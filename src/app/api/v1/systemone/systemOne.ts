/**
 * TypeSafe's native System One contract (`POST /v1/systemone`, api.typesafe.ai, SDK
 * `@typesafe-ai/sdk` 0.6) translated onto the Vercel AI Gateway v4 evaluation contract
 * that `/v1/evaluation-model` already forwards. Clients such as jev-axi and jevkit speak
 * the native shape and honour `TYPESAFE_BASE_URL`, so this route lets them run through
 * OmniRoute with the stored Vercel AI Gateway credential and no vendor key of their own.
 *
 * Native → Vercel:  question `noul` → `boolean` (criteria folded into instructions);
 *                   `state` may be any JSON → serialised to a string; `model` alias
 *                   (`jev-latest`, `jev-1.13.0`) → `typesafe-ai/jev`.
 * Vercel → native:  answer `boolean.probability` → `noul`; `confidence` restored from
 *                   `providerMetadata.typesafe.confidence` (fallback: top probability);
 *                   score answers regain a `legend`; `usage.inputTokens` → `input_tokens`.
 */

export const NATIVE_DEFAULT_MODEL = "jev-latest";
export const UPSTREAM_MODEL = "typesafe-ai/jev";

type Json = Record<string, unknown>;

export function parseNativeModel(model: unknown): { upstreamModel: string; echo: string } | null {
  if (model === undefined || model === null || model === "") {
    return { upstreamModel: UPSTREAM_MODEL, echo: NATIVE_DEFAULT_MODEL };
  }
  if (typeof model !== "string") return null;
  const slug = model.trim();
  // Accept TypeSafe aliases/versions and either OmniRoute spelling of the gateway model.
  if (/^jev(-[a-z0-9.]+)?$/i.test(slug)) return { upstreamModel: UPSTREAM_MODEL, echo: slug };
  const stripped = slug.replace(/^(vag|vercel-ai-gateway)\//, "");
  if (stripped === UPSTREAM_MODEL) return { upstreamModel: UPSTREAM_MODEL, echo: slug };
  return null;
}

/** Vercel's `state` is a string; TypeSafe accepts any JSON value. */
export function nativeStateToString(state: unknown): string | null {
  if (typeof state === "string") return state;
  if (state === undefined) return null;
  try {
    return JSON.stringify(state);
  } catch {
    return null;
  }
}

/** Translate native questions to the v4 evaluation shape. Returns null when a question is malformed. */
export function nativeQuestionsToVercel(questions: unknown): Record<string, Json> | null {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return null;
  // Null-prototype so a JSON-parsed question literally named `__proto__` becomes
  // an own key instead of mutating the prototype and vanishing from the map.
  const out: Record<string, Json> = Object.create(null);
  for (const [name, raw] of Object.entries(questions as Json)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const q = raw as Json;
    const type = q.type;
    if (type === "noul") {
      const { criteria, type: _t, ...rest } = q;
      const instructions =
        criteria && typeof criteria === "object"
          ? { question: q.instructions ?? null, criteria }
          : (q.instructions ?? null);
      out[name] = { ...rest, type: "boolean", instructions };
    } else if (type === "choice" || type === "score") {
      out[name] = { ...q };
    } else {
      return null;
    }
  }
  return Object.keys(out).length ? out : null;
}

function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function topProbability(probabilities: unknown): number | undefined {
  if (!isRecord(probabilities)) return undefined;
  const values = Object.values(probabilities).filter((v): v is number => typeof v === "number");
  return values.length ? Math.max(...values) : undefined;
}

/** The v4 answer type a given native question type must come back as. */
const NATIVE_TO_ANSWER_TYPE: Record<string, string> = {
  noul: "boolean",
  choice: "choice",
  score: "score",
};

function isProbability(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** A distribution: a record whose every value is a probability in [0,1]. */
function isProbabilityDistribution(v: unknown): v is Json {
  if (!isRecord(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every(isProbability);
}

/**
 * One upstream answer, validated in full against its native question:
 *  (a) type matches; (b) primary value present (choice ∈ option keys);
 *  (c) distribution present with numbers in [0,1] (choice keys == option set,
 *      boolean `probability` in [0,1], score within the criteria range);
 *  (d) `confidence` (from provider metadata) is a number in [0,1] for the
 *      answer types that carry it natively (choice, score).
 */
function isValidAnswer(question: Json, answer: unknown, confidence: unknown): boolean {
  const expected = NATIVE_TO_ANSWER_TYPE[String(question.type)];
  if (!expected) return false;
  if (!isRecord(answer) || answer.type !== expected) return false;

  if (expected === "boolean") {
    // A boolean's single `probability` IS its distribution; noul carries no confidence.
    return isProbability(answer.probability);
  }

  if (expected === "choice") {
    if (!isRecord(question.criteria)) return false;
    const optionKeys = Object.keys(question.criteria);
    if (optionKeys.length === 0) return false;
    if (typeof answer.choice !== "string" || !optionKeys.includes(answer.choice)) return false;
    if (!isProbabilityDistribution(answer.probabilities)) return false;
    const probKeys = Object.keys(answer.probabilities);
    if (probKeys.length !== optionKeys.length || !probKeys.every((k) => optionKeys.includes(k))) {
      return false;
    }
    return isProbability(confidence);
  }

  // score
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) return false;
  if (!Array.isArray(question.criteria) || question.criteria.length === 0) return false;
  if (answer.score < 0 || answer.score > question.criteria.length - 1) return false;
  if (!isProbabilityDistribution(answer.probabilities)) return false;
  return isProbability(confidence);
}

/**
 * A malformed or incomplete upstream success body must NOT translate into a
 * silently-successful native response. The invariant, written once: EVERY asked
 * question must have a well-formed answer (see isValidAnswer) AND the usage must
 * carry a non-negative integer `inputTokens` — nothing is ever fabricated on the
 * way out. The route returns a sanitized 502 when this is false.
 */
export function isValidEvaluationResult(data: unknown, nativeQuestions: unknown): boolean {
  if (!isRecord(data) || !isRecord(data.answers)) return false;
  if (!isRecord(nativeQuestions)) return false;
  const answers = data.answers;
  const names = Object.keys(nativeQuestions);
  if (names.length === 0) return false;

  const metadata = isRecord(data.providerMetadata) ? data.providerMetadata : {};
  const typesafe = isRecord(metadata.typesafe) ? metadata.typesafe : {};
  const confidences = isRecord(typesafe.confidence) ? typesafe.confidence : {};

  for (const name of names) {
    const question = nativeQuestions[name];
    if (!isRecord(question)) return false;
    if (!isValidAnswer(question, answers[name], confidences[name])) return false;
  }

  const usage = isRecord(data.usage) ? data.usage : undefined;
  if (!usage) return false;
  const inputTokens = usage.inputTokens;
  return typeof inputTokens === "number" && Number.isInteger(inputTokens) && inputTokens >= 0;
}

/** Translate the v4 evaluation response back to the native System One result. */
export function vercelResultToNative(
  data: unknown,
  nativeQuestions: Json,
  echoModel: string
): { model: string; answers: Json; usage: { input_tokens: number; output_tokens: number } } {
  const root = isRecord(data) ? data : {};
  const answers = isRecord(root.answers) ? root.answers : {};
  const metadata = isRecord(root.providerMetadata) ? root.providerMetadata : {};
  const typesafe = isRecord(metadata.typesafe) ? metadata.typesafe : {};
  const confidences = isRecord(typesafe.confidence) ? typesafe.confidence : {};
  // Null-prototype so an answer keyed `__proto__` survives the round trip.
  const out: Json = Object.create(null);
  for (const [name, raw] of Object.entries(answers)) {
    if (!isRecord(raw)) continue;
    const question = isRecord(nativeQuestions[name]) ? (nativeQuestions[name] as Json) : {};
    const confidence =
      typeof confidences[name] === "number"
        ? (confidences[name] as number)
        : topProbability(raw.probabilities);
    if (raw.type === "boolean") {
      out[name] = { type: "noul", noul: raw.probability };
    } else if (raw.type === "score") {
      const criteria = Array.isArray(question.criteria) ? question.criteria : [];
      const legend = Object.fromEntries(criteria.map((c, i) => [String(i), c ?? null]));
      out[name] = {
        type: "score",
        score: raw.score,
        confidence,
        legend,
        probabilities: raw.probabilities ?? {},
      };
    } else if (raw.type === "choice") {
      out[name] = {
        type: "choice",
        choice: raw.choice,
        confidence,
        probabilities: raw.probabilities ?? {},
      };
    }
  }
  const usage = isRecord(root.usage) ? root.usage : {};
  const count = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  const model = typeof typesafe.model === "string" && typesafe.model ? typesafe.model : echoModel;
  return {
    model,
    answers: out,
    usage: { input_tokens: count(usage.inputTokens), output_tokens: count(usage.outputTokens) },
  };
}
