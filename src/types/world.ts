export interface Domaine {
  id: number;
  code: string | null;
  name: string;
  /** Ville seed du domaine (expansion urbaine) */
  cityId?: number;
  /** Province parente (de jure) */
  provinceId?: number;
  /** Royaume parent (de jure) */
  royaumeId?: number;
  /**
   * Possession de facto qui tient ce domaine en demesne
   * (roi, vassal ou sous-vassal — null = non alloué).
   */
  possessionId?: number;
  /** Type de terrain (indépendant des royaumes) */
  terrainType?: TerrainType;
  /** Région terrain agrégée */
  terrainId?: number;
  /**
   * Progression économique / techno (0–100), indépendante de la politique.
   * Calée sur les foyers culturels urbains ~486.
   */
  development?: number;
  /** Superficie approximative (km²) du domaine. */
  areaKm2?: number;
  /**
   * Habitants estimés du hinterland (~486) : aire utile × densité basse
   * post-romaine × f(development). Une civitas riche ≈ quelques k–15k,
   * pas des dizaines de milliers type métropole.
   */
  population?: number;
  /**
   * Levée de campagne ≈ 2 % de la population (armées de terrain en milliers).
   */
  levies?: number;
  /**
   * Or rapporté chaque mois (taxes / rentes locales).
   * Calé sur development + population.
   */
  income?: number;
  centroid: [number, number];
  avgElevation: number;
  boundary: [number, number][][];
  neighbors: number[];
  historic?: boolean;
}

export interface Province {
  id: number;
  name: string;
  code: string | null;
  royaumeId: number;
  centroid: [number, number];
  /** Contour fusionné des domaines (sans arêtes internes) */
  boundary?: [number, number][][];
  /** Ids des domaines constitutifs */
  domaines: number[];
  neighbors: number[];
}

export interface Royaume {
  id: number;
  name: string;
  code: string | null;
  centroid: [number, number];
  /** Optionnel — contours toujours dérivés des domaines à l’affichage */
  boundary?: [number, number][][];
  /** Ids des domaines constitutifs (source de vérité géométrique) */
  domaines: number[];
  /** Ids des provinces constitutives */
  provinces?: number[];
  neighbors: number[];
}

/** Rang dans la hiérarchie de facto : roi → chef de province → seigneur de domaine. */
export type PossessionRank = "king" | "vassal" | "subvassal" | "chief";

/**
 * Possession de facto (~486).
 * Hiérarchie (3 niveaux max) :
 * - king / chief : indépendant (roi s’il a des vassaux ou un titre de royaume)
 * - vassal : chef de province sous un roi
 * - subvassal : détenteur de domaine sous un vassal (ne peut pas avoir de vassaux)
 */
export interface Possession {
  id: number;
  /** Nom du royaume (affiché sur la carte pour les rois) */
  name: string;
  /** Personnage titulaire (Clovis, Alaric II…) */
  holderName: string;
  /** Titre anglais court */
  title: string;
  code: string | null;
  rank: PossessionRank;
  /** Suzerain (vassal → roi, subvassal → vassal) */
  liegeId?: number;
  /** Vassaux directs (vide tant que non peuplé) */
  vassalIds: number[];
  /** Lien souple vers un realm de jure (couleur) — pas une équivalence */
  royaumeId?: number;
  centroid: [number, number];
  boundary?: [number, number][][];
  /** Domaines tenus en demesne direct */
  domaines: number[];
  neighbors: number[];
  /** Trésor (or) — mis à jour en jeu. */
  gold?: number;
  /** Prestige — mis à jour en jeu (taille du territoire / allégeances). */
  prestige?: number;
  /**
   * Enfants disponibles comme jetons de mariage (alliance).
   * Un jeton = une demande d’alliance.
   */
  childrenTokens?: number;
  /**
   * Index mois de la dernière naissance (`year * 12 + month`).
   * Espacement mini ~2 ans entre enfants.
   */
  lastChildMonthIndex?: number;
  /**
   * Levées disponibles (0…capacité). `undefined` = plein au premier calcul.
   * Baisse après une bataille, remonte avec le temps.
   */
  manpower?: number;
  /** Revendications sur des titres de jure (`titleId`, `year`). */
  claims?: { titleId: string; year: number }[];
  /** Ids de domaines revendiqués (casus belli unitaire). */
  domainClaims?: number[];
}

/** Types de terrain — décorrélés des royaumes / possessions. */
export type TerrainType =
  | "mountains"
  | "hills"
  | "forest"
  | "farmland"
  | "plains"
  | "marsh"
  | "desert"
  | "scrub"
  | "coast"
  | "sea";

/** Région terrain = tous les domaines d’un même type (multi-polygone possible). */
export interface Terrain {
  id: number;
  name: string;
  code: string;
  terrainType: TerrainType;
  centroid: [number, number];
  boundary?: [number, number][][];
  domaines: number[];
  neighbors: number[];
}

/** Ville historique (DARE — noms antiques, c. 400) */
export interface City {
  id: number;
  /** Nom antique */
  name: string;
  /** Nom moderne éventuel */
  modern?: string | null;
  kind: "civitas" | "city" | "town";
  lon: number;
  lat: number;
}

export interface HeightmapMeta {
  url: string;
  width: number;
  height: number;
  minElevation: number;
  maxElevation: number;
}

export type LevelName =
  | "domaine"
  | "province"
  | "royaume"
  | "possession"
  | "terrain"
  | "economy"
  | "opinion"
  | "alliance"
  | "war";

export type Selection = { level: LevelName; id: number } | null;

export interface WorldData {
  bbox: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  franceBbox: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  heightmap: HeightmapMeta;
  /** Anneaux terre (littoral Natural Earth) */
  land?: [number, number][][];
  /** Montagnes / massifs impraticables */
  impassable?: [number, number][][];
  /** Tronçons de rivières */
  rivers?: [number, number][][];
  /** Grandes villes de l’époque */
  cities?: City[];
  sources?: string[];
  /** Domaines = territoires étendus autour des villes */
  domaines: Domaine[];
  /** Provinces = clusters de domaines (≤6) à l’intérieur d’un royaume */
  provinces?: Province[];
  /** Royaumes = groupes dynamiques de domaines (contours = domaines) — de jure */
  royaumes?: Royaume[];
  /**
   * Possessions = hiérarchie de facto (rois → vassaux → domaines).
   * Beaucoup de domaines restent sans possessionId.
   */
  possessions?: Possession[];
  /** Terrains = types de sol / végétation (indépendant des pouvoirs) */
  terrains?: Terrain[];
}
