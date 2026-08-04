import { demesneLevyEfficiency, treasuryLevyFactor } from "./demesne";
import { getGold } from "./economy";
import { getPossessionDemesneManpower } from "../lib/population";
import type { Possession, WorldData } from "../types/world";

/**
 * Part des levées vassales que le suzerain peut lever selon l’opinion du vassal
 * envers lui (−100…100). Obligation minimale même en cas de haine ; jamais le
 * plein contingent (le reste reste chez le vassal).
 */
export const VASSAL_LEVY_FRACTION_MIN = 0.1;
export const VASSAL_LEVY_FRACTION_MAX = 0.5;

export function vassalLevyFraction(opinion: number): number {
  const t = (Math.max(-100, Math.min(100, opinion)) + 100) / 200;
  return (
    VASSAL_LEVY_FRACTION_MIN +
    t * (VASSAL_LEVY_FRACTION_MAX - VASSAL_LEVY_FRACTION_MIN)
  );
}

export interface VassalLevyShare {
  id: number;
  holderName: string;
  demesneLevies: number;
  opinion: number;
  fraction: number;
  contributed: number;
}

export interface PowerBreakdown {
  demesne: number;
  fromVassals: number;
  /** Levées disponibles (après pertes de guerre). */
  total: number;
  /** Capacité théorique à plein. */
  capacity: number;
  vassals: VassalLevyShare[];
  /** Levées demesne brutes avant malus. */
  demesneGross: number;
  efficiency: number;
  /** Facteur trésorerie (1 si solvable, ↓ si dette). */
  treasuryFactor: number;
}

/**
 * Force levable : demesne (après malus de limite) + part des demesnes vassaux
 * selon leur opinion, le tout écrasé par l’endettement.
 */
export function possessionPowerBreakdown(
  world: WorldData,
  p: Possession,
  opinions?: Record<string, number>,
): PowerBreakdown {
  const demesneGross = getPossessionDemesneManpower(world, p).levies;
  const efficiency = demesneLevyEfficiency(p);
  const treasuryFactor = treasuryLevyFactor(getGold(p));
  const demesne = Math.round(demesneGross * efficiency);
  const vassals: VassalLevyShare[] = [];
  let fromVassals = 0;

  for (const vid of p.vassalIds || []) {
    const v = (world.possessions || []).find((x) => x.id === vid);
    if (!v) continue;
    const demesneLevies = getPossessionDemesneManpower(world, v).levies;
    const opinion = opinions?.[`${v.id}>${p.id}`] ?? 0;
    const fraction = vassalLevyFraction(opinion);
    const contributed = Math.round(demesneLevies * fraction);
    fromVassals += contributed;
    vassals.push({
      id: v.id,
      holderName: v.holderName,
      demesneLevies,
      opinion,
      fraction,
      contributed,
    });
  }

  const rawTotal = demesne + fromVassals;
  const capacity = Math.max(0, Math.round(rawTotal * treasuryFactor));
  if (p.manpower == null) p.manpower = capacity;
  else if (p.manpower > capacity) p.manpower = capacity;
  const total = Math.max(0, Math.round(Math.min(p.manpower, capacity)));

  return {
    demesne: Math.round(demesne * treasuryFactor),
    demesneGross,
    efficiency,
    treasuryFactor,
    fromVassals: Math.round(fromVassals * treasuryFactor),
    total,
    capacity,
    vassals,
  };
}

/** Capacité théorique (plein potentiel). */
export function levyCapacity(
  world: WorldData,
  p: Possession,
  opinions?: Record<string, number>,
): number {
  return possessionPowerBreakdown(world, p, opinions).capacity;
}

/** Force de campagne disponible (demesne + vassaux, après attrition). */
export function possessionPower(
  world: WorldData,
  p: Possession,
  opinions?: Record<string, number>,
): number {
  return possessionPowerBreakdown(world, p, opinions).total;
}

export function powerRatio(attacker: number, defender: number): number {
  if (defender <= 0) return attacker > 0 ? 99 : 1;
  return attacker / defender;
}

/** Voisinage de facto (demesne + vassaux qui se touchent). */
export function areNeighbors(
  world: WorldData,
  aId: number,
  bId: number,
): boolean {
  if (aId === bId) return false;
  const a = (world.possessions || []).find((p) => p.id === aId);
  const b = (world.possessions || []).find((p) => p.id === bId);
  if (!a || !b) return false;
  if ((a.neighbors || []).includes(bId)) return true;
  if ((b.neighbors || []).includes(aId)) return true;
  return false;
}

/**
 * Puissance « beaucoup plus forte » exigée pour une allégeance volontaire.
 * En dessous → refus systématique.
 */
export const ALLEGIANCE_POWER_RATIO = 2.0;
