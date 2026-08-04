import type { Possession, WorldData } from "../types/world";
import {
  ARMY_MIN_TROOPS,
  chargeNavalEmbarkation,
  domainById,
  findMarchPath,
  legDaysBetween,
  sideRemainingPower,
  warSideOf,
  type Army,
} from "./army";
import { adjustOpinion } from "./opinion";
import type { GameState, WarState } from "./types";
import { pushLog } from "./types";
import { concludeWar, findPossession, raiseTroops, resolveWarVictory } from "./war";

function dayIndex(game: GameState): number {
  return game.year * 360 + game.month * 30 + game.day;
}

function warOf(game: GameState, warId: number): WarState | undefined {
  return game.wars.find((w) => w.id === warId);
}

function otherSideId(war: WarState, actorId: number): number | null {
  if (actorId === war.attackerId) return war.defenderId;
  if (actorId === war.defenderId) return war.attackerId;
  return null;
}

/** Domaine « capitale » d’une possession : le plus développé de son demesne. */
function homeDomainId(world: WorldData, actor: Possession): number | undefined {
  if (!actor.domaines?.length) return undefined;
  let best: { id: number; score: number } | undefined;
  for (const id of actor.domaines) {
    const d = domainById(world, id);
    if (!d) continue;
    const score = d.development ?? 0;
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? actor.domaines[0];
}

/** Lève une armée (une des levées disponibles) pour l’un des deux camps d’une guerre en cours. */
export function raiseLevies(
  game: GameState,
  warId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const war = warOf(game, warId);
  const actor = findPossession(game.world, actorId);
  if (!war || !actor) return false;
  if (!warSideOf(war, actorId)) return false;

  const raise = raiseTroops(game.world, actor, game.opinions, game.alliances);
  if (raise.host <= 0) {
    if (actorId === game.playerId) pushLog(game, `No levies available to raise.`);
    return false;
  }
  // Pas de troupe symbolique : en dessous du seuil viable, mieux vaut attendre
  // que le vivier de recrues se reconstitue plutôt que de lever une armée-alibi.
  if (raise.total < ARMY_MIN_TROOPS) {
    if (actorId === game.playerId) {
      pushLog(game, `Too few recruits to raise a viable levy yet — manpower must recover first.`);
    }
    return false;
  }
  const home = homeDomainId(game.world, actor);
  if (home == null) return false;

  if (!game.armies) game.armies = [];
  if (game.nextArmyId == null) game.nextArmyId = 1;
  game.armies.push({
    id: game.nextArmyId++,
    ownerId: actor.id,
    warId: war.id,
    domainId: home,
    troops: raise.total,
    stance: "idle",
    raisedDay: dayIndex(game),
  });
  actor.manpower = 0;

  pushLog(
    game,
    `${actor.holderName} raises an army of ${raise.total.toLocaleString()} at ${
      domainById(game.world, home)?.name ?? "their capital"
    }.`,
    [war.attackerId, war.defenderId],
  );
  return true;
}

/** Divise une armée immobile en deux stacks dans le même domaine. */
export function splitArmy(
  game: GameState,
  armyId: number,
  troopsToSplit: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const army = game.armies.find((a) => a.id === armyId);
  if (!army || army.ownerId !== actorId || army.stance !== "idle") return false;
  const amount = Math.floor(troopsToSplit);
  if (amount <= 0 || amount >= army.troops) return false;

  army.troops -= amount;
  if (game.nextArmyId == null) game.nextArmyId = 1;
  game.armies.push({
    id: game.nextArmyId++,
    ownerId: army.ownerId,
    warId: army.warId,
    domainId: army.domainId,
    troops: amount,
    stance: "idle",
    raisedDay: army.raisedDay,
  });
  return true;
}

/** Fusionne plusieurs armées immobiles du même camp, dans le même domaine. */
export function mergeArmies(
  game: GameState,
  armyIds: number[],
  actorId: number = game.playerId ?? -1,
): boolean {
  if (armyIds.length < 2) return false;
  const armies: Army[] = [];
  for (const id of armyIds) {
    const a = game.armies.find((x) => x.id === id);
    if (!a) return false;
    armies.push(a);
  }
  const [first, ...rest] = armies;
  if (first.ownerId !== actorId) return false;
  if (!armies.every((a) => a.stance === "idle" && a.ownerId === first.ownerId && a.domainId === first.domainId && a.warId === first.warId)) {
    return false;
  }
  for (const a of rest) {
    first.troops += a.troops;
  }
  const restIds = new Set(rest.map((a) => a.id));
  game.armies = game.armies.filter((a) => !restIds.has(a.id));
  return true;
}

/**
 * Ordonne la marche d’une armée vers un domaine cible (path calculé).
 * Fonctionne aussi en cours de route : l’armée est déjà engagée vers sa
 * prochaine étape (path[0]), donc on la laisse l’atteindre puis on
 * raccorde la nouvelle route à partir de là — pas de saut visuel arrière.
 */
export function orderMarch(
  game: GameState,
  armyId: number,
  destinationDomainId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const army = game.armies.find((a) => a.id === armyId);
  if (!army || army.ownerId !== actorId) return false;
  if (army.stance !== "idle" && army.stance !== "moving") return false;

  if (army.stance === "moving" && army.path?.length) {
    const committedNextId = army.path[0];
    const rest = findMarchPath(game.world, committedNextId, destinationDomainId);
    if (!rest) return false;
    army.path = [committedNextId, ...rest];
    return true;
  }

  const path = findMarchPath(game.world, army.domainId, destinationDomainId);
  if (!path || !path.length) return false;

  chargeNavalEmbarkation(game, army, army.domainId, path[0]);
  army.path = path;
  army.stance = "moving";
  army.legDays = legDaysBetween(game.world, army.domainId, path[0]);
  army.legProgress = 0;
  return true;
}

export interface PressDemandsCheck {
  ok: boolean;
  reason?: string;
}

/** Éligibilité à « appuyer nos exigences » — équivalent du 100 % de l’ancien front, piloté par les captures réelles. */
export function canPressDemands(war: WarState, actorId: number): PressDemandsCheck {
  const isAttacker = actorId === war.attackerId;
  if (!isAttacker && actorId !== war.defenderId) return { ok: false, reason: "Not a party to this war" };

  const cb = war.casusBelli ?? "claim_province";
  if ((cb === "claim_province" || cb === "conquest") && isAttacker) {
    const goalIds = war.warGoalDomainIds?.length ? war.warGoalDomainIds : war.conquestOrder;
    if (!goalIds?.length) return { ok: false, reason: "No war goal" };
    // Occupé militairement (siège terminé), pas forcément déjà transféré —
    // le transfert réel n’a lieu qu’à la résolution de la guerre.
    const captured = new Set(war.capturedByAttacker || []);
    const secured = goalIds.every((id) => captured.has(id));
    return secured ? { ok: true } : { ok: false, reason: "War goal not yet secured" };
  }

  if (isAttacker) {
    const total = war.conquestOrder?.length ?? 0;
    if (total > 0 && (war.capturedByAttacker?.length ?? 0) >= total) return { ok: true };
    return { ok: false, reason: "The enemy realm is not yet fully conquered" };
  }
  const total = war.attackerFrontOrder?.length ?? 0;
  if (total > 0 && (war.capturedByDefender?.length ?? 0) >= total) return { ok: true };
  return { ok: false, reason: "You have not overrun enough of their homeland" };
}

/** Poids du score de guerre : territoire pris sur l'ensemble du royaume adverse (le gros du score, proportionnel à sa taille). */
const WAR_SCORE_TERRITORY_WEIGHT = 65;
/** Bonus pour l'objectif de guerre (claim) effectivement sécurisé — compte bien plus qu'un domaine "au hasard" de même poids territorial. */
const WAR_SCORE_GOAL_BONUS = 20;
/** Points par bataille rangée gagnée, plafonnés — la progression ne vient pas que des sièges. */
const WAR_SCORE_PER_BATTLE_WIN = 3;
const WAR_SCORE_BATTLE_WINS_CAP = 15;

/**
 * Score de guerre signé (−100…100) du point de vue de `viewerId` : essentiellement
 * la part du royaume adverse effectivement prise (proportionnelle à sa taille —
 * un seul domaine conquis sur un empire de 100 ne vaut pas 100%), plus un bonus
 * pour l'objectif de guerre (claim) spécifiquement sécurisé et pour les batailles
 * rangées gagnées, moins l'équivalent côté adverse. Positif = on l'emporte.
 * `canPressDemands` reste indépendant de ce score : il ne regarde que l'objectif
 * de guerre réellement sécurisé, pas ce pourcentage global.
 */
export function warScorePercent(war: WarState, viewerId: number): number {
  const isAttacker = viewerId === war.attackerId;
  const myTotal = isAttacker ? (war.conquestOrder?.length ?? 0) : (war.attackerFrontOrder?.length ?? 0);
  const enemyTotal = isAttacker ? (war.attackerFrontOrder?.length ?? 0) : (war.conquestOrder?.length ?? 0);
  const myCaptured = (isAttacker ? war.capturedByAttacker : war.capturedByDefender)?.length ?? 0;
  const enemyCaptured = (isAttacker ? war.capturedByDefender : war.capturedByAttacker)?.length ?? 0;

  const myTerritory = myTotal > 0 ? Math.min(1, myCaptured / myTotal) : 0;
  const enemyTerritory = enemyTotal > 0 ? Math.min(1, enemyCaptured / enemyTotal) : 0;

  // L'objectif de guerre (claim) ne concerne que l'attaquant d'une guerre de claim/conquête.
  const cb = war.casusBelli ?? "claim_province";
  let myGoalBonus = 0;
  if (isAttacker && (cb === "claim_province" || cb === "conquest")) {
    const goalIds = war.warGoalDomainIds?.length ? war.warGoalDomainIds : war.conquestOrder;
    if (goalIds?.length) {
      const captured = new Set(war.capturedByAttacker || []);
      const goalFraction = goalIds.filter((id) => captured.has(id)).length / goalIds.length;
      myGoalBonus = goalFraction * WAR_SCORE_GOAL_BONUS;
    }
  }

  const myBattleWins = isAttacker ? (war.battleWinsAttacker ?? 0) : (war.battleWinsDefender ?? 0);
  const enemyBattleWins = isAttacker ? (war.battleWinsDefender ?? 0) : (war.battleWinsAttacker ?? 0);
  const myBattleBonus = Math.min(WAR_SCORE_BATTLE_WINS_CAP, myBattleWins * WAR_SCORE_PER_BATTLE_WIN);
  const enemyBattleBonus = Math.min(WAR_SCORE_BATTLE_WINS_CAP, enemyBattleWins * WAR_SCORE_PER_BATTLE_WIN);

  const myScore = myTerritory * WAR_SCORE_TERRITORY_WEIGHT + myGoalBonus + myBattleBonus;
  const enemyScore = enemyTerritory * WAR_SCORE_TERRITORY_WEIGHT + enemyBattleBonus;

  return Math.max(-100, Math.min(100, Math.round(myScore - enemyScore)));
}

/** Éligibilité à demander une paix blanche : refusée si l’autre camp n’est pas clairement le plus faible. */
export function canRequestWhitePeace(
  game: GameState,
  war: WarState,
  actorId: number,
): PressDemandsCheck {
  const otherId = otherSideId(war, actorId);
  if (otherId == null) return { ok: false, reason: "Not a party to this war" };
  return evaluateWhitePeaceAcceptance(game, war, actorId)
    ? { ok: true }
    : { ok: false, reason: "The enemy believes they are winning and refuses" };
}

/** Clôt la guerre immédiatement en faveur de l’acteur, si son war goal est acquis. */
export function pressDemands(
  game: GameState,
  warId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const war = warOf(game, warId);
  if (!war) return false;
  const check = canPressDemands(war, actorId);
  if (!check.ok) {
    if (actorId === game.playerId && check.reason) {
      pushLog(game, `Cannot press demands: ${check.reason}.`);
    }
    return false;
  }
  const otherId = otherSideId(war, actorId);
  if (otherId == null) return false;
  resolveWarVictory(game, actorId, otherId, war.casusBelli ?? "claim_province", war);
  return true;
}

/** Capitule : l’autre camp gagne avec ce qui a déjà été capturé (pas de conquête forcée). */
export function surrenderWar(
  game: GameState,
  warId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const war = warOf(game, warId);
  if (!war) return false;
  const otherId = otherSideId(war, actorId);
  if (otherId == null) return false;
  if (actorId === game.playerId) {
    pushLog(game, `You surrender the war. Terms are dictated by the enemy.`);
  }
  resolveWarVictory(game, otherId, actorId, war.casusBelli ?? "claim_province", war);
  return true;
}

/** Ratio en dessous duquel le camp le plus faible accepte une paix blanche. */
export const WHITE_PEACE_ACCEPT_RATIO = 0.6;

export function evaluateWhitePeaceAcceptance(
  game: GameState,
  war: WarState,
  requesterId: number,
): boolean {
  const otherId = otherSideId(war, requesterId);
  if (otherId == null) return false;
  const requesterPower = sideRemainingPower(game, war.id, requesterId);
  const otherPower = sideRemainingPower(game, war.id, otherId);
  return otherPower <= requesterPower * WHITE_PEACE_ACCEPT_RATIO;
}

/** Demande une paix blanche — pas de vraie négociation asynchrone : résolue immédiatement selon l’heuristique. */
export function requestWhitePeace(
  game: GameState,
  warId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const war = warOf(game, warId);
  if (!war) return false;
  const otherId = otherSideId(war, actorId);
  if (otherId == null) return false;

  const actor = findPossession(game.world, actorId);
  const other = findPossession(game.world, otherId);
  if (!evaluateWhitePeaceAcceptance(game, war, actorId)) {
    if (actorId === game.playerId) {
      pushLog(
        game,
        `${other?.holderName ?? "The enemy"} refuses your offer of white peace.`,
        [actorId, otherId],
      );
    }
    return false;
  }

  adjustOpinion(game.opinions, actorId, otherId, -5);
  adjustOpinion(game.opinions, otherId, actorId, -5);
  pushLog(
    game,
    `${actor?.holderName ?? "?"} and ${other?.holderName ?? "?"} agree to a white peace — the war ends with no changes.`,
    [actorId, otherId],
  );
  concludeWar(game, war);
  return true;
}
