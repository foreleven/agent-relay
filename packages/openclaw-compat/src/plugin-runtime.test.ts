import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, test } from "node:test";

import { OpenClawPluginRuntime } from "./index.js";

function createRuntime() {
  return new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }),
      writeConfigFile: async () => {},
    },
  }).asPluginRuntime();
}

describe("OpenClawPluginRuntime state.openKeyedStore", () => {
  test("stores, consumes, deletes, and clears values in memory", async () => {
    const runtime = createRuntime();
    const store = runtime.state.openKeyedStore<{ count: number }>({
      namespace: "test-store",
      maxEntries: 10,
    });

    await store.register("key-1", { count: 1 });
    assert.deepEqual(await store.lookup("key-1"), { count: 1 });

    const lookedUp = await store.lookup("key-1");
    if (lookedUp) {
      lookedUp.count = 2;
    }
    assert.deepEqual(await store.lookup("key-1"), { count: 1 });

    assert.deepEqual(await store.consume("key-1"), { count: 1 });
    assert.equal(await store.lookup("key-1"), undefined);

    await store.register("key-2", { count: 2 });
    assert.equal(await store.delete("key-2"), true);
    assert.equal(await store.delete("key-2"), false);

    await store.register("key-3", { count: 3 });
    await store.clear();
    assert.deepEqual(await store.entries(), []);
  });

  test("shares namespace state and atomically registers absent keys", async () => {
    const runtime = createRuntime();
    const first = runtime.state.openKeyedStore<{ value: string }>({
      namespace: "shared-store",
      maxEntries: 10,
    });
    const second = runtime.state.openKeyedStore<{ value: string }>({
      namespace: "shared-store",
      maxEntries: 10,
    });

    assert.equal(
      await first.registerIfAbsent("claim", { value: "first" }),
      true,
    );
    assert.equal(
      await second.registerIfAbsent("claim", { value: "second" }),
      false,
    );
    assert.deepEqual(await second.lookup("claim"), { value: "first" });
  });

  test("expires entries by ttl and evicts oldest entries past maxEntries", async () => {
    const runtime = createRuntime();
    const expiring = runtime.state.openKeyedStore<{ value: string }>({
      namespace: "expiring-store",
      maxEntries: 10,
      defaultTtlMs: 5,
    });

    await expiring.register("short", { value: "lived" });
    await sleep(20);
    assert.equal(await expiring.lookup("short"), undefined);
    assert.equal(
      await expiring.registerIfAbsent("short", { value: "new" }),
      true,
    );

    const bounded = runtime.state.openKeyedStore<number>({
      namespace: "bounded-store",
      maxEntries: 2,
    });
    await bounded.register("one", 1);
    await bounded.register("two", 2);
    await bounded.register("three", 3);

    assert.deepEqual(
      (await bounded.entries()).map((entry) => [entry.key, entry.value]),
      [
        ["two", 2],
        ["three", 3],
      ],
    );
  });
});
