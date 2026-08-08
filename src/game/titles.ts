import type { Domaine, Possession, Province, WorldData } from "../types/world";
import { domainById } from "./army";
import { seaLinkedDomainNeighbors } from "./war";

function findPossession(world: WorldData, id: number): Possession | undefined {
  return (world.possessions || []).find((p) => p.id === id);
}

/**
 * Domaines groupés par province / royaume, mis en cache par référence de
 * `world.domaines` — évite de rescanner les ~700+ domaines à chaque province
 * (`claimWarDomainIds` était appelée une fois par province dans
 * `findProvinceWarGoal`, soit ~116 scans complets par évaluation de guerre IA).
 */
const domainsByProvinceCache = new WeakMap<Domaine[], Map<number, Domaine[]>>();
function domainsByProvince(domaines: Domaine[]): Map<number, Domaine[]> {
  let idx = domainsByProvinceCache.get(domaines);
  if (!idx) {
    idx = new Map();
    for (const d of domaines) {
      if (d.provinceId == null) continue;
      const list = idx.get(d.provinceId);
      if (list) list.push(d);
      else idx.set(d.provinceId, [d]);
    }
    domainsByProvinceCache.set(domaines, idx);
  }
  return idx;
}

const domainsByRoyaumeCache = new WeakMap<Domaine[], Map<number, Domaine[]>>();
function domainsByRoyaume(domaines: Domaine[]): Map<number, Domaine[]> {
  let idx = domainsByRoyaumeCache.get(domaines);
  if (!idx) {
    idx = new Map();
    for (const d of domaines) {
      if (d.royaumeId == null) continue;
      const list = idx.get(d.royaumeId);
      if (list) list.push(d);
      else idx.set(d.royaumeId, [d]);
    }
    domainsByRoyaumeCache.set(domaines, idx);
  }
  return idx;
}

function isUnderLiege(
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

export type TitleTier = "kingdom" | "province";

/** Titre de jure (royaume ou province). */
export interface Title {
  id: string;
  tier: TitleTier;
  /** Id du royaume ou de la province de jure. */
  deJureId: number;
  name: string;
  /** Possesseur actuel — undefined = vacant. */
  holderId?: number;
}

/** Revendication personnelle sur un titre. */
export interface TitleClaim {
  titleId: string;
  year: number;
}

export function kingdomTitleId(royaumeId: number): string {
  return `k-${royaumeId}`;
}

export function provinceTitleId(provinceId: number): string {
  return `p-${provinceId}`;
}

export function findTitle(titles: Title[], id: string): Title | undefined {
  return titles.find((t) => t.id === id);
}

export function findProvinceTitle(
  titles: Title[],
  provinceId: number,
): Title | undefined {
  return findTitle(titles, provinceTitleId(provinceId));
}

/** Peut être `undefined` : aucun titre de royaume n’existe avant d’être créé en jeu. */
export function findKingdomTitle(
  titles: Title[],
  royaumeId: number,
): Title | undefined {
  return findTitle(titles, kingdomTitleId(royaumeId));
}

/**
 * Démonyme informel d’un royaume avant que son titre n’existe (personne ne
 * l’a encore formé) — sert à afficher « Franks of Clovis » plutôt que
 * « Kingdom of the Franks » tant que le titre n’a pas été créé.
 * Indexé par code Royaume (stable) — pas par royaumeId, qui est un id
 * numérique émergent (ordre de première rencontre à la génération), donc
 * susceptible de bouger dès qu’un royaume est ajouté/retiré.
 */
const KINGDOM_DEMONYM: Record<string, string> = {
  SYAG: "Romans",
  FRAN: "Franks",
  OSTG: "Ostrogoths",
  BURG: "Burgundians",
  VISI: "Visigoths",
  AQUI: "Aquitanians",
  ANGL: "Anglo-Saxons",
  CARN: "Carinthians",
  SUEB: "Suebi",
  VAND: "Vandals",
  ALAM: "Alemanni",
  BRYT: "Bretons",
  THUR: "Thuringians",
  BRIT: "Britons",
  SAXO: "Saxons",
  BALE: "Balearics",
  CORS: "Corsicans",
  SARD: "Sardinians",
  FRIS: "Frisians",
  DANE: "Danes",
};

/** Remonte la chaîne de vassalité jusqu’au sommet (roi, ou indépendant). */
function topRuler(world: WorldData, p: Possession): Possession {
  let cur = p;
  const seen = new Set<number>([p.id]);
  while (cur.liegeId != null) {
    const next = findPossession(world, cur.liegeId);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

/**
 * Nom d’affichage du royaume d’une possession : le nom formel une fois le
 * titre créé par le roi de cette possession (« Kingdom of the Franks »),
 * sinon un nom informel tant que le royaume n’existe pas politiquement
 * (« Franks of Clovis »).
 */
export function realmDisplayName(
  world: WorldData,
  titles: Title[],
  possession: Possession,
): string {
  const royId = possession.royaumeId;
  if (royId == null) return possession.name;
  const ruler = topRuler(world, possession);
  const title = findKingdomTitle(titles, royId);
  if (title && title.holderId === ruler.id) return possession.name;
  const royaumeCode = (world.royaumes || []).find((r) => r.id === royId)?.code;
  const demonym = (royaumeCode && KINGDOM_DEMONYM[royaumeCode]) || possession.name;
  return `${demonym} of ${ruler.holderName}`;
}

export function titlesHeldBy(titles: Title[], possessionId: number): Title[] {
  return titles.filter((t) => t.holderId === possessionId);
}

export function hasClaim(
  possession: Possession,
  titleId: string,
): boolean {
  return (possession.claims || []).some((c) => c.titleId === titleId);
}

export function addClaim(
  possession: Possession,
  titleId: string,
  year: number,
): void {
  if (!possession.claims) possession.claims = [];
  if (possession.claims.some((c) => c.titleId === titleId)) return;
  possession.claims.push({ titleId, year });
}

export function removeClaim(possession: Possession, titleId: string): void {
  if (!possession.claims?.length) return;
  possession.claims = possession.claims.filter((c) => c.titleId !== titleId);
}

/** Domaine contrôlé par `controllerId` (demesne ou vassal sous lui). */
export function controlsDomain(
  world: WorldData,
  controllerId: number,
  domainPossessionId: number | undefined,
): boolean {
  if (domainPossessionId == null) return false;
  if (domainPossessionId === controllerId) return true;
  const holder = findPossession(world, domainPossessionId);
  if (!holder) return false;
  return isUnderLiege(world, holder, controllerId);
}

export interface ProvinceControl {
  total: number;
  owned: number;
  ratio: number;
  domainIds: number[];
  ownedDomainIds: number[];
}

/** Contrôle de facto d’une province (demesne + sujets). */
export function provinceControl(
  world: WorldData,
  possessionId: number,
  provinceId: number,
): ProvinceControl {
  const province = (world.provinces || []).find((p) => p.id === provinceId);
  const domainIds = province?.domaines?.length
    ? [...province.domaines]
    : world.domaines
        .filter((d) => d.provinceId === provinceId)
        .map((d) => d.id);
  const ownedDomainIds: number[] = [];
  for (const id of domainIds) {
    const d = domainById(world, id);
    if (!d) continue;
    if (controlsDomain(world, possessionId, d.possessionId)) {
      ownedDomainIds.push(id);
    }
  }
  const total = domainIds.length;
  const owned = ownedDomainIds.length;
  return {
    total,
    owned,
    ratio: total > 0 ? owned / total : 0,
    domainIds,
    ownedDomainIds,
  };
}

/** Seuil pour usurper / revendiquer un titre de province (> 2/3). */
export const PROVINCE_CLAIM_THRESHOLD = 2 / 3;
/** Or minimum pour usurper un titre de province. */
export const PROVINCE_TITLE_MIN_GOLD = 80;
/** Prestige de base gagné en prenant un titre de province. */
export const PROVINCE_TITLE_BASE_PRESTIGE = 25;

/** Seuil pour usurper / créer un titre de royaume (> 4/5). */
export const KINGDOM_CLAIM_THRESHOLD = 4 / 5;
/** Or minimum pour usurper / créer un titre de royaume. */
export const KINGDOM_TITLE_MIN_GOLD = 300;
/** Prestige de base gagné en prenant un titre de royaume. */
export const KINGDOM_TITLE_BASE_PRESTIGE = 60;

const RANK_WEIGHT: Record<string, number> = {
  king: 4,
  vassal: 2,
  subvassal: 1,
  chief: 1,
};

/**
 * Meilleur détenteur de facto d’une province (demesne + sujets).
 * En cas d’égalité, préfère le rang le plus haut (roi > vassal).
 */
export function bestProvinceController(
  world: WorldData,
  provinceId: number,
): { possession: Possession; control: ProvinceControl } | null {
  let best: { possession: Possession; control: ProvinceControl } | null = null;
  for (const p of world.possessions || []) {
    const control = provinceControl(world, p.id, provinceId);
    if (control.owned <= 0) continue;
    if (!best) {
      best = { possession: p, control };
      continue;
    }
    if (control.owned > best.control.owned) {
      best = { possession: p, control };
      continue;
    }
    if (control.owned < best.control.owned) continue;
    const rw = RANK_WEIGHT[p.rank] ?? 0;
    const brw = RANK_WEIGHT[best.possession.rank] ?? 0;
    if (rw > brw) best = { possession: p, control };
    else if (rw === brw && p.id < best.possession.id) {
      best = { possession: p, control };
    }
  }
  return best;
}

/** Contrôle de facto d’un royaume (demesne + sujets). */
export function kingdomControl(
  world: WorldData,
  possessionId: number,
  royaumeId: number,
): ProvinceControl {
  const roy = (world.royaumes || []).find((r) => r.id === royaumeId);
  const domainIds = roy?.domaines?.length
    ? [...roy.domaines]
    : world.domaines
        .filter((d) => d.royaumeId === royaumeId)
        .map((d) => d.id);
  const ownedDomainIds: number[] = [];
  for (const id of domainIds) {
    const d = domainById(world, id);
    if (!d) continue;
    if (controlsDomain(world, possessionId, d.possessionId)) {
      ownedDomainIds.push(id);
    }
  }
  const total = domainIds.length;
  const owned = ownedDomainIds.length;
  return {
    total,
    owned,
    ratio: total > 0 ? owned / total : 0,
    domainIds,
    ownedDomainIds,
  };
}

export function provinceTitleGoldCost(control: ProvinceControl): number {
  return Math.max(
    PROVINCE_TITLE_MIN_GOLD,
    Math.round(50 + control.owned * 22 + control.total * 8),
  );
}

export function provinceTitlePrestigeGain(control: ProvinceControl): number {
  return Math.max(
    PROVINCE_TITLE_BASE_PRESTIGE,
    Math.round(18 + control.owned * 5 + control.total * 3),
  );
}

/** Royaumes plus vastes que les provinces — coefficients par domaine plus bas. */
export function kingdomTitleGoldCost(control: ProvinceControl): number {
  return Math.max(
    KINGDOM_TITLE_MIN_GOLD,
    Math.round(120 + control.owned * 8 + control.total * 3),
  );
}

export function kingdomTitlePrestigeGain(control: ProvinceControl): number {
  return Math.max(
    KINGDOM_TITLE_BASE_PRESTIGE,
    Math.round(35 + control.owned * 3 + control.total),
  );
}

export function canUsurpProvinceTitle(
  world: WorldData,
  titles: Title[],
  actor: Possession,
  provinceId: number,
): { ok: boolean; reason?: string; title?: Title; control: ProvinceControl } {
  const title = findProvinceTitle(titles, provinceId);
  const control = provinceControl(world, actor.id, provinceId);
  if (!title) {
    return { ok: false, reason: "No province title", control };
  }
  if (title.holderId === actor.id) {
    return { ok: false, reason: "You already hold this title", title, control };
  }
  if (control.ratio <= PROVINCE_CLAIM_THRESHOLD) {
    return {
      ok: false,
      reason: `Need more than two-thirds of the domains (${control.owned}/${control.total})`,
      title,
      control,
    };
  }
  return { ok: true, title, control };
}

/**
 * Usurpe/crée un titre de royaume. Contrairement aux provinces, aucun titre
 * de royaume n’existe au lancement de la partie — `title` est `undefined`
 * tant que personne ne l’a créé, ce qui est traité comme vacant.
 */
export function canUsurpKingdomTitle(
  world: WorldData,
  titles: Title[],
  actor: Possession,
  royaumeId: number,
): { ok: boolean; reason?: string; title?: Title; control: ProvinceControl } {
  const title = findKingdomTitle(titles, royaumeId);
  const control = kingdomControl(world, actor.id, royaumeId);
  if (title && title.holderId === actor.id) {
    return { ok: false, reason: "You already hold this title", title, control };
  }
  if (control.ratio <= KINGDOM_CLAIM_THRESHOLD) {
    return {
      ok: false,
      reason: `Need more than four-fifths of the domains (${control.owned}/${control.total})`,
      title,
      control,
    };
  }
  return { ok: true, title, control };
}

/** Provinces minimum pour fonder un royaume imaginaire. */
export const IMAGINARY_KINGDOM_MIN_PROVINCES = 3;
/** Années d’attente avant que le drift vole les provinces à l’ancien royaume. */
export const IMAGINARY_KINGDOM_DRIFT_YEARS = 10;

/**
 * Contrôle « plein » sur un ensemble de domaines déjà détenus — pour appliquer
 * la même formule de coût/prestige (`kingdomTitleGoldCost`/`kingdomTitlePrestigeGain`)
 * à la fondation d’un royaume imaginaire qu’à la revendication d’un royaume
 * existant : même geste politique, même prix.
 */
export function fullControlFromDomains(domainIds: number[]): ProvinceControl {
  return {
    owned: domainIds.length,
    total: domainIds.length,
    ratio: 1,
    domainIds,
    ownedDomainIds: domainIds,
  };
}

/**
 * Cluster connecté (via province.neighbors) de `size` provinces détenues par
 * `actor`, en partant de `seedProvinceId`. BFS glouton — déterministe selon
 * l’ordre des voisins. `null` si le cluster n’atteint pas `size`.
 */
export function connectedHeldProvinceCluster(
  world: WorldData,
  titles: Title[],
  actor: Possession,
  seedProvinceId: number,
  size: number = IMAGINARY_KINGDOM_MIN_PROVINCES,
): number[] | null {
  const heldProvinceIds = new Set(
    titlesHeldBy(titles, actor.id)
      .filter((t) => t.tier === "province")
      .map((t) => t.deJureId),
  );
  if (!heldProvinceIds.has(seedProvinceId)) return null;

  const visited = new Set<number>([seedProvinceId]);
  const order = [seedProvinceId];
  const queue = [seedProvinceId];
  while (queue.length && order.length < size) {
    const cur = queue.shift()!;
    const prov = (world.provinces || []).find((p) => p.id === cur);
    if (!prov) continue;
    for (const nid of prov.neighbors || []) {
      if (order.length >= size) break;
      if (visited.has(nid) || !heldProvinceIds.has(nid)) continue;
      visited.add(nid);
      order.push(nid);
      queue.push(nid);
    }
  }
  return order.length >= size ? order.slice(0, size) : null;
}

export interface ImaginaryKingdomCheck {
  ok: boolean;
  reason?: string;
  provinceIds?: number[];
  domainIds?: number[];
}

/**
 * Fonder un royaume imaginaire : il faut détenir ≥3 titres de province et un
 * cluster connecté de 3 d’entre elles en partant de `seedProvinceId`. Casse
 * volontairement la carte de jure — les provinces choisies restent listées
 * dans leur royaume d’origine jusqu’au drift (10 ans).
 */
export function canFoundImaginaryKingdom(
  world: WorldData,
  titles: Title[],
  actor: Possession,
  seedProvinceId: number,
): ImaginaryKingdomCheck {
  const heldCount = titlesHeldBy(titles, actor.id).filter(
    (t) => t.tier === "province",
  ).length;
  if (heldCount < IMAGINARY_KINGDOM_MIN_PROVINCES) {
    return {
      ok: false,
      reason: `Need ${IMAGINARY_KINGDOM_MIN_PROVINCES} province titles (have ${heldCount})`,
    };
  }
  const seedTitle = findProvinceTitle(titles, seedProvinceId);
  if (seedTitle?.holderId !== actor.id) {
    return { ok: false, reason: "You don't hold this province's title" };
  }
  const provinceIds = connectedHeldProvinceCluster(
    world,
    titles,
    actor,
    seedProvinceId,
  );
  if (!provinceIds) {
    return {
      ok: false,
      reason: `No connected cluster of ${IMAGINARY_KINGDOM_MIN_PROVINCES} held provinces from here`,
    };
  }
  const domainIds = provinceIds.flatMap((pid) => {
    const p = (world.provinces || []).find((x) => x.id === pid);
    return p?.domaines || [];
  });
  return { ok: true, provinceIds, domainIds };
}

/**
 * Objectif de guerre pour une province :
 * domaines de la province contrôlés par le défenseur (demesne + sujets)
 * et non déjà contrôlés par l’attaquant.
 */
export function claimWarDomainIds(
  world: WorldData,
  attackerId: number,
  defenderId: number,
  provinceId: number,
): number[] {
  const out: number[] = [];
  for (const d of domainsByProvince(world.domaines).get(provinceId) || []) {
    if (!controlsDomain(world, defenderId, d.possessionId)) continue;
    if (controlsDomain(world, attackerId, d.possessionId)) continue;
    out.push(d.id);
  }
  return out;
}

/** Domaines d’un royaume tenus par le défenseur, non déjà tenus par l’attaquant. */
export function claimWarDomainIdsInRoyaume(
  world: WorldData,
  attackerId: number,
  defenderId: number,
  royaumeId: number,
): number[] {
  const out: number[] = [];
  for (const d of domainsByRoyaume(world.domaines).get(royaumeId) || []) {
    if (!controlsDomain(world, defenderId, d.possessionId)) continue;
    if (controlsDomain(world, attackerId, d.possessionId)) continue;
    out.push(d.id);
  }
  return out;
}

/**
 * Une guerre de titre est possible si l’attaquant :
 * - détient le titre de province et le défenseur y contrôle des domaines, ou
 * - a une claim et le défenseur détient le titre (ou contrôle des domaines dedans).
 */
export function findProvinceWarGoal(
  world: WorldData,
  titles: Title[],
  attacker: Possession,
  defender: Possession,
): { title: Title; provinceId: number; domainIds: number[] } | null {
  const provinces = world.provinces || [];
  let best: { title: Title; provinceId: number; domainIds: number[] } | null =
    null;

  for (const prov of provinces) {
    const title = findProvinceTitle(titles, prov.id);
    if (!title) continue;
    const domains = claimWarDomainIds(
      world,
      attacker.id,
      defender.id,
      prov.id,
    );
    if (!domains.length) continue;

    const holdsTitle = title.holderId === attacker.id;
    const hasTitleClaim = hasClaim(attacker, title.id);
    const defenderHoldsTitle = title.holderId === defender.id;

    if (holdsTitle) {
      if (!best || domains.length > best.domainIds.length) {
        best = { title, provinceId: prov.id, domainIds: domains };
      }
      continue;
    }

    if (hasTitleClaim && (defenderHoldsTitle || domains.length > 0)) {
      if (!best || domains.length > best.domainIds.length) {
        best = { title, provinceId: prov.id, domainIds: domains };
      }
    }
  }

  return best;
}

/**
 * Même logique que `findProvinceWarGoal`, à l’échelle du royaume. Un titre
 * de royaume ne peut être un war goal que s’il a déjà été créé en jeu.
 */
export function findKingdomWarGoal(
  world: WorldData,
  titles: Title[],
  attacker: Possession,
  defender: Possession,
): { title: Title; royaumeId: number; domainIds: number[] } | null {
  const royaumes = world.royaumes || [];
  let best: { title: Title; royaumeId: number; domainIds: number[] } | null =
    null;

  for (const roy of royaumes) {
    const title = findKingdomTitle(titles, roy.id);
    if (!title) continue;
    const domains = claimWarDomainIdsInRoyaume(
      world,
      attacker.id,
      defender.id,
      roy.id,
    );
    if (!domains.length) continue;

    const holdsTitle = title.holderId === attacker.id;
    const hasTitleClaim = hasClaim(attacker, title.id);
    const defenderHoldsTitle = title.holderId === defender.id;

    if (holdsTitle) {
      if (!best || domains.length > best.domainIds.length) {
        best = { title, royaumeId: roy.id, domainIds: domains };
      }
      continue;
    }

    if (hasTitleClaim && (defenderHoldsTitle || domains.length > 0)) {
      if (!best || domains.length > best.domainIds.length) {
        best = { title, royaumeId: roy.id, domainIds: domains };
      }
    }
  }

  return best;
}

/** Cibles possibles pour des guerres de titre de royaume (hors voisinage / gates). */
export function listKingdomWarTargets(
  world: WorldData,
  titles: Title[],
  attacker: Possession,
): {
  defenderId: number;
  title: Title;
  royaumeId: number;
  domainIds: number[];
}[] {
  const out: {
    defenderId: number;
    title: Title;
    royaumeId: number;
    domainIds: number[];
  }[] = [];
  const seen = new Set<string>();

  for (const title of titles) {
    if (title.tier !== "kingdom") continue;
    const royaumeId = title.deJureId;
    const holdsTitle = title.holderId === attacker.id;
    const hasTitleClaim = hasClaim(attacker, title.id);
    if (!holdsTitle && !hasTitleClaim) continue;

    for (const p of world.possessions || []) {
      if (p.id === attacker.id) continue;
      const domainIds = claimWarDomainIdsInRoyaume(
        world,
        attacker.id,
        p.id,
        royaumeId,
      );
      if (!domainIds.length) continue;
      const key = `${p.id}:${royaumeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ defenderId: p.id, title, royaumeId, domainIds });
    }
  }

  return out;
}

/** Cibles possibles pour des guerres de titre (hors voisinage / gates). */
export function listProvinceWarTargets(
  world: WorldData,
  titles: Title[],
  attacker: Possession,
): {
  defenderId: number;
  title: Title;
  provinceId: number;
  domainIds: number[];
}[] {
  const out: {
    defenderId: number;
    title: Title;
    provinceId: number;
    domainIds: number[];
  }[] = [];
  const seen = new Set<string>();

  for (const title of titles) {
    if (title.tier !== "province") continue;
    const provinceId = title.deJureId;
    const holdsTitle = title.holderId === attacker.id;
    const hasTitleClaim = hasClaim(attacker, title.id);
    if (!holdsTitle && !hasTitleClaim) continue;

    for (const p of world.possessions || []) {
      if (p.id === attacker.id) continue;
      const domainIds = claimWarDomainIds(
        world,
        attacker.id,
        p.id,
        provinceId,
      );
      if (!domainIds.length) continue;
      const key = `${p.id}:${provinceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ defenderId: p.id, title, provinceId, domainIds });
    }
  }

  return out;
}

function provinceName(province: Province): string {
  return province.name || `Province ${province.id}`;
}

/**
 * Nom d’un titre de royaume — pas de titre de royaume au lancement de la
 * partie : ils sont créés en jeu via `claimKingdomTitle` (contrôle > 4/5).
 */
export function kingdomTitleName(roy: { id: number; name?: string }): string {
  return roy.name || `Kingdom ${roy.id}`;
}

/**
 * Crée les titres de jure (provinces uniquement) et attribue les détenteurs
 * initiaux selon le contrôle de facto (demesne + vassaux), seuil > 2/3.
 * Les titres de royaume n’existent pas au lancement — ils se gagnent en jeu.
 */
export function buildInitialTitles(world: WorldData): Title[] {
  const titles: Title[] = [];

  for (const prov of world.provinces || []) {
    const id = provinceTitleId(prov.id);
    // Contrôle de facto (demesne + vassaux) — sans toucher aux possessions
    const best = bestProvinceController(world, prov.id);
    let holderId: number | undefined;
    if (
      best &&
      best.control.total > 0 &&
      best.control.ratio > PROVINCE_CLAIM_THRESHOLD
    ) {
      holderId = best.possession.id;
    }
    titles.push({
      id,
      tier: "province",
      deJureId: prov.id,
      name: `Lord of ${provinceName(prov)}`,
      holderId,
    });
  }

  return titles;
}

/**
 * Donne aux rois des claims de jure sur les titres de province de leur
 * royaume qu’ils ne détiennent pas encore — mais seulement s’ils en
 * contrôlent déjà substantiellement les domaines (> 2/3, même seuil que la
 * revendication pacifique du titre). Être simplement de jure dans le
 * royaume ne suffit pas : sans présence réelle sur place, il n’y a rien à
 * revendiquer.
 */
export function seedDeJureProvinceClaims(
  world: WorldData,
  titles: Title[],
  year: number,
): void {
  for (const prov of world.provinces || []) {
    const title = findProvinceTitle(titles, prov.id);
    if (!title || prov.royaumeId == null) continue;
    for (const p of world.possessions || []) {
      if (p.rank !== "king") continue;
      if (p.royaumeId !== prov.royaumeId) continue;
      if (title.holderId === p.id) continue;
      // Pas de claim si le titulaire est déjà son vassal (le roi devrait
      // déjà tenir le titre via le contrôle de realm — filet de sécurité).
      if (
        title.holderId != null &&
        controlsDomain(world, p.id, title.holderId)
      ) {
        continue;
      }
      const control = provinceControl(world, p.id, prov.id);
      if (control.ratio <= PROVINCE_CLAIM_THRESHOLD) continue;
      addClaim(p, title.id, year);
    }
  }
}

/** Profondeur féodale : 0 = indépendant, 1 = vassal, 2 = sous-vassal. */
export function vassalDepth(world: WorldData, p: Possession): number {
  let depth = 0;
  let cur: Possession | undefined = p;
  const seen = new Set<number>();
  while (cur?.liegeId != null) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    depth += 1;
    cur = findPossession(world, cur.liegeId);
  }
  return depth;
}

/** Max : roi → chef de province → détenteur de domaine. */
export const MAX_VASSAL_DEPTH = 2;

/** Durée de base pour fabriquer une claim de domaine (jours). */
export const DOMAIN_CLAIM_BASE_DAYS = 40;
/** Or minimum pour lancer une fabrication. */
export const DOMAIN_CLAIM_MIN_GOLD = 30;
/** Prestige gagné quand la claim de domaine est prête. */
export const DOMAIN_CLAIM_PRESTIGE = 12;

export function hasDomainClaim(possession: Possession, domainId: number): boolean {
  return (possession.domainClaims || []).includes(domainId);
}

export function addDomainClaim(possession: Possession, domainId: number): void {
  if (!possession.domainClaims) possession.domainClaims = [];
  if (!possession.domainClaims.includes(domainId)) {
    possession.domainClaims.push(domainId);
  }
}

export function removeDomainClaim(possession: Possession, domainId: number): void {
  if (!possession.domainClaims?.length) return;
  possession.domainClaims = possession.domainClaims.filter((id) => id !== domainId);
}

/** Coût or pour lancer la fabrication (revenu × 10, plancher). */
export function domainClaimGoldCost(domain: {
  income?: number;
  development?: number;
}): number {
  const income = domain.income ?? 3;
  const dev = domain.development ?? 20;
  return Math.max(
    DOMAIN_CLAIM_MIN_GOLD,
    Math.round(income * 10 + dev * 0.35),
  );
}

/** Prestige à la complétion de la fabrication. */
export function domainClaimPrestigeGain(domain: {
  income?: number;
  development?: number;
}): number {
  const income = domain.income ?? 3;
  const dev = domain.development ?? 20;
  return Math.max(
    DOMAIN_CLAIM_PRESTIGE,
    Math.round(8 + income * 1.5 + dev * 0.15),
  );
}

/** Durée en jours (plus long si le domaine est développé). */
export function domainClaimDaysRequired(domain: {
  development?: number;
}): number {
  const dev = domain.development ?? 20;
  return Math.round(DOMAIN_CLAIM_BASE_DAYS + dev * 0.5);
}

/** Le domaine touche-t-il le realm de `actor` (demesne + sujets) ? */
export function isDomainAdjacentToRealm(
  world: WorldData,
  actorId: number,
  domainId: number,
): boolean {
  // Traverse la mer comme la guerre / l'alliance (courte traversée seulement,
  // voir `seaLinkedDomainNeighbors`) — une revendication ne doit pas être
  // plus restrictive que ce qu'on peut déjà attaquer ou avec qui s'allier.
  for (const nid of seaLinkedDomainNeighbors(world, domainId)) {
    const n = domainById(world, nid);
    if (!n) continue;
    if (controlsDomain(world, actorId, n.possessionId)) return true;
  }
  return false;
}

/**
 * Guerre pour domaines revendiqués unitairement :
 * claims de `attacker.domainClaims` contrôlés par le défenseur.
 */
export function findDomainWarGoal(
  world: WorldData,
  attacker: Possession,
  defender: Possession,
): { domainIds: number[]; label: string } | null {
  const claims = attacker.domainClaims || [];
  if (!claims.length) return null;
  const domainIds: number[] = [];
  const names: string[] = [];
  for (const id of claims) {
    const d = domainById(world, id);
    if (!d) continue;
    if (!controlsDomain(world, defender.id, d.possessionId)) continue;
    if (controlsDomain(world, attacker.id, d.possessionId)) continue;
    domainIds.push(id);
    names.push(d.name);
  }
  if (!domainIds.length) return null;
  const label =
    names.length === 1
      ? `claim on ${names[0]}`
      : `claims on ${names.slice(0, 2).join(", ")}${names.length > 2 ? "…" : ""}`;
  return { domainIds, label };
}

export type ResolvedWarGoal = {
  domainIds: number[];
  label: string;
  claimTitleId?: string;
  claimProvinceId?: number;
  claimRoyaumeId?: number;
  kind: "province" | "kingdom" | "domain";
};

/** Priorité : titre de province, puis titre de royaume, sinon claims de domaines. */
export function findWarGoal(
  world: WorldData,
  titles: Title[],
  attacker: Possession,
  defender: Possession,
): ResolvedWarGoal | null {
  const province = findProvinceWarGoal(world, titles, attacker, defender);
  if (province) {
    return {
      domainIds: province.domainIds,
      label: province.title.name,
      claimTitleId: province.title.id,
      claimProvinceId: province.provinceId,
      kind: "province",
    };
  }
  const kingdom = findKingdomWarGoal(world, titles, attacker, defender);
  if (kingdom) {
    return {
      domainIds: kingdom.domainIds,
      label: kingdom.title.name,
      claimTitleId: kingdom.title.id,
      claimRoyaumeId: kingdom.royaumeId,
      kind: "kingdom",
    };
  }
  const domain = findDomainWarGoal(world, attacker, defender);
  if (domain) {
    return {
      domainIds: domain.domainIds,
      label: domain.label,
      kind: "domain",
    };
  }
  return null;
}
