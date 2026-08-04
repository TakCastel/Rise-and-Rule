import {
  claimKingdomTitle,
  claimProvinceTitle,
  declareRebellion,
  declareWar,
  demandAllegiance,
  grantDomain,
  isInvolvedInWar,
  pickDomainToGrant,
  previewAction,
  previewFabricateDomainClaim,
  previewGift,
  previewGrantDomain,
  requestAlliance,
  sendGift,
  startFabricateDomainClaim,
  type ActionKind,
} from "./actions";
import {
  ALLIANCE_OPINION_MIN,
  allyTroopContribution,
  allianceRangeTargets,
  getChildrenTokens,
  listAlliedBlocThreats,
} from "./alliance";
import { demesneOverage } from "./demesne";
import {
  getGold,
  getPrestige,
  possessionIncomeBreakdown,
} from "./economy";
import { ALLEGIANCE_OPINION_MIN, getOpinion } from "./opinion";
import { possessionPower, powerRatio } from "./power";
import {
  canUsurpKingdomTitle,
  canUsurpProvinceTitle,
  findWarGoal,
  kingdomTitleGoldCost,
  kingdomTitlePrestigeGain,
  listKingdomWarTargets,
  listProvinceWarTargets,
  provinceTitleGoldCost,
  provinceTitlePrestigeGain,
} from "./titles";
import type { GameState } from "./types";
import type { Possession } from "../types/world";
import { findPossession, resolveWarDefender } from "./war";

/** Fréquence des tours IA (1 = chaque jour). */
export const AI_DAY_INTERVAL = 1;

/** Actions IA max par jour (acteurs distincts). */
export const AI_MAX_ACTIONS_PER_TICK = 4;

/** Combien d’acteurs sont évalués chaque jour. */
export const AI_WAKE_COUNT = 14;

/** Chance de passer son tour (0–1). */
export const AI_SKIP_CHANCE = 0.22;

/** Ratio de force mini pour qu’une IA déclare la guerre (avec alliés). */
/** En dessous (ou à égalité) de ce ratio de puissance, jamais d'attaque — l'IA ne se lance pas contre un défenseur égal ou plus fort. */
export const AI_WAR_MIN_RATIO = 1;
/** Ratio à partir duquel la chance d'attaque plafonne (avantage écrasant). */
export const AI_WAR_FAVORABLE_RATIO = 2.5;
/** Chance d'attaque max, même avec un avantage écrasant — jamais une certitude à 100%. */
export const AI_WAR_MAX_CHANCE = 0.85;

/** Opinion max (vassal→seigneur) pour envisager une rébellion. */
export const AI_REBEL_OPINION_MAX = 8;

/** Ratio mini pour qu’un vassal se rebelle. */
export const AI_REBEL_POWER_RATIO = 0.8;

/** Score mini pour exécuter un plan. */
export const AI_MIN_SCORE = 40;

export interface AiPlan {
  actorId: number;
  targetId: number;
  kind:
    | ActionKind
    | "grant"
    | "gift"
    | "claim_province"
    | "claim_kingdom"
    | "fabricate_claim";
  score: number;
  /** Pour grant : id du domaine. */
  domainId?: number;
  /** Pour grant : vassal existant, sinon nouveau comte. */
  vassalId?: number | null;
  /** Pour claim_province : id province. */
  provinceId?: number;
  /** Pour claim_kingdom : id royaume. */
  royaumeId?: number;
}

function dayIndex(game: GameState): number {
  return game.year * 360 + game.month * 30 + game.day;
}

function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Force de campagne = demesne/vassaux + alliés. */
function campaignPower(game: GameState, p: Possession): number {
  return (
    possessionPower(game.world, p, game.opinions) +
    allyTroopContribution(game.world, p, game.opinions, game.alliances)
  );
}

function campaignRatio(
  game: GameState,
  attacker: Possession,
  defender: Possession,
): number {
  return powerRatio(campaignPower(game, attacker), campaignPower(game, defender));
}

/**
 * Acteurs IA : rois / chefs indépendants, plus des vassaux (guerres frères / rébellions).
 * Pas le joueur.
 */
export function listAiActors(game: GameState): Possession[] {
  return (game.world.possessions || []).filter((p) => {
    if (p.id === game.playerId) return false;
    if (p.liegeId == null) {
      return p.rank === "king" || p.rank === "chief";
    }
    return (
      p.rank === "vassal" ||
      p.rank === "subvassal" ||
      (p.vassalIds && p.vassalIds.length > 0)
    );
  });
}

function considerGift(
  game: GameState,
  actor: Possession,
  target: Possession,
  purpose: "allegiance" | "alliance" | "appease",
): AiPlan | null {
  const gift = previewGift(game, target.id, actor.id);
  if (!gift?.ok) return null;

  const after = gift.opinion + gift.opinionGain;
  let score = 0;

  if (purpose === "allegiance") {
    if (gift.opinion >= ALLEGIANCE_OPINION_MIN) return null;
    if (after < ALLEGIANCE_OPINION_MIN) return null;
    // Cadeau qui débloque une allégeance autrement OK (sauf opinion)
    const alleg = previewAction(game, target.id, "allegiance", actor.id);
    if (!alleg || alleg.gates?.opinionOk) return null;
    if (!alleg.gates?.neighborOk || !alleg.gates?.powerOk || !alleg.gates?.prestigeOk) {
      return null;
    }
    score = 115 + alleg.ratio * 10;
  } else if (purpose === "alliance") {
    if (gift.opinion >= ALLIANCE_OPINION_MIN) return null;
    if (after < ALLIANCE_OPINION_MIN) return null;
    if (getChildrenTokens(actor) < 1) return null;
    const alli = previewAction(game, target.id, "alliance", actor.id);
    if (!alli || alli.ok || alli.gates?.opinionOk) return null;
    if (!alli.gates?.rangeOk || !alli.gates?.childOk || !alli.gates?.notAlliedOk) {
      return null;
    }
    score = 95 + targetPowerBonus(game, target);
  } else {
    // Apaiser un vassal menaçant / peu loyal
    if (target.liegeId !== actor.id) return null;
    if (gift.opinion >= 40) return null;
    score = 88 + (40 - gift.opinion) * 0.8;
  }

  // Ne pas se ruiner
  if (gift.playerGold - gift.gold < 10) score -= 25;
  if (score < AI_MIN_SCORE) return null;

  return {
    actorId: actor.id,
    targetId: target.id,
    kind: "gift",
    score: score + hash01(actor.id * 3.1 + target.id + dayIndex(game)) * 6,
  };
}

function targetPowerBonus(game: GameState, target: Possession): number {
  return campaignPower(game, target) * 0.002;
}

function scorePlan(
  game: GameState,
  actor: Possession,
  targetId: number,
  kind: ActionKind,
): AiPlan | null {
  const target = findPossession(game.world, targetId);
  if (!target) return null;

  if (kind === "war") {
    // Dette : levées écrasées — pas de guerre offensive
    if (getGold(actor) < 0) return null;

    const defender = resolveWarDefender(game.world, actor, target);
    const preview = previewAction(game, target.id, "war", actor.id);
    if (!preview?.ok) return null;

    const ratio = campaignRatio(game, actor, defender);
    // Jamais d'attaque si le défenseur est à égalité ou plus fort. Au-delà,
    // décision probabiliste (rejouée chaque jour via le hash daté) plutôt
    // qu'un seuil strict — plus l'avantage est écrasant, plus l'attaque est
    // probable, mais jamais garantie.
    if (ratio <= AI_WAR_MIN_RATIO) return null;
    const attackChance =
      Math.min(1, (ratio - AI_WAR_MIN_RATIO) / (AI_WAR_FAVORABLE_RATIO - AI_WAR_MIN_RATIO)) *
      AI_WAR_MAX_CHANCE;
    const attackRoll = hash01(actor.id * 7.3 + defender.id * 5.1 + dayIndex(game) * 1.7 + 41);
    if (attackRoll >= attackChance) return null;

    const opinion = getOpinion(game.opinions, defender.id, actor.id);
    if (opinion > 50) return null;

    let siblingBonus = 0;
    if (
      actor.liegeId != null &&
      target.liegeId != null &&
      actor.liegeId === target.liegeId
    ) {
      siblingBonus = 18;
    }

    // Préfère cibler directement le suzerain quand c’est un redirect
    const redirectBonus = defender.id !== target.id ? 4 : 0;

    // Bonus fort si on presse un titre / claim de province (ou claim de domaine)
    const warGoal = findWarGoal(
      game.world,
      game.titles || [],
      actor,
      defender,
    );
    let claimBonus = 0;
    if (warGoal) {
      claimBonus =
        warGoal.kind === "province"
          ? 55 + warGoal.domainIds.length * 8
          : 28 + warGoal.domainIds.length * 6;
    }

    return {
      actorId: actor.id,
      targetId: defender.id,
      kind: "war",
      score:
        40 +
        ratio * 22 -
        opinion * 0.35 +
        siblingBonus +
        redirectBonus +
        claimBonus +
        hash01(actor.id * 9.1 + defender.id * 3.7 + dayIndex(game)) * 12,
    };
  }

  const preview = previewAction(game, targetId, kind, actor.id);
  if (!preview?.ok) return null;

  if (kind === "allegiance") {
    if (actor.liegeId != null) return null;
    // Priorise les cibles fortes (prestige bien investi)
    const prestigeLeft = getPrestige(actor) - (preview.prestigeCost ?? 0);
    let score =
      120 +
      preview.ratio * 15 +
      preview.opinion * 0.2 +
      preview.targetPower * 0.0015;
    if (prestigeLeft < 10) score -= 15;
    return {
      actorId: actor.id,
      targetId,
      kind,
      score,
    };
  }

  if (kind === "alliance") {
    let score = 50 + preview.opinion * 0.6;
    if (
      actor.liegeId != null &&
      target.liegeId != null &&
      actor.liegeId === target.liegeId
    ) {
      // Co-vassaux : seulement si le seigneur est déjà détesté (sinon nourrit les blocs)
      const ofLiege = getOpinion(game.opinions, actor.id, actor.liegeId);
      score += ofLiege <= AI_REBEL_OPINION_MAX ? 28 : 6;
    } else if (actor.liegeId == null) {
      score += targetPowerBonus(game, target);
      // Bonus si l’allié borde un voisin dangereux
      for (const nid of actor.neighbors || []) {
        const foe = findPossession(game.world, nid);
        if (!foe || foe.id === target.id) continue;
        if ((target.neighbors || []).includes(nid)) {
          const foePower = campaignPower(game, foe);
          if (foePower > campaignPower(game, actor) * 0.7) score += 18;
        }
      }
    } else {
      score -= 10;
    }
    return {
      actorId: actor.id,
      targetId,
      kind,
      score: score + hash01(actor.id * 7.1 + targetId + dayIndex(game)) * 8,
    };
  }

  if (kind === "depose" || kind === "independence") {
    const ratio = campaignRatio(game, actor, target);
    if (preview.opinion > AI_REBEL_OPINION_MAX) return null;
    if (ratio < AI_REBEL_POWER_RATIO) return null;
    const base = kind === "depose" ? 70 : 55;
    return {
      actorId: actor.id,
      targetId,
      kind,
      score:
        base +
        ratio * 28 -
        preview.opinion * 0.8 +
        hash01(actor.id * 5.3 + targetId + dayIndex(game)) * 10,
    };
  }

  return null;
}

function pickGrantPlan(game: GameState, actor: Possession): AiPlan | null {
  const over = demesneOverage(actor);
  const income = possessionIncomeBreakdown(game.world, actor);
  const inDebt = getGold(actor) < 0;
  const deficit = income.net < 0;

  // Grant si overage, ou dette / déficit pour soulager l’économie
  if (over <= 0 && !inDebt && !deficit) return null;

  const domainId = pickDomainToGrant(game, actor.id);
  // pickDomainToGrant exige overage — si dette sans overage, tenter le domaine le moins rentable
  let grantId = domainId;
  if (grantId == null && (inDebt || deficit) && (actor.domaines || []).length > 1) {
    let worst: { id: number; income: number } | null = null;
    for (const id of actor.domaines) {
      const d =
        game.world.domaines.find((x) => x.id === id) ?? game.world.domaines[id];
      if (!d) continue;
      const row = income.domains.find((x) => x.id === id);
      const inc = row?.income ?? 0;
      if (!worst || inc < worst.income) worst = { id, income: inc };
    }
    if (worst && previewGrantDomain(game, worst.id, null, actor.id)?.ok) {
      grantId = worst.id;
    }
  }
  if (grantId == null) return null;

  // Préfère un vassal loyal existant
  let vassalId: number | null = null;
  let bestOp = -Infinity;
  for (const vid of actor.vassalIds || []) {
    const g = previewGrantDomain(game, grantId, vid, actor.id);
    if (!g?.ok) continue;
    const op = getOpinion(game.opinions, vid, actor.id);
    if (op > bestOp) {
      bestOp = op;
      vassalId = vid;
    }
  }

  const score =
    200 +
    over * 40 +
    (inDebt ? 50 : 0) +
    (deficit ? 30 : 0) +
    (vassalId != null ? 8 : 0);

  return {
    actorId: actor.id,
    targetId: actor.id,
    kind: "grant",
    domainId: grantId,
    vassalId,
    score,
  };
}

/**
 * Choisit au plus une action pour un acteur.
 * Ne mute pas l’état.
 */
export function planAiForActor(game: GameState, actor: Possession): AiPlan | null {
  if (isInvolvedInWar(game, actor.id)) return null;

  const grant = pickGrantPlan(game, actor);
  if (grant && demesneOverage(actor) > 0) return grant;

  if (hash01(actor.id * 4.4 + dayIndex(game) * 1.7) < AI_SKIP_CHANCE) {
    // Même en skip : demesne critique ou dette grave
    if (grant && (demesneOverage(actor) > 2 || getGold(actor) < -20)) return grant;
    return null;
  }

  let best: AiPlan | null = grant;

  // Suzerain : apaiser vassaux d’un bloc menaçant
  if ((actor.vassalIds || []).length >= 2) {
    const busy = new Set<number>();
    for (const w of game.wars) {
      busy.add(w.attackerId);
      busy.add(w.defenderId);
    }
    const threats = listAlliedBlocThreats(game, busy).filter(
      (t) => t.liegeId === actor.id,
    );
    for (const t of threats) {
      for (const vid of t.blocIds) {
        const v = findPossession(game.world, vid);
        if (!v) continue;
        const gift = considerGift(game, actor, v, "appease");
        if (gift && (!best || gift.score > best.score)) best = gift;
      }
    }
  }

  // Rébellion contre le seigneur
  if (actor.liegeId != null) {
    const opinionOfLiege = getOpinion(game.opinions, actor.id, actor.liegeId);
    if (opinionOfLiege <= AI_REBEL_OPINION_MAX) {
      for (const kind of ["depose", "independence"] as ActionKind[]) {
        const plan = scorePlan(game, actor, actor.liegeId, kind);
        if (!plan) continue;
        if (!best || plan.score > best.score) best = plan;
      }
    }
  }

  const neighborIds = actor.neighbors || [];
  const warTargetsSeen = new Set<number>();

  // Cadeaux / alliances / allégeance / guerres
  if (getChildrenTokens(actor) > 0 || getGold(actor) > 20) {
    for (const { id: nid } of allianceRangeTargets(game.world, actor.id)) {
      const target = findPossession(game.world, nid);
      if (!target) continue;

      if (getChildrenTokens(actor) > 0) {
        const gift = considerGift(game, actor, target, "alliance");
        if (gift && (!best || gift.score > best.score)) best = gift;

        const plan = scorePlan(game, actor, nid, "alliance");
        if (plan && (!best || plan.score > best.score)) best = plan;
      }
    }
  }

  for (const nid of neighborIds) {
    const target = findPossession(game.world, nid);
    if (!target) continue;
    if (target.liegeId === actor.id) continue;

    if (actor.liegeId == null) {
      const gift = considerGift(game, actor, target, "allegiance");
      if (gift && (!best || gift.score > best.score)) best = gift;

      const alleg = scorePlan(game, actor, nid, "allegiance");
      if (alleg && (!best || alleg.score > best.score)) best = alleg;
    }

    // Dédup protection féodale : une seule entrée par suzerain
    const defender = resolveWarDefender(game.world, actor, target);
    if (warTargetsSeen.has(defender.id)) continue;
    warTargetsSeen.add(defender.id);

    const war = scorePlan(game, actor, nid, "war");
    if (war && (!best || war.score > best.score)) best = war;
  }

  // Usurper des titres de province si contrôle > 2/3
  for (const prov of game.world.provinces || []) {
    const check = canUsurpProvinceTitle(
      game.world,
      game.titles || [],
      actor,
      prov.id,
    );
    if (!check.ok || !check.title) continue;
    const goldCost = provinceTitleGoldCost(check.control);
    if (getGold(actor) < goldCost) continue;
    const score =
      110 +
      check.control.ratio * 50 +
      provinceTitlePrestigeGain(check.control) * 0.4 -
      goldCost * 0.12 +
      hash01(actor.id * 5.3 + prov.id + dayIndex(game)) * 10;
    if (!best || score > best.score) {
      best = {
        actorId: actor.id,
        targetId: actor.id,
        kind: "claim_province",
        provinceId: prov.id,
        score,
      };
    }
  }

  // Usurper/créer un titre de royaume si contrôle > 4/5
  for (const roy of game.world.royaumes || []) {
    const check = canUsurpKingdomTitle(
      game.world,
      game.titles || [],
      actor,
      roy.id,
    );
    if (!check.ok) continue;
    const goldCost = kingdomTitleGoldCost(check.control);
    if (getGold(actor) < goldCost) continue;
    const score =
      140 +
      check.control.ratio * 50 +
      kingdomTitlePrestigeGain(check.control) * 0.4 -
      goldCost * 0.12 +
      hash01(actor.id * 6.1 + roy.id + dayIndex(game)) * 10;
    if (!best || score > best.score) {
      best = {
        actorId: actor.id,
        targetId: actor.id,
        kind: "claim_kingdom",
        royaumeId: roy.id,
        score,
      };
    }
  }

  // Presse explicitement les claims / titres de province (voisins)
  for (const target of listProvinceWarTargets(
    game.world,
    game.titles || [],
    actor,
  )) {
    const war = scorePlan(game, actor, target.defenderId, "war");
    if (war && (!best || war.score > best.score)) best = war;
  }

  // Presse explicitement les claims / titres de royaume (voisins)
  for (const target of listKingdomWarTargets(
    game.world,
    game.titles || [],
    actor,
  )) {
    const war = scorePlan(game, actor, target.defenderId, "war");
    if (war && (!best || war.score > best.score)) best = war;
  }

  // Fabriquer une claim de domaine frontalier (si assez d’or, pas déjà en cours)
  if (
    getGold(actor) >= 40 &&
    !(game.claimFabrications || []).some((f) => f.actorId === actor.id)
  ) {
    const seen = new Set<number>();
    const candidates: { domainId: number; score: number }[] = [];
    for (const did of actor.domaines || []) {
      const mine =
        game.world.domaines.find((x) => x.id === did) ??
        game.world.domaines[did];
      if (!mine) continue;
      for (const nid of mine.neighbors || []) {
        if (seen.has(nid)) continue;
        seen.add(nid);
        const preview = previewFabricateDomainClaim(game, nid, actor.id);
        if (!preview?.ok) continue;
        candidates.push({
          domainId: nid,
          score:
            55 +
            (80 - preview.goldCost) * 0.25 +
            hash01(actor.id * 4.2 + nid + dayIndex(game)) * 15,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];
    if (top && (!best || top.score > best.score)) {
      best = {
        actorId: actor.id,
        targetId: actor.id,
        kind: "fabricate_claim",
        domainId: top.domainId,
        score: top.score,
      };
    }
  }

  if (!best || best.score < AI_MIN_SCORE) return null;
  return best;
}

/** @deprecated Préférer `planAiDayActions`. */
export function planAiDay(game: GameState): AiPlan | null {
  return planAiDayActions(game)[0] ?? null;
}

/** Planifie jusqu’à `AI_MAX_ACTIONS_PER_TICK` actions (acteurs distincts). */
export function planAiDayActions(game: GameState): AiPlan[] {
  if (game.phase !== "play") return [];
  const idx = dayIndex(game);
  if (idx % AI_DAY_INTERVAL !== 0) return [];

  const actors = listAiActors(game);
  if (!actors.length) return [];

  const start = idx % actors.length;
  const wakeCount = Math.min(AI_WAKE_COUNT, actors.length);
  const ordered: Possession[] = [];
  for (let i = 0; i < wakeCount; i++) {
    ordered.push(actors[(start + i) % actors.length]);
  }
  ordered.sort(
    (a, b) => hash01(a.id + idx * 0.13) - hash01(b.id + idx * 0.13),
  );

  const plans: AiPlan[] = [];
  const busy = new Set<number>();

  for (const actor of ordered) {
    if (plans.length >= AI_MAX_ACTIONS_PER_TICK) break;
    if (busy.has(actor.id)) continue;

    const plan = planAiForActor(game, actor);
    if (!plan) continue;

    plans.push(plan);
    busy.add(plan.actorId);
    if (plan.targetId !== plan.actorId) busy.add(plan.targetId);
  }

  return plans;
}

/** Exécute un plan IA (mute `game`). */
export function executeAiPlan(game: GameState, plan: AiPlan): boolean {
  if (plan.kind === "grant" && plan.domainId != null) {
    return grantDomain(
      game,
      plan.domainId,
      plan.vassalId ?? null,
      plan.actorId,
    );
  }
  if (plan.kind === "gift") {
    return sendGift(game, plan.targetId, plan.actorId);
  }
  if (plan.kind === "allegiance") {
    return demandAllegiance(game, plan.targetId, plan.actorId);
  }
  if (plan.kind === "alliance") {
    return requestAlliance(game, plan.targetId, plan.actorId);
  }
  if (plan.kind === "claim_province" && plan.provinceId != null) {
    return claimProvinceTitle(game, plan.provinceId, plan.actorId);
  }
  if (plan.kind === "claim_kingdom" && plan.royaumeId != null) {
    return claimKingdomTitle(game, plan.royaumeId, plan.actorId);
  }
  if (plan.kind === "fabricate_claim" && plan.domainId != null) {
    return startFabricateDomainClaim(game, plan.domainId, plan.actorId);
  }
  if (plan.kind === "war") {
    return declareWar(game, plan.targetId, plan.actorId);
  }
  if (plan.kind === "depose" || plan.kind === "independence") {
    return declareRebellion(game, plan.kind, plan.actorId);
  }
  return false;
}

/**
 * Tour IA quotidien : planifie puis exécute jusqu’à N actions.
 * @returns true si au moins une action a muté l’état.
 */
export function processAiDay(game: GameState): boolean {
  const plans = planAiDayActions(game);
  let any = false;
  for (const plan of plans) {
    if (executeAiPlan(game, plan)) any = true;
  }
  return any;
}
