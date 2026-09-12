// Node boundary for the pinned official SDK. The compiled Bun server must not
// launch itself as dsh's Node executable. stdout is our JSONL event channel.
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const patchDir = mkdtempSync(join(tmpdir(), 'agentic-dsh-'));
const patch = join(patchDir, 'identity.yml');
const stringMap = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object of strings`);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${label}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
};
const mcpPatch = () => {
  if (!request.mcpConfig) return '';
  if (!existsSync(request.mcpConfig)) throw new Error('MCP configuration file is missing');
  let parsed;
  try { parsed = JSON.parse(readFileSync(request.mcpConfig, 'utf8')); } catch { throw new Error('MCP configuration is not valid JSON'); }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('MCP configuration must contain mcpServers');
  const rows = [];
  for (const [serverName, raw] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new Error(`unsupported MCP server name: ${serverName}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid MCP server: ${serverName}`);
    const server = raw;
    const type = typeof server.type === 'string' ? server.type : undefined;
    const id = `agentic-mcp-${rows.length}`;
    if (typeof server.command === 'string' && server.command) {
      if (type && type !== 'stdio') throw new Error(`unsupported MCP transport for ${serverName}: ${type}`);
      const args = server.args === undefined ? [] : server.args;
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error(`MCP args for ${serverName} must be strings`);
      const env = server.env === undefined ? {} : stringMap(server.env, `MCP env for ${serverName}`);
      rows.push(`    - id: ${id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${JSON.stringify(serverName)}\n        transport: stdio\n        command: ${JSON.stringify(server.command)}\n        args: ${JSON.stringify(args)}\n        env: ${JSON.stringify(env)}\n        cwd: ${JSON.stringify(request.cwd)}`);
    } else if (typeof server.url === 'string' && server.url) {
      if (type && type !== 'http' && type !== 'streamable-http') throw new Error(`unsupported MCP transport for ${serverName}: ${type}`);
      // Validate the URL now; the plugin receives the normalized string.
      let url; try { url = new URL(server.url); } catch { throw new Error(`invalid MCP URL for ${serverName}`); }
      const headers = server.headers === undefined ? {} : stringMap(server.headers, `MCP headers for ${serverName}`);
      rows.push(`    - id: ${id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${JSON.stringify(serverName)}\n        transport: streamable-http\n        url: ${JSON.stringify(url.toString())}\n        headers: ${JSON.stringify(headers)}`);
    } else {
      throw new Error(`MCP server ${serverName} needs a stdio command or HTTP URL`);
    }
  }
  return rows.length ? `\n- insert:\n${rows.join('\n')}` : '';
};
const instructions = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
let harness;
let closing;
const close = () => harness ? (closing ??= harness.close()) : Promise.resolve();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close(); });
try {
  writeFileSync(patch, '- id: system-prompt\n  config:\n    personaPrefix: ' + JSON.stringify('You are agentic.harness.\n' + instructions) + '\n    personaSuffix: "Your working directory is {{cwd}}."\n' + mcpPatch(), { mode: 0o600 });
  mkdirSync(request.home, { recursive: true, mode: 0o700 });
  harness = new DeepSeekHarness({
    profile: 'sdk', dshHome: request.home, cwd: request.cwd,
    processCwd: request.cwd, patches: [patch],
    provider: 'deepseek-official', model: request.model,
    maxTokens: request.maxTokens ?? 8192,
    initializeTimeoutMs: 30_000,
    env: { ...process.env, DSH_PERMISSION_MODE: request.access === 'full' ? 'danger-full-access' : request.access === 'workspace' ? 'workspace-write' : 'read-only', DSH_TELEMETRY_MODE: 'DISABLED' },
  });
  // A provider-neutral turn can follow any model. Replay its bounded transcript
  // in a fresh native session so switches never duplicate native history.
  const conversation = request.messages.filter(m => m.role !== 'system');
  const prompt = conversation.map((m, i) => i === conversation.length - 1 ? m.content : `[Earlier ${m.role} message]\n${m.content}`).join('\n\n');
  const result = await harness.run(prompt, { onNotification(n) {
    if (n.method !== 'session.event') return;
    const e = n.params.event;
    if (e.type === 'assistant/message') {
      const blocks = e.data.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) emit({ type: 'text-delta', text: b.text });
        if (b.type === 'reasoning' && b.text) emit({ type: 'reasoning-delta', text: b.text });
      }
      if (e.data.usage) emit({ type: 'usage', usage: { ...e.data.usage, billing: 'api' } });
    } else if (e.type === 'tool/call') {
      emit({ type: 'tool-call', id: e.data.callId, name: e.data.name, arguments: e.data.arguments });
    }
  }});
  const end = result.events.findLast(e => e.type === 'turn/end');
  if (end?.data.reason.kind !== 'completed') throw new Error(`DeepSeek Harness turn ended: ${end?.data.reason.kind ?? 'missing completion'}`);
  // The official close handshake drains persistence before completion is sent.
  await close();
  emit({ type: 'done', text: result.finalResponse, finishReason: 'stop' });
} catch (error) {
  emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await close();
  rmSync(patchDir, { recursive: true, force: true });
}
