/**
 * Valyu-backed search for the unified search gateway (https://docs.valyu.ai).
 *
 * Upstream contract (POST https://api.valyu.ai/v1/search, `x-api-key` auth):
 * - body: `query`, `search_type` ("all" | "web" | "proprietary" | "news"),
 *   `max_num_results` (1-20 on standard keys), `included_sources` /
 *   `excluded_sources` (dataset ids, domains or presets such as "academic",
 *   "finance"), `start_date` / `end_date` (YYYY-MM-DD), `country_code`,
 *   `response_length` ("short" | "medium" | "large" | "max" | integer chars),
 *   `relevance_threshold`, `max_price`, `fast_mode`, `is_tool_call`.
 * - success: HTTP 200 (206 = partial, with `warnings`) and
 *   `{ success, error, tx_id, query, results: [...], total_deduction_dollars }`.
 * - failure: HTTP 4xx/5xx with `{ success: false, error }` — handled by the
 *   shared non-2xx path; a 2xx body with `success: false` and no results is
 *   surfaced as ValyuSearchEnvelopeError instead of an empty result set.
 */

import { z } from "zod";
import type { SearchProviderConfig } from "../../config/searchRegistry.ts";
import type { SearchResult } from "../search.ts";

export const VALYU_SEARCH_PROVIDER_ID = "valyu-search";

/** Standard-key upstream cap; higher limits need Valyu-side permission. */
const VALYU_MAX_NUM_RESULTS = 20;

const VALYU_SEARCH_TYPES = new Set(["all", "web", "proprietary", "news"]);
const VALYU_RESPONSE_LENGTHS = new Set(["short", "medium", "large", "max"]);

/**
 * Thrown by normalizeValyuSearchResponse when a 2xx body reports
 * `success: false` without results. A credit/quota-shaped message maps to 402
 * (quota-aware failover); anything else maps to 502 (see searchProxy.ts).
 */
export class ValyuSearchEnvelopeError extends Error {
  constructor(
    public readonly quota: boolean,
    message: string
  ) {
    super(message);
    this.name = "ValyuSearchEnvelopeError";
  }
}

const QUOTA_SIGNAL = /quota|credit|balance|insufficient|exceed|limit/i;

export interface ValyuSearchParams {
  query: string;
  searchType: string;
  maxResults: number;
  token?: string;
  country?: string;
  timeRange?: string;
  domainFilter?: string[];
  contentOptions?: { max_characters?: number };
  providerOptions?: Record<string, unknown>;
}

type MakeResult = (
  providerId: string,
  item: {
    title?: string;
    url?: string;
    snippet?: string;
    score?: number;
    published_at?: string;
    author?: string;
    source_type?: string;
    image_url?: string;
    full_text?: string;
    text_format?: string;
  },
  index: number,
  now: string
) => SearchResult;

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function timeRangeStartDate(timeRange: string | undefined, now: Date): string | undefined {
  if (!timeRange || timeRange === "any") return undefined;
  const from = new Date(now);
  if (timeRange === "hour" || timeRange === "day") from.setUTCDate(from.getUTCDate() - 1);
  else if (timeRange === "week") from.setUTCDate(from.getUTCDate() - 7);
  else if (timeRange === "month") from.setUTCMonth(from.getUTCMonth() - 1);
  else if (timeRange === "year") from.setUTCFullYear(from.getUTCFullYear() - 1);
  else return undefined;
  return from.toISOString().slice(0, 10);
}

/**
 * Map the gateway request onto Valyu's body.
 *
 * `search_type` "web" / "news" pass through. Academic, finance and other
 * proprietary datasets are reachable via `provider_options`:
 * `{ included_sources: ["academic"] }` (switches the default search_type to
 * "all" so proprietary sources are eligible) or an explicit
 * `{ search_type: "all" | "proprietary" }`.
 */
export function buildValyuSearchRequest(
  config: SearchProviderConfig,
  params: ValyuSearchParams
): { url: string; init: RequestInit } {
  if (!params.token) {
    throw new Error("Valyu Search requires an API key");
  }
  const options = params.providerOptions ?? {};
  const maxNumResults = Math.min(
    Math.max(Math.trunc(params.maxResults) || 5, 1),
    VALYU_MAX_NUM_RESULTS
  );

  const includedSources = [
    ...readStringArray(options.included_sources),
    ...(params.domainFilter ?? []).filter((d) => !d.startsWith("-")),
  ];
  const excludedSources = [
    ...readStringArray(options.excluded_sources),
    ...(params.domainFilter ?? []).filter((d) => d.startsWith("-")).map((d) => d.slice(1)),
  ];

  const requestedType =
    typeof options.search_type === "string" && VALYU_SEARCH_TYPES.has(options.search_type)
      ? options.search_type
      : undefined;
  const searchType =
    requestedType ??
    (params.searchType === "news"
      ? "news"
      : readStringArray(options.included_sources).length > 0
        ? "all"
        : "web");

  const body: Record<string, unknown> = {
    query: params.query,
    search_type: searchType,
    max_num_results: maxNumResults,
    is_tool_call: true,
  };
  if (includedSources.length) body.included_sources = includedSources;
  if (excludedSources.length) body.excluded_sources = excludedSources;
  if (params.country) body.country_code = params.country.toUpperCase();

  const startDate =
    typeof options.start_date === "string"
      ? options.start_date
      : timeRangeStartDate(params.timeRange, new Date());
  if (startDate) body.start_date = startDate;
  if (typeof options.end_date === "string") body.end_date = options.end_date;

  const responseLength = options.response_length;
  if (typeof responseLength === "string" && VALYU_RESPONSE_LENGTHS.has(responseLength)) {
    body.response_length = responseLength;
  } else if (typeof responseLength === "number" && responseLength > 0) {
    body.response_length = Math.trunc(responseLength);
  } else if (params.contentOptions?.max_characters) {
    body.response_length = params.contentOptions.max_characters;
  }
  if (typeof options.relevance_threshold === "number") {
    body.relevance_threshold = options.relevance_threshold;
  }
  if (typeof options.max_price === "number") body.max_price = options.max_price;
  if (typeof options.fast_mode === "boolean") body.fast_mode = options.fast_mode;

  return {
    url: config.baseUrl.replace(/\/+$/, ""),
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": params.token,
      },
      body: JSON.stringify(body),
    },
  };
}

const ValyuItemSchema = z
  .object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    // Unstructured sources return text; structured (e.g. finance) sources can
    // return an object/array, which is serialized for the gateway content field.
    content: z.unknown().optional(),
    description: z.string().nullish(),
    source: z.string().nullish(),
    source_type: z.string().nullish(),
    relevance_score: z.number().nullish(),
    publication_date: z.string().nullish(),
    authors: z.array(z.string()).nullish(),
    image_url: z.unknown().optional(),
  })
  .passthrough();

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (content === null || content === undefined) return undefined;
  try {
    return JSON.stringify(content);
  } catch {
    return undefined;
  }
}

export function normalizeValyuSearchResponse(
  data: unknown,
  makeResult: MakeResult
): { results: SearchResult[]; totalResults: number } {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const rows = Array.isArray(record.results) ? record.results : [];

  if (record.success === false && rows.length === 0) {
    const message =
      (typeof record.error === "string" && record.error) || "Valyu search reported failure";
    throw new ValyuSearchEnvelopeError(QUOTA_SIGNAL.test(message), message);
  }

  const now = new Date().toISOString();
  const results: SearchResult[] = [];
  for (const row of rows) {
    const parsed = ValyuItemSchema.safeParse(row);
    if (!parsed.success || !parsed.data.url) continue;
    const item = parsed.data;
    const fullText = contentToText(item.content);
    const snippet = item.description || (fullText ? fullText.slice(0, 300) : "");
    results.push(
      makeResult(
        VALYU_SEARCH_PROVIDER_ID,
        {
          title: item.title || item.url || undefined,
          url: item.url || undefined,
          snippet,
          score: item.relevance_score ?? undefined,
          published_at: item.publication_date || undefined,
          author: item.authors?.length ? item.authors.join(", ") : undefined,
          source_type: item.source_type || item.source || undefined,
          image_url: typeof item.image_url === "string" ? item.image_url : undefined,
          full_text: fullText,
          text_format: "text",
        },
        results.length,
        now
      )
    );
  }
  return { results, totalResults: results.length };
}
