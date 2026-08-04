import type { Domaine, Possession, WorldData } from "../types/world";

/**
 * Share of population raisable as a short campaign levy (~486).
 * Populations are late-antique hinterland estimates (low thousands per domain),
 * not modern city sizes; ~2% yields field hosts in the hundreds–low thousands.
 */
export const LEVY_RATE = 0.02;

export interface Manpower {
  population: number;
  levies: number;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return Math.round(n).toLocaleString("en-US");
}

export function sumManpower(domaines: (Domaine | undefined | null)[]): Manpower {
  let population = 0;
  let levies = 0;
  for (const d of domaines) {
    if (!d) continue;
    const pop = d.population ?? 0;
    population += pop;
    levies += d.levies ?? Math.round(pop * LEVY_RATE);
  }
  return { population, levies };
}

function domainsOf(world: WorldData, ids: number[]): Domaine[] {
  return ids
    .map((id) => world.domaines.find((d) => d.id === id))
    .filter((d): d is Domaine => !!d);
}

/** Demesne only (lands held directly by this holder). */
export function getPossessionDemesneManpower(
  world: WorldData,
  possession: Possession,
): Manpower {
  return sumManpower(domainsOf(world, possession.domaines || []));
}

/**
 * Population du royaume de facto (demesne + vassaux récursifs) — recensement, pas la force
 * levable. Les levées de campagne utilisent `possessionPower` (part vassale selon opinion).
 */
export function getPossessionRealmManpower(
  world: WorldData,
  possession: Possession,
): Manpower {
  const byId = new Map((world.possessions || []).map((p) => [p.id, p]));
  const ids = new Set<number>();
  const seen = new Set<number>();

  function walk(pid: number) {
    if (seen.has(pid)) return;
    seen.add(pid);
    const p = byId.get(pid);
    if (!p) return;
    for (const did of p.domaines || []) ids.add(did);
    for (const vid of p.vassalIds || []) walk(vid);
  }

  walk(possession.id);
  return sumManpower(domainsOf(world, [...ids]));
}
