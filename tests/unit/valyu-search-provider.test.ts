import test from "node:test";
import assert from "node:assert/strict";

const { SEARCH_PROVIDERS, getSearchProvider, resolveSearchProvider, supportsSearchType } =
  await import("../../open-sse/config/searchRegistry.ts");
const { SEARCH_VALIDATOR_CONFIGS } =
  await import("../../src/lib/providers/validation/searchProviders.ts");
const {
  VALYU_SEARCH_PROVIDER_ID,
  ValyuSearchEnvelopeError,
  buildValyuSearchRequest,
  normalizeValyuSearchResponse,
} = await import("../../open-sse/handlers/search/valyuSearch.ts");
const { handleSearch } = await import("../../open-sse/handlers/search.ts");
const { SEARCH_PROVIDERS: SEARCH_PROVIDER_CATALOG } =
  await import("../../src/shared/constants/providers/search.ts");

// Mirrors the documented POST /v1/search response (https://docs.valyu.ai).
const VALYU_RESPONSE = {
  success: true,
  error: null,
  tx_id: "tx_0123456789",
  query: "transformer attention",
  results: [
    {
      id: "https://arxiv.org/abs/1706.03762",
      title: "Attention Is All You Need",
      url: "https://arxiv.org/abs/1706.03762",
      content: "The dominant sequence transduction models are based on complex recurrent...",
      description: "Introduces the Transformer architecture.",
      source: "valyu/valyu-arxiv",
      price: 0.0015,
      length: 74,
      image_url: { "0": "https://arxiv.org/figure1.png" },
      relevance_score: 0.93,
      data_type: "unstructured",
      source_type: "paper",
      publication_date: "2017-06-12",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
    },
    {
      id: "https://example.com/stock",
      title: "AAPL daily prices",
      url: "https://example.com/stock",
      content: [{ date: "2026-09-22", close: 250.1 }],
      source: "valyu/valyu-stocks",
      relevance_score: 1.4,
      data_type: "structured",
      source_type: "data",
      image_url: "https://example.com/chart.png",
    },
    { title: "row without a url", content: "skipped" },
  ],
  results_by_source: { web: 0, proprietary: 2 },
  total_deduction_dollars: 0.003,
  total_characters: 120,
};

function makeTestResult(
  providerId: string,
  item: Record<string, unknown>,
  index: number,
  now: string
) {
  return { providerId, index, now, ...item } as never;
}

test("valyu-search is a keyed web+news provider with Valyu's x-api-key auth", () => {
  const config = getSearchProvider(VALYU_SEARCH_PROVIDER_ID);
  assert.ok(config);
  assert.equal(config.id, "valyu-search");
  assert.equal(config.baseUrl, "https://api.valyu.ai/v1/search");
  assert.equal(config.method, "POST");
  assert.equal(config.authType, "apikey");
  assert.equal(config.authHeader, "x-api-key");
  assert.deepEqual(config.searchTypes, ["web", "news"]);
  assert.equal(config.maxMaxResults, 20);
  assert.equal(config.fallbackOnly, undefined);
  assert.equal(supportsSearchType(config, "web"), true);
  assert.equal(supportsSearchType(config, "news"), true);
  assert.equal(supportsSearchType(config, "x"), false);
});

test("valyu alias resolves to the canonical id", () => {
  assert.equal(resolveSearchProvider("valyu")?.id, "valyu-search");
  assert.equal(resolveSearchProvider("valyu-search")?.id, "valyu-search");
});

test("valyu-search has a dashboard catalog entry for API-key setup", () => {
  const entry = SEARCH_PROVIDER_CATALOG["valyu-search"];
  assert.ok(entry);
  assert.equal(entry.id, "valyu-search");
  assert.equal(entry.alias, "valyu");
  assert.deepEqual(entry.serviceKinds, ["webSearch"]);
});

test("buildValyuSearchRequest maps the gateway request onto Valyu's body", () => {
  const config = SEARCH_PROVIDERS["valyu-search"];
  const { url, init } = buildValyuSearchRequest(config, {
    query: "omniroute gateway",
    searchType: "web",
    maxResults: 3,
    token: "valyu_test",
    country: "gb",
    domainFilter: ["arxiv.org", "-reddit.com"],
    contentOptions: { max_characters: 2000 },
  });
  assert.equal(url, "https://api.valyu.ai/v1/search");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "valyu_test");
  assert.equal("Authorization" in headers, false);
  assert.deepEqual(JSON.parse(String(init.body)), {
    query: "omniroute gateway",
    search_type: "web",
    max_num_results: 3,
    is_tool_call: true,
    included_sources: ["arxiv.org"],
    excluded_sources: ["reddit.com"],
    country_code: "GB",
    response_length: 2000,
  });
});

test("buildValyuSearchRequest maps news, time_range and clamps max_num_results to 20", () => {
  const config = SEARCH_PROVIDERS["valyu-search"];
  const { init } = buildValyuSearchRequest(config, {
    query: "q",
    searchType: "news",
    maxResults: 99,
    token: "valyu_test",
    timeRange: "week",
  });
  const body = JSON.parse(String(init.body));
  assert.equal(body.search_type, "news");
  assert.equal(body.max_num_results, 20);
  assert.match(body.start_date, /^\d{4}-\d{2}-\d{2}$/);
  const expected = new Date();
  expected.setUTCDate(expected.getUTCDate() - 7);
  assert.equal(body.start_date, expected.toISOString().slice(0, 10));
  assert.equal("end_date" in body, false);
});

test("buildValyuSearchRequest reaches academic/finance datasets via provider_options", () => {
  const config = SEARCH_PROVIDERS["valyu-search"];
  const presets = buildValyuSearchRequest(config, {
    query: "q",
    searchType: "web",
    maxResults: 5,
    token: "valyu_test",
    providerOptions: { included_sources: ["academic", "finance"], response_length: "medium" },
  });
  const presetBody = JSON.parse(String(presets.init.body));
  assert.equal(presetBody.search_type, "all");
  assert.deepEqual(presetBody.included_sources, ["academic", "finance"]);
  assert.equal(presetBody.response_length, "medium");

  const explicit = buildValyuSearchRequest(config, {
    query: "q",
    searchType: "web",
    maxResults: 5,
    token: "valyu_test",
    providerOptions: {
      search_type: "proprietary",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      relevance_threshold: 0.7,
    },
  });
  const explicitBody = JSON.parse(String(explicit.init.body));
  assert.equal(explicitBody.search_type, "proprietary");
  assert.equal(explicitBody.start_date, "2024-01-01");
  assert.equal(explicitBody.end_date, "2024-12-31");
  assert.equal(explicitBody.relevance_threshold, 0.7);

  const invalid = buildValyuSearchRequest(config, {
    query: "q",
    searchType: "web",
    maxResults: 5,
    token: "valyu_test",
    providerOptions: { search_type: "images" },
  });
  assert.equal(JSON.parse(String(invalid.init.body)).search_type, "web");
});

test("buildValyuSearchRequest requires an API key", () => {
  const config = SEARCH_PROVIDERS["valyu-search"];
  assert.throws(
    () => buildValyuSearchRequest(config, { query: "q", searchType: "web", maxResults: 5 }),
    /requires an API key/
  );
});

test("normalizeValyuSearchResponse maps Valyu fields and skips url-less rows", () => {
  const { results, totalResults } = normalizeValyuSearchResponse(VALYU_RESPONSE, makeTestResult);
  assert.equal(totalResults, 2);
  const [paper, data] = results as unknown as Array<Record<string, unknown>>;
  assert.equal(paper.providerId, "valyu-search");
  assert.equal(paper.index, 0);
  assert.equal(paper.title, "Attention Is All You Need");
  assert.equal(paper.url, "https://arxiv.org/abs/1706.03762");
  assert.equal(paper.snippet, "Introduces the Transformer architecture.");
  assert.equal(paper.score, 0.93);
  assert.equal(paper.published_at, "2017-06-12");
  assert.equal(paper.author, "Ashish Vaswani, Noam Shazeer");
  assert.equal(paper.source_type, "paper");
  assert.equal(paper.image_url, undefined, "non-string image_url is dropped");
  assert.equal(paper.full_text, VALYU_RESPONSE.results[0].content);

  assert.equal(data.index, 1);
  assert.equal(data.full_text, JSON.stringify([{ date: "2026-09-22", close: 250.1 }]));
  assert.equal(data.snippet, JSON.stringify([{ date: "2026-09-22", close: 250.1 }]));
  assert.equal(data.image_url, "https://example.com/chart.png");
});

test("normalizeValyuSearchResponse throws on a 2xx success:false body, flagging credit errors", () => {
  assert.throws(
    () =>
      normalizeValyuSearchResponse(
        { success: false, error: "Insufficient credits" },
        makeTestResult
      ),
    (err: unknown) => err instanceof ValyuSearchEnvelopeError && err.quota === true
  );
  assert.throws(
    () => normalizeValyuSearchResponse({ success: false, error: "boom" }, makeTestResult),
    (err: unknown) => err instanceof ValyuSearchEnvelopeError && err.quota === false
  );
  // Partial success (HTTP 206) keeps its results.
  const partial = normalizeValyuSearchResponse(
    { ...VALYU_RESPONSE, success: false, warnings: ["one source timed out"] },
    makeTestResult
  );
  assert.equal(partial.totalResults, 2);
});

test("valyu provider validation posts an x-api-key probe with max_num_results 1", () => {
  const { url, init } = SEARCH_VALIDATOR_CONFIGS["valyu-search"]("valyu_test");
  assert.equal(url, "https://api.valyu.ai/v1/search");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "valyu_test");
  assert.deepEqual(JSON.parse(String(init.body)), {
    query: "test",
    search_type: "web",
    max_num_results: 1,
  });
});

test("handleSearch maps a mocked Valyu response into the unified search response", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify(VALYU_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await handleSearch({
      query: "transformer attention",
      provider: "valyu-search",
      maxResults: 5,
      searchType: "web",
      credentials: { apiKey: "valyu_test" },
      log: null,
    });

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(capturedUrl, "https://api.valyu.ai/v1/search");
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["x-api-key"], "valyu_test");
    assert.equal(JSON.parse(String(capturedInit?.body)).max_num_results, 5);
    assert.equal(result.data?.provider, "valyu-search");
    assert.equal(result.data?.results.length, 2);
    const first = result.data!.results[0];
    assert.equal(first.title, "Attention Is All You Need");
    assert.equal(first.url, "https://arxiv.org/abs/1706.03762");
    assert.equal(first.snippet, "Introduces the Transformer architecture.");
    assert.equal(first.score, 0.93);
    assert.equal(first.published_at, "2017-06-12");
    assert.equal(first.metadata?.author, "Ashish Vaswani, Noam Shazeer");
    assert.equal(first.metadata?.source_type, "paper");
    assert.equal(first.content?.text, VALYU_RESPONSE.results[0].content);
    assert.equal(first.citation.provider, "valyu-search");
    // relevance_score above 1 is clamped by the shared result builder.
    assert.equal(result.data!.results[1].score, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleSearch maps Valyu success:false bodies to 402 (credits) and 502 (other)", async () => {
  const originalFetch = globalThis.fetch;
  const run = async (payload: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    return handleSearch({
      query: "q",
      provider: "valyu-search",
      maxResults: 5,
      searchType: "web",
      credentials: { apiKey: "valyu_test" },
      log: null,
    });
  };
  try {
    const credits = await run({ success: false, error: "Insufficient credits" });
    assert.equal(credits.success, false);
    assert.equal(credits.status, 402, JSON.stringify(credits));
    const generic = await run({ success: false, error: "internal error" });
    assert.equal(generic.success, false);
    assert.equal(generic.status, 502, JSON.stringify(generic));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleSearch surfaces Valyu HTTP 401 without results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: false, error: "Invalid API key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await handleSearch({
      query: "q",
      provider: "valyu-search",
      maxResults: 5,
      searchType: "web",
      credentials: { apiKey: "bad" },
      log: null,
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
