import { getPossessionDemesneManpower } from "../lib/population";
import type { Possession, WorldData } from "../types/world";
import { areNeighbors } from "./power";
import type { GameState } from "./types";

/** Clé opinion : « from → toward ». */
export function opinionKey(fromId: number, towardId: number): string {
  return `${fromId}>${towardId}`;
}

function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function clampOpinion(n: number): number {
  return Math.max(-100, Math.min(100, Math.round(n)));
}

/**
 * Opinion initiale de `from` envers `toward` (−100…100).
 * Même culture / voisins → plus favorable ; puissance écrasante peut intimider ou irriter.
 */
export function baseOpinion(
  world: WorldData,
  from: Possession,
  toward: Possession,
): number {
  if (from.id === toward.id) return 100;
  // Baseline un peu plus chaude + variance plus large
  let o = 2 + (hash01(from.id * 17.3 + toward.id * 9.1) - 0.5) * 50;

  if (from.royaumeId != null && from.royaumeId === toward.royaumeId) o += 28;
  if (from.name === toward.name) o += 12;
  if (areNeighbors(world, from.id, toward.id)) o += 22;

  if (from.liegeId === toward.id) o += 35;
  if (toward.liegeId === from.id) o += 16;

  // Demesne only — évite la circularité avec la contribution vassale (dépend des opinions).
  const pf = getPossessionDemesneManpower(world, from).levies;
  const pt = getPossessionDemesneManpower(world, toward).levies;
  if (pt > pf * 2.2) o += 12; // respect / fear of the strong
  else if (pt > pf * 1.4) o += 6;
  else if (pf > pt * 2) o -= 8; // scorn for the weak

  // Rival kings of same realm label
  if (from.rank === "king" && toward.rank === "king" && from.name === toward.name) {
    o -= 40;
  }

  return clampOpinion(o);
}

/** Construit la matrice pour tous les personnages. */
export function buildOpinionMatrix(world: WorldData): Record<string, number> {
  const list = world.possessions || [];
  const out: Record<string, number> = {};
  for (const a of list) {
    for (const b of list) {
      if (a.id === b.id) continue;
      out[opinionKey(a.id, b.id)] = baseOpinion(world, a, b);
    }
  }
  return out;
}

export function getOpinion(
  opinions: Record<string, number>,
  fromId: number,
  towardId: number,
): number {
  if (fromId === towardId) return 100;
  return opinions[opinionKey(fromId, towardId)] ?? 0;
}

export function setOpinion(
  opinions: Record<string, number>,
  fromId: number,
  towardId: number,
  value: number,
): void {
  if (fromId === towardId) return;
  opinions[opinionKey(fromId, towardId)] = clampOpinion(value);
}

export function adjustOpinion(
  opinions: Record<string, number>,
  fromId: number,
  towardId: number,
  delta: number,
): void {
  const cur = getOpinion(opinions, fromId, towardId);
  setOpinion(opinions, fromId, towardId, cur + delta);
}

/** Seuil « aime bien » pour envisager l’allégeance. */
export const ALLEGIANCE_OPINION_MIN = 55;

/** Malus d’opinion des voisins géographiques d’un territoire conquis (crainte). */
export const WAR_NEIGHBOR_FEAR_MALUS = -14;

/** Malus plus léger chez les voisins à la déclaration de guerre. */
export const WAR_DECLARE_NEIGHBOR_MALUS = -6;

/**
 * Distances BFS sur le graphe des possessions (hops de voisinage).
 * `Infinity` si hors composante connexe.
 */
export function buildPossessionDistances(
  world: WorldData,
  fromId: number,
): Map<number, number> {
  const list = world.possessions || [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const dist = new Map<number, number>();
  if (!byId.has(fromId)) return dist;
  dist.set(fromId, 0);
  const q: number[] = [fromId];
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    const d = dist.get(cur)!;
    const p = byId.get(cur);
    if (!p) continue;
    for (const nid of p.neighbors || []) {
      if (dist.has(nid)) continue;
      dist.set(nid, d + 1);
      q.push(nid);
    }
  }
  return dist;
}

/**
 * Probabilité mensuelle qu’une opinion progresse vers sa cible naturelle.
 * Amplifiée : les relations se réchauffent plus vite, surtout entre voisins.
 */
function monthlyWarmChance(hops: number | undefined): number {
  if (hops == null) return 0.02;
  if (hops <= 1) return 0.55;
  if (hops === 2) return 0.28;
  if (hops === 3) return 0.12;
  if (hops <= 5) return 0.05;
  return 0.018;
}

/**
 * Dérive mensuelle : les avis progressent très lentement vers la relation naturelle
 * (`baseOpinion`), plus lentement encore si les dirigeants sont loin.
 * Pas de dérive pendant une guerre active entre les deux camps.
 */
export function tickOpinions(game: GameState): void {
  const list = game.world.possessions || [];
  if (list.length < 2) return;

  const warPairs = new Set<string>();
  for (const w of game.wars) {
    const a = Math.min(w.attackerId, w.defenderId);
    const b = Math.max(w.attackerId, w.defenderId);
    warPairs.add(`${a}>${b}`);
  }

  const distCache = new Map<number, Map<number, number>>();
  const getDist = (fromId: number, toId: number): number | undefined => {
    let m = distCache.get(fromId);
    if (!m) {
      m = buildPossessionDistances(game.world, fromId);
      distCache.set(fromId, m);
    }
    return m.get(toId);
  };

  for (const from of list) {
    for (const toward of list) {
      if (from.id === toward.id) continue;
      const a = Math.min(from.id, toward.id);
      const b = Math.max(from.id, toward.id);
      if (warPairs.has(`${a}>${b}`)) continue;

      const target = baseOpinion(game.world, from, toward);
      const alliedBonus = (() => {
        if (!game.alliances?.length) return 0;
        const key =
          from.id < toward.id
            ? `${from.id}:${toward.id}`
            : `${toward.id}:${from.id}`;
        return game.alliances.some(
          (a) =>
            (a.aId < a.bId ? `${a.aId}:${a.bId}` : `${a.bId}:${a.aId}`) === key,
        )
          ? 22
          : 0;
      })();
      const natural = Math.min(100, target + alliedBonus);
      const cur = getOpinion(game.opinions, from.id, toward.id);
      if (cur >= natural) continue;

      const hops = getDist(from.id, toward.id);
      if (Math.random() > monthlyWarmChance(hops)) continue;
      // Voisins : parfois +2 pour accélérer
      const step = hops != null && hops <= 1 && Math.random() < 0.35 ? 2 : 1;
      adjustOpinion(game.opinions, from.id, toward.id, step);
    }
  }
}

/**
 * Titulaires (et leurs suzerains) des domaines voisins d’un ensemble de domaines,
 * hors `excludeIds`.
 */
export function holdersNeighboringDomains(
  world: WorldData,
  domainIds: Iterable<number>,
  excludeIds: Set<number>,
): number[] {
  const byId = new Map((world.possessions || []).map((p) => [p.id, p]));
  const found = new Set<number>();

  for (const did of domainIds) {
    const d = world.domaines.find((x) => x.id === did) ?? world.domaines[did];
    if (!d) continue;
    for (const nid of d.neighbors || []) {
      const n = world.domaines.find((x) => x.id === nid) ?? world.domaines[nid];
      if (!n || n.possessionId == null) continue;
      const holder = byId.get(n.possessionId);
      if (!holder) continue;
      if (!excludeIds.has(holder.id)) found.add(holder.id);
      if (holder.liegeId != null && !excludeIds.has(holder.liegeId)) {
        found.add(holder.liegeId);
      }
    }
  }

  return [...found];
}

/** Malus de crainte chez les voisins d’un territoire conquis / du théâtre de guerre. */
export function applyNeighborFearMalus(
  game: GameState,
  towardId: number,
  domainIds: Iterable<number>,
  excludeIds: Iterable<number>,
  delta: number,
): void {
  const exclude = new Set(excludeIds);
  exclude.add(towardId);
  for (const id of holdersNeighboringDomains(game.world, domainIds, exclude)) {
    adjustOpinion(game.opinions, id, towardId, delta);
  }
}
