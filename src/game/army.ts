import type { Domaine, TerrainType, WorldData } from "../types/world";
import { areAllied } from "./alliance";
import { controlsDomain } from "./titles";
import { addGold, formatGold } from "./economy";
import { levyCapacity } from "./power";
import type { GameState, WarState } from "./types";
import { pushLog } from "./types";
import { findPossession } from "./war";

export type ArmyStance = "idle" | "moving" | "sieging" | "battling";

/**
 * Corps d’armée levé pour une guerre précise. `domainId` est le domaine
 * occupé (en marche : le domaine de départ de l’étape en cours — la
 * destination immédiate est `path[0]`, pas encore atteinte).
 */
export interface Army {
  id: number;
  ownerId: number;
  warId: number;
  domainId: number;
  troops: number;
  stance: ArmyStance;

  /** Étapes restantes (path[0] = prochaine destination, pas encore rejointe). */
  path?: number[];
  legProgress?: number;
  legDays?: number;

  siegeProgress?: number;
  siegeDays?: number;

  /** Armées adverses présentes dans le même domaine (info d’affichage). */
  battleOpponentIds?: number[];
  /** Effectif au moment d’entrer en bataille — sert de référence pour la déroute. */
  battleStartTroops?: number;

  raisedDay: number;
}

export function domainById(world: WorldData, id: number): Domaine | undefined {
  return world.domaines.find((x) => x.id === id) ?? world.domaines[id];
}

export type WarSide = "attacker" | "defender";

/** Camp (principal ou allié ayant répondu à l’appel) d’un possesseur d’armée dans cette guerre. */
export function warSideOf(war: WarState, ownerId: number): WarSide | null {
  if (ownerId === war.attackerId || (war.allyOfAttacker || []).includes(ownerId)) return "attacker";
  if (ownerId === war.defenderId || (war.allyOfDefender || []).includes(ownerId)) return "defender";
  return null;
}

/**
 * Camp adverse (au sein de la guerre) pour un possesseur d’armée donné —
 * toujours l’identité principale (attaquant/défenseur), même pour un allié :
 * le territoire contesté appartient aux belligérants principaux, pas à leurs
 * alliés venus prêter main-forte.
 */
export function opposingSideId(war: WarState, ownerId: number): number {
  return warSideOf(war, ownerId) === "attacker" ? war.defenderId : war.attackerId;
}

function activeWarById(game: GameState, warId: number): WarState | undefined {
  return game.wars.find((w) => w.id === warId);
}

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

export const MARCH_DAYS_PER_DOMAIN_BASE = 3;

const TERRAIN_MARCH_FRICTION: Partial<Record<TerrainType, number>> = {
  mountains: 1.8,
  hills: 1.3,
  forest: 1.25,
  marsh: 1.4,
  desert: 1.3,
  plains: 0.85,
  farmland: 0.85,
  coast: 1.0,
  scrub: 1.05,
  sea: 0.55,
};

function terrainFriction(d: Domaine | undefined): number {
  if (!d?.terrainType) return 1;
  return TERRAIN_MARCH_FRICTION[d.terrainType] ?? 1;
}

function isSeaDomain(d: Domaine | undefined): boolean {
  return d?.terrainType === "sea";
}

/**
 * Franchir la côte (terre → mer ou mer → terre) prend plus de temps que le
 * trajet moyen ne le suggère — embarquer/débarquer une armée, pas une simple
 * marche. Une fois en mer, en revanche, on va plus vite que sur terre (voir
 * `TERRAIN_MARCH_FRICTION.sea`).
 */
const COASTAL_CROSSING_FRICTION_BONUS = 1.6;

export function legDaysBetween(world: WorldData, fromId: number, toId: number): number {
  const fromD = domainById(world, fromId);
  const toD = domainById(world, toId);
  let friction = (terrainFriction(fromD) + terrainFriction(toD)) / 2;
  if (isSeaDomain(fromD) !== isSeaDomain(toD)) {
    friction *= COASTAL_CROSSING_FRICTION_BONUS;
  }
  return Math.max(1, Math.round(MARCH_DAYS_PER_DOMAIN_BASE * friction));
}

/** Coût d'affrètement pour embarquer une armée (terre → mer uniquement). */
export const NAVAL_EMBARK_GOLD_PER_TROOP = 0.05;
export const NAVAL_EMBARK_MIN_GOLD = 5;

/**
 * Prélève le coût d'affrètement quand une armée quitte la terre pour la mer
 * (jamais l'inverse — débarquer est lent mais gratuit). Peut mettre le
 * trésor à découvert : le système de dette (`demesne.ts`) l'absorbe déjà,
 * pas de blocage de la marche ici.
 */
export function chargeNavalEmbarkation(game: GameState, army: Army, fromId: number, toId: number): void {
  const fromD = domainById(game.world, fromId);
  const toD = domainById(game.world, toId);
  if (isSeaDomain(fromD) || !isSeaDomain(toD)) return;
  const owner = findPossession(game.world, army.ownerId);
  if (!owner) return;
  const cost = Math.max(
    NAVAL_EMBARK_MIN_GOLD,
    Math.round(army.troops * NAVAL_EMBARK_GOLD_PER_TROOP * 10) / 10,
  );
  addGold(owner, -cost);
  pushLog(
    game,
    `${owner.holderName} charters ships at ${fromD?.name ?? "the coast"} to embark for ${toD?.name ?? "open water"} (−${formatGold(cost)}).`,
    [owner.id],
  );
}

/** Dijkstra sur l’adjacence des domaines (pondérée terrain) — chemin de marche. */
export function findMarchPath(
  world: WorldData,
  fromDomainId: number,
  toDomainId: number,
): number[] | null {
  if (fromDomainId === toDomainId) return [];
  const dist = new Map<number, number>([[fromDomainId, 0]]);
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  const queue: number[] = [fromDomainId];

  while (queue.length) {
    queue.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur === toDomainId) break;

    const d = domainById(world, cur);
    if (!d) continue;
    const curDist = dist.get(cur) ?? Infinity;
    for (const nid of d.neighbors || []) {
      if (visited.has(nid)) continue;
      const nd = curDist + legDaysBetween(world, cur, nid);
      if (nd < (dist.get(nid) ?? Infinity)) {
        dist.set(nid, nd);
        prev.set(nid, cur);
        queue.push(nid);
      }
    }
  }

  if (!dist.has(toDomainId)) return null;
  const path: number[] = [];
  let cur = toDomainId;
  while (cur !== fromDomainId) {
    path.push(cur);
    const p = prev.get(cur);
    if (p == null) return null;
    cur = p;
  }
  path.reverse();
  return path;
}

function nearestFriendlyDomain(
  world: WorldData,
  domainId: number,
  ownerId: number,
): number | undefined {
  const d = domainById(world, domainId);
  if (!d) return undefined;
  for (const nid of d.neighbors || []) {
    const n = domainById(world, nid);
    if (n && controlsDomain(world, ownerId, n.possessionId)) return nid;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sièges
// ---------------------------------------------------------------------------

export const SIEGE_BASE_DAYS = 18;
export const SIEGE_DEV_FACTOR = 0.3;

/** Terrain plus accidenté/fortifiable → siège plus long (défense naturelle). */
const SIEGE_TERRAIN_FACTOR: Partial<Record<TerrainType, number>> = {
  mountains: 1.6,
  hills: 1.25,
  forest: 1.2,
  marsh: 1.3,
  desert: 1.15,
  plains: 0.9,
  farmland: 0.9,
  coast: 0.95,
  scrub: 1.0,
};

function terrainSiegeFriction(d: Domaine | undefined): number {
  if (!d?.terrainType) return 1;
  return SIEGE_TERRAIN_FACTOR[d.terrainType] ?? 1;
}

/** Durée de référence (terrain + développement) — module la vitesse, pas un plancher absolu. */
export function siegeDaysFor(domain: Domaine): number {
  const base = SIEGE_BASE_DAYS + (domain.development ?? 30) * SIEGE_DEV_FACTOR;
  return Math.max(1, Math.round(base * terrainSiegeFriction(domain)));
}

/** Habitants par « défenseur implicite » (garnison locale déduite de la population). */
export const SIEGE_POP_PER_DEFENDER = 120;
/** Garnison minimale même pour un hameau — un siège n’est jamais gratuit. */
export const SIEGE_MIN_DEFENSE = 40;
/** Vitesse maximale (multiplicateur) quand l’attaquant écrase largement la garnison. */
export const SIEGE_MAX_SPEED_FACTOR = 3;

/** Effectif défenseur implicite du domaine assiégé, déduit de sa population. */
export function siegeDefenseStrength(domain: Domaine): number {
  return Math.max(SIEGE_MIN_DEFENSE, Math.round((domain.population ?? 0) / SIEGE_POP_PER_DEFENDER));
}

// ---------------------------------------------------------------------------
// Batailles
// ---------------------------------------------------------------------------

export const BATTLE_DAILY_CASUALTY_RATE = 0.06;
export const BATTLE_RETREAT_FRACTION = 0.2;
export const ARMY_MIN_TROOPS = 50;
export const ARMY_DISBAND_RETURN_FRACTION = 0.5;
/** Fraction du manpower encore en réserve qui survit à une défaite écrasante (armée anéantie). */
export const BATTLE_DEFEAT_MANPOWER_FACTOR = 0.15;

function removeArmy(game: GameState, id: number): void {
  game.armies = game.armies.filter((a) => a.id !== id);
}

function startNextLegOrIdle(game: GameState, army: Army): void {
  if (army.path && army.path.length) {
    const next = army.path[0];
    chargeNavalEmbarkation(game, army, army.domainId, next);
    army.legDays = legDaysBetween(game.world, army.domainId, next);
    army.legProgress = 0;
    army.stance = "moving";
  } else {
    army.stance = "idle";
    army.path = undefined;
    army.legDays = undefined;
    army.legProgress = undefined;
  }
}

/**
 * Parmi les guerres où `ownerId` est partie prenante (principal ou allié),
 * celle dont le camp adverse tient effectivement ce domaine — sert à
 * réaffecter une armée déjà levée vers une autre guerre en cours sans avoir
 * besoin de lever une nouvelle armée.
 */
function relevantWarForDomain(game: GameState, ownerId: number, domain: Domaine): WarState | undefined {
  for (const war of game.wars) {
    const side = warSideOf(war, ownerId);
    if (!side) continue;
    if (controlsDomain(game.world, opposingSideId(war, ownerId), domain.possessionId)) return war;
  }
  return undefined;
}

function handleArrival(game: GameState, army: Army): void {
  const domain = domainById(game.world, army.domainId);
  if (!domain) {
    army.stance = "idle";
    return;
  }
  // Une armée hostile est déjà stationnée ici (garnison, retraite, siège en
  // cours…) — peu importe qui possède politiquement le territoire, on ne
  // traverse pas en silence : on s’arrête, `detectBattles` engage le combat
  // juste après dans le même tick.
  const hostileHere = game.armies.some(
    (o) =>
      o.id !== army.id &&
      o.domainId === army.domainId &&
      (o.stance === "idle" || o.stance === "sieging" || o.stance === "battling") &&
      !areArmiesFriendly(game, army, o),
  );
  if (hostileHere) {
    army.stance = "idle";
    return;
  }

  // Une armée déjà levée n'a pas besoin d'être relevée pour servir une autre
  // guerre en cours : si sa destination est le théâtre d'un conflit
  // différent où son possesseur est partie prenante (et que sa guerre
  // d'origine ne concerne plus ce domaine), elle change d'allégeance de
  // guerre à son arrivée plutôt que de forcer une nouvelle levée coûteuse.
  const currentWar = activeWarById(game, army.warId);
  const currentApplies =
    !!currentWar && controlsDomain(game.world, opposingSideId(currentWar, army.ownerId), domain.possessionId);
  const relevantWar = currentApplies ? currentWar : relevantWarForDomain(game, army.ownerId, domain);
  if (relevantWar && relevantWar.id !== army.warId) {
    army.warId = relevantWar.id;
  }

  const war = activeWarById(game, army.warId);
  if (!war) {
    army.stance = "idle";
    army.path = undefined;
    return;
  }
  const enemySide = opposingSideId(war, army.ownerId);
  const myCaptured = warSideOf(war, army.ownerId) === "attacker" ? war.capturedByAttacker : war.capturedByDefender;
  const alreadyOccupiedByMe = (myCaptured || []).includes(domain.id);
  if (!alreadyOccupiedByMe && controlsDomain(game.world, enemySide, domain.possessionId)) {
    army.stance = "sieging";
    army.siegeProgress = 0;
    army.siegeDays = siegeDaysFor(domain);
    const owner = findPossession(game.world, army.ownerId);
    pushLog(
      game,
      `${owner?.holderName ?? "An army"} lays siege to ${domain.name}.`,
      [war.attackerId, war.defenderId],
    );
    return;
  }
  startNextLegOrIdle(game, army);
}

/**
 * Deux armées hostiles qui se croisent sur le même tronçon (l’une va de A
 * vers B, l’autre de B vers A) doivent se rencontrer plutôt que se dépasser
 * sans jamais se battre. Celle qui a le moins de jours de marche restants
 * arrive la première : on la fait arriver ce jour-là, dans le domaine de
 * l’autre (qui n’a pas encore quitté le sien) — bataille aussitôt via
 * `detectBattles`, appelé juste après dans le même `tickArmies`, avant que
 * `runAiWarConduct` (appelé par l’appelant, après tickArmies) n’ait la
 * moindre chance de redonner un ordre de marche à l’une ou l’autre. En cas
 * d’égalité de jours restants, l’armée en défense (dans sa propre guerre)
 * reste sur son terrain — c’est l’attaquant qui vient à elle.
 */
function interceptCrossingMarches(game: GameState): void {
  const handled = new Set<number>();
  const moving = game.armies.filter((a) => a.stance === "moving" && a.path?.length);
  for (const a of moving) {
    if (handled.has(a.id)) continue;
    const aNext = a.path?.[0];
    if (aNext == null) continue;
    for (const b of moving) {
      if (b.id === a.id || handled.has(b.id)) continue;
      if (areArmiesFriendly(game, a, b)) continue;
      const bNext = b.path?.[0];
      if (bNext == null) continue;
      if (a.domainId !== bNext || b.domainId !== aNext) continue;

      const daysLeftA = (a.legDays ?? 1) - (a.legProgress ?? 0);
      const daysLeftB = (b.legDays ?? 1) - (b.legProgress ?? 0);
      let advancing = a;
      let stationary = b;
      if (daysLeftB < daysLeftA) {
        advancing = b;
        stationary = a;
      } else if (daysLeftA === daysLeftB) {
        const warA = activeWarById(game, a.warId);
        const warB = activeWarById(game, b.warId);
        const aDefends = !!warA && warSideOf(warA, a.ownerId) === "defender";
        const bDefends = !!warB && warSideOf(warB, b.ownerId) === "defender";
        if (aDefends && !bDefends) {
          advancing = b;
          stationary = a;
        }
        // sinon (a avance déjà par défaut) : b défend seul, ou aucun/les deux — ordre d'origine.
      }

      advancing.path?.shift();
      advancing.domainId = stationary.domainId;
      advancing.legProgress = 0;
      advancing.legDays = undefined;
      advancing.stance = "idle";
      stationary.stance = "idle";
      handled.add(advancing.id);
      handled.add(stationary.id);

      const advOwner = findPossession(game.world, advancing.ownerId);
      const statOwner = findPossession(game.world, stationary.ownerId);
      pushLog(
        game,
        `${advOwner?.holderName ?? "An army"} runs into ${statOwner?.holderName ?? "an enemy"} while crossing its path.`,
        [advancing.ownerId, stationary.ownerId],
      );
      break;
    }
  }
}

function advanceMarches(game: GameState): void {
  for (const army of game.armies) {
    if (army.stance !== "moving") continue;
    army.legProgress = (army.legProgress ?? 0) + 1;
    if ((army.legProgress ?? 0) < (army.legDays ?? 1)) continue;
    const arrivedId = army.path?.shift();
    if (arrivedId == null) {
      army.stance = "idle";
      army.path = undefined;
      continue;
    }
    army.domainId = arrivedId;
    handleArrival(game, army);
  }
}

/**
 * Regroupe des armées co-localisées en « factions » (union-find) : deux
 * armées sont dans la même faction si même possesseur, alliées, ou même
 * camp d'une guerre commune. Deux factions distinctes présentes au même
 * endroit sont hostiles l'une à l'autre même si leurs guerres respectives
 * n'ont rien à voir — un envahisseur tiers reste un envahisseur, on se bat
 * aussi contre lui.
 */
/**
 * Deux armées sont « amies » (jamais hostiles l’une à l’autre) si même
 * possesseur, alliées, ou même camp d’une guerre commune — utilisé aussi
 * bien pour regrouper les factions en bataille que pour détecter un
 * croisement hostile en cours de marche.
 */
function areArmiesFriendly(game: GameState, a: Army, b: Army): boolean {
  if (a.ownerId === b.ownerId || areAllied(game.alliances, a.ownerId, b.ownerId)) return true;
  if (a.warId === b.warId) {
    const war = activeWarById(game, a.warId);
    if (war) {
      const sideA = warSideOf(war, a.ownerId);
      return sideA != null && sideA === warSideOf(war, b.ownerId);
    }
  }
  return false;
}

function computeFactions(game: GameState, armies: Army[]): Map<number, Army[]> {
  const parent = new Map<number, number>();
  function find(id: number): number {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const a of armies) parent.set(a.id, a.id);

  for (let i = 0; i < armies.length; i++) {
    for (let j = i + 1; j < armies.length; j++) {
      const a = armies[i];
      const b = armies[j];
      if (find(a.id) === find(b.id)) continue;
      if (areArmiesFriendly(game, a, b)) union(a.id, b.id);
    }
  }

  const factions = new Map<number, Army[]>();
  for (const a of armies) {
    const root = find(a.id);
    const list = factions.get(root) ?? [];
    list.push(a);
    factions.set(root, list);
  }
  return factions;
}

function detectBattles(game: GameState): void {
  const stationary = game.armies.filter(
    (a) => a.stance === "idle" || a.stance === "sieging" || a.stance === "battling",
  );
  const byDomain = new Map<number, Army[]>();
  for (const a of stationary) {
    const list = byDomain.get(a.domainId) ?? [];
    list.push(a);
    byDomain.set(a.domainId, list);
  }

  for (const [domainId, list] of byDomain) {
    if (list.length < 2) continue;
    const factions = computeFactions(game, list);
    if (factions.size < 2) continue;
    if (list.every((a) => a.stance === "battling")) continue;

    const domain = domainById(game.world, domainId);
    pushLog(
      game,
      `Battle erupts at ${domain?.name ?? `domain ${domainId}`}!`,
      list.map((a) => a.ownerId),
    );
    for (const faction of factions.values()) {
      const factionIds = new Set(faction.map((a) => a.id));
      const opponentIds = list.filter((a) => !factionIds.has(a.id)).map((a) => a.id);
      for (const a of faction) {
        if (a.stance !== "battling") a.battleStartTroops = a.troops;
        a.stance = "battling";
        a.battleOpponentIds = opponentIds;
      }
    }
  }
}

function progressSieges(game: GameState): void {
  for (const army of game.armies) {
    if (army.stance !== "sieging") continue;
    const siegedDomain = domainById(game.world, army.domainId);
    if (!siegedDomain) continue;

    // Pas assez de troupes face à la garnison implicite (population) : le
    // siège stagne — il faut masser des forces suffisantes pour avancer.
    const defense = siegeDefenseStrength(siegedDomain);
    if (army.troops < defense) continue;

    // Force en excès face à la garnison → siège plus rapide (jusqu’à 3×).
    const speedFactor = Math.min(SIEGE_MAX_SPEED_FACTOR, army.troops / defense);
    army.siegeProgress = (army.siegeProgress ?? 0) + speedFactor;
    if ((army.siegeProgress ?? 0) < (army.siegeDays ?? SIEGE_BASE_DAYS)) continue;

    const war = activeWarById(game, army.warId);
    const domain = siegedDomain;
    const owner = findPossession(game.world, army.ownerId);
    if (!war || !owner) {
      army.stance = "idle";
      continue;
    }

    // Le domaine passe sous occupation militaire (hachures) mais ne change
    // pas réellement de mains — le transfert n’a lieu qu’à la résolution de
    // la guerre (« appuyer nos exigences »), et seulement pour les domaines
    // du war goal (claim). `capturedByAttacker/Defender` sert d’état
    // d’occupation, pas d’historique de transferts déjà faits.
    if (warSideOf(war, army.ownerId) === "attacker") {
      if (!war.capturedByAttacker.includes(domain.id)) {
        war.capturedByAttacker = [...war.capturedByAttacker, domain.id];
      }
    } else if (!war.capturedByDefender.includes(domain.id)) {
      war.capturedByDefender = [...war.capturedByDefender, domain.id];
    }
    pushLog(
      game,
      `${owner.holderName}'s host occupies ${domain.name} after a siege.`,
      [war.attackerId, war.defenderId],
    );

    army.siegeProgress = undefined;
    army.siegeDays = undefined;
    startNextLegOrIdle(game, army);
  }
}

function applyCasualties(armies: Army[], total: number, loss: number): void {
  if (total <= 0 || loss <= 0) return;
  for (const a of armies) {
    const share = Math.round((loss * a.troops) / total);
    a.troops = Math.max(0, a.troops - share);
  }
}

function exitBattle(game: GameState, army: Army): void {
  army.battleOpponentIds = undefined;
  army.battleStartTroops = undefined;
  if (army.siegeDays != null) {
    army.stance = "sieging";
  } else {
    startNextLegOrIdle(game, army);
  }
}

function maybeRetreat(game: GameState, survivors: Army[]): void {
  if (!survivors.length) return;
  const startTotal = survivors.reduce((s, a) => s + (a.battleStartTroops ?? a.troops), 0);
  const nowTotal = survivors.reduce((s, a) => s + a.troops, 0);
  if (startTotal <= 0 || nowTotal / startTotal >= BATTLE_RETREAT_FRACTION) return;

  const fromDomainId = survivors[0].domainId;
  const dest = nearestFriendlyDomain(game.world, fromDomainId, survivors[0].ownerId);
  for (const a of survivors) {
    a.stance = "idle";
    a.path = undefined;
    a.siegeProgress = undefined;
    a.siegeDays = undefined;
    a.battleOpponentIds = undefined;
    a.battleStartTroops = undefined;
    if (dest != null) a.domainId = dest;
  }
  const domainName = domainById(game.world, fromDomainId)?.name ?? "the field";
  const ownerName = findPossession(game.world, survivors[0].ownerId)?.holderName ?? "An army";
  pushLog(
    game,
    `${ownerName} routs from ${domainName} and retreats.`,
    survivors.map((a) => a.ownerId),
  );
}

/**
 * Résolution quotidienne des batailles, par domaine — pas par guerre : une
 * bataille peut opposer plus de deux factions (guerres différentes qui se
 * disputent le même terrain). Chaque faction encaisse des pertes
 * proportionnelles au total de TOUT ce qui lui fait face (généralisation à
 * N camps du modèle à deux camps).
 */
function resolveBattles(game: GameState): void {
  const battling = game.armies.filter((a) => a.stance === "battling");
  const byDomain = new Map<number, Army[]>();
  for (const a of battling) {
    const list = byDomain.get(a.domainId) ?? [];
    list.push(a);
    byDomain.set(a.domainId, list);
  }

  for (const [domainId, list] of byDomain) {
    const factions = computeFactions(game, list);
    if (factions.size < 2) {
      for (const a of list) exitBattle(game, a);
      continue;
    }

    const totals = new Map<number, number>();
    for (const [root, members] of factions) {
      totals.set(root, members.reduce((s, a) => s + a.troops, 0));
    }
    const grandTotal = [...totals.values()].reduce((s, t) => s + t, 0);

    for (const [root, members] of factions) {
      const mine = totals.get(root) ?? 0;
      const enemyTotal = grandTotal - mine;
      applyCasualties(members, mine, Math.round(BATTLE_DAILY_CASUALTY_RATE * enemyTotal));
    }

    for (const a of list) {
      if (a.troops <= 0 || a.troops < ARMY_MIN_TROOPS) removeArmy(game, a.id);
    }

    const survivingFactions = new Map<number, Army[]>();
    for (const [root, members] of factions) {
      const survivors = members.filter((a) => game.armies.includes(a));
      if (survivors.length) survivingFactions.set(root, survivors);
    }

    const domainName = domainById(game.world, domainId)?.name ?? "the field";

    if (survivingFactions.size <= 1) {
      // Pénalité manpower pour chaque camp anéanti (principal + alliés).
      for (const [root, members] of factions) {
        if (survivingFactions.has(root)) continue;
        const ownerIds = new Set(members.map((a) => a.ownerId));
        for (const ownerId of ownerIds) {
          const p = findPossession(game.world, ownerId);
          if (p) p.manpower = Math.round((p.manpower ?? 0) * BATTLE_DEFEAT_MANPOWER_FACTOR);
        }
      }
      const winners = survivingFactions.size ? [...survivingFactions.values()][0] : [];

      // Progression de guerre : une bataille rangée gagnée compte en plus
      // des sièges. Seulement pour une bataille « propre » à une seule
      // guerre (le cas courant) — une mêlée à plusieurs guerres n'alimente
      // aucun score de guerre précis.
      if (winners.length) {
        const battleWarId = list[0].warId;
        if (list.every((a) => a.warId === battleWarId)) {
          const battleWar = activeWarById(game, battleWarId);
          const winnerSide = battleWar ? warSideOf(battleWar, winners[0].ownerId) : null;
          if (battleWar && winnerSide === "attacker") {
            battleWar.battleWinsAttacker = (battleWar.battleWinsAttacker ?? 0) + 1;
          } else if (battleWar && winnerSide === "defender") {
            battleWar.battleWinsDefender = (battleWar.battleWinsDefender ?? 0) + 1;
          }
        }
      }

      const winnerName = findPossession(game.world, winners[0]?.ownerId ?? -1)?.holderName;
      pushLog(
        game,
        `The battle at ${domainName} ends${winnerName ? ` — ${winnerName} triumphs` : ""}.`,
        list.map((a) => a.ownerId),
      );
      for (const a of winners) exitBattle(game, a);
      continue;
    }

    for (const members of survivingFactions.values()) {
      maybeRetreat(game, members);
    }
  }
}

/**
 * Reconquête silencieuse : un domaine occupé pendant la guerre (siège adverse
 * réussi) ne change jamais réellement de mains (`possessionId` intact — voir
 * `progressSieges`). Si mon armée est tranquillement chez moi sur un domaine
 * encore marqué « occupé » par l’ennemi et qu’aucune force adverse n’y tient
 * garnison, l’occupation n’a plus de rempart : elle tombe aussitôt, sans
 * siège en règle (l’ennemi n’a aucun titre dessus, juste une prise de guerre
 * qu’il ne défend plus).
 */
function reclaimUndefendedOccupations(game: GameState): void {
  for (const army of game.armies) {
    if (army.stance !== "idle") continue;
    const war = activeWarById(game, army.warId);
    if (!war) continue;
    const domain = domainById(game.world, army.domainId);
    if (!domain) continue;
    if (!controlsDomain(game.world, army.ownerId, domain.possessionId)) continue;

    const enemySide = opposingSideId(war, army.ownerId);
    const enemyCaptured = enemySide === war.attackerId ? war.capturedByAttacker : war.capturedByDefender;
    if (!(enemyCaptured || []).includes(domain.id)) continue;

    const enemyPresent = game.armies.some(
      (a) => a.ownerId === enemySide && a.warId === war.id && a.domainId === domain.id,
    );
    if (enemyPresent) continue; // laisser detectBattles/resolveBattles trancher d’abord

    if (enemySide === war.attackerId) {
      war.capturedByAttacker = war.capturedByAttacker.filter((id) => id !== domain.id);
    } else {
      war.capturedByDefender = war.capturedByDefender.filter((id) => id !== domain.id);
    }
    const owner = findPossession(game.world, army.ownerId);
    pushLog(
      game,
      `${owner?.holderName ?? "Loyal forces"} reclaim ${domain.name} from enemy occupation.`,
      [war.attackerId, war.defenderId],
    );
  }
}

/** Progression quotidienne de toutes les armées : marche, sièges, batailles. */
export function tickArmies(game: GameState): void {
  if (!game.armies?.length) return;
  interceptCrossingMarches(game);
  advanceMarches(game);
  detectBattles(game);
  progressSieges(game);
  resolveBattles(game);
  reclaimUndefendedOccupations(game);
}

/** Dissout toutes les armées d’une guerre — une partie de l’effectif regagne les levées disponibles. */
export function disbandWarArmies(game: GameState, war: WarState): void {
  const remaining: Army[] = [];
  for (const army of game.armies) {
    if (army.warId !== war.id) {
      remaining.push(army);
      continue;
    }
    const owner = findPossession(game.world, army.ownerId);
    if (owner) {
      const cap = levyCapacity(game.world, owner, game.opinions);
      const returned = Math.round(army.troops * ARMY_DISBAND_RETURN_FRACTION);
      owner.manpower = Math.min(cap, (owner.manpower ?? 0) + returned);
    }
  }
  game.armies = remaining;
}

/** Puissance restante d’un camp dans une guerre (levées + armées vivantes). */
/** Puissance restante d’un camp — inclut les alliés ayant rejoint la guerre à ses côtés. */
export function sideRemainingPower(game: GameState, warId: number, sideId: number): number {
  const owner = findPossession(game.world, sideId);
  const manpower = owner?.manpower ?? 0;
  const war = game.wars.find((w) => w.id === warId);
  const side = war ? warSideOf(war, sideId) : null;
  const armyTroops = game.armies
    .filter((a) => {
      if (a.warId !== warId) return false;
      return war && side ? warSideOf(war, a.ownerId) === side : a.ownerId === sideId;
    })
    .reduce((s, a) => s + a.troops, 0);
  return manpower + armyTroops;
}
