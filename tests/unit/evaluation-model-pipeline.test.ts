/**
 * POST /v1/evaluation-model — pipeline-level security tests (PR #5 review fixes).
 *
 * Unlike the direct-handler tests, these drive requests through the real authz
 * middleware (`runAuthzPipeline`, `enforce: true`) with `REQUIRE_API_KEY` on, so
 * missing/invalid keys are rejected before the route runs, and a valid key is
 * carried into the route. They then assert the route's own policy: the API-key
 * connection allowlist is applied to credential selection (BLOCKER 1), the
 * endpoint category is registered so a restricted key is enforced on both `/v1/`
 * and `/api/v1/` paths (BLOCKER 2), call logs are metadata-only (BLOCKER 3), and
 * an echoed `vck_…` credential never survives into a client error (BLOCKER 4).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-evaluation-pipeline-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "evaluation-pipeline-secret";
process.env.REQUIRE_API_KEY = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { getCallLogs, getCallLogById } = await import("../../src/lib/usage/callLogs.ts");
const pipeline = await import("../../src/server/authz/pipeline.ts");
const route = await import("../../src/app/api/v1/evaluation-model/route.ts");

const originalFetch = globalThis.fetch;
const VAG_KEY = "vck_test_vercel_gateway_key";
const STATE = "Customer: I was charged twice on invoice INV-9. Please refund the duplicate.";

const QUESTIONS = {
  requestsRefund: { type: "boolean", instructions: "Is a refund requested?" },
};
const ANSWERS = {
  answers: { requestsRefund: { type: "boolean", probability: 0.99 } },
  usage: { inputTokens: 57, outputTokens: 0 },
  warnings: [],
};

type Captured = { url: string; init: RequestInit };

async function resetStorage() {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
}

async function seedVercelConnection(apiKey = VAG_KEY) {
  return providersDb.createProviderConnection({
    provider: "vercel-ai-gateway",
    authType: "apikey",
    name: `vag-${Math.random().toString(16).slice(2, 8)}`,
    apiKey,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

function stubUpstream(captured: Captured[], reply = { status: 200, body: ANSWERS as unknown }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function body(overrides: Record<string, unknown> = {}) {
  return { model: "vag/typesafe-ai/jev", state: STATE, questions: QUESTIONS, ...overrides };
}

/** Run the real middleware; if it allows the request, run the route handler. */
async function pipe(url: string, apiKey: string | undefined, payload: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const authz = await pipeline.runAuthzPipeline(
    new NextRequest(url, { method: "POST", headers, body: JSON.stringify(payload) }),
    { enforce: true }
  );
  if (authz.headers.get("x-middleware-next") !== "1") return { authz, routed: null };
  const routed = await route.POST(
    new Request(url, { method: "POST", headers, body: JSON.stringify(payload) })
  );
  return { authz, routed };
}

async function waitForCallLog(pathFilter: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await getCallLogs({ limit: 10 });
    const match = logs.find((l: { path?: string }) => l.path === pathFilter);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test.beforeEach(resetStorage);
test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("pipeline rejects a missing API key with 401 before the route runs", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { authz, routed } = await pipe("http://localhost/v1/evaluation-model", undefined, body());
  assert.equal(authz.status, 401);
  assert.equal(routed, null);
  assert.equal(captured.length, 0);
});

test("pipeline rejects an unregistered bearer with 401", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { authz, routed } = await pipe(
    "http://localhost/v1/evaluation-model",
    "not-a-real-key",
    body()
  );
  assert.equal(authz.status, 401);
  assert.equal(routed, null);
  assert.equal(captured.length, 0);
});

test("pipeline admits a valid key and the route returns 200", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-valid", "machine-eval", []);
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { authz, routed } = await pipe("http://localhost/v1/evaluation-model", created.key, body());
  assert.equal(authz.headers.get("x-middleware-next"), "1");
  assert.ok(routed);
  assert.equal(routed!.status, 200);
  assert.equal(captured.length, 1);
});

test("an endpoint-restricted key is blocked on /v1/evaluation-model", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-chat-only", "machine-eval", []);
  await apiKeysDb.updateApiKeyPermissions(created.id, { allowedEndpoints: ["chat"] });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/v1/evaluation-model", created.key, body());
  assert.ok(routed);
  assert.equal(routed!.status, 403);
  assert.match((await routed!.json()).error.message, /evaluation/);
  assert.equal(captured.length, 0);
});

test("an endpoint-restricted key is blocked on the /api/v1/evaluation-model path too", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-chat-only-api", "machine-eval", []);
  await apiKeysDb.updateApiKeyPermissions(created.id, { allowedEndpoints: ["chat"] });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/api/v1/evaluation-model", created.key, body());
  assert.ok(routed);
  assert.equal(routed!.status, 403);
  assert.equal(captured.length, 0);
});

test("a key restricted to the evaluation endpoint is admitted", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-only", "machine-eval", []);
  await apiKeysDb.updateApiKeyPermissions(created.id, { allowedEndpoints: ["evaluation"] });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/v1/evaluation-model", created.key, body());
  assert.ok(routed);
  assert.equal(routed!.status, 200);
  assert.equal(captured.length, 1);
});

test("a key restricted to another connection never selects the Vercel credential", async () => {
  await seedVercelConnection(); // connection id A
  const otherConnectionId = randomUUID(); // not A
  const created = await apiKeysDb.createApiKey("eval-conn-scoped", "machine-eval", [], {
    allowedConnections: [otherConnectionId],
  });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/v1/evaluation-model", created.key, body());
  assert.ok(routed);
  assert.equal(routed!.status, 400);
  assert.match((await routed!.json()).error.message, /No credentials for provider/);
  assert.equal(captured.length, 0, "upstream must not be called for an excluded connection");
});

test("an upstream error that echoes state and the credential is scrubbed from the client error and the log", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-echo", "machine-eval", []);
  const captured: Captured[] = [];
  // A hostile upstream reflects the caller's state AND the injected credential.
  stubUpstream(captured, {
    status: 400,
    body: { error: { message: `bad state ${STATE} using key ${VAG_KEY}` } },
  });

  const { routed } = await pipe("http://localhost/v1/evaluation-model", created.key, body());
  assert.ok(routed);
  assert.equal(routed!.status, 400);
  const clientMessage = (await routed!.json()).error.message as string;
  assert.equal(clientMessage.includes(VAG_KEY), false, "credential must not reach the client");

  const logRow = await waitForCallLog("/v1/evaluation-model");
  assert.ok(logRow);
  const detail = await getCallLogById(logRow.id);
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes(VAG_KEY), false, "credential must not be persisted");
  assert.equal(
    serialized.includes("charged twice"),
    false,
    "evaluated state must not be persisted"
  );
});

test("a network failure returns a generic 502 that leaks no internals", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-net", "machine-eval", []);
  globalThis.fetch = (async () => {
    throw new Error(`connect ECONNREFUSED with key ${VAG_KEY}`);
  }) as typeof fetch;

  const { routed } = await pipe("http://localhost/v1/evaluation-model", created.key, body());
  assert.ok(routed);
  assert.equal(routed!.status, 502);
  const message = (await routed!.json()).error.message as string;
  assert.equal(message, "Evaluation request failed");
  assert.equal(message.includes(VAG_KEY), false);
});
