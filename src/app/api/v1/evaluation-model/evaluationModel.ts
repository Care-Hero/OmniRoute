/**
 * Vercel AI Gateway evaluation models (e.g. `typesafe-ai/jev`) are not language
 * models: the gateway refuses them on chat completions ("Use the evaluation
 * generation API instead") and serves them only through the v4 evaluation
 * contract (vercel/ai `packages/gateway/src/gateway-evaluation-model.ts`):
 *
 *   POST {baseURL}/evaluation-model
 *   ai-model-id: <model>   ai-evaluation-model-specification-version: 4
 *   body { state: string, questions: Record<string, Question>, providerOptions? }
 *
 * OmniRoute already advertises these models under the `vag/` alias but had no
 * route for the contract, so callers had to bypass the gateway with a direct
 * Vercel key. This module holds the pure helpers; the route wires credentials,
 * policy and logging.
 */
import { resolveProviderId } from "@/shared/constants/providers";

export const EVALUATION_PROVIDER_ID = "vercel-ai-gateway";
export const EVALUATION_SPEC_VERSION = "4";
export const VERCEL_AI_GATEWAY_EVALUATION_URL =
  "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";

/** Request headers forwarded verbatim when the caller (an AI SDK client) sets them. */
const FORWARDED_REQUEST_HEADERS = [
  "ai-evaluation-model-specification-version",
  "ai-gateway-protocol-version",
] as const;

export interface ParsedEvaluationModel {
  provider: string;
  /** The model id as the upstream gateway expects it, alias prefix stripped. */
  upstreamModel: string;
}

/**
 * `vag/typesafe-ai/jev` or `vercel-ai-gateway/typesafe-ai/jev` → `typesafe-ai/jev`.
 * Returns null unless the prefix resolves to the Vercel AI Gateway provider —
 * no other provider serves the evaluation contract, so nothing else is routed.
 */
export function parseEvaluationModel(model: unknown): ParsedEvaluationModel | null {
  if (typeof model !== "string") return null;
  const slug = model.trim();
  const slash = slug.indexOf("/");
  if (slash <= 0) return null;
  const provider = resolveProviderId(slug.slice(0, slash));
  const upstreamModel = slug.slice(slash + 1).trim();
  if (provider !== EVALUATION_PROVIDER_ID || !upstreamModel) return null;
  return { provider, upstreamModel };
}

/** Model precedence: body `model` (OpenAI habit), then the AI SDK's `ai-model-id` header. */
export function requestedEvaluationModel(
  body: { model?: unknown },
  headers: Headers
): string | null {
  if (typeof body.model === "string" && body.model.trim()) return body.model.trim();
  const header = headers.get("ai-model-id");
  return header && header.trim() ? header.trim() : null;
}

export function buildUpstreamHeaders(
  requestHeaders: Headers,
  token: string,
  upstreamModel: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "ai-gateway-auth-method": "api-key",
    "ai-evaluation-model-specification-version": EVALUATION_SPEC_VERSION,
    "ai-gateway-protocol-version": "0.0.1",
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders.get(name);
    if (value && value.trim()) headers[name] = value.trim();
  }
  // Always the stripped id: the alias prefix is OmniRoute's, not the gateway's.
  headers["ai-model-id"] = upstreamModel;
  return headers;
}

/** Only the contract's fields go upstream; `model` and anything else stays here. */
export function buildUpstreamBody(body: {
  state: string;
  questions: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    state: body.state,
    questions: body.questions,
    ...(body.providerOptions ? { providerOptions: body.providerOptions } : {}),
  };
}

/** Vercel reports `usage.inputTokens/outputTokens`; call logs want OpenAI names. */
export function usageTokens(data: unknown): { prompt_tokens: number; completion_tokens: number } {
  const usage =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { usage?: unknown }).usage
      : undefined;
  const read = (key: string) => {
    const value =
      usage && typeof usage === "object" ? (usage as Record<string, unknown>)[key] : undefined;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return { prompt_tokens: read("inputTokens"), completion_tokens: read("outputTokens") };
}

/** Upstream error bodies are `{ error: { message } }` (gateway) or `{ message }`. */
export function upstreamErrorMessage(errData: unknown, status: number): string {
  if (errData && typeof errData === "object") {
    const record = errData as { error?: unknown; message?: unknown };
    const nested =
      record.error && typeof record.error === "object"
        ? (record.error as { message?: unknown }).message
        : record.error;
    for (const candidate of [nested, record.message]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return `Provider returned HTTP ${status}`;
}
