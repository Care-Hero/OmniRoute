import test from "node:test";
import assert from "node:assert/strict";
import { resolveContextAdmissionLimits } from "../../open-sse/handlers/chatCore/outputTokenBudget.ts";
import { enforceOutputTokenBudget } from "../../open-sse/handlers/chatCore/outputTokenBudget.ts";

test("Codex upstream admission accepts an oversized heuristic and preserves the output cap", () => {
  // The live 850K-token ordinary-word probe was estimated above 1.4M by chars/4.
  const limits = resolveContextAdmissionLimits("codex", 872000, 872000, "upstream");
  const result = enforceOutputTokenBudget(
    { max_tokens: 200000 },
    1450000,
    limits.contextLimit,
    0,
    128000,
    limits.maxInputTokens
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.body.max_tokens, 128000);
});

test("local admission remains the default, including invalid mode values", () => {
  for (const mode of [undefined, "local", "true", "invalid"]) {
    const limits = resolveContextAdmissionLimits("codex", 872000, 872000, mode);
    assert.deepEqual(limits, { contextLimit: 872000, maxInputTokens: 872000 });
    assert.equal(
      enforceOutputTokenBudget({}, 1450000, limits.contextLimit, 0, 128000, limits.maxInputTokens)
        .ok,
      false
    );
  }
});

test("Codex opt-in never disables other providers' admission checks", () => {
  for (const provider of ["openai", "claude", "gemini", "nvidia", ""]) {
    assert.deepEqual(resolveContextAdmissionLimits(provider, 272000, 144000, "upstream"), {
      contextLimit: 272000,
      maxInputTokens: 144000,
    });
  }
});

test("upstream admission still removes invalid output limits", () => {
  const limits = resolveContextAdmissionLimits("codex", 872000, null, "upstream");
  const result = enforceOutputTokenBudget(
    { max_tokens: -1 },
    1450000,
    limits.contextLimit,
    0,
    128000,
    limits.maxInputTokens
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.body.max_tokens, undefined);
});
