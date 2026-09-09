/**
 * Live-catalog readiness (Care-Hero, 2026-09-09).
 *
 * `GET /api/health` answers 200 the instant Next.js listens, but a provider's
 * live model catalog is only populated by the model-sync cycle that starts 5 s
 * after boot — and an OAuth account that is mid-token-refresh at that moment is
 * skipped by that cycle (exclusive lease). On Railway the healthcheck IS the
 * cutover gate, so on 2026-09-08 the new container took traffic ~3.5 min before
 * the claude catalog existed and every claude request answered
 * `400 Model '…' is not available in the active live catalog`.
 *
 * `checkCatalogReadiness` reports ready only when every provider that has at
 * least one ACTIVE connection and uses an authoritative live catalog has a
 * non-empty catalog. The verdict latches true for the life of the process: a
 * catalog that later empties (token rotation, a manual disconnect) must not
 * flip a serving container back to "starting". Providers with no active
 * connection contribute nothing; non-authoritative providers are skipped.
 *
 * Wired into `/api/health` behind `HEALTH_REQUIRE_CATALOG=1` so upstream's
 * liveness semantics are unchanged unless an operator opts in.
 */

export type ReadinessDeps = {
  activeProviders: () => Promise<string[]>;
  catalogSize: (providerId: string) => Promise<number>;
  isAuthoritative: (providerId: string) => boolean;
};

export type ReadinessResult = { ready: boolean; waiting: string[] };

let latched = false;

async function defaultDeps(): Promise<ReadinessDeps> {
  const [{ getRawProviderConnections }, { getActiveSyncedCatalog }, registry] =
    await Promise.all([
      import("@/lib/db/providers"),
      import("@/lib/db/models/activeSyncedCatalog"),
      import("@omniroute/open-sse/config/providerRegistry"),
    ]);
  return {
    activeProviders: async () => {
      const rows = (await getRawProviderConnections({ isActive: true }, undefined, undefined, [
        "id",
        "provider",
      ])) as Array<{ provider?: unknown }>;
      return Array.from(
        new Set(
          rows
            .map((row) => row.provider)
            .filter((p): p is string => typeof p === "string" && p.length > 0)
        )
      );
    },
    catalogSize: async (providerId) => (await getActiveSyncedCatalog(providerId)).models.length,
    isAuthoritative: (providerId) => registry.providerUsesAuthoritativeLiveCatalog(providerId),
  };
}

export async function checkCatalogReadiness(deps?: ReadinessDeps): Promise<ReadinessResult> {
  if (latched) return { ready: true, waiting: [] };
  try {
    const d = deps ?? (await defaultDeps());
    const providers = (await d.activeProviders()).filter((p) => d.isAuthoritative(p));
    const sizes = await Promise.all(providers.map((p) => d.catalogSize(p)));
    const waiting = providers.filter((_, i) => sizes[i] === 0).sort();
    if (waiting.length === 0) latched = true;
    return { ready: waiting.length === 0, waiting };
  } catch (err) {
    // Fail closed while the gate is on: a DB that cannot answer is not ready.
    return { ready: false, waiting: [`error:${(err as Error).message}`] };
  }
}

export function catalogReadinessRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEALTH_REQUIRE_CATALOG === "1";
}

export function resetCatalogReadinessForTests(): void {
  latched = false;
}
