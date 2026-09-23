/**
 * POST /v1/evaluation-model — Vercel AI Gateway v4 evaluation passthrough.
 *
 * Evaluation models (`typesafe-ai/jev`) are refused on chat completions by the
 * gateway ("is an evaluation model, not a language model"), so the route must
 * speak the v4 contract: `{baseURL}/evaluation-model` with `ai-model-id` +
 * `ai-evaluation-model-specification-version` headers and a `{ state, questions }`
 * body, using the stored `vercel-ai-gateway` credential. These tests drive the
 * real POST handler against a stubbed upstream and assert the wire shape, the
 * alias handling, the error passthrough and the persisted call-log row.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-evaluation-model-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "evaluation-model-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const route = await import("../../src/app/api/v1/evaluation-model/route.ts");
const helpers = await import("../../src/app/api/v1/evaluation-model/evaluationModel.ts");

const originalFetch = globalThis.fetch;
const UPSTREAM = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const VAG_KEY = "vck_test_vercel_gateway_key";

const QUESTIONS = {
  category: {
    type: "choice",
    instructions: "What is the main subject?",
    criteria: { billing: "Charges or refunds", other: null },
  },
  requestsRefund: { type: "boolean", instructions: "Is a refund requested?" },
};
const ANSWERS = {
  answers: {
    category: { type: "choice", choice: "billing", probabilities: { billing: 0.97, other: 0.03 } },
    requestsRefund: { type: "boolean", probability: 0.99 },
  },
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

function stubUpstream(
  captured: Captured[],
  reply: { status: number; body: unknown } = { status: 200, body: ANSWERS }
) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return route.POST(
    new Request("http://localhost/api/v1/evaluation-model", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
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

test("parseEvaluationModel resolves the vag alias and the full provider id, nothing else", () => {
  assert.deepEqual(helpers.parseEvaluationModel("vag/typesafe-ai/jev"), {
    provider: "vercel-ai-gateway",
    upstreamModel: "typesafe-ai/jev",
  });
  assert.deepEqual(helpers.parseEvaluationModel("vercel-ai-gateway/typesafe-ai/jev"), {
    provider: "vercel-ai-gateway",
    upstreamModel: "typesafe-ai/jev",
  });
  assert.equal(helpers.parseEvaluationModel("openai/gpt-5.6"), null);
  assert.equal(helpers.parseEvaluationModel("typesafe-ai/jev"), null);
  assert.equal(helpers.parseEvaluationModel("vag/"), null);
  assert.equal(helpers.parseEvaluationModel(42), null);
});

test("forwards the v4 contract to Vercel with the stored key and the alias stripped", async () => {
  await seedVercelConnection();
  const created = await apiKeysDb.createApiKey("eval-key", "machine-eval", []);
  const captured: Captured[] = [];
  stubUpstream(captured);

  const response = await post(
    {
      model: "vag/typesafe-ai/jev",
      state: "Customer: I was charged twice. Please refund the duplicate.",
      questions: QUESTIONS,
      providerOptions: { typesafe: { confidence: true } },
    },
    { Authorization: `Bearer ${created.key}` }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ANSWERS);
  assert.equal(response.headers.get("x-omniroute-provider"), "vag");
  assert.equal(response.headers.get("x-omniroute-model"), "typesafe-ai/jev");

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, UPSTREAM);
  assert.equal(captured[0].init.method, "POST");
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${VAG_KEY}`);
  assert.equal(headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(headers["ai-evaluation-model-specification-version"], "4");
  assert.equal(headers["ai-gateway-protocol-version"], "0.0.1");
  assert.equal(headers["ai-gateway-auth-method"], "api-key");
  const body = JSON.parse(String(captured[0].init.body));
  assert.deepEqual(Object.keys(body).sort(), ["providerOptions", "questions", "state"]);
  assert.equal(body.state, "Customer: I was charged twice. Please refund the duplicate.");
  assert.deepEqual(body.questions, QUESTIONS);
  assert.equal("model" in body, false);

  const logRow = await waitForCallLog("/v1/evaluation-model");
  assert.ok(logRow, "call log row persisted");
  assert.equal(logRow.status, 200);
  assert.equal(logRow.provider, "vercel-ai-gateway");
  assert.equal(logRow.model, "vag/typesafe-ai/jev");
  assert.equal(logRow.apiKeyId, created.id);
  assert.equal(logRow.tokens?.in, 57);
  // The evaluated state is the caller's text and never lands in the call log.
  assert.equal(JSON.stringify(logRow).includes("charged twice"), false);
});

test("takes the model from the AI SDK ai-model-id header when the body has none", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const response = await post(
    { state: "hello", questions: QUESTIONS },
    {
      "ai-model-id": "vag/typesafe-ai/jev",
      "ai-evaluation-model-specification-version": "4",
      "ai-gateway-protocol-version": "0.0.2",
    }
  );

  assert.equal(response.status, 200);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(headers["ai-gateway-protocol-version"], "0.0.2");
});

test("rejects models outside the Vercel AI Gateway without calling upstream", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const response = await post({
    model: "openai/gpt-5.6",
    state: "hello",
    questions: QUESTIONS,
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.message, /Invalid evaluation model/);
  assert.equal(captured.length, 0);
});

test("rejects a body without state or questions", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const noState = await post({ model: "vag/typesafe-ai/jev", questions: QUESTIONS });
  assert.equal(noState.status, 400);
  const noQuestions = await post({ model: "vag/typesafe-ai/jev", state: "x", questions: {} });
  assert.equal(noQuestions.status, 400);
  const noModel = await post({ state: "x", questions: QUESTIONS });
  assert.equal(noModel.status, 400);
  assert.match((await noModel.json()).error.message, /Model is required/);
  assert.equal(captured.length, 0);
});

test("reports a missing Vercel AI Gateway connection instead of calling upstream", async () => {
  const captured: Captured[] = [];
  stubUpstream(captured);

  const response = await post({
    model: "vag/typesafe-ai/jev",
    state: "hello",
    questions: QUESTIONS,
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /No credentials for provider/);
  assert.equal(captured.length, 0);
});

test("passes an upstream error status and message through and logs it", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured, {
    status: 400,
    body: {
      error: {
        message: "Model 'typesafe-ai/nope' is not an evaluation model.",
        type: "invalid_request_error",
      },
    },
  });

  const response = await post({
    model: "vag/typesafe-ai/nope",
    state: "hello",
    questions: QUESTIONS,
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /not an evaluation model/);
  const logRow = await waitForCallLog("/v1/evaluation-model");
  assert.ok(logRow);
  assert.equal(logRow.status, 400);
});

test("a failed upstream fetch becomes a 502, not a crash", async () => {
  await seedVercelConnection();
  globalThis.fetch = (async () => {
    throw new Error("socket hang up");
  }) as typeof fetch;

  const response = await post({
    model: "vag/typesafe-ai/jev",
    state: "hello",
    questions: QUESTIONS,
  });

  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /Evaluation request failed/);
});
