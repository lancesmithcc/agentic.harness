import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { acknowledgeEvolution, beginEvolution, evolutionStatus, recoverEvolution, revertEvolution, snapshotTree, syncEvolution } from "./self-evolution.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), "evolve-")); roots.push(root);
  git(root, ["init"]); git(root, ["config", "user.name", "Test"]); git(root, ["config", "user.email", "test@example.test"]);
  writeFileSync(join(root, "base.txt"), "base\n"); git(root, ["add", "base.txt"]); git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("self evolution checkpoints", () => {
  test("durably checkpoints before edits without changing the caller index", () => {
    const root = repo();
    writeFileSync(join(root, "base.txt"), "staged prior work\n"); git(root, ["add", "base.txt"]);
    const staged = git(root, ["diff", "--cached"]);
    const watch = beginEvolution(root, { sessionId: "s1", profile: "home" });
    expect(watch.beforeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(root, ["show", "--format=%s", "-s", watch.beforeCommit])).toContain("baseline checkpoint");
    expect(git(root, ["diff", "--cached"])).toBe(staged);
    writeFileSync(join(root, "new.txt"), "new\n");
    const change = watch.finish();
    expect(change?.files.map((file) => file.path)).toContain("new.txt");
    expect(watch.finish()).toEqual(change);
    expect(git(root, ["diff", "--cached"])).toBe(staged);
    expect(existsSync(join(root, ".git", "agentic-harness", "evolution-completed.json"))).toBe(true);
    acknowledgeEvolution(root, change!.afterCommit);
  });

  test("rollback preserves newer edits and restores safe add/delete/mode paths", () => {
    const root = repo();
    writeFileSync(join(root, "remove.txt"), "remove\n"); writeFileSync(join(root, "mode.sh"), "#!/bin/sh\n"); chmodSync(join(root, "mode.sh"), 0o755); symlinkSync("mode.sh", join(root, "link"));
    git(root, ["add", "."]); git(root, ["commit", "-m", "fixtures"]);
    const watch = beginEvolution(root);
    writeFileSync(join(root, "added.txt"), "added\n"); rmSync(join(root, "remove.txt")); chmodSync(join(root, "mode.sh"), 0o644); rmSync(join(root, "link")); symlinkSync("base.txt", join(root, "link"));
    writeFileSync(join(root, "base.txt"), "changed by evolution\n");
    const change = watch.finish()!;
    acknowledgeEvolution(root, change.afterCommit);
    writeFileSync(join(root, "base.txt"), "newer user edit\n");
    const result = revertEvolution(change);
    expect(result.reverted).toEqual(expect.arrayContaining(["added.txt", "remove.txt", "mode.sh", "link"]));
    expect(result.skipped).toContain("base.txt");
    expect(existsSync(join(root, "added.txt"))).toBe(false);
    expect(existsSync(join(root, "remove.txt"))).toBe(true);
    expect((git(root, ["ls-files", "-s", "mode.sh"]).split(/\s+/)[0])).toBe("100755");
    expect(readlinkSync(join(root, "link"))).toBe("mode.sh");
  });

  test("records nested add, rename, and delete paths", () => {
    const root = repo();
    mkdirSync(join(root, "nested", "old"), { recursive: true });
    writeFileSync(join(root, "nested", "old", "delete.txt"), "delete\n");
    writeFileSync(join(root, "nested", "old", "rename.txt"), "rename\n");
    git(root, ["add", "."]); git(root, ["commit", "-m", "nested fixtures"]);
    const watch = beginEvolution(root);
    rmSync(join(root, "nested", "old", "delete.txt"));
    mkdirSync(join(root, "nested", "new"), { recursive: true });
    rmSync(join(root, "nested", "old", "rename.txt")); writeFileSync(join(root, "nested", "new", "renamed.txt"), "rename\n");
    writeFileSync(join(root, "nested", "new", "added.txt"), "added\n");
    const change = watch.finish()!;
    expect(change.files.map(file => file.path)).toEqual(expect.arrayContaining(["nested/old/delete.txt", "nested/old/rename.txt", "nested/new/renamed.txt", "nested/new/added.txt"]));
    acknowledgeEvolution(root, change.afterCommit);
  });

  test("allows source auth and secrets modules but blocks credentials", () => {
    const root = repo();
    const safe = beginEvolution(root);
    writeFileSync(join(root, "auth.ts"), "export const auth = () => true;\n");
    writeFileSync(join(root, "secrets.ts"), "export const label = 'not a credential';\n");
    const safeChange = safe.finish()!; acknowledgeEvolution(root, safeChange.afterCommit);
    writeFileSync(join(root, ".env"), "API_KEY=real-value\n");
    expect(() => beginEvolution(root)).toThrow(/sensitive path/i);
    rmSync(join(root, ".env"));
    const blocked = beginEvolution(root);
    writeFileSync(join(root, "config.ts"), "const api_key = '" + "sk-" + "a".repeat(32) + "';\n");
    expect(() => blocked.finish()).toThrow(/credential content/i);
    rmSync(join(root, "config.ts"));
    const recovered = recoverEvolution(root); if (recovered.change) acknowledgeEvolution(root, recovered.change.afterCommit);
  });

  test("rejects same-process overlap and recovers abandoned checkpoint metadata", () => {
    const root = repo(); const watch = beginEvolution(root, { sessionId: "session-x", profile: "work" });
    expect(() => beginEvolution(root)).toThrow(/already active|unfinished/i);
    writeFileSync(join(root, "abandoned.txt"), "recovered\n"); watch.release();
    const recovered = recoverEvolution(root);
    expect(recovered.sessionId).toBe("session-x"); expect(recovered.profile).toBe("work");
    expect(recovered.change?.files.map(file => file.path)).toContain("abandoned.txt");
    expect(() => beginEvolution(root)).toThrow(/unfinished/i);
    acknowledgeEvolution(root, recovered.change!.afterCommit);
    const next = beginEvolution(root); next.release();
  });

  test("recovers a checkpoint left by a killed process", async () => {
    const root = repo(); const modulePath = join(import.meta.dir, "self-evolution.ts");
    const program = `import { beginEvolution } from ${JSON.stringify(modulePath)}; import { writeFileSync } from 'node:fs'; const watch = beginEvolution(process.argv[1], { sessionId: 'dead-session', profile: 'dead-profile' }); writeFileSync(process.argv[1] + '/killed.txt', 'durable recovery\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", program, root]);
    const pending = join(root, ".git", "agentic-harness", "evolution-pending.json");
    for (let attempt = 0; attempt < 50 && !existsSync(pending); attempt++) await Bun.sleep(20);
    expect(existsSync(pending)).toBe(true);
    child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("exit", () => resolve()));
    const recovered = recoverEvolution(root);
    expect(recovered.sessionId).toBe("dead-session"); expect(recovered.profile).toBe("dead-profile");
    expect(recovered.change?.files.map(file => file.path)).toContain("killed.txt");
    acknowledgeEvolution(root, recovered.change!.afterCommit);
  });

  test("keeps chmod-only newer user change during rollback", () => {
    const root = repo(); writeFileSync(join(root, "mode.txt"), "same bytes\n"); chmodSync(join(root, "mode.txt"), 0o644); git(root, ["add", "."]); git(root, ["commit", "-m", "mode fixture"]);
    const watch = beginEvolution(root); chmodSync(join(root, "mode.txt"), 0o755); const change = watch.finish()!;
    acknowledgeEvolution(root, change.afterCommit);
    chmodSync(join(root, "mode.txt"), 0o644);
    const result = revertEvolution(change);
    expect(result.skipped).toContain("mode.txt");
    expect(statSync(join(root, "mode.txt")).mode & 0o777).toBe(0o644);
  });

  test("does not replace a directory containing newer files during rollback", () => {
    const root = repo(); writeFileSync(join(root, "replace"), "original file\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "replacement fixture"]);
    const watch = beginEvolution(root); rmSync(join(root, "replace")); mkdirSync(join(root, "replace")); writeFileSync(join(root, "replace", "agent.txt"), "agent\n"); const change = watch.finish()!;
    acknowledgeEvolution(root, change.afterCommit);
    writeFileSync(join(root, "replace", "newer.txt"), "do not remove\n");
    const result = revertEvolution(change);
    expect(result.skipped).toContain("replace");
    expect(existsSync(join(root, "replace", "newer.txt"))).toBe(true);
  });

  test("never follows a newer symlink outside the source tree during rollback", () => {
    const root = repo(); const outside = mkdtempSync(join(tmpdir(), "evolve-outside-")); roots.push(outside);
    const sentinel = join(outside, "sentinel.txt"); writeFileSync(sentinel, "outside untouched\n");
    symlinkSync("base.txt", join(root, "link-out")); git(root, ["add", "."]); git(root, ["commit", "-m", "symlink fixture"]);
    const watch = beginEvolution(root); rmSync(join(root, "link-out")); writeFileSync(join(root, "link-out"), "regular evolution file\n"); const change = watch.finish()!;
    acknowledgeEvolution(root, change.afterCommit);
    rmSync(join(root, "link-out")); symlinkSync(sentinel, join(root, "link-out"));
    const result = revertEvolution(change);
    expect(result.skipped).toContain("link-out");
    expect(readFileSync(sentinel, "utf8")).toBe("outside untouched\n");
  });

  test("replaces an evolution symlink with its prior regular file without touching target", () => {
    const root = repo(); const outside = mkdtempSync(join(tmpdir(), "evolve-outside-")); roots.push(outside);
    const sentinel = join(outside, "sentinel.txt"); writeFileSync(sentinel, "outside untouched\n");
    writeFileSync(join(root, "regular.txt"), "original regular file\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "regular fixture"]);
    const watch = beginEvolution(root); rmSync(join(root, "regular.txt")); symlinkSync(sentinel, join(root, "regular.txt")); const change = watch.finish()!;
    acknowledgeEvolution(root, change.afterCommit);
    const result = revertEvolution(change);
    expect(result.reverted).toContain("regular.txt");
    expect(readFileSync(join(root, "regular.txt"), "utf8")).toBe("original regular file\n");
    expect(readFileSync(sentinel, "utf8")).toBe("outside untouched\n");
  });

  test("pushes only the self-evolve branch to an explicit bare remote", async () => {
    const root = repo(); const remote = mkdtempSync(join(tmpdir(), "evolve-remote-")); roots.push(remote); git(remote, ["init", "--bare"]);
    git(root, ["remote", "add", "origin", "https://github.com/lancesmithcc/agentic.harness.git"]);
    const watch = beginEvolution(root); writeFileSync(join(root, "published.txt"), "yes\n"); const change = watch.finish()!; acknowledgeEvolution(root, change.afterCommit);
    const status = await syncEvolution(root, { testRemoteUrl: remote });
    expect(status.sync).toBe("synced");
    expect(git(remote, ["show-ref", "--verify", "refs/heads/self-evolve"])).toMatch(/self-evolve$/);
    expect(evolutionStatus(root).sync).toBe("synced");
  });

  test("leaves an invalid configured remote unconfigured", async () => {
    const root = repo(); const watch = beginEvolution(root); writeFileSync(join(root, "local.txt"), "x\n"); const change = watch.finish()!; acknowledgeEvolution(root, change.afterCommit);
    git(root, ["remote", "add", "origin", "https://example.test/not-authorized.git"]);
    expect((await syncEvolution(root)).sync).toBe("unconfigured");
  });

  test("reports remote divergence without rewriting its branch", async () => {
    const root = repo(); const remote = mkdtempSync(join(tmpdir(), "evolve-remote-")); roots.push(remote); git(remote, ["init", "--bare"]);
    let watch = beginEvolution(root); writeFileSync(join(root, "one.txt"), "one\n"); let change = watch.finish()!; acknowledgeEvolution(root, change.afterCommit); await syncEvolution(root, { testRemoteUrl: remote });
    const writer = mkdtempSync(join(tmpdir(), "evolve-writer-")); roots.push(writer); git(writer, ["clone", remote, "."]); git(writer, ["checkout", "self-evolve"]); git(writer, ["config", "user.name", "Writer"]); git(writer, ["config", "user.email", "writer@example.test"]);
    writeFileSync(join(writer, "remote.txt"), "remote\n"); git(writer, ["add", "."]); git(writer, ["commit", "-m", "remote advance"]); git(writer, ["push", "origin", "self-evolve"]);
    watch = beginEvolution(root); writeFileSync(join(root, "local.txt"), "local\n"); change = watch.finish()!; acknowledgeEvolution(root, change.afterCommit);
    const status = await syncEvolution(root, { testRemoteUrl: remote });
    expect(status.sync).toBe("error");
    expect(git(remote, ["log", "-1", "--format=%s", "self-evolve"])).toBe("remote advance");
  });
});
