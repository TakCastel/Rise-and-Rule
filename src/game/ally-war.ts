import { areAllied, getAllyIds } from "./alliance";
import { sideRemainingPower, warSideOf, type WarSide } from "./army";
import type { AllyCallRequest, GameState, WarState } from "./types";
import { pushLog, pushNotice } from "./types";
import { addPrestige, formatPrestige } from "./economy";
import { adjustOpinion } from "./opinion";
import { findPossession } from "./war";

/** Prestige perdu par celui qui refuse (ou n’honore pas) un appel à l’aide allié. */
export const ALLY_CALL_DECLINE_PRESTIGE_COST = 15;
/** Un allié IA accepte si son propre camp n’est pas nettement plus faible que l’ennemi. */
export const ALLY_CALL_ACCEPT_RATIO = 0.5;
/** Une demande adressée au joueur expire (refus automatique) après ce délai. */
export const ALLY_CALL_REQUEST_TIMEOUT_DAYS = 10;

function warOf(game: GameState, warId: number): WarState | undefined {
  return game.wars.find((w) => w.id === warId);
}

/** Alliés d’un belligérant pas encore engagés dans cette guerre (ni d’un côté ni de l’autre). */
export function eligibleAlliesToCall(
  game: GameState,
  war: WarState,
  callerId: number,
): number[] {
  const already = new Set<number>([
    war.attackerId,
    war.defenderId,
    ...(war.allyOfAttacker || []),
    ...(war.allyOfDefender || []),
  ]);
  const isRebellionWar = war.casusBelli === "depose" || war.casusBelli === "independence";
  return getAllyIds(game.alliances, callerId).filter((id) => {
    if (already.has(id)) return false;
    // Un vassal ne peut jamais être appelé en renfort dans une guerre
    // d’indépendance/renversement — s’il veut se dresser contre un seigneur
    // lige, c’est par sa propre rébellion, jamais parce qu’un allié l’y
    // entraîne malgré lui.
    if (isRebellionWar && findPossession(game.world, id)?.liegeId != null) return false;
    return true;
  });
}

export interface CallableAlly {
  warId: number;
  allyId: number;
  allyName: string;
  enemyName: string;
}

/** Pour l’UI : les guerres où le joueur est belligérant principal et a des alliés pas encore appelés. */
export function listCallableAllies(game: GameState): CallableAlly[] {
  if (game.playerId == null) return [];
  const out: CallableAlly[] = [];
  for (const war of game.wars) {
    const side = warSideOf(war, game.playerId);
    if (side !== "attacker" && side !== "defender") continue;
    const enemyName = side === "attacker" ? war.defenderName : war.attackerName;
    for (const allyId of eligibleAlliesToCall(game, war, game.playerId)) {
      const ally = findPossession(game.world, allyId);
      if (!ally) continue;
      out.push({ warId: war.id, allyId, allyName: ally.holderName, enemyName });
    }
  }
  return out;
}

export interface IncomingAllyCall {
  requestId: number;
  warId: number;
  callerId: number;
  callerName: string;
  enemyName: string;
}

/** Pour l’UI : les appels à l’aide reçus par le joueur, en attente de réponse. */
export function listIncomingAllyCalls(game: GameState): IncomingAllyCall[] {
  if (game.playerId == null) return [];
  const out: IncomingAllyCall[] = [];
  for (const request of game.allyCallRequests || []) {
    if (request.targetId !== game.playerId) continue;
    const war = warOf(game, request.warId);
    const caller = findPossession(game.world, request.callerId);
    if (!war || !caller) continue;
    const callerSide = warSideOf(war, request.callerId);
    const enemyName = callerSide === "attacker" ? war.defenderName : war.attackerName;
    out.push({
      requestId: request.id,
      warId: request.warId,
      callerId: request.callerId,
      callerName: caller.holderName,
      enemyName,
    });
  }
  return out;
}

/** Heuristique d’acceptation IA : accepte si son propre camp de guerre n’écrase pas nettement l’adversaire… côté allié, dans l’autre sens : accepte si l’adversaire n’est pas nettement plus fort que l’appelant. */
export function evaluateAllyCallAcceptance(
  game: GameState,
  war: WarState,
  callerId: number,
): boolean {
  const callerSide = warSideOf(war, callerId);
  if (!callerSide) return false;
  const otherPrimaryId: number = callerSide === "attacker" ? war.defenderId : war.attackerId;
  const callerPower = sideRemainingPower(game, war.id, callerId);
  const otherPower = sideRemainingPower(game, war.id, otherPrimaryId);
  // Accepte si l'appelant n'est pas déjà écrasé — inutile de rejoindre une cause perdue.
  return callerPower >= otherPower * ALLY_CALL_ACCEPT_RATIO;
}

function joinWarSide(war: WarState, side: WarSide, allyId: number): void {
  if (side === "attacker") {
    if (!(war.allyOfAttacker || []).includes(allyId)) {
      war.allyOfAttacker = [...(war.allyOfAttacker || []), allyId];
    }
  } else if (!(war.allyOfDefender || []).includes(allyId)) {
    war.allyOfDefender = [...(war.allyOfDefender || []), allyId];
  }
}

function applyDeclinePenalty(game: GameState, decliner: number, caller: number): void {
  const decliningPossession = findPossession(game.world, decliner);
  if (decliningPossession) addPrestige(decliningPossession, -ALLY_CALL_DECLINE_PRESTIGE_COST);
  adjustOpinion(game.opinions, caller, decliner, -10);
  adjustOpinion(game.opinions, decliner, caller, -6);
}

/**
 * Un belligérant (`callerId`, attaquant ou défenseur de `warId`) sollicite un
 * allié (`allyId`). Si l’allié est une IA, la réponse est résolue le jour
 * même (accepte → lève sa propre armée via `runAiWarConduct` ; refuse →
 * perd du prestige). Si l’allié est le joueur, une demande reste en attente
 * jusqu’à réponse manuelle (`respondAllyCall`).
 */
export function callAlly(
  game: GameState,
  warId: number,
  allyId: number,
  callerId: number = game.playerId ?? -1,
): boolean {
  const war = warOf(game, warId);
  const caller = findPossession(game.world, callerId);
  const ally = findPossession(game.world, allyId);
  if (!war || !caller || !ally) return false;

  const callerSide = warSideOf(war, callerId);
  if (!callerSide) return false;
  if (!areAllied(game.alliances, callerId, allyId)) return false;
  if (!eligibleAlliesToCall(game, war, callerId).includes(allyId)) return false;

  if (allyId === game.playerId) {
    if (!game.allyCallRequests) game.allyCallRequests = [];
    if (game.nextAllyCallRequestId == null) game.nextAllyCallRequestId = 1;
    if (game.allyCallRequests.some((r) => r.warId === warId && r.targetId === allyId)) return false;
    game.allyCallRequests.push({
      id: game.nextAllyCallRequestId++,
      warId,
      callerId,
      targetId: allyId,
      daysElapsed: 0,
    });
    pushLog(
      game,
      `${caller.holderName} calls upon ${ally.holderName} to join the war.`,
      [callerId, allyId],
    );
    return true;
  }

  if (evaluateAllyCallAcceptance(game, war, callerId)) {
    joinWarSide(war, callerSide, allyId);
    adjustOpinion(game.opinions, callerId, allyId, 8);
    pushLog(
      game,
      `${ally.holderName} answers ${caller.holderName}'s call and joins the war.`,
      [callerId, allyId, war.attackerId, war.defenderId],
    );
    if (callerId === game.playerId) {
      pushNotice(game, `${ally.holderName} answers your call and joins the war.`, {
        title: "Ally joins the war",
      });
    }
  } else {
    applyDeclinePenalty(game, allyId, callerId);
    pushLog(
      game,
      `${ally.holderName} declines ${caller.holderName}'s call to arms (−${formatPrestige(ALLY_CALL_DECLINE_PRESTIGE_COST)} prestige).`,
      [callerId, allyId],
    );
    if (callerId === game.playerId) {
      pushNotice(game, `${ally.holderName} declines your call to arms.`, {
        title: "Ally refuses to join",
      });
    }
  }
  return true;
}

/** Réponse manuelle du joueur à un appel à l’aide reçu. */
export function respondAllyCall(
  game: GameState,
  requestId: number,
  accept: boolean,
  actorId: number = game.playerId ?? -1,
): boolean {
  const idx = (game.allyCallRequests || []).findIndex(
    (r) => r.id === requestId && r.targetId === actorId,
  );
  if (idx < 0) return false;
  const request = game.allyCallRequests[idx];
  game.allyCallRequests = game.allyCallRequests.filter((r) => r.id !== requestId);

  const war = warOf(game, request.warId);
  const caller = findPossession(game.world, request.callerId);
  const target = findPossession(game.world, actorId);
  if (!war || !caller || !target) return false;
  const callerSide = warSideOf(war, request.callerId);
  if (!callerSide) return false;

  if (accept) {
    joinWarSide(war, callerSide, actorId);
    adjustOpinion(game.opinions, request.callerId, actorId, 8);
    pushLog(
      game,
      `You answer ${caller.holderName}'s call and join the war against ${
        callerSide === "attacker" ? war.defenderName : war.attackerName
      }.`,
      [request.callerId, actorId],
    );
  } else {
    applyDeclinePenalty(game, actorId, request.callerId);
    pushLog(
      game,
      `You decline ${caller.holderName}'s call to arms (−${formatPrestige(ALLY_CALL_DECLINE_PRESTIGE_COST)} prestige).`,
      [request.callerId, actorId],
    );
  }
  return true;
}

/** Fait vieillir les demandes en attente ; celles trop anciennes sont refusées automatiquement. */
export function tickAllyCallRequests(game: GameState): void {
  if (!game.allyCallRequests?.length) return;
  const kept: AllyCallRequest[] = [];
  for (const request of game.allyCallRequests) {
    request.daysElapsed += 1;
    if (request.daysElapsed < ALLY_CALL_REQUEST_TIMEOUT_DAYS) {
      kept.push(request);
      continue;
    }
    const caller = findPossession(game.world, request.callerId);
    const target = findPossession(game.world, request.targetId);
    if (caller && target) {
      applyDeclinePenalty(game, request.targetId, request.callerId);
      pushLog(
        game,
        `${target.holderName} never answers ${caller.holderName}'s call to arms — the moment passes (−${formatPrestige(ALLY_CALL_DECLINE_PRESTIGE_COST)} prestige).`,
        [request.callerId, request.targetId],
      );
    }
  }
  game.allyCallRequests = kept;
}
