import test from "node:test";
import assert from "node:assert/strict";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());

test("Claude clients can drain a context error event without a connection reset", async () => {
  const events = [
    {
      type: "response.created",
      response: { id: "resp_overflow", model: "gpt-5.6-sol", output: [] },
    },
    {
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          code: "context_length_exceeded",
          message: "Your input exceeds the context window of this model.",
        },
      },
    },
  ];
  const failures: unknown[] = [];
  const completions: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  }).pipeThrough(
    createSSEStream({
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-5.6-sol",
      onFailure: (failure) => {
        failures.push(failure);
      },
      onComplete: (completion) => {
        completions.push(completion);
      },
    })
  );
  const output = await new Response(stream).text();
  assert.match(output, /event: error/);
  assert.match(output, /context_length_exceeded/);
  assert.equal(failures.length, 1);
  assert.equal(completions.length, 1);
});
