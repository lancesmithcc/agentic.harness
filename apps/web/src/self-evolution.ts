/**
 * Isolated, append-only checkpoints for source self-evolution. This never
 * touches HEAD, the caller's index, stash, or working files; every snapshot
 * uses a throwaway index and commits directly with git commit-tree.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const EVOLUTION_BRANCH = "self-evolve";
export const DEFAULT_REPO_URL = "https://github.com/lancesmithcc/agentic.harness";
type FileChange = { status: string; path: string };

export interface SelfChange {
  root: string; before: string; after: string; files: FileChange[];
  beforeCommit: string; afterCommit: string; branch: typeof EVOLUTION_BRANCH; repoUrl: string;
}
export interface BeginOptions { sessionId?: string; profile?: string; repoUrl?: string; operation?: "rollback" }
export interface EvolutionWatch { root: string; before: string; beforeCommit: string; finish(): SelfChange | null; release(): void }
export interface EvolutionStatus {
  branch: string; repoUrl: string; localCommit: string | null; remoteCommit: string | null;
  sync: "synced" | "pending" | "error" | "unconfigured"; error?: string; busy: boolean;
}
interface Pending { root: string; before: string; beforeCommit: string; repoUrl: string; sessionId?: string; profile?: string; pid: number; startedAt: string }
interface Completed { pending: Pending; change: SelfChange }
interface Lock { dir: string; release(): void }

function run(root: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...env } });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  return result.stdout.trim();
}
function gitDir(root: string): string {
  const raw = run(root, ["rev-parse", "--git-dir"]);
  return isAbsolute(raw) ? raw : resolve(root, raw);
}
function stateDir(root: string) { const path = join(gitDir(root), "agentic-harness"); mkdirSync(path, { recursive: true }); return path; }
function statePath(root: string, name: string) { return join(stateDir(root), name); }
function branchRef() { return `refs/heads/${EVOLUTION_BRANCH}`; }
function maybeRef(root: string, ref: string): string | null { try { return run(root, ["rev-parse", "--verify", ref]); } catch { return null; } }
function treeOf(root: string, commit: string): string { return run(root, ["rev-parse", `${commit}^{tree}`]); }
function defaultEnv() { return { GIT_AUTHOR_NAME: "agentic.sidekick", GIT_AUTHOR_EMAIL: "agentic@localhost", GIT_COMMITTER_NAME: "agentic.sidekick", GIT_COMMITTER_EMAIL: "agentic@localhost" }; }

function acquire(root: string, name = "evolution.lock"): Lock {
  const dir = statePath(root, name);
  try { mkdirSync(dir); }
  catch {
    let pid: number;
    try { pid = Number(readFileSync(join(dir, "pid"), "utf8").trim()); }
    catch { throw new Error("Self-evolve checkpoint lock is being initialized. Retry shortly."); }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive) throw new Error("self-evolution is already active for this source tree");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
  writeFileSync(join(dir, "pid"), String(process.pid));
  let released = false;
  return { dir, release() { if (!released) { released = true; rmSync(dir, { recursive: true, force: true }); } } };
}

function withTempIndex<T>(root: string, fn: (env: Record<string, string>) => T): T {
  const path = join(stateDir(root), `index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: path };
  try {
    try { run(root, ["read-tree", "HEAD"], env); } catch { run(root, ["read-tree", "--empty"], env); }
    run(root, ["add", "-A"], env);
    return fn(env);
  } finally { rmSync(path, { force: true }); }
}
export function snapshotTree(root: string): string { return withTempIndex(root, (env) => run(root, ["write-tree"], env)); }
function commit(root: string, tree: string, parent: string | null, message: string): string {
  return run(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], defaultEnv());
}
function updateBranch(root: string, next: string, previous: string | null): void {
  run(root, ["update-ref", branchRef(), next, ...(previous ? [previous] : ["0000000000000000000000000000000000000000"])]);
}
function unsafePath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /(^|\/)\.env(?:\.|$)/i.test(path) && !/\.env\.example$/i.test(path)
    || /\.(pem|key|p12|pfx)$/i.test(path)
    || /(?:^|[._-])(?:credentials?|private[-_]?key|access[-_]?token|auth)\.(?:json|ya?ml|ini|toml|txt)$/i.test(name);
}
const checkedBlobs = new Set<string>();
const checkedTrees = new Set<string>();
function assertNoSensitiveTree(root: string, tree: string): void {
  if (checkedTrees.has(tree)) return;
  const entries = run(root, ["ls-tree", "-r", "-z", tree]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    if (unsafePath(path)) throw new Error(`refusing to checkpoint sensitive path: ${path}`);
    const [, kind, hash] = entry.slice(0, tab).split(" ");
    if (kind !== "blob" || !hash || checkedBlobs.has(hash)) continue;
    const bytes = showBytes(root, hash);
    if (!bytes.includes(0)) {
      const text = bytes.toString("utf8");
      if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{24,}|\bAKIA[A-Z0-9]{16}\b|(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{24,}['"])/i.test(text))
        throw new Error(`refusing to checkpoint probable credential content: ${path}`);
    }
    checkedBlobs.add(hash);
  }
  checkedTrees.add(tree);
}
function writeState(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function changes(root: string, before: string, after: string): FileChange[] {
  const raw = run(root, ["diff-tree", "-r", "--name-status", "--no-renames", "-z", before, after]).split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push({ status: raw[i]!, path: raw[i + 1]! });
  return out;
}
function pendingPath(root: string) { return statePath(root, "evolution-pending.json"); }
function writePending(root: string, pending: Pending) { writeState(pendingPath(root), pending); }
function readPending(root: string): Pending | null { try { return JSON.parse(readFileSync(pendingPath(root), "utf8")) as Pending; } catch { return null; } }
function removePending(root: string) { rmSync(pendingPath(root), { force: true }); }
function completedPath(root: string) { return statePath(root, "evolution-completed.json"); }
function readCompleted(root: string): Completed | null { try { return JSON.parse(readFileSync(completedPath(root), "utf8")) as Completed; } catch { return null; } }
function writeCompleted(root: string, completed: Completed) { writeState(completedPath(root), completed); }
/** Clear a completed checkpoint only after its corresponding session event is durable. */
export function acknowledgeEvolution(root: string, afterCommit: string): void { const completed = readCompleted(resolve(root)); if (completed?.change.afterCommit === afterCommit) rmSync(completedPath(resolve(root)), { force: true }); }

export function beginEvolution(root: string, options: BeginOptions = {}): EvolutionWatch {
  root = resolve(root);
  const lock = acquire(root);
  try {
    if (readPending(root) || readCompleted(root)) throw new Error("self-evolution has an unfinished checkpoint; recover and acknowledge it before starting another");
    const before = snapshotTree(root);
    assertNoSensitiveTree(root, before);
    const previous = maybeRef(root, branchRef());
    const initialParent = previous ?? maybeRef(root, "HEAD");
    const beforeCommit = previous && treeOf(root, previous) === before ? previous : commit(root, before, initialParent, "self-evolve: baseline checkpoint");
    if (beforeCommit !== previous) updateBranch(root, beforeCommit, previous);
    writePending(root, { root, before, beforeCommit, repoUrl: options.repoUrl ?? DEFAULT_REPO_URL, sessionId: options.sessionId, profile: options.profile, pid: process.pid, startedAt: new Date().toISOString() });
    let done = false;
    let completed = false;
    let result: SelfChange | null | undefined;
    return {
      root, before, beforeCommit,
      finish() {
        if (completed) return result!;
        if (done) throw new Error("self-evolution watch was released after a failed checkpoint");
        done = true;
        try {
          const after = snapshotTree(root);
          if (after === before) { removePending(root); completed = true; result = null; return result; }
          const files = changes(root, before, after);
          assertNoSensitiveTree(root, after);
          const afterCommit = commit(root, after, beforeCommit, options.operation === "rollback" ? "self-evolve: rollback checkpoint" : "self-evolve: source change");
          updateBranch(root, afterCommit, beforeCommit);
          result = { root, before, after, files, beforeCommit, afterCommit, branch: EVOLUTION_BRANCH, repoUrl: options.repoUrl ?? DEFAULT_REPO_URL };
          writeCompleted(root, { pending: readPending(root)!, change: result });
          removePending(root);
          completed = true;
          return result;
        } finally { lock.release(); }
      },
      release() { if (!done) { done = true; lock.release(); } },
    };
  } catch (error) { lock.release(); throw error; }
}

/** Complete a crashed turn from its durable pre-edit checkpoint, if its PID is dead. */
export function recoverEvolution(root: string): { change: SelfChange | null; sessionId?: string; profile?: string } {
  root = resolve(root);
  const completed = readCompleted(root);
  if (completed) return { change: completed.change, sessionId: completed.pending.sessionId, profile: completed.pending.profile };
  const pending = readPending(root);
  if (!pending) return { change: null };
  let alive = false;
  try { process.kill(pending.pid, 0); alive = true; } catch { /* stale */ }
  if (alive && existsSync(statePath(root, "evolution.lock"))) return { change: null, sessionId: pending.sessionId, profile: pending.profile };
  const lock = acquire(root);
  try {
    const after = snapshotTree(root);
    assertNoSensitiveTree(root, after);
    if (after === pending.before) { removePending(root); return { change: null, sessionId: pending.sessionId, profile: pending.profile }; }
    const files = changes(root, pending.before, after);
    const previous = maybeRef(root, branchRef());
    // A crash can occur after update-ref but before the chat recovery record.
    const afterCommit = previous && treeOf(root, previous) === after ? previous : commit(root, after, previous ?? pending.beforeCommit, "self-evolve: recovered source change");
    if (afterCommit !== previous) updateBranch(root, afterCommit, previous);
    const change: SelfChange = { root, before: pending.before, after, files, beforeCommit: pending.beforeCommit, afterCommit, branch: EVOLUTION_BRANCH, repoUrl: pending.repoUrl };
    writeCompleted(root, { pending, change }); removePending(root);
    return { change, sessionId: pending.sessionId, profile: pending.profile };
  } finally { lock.release(); }
}

export function revertEvolution(change: SelfChange, options: BeginOptions = {}): { reverted: string[]; skipped: string[]; checkpoint?: SelfChange } {
  const root = resolve(change.root);
  const watch = beginEvolution(root, { ...options, repoUrl: change.repoUrl, operation: "rollback" });
  const reverted: string[] = [], skipped: string[] = [];
  try {
    for (const file of change.files) {
      const path = resolve(root, file.path);
      if (!path.startsWith(root + "/") || !safeAncestors(root, path)) { skipped.push(file.path); continue; }
      const current = maybeEntry(root, watch.before, file.path), expected = maybeEntry(root, change.after, file.path);
      if (current !== expected || (existsSync(path) && lstatSync(path).isDirectory())) { skipped.push(file.path); continue; }
      restorePath(root, file.path, change.before);
      reverted.push(file.path);
    }
    const checkpoint = watch.finish();
    return { reverted, skipped, ...(checkpoint ? { checkpoint } : {}) };
  } catch (error) {
    // Preserve even a partial rollback before surfacing a filesystem error.
    try { watch.finish(); } catch { /* pending pre-edit record remains recoverable */ }
    throw error;
  } finally { watch.release(); }
}
function maybeEntry(root: string, tree: string, path: string): string | null { try { return run(root, ["ls-tree", tree, "--", path]).split("\t")[0] || null; } catch { return null; } }
function showBytes(root: string, spec: string): Buffer {
  const result = spawnSync("git", ["-C", root, "cat-file", "blob", spec], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(result.stderr.toString() || `cannot read ${spec}`);
  return Buffer.from(result.stdout);
}
function restorePath(root: string, path: string, tree: string): void {
  const target = resolve(root, path); const entry = maybeEntry(root, tree, path);
  if (!target.startsWith(root + "/") || !safeAncestors(root, target)) throw new Error(`unsafe rollback path: ${path}`);
  if (!entry) { if (existsSync(target) && lstatSync(target).isDirectory()) throw new Error(`refusing to remove directory during rollback: ${path}`); rmSync(target, { force: true }); return; }
  mkdirSync(dirname(target), { recursive: true });
  const mode = run(root, ["ls-tree", tree, "--", path]).split(/\s+/)[0];
  if (existsSync(target) && lstatSync(target).isDirectory()) throw new Error(`refusing to replace directory during rollback: ${path}`);
  if (mode === "120000") { rmSync(target, { force: true }); symlinkSync(showBytes(root, `${tree}:${path}`).toString(), target); }
  else {
    // Unlink first: writing through an existing symlink can touch another file.
    rmSync(target, { force: true });
    writeFileSync(target, showBytes(root, `${tree}:${path}`));
    chmodSync(target, mode === "100755" ? 0o755 : 0o644);
  }
}
function safeAncestors(root: string, target: string): boolean {
  for (let path = dirname(target); path !== root; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
  }
  return true;
}

export function evolutionStatus(root: string): EvolutionStatus {
  root = resolve(root);
  try {
    const localCommit = maybeRef(root, branchRef());
    const remoteUrl = configuredRemote(root, "origin");
    const persisted = readSyncState(root);
    const remoteCommit = persisted?.remoteCommit ?? maybeRef(root, `refs/remotes/origin/${EVOLUTION_BRANCH}`);
    const configured = !!remoteUrl && allowedRemote(remoteUrl, false);
    const sync = !configured ? "unconfigured" : persisted?.sync === "error" ? "error" : localCommit && remoteCommit === localCommit ? "synced" : "pending";
    return { branch: EVOLUTION_BRANCH, repoUrl: DEFAULT_REPO_URL, localCommit, remoteCommit, sync, ...(persisted?.error ? { error: persisted.error } : {}), busy: existsSync(statePath(root, "evolution.lock")) || existsSync(statePath(root, "sync.lock")) };
  } catch { return { branch: EVOLUTION_BRANCH, repoUrl: DEFAULT_REPO_URL, localCommit: null, remoteCommit: null, sync: "unconfigured", busy: false }; }
}
function configuredRemote(root: string, name: string): string | null {
  try {
    const urls = run(root, ["remote", "get-url", "--push", "--all", name]).split("\n");
    return urls.length === 1 ? urls[0]! : null;
  } catch { return null; }
}
function readSyncState(root: string): Partial<EvolutionStatus> | null { try { return JSON.parse(readFileSync(statePath(root, "evolution-sync.json"), "utf8")); } catch { return null; } }
function writeSyncState(root: string, status: EvolutionStatus) { writeState(statePath(root, "evolution-sync.json"), { sync: status.sync, error: status.error, remoteCommit: status.remoteCommit }); }
function allowedRemote(url: string, testOverride: boolean): boolean {
  return testOverride || /^(?:https:\/\/github\.com\/lancesmithcc\/agentic\.harness(?:\.git)?|git@github\.com:lancesmithcc\/agentic\.harness(?:\.git)?)$/i.test(url);
}
function pushAsync(root: string, url: string, commit: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", root, "push", url, `${commit}:${branchRef()}`], {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes" },
    });
    let output = "", timedOut = false;
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    child.stderr.on("data", capture); child.stdout.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.platform !== "win32" && child.pid ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch { /* already exited */ }
    }, 30_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("GitHub sync timed out after 30 seconds; the local checkpoint is safe."));
      else if (code === 0) resolvePromise();
      else reject(new Error(output.trim() || "GitHub sync failed; the local checkpoint is safe."));
    });
  });
}
export async function syncEvolution(root: string, options: { remoteName?: string; testRemoteUrl?: string } = {}): Promise<EvolutionStatus> {
  root = resolve(root);
  let lock: Lock;
  try { lock = acquire(root, "sync.lock"); } catch { return evolutionStatus(root); }
  try {
    const local = maybeRef(root, branchRef());
    if (!local) return evolutionStatus(root);
    const remote = options.remoteName ?? "origin", url = options.testRemoteUrl ?? configuredRemote(root, remote);
    if (!url || !allowedRemote(url, Boolean(options.testRemoteUrl))) {
      const status: EvolutionStatus = { ...evolutionStatus(root), sync: "unconfigured", error: "Set origin to https://github.com/lancesmithcc/agentic.harness to sync checkpoints." };
      writeSyncState(root, status); return status;
    }
    // Validate all newly published history, including a credential removed in a later commit.
    const synced = readSyncState(root)?.remoteCommit;
    const commits = run(root, ["rev-list", local, ...(synced && maybeRef(root, synced) ? [`^${synced}`] : [])]).split("\n").filter(Boolean);
    for (const revision of commits) assertNoSensitiveTree(root, treeOf(root, revision));
    await pushAsync(root, url, local);
    run(root, ["update-ref", `refs/remotes/${remote}/${EVOLUTION_BRANCH}`, local]);
    const status: EvolutionStatus = { ...evolutionStatus(root), remoteCommit: local, sync: maybeRef(root, branchRef()) === local ? "synced" : "pending", error: undefined };
    writeSyncState(root, status); return status;
  } catch (error) {
    const status: EvolutionStatus = { ...evolutionStatus(root), sync: "error", error: (error as Error).message };
    writeSyncState(root, status); return status;
  } finally { lock.release(); }
}
