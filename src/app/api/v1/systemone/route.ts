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
  redactSelectedCredential,
  upstreamErrorMessage,
  usageTokens,
  EVALUATION_PROVIDER_ID,
  VERCEL_AI_GATEWAY_EVALUATION_URL,
} from "../evaluation-model/evaluationModel";
import {
  isValidEvaluationResult,
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
  // Honour the key's connection allowlist exactly as chat completions does, so a
  // restricted key can never draw another account's Vercel credential. An
  // empty/absent allowlist means unrestricted; a restricted key whose
  // connections don't match this provider selects nothing.
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
      // Strip the exact injected credential before the upstream free-text
      // reaches the client, then let errorResponse's shared sanitizer run.
      const errorMessage = redactSelectedCredential(
        upstreamErrorMessage(errData, res.status),
        token
      );
      // Metadata-only log: the upstream body and its free-text error can echo
      // the caller's evaluated state or the credential, so neither is persisted.
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
    // A malformed or incomplete success body must not translate into a
    // silently-successful native response — return a sanitized 502 instead.
    if (!isValidEvaluationResult(data, native.questions)) {
      saveCallLog({
        method: "POST",
        path: LOG_PATH,
        status: HTTP_STATUS.BAD_GATEWAY,
        model,
        provider,
        connectionId: connectionId || undefined,
        duration: latencyMs,
        tokens,
        requestBody: loggedRequest,
        error: "Upstream returned a malformed evaluation result",
        apiKeyId,
        apiKeyName,
      }).catch(() => {});
      return errorResponse(
        HTTP_STATUS.BAD_GATEWAY,
        "Upstream returned a malformed evaluation result"
      );
    }
    let costUsd = 0;
    try {
      costUsd = await calculateCost(provider, upstreamModel, tokens);
    } catch {
      costUsd = 0;
    }
    await clearRecoveredProviderState(credentials);
    const result = vercelResultToNative(data, native.questions as Record<string, unknown>, echo);
    // Metadata-only log: token usage and status are captured above; the
    // translated answer body (which can echo the evaluated state) is not stored.
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
      error: "Upstream System One request failed",
      apiKeyId,
      apiKeyName,
    }).catch(() => {});
    return errorResponse(HTTP_STATUS.BAD_GATEWAY, "System One request failed");
  }
}

export const POST = withInjectionGuard(postHandler);
