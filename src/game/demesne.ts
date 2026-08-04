import type { Possession, WorldData } from "../types/world";
import { PROVINCE_CLAIM_THRESHOLD } from "./titles";

/** Domaines tenus en demesne direct sans malus. */
export const DEMESNE_LIMIT = 5;

/**
 * Provinces tenues en direct (demesne) sans malus d'opinion. Au-delà,
 * chaque vassal direct perd de l'opinion envers son suzerain — signe qu'il
 * devrait déléguer les provinces excédentaires plutôt que tout garder en
 * main propre.
 */
export const PROVINCE_DEMESNE_LIMIT = 2;

/** Malus d'opinion (vassal → suzerain) par province excédentaire, par mois. */
export const PROVINCE_OVERAGE_VASSAL_OPINION_MALUS = -5;

/**
 * Pénalité par domaine au-delà de la limite.
 * À 8 domaines en trop (13 total) le revenu devient négatif (~−12 %).
 */
export const DEMESNE_OVERAGE_PENALTY = 0.14;

/** Plancher des levées demesne (quasi zéro si demesne monstrueux). */
export const DEMESNE_LEVY_FLOOR = 0.02;

/**
 * Plancher du multiplicateur de revenu : peut être négatif
 * (entretien / désordre → on paie pour tenir trop de terres).
 */
export const DEMESNE_INCOME_FLOOR = -1;

/**
 * Or négatif : à −DEBT_LEVY_SCALE la force de campagne tombe au plancher.
 * (ex. −80 or → ~2 % de troupes).
 */
export const DEBT_LEVY_SCALE = 80;

/** Plancher de force sous endettement extrême. */
export const DEBT_LEVY_FLOOR = 0.02;

/** Intérêt mensuel sur la dette (fraction de |or| si or < 0). */
export const DEBT_INTEREST_RATE = 0.04;

export function demesneCount(p: Possession): number {
  return p.domaines?.length ?? 0;
}

export function demesneOverage(p: Possession): number {
  return Math.max(0, demesneCount(p) - DEMESNE_LIMIT);
}

/** Multiplicateur brut : 1 sous la limite, puis −14 % / domaine excessif. */
export function demesneRawMultiplier(p: Possession): number {
  const over = demesneOverage(p);
  if (over <= 0) return 1;
  return 1 - over * DEMESNE_OVERAGE_PENALTY;
}

/**
 * Efficacité revenu : peut descendre sous 0 → déficit mensuel
 * (endettement si on ne délègue pas).
 */
export function demesneEfficiency(p: Possession): number {
  return Math.max(DEMESNE_INCOME_FLOOR, demesneRawMultiplier(p));
}

/**
 * Efficacité levées demesne : suit le même malus, plancher ~2 %.
 */
export function demesneLevyEfficiency(p: Possession): number {
  return Math.max(DEMESNE_LEVY_FLOOR, demesneRawMultiplier(p));
}

/** Perte d’efficacité en % (peut dépasser 100 % si déficit). */
export function demesnePenaltyPercent(p: Possession): number {
  return Math.round((1 - demesneEfficiency(p)) * 100);
}

/**
 * Provinces substantiellement tenues en demesne direct par `p` (> 2/3 des
 * domaines de la province détenus en propre). Un simple domaine isolé dans
 * une province qu'on ne contrôle pas vraiment ne compte pas comme
 * « une province de plus » — même seuil que pour revendiquer un titre de
 * province (`PROVINCE_CLAIM_THRESHOLD`).
 */
export function demesneProvinceIds(world: WorldData, p: Possession): Set<number> {
  const heldSet = new Set(p.domaines || []);
  const touchedProvinceIds = new Set<number>();
  for (const did of heldSet) {
    const d = world.domaines.find((x) => x.id === did) ?? world.domaines[did];
    if (d?.provinceId != null) touchedProvinceIds.add(d.provinceId);
  }
  const ids = new Set<number>();
  for (const provinceId of touchedProvinceIds) {
    const province = (world.provinces || []).find((pr) => pr.id === provinceId);
    const domainIds = province?.domaines?.length
      ? province.domaines
      : world.domaines.filter((d) => d.provinceId === provinceId).map((d) => d.id);
    if (!domainIds.length) continue;
    const directCount = domainIds.filter((id) => heldSet.has(id)).length;
    if (directCount / domainIds.length > PROVINCE_CLAIM_THRESHOLD) ids.add(provinceId);
  }
  return ids;
}

export function demesneProvinceCount(world: WorldData, p: Possession): number {
  return demesneProvinceIds(world, p).size;
}

/** Provinces en trop au-delà de `PROVINCE_DEMESNE_LIMIT`. */
export function provinceOverage(world: WorldData, p: Possession): number {
  return Math.max(0, demesneProvinceCount(world, p) - PROVINCE_DEMESNE_LIMIT);
}

/**
 * Facteur de levées selon la trésorerie.
 * Solvable → 1 ; endetté → baisse jusqu’au plancher.
 */
export function treasuryLevyFactor(gold: number): number {
  if (gold >= 0) return 1;
  return Math.max(DEBT_LEVY_FLOOR, 1 + gold / DEBT_LEVY_SCALE);
}

/** Intérêt du mois si en dette (montant positif à retrancher). */
export function debtInterest(gold: number): number {
  if (gold >= 0) return 0;
  return Math.round(-gold * DEBT_INTEREST_RATE * 10) / 10;
}
