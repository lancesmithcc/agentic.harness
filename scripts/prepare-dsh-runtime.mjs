/** Stage the matching official SDK/runtime for a self-contained desktop bundle. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
// Node 24 LTS is required by dsh SDK 0.1.5 and is shipped from nodejs.org,
// not inherited from a developer's Homebrew/NVM installation.
const NODE_VERSION = '24.21.0';
const NODE_SHA256 = 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`desktop bundle only supports darwin-arm64; build host is ${process.platform}-${process.arch}`);
}
const version = JSON.parse(readFileSync(join(root, 'packages/providers/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh-sdk-client'];
const dir = join(root, 'apps/desktop/.runtime');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agentic-harness-runtime', private: true, type: 'module', dependencies: { '@deepseek-ai/dsh-sdk-client': version } }, null, 2));
const installed = join(dir, 'node_modules/@deepseek-ai/dsh-sdk-client/package.json');
if (!existsSync(installed) || JSON.parse(readFileSync(installed, 'utf8')).version !== version) {
  const result = spawnSync('npm', ['install', '--prefix', dir, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Could not prepare official DeepSeek runtime');
}
copyFileSync(join(root, 'packages/providers/runtime/deepseek-bridge.mjs'), join(dir, 'deepseek-bridge.mjs'));

const bundledNode = join(dir, 'node', 'bin', 'node');
const verifyNode = (path) => {
  const checked = spawnSync(path, ['--version'], { encoding: 'utf8' });
  if (checked.status !== 0 || checked.stdout.trim() !== `v${NODE_VERSION}`) return false;
  const arch = spawnSync('file', [path], { encoding: 'utf8' });
  if (arch.status !== 0 || !/arm64/.test(arch.stdout)) return false;
  // Official Node must link only macOS system libraries. This catches an
  // accidentally copied Homebrew binary that would need external dylibs.
  const links = spawnSync('otool', ['-L', path], { encoding: 'utf8' });
  return links.status === 0 && !/\/(?:opt\/homebrew|usr\/local)\//.test(links.stdout);
};
if (!existsSync(bundledNode) || !existsSync(join(dir, 'node', 'LICENSE')) || !verifyNode(bundledNode)) {
  const temp = mkdtempSync(join(tmpdir(), 'agentic-node-'));
  try {
    const archive = join(temp, NODE_ARCHIVE);
    const download = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error', '--output', archive, NODE_URL], { encoding: 'utf8' });
    if (download.status !== 0) throw new Error(`Could not download official Node ${NODE_VERSION}: ${download.stderr.trim()}`);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (digest !== NODE_SHA256) throw new Error(`Node archive checksum mismatch for ${NODE_ARCHIVE}`);
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', temp], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(`Could not unpack official Node: ${unpack.stderr.trim()}`);
    const extracted = join(temp, `node-v${NODE_VERSION}-darwin-arm64`, 'bin', 'node');
    if (!existsSync(extracted)) throw new Error('Official Node archive did not contain bin/node');
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
    copyFileSync(extracted, bundledNode);
    copyFileSync(join(temp, `node-v${NODE_VERSION}-darwin-arm64`, 'LICENSE'), join(dir, 'node', 'LICENSE'));
    chmodSync(bundledNode, 0o755);
    if (!verifyNode(bundledNode)) throw new Error('Bundled Node failed version, architecture, or dynamic-link validation');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
console.log(`Prepared DeepSeek SDK/runtime ${version} with official Node ${NODE_VERSION} arm64`);
