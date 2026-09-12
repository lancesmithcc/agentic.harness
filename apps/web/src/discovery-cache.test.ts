import { describe, expect, test } from "bun:test";
import { DiscoveryCache } from "./discovery-cache.ts";

describe("DiscoveryCache", () => {
  test("coalesces concurrent discovery and invalidates when workspace config changes", async () => {
    const cache = new DiscoveryCache<{ workspace: string }>();
    let calls = 0;
    const load = async () => { calls++; await Bun.sleep(10); return { workspace: "one" }; };
    const [first, second] = await Promise.all([
      cache.get("home\0/workspace", "config-a", load),
      cache.get("home\0/workspace", "config-a", load),
    ]);
    expect(first).toEqual({ workspace: "one" });
    expect(second).toEqual({ workspace: "one" });
    expect(calls).toBe(1);
    await cache.get("home\0/workspace", "config-b", async () => { calls++; return { workspace: "two" }; });
    expect(calls).toBe(2);
  });
});
