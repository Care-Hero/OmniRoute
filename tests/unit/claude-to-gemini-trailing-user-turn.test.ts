/**
 * Claude → Gemini (vertex/gemini-*) must never emit `contents` that end on a
 * `model` turn when the Claude request ends on a user message. Vertex rejects
 * such a request with 400 "Requests ending with a model turn are not supported."
 *
 * Seen after an ABORTED Claude Code turn: the CLI answers the dangling tool_use
 * with an is_error tool_result plus "[Request interrupted by user for tool use]"
 * and merges the next prompt into the same user message. These tests pin that
 * shape (and its bisected variants, the /compact and resume shapes) in both the
 * signature-less "context" mode and the signed native functionCall mode, and
 * check that the already-correct shapes are unchanged.
 *
 * The one reproducible way the direct translator ended on `model` was a trailing
 * user message whose every block was silently dropped — e.g. a `document` block
 * (PDF / plain text attachment), which the translator had no case for.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const {
  buildGeminiThoughtSignatureKey,
  storeGeminiThoughtSignature,
  clearGeminiThoughtSignatures,
} = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");

type Part = Record<string, unknown>;

const MODEL = "gemini-3.8-flash";
const NS = "conn-trailing-user-turn";
const TOOL_ID = "toolu_trailing_1";
const INTERRUPT = "[Request interrupted by user for tool use]";
const PROMPT = "ok, try something else";
const DENIED = "The user doesn't want to proceed with this tool use.";

test.beforeEach(() => {
  clearGeminiThoughtSignatures();
});

function vertexCreds(signed: boolean) {
  if (signed) {
    storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(NS, TOOL_ID), "SIG_TRAILING");
  }
  return { _provider: "vertex", _signatureNamespace: NS };
}

function toolUseTurn(extra: unknown[] = [{ type: "text", text: "Writing the note." }]) {
  return {
    role: "assistant",
    content: [
      ...extra,
      { type: "tool_use", id: TOOL_ID, name: "WriteNote", input: { path: "a.md" } },
    ],
  };
}

function requestEndingWith(lastUser: unknown[], assistant = toolUseTurn()) {
  return {
    model: MODEL,
    system: [{ type: "text", text: "You are a helpful agent." }],
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Write the note" },
      assistant,
      { role: "user", content: lastUser },
    ],
  };
}

function assertWellFormed(contents: Array<{ role: string; parts: Part[] }>) {
  assert.ok(contents.length > 0, "contents must not be empty");
  assert.equal(contents.at(-1)!.role, "user", "contents must end on a user turn");
  for (let i = 0; i < contents.length; i++) {
    assert.ok(contents[i].parts.length > 0, `contents[${i}] has no parts`);
    for (const part of contents[i].parts) {
      if ("text" in part) assert.notEqual(part.text, "", `contents[${i}] has an empty text part`);
    }
    if (i > 0) assert.notEqual(contents[i].role, contents[i - 1].role, `same role at ${i}`);
  }
}

const lastTexts = (contents: Array<{ parts: Part[] }>) =>
  contents
    .at(-1)!
    .parts.filter((p) => typeof p.text === "string")
    .map((p) => p.text);

const toolResult = (content: unknown, isError = true) => ({
  type: "tool_result",
  tool_use_id: TOOL_ID,
  content,
  ...(isError ? { is_error: true } : {}),
});

const BISECT_VARIANTS: Record<string, unknown[]> = {
  "tool_result(is_error) + interrupt + prompt": [
    toolResult(DENIED),
    { type: "text", text: INTERRUPT },
    { type: "text", text: PROMPT },
  ],
  "tool_result without is_error": [
    toolResult(DENIED, false),
    { type: "text", text: INTERRUPT },
    { type: "text", text: PROMPT },
  ],
  "tool_result + prompt (no interrupt text)": [toolResult(DENIED), { type: "text", text: PROMPT }],
  "tool_result + interrupt only": [toolResult(DENIED), { type: "text", text: INTERRUPT }],
  "tool_result alone": [toolResult(DENIED)],
  "tool_result with array content": [
    toolResult([{ type: "text", text: DENIED }]),
    { type: "text", text: INTERRUPT },
    { type: "text", text: PROMPT },
  ],
  "tool_result with empty content": [
    toolResult(""),
    { type: "text", text: INTERRUPT },
    { type: "text", text: PROMPT },
  ],
  "prompt with cache_control": [
    toolResult(DENIED),
    { type: "text", text: INTERRUPT },
    { type: "text", text: PROMPT, cache_control: { type: "ephemeral" } },
  ],
};

for (const signed of [false, true]) {
  const mode = signed ? "signed functionCall" : "context mode";
  for (const [name, lastUser] of Object.entries(BISECT_VARIANTS)) {
    test(`vertex ${mode}: ${name} ends on a user turn`, () => {
      const result = claudeToGeminiRequest(
        MODEL,
        requestEndingWith(lastUser),
        true,
        vertexCreds(signed)
      );
      assertWellFormed(result.contents);
    });
  }

  test(`vertex ${mode}: aborted-turn shape keeps the tool result, interrupt text and prompt in order`, () => {
    const lastUser = BISECT_VARIANTS["tool_result(is_error) + interrupt + prompt"];
    const result = claudeToGeminiRequest(
      MODEL,
      requestEndingWith(lastUser),
      true,
      vertexCreds(signed)
    );
    assertWellFormed(result.contents);
    const tail = result.contents.at(-1)!.parts;
    if (signed) {
      assert.equal(result.contents.at(-2)!.role, "model");
      assert.ok(result.contents.at(-2)!.parts.some((p: Part) => p.functionCall));
      assert.deepEqual(tail[0], {
        functionResponse: { name: "WriteNote", response: { result: DENIED } },
      });
      assert.deepEqual(tail.slice(1), [{ text: INTERRUPT }, { text: PROMPT }]);
    } else {
      assert.match(tail.at(-3).text, /previous_tool_result_context/);
      assert.ok(tail.at(-3).text.includes(DENIED));
      assert.deepEqual(lastTexts(result.contents).slice(-2), [INTERRUPT, PROMPT]);
    }
  });

  test(`vertex ${mode}: thinking-only assistant turn before the aborted tool_use`, () => {
    const assistant = toolUseTurn([{ type: "thinking", thinking: "", signature: "sig" }]);
    const lastUser = BISECT_VARIANTS["tool_result(is_error) + interrupt + prompt"];
    const result = claudeToGeminiRequest(
      MODEL,
      requestEndingWith(lastUser, assistant),
      true,
      vertexCreds(signed)
    );
    assertWellFormed(result.contents);
    assert.deepEqual(lastTexts(result.contents).slice(-2), [INTERRUPT, PROMPT]);
  });

  test(`vertex ${mode}: resume shape (synthetic "No response requested." then prompt)`, () => {
    const body = requestEndingWith(BISECT_VARIANTS["tool_result(is_error) + interrupt + prompt"]);
    body.messages.push(
      { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
      { role: "user", content: [{ type: "text", text: "and now?" }] }
    );
    const result = claudeToGeminiRequest(MODEL, body, true, vertexCreds(signed));
    assertWellFormed(result.contents);
    assert.deepEqual(lastTexts(result.contents), ["and now?"]);
  });

  test(`vertex ${mode}: /compact shape ends on the summary instruction`, () => {
    const compact = "CRITICAL: Respond with TEXT ONLY. Summarize the conversation so far.";
    const result = claudeToGeminiRequest(
      MODEL,
      requestEndingWith([
        toolResult(DENIED),
        { type: "text", text: INTERRUPT },
        { type: "text", text: compact },
      ]),
      true,
      vertexCreds(signed)
    );
    assertWellFormed(result.contents);
    assert.equal(lastTexts(result.contents).at(-1), compact);
  });
}

// ── Trailing user turns whose blocks used to be dropped ─────────────────────

test("a trailing user document (base64 PDF) becomes inlineData instead of vanishing", () => {
  const result = claudeToGeminiRequest(
    MODEL,
    requestEndingWith([
      toolResult("done", false),
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
      },
    ]),
    true,
    vertexCreds(true)
  );
  assertWellFormed(result.contents);
  assert.deepEqual(result.contents.at(-1)!.parts.at(-1), {
    inlineData: { mimeType: "application/pdf", data: "JVBERi0x" },
  });
});

test("a trailing user-only document message (plain text source) ends on a user turn", () => {
  const result = claudeToGeminiRequest(
    MODEL,
    {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "notes.txt",
              source: { type: "text", media_type: "text/plain", data: "line one" },
            },
          ],
        },
      ],
    },
    true,
    vertexCreds(false)
  );
  assertWellFormed(result.contents);
  assert.deepEqual(lastTexts(result.contents), ["notes.txt\nline one"]);
});

test("a document with a content-block source keeps its text blocks", () => {
  const result = claudeToGeminiRequest(
    MODEL,
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "content",
                content: [
                  { type: "text", text: "first" },
                  { type: "text", text: "second" },
                ],
              },
            },
          ],
        },
      ],
    },
    true,
    vertexCreds(false)
  );
  assertWellFormed(result.contents);
  assert.deepEqual(lastTexts(result.contents), ["first", "second"]);
});

// ── Already-correct shapes stay byte-identical ──────────────────────────────

test("plain tool_result turn (signed) is unchanged", () => {
  const result = claudeToGeminiRequest(
    MODEL,
    requestEndingWith([toolResult("42", false)]),
    true,
    vertexCreds(true)
  );
  assert.deepEqual(result.contents, [
    { role: "user", parts: [{ text: "Write the note" }] },
    {
      role: "model",
      parts: [
        { text: "Writing the note." },
        {
          thoughtSignature: "SIG_TRAILING",
          functionCall: { name: "WriteNote", args: { path: "a.md" } },
        },
      ],
    },
    {
      role: "user",
      parts: [{ functionResponse: { name: "WriteNote", response: { result: "42" } } }],
    },
  ]);
});

test("parallel signed tool calls keep one functionResponse per call", () => {
  const second = "toolu_trailing_2";
  storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(NS, second), "SIG_TWO");
  const result = claudeToGeminiRequest(
    MODEL,
    {
      messages: [
        { role: "user", content: "read both" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: TOOL_ID, name: "Read", input: { p: "a" } },
            { type: "tool_use", id: second, name: "Read", input: { p: "b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: TOOL_ID, content: "A" },
            { type: "tool_result", tool_use_id: second, content: "B" },
          ],
        },
      ],
    },
    true,
    vertexCreds(true)
  );
  assertWellFormed(result.contents);
  assert.deepEqual(result.contents.at(-1)!.parts, [
    { functionResponse: { name: "Read", response: { result: "A" } } },
    { functionResponse: { name: "Read", response: { result: "B" } } },
  ]);
  assert.equal(result.contents.at(-2)!.parts.filter((p: Part) => p.functionCall).length, 2);
});

test("text-only conversation is unchanged", () => {
  const result = claudeToGeminiRequest(
    MODEL,
    {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "bye" }] },
      ],
    },
    true,
    vertexCreds(false)
  );
  assert.deepEqual(result.contents, [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "hello" }] },
    { role: "user", parts: [{ text: "bye" }] },
  ]);
});
