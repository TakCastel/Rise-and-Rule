import type { Domaine, Possession, PossessionRank, WorldData } from "../types/world";
import { debtInterest, demesneEfficiency } from "./demesne";
import { economyFocusMultiplier, prestigeFocusMultiplier } from "./focus";

/**
 * Revenu mensuel d’un domaine (or) — échelle basse (~486).
 * ~0.1× l’ancienne formule (un demesne royal ≈ quelques or / mois, pas 70+).
 */
export function computeDomainIncome(d: Domaine): number {
  const dev = Math.max(0, Math.min(100, d.development ?? 0));
  const pop = Math.max(0, d.population ?? 0);
  const raw = dev * 0.4 + (pop / 350) * (0.45 + dev / 200);
  return Math.max(0.1, Math.round(raw) / 10);
}

/** Revenu mensuel du domaine (champ `income` ou formule). */
export function domainMonthlyIncome(d: Domaine): number {
  if (typeof d.income === "number" && d.income >= 0) return d.income;
  return computeDomainIncome(d);
}

/** Recalcule `income` sur tous les domaines. */
export function ensureDomainIncomes(world: WorldData): void {
  for (const d of world.domaines) {
    d.income = computeDomainIncome(d);
  }
}

/**
 * Revenu mensuel net du demesne (après malus).
 * Peut être négatif si demesne trop vaste → depletion / dette.
 */
export function possessionMonthlyIncome(
  world: WorldData,
  p: Possession,
): number {
  let total = 0;
  for (const id of p.domaines || []) {
    const d = world.domaines.find((x) => x.id === id) ?? world.domaines[id];
    if (d) total += domainMonthlyIncome(d);
  }
  const eff = demesneEfficiency(p);
  return Math.round(total * eff * economyFocusMultiplier(p) * 10) / 10;
}

function realmDomainCount(world: WorldData, p: Possession): number {
  const ids = new Set(p.domaines || []);
  for (const vid of p.vassalIds || []) {
    const v = (world.possessions || []).find((x) => x.id === vid);
    if (!v) continue;
    for (const did of v.domaines || []) ids.add(did);
  }
  return ids.size;
}

/**
 * Prestige mensuel ≈ taille du territoire de facto
 * (demesne + vassaux pour un roi, demesne seul sinon).
 * Légère perte si demesne trop étendu (administration difficile).
 */
export function possessionMonthlyPrestige(
  world: WorldData,
  p: Possession,
): number {
  const domainCount =
    p.rank === "king" || (p.vassalIds && p.vassalIds.length > 0)
      ? realmDomainCount(world, p)
      : (p.domaines || []).length;
  const base = Math.max(0.5, Math.round(domainCount * 0.75 * 10) / 10);
  const soft = 0.5 + 0.5 * Math.max(0, demesneEfficiency(p));
  return Math.round(base * soft * prestigeFocusMultiplier(p) * 10) / 10;
}

export interface IncomeBreakdown {
  demesne: number;
  domains: { id: number; name: string; income: number; development: number }[];
  total: number;
  /** Revenu brut avant malus. */
  gross: number;
  efficiency: number;
  /** Intérêt mensuel si déjà endetté (positif = charge). */
  debtInterest: number;
  /** Flux net du mois (revenu ± intérêt). */
  net: number;
}

export function possessionIncomeBreakdown(
  world: WorldData,
  p: Possession,
): IncomeBreakdown {
  const domains: IncomeBreakdown["domains"] = [];
  let demesne = 0;
  for (const id of p.domaines || []) {
    const d = world.domaines.find((x) => x.id === id) ?? world.domaines[id];
    if (!d) continue;
    const income = domainMonthlyIncome(d);
    demesne += income;
    domains.push({
      id: d.id,
      name: d.name,
      income,
      development: d.development ?? 0,
    });
  }
  domains.sort((a, b) => b.income - a.income);
  const efficiency = demesneEfficiency(p);
  const gross = Math.round(demesne * 10) / 10;
  const total = Math.round(demesne * efficiency * economyFocusMultiplier(p) * 10) / 10;
  const interest = debtInterest(p.gold ?? 0);
  const net = Math.round((total - interest) * 10) / 10;
  return {
    demesne: total,
    domains,
    total,
    gross,
    efficiency,
    debtInterest: interest,
    net,
  };
}

/** Or actuel (peut être négatif = dette). */
export function getGold(p: Possession): number {
  return Math.round((p.gold ?? 0) * 10) / 10;
}

/** Solde ; pas de plancher — la dette est autorisée. */
export function setGold(p: Possession, amount: number): void {
  p.gold = Math.round(amount * 10) / 10;
}

export function addGold(p: Possession, delta: number): void {
  setGold(p, getGold(p) + delta);
}

export function getPrestige(p: Possession): number {
  return Math.max(0, Math.round((p.prestige ?? 0) * 10) / 10);
}

export function setPrestige(p: Possession, amount: number): void {
  p.prestige = Math.max(0, Math.round(amount * 10) / 10);
}

export function addPrestige(p: Possession, delta: number): void {
  setPrestige(p, getPrestige(p) + delta);
}

/** Trésor de départ ≈ quelques mois de revenu demesne. */
export const STARTING_TREASURY_MONTHS = 16;

/** Prestige de départ ≈ quelques mois de gain territorial. */
export const STARTING_PRESTIGE_MONTHS = 10;

/**
 * Coût d’un cadeau selon le rang du destinataire (une seule fois).
 * Roi ≈ 100 or ; titres moindres moins cher.
 */
export function giftCostForRank(rank: PossessionRank): number {
  if (rank === "king") return 100;
  if (rank === "vassal") return 40;
  if (rank === "subvassal") return 25;
  return 20; // chief
}

/** Coût en prestige pour demander l’allégeance selon le rang cible. */
export function allegiancePrestigeCost(rank: PossessionRank): number {
  if (rank === "king") return 50;
  if (rank === "vassal") return 30;
  if (rank === "subvassal") return 20;
  return 15; // chief
}

/** Prestige gagné en remportant une guerre, selon le rang du vaincu. */
export function warVictoryPrestige(rank: PossessionRank): number {
  if (rank === "king") return 40;
  if (rank === "vassal") return 25;
  if (rank === "subvassal") return 15;
  return 20; // chief
}

/** Mois de revenu de royaume pillés au vainqueur d’une guerre. */
export const WAR_LOOT_INCOME_MONTHS = 4;
/** Butin minimum même contre un royaume pauvre. */
export const WAR_LOOT_MIN_GOLD = 15;

/** Revenu mensuel de tout le royaume (demesne + vassaux, récursif) — mesure de sa richesse. */
export function realmMonthlyIncome(world: WorldData, p: Possession): number {
  const seen = new Set<number>();
  function walk(possession: Possession): number {
    if (seen.has(possession.id)) return 0;
    seen.add(possession.id);
    let total = possessionMonthlyIncome(world, possession);
    for (const vid of possession.vassalIds || []) {
      const v = (world.possessions || []).find((x) => x.id === vid);
      if (v) total += walk(v);
    }
    return total;
  }
  return walk(p);
}

/** Or pillé au vainqueur d’une guerre, proportionnel à la richesse du royaume vaincu. */
export function warVictoryGold(world: WorldData, loser: Possession): number {
  const income = realmMonthlyIncome(world, loser);
  return Math.max(WAR_LOOT_MIN_GOLD, Math.round(income * WAR_LOOT_INCOME_MONTHS));
}

/** Valeur fixe par domaine effectivement récupéré (butin de guerre), en plus du pillage. */
export const WAR_LOOT_GOLD_PER_DOMAIN = 30;

/** Or gagné pour les domaines qui changent effectivement de mains à la victoire. */
export function warVictoryDomainGold(domainCount: number): number {
  return Math.max(0, domainCount) * WAR_LOOT_GOLD_PER_DOMAIN;
}

/** Gain d’opinion pour un cadeau accepté. */
export const GIFT_OPINION_GAIN = 40;

export function formatGold(n: number): string {
  const v = Math.round(n * 10) / 10;
  const sign = v < 0 ? "−" : "";
  const abs = Math.abs(v);
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  if (Number.isInteger(abs)) return `${sign}${abs.toLocaleString("en-US")}`;
  return `${sign}${abs.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}`;
}

/** Affiche un flux mensuel avec signe explicite (+/−). */
export function formatGoldDelta(n: number): string {
  const v = Math.round(n * 10) / 10;
  if (v > 0) return `+${formatGold(v)}`;
  if (v < 0) return formatGold(v); // déjà préfixé de −
  return formatGold(0);
}

export const formatPrestige = formatGold;
