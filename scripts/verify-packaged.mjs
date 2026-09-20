/** Live packaged-runtime check. Requires DEEPSEEK_API_KEY; uses an isolated home, workspace, and local MCP fixture. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const app=join(repo,'apps/desktop/src-tauri/target/release/bundle/macos/agentic.sidekick.app/Contents');
const resources=join(app,'Resources');
const root=mkdtempSync(join(tmpdir(),'agentic-packaged-'));
const home=join(root,'data'), workspace=join(root,'workspace'), bin=join(root,'bin');
for(const p of [home,workspace,bin,join(home,'profiles/home')])mkdirSync(p,{recursive:true});
for(const cli of ['codex','claude'])writeFileSync(join(bin,cli),'#!/bin/sh\nexit 1\n',{mode:0o755});
writeFileSync(join(workspace,'fixture.txt'),'DURABLE-HARNESS-9472\n');
const fixtureMcp=join(root,'fixture-mcp.mjs');
writeFileSync(fixtureMcp, `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const msg=JSON.parse(line);if(msg.id===undefined)return;let result={};
if(msg.method==='initialize')result={protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0'}};
else if(msg.method==='tools/list')result={tools:[{name:'marker',description:'Returns the verification marker for this isolated test.',inputSchema:{type:'object',properties:{}}}]};
else if(msg.method==='tools/call')result={content:[{type:'text',text:'MCP-READY-6738'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');});`);
const mcpServers={fixture:{command:join(resources,'dsh-runtime/node/bin/node'),args:[fixtureMcp]}};
writeFileSync(join(home,'tools.json'),JSON.stringify({tools:[],mcpServers,hiddenTools:[],hiddenMcp:[]}));
writeFileSync(join(home,'mcp.json'),JSON.stringify({mcpServers}));
writeFileSync(join(home,'settings.json'),JSON.stringify({workspaces:{home:workspace},agentAccess:'read-only',startModel:'deepseek-harness/deepseek-v4-flash',selfEvolve:false}));
writeFileSync(join(home,'profiles/home/profile.toml'),['[profile]','name="home"',...['deepseek','openai','zai','kimi','minimax','openrouter'].flatMap(p=>[`[providers.${p}]`,'enabled=false']),'[providers.deepseek-harness]','enabled=true','api_key="env://DEEPSEEK_API_KEY"'].join('\n'));
const key=process.env.DEEPSEEK_API_KEY;
if(!key)throw Error('DeepSeek key missing');
const port=Number(process.env.HARNESS_QA_PORT || 31878), base=`http://127.0.0.1:${port}`;
const child=spawn(join(app,'MacOS/harness-server'),[],{cwd:workspace,env:{HOME:root,PATH:`${bin}:/usr/bin:/bin`,HARNESS_HOME:home,HARNESS_PROFILE:'home',HARNESS_WEB_PORT:String(port),HARNESS_WEB_HOST:'127.0.0.1',HARNESS_WEB_ROOT:join(resources,'web'),HARNESS_DSH_BRIDGE:join(resources,'dsh-runtime/deepseek-bridge.mjs'),HARNESS_NODE_PATH:join(resources,'dsh-runtime/node/bin/node'),DEEPSEEK_API_KEY:key},stdio:['ignore','ignore','pipe']});
let stderr='';child.stderr.on('data',c=>stderr=(stderr+String(c)).slice(-1200));
let browser;
const assert=(value,label)=>{if(!value)throw Error(label);};
try{
 for(let i=0;i<200;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{} await new Promise(r=>setTimeout(r,50));}
 assert((await fetch(base+'/api/health').then(r=>r.json())).name==='agentic.sidekick','health identity');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});
 const started=performance.now();const events=[];
 const reply=await fetch(base+'/api/ask?profile=home',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'Use your file reading tool to read fixture.txt in the working directory, then call the available MCP marker tool. Reply only with your application name, exact file value, and MCP marker value.',model:'deepseek-harness/deepseek-v4-flash',noFallback:true})});
 const reader=reply.body.getReader(),decoder=new TextDecoder();let pending='';
 for(;;){const next=await reader.read();if(next.done)break;pending+=decoder.decode(next.value,{stream:true});const chunks=pending.split('\n\n');pending=chunks.pop();for(const part of chunks){if(part.startsWith('data:'))events.push({ms:Math.round(performance.now()-started),...JSON.parse(part.slice(5))});}}
 const id=events.find(e=>e.t==='accepted')?.session, done=events.find(e=>e.t==='done');
 assert(done?.text.includes('agentic.sidekick'),'response application identity');assert(done.text.includes('DURABLE-HARNESS-9472'),'real file read marker');assert(events.some(e=>e.t==='tool'),'live tool activity');assert(done.text.includes('MCP-READY-6738'),'real MCP result');
 const transcript=await fetch(base+`/api/session?profile=home&id=${id}`).then(r=>r.json());
 assert(transcript.events.some(e=>e.kind==='tool-call'),'durable tool log');assert(transcript.events.filter(e=>e.kind==='assistant-text').length===1,'one committed assistant reply');
 await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#chatList')?.textContent.includes('Use your file reading tool'));await page.locator('#chatList').getByText(/Use your file reading tool/).first().click();await page.waitForFunction(()=>document.querySelector('#view')?.textContent.includes('DURABLE-HARNESS-9472'));
 await page.screenshot({path:join(repo,'docs/qa/packaged-runtime.png'),fullPage:true});
 assert(errors.length===0,'browser errors');
 const report={app:app.replace('/Contents',''),runtime:'0.1.5-rc.2',node:'24.21.0',isolatedHome:home,checks:['compiled server','clean PATH','real SDK file tool','real MCP tool','self identity','durable reply','browser reload'],acceptedMs:events.find(e=>e.t==='accepted').ms,firstToolMs:events.find(e=>e.t==='tool').ms,replyMs:done.ms,reply:done.text};
 writeFileSync(join(repo,'docs/qa/packaged-runtime.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>child.once('close',r));}
