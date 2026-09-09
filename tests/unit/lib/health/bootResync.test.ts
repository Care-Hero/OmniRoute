import test from "node:test";
import assert from "node:assert/strict";

import {
  runBootResync,
  type AutoSyncConnection,
} from "../../../../src/shared/services/modelSyncScheduler.ts";

const claude1: AutoSyncConnection = { id: "d46c7a43-1", provider: "claude", name: "claude-a" };
const claude2: AutoSyncConnection = { id: "d46c7a43-2", provider: "claude", name: "claude-b" };

test("retries the deferred connections until each syncs", async () => {
  const calls: Record<string, number> = {};
  const slept: number[] = [];
  const logs: string[] = [];
  const result = await runBootResync([claude1, claude2], {
    sync: async (c) => {
      calls[c.id] = (calls[c.id] ?? 0) + 1;
      // claude-a lands on the 2nd try (lease cleared), claude-b on the 3rd.
      return c.id === claude1.id ? calls[c.id] >= 2 : calls[c.id] >= 3;
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (l) => logs.push(l),
    retryMs: 15_000,
    maxMs: 600_000,
  });
  assert.deepEqual(result.abandoned, []);
  assert.deepEqual(
    result.synced.map((c) => c.id),
    [claude1.id, claude2.id]
  );
  assert.deepEqual(calls, { [claude1.id]: 2, [claude2.id]: 3 });
  assert.deepEqual(slept, [15_000, 15_000, 15_000]); // waits before EVERY attempt
  assert.match(logs.at(-1) ?? "", /boot re-sync complete — 2 connection\(s\)/);
});

test("gives up after maxMs and names what is still unsynced", async () => {
  let t = 0;
  const logs: string[] = [];
  const result = await runBootResync([claude1], {
    sync: async () => false,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    log: (l) => logs.push(l),
    retryMs: 15_000,
    maxMs: 60_000,
  });
  assert.deepEqual(result.synced, []);
  assert.deepEqual(result.abandoned, [claude1]);
  assert.match(logs.at(-1) ?? "", /gave up .* claude-a/);
});

test("nothing deferred is a no-op", async () => {
  let calls = 0;
  const result = await runBootResync([], {
    sync: async () => {
      calls++;
      return true;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { synced: [], abandoned: [] });
});
