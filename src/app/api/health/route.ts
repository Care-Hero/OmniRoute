import { NextResponse } from "next/server";

/**
 * GET /api/health — canonical liveness probe, no auth required.
 *
 * Without this route, `/api/health` fell through to the `/api/*` catch-all, and the
 * management-auth boundary answered before routing: an unauthenticated caller got a 401,
 * which is exactly what a wrong or missing key returns. An orchestrator (Docker HEALTHCHECK,
 * a Kubernetes probe, a monitoring curl) cannot tell "service down" from "bad credentials"
 * from "no such route" — the ambiguity the #6424 catch-all was written to remove for
 * authenticated callers, still intact for the one caller that never authenticates.
 *
 * Deliberately minimal: `{ status, timestamp }` and nothing else. Whatever this returns is
 * public on an exposed instance, so version, uptime and memory stay behind the authenticated
 * `/api/monitoring/health`. For a probe that also confirms the database answers, use
 * `/api/health/ping`.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/**
 * `HEALTH_REQUIRE_CATALOG=1` turns this liveness probe into a READINESS probe:
 * 503 `{ status: "starting", waiting: [providerIds] }` until every provider with
 * an active connection has a live model catalog (src/lib/health/readiness.ts).
 * Orchestrators that gate cutover on this route (Railway `healthcheckPath`)
 * then keep the previous container serving until the new one can actually
 * route. Off by default — upstream behaviour unchanged.
 */
export async function GET() {
  const { catalogReadinessRequired, checkCatalogReadiness } = await import(
    "@/lib/health/readiness"
  );
  if (catalogReadinessRequired()) {
    const { ready, waiting } = await checkCatalogReadiness();
    if (!ready) {
      return NextResponse.json(
        { status: "starting", waiting, timestamp: new Date().toISOString() },
        { status: 503, headers: NO_STORE }
      );
    }
  }
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { status: 200, headers: NO_STORE }
  );
}
