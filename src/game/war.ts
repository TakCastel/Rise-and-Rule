import type { Possession, WorldData } from "../types/world";
import { allyTroopContribution } from "./alliance";
import { disbandWarArmies, domainById } from "./army";
import {
  addGold,
  addPrestige,
  formatGold,
  formatPrestige,
  warVictoryDomainGold,
  warVictoryGold,
  warVictoryPrestige,
} from "./economy";
import { economyFocusMultiplier, prestigeFocusMultiplier } from "./focus";
import {
  WAR_NEIGHBOR_FEAR_MALUS,
  adjustOpinion,
  applyNeighborFearMalus,
} from "./opinion";
import { levyCapacity, possessionPower } from "./power";
import {
  IMAGINARY_KINGDOM_DRIFT_YEARS,
  MAX_VASSAL_DEPTH,
  addClaim,
  findTitle,
  removeClaim,
  removeDomainClaim,
  vassalDepth,
} from "./titles";
import type { Alliance, CasusBelli, GameState, WarState } from "./types";
import { pushLog, triggerGameOver } from "./types";

export function findPossession(world: WorldData, id: number): Possession | undefined {
  return (world.possessions || []).find((p) => p.id === id);
}

/**
 * Suzerain indépendant en tête de chaîne féodale (soi-même si indépendant).
 */
export function getTopLiege(world: WorldData, p: Possession): Possession {
  let cur = p;
  const seen = new Set<number>();
  while (cur.liegeId != null) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    const next = findPossession(world, cur.liegeId);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/**
 * Défenseur d’une guerre de conquête : le suzerain protège ses vassaux
 * contre toute attaque externe. Les rivalités internes au même royaume
 * (co-vassaux, etc.) restent des guerres directes.
 */
export function resolveWarDefender(
  world: WorldData,
  attacker: Possession,
  target: Possession,
): Possession {
  if (target.liegeId == null) return target;
  const attackerTop = getTopLiege(world, attacker);
  const targetTop = getTopLiege(world, target);
  if (attackerTop.id === targetTop.id) return target;
  return targetTop;
}

/**
 * Hiérarchie de rang pour les guerres de vassaux :
 * king > vassal ≈ chief > subvassal.
 * Un vassal ne peut attaquer que son propre rang ou inférieur
 * (pas le rang de son supérieur).
 */
export function feudalRankTier(rank: Possession["rank"]): number {
  if (rank === "king") return 3;
  if (rank === "vassal" || rank === "chief") return 2;
  return 1; // subvassal
}

/** Vassal / sous-vassal : uniquement vs rang égal ou inférieur (défenseur effectif). */
export function canAttackByRank(
  attacker: Possession,
  defender: Possession,
): boolean {
  if (attacker.liegeId == null) return true;
  return feudalRankTier(defender.rank) <= feudalRankTier(attacker.rank);
}

/** Même suzerain indépendant (même royaume de facto). */
export function areSameRealm(
  world: WorldData,
  a: Possession,
  b: Possession,
): boolean {
  return getTopLiege(world, a).id === getTopLiege(world, b).id;
}

/**
 * `subject` est-il dans la chaîne féodale sous `liegeId`
 * (vassal direct, sous-vassal, etc.) ?
 */
export function isUnderLiege(
  world: WorldData,
  subject: Possession,
  liegeId: number,
): boolean {
  let cur: Possession | undefined = subject;
  const seen = new Set<number>();
  while (cur?.liegeId != null) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    if (cur.liegeId === liegeId) return true;
    cur = findPossession(world, cur.liegeId);
  }
  return false;
}

/**
 * Traversée maritime max (en cellules de mer) pour qu'un rivage compte
 * comme « voisin » d'un autre — une mer étroite / un détroit court (Douvres–
 * Calais, Sicile–Tunisie, Galles–Irlande…), pas l'intégralité d'un bassin
 * maritime interconnecté. Calibré sur `public/world.json` : Douvres–Calais
 * ≈ 1, Galles–Irlande ≈ 2, Sicile–Tunisie ≈ 3, Douvres–Danemark ≈ 7,
 * Angleterre–Espagne ≈ 10 (à exclure), Douvres–Italie ≈ 35.
 */
const MAX_SEA_HOPS = 3;

/**
 * Voisins d'un domaine « traversant la mer » : ses voisins terrestres directs,
 * plus — pour tout voisin maritime — tout domaine terrestre atteignable en ne
 * traversant que des cellules de mer contiguës, dans la limite de
 * `MAX_SEA_HOPS` cellules (une mer étroite proche, pas l'océan tout entier).
 * La mer elle-même n'apparaît jamais dans le résultat : seuls les rivages de
 * part et d'autre comptent.
 * Sert uniquement à la portée diplomatique (guerre / allégeance / fabrication
 * de revendication) — le déplacement des armées reste sur le graphe brut
 * `Domaine.neighbors`, où chaque cellule de mer est une étape à part entière.
 */
export function seaLinkedDomainNeighbors(world: WorldData, domainId: number): number[] {
  const start = domainById(world, domainId);
  if (!start) return [];
  const out = new Set<number>();
  const seaHops = new Map<number, number>();
  const queue: number[] = [...(start.neighbors || [])];
  for (const nid of queue) {
    const n = domainById(world, nid);
    if (n?.terrainType === "sea") seaHops.set(nid, 1);
  }
  let qi = 0;
  while (qi < queue.length) {
    const nid = queue[qi++];
    const n = domainById(world, nid);
    if (!n) continue;
    if (n.terrainType === "sea") {
      const hops = seaHops.get(nid) ?? 1;
      if (hops > MAX_SEA_HOPS) continue;
      for (const nn of n.neighbors || []) {
        if (seaHops.has(nn)) continue;
        const nnDomain = domainById(world, nn);
        if (nnDomain?.terrainType === "sea") seaHops.set(nn, hops + 1);
        queue.push(nn);
      }
    } else {
      out.add(nid);
    }
  }
  return [...out];
}

/**
 * Voisinage de facto pour guerre / allégeance :
 * les domaines du demesne **et** des vassaux comptent, en traversant
 * transparemment toute mer navigable contiguë (voir `seaLinkedDomainNeighbors`)
 * — deux royaumes côtiers séparés par la même mer deviennent voisins.
 * Ainsi un roi dont le vassal touche l’ennemi (par terre ou par-delà la mer)
 * est bien « nearby ».
 */
export function rebuildPossessionNeighbors(world: WorldData): void {
  const list = world.possessions || [];
  const nb = list.map(() => new Set<number>());
  const index = new Map(list.map((p, i) => [p.id, i]));
  const byId = new Map(list.map((p) => [p.id, p]));

  /** Titulaire + suzerain (le blob carte Possession). */
  function controllers(possessionId: number): number[] {
    const out = [possessionId];
    const p = byId.get(possessionId);
    if (p?.liegeId != null) out.push(p.liegeId);
    return out;
  }

  for (const d of world.domaines) {
    if (d.possessionId == null) continue;
    const aHolders = controllers(d.possessionId);
    for (const nid of seaLinkedDomainNeighbors(world, d.id)) {
      const o = domainById(world, nid);
      if (!o || o.possessionId == null || o.possessionId === d.possessionId) continue;
      const bHolders = controllers(o.possessionId);
      for (const a of aHolders) {
        for (const b of bHolders) {
          if (a === b) continue;
          const ia = index.get(a);
          const ib = index.get(b);
          if (ia == null || ib == null) continue;
          nb[ia].add(b);
          nb[ib].add(a);
        }
      }
    }
  }
  for (let i = 0; i < list.length; i++) list[i].neighbors = [...nb[i]];
}

function recomputeCentroid(world: WorldData, p: Possession): void {
  const members = p.domaines.map((id) => domainById(world, id)).filter(Boolean);
  if (!members.length) return;
  let sx = 0,
    sy = 0;
  for (const d of members) {
    sx += d!.centroid[0];
    sy += d!.centroid[1];
  }
  p.centroid = [sx / members.length, sy / members.length];
}

export function detachFromLiege(world: WorldData, p: Possession): void {
  if (p.liegeId == null) return;
  const liege = findPossession(world, p.liegeId);
  if (liege) {
    liege.vassalIds = (liege.vassalIds || []).filter((id) => id !== p.id);
  }
  p.liegeId = undefined;
}

/**
 * Le suzerain reprend tous les vassaux directs de `from` (rébellion écrasée).
 * Les sous-vassaux restent sous leurs seigneurs respectifs.
 */
export function stripVassalsToLiege(
  world: WorldData,
  from: Possession,
  liege: Possession,
): number {
  const taken = [...(from.vassalIds || [])];
  if (!taken.length) return 0;
  from.vassalIds = [];
  for (const vid of taken) {
    const v = findPossession(world, vid);
    if (!v) continue;
    detachFromLiege(world, v);
    attachAsVassal(world, v, liege);
  }
  from.boundary = undefined;
  liege.boundary = undefined;
  return taken.length;
}

/**
 * Après une défaite du joueur : jamais de bascule vers un autre personnage —
 * Game Over si anéanti, déposé, ou déjà sans vassaux.
 */
export function checkPlayerGameOver(
  game: GameState,
  loserId: number,
  winnerName: string,
  ctx?: { vassalsBefore: number; wasVassalBefore: boolean },
): boolean {
  if (game.playerId !== loserId) return false;
  const live = findPossession(game.world, loserId);
  if (!live || live.domaines.length === 0) {
    if (live) {
      removePossession(game.world, loserId);
      purgeOpinionsFor(game, loserId);
    }
    triggerGameOver(
      game,
      `Defeated by ${winnerName}. Your line is extinguished — game over.`,
    );
    return true;
  }
  if (ctx?.vassalsBefore === 0 && ctx.wasVassalBefore) {
    triggerGameOver(
      game,
      `Defeated by ${winnerName}. With no vassals left to rebuild, this last war ends your rule — game over.`,
    );
    return true;
  }
  return false;
}

/** Le joueur a perdu le trône / tout : Game Over, sans changer de personnage. */
export function endPlayerAsDefeated(
  game: GameState,
  playerId: number,
  winnerName: string,
  reason: string,
): void {
  if (game.playerId !== playerId) return;
  const live = findPossession(game.world, playerId);
  if (live && live.domaines.length === 0) {
    removePossession(game.world, playerId);
    purgeOpinionsFor(game, playerId);
  }
  triggerGameOver(game, reason || `Defeated by ${winnerName} — game over.`);
}

/**
 * Attache `subject` comme vassal de `liege` (détache d’un éventuel suzerain précédent).
 * Profondeur max : roi → chef de province → seigneur de domaine (pas plus).
 * Rang : vassal sous un indépendant, subvassal si le suzerain a lui-même un seigneur.
 */
export function attachAsVassal(
  world: WorldData,
  subject: Possession,
  liege: Possession,
): void {
  if (subject.id === liege.id) return;

  // Liege déjà au fond de la pyramide → remonter d’un cran
  let realLiege = liege;
  if (vassalDepth(world, liege) >= MAX_VASSAL_DEPTH) {
    const top = getTopLiege(world, liege);
    if (top.id === subject.id) return;
    realLiege = top;
  }

  detachFromLiege(world, subject);

  // Si on devient sous-vassal, aplatir nos propres vassaux (sinon 4e niveau)
  if (vassalDepth(world, realLiege) >= 1 && (subject.vassalIds || []).length) {
    stripVassalsToLiege(world, subject, realLiege);
  }

  subject.liegeId = realLiege.id;
  if (!realLiege.vassalIds) realLiege.vassalIds = [];
  if (!realLiege.vassalIds.includes(subject.id)) {
    realLiege.vassalIds.push(subject.id);
  }
  subject.rank = realLiege.liegeId != null ? "subvassal" : "vassal";

  // Descendants restants → sous-vassaux
  const byId = new Map((world.possessions || []).map((p) => [p.id, p]));
  const stack = [...(subject.vassalIds || [])];
  const seen = new Set<number>([subject.id]);
  while (stack.length) {
    const vid = stack.pop()!;
    if (seen.has(vid)) continue;
    seen.add(vid);
    const v = byId.get(vid);
    if (!v) continue;
    v.rank = "subvassal";
    // Interdire un 4e niveau : rattacher au même liege intermédiaire
    if ((v.vassalIds || []).length) {
      stripVassalsToLiege(world, v, subject.liegeId != null ? realLiege : subject);
    }
    for (const sid of v.vassalIds || []) stack.push(sid);
  }
  if (realLiege.rank === "chief") realLiege.rank = "king";
  realLiege.boundary = undefined;
  subject.boundary = undefined;
}

export function removePossession(world: WorldData, id: number): void {
  const list = world.possessions || [];
  const p = list.find((x) => x.id === id);
  if (!p) return;
  detachFromLiege(world, p);
  for (const vid of [...(p.vassalIds || [])]) {
    const v = findPossession(world, vid);
    if (v) {
      v.liegeId = undefined;
      if (v.rank === "vassal" || v.rank === "subvassal") v.rank = "chief";
    }
  }
  // Domaines orphelins → fond de carte évité : détacher la référence
  for (const did of p.domaines) {
    const d = domainById(world, did);
    if (d && d.possessionId === id) d.possessionId = undefined;
  }
  for (const d of world.domaines) {
    if (d.possessionId === id) d.possessionId = undefined;
  }
  world.possessions = list.filter((x) => x.id !== id);
}

export function purgeOpinionsFor(game: GameState, deadId: number): void {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(game.opinions)) {
    const [a, b] = k.split(">");
    if (Number(a) === deadId || Number(b) === deadId) continue;
    next[k] = v;
  }
  game.opinions = next;
  if (game.alliances?.length) {
    game.alliances = game.alliances.filter(
      (a) => a.aId !== deadId && a.bId !== deadId,
    );
  }
}

export function transferDomains(
  world: WorldData,
  from: Possession,
  to: Possession,
  domainIds: number[],
): void {
  const take = new Set(domainIds);
  from.domaines = from.domaines.filter((id) => !take.has(id));
  for (const id of take) {
    const d = domainById(world, id);
    if (d) d.possessionId = to.id;
    if (!to.domaines.includes(id)) to.domaines.push(id);
  }
  // Contours précalculés invalides après transfert
  from.boundary = undefined;
  to.boundary = undefined;
  recomputeCentroid(world, from);
  recomputeCentroid(world, to);
}

/**
 * Province conquise par la guerre : à la différence d’une fondation de
 * royaume (immédiate), elle doit d’abord faire ses preuves — programme une
 * assimilation de jure dans le royaume du vainqueur, revérifiée par
 * `tickKingdomDrifts` dans `IMAGINARY_KINGDOM_DRIFT_YEARS` ans. No-op si le
 * vainqueur n’a pas encore de royaume, ou si la province en fait déjà partie.
 */
function scheduleProvinceDrift(game: GameState, winner: Possession, domainId: number): void {
  const targetRoyaumeId = getTopLiege(game.world, winner).royaumeId;
  if (targetRoyaumeId == null) return;
  const domain = domainById(game.world, domainId);
  const provinceId = domain?.provinceId;
  if (provinceId == null) return;
  const province = (game.world.provinces || []).find((p) => p.id === provinceId);
  if (!province || province.royaumeId === targetRoyaumeId) return;

  if (!game.kingdomDrifts) game.kingdomDrifts = [];
  if (game.nextDriftId == null) game.nextDriftId = 1;

  const existing = game.kingdomDrifts.find((d) => d.royaumeId === targetRoyaumeId);
  if (existing) {
    if (!existing.provinceIds.includes(provinceId)) {
      existing.provinceIds = [...existing.provinceIds, provinceId];
    }
    return;
  }
  game.kingdomDrifts.push({
    id: game.nextDriftId++,
    royaumeId: targetRoyaumeId,
    provinceIds: [provinceId],
    dueYear: game.year + IMAGINARY_KINGDOM_DRIFT_YEARS,
    dueMonth: game.month,
    dueDay: game.day,
    actorId: winner.id,
  });
}

/** Domaines du demesne + vassaux récursifs (base amie pour démarrer le BFS). */
function realmDomainIds(world: WorldData, p: Possession): Set<number> {
  const byId = new Map((world.possessions || []).map((x) => [x.id, x]));
  const out = new Set<number>();
  const seen = new Set<number>();

  function walk(pid: number) {
    if (seen.has(pid)) return;
    seen.add(pid);
    const cur = byId.get(pid);
    if (!cur) return;
    for (const id of cur.domaines) out.add(id);
    for (const vid of cur.vassalIds || []) walk(vid);
  }

  walk(p.id);
  return out;
}

/**
 * Ordre de conquête style OpenFront : BFS depuis la frontière commune.
 * Couvre tout le royaume de la cible (demesne + vassaux) — la guerre se gagne
 * en envahissant 100 % du territoire adverse, pas seulement le war goal (qui
 * ne détermine que le butin transféré à la victoire).
 */
export function buildConquestOrder(
  world: WorldData,
  advancing: Possession,
  target: Possession,
): number[] {
  const friendly = realmDomainIds(world, advancing);
  const targets = realmDomainIds(world, target);
  if (!targets.size) return [];

  const dist = new Map<number, number>();
  const queue: number[] = [];

  for (const id of targets) {
    const d = domainById(world, id);
    if (!d) continue;
    const touches = (d.neighbors || []).some((nid) => friendly.has(nid));
    if (touches) {
      dist.set(id, 0);
      queue.push(id);
    }
  }

  // Si aucune frontière directe (ex. enclave), partir du plus proche du centroïde
  if (!queue.length) {
    const [cx, cy] = advancing.centroid;
    let best: number | null = null;
    let bestD = Infinity;
    for (const id of targets) {
      const d = domainById(world, id);
      if (!d) continue;
      const dx = d.centroid[0] - cx;
      const dy = d.centroid[1] - cy;
      const dd = dx * dx + dy * dy;
      if (dd < bestD) {
        bestD = dd;
        best = id;
      }
    }
    if (best != null) {
      dist.set(best, 0);
      queue.push(best);
    }
  }

  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    const d = domainById(world, id);
    if (!d) continue;
    const base = dist.get(id) ?? 0;
    for (const nid of d.neighbors || []) {
      if (!targets.has(nid) || dist.has(nid)) continue;
      dist.set(nid, base + 1);
      queue.push(nid);
    }
  }

  // Domaines isolés restants
  for (const id of targets) {
    if (!dist.has(id)) {
      dist.set(id, 999);
      queue.push(id);
    }
  }

  const [cx, cy] = advancing.centroid;
  return [...targets].sort((a, b) => {
    const da = dist.get(a) ?? 999;
    const db = dist.get(b) ?? 999;
    if (da !== db) return da - db;
    const A = domainById(world, a);
    const B = domainById(world, b);
    if (!A || !B) return a - b;
    const dA = (A.centroid[0] - cx) ** 2 + (A.centroid[1] - cy) ** 2;
    const dB = (B.centroid[0] - cx) ** 2 + (B.centroid[1] - cy) ** 2;
    return dA - dB;
  });
}

function resolveIndependenceVictory(
  game: GameState,
  rebel: Possession,
  liege: Possession,
): void {
  detachFromLiege(game.world, rebel);
  rebel.rank =
    rebel.vassalIds && rebel.vassalIds.length > 0 ? "king" : "chief";
  rebel.boundary = undefined;
  liege.boundary = undefined;

  adjustOpinion(game.opinions, liege.id, rebel.id, -60);
  adjustOpinion(game.opinions, rebel.id, liege.id, -40);

  pushLog(
    game,
    `${rebel.holderName} wins independence from ${liege.holderName}. The feudal bond is broken.`,
    [rebel.id, liege.id],
  );
  if (game.playerId === rebel.id) {
    pushLog(game, `You are free. Your realm stands on its own.`);
  }
  rebuildPossessionNeighbors(game.world);
}

function resolveDeposeVictory(
  game: GameState,
  rebel: Possession,
  liege: Possession,
): void {
  const liegeName = liege.holderName;
  const upperLiegeId = liege.liegeId;

  // Hériter des vassaux du seigneur (sauf le rebelle)
  for (const vid of [...(liege.vassalIds || [])]) {
    if (vid === rebel.id) continue;
    const v = findPossession(game.world, vid);
    if (!v) continue;
    detachFromLiege(game.world, v);
    attachAsVassal(game.world, v, rebel);
    adjustOpinion(game.opinions, v.id, rebel.id, -10);
  }

  // Annexer le demesne restant du seigneur
  const loot = [...liege.domaines];
  if (loot.length) transferDomains(game.world, liege, rebel, loot);

  // Prendre la place féodale du seigneur
  detachFromLiege(game.world, rebel);
  if (upperLiegeId != null) {
    const upper = findPossession(game.world, upperLiegeId);
    if (upper) attachAsVassal(game.world, rebel, upper);
    else {
      rebel.rank = rebel.vassalIds?.length ? "king" : "chief";
    }
  } else {
    rebel.rank = rebel.vassalIds && rebel.vassalIds.length > 0 ? "king" : "chief";
  }

  pushLog(
    game,
    `${rebel.holderName} deposes ${liegeName} and seizes the realm.`,
    [rebel.id, liege.id],
  );

  for (const p of game.world.possessions || []) {
    if (p.id === rebel.id || p.id === liege.id) continue;
    adjustOpinion(game.opinions, p.id, rebel.id, -12);
  }

  // Seigneur déposé : sans terre → disparaît ; sinon vassal du vainqueur
  if (liege.domaines.length === 0) {
    const liegeId = liege.id;
    removePossession(game.world, liegeId);
    purgeOpinionsFor(game, liegeId);
    if (game.playerId === liegeId) {
      endPlayerAsDefeated(
        game,
        liegeId,
        rebel.holderName,
        `You have been deposed by ${rebel.holderName}. Your realm is lost — game over.`,
      );
    }
  } else {
    attachAsVassal(game.world, liege, rebel);
    adjustOpinion(game.opinions, liege.id, rebel.id, -80);
    if (game.playerId === liege.id) {
      // Perdre le trône = fin de partie (pas de bascule vers le rebelle)
      endPlayerAsDefeated(
        game,
        liege.id,
        rebel.holderName,
        `You have been deposed by ${rebel.holderName}. Your crown is forfeit — game over.`,
      );
    }
  }

  rebuildPossessionNeighbors(game.world);
}

/** Durée d’une trêve après la conclusion d’une guerre (années). */
export const WAR_TRUCE_YEARS = 1;

function truceKey(aId: number, bId: number): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

/** Année jusqu’à laquelle une trêve entre ces deux-là est en vigueur (undefined si aucune). */
export function truceUntilYear(game: GameState, aId: number, bId: number): number | undefined {
  return (game.warTruces || {})[truceKey(aId, bId)];
}

/** Trêve en cours entre les deux belligérants principaux d’une guerre conclue. */
export function isTruceActive(game: GameState, aId: number, bId: number): boolean {
  const until = truceUntilYear(game, aId, bId);
  return until != null && game.year < until;
}

/** Dissout les armées de la guerre, la retire des guerres actives, et impose une trêve entre les deux belligérants principaux. */
export function concludeWar(game: GameState, war: WarState): void {
  disbandWarArmies(game, war);
  game.wars = game.wars.filter((w) => w.id !== war.id);
  game.warTruces = {
    ...(game.warTruces || {}),
    [truceKey(war.attackerId, war.defenderId)]: game.year + WAR_TRUCE_YEARS,
  };
}

/**
 * Fin de guerre selon le casus belli :
 * - claim_province : transfert des domaines / titre claimés seulement (pas de vassalisation totale)
 * - depose : le rebelle prend la place du seigneur
 * - independence : le rebelle casse le lien féodal (sans annexion)
 */
export function resolveWarVictory(
  game: GameState,
  winnerId: number,
  loserId: number,
  casusBelli: CasusBelli = "claim_province",
  war?: WarState,
): void {
  const winner = findPossession(game.world, winnerId);
  const loser = findPossession(game.world, loserId);
  if (!winner || !loser) return;

  if (war) concludeWar(game, war);

  const prestigeGain = Math.round(
    warVictoryPrestige(loser.rank) * prestigeFocusMultiplier(winner) * 10,
  ) / 10;
  addPrestige(winner, prestigeGain);
  // Domaines effectivement récupérés : le war goal si claim war, sinon l'ampleur du territoire capturé par siège.
  const wonDomainCount =
    war?.warGoalDomainIds?.length ??
    ((war?.capturedByAttacker?.length ?? 0) + (war?.capturedByDefender?.length ?? 0));
  const goldGain = Math.round(
    (warVictoryGold(game.world, loser) + warVictoryDomainGold(wonDomainCount)) *
      economyFocusMultiplier(winner) *
      10,
  ) / 10;
  addGold(winner, goldGain);
  const parties = [winnerId, loserId];
  const logWar = (text: string) => pushLog(game, text, parties);
  logWar(
    `${winner.holderName} gains ${formatPrestige(prestigeGain)} prestige and plunders ${formatGold(goldGain)} gold from ${loser.holderName}'s realm.`,
  );

  const playerCtx =
    game.playerId === loserId
      ? {
          vassalsBefore: (loser.vassalIds || []).length,
          wasVassalBefore: loser.liegeId != null,
        }
      : null;

  /** Domaines effectivement pris par siège par le vainqueur pendant cette guerre. */
  const conqueredDomains = (): number[] => {
    if (!war) return [];
    return winnerId === war.attackerId
      ? war.capturedByAttacker || []
      : war.capturedByDefender || [];
  };

  /** Crainte chez les voisins du territoire conquis. */
  const applyFear = (domains: number[]) => {
    if (!domains.length) return;
    applyNeighborFearMalus(
      game,
      winnerId,
      domains,
      [winnerId, loserId],
      WAR_NEIGHBOR_FEAR_MALUS,
    );
  };

  const finishPlayerDefeat = () => {
    if (!playerCtx) return;
    checkPlayerGameOver(game, loserId, winner.holderName, playerCtx);
  };

  if (casusBelli === "independence") {
    // Seul le rebelle (attaquant) peut gagner l’indépendance
    if (winner.liegeId === loser.id) {
      resolveIndependenceVictory(game, winner, loser);
      return;
    }
    // Rebelle vaincu : le roi reprend ses vassaux
    logWar(
    `${loser.holderName}'s bid for independence fails. ${winner.holderName} tightens their grip.`,
  );
    const stripped = stripVassalsToLiege(game.world, loser, winner);
    adjustOpinion(game.opinions, loser.id, winner.id, -50);
    adjustOpinion(game.opinions, winner.id, loser.id, -30);
    applyFear(conqueredDomains());
    if (stripped > 0) {
      logWar(
    `${winner.holderName} seizes ${stripped} vassal${stripped > 1 ? "s" : ""} from ${loser.holderName}.`,
  );
    }
    if (game.playerId === loser.id) {
      pushLog(
        game,
        stripped > 0
          ? `Your rebellion is crushed. ${winner.holderName} takes your vassals; you remain under their rule.`
          : `Your rebellion is crushed. You remain a vassal of ${winner.holderName}.`,
      );
    }
    rebuildPossessionNeighbors(game.world);
    finishPlayerDefeat();
    return;
  }

  if (casusBelli === "depose") {
    if (winner.liegeId === loser.id) {
      resolveDeposeVictory(game, winner, loser);
      return;
    }
    // Rebelle vaincu face au seigneur → le roi reprend les vassaux
    logWar(
    `${loser.holderName}'s bid to depose ${winner.holderName} fails.`,
  );
    const stripped = stripVassalsToLiege(game.world, loser, winner);
    adjustOpinion(game.opinions, loser.id, winner.id, -70);
    applyFear(conqueredDomains());
    if (stripped > 0) {
      logWar(
    `${winner.holderName} seizes ${stripped} vassal${stripped > 1 ? "s" : ""} from ${loser.holderName}.`,
  );
    }
    if (loser.domaines.length === 0 && !(loser.vassalIds || []).length) {
      removePossession(game.world, loser.id);
      purgeOpinionsFor(game, loser.id);
      if (game.playerId === loserId) {
        rebuildPossessionNeighbors(game.world);
        finishPlayerDefeat();
        return;
      }
    } else if (loser.liegeId !== winner.id) {
      attachAsVassal(game.world, loser, winner);
    }
    if (game.playerId === loserId && findPossession(game.world, loserId)) {
      pushLog(
        game,
        stripped > 0
          ? `Your rebellion is crushed. Your vassals are forfeit; you remain under ${winner.holderName}.`
          : `Your rebellion is crushed. You remain under ${winner.holderName}.`,
      );
    }
    rebuildPossessionNeighbors(game.world);
    finishPlayerDefeat();
    return;
  }

  if (casusBelli === "vassalize") {
    // Seul l'agresseur (attaquant) gagne le droit de vassaliser en cas de victoire.
    if (war && winnerId === war.attackerId) {
      logWar(
        `${loser.holderName} submits to ${winner.holderName} after a failed defense.`,
      );
      applyFear(conqueredDomains());
      attachAsVassal(game.world, loser, winner);
      adjustOpinion(game.opinions, loser.id, winner.id, -40);
      if (game.playerId === loser.id) {
        pushLog(game, `You are forced to submit to ${winner.holderName} as their vassal.`);
      }
      rebuildPossessionNeighbors(game.world);
      finishPlayerDefeat();
      return;
    }
    // Le défenseur repousse la tentative de vassalisation — reste indépendant.
    logWar(
      `${winner.holderName} repels ${loser.holderName}'s bid to force their submission.`,
    );
    adjustOpinion(game.opinions, winnerId, loserId, -30);
    applyFear(conqueredDomains());
    finishPlayerDefeat();
    return;
  }

  // —— Guerre de titre / claim : uniquement le war goal ——
  resolveClaimProvinceVictory(game, winner, loser, war, {
    logWar,
    applyFear,
    finishPlayerDefeat,
    conqueredDomains,
  });
}

function resolveClaimProvinceVictory(
  game: GameState,
  winner: Possession,
  loser: Possession,
  war: WarState | undefined,
  ctx: {
    logWar: (text: string) => void;
    applyFear: (domains: number[]) => void;
    finishPlayerDefeat: () => void;
    conqueredDomains: () => number[];
  },
): void {
  const goalIds =
    war?.warGoalDomainIds?.length
      ? war.warGoalDomainIds
      : war?.conquestOrder || [];
  const goal = new Set(goalIds);

  // Domaines du war goal encore contrôlés par le perdant → vainqueur
  const remaining: number[] = [];
  for (const id of goal) {
    const d = domainById(game.world, id);
    if (!d || d.possessionId == null) continue;
    if (d.possessionId === winner.id) continue;
    const holder = findPossession(game.world, d.possessionId);
    if (!holder) continue;
    if (
      holder.id === loser.id ||
      isUnderLiege(game.world, holder, loser.id) ||
      (loser.liegeId != null && holder.id === loser.liegeId)
    ) {
      // Prendre si tenu par le perdant ou son sujet ; si le perdant est vassal,
      // ses domaines directs / sujets seulement
      if (
        holder.id === loser.id ||
        isUnderLiege(game.world, holder, loser.id)
      ) {
        remaining.push(id);
      }
    }
  }

  for (const id of remaining) {
    const d = domainById(game.world, id);
    if (!d || d.possessionId == null) continue;
    const holder = findPossession(game.world, d.possessionId);
    if (!holder || holder.id === winner.id) continue;
    transferDomains(game.world, holder, winner, [id]);
    scheduleProvinceDrift(game, winner, id);
  }

  const painted = ctx.conqueredDomains();
  ctx.applyFear(painted.length ? painted : remaining);

  // Transfert du titre contesté
  if (war?.claimTitleId) {
    const title = findTitle(game.titles || [], war.claimTitleId);
    if (title) {
      const prevHolderId = title.holderId;
      if (prevHolderId != null && prevHolderId !== winner.id) {
        const prev = findPossession(game.world, prevHolderId);
        if (prev) addClaim(prev, title.id, game.year);
      }
      title.holderId = winner.id;
      removeClaim(winner, title.id);
      ctx.logWar(`${winner.holderName} secures the title ${title.name}.`);
    }
  }

  // Claims de domaines satisfaites
  for (const id of goal) {
    removeDomainClaim(winner, id);
  }

  ctx.logWar(
    `${winner.holderName} wins the claim war against ${loser.holderName}. Only the contested lands change hands.`,
  );

  adjustOpinion(game.opinions, loser.id, winner.id, -45);
  adjustOpinion(game.opinions, winner.id, loser.id, -15);

  // Nettoyer possessions vidées (vassaux dépouillés)
  for (const p of [...(game.world.possessions || [])]) {
    if (p.id === winner.id) continue;
    if (p.domaines.length === 0 && !(p.vassalIds || []).length) {
      removePossession(game.world, p.id);
      purgeOpinionsFor(game, p.id);
    }
  }

  if (game.playerId === loser.id && findPossession(game.world, loser.id)) {
    pushLog(
      game,
      `You lost the claim war. Contested lands go to ${winner.holderName}; the rest of your realm stands.`,
    );
  }

  rebuildPossessionNeighbors(game.world);
  ctx.finishPlayerDefeat();
}

export function activeWarBetween(
  game: GameState,
  aId: number,
  bId: number,
): WarState | undefined {
  return game.wars.find(
    (w) =>
      (w.attackerId === aId && w.defenderId === bId) ||
      (w.attackerId === bId && w.defenderId === aId),
  );
}

/** Fraction de la capacité régénérée par mois (hors guerre). */
export const LEVY_REGEN_MONTHLY = 0.12;
/** Fraction du taux normal appliquée en guerre (campagnes longues : permet une 2e vague). */
export const LEVY_REGEN_WAR_FACTOR = 0.3;
/** Jours calendaires par mois (voir tick). */
export const DAYS_PER_MONTH = 30;

/** Remonte progressivement les levées vers la capacité — ralenti (pas stoppé) en guerre.
 *  Appelé chaque jour : même rythme qu’avant (~12 % / mois), lissé sur 30 jours.
 */
export function regenLevies(game: GameState): void {
  for (const p of game.world.possessions || []) {
    const cap = levyCapacity(game.world, p, game.opinions);
    if (cap <= 0) {
      p.manpower = 0;
      continue;
    }
    if (p.manpower == null) {
      p.manpower = cap;
      continue;
    }
    if (p.manpower >= cap) {
      p.manpower = cap;
      continue;
    }
    const inWar = game.wars.some(
      (w) => w.attackerId === p.id || w.defenderId === p.id,
    );
    // Même paliers mensuels qu’avant (dont plancher 1), répartis jour par jour ; ralenti en guerre.
    const monthlyStep = Math.max(1, Math.round(cap * LEVY_REGEN_MONTHLY));
    const step = (monthlyStep / DAYS_PER_MONTH) * (inWar ? LEVY_REGEN_WAR_FACTOR : 1);
    p.manpower = Math.min(cap, p.manpower + step);
  }
}

/** Levées rassemblées au début de campagne (demesne + vassaux + alliés). */
export function raiseTroops(
  world: WorldData,
  p: Possession,
  opinions?: Record<string, number>,
  alliances?: Alliance[],
): { total: number; host: number } {
  const host = possessionPower(world, p, opinions);
  const allies = allyTroopContribution(world, p, opinions, alliances);
  return {
    host: Math.max(0, Math.round(host)),
    total: Math.max(0, Math.round(host + allies)),
  };
}
