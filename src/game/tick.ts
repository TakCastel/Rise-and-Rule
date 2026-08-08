import type { GameState, GameSpeed } from "./types";
import { pushLog } from "./types";
import { executeAiPlan, planAiDayActions } from "./ai";
import { tickArmies } from "./army";
import { runAiWarConduct } from "./aiWar";
import { tickAllyCallRequests } from "./ally-war";
import { tickWarGoalOccupation } from "./army-actions";
import { declareRebellion, isInvolvedInWar, tickAllegianceDemands, tickClaimFabrications } from "./actions";
import {
  ALLIED_BLOC_REBEL_CHANCE,
  listAlliedBlocThreats,
  tickChildbirths,
} from "./alliance";
import {
  debtInterest,
  provinceOverage,
  PROVINCE_OVERAGE_VASSAL_OPINION_MALUS,
} from "./demesne";
import {
  addGold,
  addPrestige,
  formatGold,
  getGold,
  possessionMonthlyIncome,
  possessionMonthlyPrestige,
} from "./economy";
import { adjustOpinion, tickOpinions } from "./opinion";
import {
  findKingdomTitle,
  provinceControl,
  PROVINCE_CLAIM_THRESHOLD,
} from "./titles";
import { regenLevies } from "./war";

function cloneWars(wars: GameState["wars"]): GameState["wars"] {
  return wars.map((w) => ({
    ...w,
    conquestOrder: [...(w.conquestOrder || [])],
    attackerFrontOrder: w.attackerFrontOrder ? [...w.attackerFrontOrder] : undefined,
    capturedByAttacker: [...(w.capturedByAttacker || [])],
    capturedByDefender: [...(w.capturedByDefender || [])],
    allyOfAttacker: w.allyOfAttacker ? [...w.allyOfAttacker] : undefined,
    allyOfDefender: w.allyOfDefender ? [...w.allyOfDefender] : undefined,
    declinedAllyCalls: w.declinedAllyCalls ? [...w.declinedAllyCalls] : undefined,
  }));
}

function cloneAllyCallRequests(
  requests: GameState["allyCallRequests"],
): GameState["allyCallRequests"] {
  return requests.map((r) => ({ ...r }));
}

function cloneAllegianceDemands(
  requests: GameState["allegianceDemands"],
): GameState["allegianceDemands"] {
  return requests.map((r) => ({ ...r }));
}

function cloneArmies(armies: GameState["armies"]): GameState["armies"] {
  return armies.map((a) => ({
    ...a,
    path: a.path ? [...a.path] : undefined,
    battleOpponentIds: a.battleOpponentIds ? [...a.battleOpponentIds] : undefined,
  }));
}

/**
 * Clone superficiel de `world`, sans toucher aux géométries figées (littoral,
 * rivières, `boundary` des domaines/provinces/royaumes/possessions…) — seuls
 * les tableaux réellement mutés en place pendant un tick (vassaux, domaines
 * tenus, revendications) sont recopiés. Un `structuredClone(world)` complet
 * recopiait ~126k points de coordonnées à chaque jour écoulé (~30-40 ms),
 * perceptible en jeu à vitesse rapide.
 */
function cloneWorldMutable(world: GameState["world"]): GameState["world"] {
  return {
    ...world,
    domaines: world.domaines.map((d) => ({ ...d })),
    provinces: (world.provinces || []).map((p) => ({ ...p, domaines: [...p.domaines] })),
    royaumes: (world.royaumes || []).map((r) => ({ ...r, domaines: [...r.domaines] })),
    possessions: (world.possessions || []).map((p) => ({
      ...p,
      vassalIds: [...(p.vassalIds || [])],
      domaines: [...p.domaines],
      claims: p.claims ? p.claims.map((c) => ({ ...c })) : p.claims,
      domainClaims: p.domainClaims ? [...p.domainClaims] : p.domainClaims,
    })),
  };
}

/** Durée d’un jour calendaire en ms selon la vitesse. */
export function tickIntervalMs(speed: GameSpeed): number {
  if (speed === 1) return 900;
  if (speed === 2) return 400;
  return 160;
}

/** Impôts / rentes + prestige + intérêts de dette. */
export function applyMonthlyIncome(game: GameState): void {
  for (const p of game.world.possessions || []) {
    const before = getGold(p);
    const income = possessionMonthlyIncome(game.world, p);
    if (income !== 0) addGold(p, income);

    const interest = debtInterest(getGold(p));
    if (interest > 0) addGold(p, -interest);

    const after = getGold(p);
    if (
      p.id === game.playerId &&
      before >= 0 &&
      after < 0
    ) {
      pushLog(
        game,
        `Your treasury falls into debt (${formatGold(after)} gold). Levies collapse until you recover — grant excess domains.`,
      );
    }

    const prestige = possessionMonthlyPrestige(game.world, p);
    if (prestige > 0) addPrestige(p, prestige);
  }
}

function advanceCalendar(game: GameState): { monthRolled: boolean } {
  game.day += 1;
  let monthRolled = false;
  if (game.day > 30) {
    game.day = 1;
    game.month += 1;
    monthRolled = true;
    if (game.month >= 12) {
      game.month = 0;
      game.year += 1;
      if (game.year % 5 === 0) pushLog(game, `Year ${game.year}.`);
    }
  }
  return { monthRolled };
}

function ensureWorldClone(game: GameState, original: GameState): void {
  if (game.world === original.world) {
    game.world = cloneWorldMutable(original.world);
  }
}

function dayIndexOf(year: number, month: number, day: number): number {
  return year * 360 + month * 30 + day;
}

/**
 * Résout les royaumes imaginaires arrivés à échéance (10 ans) : la province
 * quitte son royaume d’origine et rejoint le royaume imaginaire — la carte
 * de jure « drift » définitivement.
 */
/** Détruit tout royaume qui n’a plus aucun domaine, et son titre avec lui. */
function destroyEmptyRoyaumes(game: GameState): void {
  const empty = (game.world.royaumes || []).filter((r) => r.domaines.length === 0);
  if (!empty.length) return;
  const emptyIds = new Set(empty.map((r) => r.id));
  game.world.royaumes = (game.world.royaumes || []).filter((r) => !emptyIds.has(r.id));
  if (game.titles?.length) {
    game.titles = game.titles.filter(
      (t) => !(t.tier === "kingdom" && emptyIds.has(t.deJureId)),
    );
  }
  for (const r of empty) {
    pushLog(game, `${r.name} is dissolved — no land remains under its name.`);
  }
}

/**
 * Résout les royaumes imaginaires arrivés à échéance (10 ans) : chaque
 * province ne rejoint le royaume imaginaire que si elle est encore
 * réellement possédée par son titulaire à ce moment-là (> 2/3 de contrôle) —
 * sinon elle reste à son royaume d’origine, l’opportunité est perdue.
 * Un royaume vidé de tout territoire est détruit.
 */
function tickKingdomDrifts(game: GameState): void {
  const drifts = game.kingdomDrifts || [];
  if (!drifts.length) return;
  const today = dayIndexOf(game.year, game.month, game.day);
  const due = drifts.filter(
    (d) => dayIndexOf(d.dueYear, d.dueMonth, d.dueDay) <= today,
  );
  if (!due.length) return;

  for (const drift of due) {
    const newRoy = (game.world.royaumes || []).find(
      (r) => r.id === drift.royaumeId,
    );
    if (!newRoy) continue;
    const holderId =
      findKingdomTitle(game.titles || [], drift.royaumeId)?.holderId ??
      drift.actorId;
    const stolenNames: string[] = [];
    const lostNames: string[] = [];
    for (const provinceId of drift.provinceIds) {
      const province = (game.world.provinces || []).find(
        (p) => p.id === provinceId,
      );
      if (!province || province.royaumeId === drift.royaumeId) continue;

      const control = provinceControl(game.world, holderId, provinceId);
      if (control.ratio <= PROVINCE_CLAIM_THRESHOLD) {
        lostNames.push(province.name);
        // Jamais réellement rejoint : retirer la revendication spéculative.
        newRoy.provinces = (newRoy.provinces || []).filter((id) => id !== provinceId);
        const lostDomainIds = new Set(province.domaines);
        newRoy.domaines = newRoy.domaines.filter((id) => !lostDomainIds.has(id));
        continue;
      }

      const oldRoy = (game.world.royaumes || []).find(
        (r) => r.id === province.royaumeId,
      );
      if (oldRoy) {
        oldRoy.provinces = (oldRoy.provinces || []).filter(
          (id) => id !== provinceId,
        );
        const stolenDomainIds = new Set(province.domaines);
        oldRoy.domaines = oldRoy.domaines.filter(
          (id) => !stolenDomainIds.has(id),
        );
      }
      province.royaumeId = drift.royaumeId;
      for (const did of province.domaines) {
        const d =
          game.world.domaines.find((x) => x.id === did) ??
          game.world.domaines[did];
        if (d) d.royaumeId = drift.royaumeId;
      }
      stolenNames.push(province.name);
    }
    const actor = (game.world.possessions || []).find(
      (p) => p.id === drift.actorId,
    );
    if (stolenNames.length) {
      pushLog(
        game,
        `${newRoy.name} drifts into being: ${stolenNames.join(", ")} secede${
          stolenNames.length === 1 ? "s" : ""
        } from their old realm${actor ? ` under ${actor.holderName}` : ""}.`,
        actor ? [actor.id] : undefined,
      );
    }
    if (lostNames.length) {
      pushLog(
        game,
        `${newRoy.name}'s claim on ${lostNames.join(", ")} lapses — no longer held after 10 years.`,
        actor ? [actor.id] : undefined,
      );
    }
  }

  game.kingdomDrifts = drifts.filter((d) => !due.includes(d));
  destroyEmptyRoyaumes(game);
}

/** Rébellion d’un bloc de vassaux alliés trop puissant. */
function tickAlliedVassalThreat(game: GameState): void {
  if (game.phase !== "play") return;
  const busy = new Set<number>();
  for (const w of game.wars) {
    busy.add(w.attackerId);
    busy.add(w.defenderId);
  }
  const threats = listAlliedBlocThreats(game, busy);
  for (const t of threats) {
    if (Math.random() > ALLIED_BLOC_REBEL_CHANCE) continue;
    if (isInvolvedInWar(game, t.leaderId) || isInvolvedInWar(game, t.liegeId)) {
      continue;
    }
    const mode =
      t.mode === "depose" && Math.random() < 0.55 ? "depose" : "independence";
    const ok = declareRebellion(game, mode, t.leaderId);
    if (!ok) continue;
    pushLog(
      game,
      `Allied vassals under ${t.leaderName} rise against ${t.liegeName} (${mode}) — their bloc outmatches the crown.`,
      [t.leaderId, t.liegeId, ...t.blocIds],
    );
    if (t.liegeId === game.playerId) {
      pushLog(
        game,
        `Warning: keep your vassals divided. Allied blocs stronger than you will rebel.`,
      );
    }
    return;
  }
}

/**
 * Trop de provinces gardées en demesne direct (> PROVINCE_DEMESNE_LIMIT)
 * mécontente les vassaux directs — ils voient leur suzerain accaparer des
 * terres qui devraient leur revenir, et sont d'autant plus tentés de se
 * rebeller que l'excédent est grand.
 */
function applyProvinceOverageDiscontent(game: GameState): void {
  for (const p of game.world.possessions || []) {
    if (!p.vassalIds?.length) continue;
    const overage = provinceOverage(game.titles || [], p);
    if (overage <= 0) continue;
    for (const vassalId of p.vassalIds) {
      adjustOpinion(
        game.opinions,
        vassalId,
        p.id,
        PROVINCE_OVERAGE_VASSAL_OPINION_MALUS * overage,
      );
    }
  }
}

/**
 * Avance le temps de `dtMs` : calendrier / impôts / armées / IA au passage
 * de chaque jour calendaire (les armées avancent par pas de jour entier —
 * plus de front continu à lisser image par image).
 */
export function tickFrame(game: GameState, dtMs: number): GameState {
  const dayMs = tickIntervalMs(game.speed);
  let dtDays = dtMs / dayMs;
  if (dtDays <= 0) return game;
  // Évite les sauts après un onglet en veille
  if (dtDays > 0.4) dtDays = 0.4;

  const progress = (game.dayProgress ?? 0) + dtDays;
  const daysToRoll = Math.floor(progress);
  const nextProgress = progress - daysToRoll;

  // Aucun jour calendaire écoulé : ne fait avancer que la fraction visuelle
  // (dayProgress, pour le glissé continu des armées) sans reconstruire
  // wars/armies/claimFabrications — évite de recréer des tableaux à chaque
  // sous-tick (jusqu'à 20/s) alors que rien ne change tant qu'un jour entier
  // ne s'est pas écoulé. Sans ça, tous les useMemo de la carte qui dépendent
  // de `armies`/`wars` se recalculaient inutilement en continu.
  if (daysToRoll === 0) {
    return { ...game, dayProgress: nextProgress };
  }

  const hasWars = game.wars.length > 0 || game.armies.length > 0;
  const next: GameState = {
    ...game,
    dayProgress: nextProgress,
    world: game.world,
    wars: hasWars ? cloneWars(game.wars) : game.wars,
    armies: hasWars ? cloneArmies(game.armies) : game.armies,
    allyCallRequests: (game.allyCallRequests || []).length
      ? cloneAllyCallRequests(game.allyCallRequests)
      : game.allyCallRequests,
    allegianceDemands: (game.allegianceDemands || []).length
      ? cloneAllegianceDemands(game.allegianceDemands)
      : game.allegianceDemands,
    claimFabrications: (game.claimFabrications || []).map((f) => ({ ...f })),
    titles: game.titles,
    kingdomDrifts: game.kingdomDrifts,
    opinions: game.opinions,
    giftsSent: game.giftsSent,
    warTruces: game.warTruces,
    alliances: game.alliances,
    log: game.log,
    notices: game.notices,
  };

  for (let i = 0; i < daysToRoll; i++) {
    const { monthRolled } = advanceCalendar(next);
    if (monthRolled) {
      ensureWorldClone(next, game);
      if (next.opinions === game.opinions) next.opinions = { ...game.opinions };
      if (next.alliances === game.alliances) {
        next.alliances = [...(game.alliances || [])];
      }
      applyMonthlyIncome(next);
      tickOpinions(next);
      applyProvinceOverageDiscontent(next);
      tickChildbirths(next);
      tickAlliedVassalThreat(next);
    }

    // Levées : progression quotidienne (équivalent ~12 % / mois)
    ensureWorldClone(next, game);
    regenLevies(next);

    if (next.phase === "play") {
      ensureWorldClone(next, game);
      tickArmies(next);
      runAiWarConduct(next);
      tickAllyCallRequests(next);
      tickAllegianceDemands(next);
      tickWarGoalOccupation(next);
      tickClaimFabrications(next);
      tickKingdomDrifts(next);

      const plans = planAiDayActions(next);
      for (const plan of plans) {
        ensureWorldClone(next, game);
        if (next.opinions === game.opinions) next.opinions = { ...game.opinions };
        if (next.giftsSent === game.giftsSent) next.giftsSent = { ...game.giftsSent };
        if (next.alliances === game.alliances) {
          next.alliances = [...(next.alliances || [])];
        }
        if (next.claimFabrications === game.claimFabrications) {
          next.claimFabrications = (game.claimFabrications || []).map((f) => ({
            ...f,
          }));
        }
        executeAiPlan(next, plan);
      }
    }
  }

  return next;
}

/** Avance d’un jour plein. */
export function tickDay(game: GameState): GameState {
  return tickFrame(game, tickIntervalMs(game.speed));
}

export function formatDate(year: number, month: number, day: number): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${day} ${months[month]} ${year}`;
}
