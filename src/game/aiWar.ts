import type { WorldData } from "../types/world";
import { domainById, sideRemainingPower, warSideOf } from "./army";
import {
  canPressDemands,
  orderMarch,
  pressDemands,
  raiseLevies,
  requestWhitePeace,
  surrenderWar,
  warScorePercent,
} from "./army-actions";
import { callAlly, eligibleAlliesToCall } from "./ally-war";
import type { GameState, WarState } from "./types";
import { findPossession } from "./war";

/** Score de guerre en dessous duquel un belligérant IA cherche du renfort allié. */
export const AI_CALL_ALLY_SCORE_THRESHOLD = -20;

/** BFS non pondéré — cible non capturée la plus proche depuis un domaine donné. */
function nearestTarget(
  world: WorldData,
  fromDomainId: number,
  targets: Set<number>,
): number | undefined {
  if (targets.has(fromDomainId)) return fromDomainId;
  const visited = new Set<number>([fromDomainId]);
  const queue: number[] = [fromDomainId];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = domainById(world, cur);
    if (!d) continue;
    for (const nid of d.neighbors || []) {
      if (visited.has(nid)) continue;
      visited.add(nid);
      if (targets.has(nid)) return nid;
      queue.push(nid);
    }
  }
  return undefined;
}

/**
 * Conduite militaire d’un participant IA (belligérant principal ou allié
 * ayant rejoint) pour une guerre : pas de scoring, une simple chaîne de
 * règles déterministe (appeler du renfort → lever → marcher → presser →
 * sortir). `role: "ally"` désactive presser/se rendre/paix blanche — un
 * allié combat mais ne décide pas de l’issue de la guerre d’un autre.
 */
function conductSide(
  game: GameState,
  war: WarState,
  actorId: number,
  role: "primary" | "ally",
): void {
  if (actorId === game.playerId) return;
  const actor = findPossession(game.world, actorId);
  if (!actor) return;

  if (role === "primary") {
    const pressCheck = canPressDemands(game, war, actorId);
    if (pressCheck.ok) {
      pressDemands(game, war.id, actorId);
      return;
    }
    // En difficulté et pas encore aidé : chercher du renfort allié avant de
    // continuer à se battre seul.
    if (warScorePercent(game, war, actorId) < AI_CALL_ALLY_SCORE_THRESHOLD) {
      const candidates = eligibleAlliesToCall(game, war, actorId);
      if (candidates.length && callAlly(game, war.id, candidates[0], actorId)) return;
    }
  }

  const myArmies = game.armies.filter((a) => a.warId === war.id && a.ownerId === actorId);

  if (!myArmies.length && raiseLevies(game, war.id, actorId)) return;

  const isAttacker = warSideOf(war, actorId) === "attacker";
  const targetOrder = isAttacker ? war.conquestOrder : war.attackerFrontOrder;
  const captured = new Set(isAttacker ? war.capturedByAttacker : war.capturedByDefender);
  const targets = new Set((targetOrder || []).filter((id) => !captured.has(id)));

  let ordered = false;
  if (targets.size) {
    for (const army of myArmies) {
      if (army.stance !== "idle") continue;
      const dest = nearestTarget(game.world, army.domainId, targets);
      if (dest == null) continue;
      if (orderMarch(game, army.id, dest, actorId)) ordered = true;
    }
  }
  if (ordered || myArmies.length) return;
  if (role !== "primary") return; // un allié à sec attend, ne se rend pas pour un autre

  // Filet de sécurité anti-blocage : plus d’armée, plus de levées disponibles → sortir de guerre.
  if ((actor.manpower ?? 0) > 0) return;
  const otherId = isAttacker ? war.defenderId : war.attackerId;
  const myPower = sideRemainingPower(game, war.id, actorId);
  const otherPower = sideRemainingPower(game, war.id, otherId);
  if (myPower <= 0) {
    surrenderWar(game, war.id, actorId);
    return;
  }
  if (otherPower > myPower * 1.5) {
    requestWhitePeace(game, war.id, actorId);
  }
}

/** Conduite militaire quotidienne de toutes les guerres impliquant au moins une IA. */
export function runAiWarConduct(game: GameState): void {
  if (!game.wars.length) return;
  for (const war of [...game.wars]) {
    if (!game.wars.some((w) => w.id === war.id)) continue;
    conductSide(game, war, war.attackerId, "primary");
    if (!game.wars.some((w) => w.id === war.id)) continue;
    conductSide(game, war, war.defenderId, "primary");
    if (!game.wars.some((w) => w.id === war.id)) continue;
    for (const allyId of [...(war.allyOfAttacker || []), ...(war.allyOfDefender || [])]) {
      conductSide(game, war, allyId, "ally");
    }
  }
}
