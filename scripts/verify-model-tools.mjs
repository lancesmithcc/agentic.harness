/** Live tool checks against the built desktop server. Uses only disposable data. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const app = join(repo, 'apps/desktop/src-tauri/target/release/bundle/macos/agentic.harness.app/Contents');
const resources = join(app, 'Resources');
const node = join(resources, 'dsh-runtime/node/bin/node');
const root = mkdtempSync(join(tmpdir(), 'agentic-model-tools-'));
const home = join(root, 'data'), workspace = join(root, 'workspace'), bin = join(root, 'bin');
for (const dir of [home, workspace, bin, join(home, 'profiles/home')]) mkdirSync(dir, { recursive: true });
for (const cli of ['codex', 'claude']) writeFileSync(join(bin, cli), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const candidates = [
  ['deepseek', 'deepseek-v4-flash', 'DEEPSEEK_API_KEY'],
  ['deepseek-harness', 'deepseek-v4-flash', 'DEEPSEEK_API_KEY'],
  ['zai', 'glm-5.3-flash', 'ZAICODINGPLAN_KEY'],
  ['kimi', 'k3', 'KIMI_API_KEY'],
  ['minimax', 'MiniMax-M3', 'MINIMAX_API_KEY'],
  ['openai', 'gpt-5.6-luna', 'OPENAI_KEY'],
  ['openrouter', 'deepseek/deepseek-v4-flash', 'OPENROUTER_API_KEY'],
  ['local', 'gemma-4-12b-it', ''],
];
const requested = process.env.HARNESS_QA_MODELS?.split(',');
const routes = candidates.filter(([id, , key]) => (!requested || requested.includes(id)) && (!key || process.env[key]));
const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin` };
for (const [, , key] of routes) if (key) env[key] = process.env[key];
writeFileSync(join(home, 'profiles/home/profile.toml'), candidates.filter(([id]) => id !== 'local').flatMap(([id, , key]) => [
  `[providers.${id}]`, `enabled = ${routes.some(([route]) => route === id)}`, `api_key = "env://${key}"`,
]).join('\n'));
writeFileSync(join(home, 'settings.json'), JSON.stringify({
  workspaces: { home: workspace }, agentAccess: 'workspace', selfEvolve: false, selfSourceRoot: repo.replace(/\/$/, ''),
}));
const marker = `FILE-${crypto.randomUUID()}`, mcpMarker = `MCP-${crypto.randomUUID()}`;
writeFileSync(join(workspace, 'fixture.txt'), marker + '\n');
const fixtureMcp = join(root, 'fixture-mcp.mjs');
writeFileSync(fixtureMcp, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);if(msg.id===undefined)return;let result={};
 if(msg.method==='initialize')result={protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0'}};
 else if(msg.method==='tools/list')result={tools:[{name:'marker',description:'Returns the current verification marker.',inputSchema:{type:'object',properties:{}}}]};
 else if(msg.method==='tools/call')result={content:[{type:'text',text:${JSON.stringify(mcpMarker)}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});`);
const mcpServers = { fixture: { command: node, args: [fixtureMcp] } };
writeFileSync(join(home, 'tools.json'), JSON.stringify({ tools: [], mcpServers, hiddenTools: [], hiddenMcp: [] }));
writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers }));
const port = Number(process.env.HARNESS_QA_PORT || 31919), base = `http://127.0.0.1:${port}`;
const child = spawn(join(app, 'MacOS/harness-server'), [], { cwd: workspace, env: {
  ...env, HARNESS_HOME: home, HARNESS_PROFILE: 'home', HARNESS_WEB_PORT: String(port), HARNESS_WEB_HOST: '127.0.0.1',
  HARNESS_WEB_ROOT: join(resources, 'web'), HARNESS_DSH_BRIDGE: join(resources, 'dsh-runtime/deepseek-bridge.mjs'), HARNESS_NODE_PATH: node,
}, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
const closed = new Promise(resolve => child.once('close', resolve));
const results = [];
try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`Packaged server exited: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const [provider, model] of routes) {
    const started = performance.now(), events = [];
    const output = `output-${provider}.txt`;
    const response = await fetch(base + '/api/ask?profile=home', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        task: `Use real tools: read fixture.txt, run a shell command that copies its contents unchanged to ${output}, read ${output} to verify it, then call the MCP marker tool. Reply only with your application name, exact file value, and exact MCP marker.`,
        model: `${provider}/${model}`, tools: true, noFallback: true,
      }),
    });
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const frames = pending.split('\n\n'); pending = frames.pop();
      for (const frame of frames) if (frame.startsWith('data:')) events.push({ ms: Math.round(performance.now() - started), ...JSON.parse(frame.slice(5)) });
    }
    const done = events.find(event => event.t === 'done');
    const session = events.find(event => event.t === 'accepted')?.session;
    const transcript = session ? await fetch(`${base}/api/session?profile=home&id=${session}`).then(response => response.json()) : { events: [] };
    const checked = {
      completed: Boolean(done),
      file: existsSync(join(workspace, output)) && readFileSync(join(workspace, output), 'utf8').trim() === marker,
      identity: Boolean(done?.text.includes('agentic.harness')),
      reply: Boolean(done?.text.includes(marker) && done?.text.includes(mcpMarker)),
      mcp: transcript.events.some(event => event.kind === 'tool-result' && event.content.includes(mcpMarker)),
      persisted: transcript.events.some(event => event.kind === 'tool-call') && transcript.events.some(event => event.kind === 'tool-result'),
      noFallback: !events.some(event => event.t === 'fallback'),
    };
    const result = { model: `${provider}/${model}`, passed: Object.values(checked).every(Boolean), checks: checked,
      acceptedMs: events.find(event => event.t === 'accepted')?.ms, firstToolMs: events.find(event => event.t === 'tool')?.ms,
      completedMs: done?.ms, toolCalls: events.filter(event => event.t === 'tool').length,
      error: events.find(event => event.t === 'error')?.message,
    };
    results.push(result); console.log(JSON.stringify(result));
  }
  const report = { checkedAt: new Date().toISOString(), runtime: '0.1.5-rc.2', results, skipped: candidates.filter(([id]) => !routes.some(([route]) => route === id)).map(([id]) => id) };
  writeFileSync(join(repo, 'docs/qa/model-tools.json'), JSON.stringify(report, null, 2) + '\n');
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally {
  child.kill('SIGTERM'); await closed;
}
