import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1EvaluationModelSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { saveCallLog } from "@/lib/usageDb";
import { calculateCost } from "@/lib/usage/costCalculator";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { CORS_HEADERS } from "@omniroute/open-sse/utils/cors.ts";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import * as log from "@/sse/utils/logger";
import {
  buildUpstreamBody,
  buildUpstreamHeaders,
  parseEvaluationModel,
  redactSelectedCredential,
  requestedEvaluationModel,
  upstreamErrorMessage,
  usageTokens,
  VERCEL_AI_GATEWAY_EVALUATION_URL,
} from "./evaluationModel";

const LOG_PATH = "/v1/evaluation-model";
const UPSTREAM_TIMEOUT_MS = 60_000;

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/evaluation-model — Vercel AI Gateway v4 evaluation contract.
 *
 * Model `vag/<id>` (or `vercel-ai-gateway/<id>`), from the body or the AI SDK's
 * `ai-model-id` header. The stored Vercel AI Gateway credential is injected;
 * the answer body is passed through unchanged. See ./evaluationModel.ts.
 */
async function postHandler(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1EvaluationModelSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  const requestedModel = requestedEvaluationModel(body, request.headers);
  if (!requestedModel) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Model is required: body `model` or the `ai-model-id` header, e.g. vag/typesafe-ai/jev"
    );
  }
  const parsed = parseEvaluationModel(requestedModel);
  if (!parsed) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid evaluation model: ${requestedModel}. Use format: vag/<model> (Vercel AI Gateway evaluation models only)`
    );
  }
  const { provider, upstreamModel } = parsed;
  const model = `vag/${upstreamModel}`;

  const policy = await enforceApiKeyPolicy(request, model);
  if (policy.rejection) return policy.rejection;
  const apiKeyId = policy.apiKeyInfo?.id || undefined;
  const apiKeyName = policy.apiKeyInfo?.name || undefined;

  // Honour the key's connection allowlist exactly as chat completions does: pass
  // it into credential selection so a restricted key can never draw another
  // account's Vercel credential. An empty/absent allowlist means unrestricted
  // (getProviderCredentials only filters when the list is non-empty); a
  // restricted key whose connections don't match this provider selects nothing.
  const allowedConnections = policy.apiKeyInfo?.allowedConnections ?? null;
  const credentials = await getProviderCredentialsWithQuotaPreflight(
    provider,
    null,
    allowedConnections
  );
  if (!credentials) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse(provider, credentials);
  }
  const token =
    (credentials as { apiKey?: string; accessToken?: string }).apiKey ||
    (credentials as { accessToken?: string }).accessToken;
  const connectionId = (credentials as { connectionId?: string }).connectionId || null;
  if (!token) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No API key on the ${provider} connection`);
  }

  // Per-connection proxy pinning, same as chat/embeddings/rerank (#7350). A bare
  // fetch still honours the process-wide ALL_PROXY via the patched global fetch.
  let proxyInfo: Awaited<ReturnType<typeof resolveProxyForConnection>> | null = null;
  if (connectionId) {
    try {
      proxyInfo = await resolveProxyForConnection(connectionId, apiKeyId, provider);
    } catch (err) {
      log.error("EVALUATION", `Proxy resolution failed for connection ${connectionId}: ${err}`);
    }
  }

  const upstreamBody = buildUpstreamBody(body);
  // Call logs never carry the evaluated state: it is the caller's conversation
  // text. Question names and the state size are enough to audit a call.
  const loggedRequest = {
    model,
    questions: Object.keys(body.questions),
    stateChars: body.state.length,
  };
  const startTime = Date.now();
  const doFetch = () =>
    fetch(VERCEL_AI_GATEWAY_EVALUATION_URL, {
      method: "POST",
      headers: buildUpstreamHeaders(request.headers, token, upstreamModel),
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

  try {
    const res = connectionId
      ? await runWithProxyContext(proxyInfo?.proxy || null, doFetch)
      : await doFetch();

    if (!res.ok) {
      const errData: unknown = await res.json().catch(() => ({}));
      // Strip the exact injected credential before the upstream free-text
      // reaches the client, then let errorResponse's shared sanitizer run.
      const errorMessage = redactSelectedCredential(
        upstreamErrorMessage(errData, res.status),
        token
      );
      // Metadata-only log: never persist the upstream body or its free-text
      // error — either can echo the caller's evaluated state or the credential.
      saveCallLog({
        method: "POST",
        path: LOG_PATH,
        status: res.status,
        model,
        provider,
        connectionId: connectionId || undefined,
        duration: Date.now() - startTime,
        requestBody: loggedRequest,
        error: `Provider returned HTTP ${res.status}`,
        apiKeyId,
        apiKeyName,
      }).catch(() => {});
      return errorResponse(res.status, errorMessage);
    }

    const data: unknown = await res.json();
    const latencyMs = Date.now() - startTime;
    const tokens = usageTokens(data);
    let costUsd = 0;
    try {
      costUsd = await calculateCost(provider, upstreamModel, tokens);
    } catch {
      costUsd = 0;
    }
    await clearRecoveredProviderState(credentials);
    // Metadata-only log: token usage and status are captured above; the answer
    // body (which can echo the evaluated state) is never persisted.
    saveCallLog({
      method: "POST",
      path: LOG_PATH,
      status: 200,
      model,
      provider,
      connectionId: connectionId || undefined,
      duration: latencyMs,
      tokens,
      requestBody: loggedRequest,
      apiKeyId,
      apiKeyName,
    }).catch(() => {});

    const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
    attachOmniRouteMetaHeaders(headers, {
      provider,
      model: upstreamModel,
      costUsd,
      latencyMs,
      requestId: generateRequestId(),
    });
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch {
    // Network or parse failure: the raw error can carry the request URL or the
    // credential, so it is neither returned to the client nor logged verbatim.
    saveCallLog({
      method: "POST",
      path: LOG_PATH,
      status: HTTP_STATUS.BAD_GATEWAY,
      model,
      provider,
      connectionId: connectionId || undefined,
      duration: Date.now() - startTime,
      requestBody: loggedRequest,
      error: "Upstream evaluation request failed",
      apiKeyId,
      apiKeyName,
    }).catch(() => {});
    return errorResponse(HTTP_STATUS.BAD_GATEWAY, "Evaluation request failed");
  }
}

export const POST = withInjectionGuard(postHandler);
