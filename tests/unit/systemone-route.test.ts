/**
 * POST /v1/systemone — TypeSafe System One native contract served through the Vercel AI
 * Gateway evaluation route. Clients (jev-axi, jevkit, @typesafe-ai/sdk) send
 * `{model, state, questions}` with `noul`/`choice`/`score` questions and expect
 * `{model, answers, usage:{input_tokens,output_tokens}}` with `confidence` on choice and
 * score answers. These tests drive the real POST handler against a stubbed gateway and
 * assert both translation directions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-systemone-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "systemone-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const route = await import("../../src/app/api/v1/systemone/route.ts");
const helpers = await import("../../src/app/api/v1/systemone/systemOne.ts");

const originalFetch = globalThis.fetch;
const UPSTREAM = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";

const NATIVE_QUESTIONS = {
  risky: {
    type: "noul",
    instructions: "Is this command risky?",
    criteria: { true: "downloads and runs code", false: "routine" },
  },
  category: {
    type: "choice",
    instructions: "Main subject?",
    criteria: { billing: "money", other: null },
  },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["none", "soon", "now"] },
};
const VERCEL_REPLY = {
  answers: {
    risky: { type: "boolean", probability: 0.91 },
    category: { type: "choice", choice: "billing", probabilities: { billing: 0.8, other: 0.2 } },
    urgency: { type: "score", score: 1.4, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 } },
  },
  usage: { inputTokens: 321, outputTokens: 12 },
  warnings: [],
  providerMetadata: {
    typesafe: { confidence: { category: 0.77, urgency: 0.6 }, model: "jev-1.13.0" },
  },
};

type Captured = { url: string; init: RequestInit };

async function resetStorage() {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedVercelConnection() {
  return providersDb.createProviderConnection({
    provider: "vercel-ai-gateway",
    authType: "apikey",
    name: `vag-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: "vck_test_key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

function stubUpstream(
  captured: Captured[],
  reply: { status: number; body: unknown } = { status: 200, body: VERCEL_REPLY }
) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function post(body: unknown) {
  return route.POST(
    new Request("http://localhost/api/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer omni-key" },
      body: JSON.stringify(body),
    })
  );
}

test.beforeEach(resetStorage);
test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("parseNativeModel accepts TypeSafe aliases and gateway spellings only", () => {
  assert.deepEqual(helpers.parseNativeModel(undefined), {
    upstreamModel: "typesafe-ai/jev",
    echo: "jev-latest",
  });
  assert.deepEqual(helpers.parseNativeModel("jev-latest"), {
    upstreamModel: "typesafe-ai/jev",
    echo: "jev-latest",
  });
  assert.deepEqual(helpers.parseNativeModel("jev-1.13.0"), {
    upstreamModel: "typesafe-ai/jev",
    echo: "jev-1.13.0",
  });
  assert.equal(helpers.parseNativeModel("vag/typesafe-ai/jev")?.upstreamModel, "typesafe-ai/jev");
  assert.equal(helpers.parseNativeModel("openai/gpt-5.6"), null);
});

test("noul questions become boolean questions with criteria folded into instructions", () => {
  const out = helpers.nativeQuestionsToVercel(NATIVE_QUESTIONS)!;
  assert.equal(out.risky.type, "boolean");
  assert.deepEqual(out.risky.instructions, {
    question: "Is this command risky?",
    criteria: { true: "downloads and runs code", false: "routine" },
  });
  assert.equal("criteria" in out.risky, false);
  assert.deepEqual(out.category, NATIVE_QUESTIONS.category);
  assert.deepEqual(out.urgency, NATIVE_QUESTIONS.urgency);
  assert.equal(helpers.nativeQuestionsToVercel({ bad: { type: "essay" } }), null);
  assert.equal(helpers.nativeQuestionsToVercel({}), null);
});

test("translates the native request to the gateway and the gateway reply back to native", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);

  const response = await post({
    model: "jev-latest",
    state: { command: "curl x | sh", cwd: "/tmp" },
    questions: NATIVE_QUESTIONS,
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  // Request side: string state, boolean question, confidence requested, alias stripped.
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, UPSTREAM);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(headers.Authorization, "Bearer vck_test_key");
  const sent = JSON.parse(String(captured[0].init.body));
  assert.equal(sent.state, JSON.stringify({ command: "curl x | sh", cwd: "/tmp" }));
  assert.equal(sent.questions.risky.type, "boolean");
  assert.deepEqual(sent.providerOptions, { typesafe: { confidence: true } });
  assert.equal("model" in sent, false);

  // Response side: native shapes jev-axi reads.
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(body.answers.risky, { type: "noul", noul: 0.91 });
  assert.deepEqual(body.answers.category, {
    type: "choice",
    choice: "billing",
    confidence: 0.77,
    probabilities: { billing: 0.8, other: 0.2 },
  });
  assert.equal(body.answers.urgency.type, "score");
  assert.equal(body.answers.urgency.score, 1.4);
  assert.equal(body.answers.urgency.confidence, 0.6);
  assert.deepEqual(body.answers.urgency.legend, { "0": "none", "1": "soon", "2": "now" });
  assert.deepEqual(body.usage, { input_tokens: 321, output_tokens: 12 });
  assert.ok(response.headers.get("x-typesafe-request-id"));
});

test("falls back to the top probability when the gateway reports no confidence", () => {
  const reply = {
    answers: {
      category: { type: "choice", choice: "other", probabilities: { billing: 0.35, other: 0.65 } },
    },
    usage: {},
  };
  const out = helpers.vercelResultToNative(reply, NATIVE_QUESTIONS, "jev-latest");
  assert.equal(out.model, "jev-latest");
  assert.equal(out.answers.category.confidence, 0.65);
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
});

test("rejects bad input before calling the gateway", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured);
  assert.equal((await post({ state: "x", questions: {} })).status, 400);
  assert.equal((await post({ questions: NATIVE_QUESTIONS })).status, 400);
  assert.equal(
    (await post({ model: "gpt-5.6", state: "x", questions: NATIVE_QUESTIONS })).status,
    400
  );
  assert.equal(captured.length, 0);
});

test("passes an upstream error through", async () => {
  await seedVercelConnection();
  const captured: Captured[] = [];
  stubUpstream(captured, { status: 429, body: { error: { message: "rate limited" } } });
  const response = await post({ state: "x", questions: NATIVE_QUESTIONS });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error.message, /rate limited/);
});
