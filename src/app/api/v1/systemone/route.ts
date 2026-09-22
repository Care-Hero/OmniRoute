import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
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
  buildUpstreamHeaders,
  upstreamErrorMessage,
  usageTokens,
  EVALUATION_PROVIDER_ID,
  VERCEL_AI_GATEWAY_EVALUATION_URL,
} from "../evaluation-model/evaluationModel";
import {
  nativeQuestionsToVercel,
  nativeStateToString,
  parseNativeModel,
  vercelResultToNative,
} from "./systemOne";

const LOG_PATH = "/v1/systemone";
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
 * POST /v1/systemone — TypeSafe System One native contract, served through the Vercel AI
 * Gateway evaluation route. Point `TYPESAFE_BASE_URL` at OmniRoute; any OmniRoute API key
 * works as `TYPESAFE_API_KEY`. See ./systemOne.ts for the translation rules.
 */
async function postHandler(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Body must be an object with state and questions"
    );
  }
  const native = body as { model?: unknown; state?: unknown; questions?: unknown };
  const parsedModel = parseNativeModel(native.model);
  if (!parsedModel) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unsupported model: ${String(native.model)}. Use jev-latest (served as ${EVALUATION_PROVIDER_ID}/typesafe-ai/jev)`
    );
  }
  const state = nativeStateToString(native.state);
  if (state === null || !state.length) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "state is required (text or JSON)");
  }
  const questions = nativeQuestionsToVercel(native.questions);
  if (!questions) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "questions must be a non-empty object of noul / choice / score questions"
    );
  }
  const { upstreamModel, echo } = parsedModel;
  const model = `vag/${upstreamModel}`;

  const policy = await enforceApiKeyPolicy(request, model);
  if (policy.rejection) return policy.rejection;
  const apiKeyId = policy.apiKeyInfo?.id || undefined;
  const apiKeyName = policy.apiKeyInfo?.name || undefined;

  const provider = EVALUATION_PROVIDER_ID;
  const credentials = await getProviderCredentialsWithQuotaPreflight(provider);
  if (!credentials) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse(provider, credentials);
  }
  const token =
    (credentials as { apiKey?: string }).apiKey ||
    (credentials as { accessToken?: string }).accessToken;
  const connectionId = (credentials as { connectionId?: string }).connectionId || null;
  if (!token) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No API key on the ${provider} connection`);
  }

  let proxyInfo: Awaited<ReturnType<typeof resolveProxyForConnection>> | null = null;
  if (connectionId) {
    try {
      proxyInfo = await resolveProxyForConnection(connectionId, apiKeyId, provider);
    } catch (err) {
      log.error("SYSTEMONE", `Proxy resolution failed for connection ${connectionId}: ${err}`);
    }
  }

  // Confidence is a native field; ask the gateway to report it so it can be restored.
  const upstreamBody = { state, questions, providerOptions: { typesafe: { confidence: true } } };
  const loggedRequest = {
    model,
    questions: Object.keys(questions),
    stateChars: state.length,
    nativeModel: echo,
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
      const errorMessage = upstreamErrorMessage(errData, res.status);
      saveCallLog({
        method: "POST",
        path: LOG_PATH,
        status: res.status,
        model,
        provider,
        connectionId: connectionId || undefined,
        duration: Date.now() - startTime,
        requestBody: loggedRequest,
        responseBody: errData,
        error: errorMessage,
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
    const result = vercelResultToNative(data, native.questions as Record<string, unknown>, echo);
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
      responseBody: result,
      apiKeyId,
      apiKeyName,
    }).catch(() => {});

    const requestId = generateRequestId();
    const headers = new Headers({
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "x-typesafe-request-id": requestId,
    });
    attachOmniRouteMetaHeaders(headers, {
      provider,
      model: upstreamModel,
      costUsd,
      latencyMs,
      requestId,
    });
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveCallLog({
      method: "POST",
      path: LOG_PATH,
      status: HTTP_STATUS.BAD_GATEWAY,
      model,
      provider,
      connectionId: connectionId || undefined,
      duration: Date.now() - startTime,
      requestBody: loggedRequest,
      error: message,
      apiKeyId,
      apiKeyName,
    }).catch(() => {});
    return errorResponse(HTTP_STATUS.BAD_GATEWAY, `System One request failed: ${message}`);
  }
}

export const POST = withInjectionGuard(postHandler);
