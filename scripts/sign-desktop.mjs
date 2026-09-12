/** Apply and verify a local ad-hoc signature after all desktop resources are bundled. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Desktop signing requires macOS');
const app = fileURLToPath(new URL('../apps/desktop/src-tauri/target/release/bundle/macos/agentic.harness.app', import.meta.url));
for (const args of [
  ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', app],
  ['--verify', '--deep', '--strict', app],
]) {
  const result = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Desktop signature verification failed');
}
console.log('Verified local ad-hoc desktop signature');
