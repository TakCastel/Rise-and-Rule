import type { Possession, WorldData } from "../types/world";
import type { Army } from "./army";
import { possessionPower } from "./power";
import type { Alliance, GameState } from "./types";
import { pushLog } from "./types";
import { findPossession } from "./war";

/** Opinion mini de la cible envers le demandeur pour accepter l’alliance. */
export const ALLIANCE_OPINION_MIN = 30;

/**
 * Distance max (hops sur le graphe des possessions) pour demander une alliance.
 * 1 = voisin direct ; 3 ≈ 2–3 territoires.
 */
export const ALLIANCE_MAX_HOPS = 3;

/** Espacement mini entre naissances (années). */
export const CHILD_MIN_YEARS_GAP = 2;

/**
 * Chance mensuelle d’avoir un enfant si éligible.
 * ≈ 1/30 → un enfant tous les ~2.5 ans en moyenne.
 */
export const CHILD_BIRTH_CHANCE_MONTHLY = 1 / 30;

/**
 * Si un bloc de vassaux alliés dépasse la force du seigneur,
 * chance mensuelle qu’ils se rebellent.
 */
export const ALLIED_BLOC_REBEL_CHANCE = 0.12;

/** Ratio bloc / seigneur au-delà duquel le risque existe. */
export const ALLIED_BLOC_POWER_RATIO = 1.05;

export function allianceKey(aId: number, bId: number): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

export function areAllied(
  alliances: Alliance[] | undefined,
  aId: number,
  bId: number,
): boolean {
  if (aId === bId || !alliances?.length) return false;
  const key = allianceKey(aId, bId);
  return alliances.some((a) => allianceKey(a.aId, a.bId) === key);
}

export function getAllyIds(
  alliances: Alliance[] | undefined,
  possessionId: number,
): number[] {
  if (!alliances?.length) return [];
  const out: number[] = [];
  for (const a of alliances) {
    if (a.aId === possessionId) out.push(a.bId);
    else if (a.bId === possessionId) out.push(a.aId);
  }
  return out;
}

export function getChildrenTokens(p: Possession): number {
  return Math.max(0, p.childrenTokens ?? 0);
}

/**
 * Ids à portée d’alliance (≤ ALLIANCE_MAX_HOPS hops), hors soi-même.
 * Retourne aussi la distance pour l’UI / le scoring.
 */
export function allianceRangeTargets(
  world: WorldData,
  fromId: number,
  maxHops: number = ALLIANCE_MAX_HOPS,
): { id: number; hops: number }[] {
  const list = world.possessions || [];
  const byId = new Map(list.map((p) => [p.id, p]));
  if (!byId.has(fromId)) return [];

  const dist = new Map<number, number>();
  dist.set(fromId, 0);
  const q: number[] = [fromId];
  const out: { id: number; hops: number }[] = [];

  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    const d = dist.get(cur)!;
    if (d >= maxHops) continue;
    const p = byId.get(cur);
    if (!p) continue;
    for (const nid of p.neighbors || []) {
      if (dist.has(nid)) continue;
      const hops = d + 1;
      dist.set(nid, hops);
      q.push(nid);
      if (nid !== fromId) out.push({ id: nid, hops });
    }
  }
  return out;
}

/**
 * Contribution militaire des alliés : **toutes** leurs troupes
 * (demesne + vassaux), hors double-compte si déjà vassal du belligérant.
 */
export function allyTroopContribution(
  world: WorldData,
  p: Possession,
  opinions: Record<string, number> | undefined,
  alliances: Alliance[] | undefined,
  armies?: Army[],
): number {
  let total = 0;
  const vassalSet = new Set(p.vassalIds || []);
  for (const allyId of getAllyIds(alliances, p.id)) {
    if (vassalSet.has(allyId)) continue;
    if (allyId === p.liegeId) continue;
    const ally = findPossession(world, allyId);
    if (!ally) continue;
    total += possessionPower(world, ally, opinions, armies);
  }
  return total;
}

export function formAlliance(
  game: GameState,
  aId: number,
  bId: number,
): boolean {
  if (aId === bId || areAllied(game.alliances, aId, bId)) return false;
  if (!game.alliances) game.alliances = [];
  game.alliances = [
    ...game.alliances,
    { aId, bId, sinceYear: game.year },
  ];
  return true;
}

export function breakAlliance(
  game: GameState,
  aId: number,
  bId: number,
): void {
  if (!game.alliances?.length) return;
  const key = allianceKey(aId, bId);
  game.alliances = game.alliances.filter(
    (a) => allianceKey(a.aId, a.bId) !== key,
  );
}

/** Supprime toutes les alliances d’un personnage éliminé. */
export function purgeAlliancesFor(game: GameState, deadId: number): void {
  if (!game.alliances?.length) return;
  game.alliances = game.alliances.filter(
    (a) => a.aId !== deadId && a.bId !== deadId,
  );
}

function monthIndex(year: number, month: number): number {
  return year * 12 + month;
}

function canBirth(p: Possession, year: number, month: number): boolean {
  if (p.lastChildMonthIndex == null) return true;
  return monthIndex(year, month) - p.lastChildMonthIndex >= CHILD_MIN_YEARS_GAP * 12;
}

/** Naissances mensuelles — jetons de mariage. */
export function tickChildbirths(game: GameState): void {
  for (const p of game.world.possessions || []) {
    if (!canBirth(p, game.year, game.month)) continue;
    if (Math.random() > CHILD_BIRTH_CHANCE_MONTHLY) continue;
    p.childrenTokens = getChildrenTokens(p) + 1;
    p.lastChildMonthIndex = monthIndex(game.year, game.month);
    if (p.id === game.playerId) {
      pushLog(
        game,
        `A child is born to your house. You have ${getChildrenTokens(p)} marriage token${getChildrenTokens(p) === 1 ? "" : "s"}.`,
      );
    }
  }
}

/**
 * Composantes connexes des vassaux directs liés par alliance.
 */
export function alliedVassalBlocs(
  alliances: Alliance[] | undefined,
  vassalIds: number[],
): number[][] {
  const set = new Set(vassalIds);
  const adj = new Map<number, number[]>();
  for (const id of vassalIds) adj.set(id, []);
  for (const a of alliances || []) {
    if (!set.has(a.aId) || !set.has(a.bId)) continue;
    adj.get(a.aId)!.push(a.bId);
    adj.get(a.bId)!.push(a.aId);
  }

  const seen = new Set<number>();
  const blocs: number[][] = [];
  for (const id of vassalIds) {
    if (seen.has(id)) continue;
    const neighbors = adj.get(id) || [];
    if (neighbors.length === 0) {
      seen.add(id);
      continue; // pas d’alliance → pas de bloc
    }
    const bloc: number[] = [];
    const q = [id];
    seen.add(id);
    while (q.length) {
      const cur = q.pop()!;
      bloc.push(cur);
      for (const n of adj.get(cur) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    if (bloc.length >= 2) blocs.push(bloc);
  }
  return blocs;
}

export interface AlliedBlocThreat {
  liegeId: number;
  liegeName: string;
  leaderId: number;
  leaderName: string;
  blocIds: number[];
  blocPower: number;
  liegePower: number;
  /** Mode suggéré si la rébellion se déclenche. */
  mode: "depose" | "independence";
}

/**
 * Blocs de vassaux alliés plus forts que leur seigneur.
 * `busyIds` = personnages déjà en guerre (à exclure).
 */
export function listAlliedBlocThreats(
  game: GameState,
  busyIds: Set<number>,
): AlliedBlocThreat[] {
  const threats: AlliedBlocThreat[] = [];

  for (const liege of game.world.possessions || []) {
    const vassals = liege.vassalIds || [];
    if (vassals.length < 2) continue;
    if (busyIds.has(liege.id)) continue;

    const blocs = alliedVassalBlocs(game.alliances, vassals);
    for (const bloc of blocs) {
      let blocPower = 0;
      let leaderId = bloc[0];
      let leaderPower = 0;
      let busy = false;
      for (const vid of bloc) {
        if (busyIds.has(vid)) {
          busy = true;
          break;
        }
        const v = findPossession(game.world, vid);
        if (!v) continue;
        const pw = possessionPower(game.world, v, game.opinions, game.armies);
        blocPower += pw;
        if (pw > leaderPower) {
          leaderPower = pw;
          leaderId = vid;
        }
      }
      if (busy) continue;

      const liegePower = possessionPower(game.world, liege, game.opinions, game.armies);
      if (blocPower < liegePower * ALLIED_BLOC_POWER_RATIO) continue;

      const leader = findPossession(game.world, leaderId);
      if (!leader) continue;

      const mode: "depose" | "independence" =
        blocPower >= liegePower * 1.15 ? "depose" : "independence";

      threats.push({
        liegeId: liege.id,
        liegeName: liege.holderName,
        leaderId,
        leaderName: leader.holderName,
        blocIds: bloc,
        blocPower,
        liegePower,
        mode,
      });
    }
  }

  return threats;
}
