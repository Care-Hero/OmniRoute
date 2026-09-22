/**
 * POST /v1/systemone — pipeline-level security tests (PR #5 review fixes).
 *
 * These drive requests through the real authz middleware (`runAuthzPipeline`,
 * `enforce: true`) with `REQUIRE_API_KEY` on: missing/invalid keys are rejected
 * before the route, a valid key is carried into it. They then assert the route's
 * own guarantees: the API-key connection allowlist reaches credential selection
 * (BLOCKER 1), the endpoint category is enforced on both `/v1/` and `/api/v1/`
 * (BLOCKER 2), logs are metadata-only and errors scrub the credential and the
 * evaluated state (BLOCKERs 3–4), a question named `__proto__` survives both
 * translation directions (SHOULD-FIX), and a malformed upstream success body
 * becomes a sanitized 502 instead of a silently-successful native response.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-systemone-pipeline-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "systemone-pipeline-secret";
process.env.REQUIRE_API_KEY = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { getCallLogs, getCallLogById } = await import("../../src/lib/usage/callLogs.ts");
const pipeline = await import("../../src/server/authz/pipeline.ts");
const route = await import("../../src/app/api/v1/systemone/route.ts");

const originalFetch = globalThis.fetch;
const VAG_KEY = "vck_test_key";
const STATE = "Patient NRIC S1234567A requests a refund for order ORD-42.";

const QUESTIONS = { risky: { type: "noul", instructions: "Is this risky?" } };
const REPLY = {
  answers: { risky: { type: "boolean", probability: 0.91 } },
  usage: { inputTokens: 100, outputTokens: 3 },
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

function stubUpstream(captured: Captured[], reply = { status: 200, body: REPLY as unknown }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return { model: "jev-latest", state: STATE, questions: QUESTIONS, ...overrides };
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

  const { authz, routed } = await pipe("http://localhost/v1/systemone", undefined, makeBody());
  assert.equal(authz.status, 401);
  assert.equal(routed, null);
  assert.equal(captured.length, 0);
});

test("pipeline rejects an unregistered bearer with 401", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { authz, routed } = await pipe("http://localhost/v1/systemone", "omni-key", makeBody());
  assert.equal(authz.status, 401);
  assert.equal(routed, null);
  assert.equal(captured.length, 0);
});

test("pipeline admits a valid key and the route returns 200", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-valid", "machine-s1", []);
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { authz, routed } = await pipe("http://localhost/v1/systemone", created.key, makeBody());
  assert.equal(authz.headers.get("x-middleware-next"), "1");
  assert.ok(routed);
  assert.equal(routed!.status, 200);
  assert.equal(captured.length, 1);
});

test("an endpoint-restricted key is blocked on /v1/systemone", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-chat-only", "machine-s1", []);
  await apiKeysDb.updateApiKeyPermissions(created.id, { allowedEndpoints: ["chat"] });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/v1/systemone", created.key, makeBody());
  assert.ok(routed);
  assert.equal(routed!.status, 403);
  assert.equal(captured.length, 0);
});

test("an endpoint-restricted key is blocked on the /api/v1/systemone path too", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-chat-only-api", "machine-s1", []);
  await apiKeysDb.updateApiKeyPermissions(created.id, { allowedEndpoints: ["chat"] });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/api/v1/systemone", created.key, makeBody());
  assert.ok(routed);
  assert.equal(routed!.status, 403);
  assert.equal(captured.length, 0);
});

test("a key restricted to another connection never selects the Vercel credential", async () => {
  await seedVercelConnection(); // connection id A
  const created = await apiKeysDb.createApiKey("s1-conn-scoped", "machine-s1", [], {
    allowedConnections: [randomUUID()], // not A
  });
  const captured: Captured[] = [];
  stubUpstream(captured);

  const { routed } = await pipe("http://localhost/v1/systemone", created.key, makeBody());
  assert.ok(routed);
  assert.equal(routed!.status, 400);
  assert.match((await routed!.json()).error.message, /No credentials for provider/);
  assert.equal(captured.length, 0);
});

test("an upstream error that echoes state and the credential is scrubbed from the client error and the log", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-echo", "machine-s1", []);
  const captured: Captured[] = [];
  stubUpstream(captured, {
    status: 400,
    body: { error: { message: `rejected ${STATE} with key ${VAG_KEY}` } },
  });

  const { routed } = await pipe("http://localhost/v1/systemone", created.key, makeBody());
  assert.ok(routed);
  assert.equal(routed!.status, 400);
  const clientMessage = (await routed!.json()).error.message as string;
  assert.equal(clientMessage.includes(VAG_KEY), false);

  const logRow = await waitForCallLog("/v1/systemone");
  assert.ok(logRow);
  const serialized = JSON.stringify(await getCallLogById(logRow.id));
  assert.equal(serialized.includes(VAG_KEY), false, "credential must not be persisted");
  assert.equal(serialized.includes("S1234567A"), false, "evaluated state must not be persisted");
});

test("a malformed upstream success body becomes a sanitized 502, not an empty native answer", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-malformed", "machine-s1", []);
  const captured: Captured[] = [];
  stubUpstream(captured, { status: 200, body: {} }); // no answers at all

  const { routed } = await pipe("http://localhost/v1/systemone", created.key, makeBody());
  assert.ok(routed);
  assert.equal(routed!.status, 502);
  assert.match((await routed!.json()).error.message, /malformed evaluation result/);
  assert.equal(captured.length, 1, "the upstream was called; the 502 is our validation");
});

test("an answer of an unknown type for a question also yields a 502", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-badtype", "machine-s1", []);
  const captured: Captured[] = [];
  // `risky` is a noul question, but the answer is a score with no probability.
  stubUpstream(captured, {
    status: 200,
    body: { answers: { risky: { type: "score", score: 1 } }, usage: {} },
  });

  const { routed } = await pipe("http://localhost/v1/systemone", created.key, makeBody());
  assert.ok(routed);
  assert.equal(routed!.status, 502);
});

test("a question named __proto__ survives both translation directions", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("s1-proto", "machine-s1", []);

  // JSON.parse yields OWN enumerable `__proto__` keys (object literals would set
  // the prototype instead), so build request and reply from raw JSON.
  const questions = JSON.parse(
    '{"__proto__":{"type":"noul","instructions":"is proto?"},"normal":{"type":"noul","instructions":"n?"}}'
  );
  const reply = JSON.parse(
    '{"answers":{"__proto__":{"type":"boolean","probability":0.7},"normal":{"type":"boolean","probability":0.4}},"usage":{"inputTokens":5,"outputTokens":1}}'
  );
  const captured: Captured[] = [];
  stubUpstream(captured, { status: 200, body: reply });

  const url = "http://localhost/v1/systemone";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${created.key}` };
  const routed = await route.POST(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "jev-latest", state: "hi", questions }),
    })
  );
  assert.equal(routed.status, 200);

  // Request side: `__proto__` reached the gateway as an OWN question key.
  const sentQuestions = JSON.parse(String(captured[0].init.body)).questions;
  assert.ok(
    Object.prototype.hasOwnProperty.call(sentQuestions, "__proto__"),
    "__proto__ question must be forwarded as an own key"
  );

  // Response side: `__proto__` came back as an OWN native answer.
  const answers = (await routed.json()).answers;
  assert.ok(
    Object.prototype.hasOwnProperty.call(answers, "__proto__"),
    "__proto__ answer must round-trip as an own key"
  );
  assert.equal(answers.normal.type, "noul");
});
