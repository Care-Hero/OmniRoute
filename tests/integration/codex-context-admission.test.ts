import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-context-admission-"));
process.env.DATA_DIR = dataDir;
const originalMode = process.env.CODEX_CONTEXT_CHECK_MODE;
const originalFetch = globalThis.fetch;
const core = await import("../../src/lib/db/core.ts");
const compression = await import("../../src/lib/db/compression.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const log = { info() {}, debug() {}, warn() {}, error() {} };
let dispatches = 0;
let failure = false;
let failureCode = "context_length_exceeded";
let failureMessage = "Your input exceeds the context window of this model.";

test.before(async () => {
  await compression.updateCompressionSettings({ enabled: false, defaultMode: "off" });
  globalThis.fetch = async () => {
    dispatches++;
    const response = failure
      ? {
          id: "resp_admission",
          status: "failed",
          error: { code: failureCode, message: failureMessage },
        }
      : {
          id: "resp_admission",
          model: "gpt-5.6-sol",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ACCEPTED" }],
            },
          ],
          usage: { input_tokens: 850000, output_tokens: 1 },
        };
    const type = failure ? "response.failed" : "response.completed";
    return new Response(`event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.CODEX_CONTEXT_CHECK_MODE;
  else process.env.CODEX_CONTEXT_CHECK_MODE = originalMode;
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function invoke(stream = false, content = "apple ".repeat(850000)) {
  const body = {
    model: "gpt-5.6-sol",
    max_tokens: 1024,
    stream,
    messages: [{ role: "user", content }],
  };
  return handleChatCore({
    body,
    modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    clientRawRequest: {
      endpoint: "/v1/messages",
      body,
      headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
    },
    userAgent: "claude-cli/2.1.263",
    log,
  });
}

test("default local admission rejects an oversized estimate without dispatch", async () => {
  delete process.env.CODEX_CONTEXT_CHECK_MODE;
  dispatches = 0;
  const result = await invoke();
  assert.equal(result.status, 400);
  assert.equal(dispatches, 0);
});

test("upstream admission dispatches the same body through the real Codex handler", async () => {
  process.env.CODEX_CONTEXT_CHECK_MODE = "upstream";
  dispatches = 0;
  const result = await invoke();
  assert.equal(result.success, true, result.error);
  assert.equal(dispatches, 1);
  assert.match(await result.response.text(), /ACCEPTED/);
});

test("upstream context overflow retains its actionable error for nonstreaming clients", async () => {
  process.env.CODEX_CONTEXT_CHECK_MODE = "upstream";
  failure = true;
  const result = await invoke();
  const text = await result.response.text();
  assert.equal(result.status, 400, text);
  assert.match(text, /context_length_exceeded/);
  assert.doesNotMatch(text, /empty response/);
});

test("upstream context overflow is visible to streaming Claude clients", async () => {
  process.env.CODEX_CONTEXT_CHECK_MODE = "upstream";
  failure = true;
  const result = await invoke(true);
  const text = await result.response.text();
  assert.match(text, /context_length_exceeded|exceeds the context window/);
  assert.doesNotMatch(text, /empty response/);
});

test("buffered upstream failure messages are sanitized before returning to the client", async () => {
  process.env.CODEX_CONTEXT_CHECK_MODE = "upstream";
  failure = true;
  failureMessage =
    "Your input exceeds the context window.\n    at handler (/private/internal.js:12:3)";
  const result = await invoke(false, "hello");
  const body = await result.response.text();
  assert.equal(result.status, 400);
  assert.match(body, /context_length_exceeded/);
  assert.doesNotMatch(body, /internal\.js|at handler/);
});

test("buffered rate-limit errors retain their status and code", async () => {
  process.env.CODEX_CONTEXT_CHECK_MODE = "upstream";
  failure = true;
  failureCode = "rate_limit_exceeded";
  failureMessage = "Too many requests";
  const result = await invoke(false, "hello");
  assert.equal(result.status, 429);
  assert.match(await result.response.text(), /rate_limit_exceeded/);
});
