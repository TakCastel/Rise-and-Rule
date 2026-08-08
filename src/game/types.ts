import type { Possession, WorldData } from "../types/world";
import type { Army } from "./army";
import type { Title } from "./titles";

export type GameSpeed = 1 | 2 | 3;

export type GamePhase = "menu" | "pick" | "play" | "gameover";

export interface GameLogEntry {
  id: number;
  year: number;
  text: string;
  /** Si défini, la chronique n’affiche l’entrée que si un id touche le joueur. */
  involvedIds?: number[];
}

/**
 * Motif de guerre :
 * - claim_province : récupérer domaines / titre de province (borné)
 * - depose / independence : rébellion
 * - conquest : legacy (traité comme claim si possible)
 * - vassalize : soumettre un seigneur indépendant par la force (échec d'une
 *   allégeance demandée à l'amiable, ou initiative directe)
 */
export type CasusBelli =
  | "claim_province"
  | "conquest"
  | "depose"
  | "independence"
  | "vassalize";

/**
 * Guerre en cours — conduite manuellement via des armées (`Army`, voir
 * `army.ts`) : lever des levées, marcher, assiéger, combattre. Le `WarState`
 * ne porte plus de front automatique, seulement le contexte de déclaration
 * et les domaines effectivement capturés par siège de chaque côté.
 */
export interface WarState {
  id: number;
  attackerId: number;
  defenderId: number;
  attackerName: string;
  defenderName: string;
  /** Domaines du royaume défenseur en ordre BFS depuis la frontière — cible de conquête / dénominateur de victoire totale. */
  conquestOrder: number[];
  /** Domaines du royaume attaquant en ordre BFS depuis la frontière — cible symétrique si le défenseur envahit en retour. */
  attackerFrontOrder?: number[];
  /** Domaines pris par siège par l’attaquant depuis la déclaration. */
  capturedByAttacker: number[];
  /** Domaines pris par siège par le défenseur depuis la déclaration. */
  capturedByDefender: number[];
  /** Alliés ayant répondu à l’appel côté attaquant — lèvent leur propre armée dans cette guerre. */
  allyOfAttacker?: number[];
  /** Alliés ayant répondu à l’appel côté défenseur. */
  allyOfDefender?: number[];
  /** Alliés ayant déjà refusé un appel à l’aide dans cette guerre — plus resollicités. */
  declinedAllyCalls?: number[];
  /** Défaut : claim_province. */
  casusBelli?: CasusBelli;
  /** Titre contesté (guerres de province). */
  claimTitleId?: string;
  /** Province de jure du war goal. */
  claimProvinceId?: number;
  /** Royaume de jure du war goal. */
  claimRoyaumeId?: number;
  /** Domaines du war goal figés à la déclaration. */
  warGoalDomainIds?: number[];
  /** Batailles rangées remportées depuis la déclaration (hors sièges) — contribue à la progression de guerre. */
  battleWinsAttacker?: number;
  battleWinsDefender?: number;
  /** Jours consécutifs où l'attaquant tient l'intégralité du war goal — remis à 0 dès qu'un domaine du goal repasse aux mains adverses. */
  warGoalOccupiedDays?: number;
}

/** Alliance bilatérale (mariage / pacte). */
export interface Alliance {
  aId: number;
  bId: number;
  sinceYear: number;
}

/**
 * Royaume imaginaire fondé sur 3 provinces détenues : casse la carte de jure
 * (une province appartient temporairement à deux royaumes) jusqu’à ce que le
 * drift se résolve, 10 ans plus tard, en volant la province à l’ancien royaume.
 */
export interface PendingKingdomDrift {
  id: number;
  /** Royaume imaginaire nouvellement créé. */
  royaumeId: number;
  /** Provinces à voler à leur royaume d’origine à l’échéance. */
  provinceIds: number[];
  dueYear: number;
  dueMonth: number;
  dueDay: number;
  actorId: number;
}

/** Fabrication en cours d’une claim sur un domaine. */
export interface ClaimFabrication {
  id: number;
  actorId: number;
  domainId: number;
  /** Jours déjà passés. */
  daysElapsed: number;
  /** Durée totale en jours. */
  daysRequired: number;
  /** Or déjà payé au lancement. */
  goldPaid: number;
}

/**
 * Appel à l’aide en attente : `callerId` (partie prenante d’une guerre)
 * demande à `targetId` (son allié) de rejoindre `warId` avec sa propre
 * armée. Tant que `targetId` n’a pas répondu, la demande reste en attente —
 * si `targetId` est le joueur, elle s’affiche pour décision manuelle ; sinon
 * elle est résolue le jour même par l’IA.
 */
export interface AllyCallRequest {
  id: number;
  warId: number;
  callerId: number;
  targetId: number;
  daysElapsed: number;
}

/**
 * Demande d’allégeance en attente : `demanderId` exige la soumission de
 * `targetId` comme vassal. Si `targetId` est le joueur, une popup bloquante
 * exige une réponse manuelle (accepter/refuser) ; un refus déclenche une
 * guerre de vassalisation du demandeur contre lui. Sinon, résolue le jour
 * même (IA cible : chance minime de refus si elle se sent assez forte).
 */
export interface AllegianceDemand {
  id: number;
  demanderId: number;
  targetId: number;
  daysElapsed: number;
}

/** Bouton d’une notice modale — `id` est renvoyé à `onDismiss` pour distinguer le choix fait. */
export interface NoticeAction {
  id: string;
  label: string;
}

/**
 * Notice générique, bloquante par défaut : modale mettant le jeu en pause
 * tant qu’elle n’a pas été acquittée. Réutilisable pour n’importe quel
 * évènement méritant une confirmation explicite (pas juste une ligne de
 * chronique). Sans `actions`, l’UI affiche un simple bouton OK.
 *
 * `blocking: false` — notice informative empilable (ex. issue d’un appel à
 * l’aide allié) : ne met pas le jeu en pause et s’affiche en pile avec les
 * autres notices non bloquantes plutôt que de remplacer la précédente.
 */
export interface GameNotice {
  id: number;
  title?: string;
  message: string;
  actions?: NoticeAction[];
  blocking?: boolean;
}

export interface GameState {
  /** Carte vivante de la partie (clone mutable de l’état initial). */
  world: WorldData;
  phase: GamePhase;
  /** Possession contrôlée par le joueur. */
  playerId: number | null;
  year: number;
  /** 0–11 */
  month: number;
  /** 1–30 */
  day: number;
  /** Progression intra-jour 0…1 (front de guerre fluide). */
  dayProgress: number;
  playing: boolean;
  speed: GameSpeed;
  wars: WarState[];
  nextWarId: number;
  /** Armées en campagne (levées, marche, siège, bataille). */
  armies: Army[];
  nextArmyId: number;
  /** Titres de jure (royaume / province). */
  titles: Title[];
  /** Royaumes imaginaires en attente de drift (10 ans). */
  kingdomDrifts: PendingKingdomDrift[];
  nextDriftId: number;
  /** Fabrications de claims de domaine en cours. */
  claimFabrications: ClaimFabrication[];
  nextFabricationId: number;
  /** Opinion from→toward, clé « id>id », −100…100 */
  opinions: Record<string, number>;
  /** Cadeaux déjà envoyés : clé « fromId>towardId » */
  giftsSent: Record<string, true>;
  /** Trêves actives après une guerre conclue : clé « min:max » → année de fin (pas de nouvelle guerre entre les deux avant). */
  warTruces: Record<string, number>;
  /** Alliances actives (mariages / pactes). */
  alliances: Alliance[];
  /** Appels à l’aide en attente de réponse (guerre → allié sollicité). */
  allyCallRequests: AllyCallRequest[];
  nextAllyCallRequestId: number;
  /** Demandes d’allégeance en attente de réponse (popup si la cible est le joueur). */
  allegianceDemands: AllegianceDemand[];
  nextAllegianceDemandId: number;
  /** File des notices modales en attente d’acquittement (première = affichée). */
  notices: GameNotice[];
  nextNoticeId: number;
  log: GameLogEntry[];
  nextLogId: number;
  /** Texte affiché sur l’écran de défaite. */
  gameOverReason?: string;
}

export const START_YEAR = 486;

export function cloneWorld(template: WorldData): WorldData {
  return structuredClone(template);
}

export function getPlayer(game: GameState): Possession | null {
  if (game.playerId == null) return null;
  return (game.world.possessions || []).find((p) => p.id === game.playerId) || null;
}

/**
 * Cercle pertinent pour la chronique : joueur, seigneur, vassaux directs, voisins.
 */
export function chronicleCircleIds(game: GameState): Set<number> | null {
  const player = getPlayer(game);
  if (!player) return null;
  const ids = new Set<number>([player.id]);
  if (player.liegeId != null) ids.add(player.liegeId);
  for (const vid of player.vassalIds || []) ids.add(vid);
  for (const nid of player.neighbors || []) ids.add(nid);
  return ids;
}

export function isChronicleRelevant(
  game: GameState,
  involvedIds?: number[] | null,
): boolean {
  if (!involvedIds?.length) return true;
  const circle = chronicleCircleIds(game);
  if (!circle) return true;
  return involvedIds.some((id) => circle.has(id));
}

export function pushLog(
  game: GameState,
  text: string,
  involvedIds?: number[],
): void {
  if (!isChronicleRelevant(game, involvedIds)) return;
  game.log = [
    { id: game.nextLogId++, year: game.year, text, involvedIds },
    ...game.log,
  ].slice(0, 50);
}

/**
 * Met en file une notice modale bloquante (le jeu se met en pause tant
 * qu’elle n’a pas été acquittée par `dismissNotice`). Sans `actions`, l’UI
 * n’affiche qu’un bouton OK par défaut.
 */
export function pushNotice(
  game: GameState,
  message: string,
  opts?: { title?: string; actions?: NoticeAction[]; blocking?: boolean },
): void {
  if (!game.notices) game.notices = [];
  if (game.nextNoticeId == null) game.nextNoticeId = 1;
  game.notices = [
    ...game.notices,
    {
      id: game.nextNoticeId++,
      title: opts?.title,
      message,
      actions: opts?.actions,
      blocking: opts?.blocking,
    },
  ];
}

/** Acquitte (retire) une notice modale — le jeu ne reste en pause que si d’autres notices suivent. */
export function dismissNotice(game: GameState, noticeId: number): void {
  game.notices = (game.notices || []).filter((n) => n.id !== noticeId);
}

/** Fin de partie : pause + écran Game Over. */
export function triggerGameOver(game: GameState, reason: string): void {
  if (game.phase === "gameover") return;
  game.phase = "gameover";
  game.playing = false;
  game.gameOverReason = reason;
  pushLog(game, reason);
}
