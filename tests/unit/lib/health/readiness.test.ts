import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  catalogReadinessRequired,
  checkCatalogReadiness,
  resetCatalogReadinessForTests,
  type ReadinessDeps,
} from "../../../../src/lib/health/readiness.ts";

afterEach(() => resetCatalogReadinessForTests());

function deps(sizes: Record<string, number>, authoritative: string[] = Object.keys(sizes)): ReadinessDeps {
  return {
    activeProviders: async () => Object.keys(sizes),
    catalogSize: async (p) => sizes[p] ?? 0,
    isAuthoritative: (p) => authoritative.includes(p),
  };
}

test("ready when every authoritative provider with an active connection has a live catalog", async () => {
  const r = await checkCatalogReadiness(deps({ claude: 60, codex: 27 }));
  assert.deepEqual(r, { ready: true, waiting: [] });
});

test("not ready while a provider's catalog is empty — names it (the 2026-09-08 boot)", async () => {
  const r = await checkCatalogReadiness(deps({ claude: 0, codex: 27 }));
  assert.deepEqual(r, { ready: false, waiting: ["claude"] });
});

test("non-authoritative providers cannot hold the gate", async () => {
  const r = await checkCatalogReadiness(deps({ claude: 60, custom: 0 }, ["claude"]));
  assert.equal(r.ready, true);
});

test("no active connections at all is ready (nothing to wait for)", async () => {
  const r = await checkCatalogReadiness(deps({}));
  assert.equal(r.ready, true);
});

test("the verdict latches: a catalog that empties later never flips a serving container", async () => {
  assert.equal((await checkCatalogReadiness(deps({ claude: 60 }))).ready, true);
  assert.equal((await checkCatalogReadiness(deps({ claude: 0 }))).ready, true);
  resetCatalogReadinessForTests();
  assert.equal((await checkCatalogReadiness(deps({ claude: 0 }))).ready, false);
});

test("a failing dependency fails closed", async () => {
  const r = await checkCatalogReadiness({
    activeProviders: async () => {
      throw new Error("db offline");
    },
    catalogSize: async () => 1,
    isAuthoritative: () => true,
  });
  assert.equal(r.ready, false);
  assert.match(r.waiting[0], /db offline/);
});

test("the gate is opt-in via HEALTH_REQUIRE_CATALOG=1", () => {
  assert.equal(catalogReadinessRequired({}), false);
  assert.equal(catalogReadinessRequired({ HEALTH_REQUIRE_CATALOG: "0" }), false);
  assert.equal(catalogReadinessRequired({ HEALTH_REQUIRE_CATALOG: "1" }), true);
});
