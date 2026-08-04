import {
  ALLIANCE_MAX_HOPS,
  ALLIANCE_OPINION_MIN,
  allianceRangeTargets,
  allyTroopContribution,
  areAllied,
  formAlliance,
  getChildrenTokens,
} from "./alliance";
import {
  ALLEGIANCE_OPINION_MIN,
  WAR_DECLARE_NEIGHBOR_MALUS,
  adjustOpinion,
  applyNeighborFearMalus,
  getOpinion,
  opinionKey,
} from "./opinion";
import {
  GIFT_OPINION_GAIN,
  addGold,
  addPrestige,
  allegiancePrestigeCost,
  domainMonthlyIncome,
  formatGold,
  formatPrestige,
  getGold,
  getPrestige,
  giftCostForRank,
  setGold,
  setPrestige,
} from "./economy";
import {
  demesneCount,
  demesneOverage,
  demesnePenaltyPercent,
  DEMESNE_LIMIT,
  provinceOverage,
  PROVINCE_DEMESNE_LIMIT,
} from "./demesne";
import {
  ALLEGIANCE_POWER_RATIO,
  areNeighbors,
  levyCapacity,
  possessionPower,
  powerRatio,
} from "./power";
import type { CasusBelli, GameState } from "./types";
import { pushLog, pushNotice } from "./types";
import {
  canUsurpProvinceTitle,
  canUsurpKingdomTitle,
  canFoundImaginaryKingdom,
  findKingdomTitle,
  findWarGoal,
  kingdomTitleId,
  kingdomTitleName,
  addClaim,
  removeClaim,
  addDomainClaim,
  hasDomainClaim,
  domainClaimGoldCost,
  domainClaimDaysRequired,
  domainClaimPrestigeGain,
  provinceTitleGoldCost,
  provinceTitlePrestigeGain,
  kingdomTitleGoldCost,
  kingdomTitlePrestigeGain,
  fullControlFromDomains,
  isDomainAdjacentToRealm,
  controlsDomain,
  vassalDepth,
  MAX_VASSAL_DEPTH,
} from "./titles";
import {
  activeWarBetween,
  areSameRealm,
  attachAsVassal,
  buildConquestOrder,
  canAttackByRank,
  findPossession,
  isUnderLiege,
  rebuildPossessionNeighbors,
  resolveWarDefender,
  seaLinkedDomainNeighbors,
  transferDomains,
} from "./war";
import type { Possession, Royaume } from "../types/world";

export type ActionKind =
  | "war"
  | "allegiance"
  | "alliance"
  | "depose"
  | "independence";

/** Déjà engagé dans une campagne (attaquant ou défenseur). */
export function isInvolvedInWar(game: GameState, possessionId: number): boolean {
  return game.wars.some(
    (w) => w.attackerId === possessionId || w.defenderId === possessionId,
  );
}

export interface ActionPreview {
  kind: ActionKind;
  ok: boolean;
  reason?: string;
  ratio: number;
  chance: number;
  playerPower: number;
  targetPower: number;
  neighbor: boolean;
  opinion: number;
  /** Guerre redirigée vers le suzerain protecteur. */
  redirectedToId?: number;
  redirectedToName?: string;
  /** Coût prestige (allégeance). */
  prestigeCost?: number;
  /** Jetons enfants requis (alliance). */
  childrenCost?: number;
  /** Distance en hops (alliance). */
  hops?: number;
  /** Guerre de titre. */
  claimTitleId?: string;
  claimProvinceId?: number;
  claimRoyaumeId?: number;
  claimTitleName?: string;
  warGoalDomainIds?: number[];
  /** Détail pour l’UI allégeance / alliance. */
  gates?: {
    opinionOk: boolean;
    neighborOk?: boolean;
    powerOk?: boolean;
    prestigeOk?: boolean;
    childOk?: boolean;
    notAlliedOk?: boolean;
    rangeOk?: boolean;
  };
}

export function previewAction(
  game: GameState,
  targetId: number,
  kind: ActionKind,
  actorId: number = game.playerId ?? -1,
): ActionPreview | null {
  const player = findPossession(game.world, actorId);
  const target = findPossession(game.world, targetId);
  if (!player || !target || player.id === target.id) return null;

  const neighbor = areNeighbors(game.world, player.id, target.id);
  const playerPower = possessionPower(game.world, player, game.opinions);
  const targetPower = possessionPower(game.world, target, game.opinions);
  const ratio = powerRatio(playerPower, targetPower);
  const opinion = getOpinion(game.opinions, target.id, player.id);

  if (kind === "alliance") {
    const opinionOk = opinion >= ALLIANCE_OPINION_MIN;
    const childrenCost = 1;
    const childOk = getChildrenTokens(player) >= childrenCost;
    const notAlliedOk = !areAllied(game.alliances, player.id, target.id);
    const feudalBond =
      target.liegeId === player.id || player.liegeId === target.id;
    const range = allianceRangeTargets(game.world, player.id).find(
      (t) => t.id === target.id,
    );
    const hops = range?.hops;
    const rangeOk = hops != null && hops <= ALLIANCE_MAX_HOPS;
    const gates = { opinionOk, childOk, notAlliedOk, rangeOk };

    if (feudalBond) {
      return {
        kind,
        ok: false,
        reason: "Already bound by fealty — alliances are between peers",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        childrenCost,
        hops,
        gates,
      };
    }
    if (!notAlliedOk) {
      return {
        kind,
        ok: false,
        reason: "Already allied",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        childrenCost,
        hops,
        gates,
      };
    }
    if (!rangeOk) {
      return {
        kind,
        ok: false,
        reason: `Too far (need ≤${ALLIANCE_MAX_HOPS} territories away)`,
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        childrenCost,
        hops,
        gates,
      };
    }
    if (!childOk) {
      return {
        kind,
        ok: false,
        reason: "Need a child to marry into their house",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        childrenCost,
        hops,
        gates,
      };
    }
    if (!opinionOk) {
      return {
        kind,
        ok: false,
        reason: `They dislike you (${opinion}; need ≥${ALLIANCE_OPINION_MIN})`,
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        childrenCost,
        hops,
        gates,
      };
    }
    return {
      kind,
      ok: true,
      ratio,
      chance: 1,
      playerPower,
      targetPower,
      neighbor,
      opinion,
      childrenCost,
      hops,
      gates,
    };
  }

  if (kind === "allegiance") {
    const opinionOk = opinion >= ALLEGIANCE_OPINION_MIN;
    const neighborOk = neighbor;
    const powerOk = ratio >= ALLEGIANCE_POWER_RATIO;
    const prestigeCost = allegiancePrestigeCost(target.rank);
    const prestigeOk = getPrestige(player) >= prestigeCost;
    const gates = { opinionOk, neighborOk, powerOk, prestigeOk };

    if (target.liegeId != null) {
      return {
        kind,
        ok: false,
        reason:
          target.liegeId === player.id
            ? "Already your vassal"
            : "Already sworn to another liege",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        prestigeCost,
        gates,
      };
    }
    if (player.liegeId === target.id) {
      return {
        kind,
        ok: false,
        reason: "They are your liege",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        prestigeCost,
        gates,
      };
    }
    if (!neighborOk) {
      return {
        kind,
        ok: false,
        reason: "Realms are not nearby",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        prestigeCost,
        gates,
      };
    }
    if (!opinionOk) {
      return {
        kind,
        ok: false,
        reason: `Opinion too low (${opinion}; need ≥${ALLEGIANCE_OPINION_MIN})`,
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        prestigeCost,
        gates,
      };
    }
    if (!powerOk) {
      return {
        kind,
        ok: false,
        reason: `Not strong enough (${ratio.toFixed(2)}×; need ≥${ALLEGIANCE_POWER_RATIO}×)`,
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        prestigeCost,
        gates,
      };
    }
    if (!prestigeOk) {
      return {
        kind,
        ok: false,
        reason: `Need ${formatPrestige(prestigeCost)} prestige`,
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion,
        prestigeCost,
        gates,
      };
    }
    return {
      kind,
      ok: true,
      ratio,
      chance: 1,
      playerPower,
      targetPower,
      neighbor,
      opinion,
      prestigeCost,
      gates,
    };
  }

  // Rébellion : déposer ou indépendance — uniquement contre son seigneur
  if (kind === "depose" || kind === "independence") {
    const rebelOpinion = getOpinion(game.opinions, player.id, target.id);
    if (player.liegeId !== target.id) {
      return {
        kind,
        ok: false,
        reason: "Only against your liege",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion: rebelOpinion,
      };
    }
    if (activeWarBetween(game, player.id, target.id)) {
      return {
        kind,
        ok: false,
        reason: "War already underway",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion: rebelOpinion,
      };
    }
    if (isInvolvedInWar(game, player.id)) {
      return {
        kind,
        ok: false,
        reason: "Already at war — finish this campaign first",
        ratio,
        chance: 0,
        playerPower,
        targetPower,
        neighbor,
        opinion: rebelOpinion,
      };
    }
    return {
      kind,
      ok: true,
      ratio,
      chance: 1,
      playerPower,
      targetPower,
      neighbor: true,
      opinion: rebelOpinion,
    };
  }

  // war (claim) — plus de conquête libre : il faut un titre ou une claim
  if (areAllied(game.alliances, player.id, target.id)) {
    return {
      kind,
      ok: false,
      reason: "Allied — cannot attack an ally",
      ratio,
      chance: 0,
      playerPower,
      targetPower,
      neighbor,
      opinion,
    };
  }
  if (activeWarBetween(game, player.id, target.id)) {
    return {
      kind,
      ok: false,
      reason: "War already underway",
      ratio,
      chance: 0,
      playerPower,
      targetPower,
      neighbor,
      opinion,
    };
  }
  // Une seule guerre offensive à la fois — on peut toujours se faire attaquer
  if (isInvolvedInWar(game, player.id)) {
    return {
      kind,
      ok: false,
      reason: "Already at war — finish this campaign first",
      ratio,
      chance: 0,
      playerPower,
      targetPower,
      neighbor,
      opinion,
    };
  }
  if (isUnderLiege(game.world, target, player.id)) {
    return {
      kind,
      ok: false,
      reason: "Already your vassal — you cannot declare war on your own subjects",
      ratio,
      chance: 0,
      playerPower,
      targetPower,
      neighbor,
      opinion,
    };
  }
  if (isUnderLiege(game.world, player, target.id)) {
    return {
      kind,
      ok: false,
      reason: "Same feudal bond — rebel to depose or seek independence",
      ratio,
      chance: 0,
      playerPower,
      targetPower,
      neighbor,
      opinion,
    };
  }
  // Protection féodale : attaquer un vassal étranger = guerre contre son suzerain
  const defender = resolveWarDefender(game.world, player, target);
  // Le suzerain protecteur (défenseur redirigé) peut être un allié même si la cible cliquée ne l'est pas
  if (defender.id !== target.id && areAllied(game.alliances, player.id, defender.id)) {
    return {
      kind,
      ok: false,
      reason: `${defender.holderName} protects them and is your ally`,
      ratio: powerRatio(playerPower, possessionPower(game.world, defender, game.opinions)),
      chance: 0,
      playerPower,
      targetPower: possessionPower(game.world, defender, game.opinions),
      neighbor,
      opinion: getOpinion(game.opinions, defender.id, player.id),
      redirectedToId: defender.id,
      redirectedToName: defender.holderName,
    };
  }
  // Vassaux : pas de guerre hors du realm du suzerain
  if (player.liegeId != null && !areSameRealm(game.world, player, defender)) {
    return {
      kind,
      ok: false,
      reason: "Vassals may only wage war within their liege's realm",
      ratio,
      chance: 0,
      playerPower,
      targetPower,
      neighbor,
      opinion,
    };
  }
  // Vassaux : seulement contre un rang égal ou inférieur
  if (!canAttackByRank(player, defender)) {
    return {
      kind,
      ok: false,
      reason: `Too high a rank — vassals may only war equals or lesser lords${
        defender.id !== target.id ? ` (${defender.holderName} protects them)` : ""
      }`,
      ratio: powerRatio(
        playerPower,
        possessionPower(game.world, defender, game.opinions),
      ),
      chance: 0,
      playerPower,
      targetPower: possessionPower(game.world, defender, game.opinions),
      neighbor,
      opinion: getOpinion(game.opinions, defender.id, player.id),
      redirectedToId: defender.id !== target.id ? defender.id : undefined,
      redirectedToName:
        defender.id !== target.id ? defender.holderName : undefined,
    };
  }

  const warGoal = findWarGoal(
    game.world,
    game.titles || [],
    player,
    defender,
  );
  if (!warGoal) {
    return {
      kind,
      ok: false,
      reason:
        "No claim — fabricate a domain claim, or hold a province title",
      ratio,
      chance: 0,
      playerPower,
      targetPower: possessionPower(game.world, defender, game.opinions),
      neighbor,
      opinion: getOpinion(game.opinions, defender.id, player.id),
      redirectedToId: defender.id !== target.id ? defender.id : undefined,
      redirectedToName:
        defender.id !== target.id ? defender.holderName : undefined,
    };
  }

  const realmNeighbor =
    neighbor || areNeighbors(game.world, player.id, defender.id);
  if (!realmNeighbor) {
    return {
      kind,
      ok: false,
      reason: "Not a neighbor",
      ratio: powerRatio(
        playerPower,
        possessionPower(game.world, defender, game.opinions),
      ),
      chance: 0,
      playerPower,
      targetPower: possessionPower(game.world, defender, game.opinions),
      neighbor: false,
      opinion: getOpinion(game.opinions, defender.id, player.id),
      claimTitleId: warGoal.claimTitleId,
      claimProvinceId: warGoal.claimProvinceId,
      claimRoyaumeId: warGoal.claimRoyaumeId,
      claimTitleName: warGoal.label,
      warGoalDomainIds: warGoal.domainIds,
      redirectedToId: defender.id !== target.id ? defender.id : undefined,
      redirectedToName:
        defender.id !== target.id ? defender.holderName : undefined,
    };
  }

  const defPower = possessionPower(game.world, defender, game.opinions);
  return {
    kind,
    ok: true,
    ratio: powerRatio(playerPower, defPower),
    chance: 1,
    playerPower,
    targetPower: defPower,
    neighbor: true,
    opinion: getOpinion(game.opinions, defender.id, player.id),
    claimTitleId: warGoal.claimTitleId,
    claimProvinceId: warGoal.claimProvinceId,
    claimRoyaumeId: warGoal.claimRoyaumeId,
    claimTitleName: warGoal.label,
    warGoalDomainIds: warGoal.domainIds,
    redirectedToId: defender.id !== target.id ? defender.id : undefined,
    redirectedToName:
      defender.id !== target.id ? defender.holderName : undefined,
  };
}

/** Demande d’allégeance — refus si opinion / voisinage / force insuffisants. */
export function demandAllegiance(
  game: GameState,
  targetId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const preview = previewAction(game, targetId, "allegiance", actorId);
  if (!preview) return false;
  const player = findPossession(game.world, actorId);
  const target = findPossession(game.world, targetId);
  if (!player || !target) return false;

  if (!preview.ok) {
    pushLog(
      game,
      `${target.holderName} refuses allegiance to ${player.holderName}: ${preview.reason}.`,
      [player.id, target.id],
    );
    adjustOpinion(game.opinions, target.id, player.id, -8);
    adjustOpinion(game.opinions, player.id, target.id, -5);
    return false;
  }

  const cost = preview.prestigeCost ?? allegiancePrestigeCost(target.rank);
  addPrestige(player, -cost);

  attachAsVassal(game.world, target, player);

  adjustOpinion(game.opinions, target.id, player.id, 28);
  adjustOpinion(game.opinions, player.id, target.id, 16);

  rebuildPossessionNeighbors(game.world);
  pushLog(
    game,
    `${target.holderName} swears allegiance to ${player.holderName} (−${formatPrestige(cost)} prestige, opinion ${preview.opinion}, ${preview.ratio.toFixed(2)}× strength).`,
    [player.id, target.id],
  );
  return true;
}

/**
 * Demande d’alliance par mariage : consomme 1 enfant si acceptée.
 * Refus si opinion trop basse (ils te détestent).
 */
export function requestAlliance(
  game: GameState,
  targetId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const preview = previewAction(game, targetId, "alliance", actorId);
  if (!preview) return false;
  const player = findPossession(game.world, actorId);
  const target = findPossession(game.world, targetId);
  if (!player || !target) return false;

  if (!preview.ok) {
    pushLog(
      game,
      `${target.holderName} refuses a marriage alliance with ${player.holderName}: ${preview.reason}.`,
      [player.id, target.id],
    );
    if (preview.gates && !preview.gates.opinionOk) {
      adjustOpinion(game.opinions, target.id, player.id, -6);
      adjustOpinion(game.opinions, player.id, target.id, -4);
    }
    return false;
  }

  player.childrenTokens = getChildrenTokens(player) - 1;
  formAlliance(game, player.id, target.id);
  adjustOpinion(game.opinions, target.id, player.id, 32);
  adjustOpinion(game.opinions, player.id, target.id, 24);

  pushLog(
    game,
    `${player.holderName} seals a marriage alliance with ${target.holderName}. They will join each other's wars.`,
    [player.id, target.id],
  );
  return true;
}

function startCampaign(
  game: GameState,
  attacker: Possession,
  defender: Possession,
  casusBelli: CasusBelli,
  label: string,
  claim?: {
    titleId?: string;
    provinceId?: number;
    royaumeId?: number;
    domainIds?: number[];
    titleName?: string;
  },
): void {
  const claimNote =
    claim?.titleName != null
      ? ` for ${claim.titleName}`
      : claim?.domainIds?.length
        ? ` (${claim.domainIds.length} domains)`
        : "";

  game.wars = [
    ...game.wars,
    {
      id: game.nextWarId++,
      attackerId: attacker.id,
      defenderId: defender.id,
      attackerName: attacker.holderName,
      defenderName: defender.holderName,
      conquestOrder: buildConquestOrder(game.world, attacker, defender),
      attackerFrontOrder: buildConquestOrder(game.world, defender, attacker),
      capturedByAttacker: [],
      capturedByDefender: [],
      casusBelli,
      claimTitleId: claim?.titleId,
      claimProvinceId: claim?.provinceId,
      claimRoyaumeId: claim?.royaumeId,
      warGoalDomainIds: claim?.domainIds ? [...claim.domainIds] : undefined,
    },
  ];

  adjustOpinion(game.opinions, defender.id, attacker.id, -40);
  adjustOpinion(game.opinions, attacker.id, defender.id, -25);

  const theater = claim?.domainIds?.length
    ? claim.domainIds
    : [...defender.domaines, ...attacker.domaines];
  applyNeighborFearMalus(
    game,
    attacker.id,
    theater,
    [attacker.id, defender.id],
    WAR_DECLARE_NEIGHBOR_MALUS,
  );

  pushLog(
    game,
    `${label}${claimNote}. Muster your levies to begin the campaign.`,
    [attacker.id, defender.id],
  );

  if (defender.id === game.playerId && attacker.id !== game.playerId) {
    pushNotice(game, `${label}${claimNote}.`, { title: "War declared upon you" });
  }
}

/**
 * Déclare la guerre : campagne bornée à un claim de province.
 */
export function declareWar(
  game: GameState,
  targetId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const preview = previewAction(game, targetId, "war", actorId);
  if (!preview || !preview.ok) {
    if (preview?.reason) {
      const player = findPossession(game.world, actorId);
      const target = findPossession(game.world, targetId);
      if (player && target && actorId === game.playerId) {
        pushLog(game, `Cannot declare war on ${target.holderName}: ${preview.reason}.`);
      }
    }
    return false;
  }

  const player = findPossession(game.world, actorId)!;
  const target = findPossession(game.world, targetId)!;
  const defender = resolveWarDefender(game.world, player, target);

  const label =
    defender.id !== target.id
      ? `${player.holderName} declares war on ${defender.holderName} (defending ${target.holderName})`
      : `${player.holderName} declares war on ${target.holderName}`;

  startCampaign(game, player, defender, "claim_province", label, {
    titleId: preview.claimTitleId,
    provinceId: preview.claimProvinceId,
    royaumeId: preview.claimRoyaumeId,
    domainIds: preview.warGoalDomainIds,
    titleName: preview.claimTitleName,
  });
  return true;
}

/**
 * Usurpe un titre de province si l’acteur contrôle >2/3 des domaines.
 * Coûte de l’or, rapporte du prestige ; l’ancien titulaire reçoit une claim.
 */
export function claimProvinceTitle(
  game: GameState,
  provinceId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const actor = findPossession(game.world, actorId);
  if (!actor) return false;
  if (!game.titles) game.titles = [];

  const check = canUsurpProvinceTitle(
    game.world,
    game.titles,
    actor,
    provinceId,
  );
  if (!check.ok || !check.title) {
    if (actorId === game.playerId && check.reason) {
      pushLog(game, `Cannot claim province: ${check.reason}.`);
    }
    return false;
  }

  const goldCost = provinceTitleGoldCost(check.control);
  const prestigeGain = provinceTitlePrestigeGain(check.control);
  if (getGold(actor) < goldCost) {
    if (actorId === game.playerId) {
      pushLog(
        game,
        `Cannot claim province: need ${formatGold(goldCost)} gold.`,
      );
    }
    return false;
  }

  addGold(actor, -goldCost);
  addPrestige(actor, prestigeGain);

  const title = check.title;
  const prevHolderId = title.holderId;
  if (prevHolderId != null && prevHolderId !== actor.id) {
    const prev = findPossession(game.world, prevHolderId);
    if (prev) addClaim(prev, title.id, game.year);
  }
  title.holderId = actor.id;
  removeClaim(actor, title.id);

  pushLog(
    game,
    prevHolderId != null && prevHolderId !== actor.id
      ? `${actor.holderName} usurps ${title.name} (−${formatGold(goldCost)} gold, +${formatPrestige(prestigeGain)} prestige).`
      : `${actor.holderName} claims ${title.name} (−${formatGold(goldCost)} gold, +${formatPrestige(prestigeGain)} prestige).`,
    prevHolderId != null ? [actor.id, prevHolderId] : [actor.id],
  );
  return true;
}

/**
 * Usurpe/crée un titre de royaume si l’acteur contrôle >4/5 des domaines.
 * Contrairement aux provinces, aucun titre de royaume n’existe au lancement
 * de la partie — le premier claim réussi le crée.
 */
export function claimKingdomTitle(
  game: GameState,
  royaumeId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const actor = findPossession(game.world, actorId);
  if (!actor) return false;
  if (!game.titles) game.titles = [];

  const check = canUsurpKingdomTitle(
    game.world,
    game.titles,
    actor,
    royaumeId,
  );
  if (!check.ok) {
    if (actorId === game.playerId && check.reason) {
      pushLog(game, `Cannot claim kingdom: ${check.reason}.`);
    }
    return false;
  }

  const goldCost = kingdomTitleGoldCost(check.control);
  const prestigeGain = kingdomTitlePrestigeGain(check.control);
  if (getGold(actor) < goldCost) {
    if (actorId === game.playerId) {
      pushLog(game, `Cannot claim kingdom: need ${formatGold(goldCost)} gold.`);
    }
    return false;
  }

  addGold(actor, -goldCost);
  addPrestige(actor, prestigeGain);

  let title = check.title;
  const prevHolderId = title?.holderId;
  if (!title) {
    const roy = (game.world.royaumes || []).find((r) => r.id === royaumeId);
    title = {
      id: kingdomTitleId(royaumeId),
      tier: "kingdom",
      deJureId: royaumeId,
      name: roy ? kingdomTitleName(roy) : `Kingdom ${royaumeId}`,
      holderId: actor.id,
    };
    game.titles.push(title);
  } else {
    if (prevHolderId != null && prevHolderId !== actor.id) {
      const prev = findPossession(game.world, prevHolderId);
      if (prev) addClaim(prev, title.id, game.year);
    }
    title.holderId = actor.id;
  }
  removeClaim(actor, title.id);

  pushLog(
    game,
    prevHolderId != null && prevHolderId !== actor.id
      ? `${actor.holderName} usurps ${title.name} (−${formatGold(goldCost)} gold, +${formatPrestige(prestigeGain)} prestige).`
      : `${actor.holderName} claims ${title.name} (−${formatGold(goldCost)} gold, +${formatPrestige(prestigeGain)} prestige).`,
    prevHolderId != null ? [actor.id, prevHolderId] : [actor.id],
  );
  return true;
}

/** Renomme un royaume — réservé au détenteur du titre (ou, sans titre encore formé, au roi qui le contrôle). */
export function renameKingdom(
  game: GameState,
  royaumeId: number,
  newName: string,
  actorId: number = game.playerId ?? -1,
): boolean {
  const trimmed = newName.trim().slice(0, 40);
  if (!trimmed) return false;
  const actor = findPossession(game.world, actorId);
  if (!actor) return false;
  const roy = (game.world.royaumes || []).find((r) => r.id === royaumeId);
  if (!roy) return false;

  const title = findKingdomTitle(game.titles || [], royaumeId);
  const allowed =
    title != null
      ? title.holderId === actor.id
      : actor.rank === "king" && actor.royaumeId === royaumeId;
  if (!allowed) return false;
  if (roy.name === trimmed) return false;

  const oldName = roy.name;
  roy.name = trimmed;
  if (title) title.name = trimmed;
  if (actor.royaumeId === royaumeId) actor.name = trimmed;

  pushLog(game, `${actor.holderName} renames the kingdom of ${oldName} to ${trimmed}.`, [actor.id]);
  return true;
}

/**
 * Fonde un royaume imaginaire sur 3 provinces détenues et connectées.
 * Casse volontairement la carte de jure : les provinces restent listées dans
 * leur royaume d’origine — le drift qui les « vole » ne se résout que 10 ans
 * plus tard (`tickKingdomDrifts`).
 */
export function foundImaginaryKingdom(
  game: GameState,
  seedProvinceId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const actor = findPossession(game.world, actorId);
  if (!actor) return false;
  if (!game.titles) game.titles = [];
  if (!game.kingdomDrifts) game.kingdomDrifts = [];

  const check = canFoundImaginaryKingdom(
    game.world,
    game.titles,
    actor,
    seedProvinceId,
  );
  if (!check.ok || !check.provinceIds || !check.domainIds) {
    if (actorId === game.playerId && check.reason) {
      pushLog(game, `Cannot found a kingdom: ${check.reason}.`);
    }
    return false;
  }

  const foundControl = fullControlFromDomains(check.domainIds);
  const goldCost = kingdomTitleGoldCost(foundControl);
  const prestigeGain = kingdomTitlePrestigeGain(foundControl);
  if (getGold(actor) < goldCost) {
    if (actorId === game.playerId) {
      pushLog(game, `Cannot found a kingdom: need ${formatGold(goldCost)} gold.`);
    }
    return false;
  }

  addGold(actor, -goldCost);
  addPrestige(actor, prestigeGain);

  const seedProvince = (game.world.provinces || []).find(
    (p) => p.id === seedProvinceId,
  )!;
  const royaumes = game.world.royaumes || [];
  const newId = royaumes.length
    ? Math.max(...royaumes.map((r) => r.id)) + 1
    : 0;
  const centroids = check.provinceIds
    .map((pid) => (game.world.provinces || []).find((p) => p.id === pid)?.centroid)
    .filter((c): c is [number, number] => !!c);
  const centroid: [number, number] = centroids.length
    ? [
        centroids.reduce((s, c) => s + c[0], 0) / centroids.length,
        centroids.reduce((s, c) => s + c[1], 0) / centroids.length,
      ]
    : seedProvince.centroid;

  const newRoyaume: Royaume = {
    id: newId,
    name: seedProvince.name,
    code: seedProvince.code,
    centroid,
    domaines: [...check.domainIds],
    provinces: [...check.provinceIds],
    neighbors: [],
  };
  game.world.royaumes = [...royaumes, newRoyaume];

  game.titles.push({
    id: kingdomTitleId(newId),
    tier: "kingdom",
    deJureId: newId,
    name: kingdomTitleName(newRoyaume),
    holderId: actor.id,
  });

  // Fondation = geste politique immédiat, pas spéculatif : les provinces
  // fondatrices rejoignent le nouveau royaume de jure sur-le-champ, quitte à
  // les retirer de leur royaume d’origine. Le drift (`kingdomDrifts`) reste
  // réservé aux provinces conquises *après coup*, qui doivent d’abord faire
  // leurs preuves avant de basculer (voir `scheduleProvinceDrift` dans war.ts).
  for (const provinceId of check.provinceIds) {
    const province = (game.world.provinces || []).find((p) => p.id === provinceId);
    if (!province) continue;
    if (province.royaumeId !== newId) {
      const oldRoy = (game.world.royaumes || []).find((r) => r.id === province.royaumeId);
      if (oldRoy) {
        oldRoy.provinces = (oldRoy.provinces || []).filter((id) => id !== provinceId);
        const stolenDomainIds = new Set(province.domaines);
        oldRoy.domaines = oldRoy.domaines.filter((id) => !stolenDomainIds.has(id));
      }
    }
    province.royaumeId = newId;
    for (const did of province.domaines) {
      const d = game.world.domaines.find((x) => x.id === did) ?? game.world.domaines[did];
      if (d) d.royaumeId = newId;
    }
  }

  pushLog(
    game,
    `${actor.holderName} founds the kingdom of ${newRoyaume.name} from ${check.provinceIds.length} provinces (−${formatGold(goldCost)} gold, +${formatPrestige(prestigeGain)} prestige).`,
    [actor.id],
  );
  return true;
}

export interface FabricateClaimPreview {
  ok: boolean;
  reason?: string;
  domainId: number;
  domainName: string;
  goldCost: number;
  daysRequired: number;
  prestigeGain: number;
  holderId?: number;
  holderName?: string;
  /** Guerre irait contre le suzerain. */
  warDefenderName?: string;
}

export function previewFabricateDomainClaim(
  game: GameState,
  domainId: number,
  actorId: number = game.playerId ?? -1,
): FabricateClaimPreview | null {
  const actor = findPossession(game.world, actorId);
  const domain =
    game.world.domaines.find((d) => d.id === domainId) ??
    game.world.domaines[domainId];
  if (!actor || !domain) return null;

  const goldCost = domainClaimGoldCost(domain);
  const daysRequired = domainClaimDaysRequired(domain);
  const prestigeGain = domainClaimPrestigeGain(domain);
  const base: FabricateClaimPreview = {
    ok: false,
    domainId,
    domainName: domain.name,
    goldCost,
    daysRequired,
    prestigeGain,
  };

  if (domain.terrainType === "sea") {
    return { ...base, reason: "Open water cannot be claimed" };
  }
  if (controlsDomain(game.world, actor.id, domain.possessionId)) {
    return { ...base, reason: "You already control this domain" };
  }
  if (hasDomainClaim(actor, domainId)) {
    return { ...base, reason: "You already have a claim on this domain" };
  }
  if ((game.claimFabrications || []).some(
    (f) => f.actorId === actor.id && f.domainId === domainId,
  )) {
    return { ...base, reason: "Already fabricating a claim here" };
  }
  if ((game.claimFabrications || []).some((f) => f.actorId === actor.id)) {
    return { ...base, reason: "Already fabricating another claim" };
  }
  if (!isDomainAdjacentToRealm(game.world, actor.id, domainId)) {
    return { ...base, reason: "Domain is not on your border" };
  }
  if (domain.possessionId == null) {
    return { ...base, reason: "No holder to claim against" };
  }
  const holder = findPossession(game.world, domain.possessionId);
  if (!holder) return { ...base, reason: "No holder to claim against" };
  if (areAllied(game.alliances, actor.id, holder.id)) {
    return {
      ...base,
      reason: "Allied with the holder",
      holderId: holder.id,
      holderName: holder.holderName,
    };
  }
  if (getGold(actor) < goldCost) {
    return {
      ...base,
      reason: `Need ${formatGold(goldCost)} gold`,
      holderId: holder.id,
      holderName: holder.holderName,
    };
  }

  const warDefender = resolveWarDefender(game.world, actor, holder);
  return {
    ...base,
    ok: true,
    holderId: holder.id,
    holderName: holder.holderName,
    warDefenderName:
      warDefender.id !== holder.id ? warDefender.holderName : undefined,
  };
}

/**
 * Lance la fabrication d’une claim sur un domaine voisin (coût or + durée).
 * Une fois prête, autorise une guerre bornée à ce domaine (vs suzerain si vassal).
 */
export function startFabricateDomainClaim(
  game: GameState,
  domainId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const preview = previewFabricateDomainClaim(game, domainId, actorId);
  const actor = findPossession(game.world, actorId);
  if (!preview || !actor) return false;
  if (!preview.ok) {
    if (actorId === game.playerId && preview.reason) {
      pushLog(game, `Cannot claim ${preview.domainName}: ${preview.reason}.`);
    }
    return false;
  }

  addGold(actor, -preview.goldCost);
  if (!game.claimFabrications) game.claimFabrications = [];
  if (game.nextFabricationId == null) game.nextFabricationId = 1;
  game.claimFabrications.push({
    id: game.nextFabricationId++,
    actorId: actor.id,
    domainId,
    daysElapsed: 0,
    daysRequired: preview.daysRequired,
    goldPaid: preview.goldCost,
  });

  const against = preview.warDefenderName
    ? `${preview.holderName} (under ${preview.warDefenderName})`
    : preview.holderName;
  pushLog(
    game,
    `${actor.holderName} begins claiming ${preview.domainName} against ${against} (−${formatGold(preview.goldCost)} gold, ~${preview.daysRequired} days).`,
    preview.holderId != null ? [actor.id, preview.holderId] : [actor.id],
  );
  return true;
}

/**
 * Annule une fabrication en cours et rembourse l’or payé.
 */
export function cancelFabricateDomainClaim(
  game: GameState,
  domainId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const actor = findPossession(game.world, actorId);
  if (!actor || !game.claimFabrications?.length) return false;
  const idx = game.claimFabrications.findIndex(
    (f) => f.actorId === actor.id && f.domainId === domainId,
  );
  if (idx < 0) return false;
  const fab = game.claimFabrications[idx]!;
  const domain =
    game.world.domaines.find((d) => d.id === domainId) ??
    game.world.domaines[domainId];
  addGold(actor, fab.goldPaid);
  game.claimFabrications = game.claimFabrications.filter((_, i) => i !== idx);
  pushLog(
    game,
    `${actor.holderName} cancels the claim on ${domain?.name ?? `domain ${domainId}`} (+${formatGold(fab.goldPaid)} gold refunded).`,
    [actor.id],
  );
  return true;
}

/** Avance les fabrications d’un jour ; complète les claims prêtes. */
export function tickClaimFabrications(game: GameState): void {
  if (!game.claimFabrications?.length) return;
  const done: typeof game.claimFabrications = [];
  const keep: typeof game.claimFabrications = [];

  for (const fab of game.claimFabrications) {
    fab.daysElapsed += 1;
    if (fab.daysElapsed >= fab.daysRequired) done.push(fab);
    else keep.push(fab);
  }
  game.claimFabrications = keep;

  for (const fab of done) {
    const actor = findPossession(game.world, fab.actorId);
    const domain =
      game.world.domaines.find((d) => d.id === fab.domainId) ??
      game.world.domaines[fab.domainId];
    if (!actor || !domain) continue;
    // Toujours valide ?
    if (controlsDomain(game.world, actor.id, domain.possessionId)) continue;
    addDomainClaim(actor, fab.domainId);
    const prestigeGain = domainClaimPrestigeGain(domain);
    addPrestige(actor, prestigeGain);
    const holder =
      domain.possessionId != null
        ? findPossession(game.world, domain.possessionId)
        : undefined;
    pushLog(
      game,
      `${actor.holderName} secures a claim on ${domain.name}${
        holder ? ` (held by ${holder.holderName})` : ""
      } (+${formatPrestige(prestigeGain)} prestige).`,
      holder ? [actor.id, holder.id] : [actor.id],
    );
  }
}

/**
 * Rébellion contre le seigneur : déposer (prendre sa place) ou indépendance.
 */
export function declareRebellion(
  game: GameState,
  mode: "depose" | "independence",
  actorId: number = game.playerId ?? -1,
): boolean {
  const player = findPossession(game.world, actorId);
  if (!player || player.liegeId == null) {
    if (actorId === game.playerId) {
      pushLog(game, `You have no liege to rebel against.`);
    }
    return false;
  }
  const liege = findPossession(game.world, player.liegeId);
  if (!liege) return false;

  const preview = previewAction(game, liege.id, mode, actorId);
  if (!preview || !preview.ok) {
    if (preview?.reason && actorId === game.playerId) {
      pushLog(game, `Cannot rebel against ${liege.holderName}: ${preview.reason}.`);
    }
    return false;
  }

  const casusBelli: CasusBelli = mode;
  const label =
    mode === "depose"
      ? `${player.holderName} rises to depose ${liege.holderName}`
      : `${player.holderName} declares independence from ${liege.holderName}`;

  startCampaign(game, player, liege, casusBelli, label);
  return true;
}

export interface AvailableActionTarget {
  id: number;
  holderName: string;
  title: string;
  troops: number;
  prestigeCost?: number;
  opinion: number;
  ratio: number;
  /** Ma puissance totale (avec alliés) ÷ la leur — pour colorer l’effectif affiché (vert = plus faible, rouge = plus fort). */
  difficultyRatio?: number;
  /** Titre de province contesté. */
  claimTitleName?: string;
  warGoalDomains?: number;
}

export interface AvailableProvinceClaim {
  provinceId: number;
  titleName: string;
  owned: number;
  total: number;
  /** true si on usurpe un titulaire existant. */
  usurping: boolean;
  goldCost: number;
  prestigeGain: number;
  canAfford: boolean;
}

export interface AvailableKingdomClaim {
  royaumeId: number;
  titleName: string;
  owned: number;
  total: number;
  /** true si on usurpe un titulaire existant. */
  usurping: boolean;
  goldCost: number;
  prestigeGain: number;
  canAfford: boolean;
}

export interface AvailableKingdomFoundation {
  /** Province de départ (celle depuis laquelle le bouton s’active). */
  seedProvinceId: number;
  provinceIds: number[];
  titleName: string;
  goldCost: number;
  prestigeGain: number;
  canAfford: boolean;
}

export interface AvailableDomainFabrication {
  domainId: number;
  domainName: string;
  goldCost: number;
  daysRequired: number;
  prestigeGain: number;
  /** Revenu mensuel du domaine convoité (gold/mois). */
  income: number;
  holderName: string;
  warDefenderName?: string;
}

export interface AvailableFabricationProgress {
  domainId: number;
  domainName: string;
  daysElapsed: number;
  daysRequired: number;
  goldPaid: number;
}

export interface AvailableDomainGrant {
  id: number;
  name: string;
  income: number;
  development: number;
}

export interface AvailableRebellion {
  liegeId: number;
  liegeName: string;
  title: string;
  troops: number;
  ratio: number;
  opinion: number;
  canDepose: boolean;
  canIndependence: boolean;
}

export interface AvailableActions {
  wars: AvailableActionTarget[];
  allegiances: AvailableActionTarget[];
  /** Mariages possibles (coûte 1 enfant). */
  alliances: AvailableActionTarget[];
  /** Provinces usurpable (>2/3 domaines). */
  provinceClaims: AvailableProvinceClaim[];
  /** Royaumes usurpables/créables (>4/5 domaines). */
  kingdomClaims: AvailableKingdomClaim[];
  /** Royaumes imaginaires fondables (≥3 provinces détenues et connectées). */
  kingdomFoundations: AvailableKingdomFoundation[];
  /** Domaines frontaliers où lancer une fabrication de claim. */
  domainFabrications: AvailableDomainFabrication[];
  /** Fabrications en cours du joueur. */
  fabricationProgress: AvailableFabricationProgress[];
  /** Domaines à déléguer si demesne au-dessus de la limite. */
  excessDomains: AvailableDomainGrant[];
  overage: number;
  penaltyPercent: number;
  /** Domaines à déléguer si plus de PROVINCE_DEMESNE_LIMIT provinces en demesne. */
  excessProvinceDomains: AvailableDomainGrant[];
  provinceOverage: number;
  /** Rébellion possible contre le seigneur. */
  rebellion: AvailableRebellion | null;
  /** Jetons enfants du joueur. */
  childrenTokens: number;
}

/** Cibles valides pour le joueur (voisins + conditions). */
export function listAvailableActions(game: GameState): AvailableActions {
  const wars: AvailableActionTarget[] = [];
  const allegiances: AvailableActionTarget[] = [];
  const alliances: AvailableActionTarget[] = [];
  const provinceClaims: AvailableProvinceClaim[] = [];
  const kingdomClaims: AvailableKingdomClaim[] = [];
  const kingdomFoundations: AvailableKingdomFoundation[] = [];
  const domainFabrications: AvailableDomainFabrication[] = [];
  const fabricationProgress: AvailableFabricationProgress[] = [];
  const excessDomains: AvailableDomainGrant[] = [];
  const excessProvinceDomains: AvailableDomainGrant[] = [];
  let rebellion: AvailableRebellion | null = null;
  const empty = {
    wars,
    allegiances,
    alliances,
    provinceClaims,
    kingdomClaims,
    kingdomFoundations,
    domainFabrications,
    fabricationProgress,
    excessDomains,
    overage: 0,
    penaltyPercent: 0,
    excessProvinceDomains,
    provinceOverage: 0,
    rebellion,
    childrenTokens: 0,
  };
  if (game.playerId == null) return empty;
  const player = findPossession(game.world, game.playerId);
  if (!player) return empty;

  const childrenTokens = getChildrenTokens(player);

  // Alliances : n’importe qui à ≤ ALLIANCE_MAX_HOPS territoires
  for (const { id: nid } of allianceRangeTargets(game.world, player.id)) {
    const target = findPossession(game.world, nid);
    if (!target) continue;
    const alli = previewAction(game, nid, "alliance", player.id);
    if (alli?.ok) {
      alliances.push({
        id: target.id,
        holderName: target.holderName,
        title: target.title,
        troops: levyCapacity(game.world, target, game.opinions),
        opinion: alli.opinion,
        ratio: alli.ratio,
      });
    }
  }

  for (const nid of player.neighbors || []) {
    const target = findPossession(game.world, nid);
    if (!target) continue;

    const war = previewAction(game, nid, "war", player.id);
    if (war?.ok) {
      const warId = war.redirectedToId ?? target.id;
      if (!wars.some((w) => w.id === warId)) {
        const named =
          war.redirectedToId != null
            ? findPossession(game.world, war.redirectedToId) ?? target
            : target;
        // Puissance réelle : leur camp complet (demesne + vassaux + alliés), pas juste leur host.
        const enemyTotalPower =
          war.targetPower + allyTroopContribution(game.world, named, game.opinions, game.alliances);
        const myTotalPower =
          war.playerPower + allyTroopContribution(game.world, player, game.opinions, game.alliances);
        wars.push({
          id: named.id,
          holderName: named.holderName,
          title: named.title,
          troops: Math.round(enemyTotalPower),
          opinion: war.opinion,
          ratio: war.ratio,
          difficultyRatio: powerRatio(myTotalPower, enemyTotalPower),
          claimTitleName: war.claimTitleName,
          warGoalDomains: war.warGoalDomainIds?.length,
        });
      }
    }

    const alleg = previewAction(game, nid, "allegiance", player.id);
    if (alleg?.ok) {
      allegiances.push({
        id: target.id,
        holderName: target.holderName,
        title: target.title,
        troops: alleg.targetPower,
        prestigeCost: alleg.prestigeCost,
        opinion: alleg.opinion,
        ratio: alleg.ratio,
      });
    }
  }

  // Usurpations de titres de province
  for (const prov of game.world.provinces || []) {
    const check = canUsurpProvinceTitle(
      game.world,
      game.titles || [],
      player,
      prov.id,
    );
    if (!check.ok || !check.title) continue;
    const goldCost = provinceTitleGoldCost(check.control);
    if (getGold(player) < goldCost) continue;
    const prestigeGain = provinceTitlePrestigeGain(check.control);
    provinceClaims.push({
      provinceId: prov.id,
      titleName: check.title.name,
      owned: check.control.owned,
      total: check.control.total,
      usurping:
        check.title.holderId != null && check.title.holderId !== player.id,
      goldCost,
      prestigeGain,
      canAfford: true,
    });
  }

  // Usurpations/créations de titres de royaume (>4/5 domaines)
  for (const roy of game.world.royaumes || []) {
    const check = canUsurpKingdomTitle(
      game.world,
      game.titles || [],
      player,
      roy.id,
    );
    if (!check.ok) continue;
    const goldCost = kingdomTitleGoldCost(check.control);
    if (getGold(player) < goldCost) continue;
    const prestigeGain = kingdomTitlePrestigeGain(check.control);
    kingdomClaims.push({
      royaumeId: roy.id,
      titleName: check.title?.name ?? kingdomTitleName(roy),
      owned: check.control.owned,
      total: check.control.total,
      usurping:
        check.title?.holderId != null && check.title.holderId !== player.id,
      goldCost,
      prestigeGain,
      canAfford: true,
    });
  }

  // Royaumes imaginaires fondables (≥3 provinces détenues et connectées)
  {
    const seenClusters = new Set<string>();
    for (const t of game.titles || []) {
      if (t.tier !== "province" || t.holderId !== player.id) continue;
      const check = canFoundImaginaryKingdom(
        game.world,
        game.titles || [],
        player,
        t.deJureId,
      );
      if (!check.ok || !check.provinceIds || !check.domainIds) continue;
      const key = [...check.provinceIds].sort((a, b) => a - b).join(",");
      if (seenClusters.has(key)) continue;
      seenClusters.add(key);
      const foundControl = fullControlFromDomains(check.domainIds);
      const goldCost = kingdomTitleGoldCost(foundControl);
      if (getGold(player) < goldCost) continue;
      const prestigeGain = kingdomTitlePrestigeGain(foundControl);
      const seedProvince = (game.world.provinces || []).find(
        (p) => p.id === t.deJureId,
      );
      kingdomFoundations.push({
        seedProvinceId: t.deJureId,
        provinceIds: check.provinceIds,
        titleName: seedProvince?.name ?? `Province ${t.deJureId}`,
        goldCost,
        prestigeGain,
        canAfford: true,
      });
    }
  }

  // Fabrications en cours
  for (const fab of game.claimFabrications || []) {
    if (fab.actorId !== player.id) continue;
    const d =
      game.world.domaines.find((x) => x.id === fab.domainId) ??
      game.world.domaines[fab.domainId];
    fabricationProgress.push({
      domainId: fab.domainId,
      domainName: d?.name ?? `Domain ${fab.domainId}`,
      daysElapsed: fab.daysElapsed,
      daysRequired: fab.daysRequired,
      goldPaid: fab.goldPaid,
    });
  }

  // Nouvelles fabrications possibles (domaines frontaliers)
  if (!(game.claimFabrications || []).some((f) => f.actorId === player.id)) {
    const seen = new Set<number>();
    for (const did of player.domaines || []) {
      const mine =
        game.world.domaines.find((x) => x.id === did) ?? game.world.domaines[did];
      if (!mine) continue;
      for (const nid of seaLinkedDomainNeighbors(game.world, mine.id)) {
        if (seen.has(nid)) continue;
        seen.add(nid);
        const preview = previewFabricateDomainClaim(game, nid, player.id);
        if (!preview?.ok) continue;
        const target =
          game.world.domaines.find((x) => x.id === nid) ?? game.world.domaines[nid];
        domainFabrications.push({
          domainId: preview.domainId,
          domainName: preview.domainName,
          goldCost: preview.goldCost,
          daysRequired: preview.daysRequired,
          prestigeGain: preview.prestigeGain,
          income: target ? domainMonthlyIncome(target) : 0,
          holderName: preview.holderName ?? "—",
          warDefenderName: preview.warDefenderName,
        });
      }
    }
    // Aussi via vassaux (frontière du realm)
    for (const vid of player.vassalIds || []) {
      const v = findPossession(game.world, vid);
      if (!v) continue;
      for (const did of v.domaines || []) {
        const mine =
          game.world.domaines.find((x) => x.id === did) ??
          game.world.domaines[did];
        if (!mine) continue;
        for (const nid of seaLinkedDomainNeighbors(game.world, mine.id)) {
          if (seen.has(nid)) continue;
          seen.add(nid);
          const preview = previewFabricateDomainClaim(game, nid, player.id);
          if (!preview?.ok) continue;
          const target =
            game.world.domaines.find((x) => x.id === nid) ?? game.world.domaines[nid];
          domainFabrications.push({
            domainId: preview.domainId,
            domainName: preview.domainName,
            goldCost: preview.goldCost,
            daysRequired: preview.daysRequired,
            prestigeGain: preview.prestigeGain,
            income: target ? domainMonthlyIncome(target) : 0,
            holderName: preview.holderName ?? "—",
            warDefenderName: preview.warDefenderName,
          });
        }
      }
    }
    // Du plus rentable (or/mois + prestige) au moins rentable.
    domainFabrications.sort(
      (a, b) => b.income + b.prestigeGain - (a.income + a.prestigeGain),
    );
  }

  if (player.liegeId != null) {
    const liege = findPossession(game.world, player.liegeId);
    if (liege) {
      const depose = previewAction(game, liege.id, "depose", player.id);
      const indep = previewAction(game, liege.id, "independence", player.id);
      if (depose?.ok || indep?.ok) {
        rebellion = {
          liegeId: liege.id,
          liegeName: liege.holderName,
          title: liege.title,
          troops: depose?.targetPower ?? indep!.targetPower,
          ratio: depose?.ratio ?? indep!.ratio,
          opinion: depose?.opinion ?? indep!.opinion,
          canDepose: !!depose?.ok,
          canIndependence: !!indep?.ok,
        };
      }
    }
  }

  const overage = demesneOverage(player);
  const penaltyPercent = demesnePenaltyPercent(player);
  if (overage > 0) {
    for (const id of player.domaines || []) {
      const preview = previewGrantDomain(game, id, null, player.id);
      if (!preview?.ok) continue;
      const d = game.world.domaines.find((x) => x.id === id) ?? game.world.domaines[id];
      if (!d) continue;
      excessDomains.push({
        id: d.id,
        name: d.name,
        income: domainMonthlyIncome(d),
        development: d.development ?? 0,
      });
    }
    excessDomains.sort((a, b) => a.income - b.income);
  }

  const provinceOverageCount = provinceOverage(game.world, player);
  if (provinceOverageCount > 0) {
    // Regroupe le demesne par province, garde les provinces où le joueur a
    // le plus de présence comme « cœur », propose de déléguer le reste.
    const byProvince = new Map<number, number[]>();
    for (const id of player.domaines || []) {
      const d = game.world.domaines.find((x) => x.id === id) ?? game.world.domaines[id];
      if (!d || d.provinceId == null) continue;
      const list = byProvince.get(d.provinceId) ?? [];
      list.push(id);
      byProvince.set(d.provinceId, list);
    }
    const ranked = [...byProvince.entries()].sort((a, b) => b[1].length - a[1].length);
    const toDelegate = ranked.slice(PROVINCE_DEMESNE_LIMIT);
    for (const [, domainIds] of toDelegate) {
      for (const id of domainIds) {
        const preview = previewGrantDomain(game, id, null, player.id);
        if (!preview?.ok) continue;
        const d = game.world.domaines.find((x) => x.id === id) ?? game.world.domaines[id];
        if (!d) continue;
        excessProvinceDomains.push({
          id: d.id,
          name: d.name,
          income: domainMonthlyIncome(d),
          development: d.development ?? 0,
        });
      }
    }
    excessProvinceDomains.sort((a, b) => a.income - b.income);
  }

  // Guerres : plus faibles d’abord · Allégeance / alliés : plus forts d’abord
  wars.sort((a, b) => a.troops - b.troops);
  allegiances.sort((a, b) => b.troops - a.troops);
  alliances.sort((a, b) => b.troops - a.troops || a.holderName.localeCompare(b.holderName));
  return {
    wars,
    allegiances,
    alliances,
    provinceClaims,
    kingdomClaims,
    kingdomFoundations,
    domainFabrications,
    fabricationProgress,
    excessDomains,
    overage,
    penaltyPercent,
    excessProvinceDomains,
    provinceOverage: provinceOverageCount,
    rebellion,
    childrenTokens,
  };
}

export interface GiftPreview {
  ok: boolean;
  reason?: string;
  gold: number;
  opinionGain: number;
  playerGold: number;
  opinion: number;
  alreadySent: boolean;
}

export function previewGift(
  game: GameState,
  targetId: number,
  actorId: number = game.playerId ?? -1,
): GiftPreview | null {
  const player = findPossession(game.world, actorId);
  const target = findPossession(game.world, targetId);
  if (!player || !target || player.id === target.id) return null;

  const gold = giftCostForRank(target.rank);
  const playerGold = getGold(player);
  const opinion = getOpinion(game.opinions, target.id, player.id);
  const giftKey = opinionKey(player.id, target.id);
  const alreadySent = !!game.giftsSent[giftKey];

  if (alreadySent) {
    return {
      ok: false,
      reason: "Already sent a gift",
      gold,
      opinionGain: GIFT_OPINION_GAIN,
      playerGold,
      opinion,
      alreadySent: true,
    };
  }

  if (playerGold < gold) {
    return {
      ok: false,
      reason: `Need ${formatGold(gold)} gold`,
      gold,
      opinionGain: GIFT_OPINION_GAIN,
      playerGold,
      opinion,
      alreadySent: false,
    };
  }

  return {
    ok: true,
    gold,
    opinionGain: GIFT_OPINION_GAIN,
    playerGold,
    opinion,
    alreadySent: false,
  };
}

/** Un seul cadeau par cible — montant selon le rang. */
export function sendGift(
  game: GameState,
  targetId: number,
  actorId: number = game.playerId ?? -1,
): boolean {
  const preview = previewGift(game, targetId, actorId);
  const player = findPossession(game.world, actorId);
  const target = findPossession(game.world, targetId);
  if (!preview || !player || !target) return false;
  const giftKey = opinionKey(player.id, target.id);

  if (!preview.ok) {
    if (actorId === game.playerId) {
      pushLog(
        game,
        `Cannot send a gift to ${target.holderName}: ${preview.reason}.`,
      );
    }
    return false;
  }

  addGold(player, -preview.gold);
  addGold(target, preview.gold);
  adjustOpinion(game.opinions, target.id, player.id, GIFT_OPINION_GAIN);
  adjustOpinion(game.opinions, player.id, target.id, Math.round(GIFT_OPINION_GAIN * 0.35));
  game.giftsSent = { ...game.giftsSent, [giftKey]: true };

  const newOpinion = getOpinion(game.opinions, target.id, player.id);
  pushLog(
    game,
    `${player.holderName} sends a gift (${formatGold(preview.gold)} gold) to ${target.holderName}. Opinion now ${newOpinion}.`,
    [player.id, target.id],
  );
  return true;
}

const VASSAL_NAME_POOL = [
  "Amalaric",
  "Chilperic",
  "Sigebert",
  "Theudebert",
  "Guntram",
  "Chlothar",
  "Radegund",
  "Berthar",
  "Wulfoald",
  "Godegisel",
  "Munderic",
  "Chararic",
  "Rignomer",
  "Audovald",
  "Leudast",
  "Nicetius",
  "Agricola",
  "Syagrius",
  "Arbogast",
  "Aegidius",
];

function nextPossessionId(world: { possessions?: Possession[] }): number {
  let max = 0;
  for (const p of world.possessions || []) {
    if (p.id > max) max = p.id;
  }
  return max + 1;
}

function pickVassalHolderName(world: { possessions?: Possession[] }, seed: number): string {
  const used = new Set((world.possessions || []).map((p) => p.holderName));
  for (let i = 0; i < VASSAL_NAME_POOL.length; i++) {
    const name = VASSAL_NAME_POOL[(seed + i) % VASSAL_NAME_POOL.length];
    if (!used.has(name)) return name;
  }
  return `Lord ${seed}`;
}

export interface GrantPreview {
  ok: boolean;
  reason?: string;
  domainId: number;
  domainName: string;
  /** null = créer un nouveau vassal */
  vassalId: number | null;
  vassalName: string | null;
  overage: number;
}

export function previewGrantDomain(
  game: GameState,
  domainId: number,
  vassalId: number | null = null,
  actorId: number = game.playerId ?? -1,
): GrantPreview | null {
  const actor = findPossession(game.world, actorId);
  if (!actor) return null;

  const domain =
    game.world.domaines.find((d) => d.id === domainId) ?? game.world.domaines[domainId];
  if (!domain) return null;

  const base: GrantPreview = {
    ok: false,
    domainId,
    domainName: domain.name,
    vassalId,
    vassalName: null,
    overage: Math.max(0, demesneCount(actor) - DEMESNE_LIMIT),
  };

  if (!actor.domaines.includes(domainId) || domain.possessionId !== actor.id) {
    return { ...base, reason: "Not in your demesne" };
  }
  if (demesneCount(actor) <= 1) {
    return { ...base, reason: "Must keep at least one domain" };
  }
  // Sous-vassaux : pas de vassaux (3 niveaux max)
  if (vassalDepth(game.world, actor) >= MAX_VASSAL_DEPTH) {
    return { ...base, reason: "Domain holders cannot create vassals" };
  }
  if (vassalId == null && vassalDepth(game.world, actor) >= 1) {
    // OK : vassal crée un subvassal
  }

  if (vassalId != null) {
    const vassal = findPossession(game.world, vassalId);
    if (!vassal || vassal.liegeId !== actor.id) {
      return { ...base, reason: "Not your vassal" };
    }
    return {
      ...base,
      ok: true,
      vassalName: vassal.holderName,
    };
  }

  return { ...base, ok: true, vassalName: null };
}

/**
 * Délègue un domaine : à un vassal existant, ou crée un nouveau vassal comtal.
 */
export function grantDomain(
  game: GameState,
  domainId: number,
  vassalId: number | null = null,
  actorId: number = game.playerId ?? -1,
): boolean {
  const preview = previewGrantDomain(game, domainId, vassalId, actorId);
  const actor = findPossession(game.world, actorId);
  if (!preview || !actor) return false;

  if (!preview.ok) {
    if (actorId === game.playerId) {
      pushLog(game, `Cannot grant ${preview.domainName}: ${preview.reason}.`);
    }
    return false;
  }

  const domain =
    game.world.domaines.find((d) => d.id === domainId) ?? game.world.domaines[domainId];
  if (!domain) return false;

  let vassal: Possession | undefined;

  if (vassalId != null) {
    vassal = findPossession(game.world, vassalId);
    if (!vassal) return false;
    transferDomains(game.world, actor, vassal, [domainId]);
    adjustOpinion(game.opinions, vassal.id, actor.id, 12);
    pushLog(
      game,
      `${actor.holderName} grants ${domain.name} to vassal ${vassal.holderName}.`,
      [actor.id, vassal.id],
    );
  } else {
    const id = nextPossessionId(game.world);
    const holderName = pickVassalHolderName(game.world, id * 17 + domainId);
    const monthly = domainMonthlyIncome(domain);
    vassal = {
      id,
      name: domain.name,
      holderName,
      title: vassalDepth(game.world, actor) >= 1 ? "Lord" : "Count",
      code: null,
      rank: vassalDepth(game.world, actor) >= 1 ? "subvassal" : "vassal",
      liegeId: actor.id,
      vassalIds: [],
      royaumeId: actor.royaumeId,
      centroid: [...domain.centroid] as [number, number],
      domaines: [],
      neighbors: [],
      claims: [],
    };
    setGold(vassal, monthly * 8);
    setPrestige(vassal, monthly * 4);
    if (!game.world.possessions) game.world.possessions = [];
    game.world.possessions.push(vassal);
    if (!actor.vassalIds) actor.vassalIds = [];
    actor.vassalIds.push(vassal.id);
    if (actor.rank === "chief") actor.rank = "king";
    // Ne pas passer par attachAsVassal : déjà lié
    transferDomains(game.world, actor, vassal, [domainId]);
    adjustOpinion(game.opinions, vassal.id, actor.id, 25);
    adjustOpinion(game.opinions, actor.id, vassal.id, 10);
    pushLog(
      game,
      `${actor.holderName} enfeoffs ${holderName} with ${domain.name} as count.`,
      [actor.id, vassal.id],
    );
  }

  rebuildPossessionNeighbors(game.world);
  return true;
}

/** Domaine à déléguer en priorité (revenu le plus faible, hors capitale/centroïde proche). */
export function pickDomainToGrant(game: GameState, actorId: number): number | null {
  const actor = findPossession(game.world, actorId);
  if (!actor || demesneCount(actor) <= 1) return null;
  if (demesneCount(actor) <= DEMESNE_LIMIT) return null;

  const [cx, cy] = actor.centroid;
  let best: { id: number; score: number } | null = null;
  for (const id of actor.domaines) {
    const d = game.world.domaines.find((x) => x.id === id) ?? game.world.domaines[id];
    if (!d) continue;
    const dx = d.centroid[0] - cx;
    const dy = d.centroid[1] - cy;
    const dist = dx * dx + dy * dy;
    const income = domainMonthlyIncome(d);
    // Préfère les domaines lointains et peu riches
    const score = dist * 2 - income * 5;
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? null;
}
