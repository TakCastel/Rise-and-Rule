import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { areAllied } from "../game/alliance";
import { warSideOf, type Army } from "../game/army";
import type { Title } from "../game/titles";
import type { Alliance, PendingKingdomDrift, WarState } from "../game/types";
import { formatCount } from "../lib/population";
import type { City, LevelName, Selection, WorldData } from "../types/world";
import { buildHillshadeCanvas } from "./hillshade";
import {
  LAND_COLOR,
  WAR_ENEMY_COLOR,
  WAR_NEUTRAL_COLOR,
  WAR_SELF_COLOR,
  getDemesneUnit,
  getPossessionLiege,
  getRealmBoundary,
  getRenderUnits,
  getWarLabelUnits,
  getWarUnits,
  kingdomColor,
  possessionColor,
  secondaryFromPrimary,
} from "./levels";
import { loadHeightmap } from "./projection";
import { buildMapLabels } from "./territoryLabels";

interface MapViewProps {
  world: WorldData;
  level: LevelName;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  /** Surbrillance (choix de faction / survol liste). */
  highlightId?: number | null;
  /**
   * Contour de focus (claim province/domaine) — sans changer le filtre carte.
   */
  focusOutline?: Selection;
  onHover?: (id: number | null) => void;
  /** Écran pick : n’afficher que les rois sur la carte. */
  pickMajorOnly?: boolean;
  /** Armées en campagne — marqueurs, sièges hachurés, batailles. */
  armies?: Army[];
  /** Guerres actives — domaines occupés (siège terminé, pas encore transférés). */
  wars?: WarState[];
  /** Alliances actives — colore les armées alliées en bleu sur la carte. */
  alliances?: Alliance[];
  /** Guerre précise mise en avant (icône de guerre cliquée) — restreint la vue Guerre (filtre "war") à ce seul conflit plutôt qu'à toutes les guerres cumulées. */
  focusWarId?: number | null;
  selectedArmyId?: number | null;
  onSelectArmy?: (id: number | null) => void;
  /** Clic droit sur un domaine avec une armée sélectionnée → ordre de marche. */
  onOrderMarch?: (armyId: number, domainId: number) => void;
  /** Possession du joueur — distingue nos armées (flèche vers la destination) des adverses (flèche vers la prochaine étape seulement). */
  viewerId?: number | null;
  /** Fraction du jour calendaire courant déjà écoulée (0…1) — permet un glissé linéaire continu des armées en marche, indépendant de la cadence des ticks. */
  dayProgress?: number;
  /** Joueur courant (vue Opinion). */
  playerId?: number | null;
  /** Matrice d’opinions (vue Opinion). */
  opinions?: Record<string, number>;
  /** Titres de jure — royaume non encore créé → nom informel (« Franks of Clovis »). */
  titles?: Title[];
  /** Royaumes imaginaires en attente de drift — provinces tampon hachurées. */
  kingdomDrifts?: PendingKingdomDrift[];
}

const BASE_W = 1600;

function ringsToPath(
  rings: [number, number][][],
  toXY: (lon: number, lat: number) => [number, number],
): string {
  return rings
    .filter((ring) => ring.length >= 3)
    .map((ring) => {
      const parts = ring.map(([lon, lat], i) => {
        const [x, y] = toXY(lon, lat);
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      });
      return `${parts.join(" ")} Z`;
    })
    .join(" ");
}

function linesToPath(
  lines: [number, number][][],
  toXY: (lon: number, lat: number) => [number, number],
): string {
  return lines
    .filter((line) => line.length >= 2)
    .map((line) => {
      const parts = line.map(([lon, lat], i) => {
        const [x, y] = toXY(lon, lat);
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      });
      return parts.join(" ");
    })
    .join(" ");
}

/** Couleurs des marqueurs d’armée relatives au joueur (hostile / allié / conflit tiers). */
const HOSTILE_ARMY_COLOR = "#c0392b";
const ALLIED_ARMY_COLOR = "#2f6fb0";
const THIRD_PARTY_ARMY_COLOR = "#d98a2b";
const NEUTRAL_ARMY_COLOR = "#9a9385";
const SELF_ARMY_LABEL_COLOR = "#f5f0e6";

/**
 * Seuils d’effectif pour le pictogramme d’unité (façon jeu de plateau) :
 * rectangle nu → 1 diagonale → 2 diagonales (croix) → 1 à 5 points.
 */
const ARMY_TIER_THRESHOLDS = [200, 500, 1000, 2500, 5000, 10000, 20000];

/** 0 = rectangle nu, 1 = 1 diagonale, 2 = 2 diagonales, 3..7 = 1..5 points. */
function armySizeTier(troops: number): number {
  let tier = 0;
  for (const t of ARMY_TIER_THRESHOLDS) {
    if (troops >= t) tier++;
  }
  return tier;
}

/**
 * Traits/points internes au rectangle selon le palier d’effectif. `w` est
 * l’axe de marche (profondeur, aligné sur le sens du déplacement une fois le
 * groupe orienté), `h` l’axe perpendiculaire (largeur) — les points se
 * placent sur la face avant (grand côté), pas sur le dessus.
 */
function armyGlyphParts(
  tier: number,
  x: number,
  y: number,
  w: number,
  h: number,
): { lines: [number, number, number, number][]; dots: [number, number][] } {
  if (tier === 1) {
    return { lines: [[x, y, x + w, y + h]], dots: [] };
  }
  if (tier === 2) {
    return {
      lines: [
        [x, y, x + w, y + h],
        [x + w, y, x, y + h],
      ],
      dots: [],
    };
  }
  if (tier >= 3) {
    const n = Math.min(5, tier - 2);
    const dx = x + w * 0.72;
    const dots: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      dots.push([dx, y + h * (0.22 + t * 0.56)]);
    }
    return { lines: [], dots };
  }
  return { lines: [], dots: [] };
}

/** Triangle plein pointant selon `angle` (radians), pointe en (x, y). */
function arrowHeadPath(x: number, y: number, angle: number, size: number): string {
  const spread = 0.5;
  const back = angle + Math.PI;
  const x1 = x + Math.cos(back + spread) * size;
  const y1 = y + Math.sin(back + spread) * size;
  const x2 = x + Math.cos(back - spread) * size;
  const y2 = y + Math.sin(back - spread) * size;
  return `M${x.toFixed(2)},${y.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} Z`;
}

/**
 * Point de contrôle d’un arc quadratique entre deux points (bulge
 * perpendiculaire au segment) — utilisé à la fois pour dessiner la flèche
 * de marche d’une étape et pour faire glisser le marqueur d’armée le long
 * de cette même courbe, plutôt qu’en ligne droite.
 */
function bulgeControlPoint(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const bulge = Math.min(len * 0.16, 22);
  return [mx - (dy / len) * bulge, my + (dx / len) * bulge];
}

/** Position et angle de tangente sur l’arc quadratique (x0,y0)→(x1,y1) via (cx,cy), au paramètre `t` (0…1). */
function quadraticPointAndAngle(
  t: number,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
): { x: number; y: number; angle: number } {
  const mt = 1 - t;
  const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
  const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
  const dx = 2 * mt * (cx - x0) + 2 * t * (x1 - cx);
  const dy = 2 * mt * (cy - y0) + 2 * t * (y1 - cy);
  return { x, y, angle: Math.atan2(dy, dx) };
}

/**
 * Tracé courbe passant par tous les `pts` (au lieu de segments droits) :
 * un simple arc pour 2 points (rien à lisser sinon), une spline
 * Catmull-Rom → Bézier cubique pour un chemin à plusieurs étapes. Renvoie
 * aussi l’angle de la tangente au point final, pour orienter la pointe.
 */
function curvedPath(pts: [number, number][]): { d: string; endAngle: number } {
  const [x0, y0] = pts[0];
  if (pts.length === 2) {
    const [x1, y1] = pts[1];
    const [cx, cy] = bulgeControlPoint(x0, y0, x1, y1);
    return {
      d: `M${x0.toFixed(2)},${y0.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`,
      endAngle: Math.atan2(y1 - cy, x1 - cx),
    };
  }

  let d = `M${x0.toFixed(2)},${y0.toFixed(2)}`;
  let endAngle = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
    if (i === pts.length - 2) endAngle = Math.atan2(p2[1] - c2y, p2[0] - c2x);
  }
  return { d, endAngle };
}

export function MapView({
  world,
  level,
  selection,
  onSelect,
  highlightId = null,
  focusOutline = null,
  onHover,
  pickMajorOnly = false,
  armies = [],
  wars = [],
  alliances = [],
  focusWarId = null,
  selectedArmyId = null,
  onSelectArmy,
  onOrderMarch,
  viewerId = null,
  dayProgress = 0,
  playerId = null,
  opinions,
  titles,
  kingdomDrifts = [],
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldGroupRef = useRef<SVGGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hillshadeUrl, setHillshadeUrl] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState<City | null>(null);
  const camRef = useRef({ x: 0, y: 0, k: 1 });
  const framedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const movedRef = useRef(false);

  function applyCam() {
    const c = camRef.current;
    const g = worldGroupRef.current;
    if (g) g.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
  }

  const { bbox } = world;
  const latAvgRad = (((bbox.latMin + bbox.latMax) / 2) * Math.PI) / 180;
  const kmPerDegLon = 111.32 * Math.cos(latAvgRad);
  const degAspect = (bbox.latMax - bbox.latMin) / (bbox.lonMax - bbox.lonMin);
  const kmAspect =
    ((bbox.latMax - bbox.latMin) * 111.32) / ((bbox.lonMax - bbox.lonMin) * kmPerDegLon);
  const aspect = degAspect * 0.4 + kmAspect * 0.6;
  const mapW = BASE_W;
  const mapH = BASE_W * aspect;

  const toXY = useMemo(() => {
    return (lon: number, lat: number): [number, number] => [
      ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * mapW,
      ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * mapH,
    ];
  }, [bbox, mapW, mapH]);

  const landPath = useMemo(
    () => (world.land?.length ? ringsToPath(world.land, toXY) : null),
    [world.land, toXY],
  );

  const impassablePath = useMemo(
    () => (world.impassable?.length ? ringsToPath(world.impassable, toXY) : null),
    [world.impassable, toXY],
  );

  const riversPath = useMemo(
    () => (world.rivers?.length ? linesToPath(world.rivers, toXY) : null),
    [world.rivers, toXY],
  );

  // Vue Guerre uniquement (jamais en filtre Possession) : rouge = camp
  // adverse (y compris ses alliés venus prêter main-forte), vert = mes
  // propres alliés ayant rejoint cette guerre.
  const { warEnemyIds, warAllyIds } = useMemo(() => {
    if (viewerId == null) return { warEnemyIds: [] as number[], warAllyIds: [] as number[] };
    // Une guerre précise est mise en avant (icône cliquée) : restreint la vue
    // à ce seul conflit plutôt qu'à toutes les guerres cumulées.
    const relevantWars =
      focusWarId != null ? wars.filter((w) => w.id === focusWarId) : wars;
    const enemies = new Set<number>();
    const allies = new Set<number>();
    for (const w of relevantWars) {
      const mySide = warSideOf(w, viewerId);
      if (!mySide) continue;
      if (mySide === "attacker") {
        enemies.add(w.defenderId);
        for (const id of w.allyOfDefender || []) enemies.add(id);
        for (const id of w.allyOfAttacker || []) if (id !== viewerId) allies.add(id);
      } else {
        enemies.add(w.attackerId);
        for (const id of w.allyOfAttacker || []) enemies.add(id);
        for (const id of w.allyOfDefender || []) if (id !== viewerId) allies.add(id);
      }
    }
    return { warEnemyIds: [...enemies], warAllyIds: [...allies] };
  }, [wars, viewerId, focusWarId]);

  const warView = level === "war";

  const units = useMemo(() => {
    if (warView) return getWarUnits(world, viewerId, warEnemyIds, warAllyIds);
    return getRenderUnits(world, level, selection, {
      majorOnly: pickMajorOnly && level === "possession",
      playerId,
      opinions,
      titles,
      alliances,
      // Vue par défaut (aucune sélection) uniquement : le focus est alors le
      // joueur lui-même, donc ses ennemis de guerre s'affichent aussi.
      // Dès qu'on clique un pays, seuls lui et ses alliés restent affichés.
      allianceEnemyIds: !selection ? warEnemyIds : undefined,
    });
  }, [
    world,
    level,
    selection,
    pickMajorOnly,
    playerId,
    opinions,
    titles,
    alliances,
    warView,
    viewerId,
    warEnemyIds,
    warAllyIds,
  ]);

  const unitPaths = useMemo(
    () =>
      units.map((u) => ({
        id: u.id,
        name: u.name,
        selectionLevel: u.selectionLevel,
        d: ringsToPath(u.boundary, toXY),
        fill: u.color,
        stroke: u.colorSecondary,
      })),
    [units, toXY],
  );

  const territoryLabels = useMemo(() => {
    try {
      if (warView) {
        return buildMapLabels(
          getWarLabelUnits(world, viewerId, warEnemyIds, warAllyIds),
          "possession",
          selection,
          toXY,
        );
      }
      return buildMapLabels(units, level, selection, toXY);
    } catch (err) {
      console.warn("territory labels failed", err);
      return [];
    }
  }, [units, level, selection, toXY, warView, world, viewerId, warEnemyIds, warAllyIds]);

  /**
   * Domaine en cours de siège : voile transparent dans la couleur de
   * l’assiégeant, de plus en plus opaque à mesure que le siège avance —
   * lisible d’un coup d’œil, pas besoin de motif.
   */
  const siegeOverlays = useMemo(() => {
    if (!armies.length || (level !== "possession" && level !== "domaine" && level !== "war")) return [];
    const out: {
      armyId: number;
      domainId: number;
      d: string;
      color: string;
      opacity: number;
    }[] = [];
    for (const army of armies) {
      if (army.stance !== "sieging") continue;
      // En vue Guerre, ne montrer que les sièges de la guerre mise en avant.
      if (warView && focusWarId != null && army.warId !== focusWarId) continue;
      const domaine =
        world.domaines.find((d) => d.id === army.domainId) ?? world.domaines[army.domainId];
      if (!domaine?.boundary?.length) continue;
      const d = ringsToPath(domaine.boundary, toXY);
      if (!d) continue;
      const progress = Math.max(
        0,
        Math.min(1, (army.siegeProgress ?? 0) / (army.siegeDays ?? 1)),
      );
      const color = warView
        ? army.ownerId === viewerId
          ? WAR_SELF_COLOR
          : WAR_ENEMY_COLOR
        : possessionColor(world, army.ownerId);
      out.push({
        armyId: army.id,
        domainId: army.domainId,
        d,
        color,
        opacity: 0.12 + progress * 0.58,
      });
    }
    return out;
  }, [armies, world, level, toXY, warView, focusWarId, viewerId]);

  /**
   * Domaines occupés militairement (siège terminé) mais pas encore
   * réellement transférés — ne le seront qu’à la résolution de la guerre
   * (« appuyer nos exigences »). Hachures mi-notre couleur, mi-celle du
   * détenteur d’origine, pour lire d’un coup d’œil « pas encore acquis ».
   */
  const occupiedOverlays = useMemo(() => {
    if (!wars.length || (level !== "possession" && level !== "domaine" && level !== "war")) return [];
    const out: { key: string; d: string; patternId: string; colorA: string; colorB: string }[] = [];
    for (const war of wars) {
      // En vue Guerre, ne montrer que l'occupation de la guerre mise en avant.
      if (warView && focusWarId != null && war.id !== focusWarId) continue;
      const sides: [number[] | undefined, number][] = [
        [war.capturedByAttacker, war.attackerId],
        [war.capturedByDefender, war.defenderId],
      ];
      for (const [domainIds, ownerId] of sides) {
        for (const domainId of domainIds || []) {
          const domaine =
            world.domaines.find((d) => d.id === domainId) ?? world.domaines[domainId];
          if (!domaine?.boundary?.length) continue;
          const d = ringsToPath(domaine.boundary, toXY);
          if (!d) continue;
          const colorA = warView
            ? ownerId === viewerId
              ? WAR_SELF_COLOR
              : WAR_ENEMY_COLOR
            : possessionColor(world, ownerId);
          const colorB = warView
            ? domaine.possessionId === viewerId
              ? WAR_SELF_COLOR
              : warEnemyIds.includes(domaine.possessionId ?? -1)
                ? WAR_ENEMY_COLOR
                : WAR_NEUTRAL_COLOR
            : domaine.possessionId != null
              ? possessionColor(world, domaine.possessionId)
              : "#4a4640";
          out.push({
            key: `occ-${war.id}-${ownerId}-${domainId}`,
            d,
            patternId: `occupied-hatch-${ownerId}-${domaine.possessionId ?? "none"}-${warView ? "w" : "n"}`,
            colorA,
            colorB,
          });
        }
      }
    }
    return out;
  }, [wars, world, level, toXY, warView, focusWarId, viewerId, warEnemyIds]);

  const occupiedHatchPatterns = useMemo(() => {
    const seen = new Map<string, { colorA: string; colorB: string }>();
    for (const o of occupiedOverlays) {
      if (!seen.has(o.patternId)) seen.set(o.patternId, { colorA: o.colorA, colorB: o.colorB });
    }
    return [...seen.entries()].map(([id, c]) => ({ id, ...c }));
  }, [occupiedOverlays]);

  /**
   * Territoire réellement en jeu dans la guerre mise en avant — ce qui
   * basculera à la victoire : le war goal précis pour une guerre de claim,
   * sinon le royaume adverse en entier (indépendance, renversement, ou
   * conquête sans claim précise) — même dénominateur que `canPressDemands`.
   * Simple contour, ne touche pas au remplissage (self/ennemi/allié/neutre).
   */
  const warGoalOverlays = useMemo(() => {
    if (!warView || viewerId == null || focusWarId == null) return [];
    const war = wars.find((w) => w.id === focusWarId);
    if (!war) return [];
    const mySide = warSideOf(war, viewerId);
    if (!mySide) return [];
    const cb = war.casusBelli ?? "claim_province";
    const goalIds =
      mySide === "attacker"
        ? (cb === "claim_province" || cb === "conquest") && war.warGoalDomainIds?.length
          ? war.warGoalDomainIds
          : war.conquestOrder
        : war.attackerFrontOrder;
    if (!goalIds?.length) return [];
    const out: { key: string; d: string }[] = [];
    for (const domainId of goalIds) {
      const domaine = world.domaines.find((d) => d.id === domainId) ?? world.domaines[domainId];
      if (!domaine?.boundary?.length) continue;
      const d = ringsToPath(domaine.boundary, toXY);
      if (!d) continue;
      out.push({ key: `goal-${domainId}`, d });
    }
    return out;
  }, [warView, viewerId, focusWarId, wars, world, toXY]);

  /**
   * Domaines qui comptent pour l’une de mes propres guerres (objectifs,
   * déjà capturés, ou simplement occupés par une de mes armées) — sert à
   * repérer un « conflit tiers » : une armée étrangère qui se trouve sur un
   * terrain que je dispute moi-même dans une guerre différente.
   */
  const myContestedDomains = useMemo(() => {
    const set = new Set<number>();
    if (viewerId == null) return set;
    for (const w of wars) {
      if (!warSideOf(w, viewerId)) continue;
      for (const id of w.conquestOrder || []) set.add(id);
      for (const id of w.attackerFrontOrder || []) set.add(id);
      for (const id of w.capturedByAttacker || []) set.add(id);
      for (const id of w.capturedByDefender || []) set.add(id);
    }
    for (const a of armies) {
      if (a.ownerId === viewerId) set.add(a.domainId);
    }
    return set;
  }, [wars, viewerId, armies]);

  /**
   * Couleur du nombre de troupes (pas du rectangle, qui garde toujours la
   * couleur du royaume propriétaire) : rouge = hostile (camp adverse d’une
   * de mes guerres, y compris un allié venu prêter main-forte à l’ennemi),
   * bleu = allié, orange = conflit tiers (armée étrangère présente sur un
   * terrain que je dispute par ailleurs — on va finir par s’y battre),
   * gris = neutre (armée étrangère totalement sans rapport avec mes
   * guerres).
   */
  const armyLabelColor = useCallback(
    (ownerId: number, domainId: number): string => {
      if (viewerId == null || ownerId === viewerId) return SELF_ARMY_LABEL_COLOR;
      const hostile = wars.some((w) => {
        const viewerSide = warSideOf(w, viewerId);
        const ownerSide = warSideOf(w, ownerId);
        return viewerSide != null && ownerSide != null && viewerSide !== ownerSide;
      });
      if (hostile) return HOSTILE_ARMY_COLOR;
      if (areAllied(alliances, viewerId, ownerId)) return ALLIED_ARMY_COLOR;
      if (myContestedDomains.has(domainId)) return THIRD_PARTY_ARMY_COLOR;
      return NEUTRAL_ARMY_COLOR;
    },
    [wars, alliances, viewerId, myContestedDomains],
  );

  /** Marqueurs d’armée — regroupés/décalés en éventail par domaine occupé. */
  const armyMarkers = useMemo(() => {
    if (!armies.length) return [];
    const stationary = armies.filter((a) => a.stance !== "moving");
    const moving = armies.filter((a) => a.stance === "moving");

    const byDomain = new Map<number, Army[]>();
    for (const a of stationary) {
      const list = byDomain.get(a.domainId) ?? [];
      list.push(a);
      byDomain.set(a.domainId, list);
    }

    const out: {
      id: number;
      x: number;
      y: number;
      /** Orientation dans le sens de la marche (degrés) — -90 (face large à plat, points en haut) pour une armée immobile. */
      angleDeg: number;
      troops: number;
      ownerId: number;
      stance: Army["stance"];
      /** Rectangle : toujours la couleur du royaume propriétaire. */
      color: string;
      /** Nombre de troupes : coloré selon la relation (ennemi/allié/tiers/neutre). */
      labelColor: string;
    }[] = [];

    for (const [domainId, list] of byDomain) {
      const domaine = world.domaines.find((d) => d.id === domainId) ?? world.domaines[domainId];
      if (!domaine) continue;
      const [cx, cy] = toXY(domaine.centroid[0], domaine.centroid[1]);
      const n = list.length;
      list.forEach((a, i) => {
        const angle = (i / Math.max(1, n)) * Math.PI * 2;
        const radius = n > 1 ? 9 : 0;
        out.push({
          id: a.id,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          angleDeg: -90,
          troops: a.troops,
          ownerId: a.ownerId,
          stance: a.stance,
          color: possessionColor(world, a.ownerId),
          labelColor: armyLabelColor(a.ownerId, a.domainId),
        });
      });
    }

    // Armées en marche : position interpolée linéairement entre le domaine de
    // départ et la prochaine étape, selon la fraction de jours déjà parcourue
    // ((legProgress + dayProgress) / legDays) — dayProgress avance en continu
    // (indépendamment de la vitesse de jeu), d’où un glissé linéaire fluide.
    for (const a of moving) {
      const fromD = world.domaines.find((d) => d.id === a.domainId) ?? world.domaines[a.domainId];
      if (!fromD) continue;
      const [fx, fy] = toXY(fromD.centroid[0], fromD.centroid[1]);
      const nextId = a.path?.[0];
      const toD =
        nextId != null ? (world.domaines.find((d) => d.id === nextId) ?? world.domaines[nextId]) : undefined;
      if (!toD) {
        out.push({
          id: a.id,
          x: fx,
          y: fy,
          angleDeg: -90,
          troops: a.troops,
          ownerId: a.ownerId,
          stance: a.stance,
          color: possessionColor(world, a.ownerId),
          labelColor: armyLabelColor(a.ownerId, a.domainId),
        });
        continue;
      }
      const [tx, ty] = toXY(toD.centroid[0], toD.centroid[1]);
      const frac = Math.max(
        0,
        Math.min(1, ((a.legProgress ?? 0) + dayProgress) / (a.legDays ?? 1)),
      );
      // Même arc (bulge) que la flèche de marche affichée pour cette étape —
      // le marqueur glisse sur la courbe, pas en ligne droite.
      const [ccx, ccy] = bulgeControlPoint(fx, fy, tx, ty);
      const { x, y, angle } = quadraticPointAndAngle(frac, fx, fy, ccx, ccy, tx, ty);
      out.push({
        id: a.id,
        x,
        y,
        angleDeg: (angle * 180) / Math.PI,
        troops: a.troops,
        ownerId: a.ownerId,
        stance: a.stance,
        color: possessionColor(world, a.ownerId),
        labelColor: armyLabelColor(a.ownerId, a.domainId),
      });
    }

    return out;
  }, [armies, world, toXY, dayProgress, armyLabelColor]);

  /**
   * Flèches de marche : chemin complet jusqu’à la destination pour nos
   * propres armées (« finalité »), juste la prochaine étape pour les armées
   * adverses (mouvement à court terme, moins de certitude sur la suite).
   */
  const armyMoveArrows = useMemo(() => {
    if (!armies.length) return [];
    const out: { id: number; d: string; head: string; color: string; friendly: boolean }[] = [];
    for (const army of armies) {
      if (army.stance !== "moving" || !army.path?.length) continue;
      const friendly = viewerId != null && army.ownerId === viewerId;
      const stopIds = friendly ? army.path : [army.path[0]];
      const fromDomaine =
        world.domaines.find((d) => d.id === army.domainId) ?? world.domaines[army.domainId];
      if (!fromDomaine) continue;
      const pts: [number, number][] = [toXY(fromDomaine.centroid[0], fromDomaine.centroid[1])];
      let ok = true;
      for (const id of stopIds) {
        const d = world.domaines.find((x) => x.id === id) ?? world.domaines[id];
        if (!d) {
          ok = false;
          break;
        }
        pts.push(toXY(d.centroid[0], d.centroid[1]));
      }
      if (!ok || pts.length < 2) continue;
      const { d, endAngle } = curvedPath(pts);
      const [ex, ey] = pts[pts.length - 1];
      out.push({
        id: army.id,
        d,
        head: arrowHeadPath(ex, ey, endAngle, friendly ? 5 : 4),
        color: possessionColor(world, army.ownerId),
        friendly,
      });
    }
    return out;
  }, [armies, world, toXY, viewerId]);

  /**
   * Provinces en attente de drift (royaume imaginaire) : la carte de jure est
   * cassée — la province reste au royaume d’origine mais s’affiche en zone
   * tampon hachurée, teintée du royaume qui la revendique.
   */
  const driftOverlays = useMemo(() => {
    if (!kingdomDrifts.length || (level !== "royaume" && level !== "province")) {
      return [];
    }
    const out: {
      key: string;
      d: string;
      color: string;
      patternId: string;
    }[] = [];
    for (const drift of kingdomDrifts) {
      const patternId = `drift-hatch-${drift.id}`;
      const color = kingdomColor(world, drift.royaumeId);
      for (const provinceId of drift.provinceIds) {
        const prov =
          (world.provinces || []).find((p) => p.id === provinceId) ??
          world.provinces?.[provinceId];
        if (!prov?.boundary?.length) continue;
        if (prov.royaumeId === drift.royaumeId) continue; // déjà résolu
        const d = ringsToPath(prov.boundary, toXY);
        if (!d) continue;
        out.push({ key: `${drift.id}-${provinceId}`, d, color, patternId });
      }
    }
    return out;
  }, [kingdomDrifts, world, level, toXY]);

  const driftHatchPatterns = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of driftOverlays) {
      if (!seen.has(o.patternId)) seen.set(o.patternId, o.color);
    }
    return [...seen.entries()].map(([id, color]) => ({ id, color }));
  }, [driftOverlays]);

  /** Contour de survol — demesne si vassal/chef, realm si roi (tous niveaux). */
  const hoverOutline = useMemo(() => {
    if (highlightId == null) return null;
    const p = (world.possessions || []).find((x) => x.id === highlightId);
    if (!p) return null;
    const rings =
      p.rank === "king"
        ? getRealmBoundary(world, p.id)
        : getDemesneUnit(world, p.id)?.boundary ?? [];
    if (!rings.length) return null;
    const primary = possessionColor(world, p.id);
    return {
      d: ringsToPath(rings, toXY),
      stroke: secondaryFromPrimary(primary),
      fill: primary,
    };
  }, [world, highlightId, toXY]);

  /** Contour claim (province / domaine) sans changer le niveau de carte. */
  const claimFocusOutline = useMemo(() => {
    if (!focusOutline) return null;
    if (focusOutline.level === "province") {
      const prov = (world.provinces || []).find((x) => x.id === focusOutline.id);
      if (!prov) return null;
      const rings =
        prov.boundary && prov.boundary.length > 0
          ? prov.boundary
          : prov.domaines
              .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
              .filter(Boolean)
              .flatMap((d) => d!.boundary);
      if (!rings.length) return null;
      const primary =
        prov.royaumeId != null
          ? kingdomColor(world, prov.royaumeId)
          : "#c4b59a";
      return {
        d: ringsToPath(rings, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    if (focusOutline.level === "domaine") {
      const d =
        world.domaines.find((x) => x.id === focusOutline.id) ??
        world.domaines[focusOutline.id];
      if (!d?.boundary?.length) return null;
      const primary =
        d.possessionId != null
          ? possessionColor(world, d.possessionId)
          : d.royaumeId != null
            ? kingdomColor(world, d.royaumeId)
            : "#c4b59a";
      return {
        d: ringsToPath(d.boundary, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    return null;
  }, [world, focusOutline, toXY]);

  /** Méga-frontière du royaume / possession sélectionné — liseret couleur secondaire. */
  const selectedKingdomOutline = useMemo(() => {
    if (selection?.level === "royaume") {
      const r = (world.royaumes || []).find((x) => x.id === selection.id);
      if (!r) return null;
      const rings =
        r.boundary && r.boundary.length > 0
          ? r.boundary
          : r.domaines
              .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
              .filter(Boolean)
              .flatMap((d) => d!.boundary);
      if (!rings.length) return null;
      const primary = kingdomColor(world, r.id);
      return {
        d: ringsToPath(rings, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    if (selection?.level === "province") {
      const prov = (world.provinces || []).find((x) => x.id === selection.id);
      if (!prov) return null;
      const rings =
        prov.boundary && prov.boundary.length > 0
          ? prov.boundary
          : prov.domaines
              .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
              .filter(Boolean)
              .flatMap((d) => d!.boundary);
      if (!rings.length) return null;
      const primary =
        prov.royaumeId != null
          ? kingdomColor(world, prov.royaumeId)
          : "#c4b59a";
      return {
        d: ringsToPath(rings, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    if (selection?.level === "domaine") {
      const d =
        world.domaines.find((x) => x.id === selection.id) ??
        world.domaines[selection.id];
      if (!d?.boundary?.length) {
        // fall through to possession/royaume outlines below when needed
      } else if (level === "domaine" || level === "province") {
        const primary =
          d.possessionId != null
            ? possessionColor(world, d.possessionId)
            : d.royaumeId != null
              ? kingdomColor(world, d.royaumeId)
              : "#c4b59a";
        return {
          d: ringsToPath(d.boundary, toXY),
          stroke: secondaryFromPrimary(primary),
        };
      }
    }
    if (selection?.level === "possession") {
      const p = (world.possessions || []).find((x) => x.id === selection.id);
      if (!p) return null;
      const liege = getPossessionLiege(world, p.id) || p;
      const rings = getRealmBoundary(world, liege.id);
      if (!rings.length) return null;
      const primary = possessionColor(world, liege.id);
      return {
        d: ringsToPath(rings, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    // Domaine sous Possession → garder le liseret du seigneur
    if (selection?.level === "domaine" && level === "possession") {
      const d =
        world.domaines.find((x) => x.id === selection.id) ?? world.domaines[selection.id];
      if (!d?.possessionId) return null;
      const liege = getPossessionLiege(world, d.possessionId);
      if (!liege) return null;
      const rings = getRealmBoundary(world, liege.id);
      if (!rings.length) return null;
      const primary = possessionColor(world, liege.id);
      return {
        d: ringsToPath(rings, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    if (selection?.level === "domaine" && level === "royaume") {
      const d =
        world.domaines.find((x) => x.id === selection.id) ?? world.domaines[selection.id];
      if (d?.royaumeId == null) return null;
      const r = (world.royaumes || []).find((x) => x.id === d.royaumeId);
      if (!r) return null;
      const rings =
        r.boundary && r.boundary.length > 0
          ? r.boundary
          : r.domaines
              .map((id) => world.domaines.find((x) => x.id === id) ?? world.domaines[id])
              .filter(Boolean)
              .flatMap((x) => x!.boundary);
      if (!rings.length) return null;
      const primary = kingdomColor(world, r.id);
      return {
        d: ringsToPath(rings, toXY),
        stroke: secondaryFromPrimary(primary),
      };
    }
    return null;
  }, [world, selection, level, toXY]);

  const cityMarkers = useMemo(() => {
    const list = world.cities || [];
    return list.map((c) => {
      const [x, y] = toXY(c.lon, c.lat);
      return { city: c, x, y };
    });
  }, [world.cities, toXY]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hm = await loadHeightmap(world);
        if (cancelled) return;
        const canvas = buildHillshadeCanvas(
          hm,
          world.bbox,
          960,
          Math.round(
            960 *
              ((world.bbox.latMax - world.bbox.latMin) /
                (world.bbox.lonMax - world.bbox.lonMin)),
          ),
        );
        const url = canvas.toDataURL("image/png");
        if (!cancelled) setHillshadeUrl(url);
      } catch {
        if (!cancelled) setHillshadeUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [world]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (framedRef.current || size.w < 80 || size.h < 80) return;
    const focus = { lonMin: -5.5, lonMax: 10.5, latMin: 41.2, latMax: 51.8 };
    const [x0, y1] = toXY(focus.lonMin, focus.latMin);
    const [x1, y0] = toXY(focus.lonMax, focus.latMax);
    const fw = Math.max(1, x1 - x0);
    const fh = Math.max(1, y1 - y0);
    const pad = 1.08;
    const k = Math.min(size.w / (fw * pad), size.h / (fh * pad));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    camRef.current = {
      x: size.w / 2 - cx * k,
      y: size.h / 2 - cy * k,
      k: Math.max(0.2, Math.min(4, k)),
    };
    framedRef.current = true;
    applyCam();
  }, [toXY, size.w, size.h]);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.00085);
    const c = camRef.current;
    const nk = Math.min(6, Math.max(0.3, c.k * factor));
    const wx = (mx - c.x) / c.k;
    const wy = (my - c.y) / c.k;
    camRef.current = { k: nk, x: mx - wx * nk, y: my - wy * nk };
    applyCam();
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const c = camRef.current;
    dragRef.current = { x: e.clientX, y: e.clientY, camX: c.x, camY: c.y };
    movedRef.current = false;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (dx * dx + dy * dy > 25) movedRef.current = true;
    camRef.current = {
      k: camRef.current.k,
      x: d.camX + dx,
      y: d.camY + dy,
    };
    applyCam();
  }

  function onPointerUp(e: React.PointerEvent) {
    const wasDrag = movedRef.current;
    dragRef.current = null;
    if (wasDrag) return;
    // Clic droit : géré par onContextMenu (ordre de marche) — pas la sélection normale.
    if (e.button === 2) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const armyHit = el?.closest?.("[data-army-id]") as HTMLElement | null;
    if (armyHit) {
      const id = Number(armyHit.dataset.armyId);
      onSelectArmy?.(selectedArmyId === id ? null : id);
      return;
    }
    const cityHit = el?.closest?.("[data-city-id]") as HTMLElement | null;
    if (cityHit) {
      const id = Number(cityHit.dataset.cityId);
      const city = (world.cities || []).find((c) => c.id === id) || null;
      setSelectedCity(city);
      return;
    }
    setSelectedCity(null);
    const unitHit = el?.closest?.("[data-unit-id]") as HTMLElement | null;
    if (!unitHit) {
      onSelect(null);
      return;
    }
    const id = Number(unitHit.dataset.unitId);
    const selLevel = (unitHit.dataset.unitLevel as LevelName) || level;

    // Possession = personnages : clic domaine ouvre le titulaire,
    // sauf si on est déjà sur ce titulaire → alors on administre le domaine.
    if (level === "possession" && selLevel === "domaine") {
      const d = world.domaines.find((x) => x.id === id) ?? world.domaines[id];
      if (d?.possessionId == null) {
        onSelect(null);
        return;
      }
      if (pickMajorOnly) {
        const holder = (world.possessions || []).find((p) => p.id === d.possessionId);
        if (!holder || holder.rank !== "king") {
          onSelect(null);
          return;
        }
      }
      // Déjà sur ce domaine → revenir au personnage
      if (selection?.level === "domaine" && selection.id === id) {
        onSelect({ level: "possession", id: d.possessionId });
        return;
      }
      const viewingSameHolder =
        (selection?.level === "possession" && selection.id === d.possessionId) ||
        (selection?.level === "domaine" &&
          (() => {
            const cur =
              world.domaines.find((x) => x.id === selection.id) ??
              world.domaines[selection.id];
            return cur?.possessionId === d.possessionId;
          })());
      if (viewingSameHolder) {
        onSelect({ level: "domaine", id });
        return;
      }
      onSelect({ level: "possession", id: d.possessionId });
      return;
    }

    if (pickMajorOnly && level === "possession" && selLevel === "possession") {
      const holder = (world.possessions || []).find((p) => p.id === id);
      if (!holder || holder.rank !== "king") {
        onSelect(null);
        return;
      }
    }

    if (selection?.level === selLevel && selection.id === id) onSelect(null);
    else onSelect({ level: selLevel, id });
  }

  /** Clic droit avec une armée sélectionnée : ordre de marche vers le domaine visé. */
  function onContextMenu(e: React.MouseEvent) {
    if (selectedArmyId == null || !onOrderMarch) return;
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const domainHit = el?.closest?.(
      '[data-unit-id][data-unit-level="domaine"]',
    ) as HTMLElement | null;
    if (domainHit) {
      onOrderMarch(selectedArmyId, Number(domainHit.dataset.unitId));
      return;
    }
    // Territoire fusionné (filtre royaume/possession, etc.) : domaine le plus
    // proche du point cliqué, en espace « monde » (avant transform caméra).
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const c = camRef.current;
    const wx = (e.clientX - rect.left - c.x) / c.k;
    const wy = (e.clientY - rect.top - c.y) / c.k;
    let best: { id: number; dist: number } | null = null;
    for (const d of world.domaines) {
      const [dx, dy] = toXY(d.centroid[0], d.centroid[1]);
      const dist = (dx - wx) ** 2 + (dy - wy) ** 2;
      if (!best || dist < best.dist) best = { id: d.id, dist };
    }
    if (best) onOrderMarch(selectedArmyId, best.id);
  }

  return (
    <div
      ref={containerRef}
      className="map2d"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <svg width={size.w} height={size.h} className="map2d-svg" style={{ display: "block" }}>
        <defs>
          <radialGradient
            id="ocean-depth"
            gradientUnits="userSpaceOnUse"
            cx={mapW * 0.42}
            cy={mapH * 0.48}
            r={mapW * 0.85}
          >
            <stop offset="0%" stopColor="#4a7382" />
            <stop offset="28%" stopColor="#3a5f6e" />
            <stop offset="58%" stopColor="#2a4a58" />
            <stop offset="100%" stopColor="#152832" />
          </radialGradient>
          <linearGradient
            id="ocean-atlantique"
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={mapH * 0.4}
            x2={mapW * 0.55}
            y2={mapH * 0.45}
          >
            <stop offset="0%" stopColor="#101f28" stopOpacity="0.75" />
            <stop offset="55%" stopColor="#1a3340" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#2a4a58" stopOpacity="0" />
          </linearGradient>
          <pattern
            id="impassable-hatch"
            patternUnits="userSpaceOnUse"
            width="7"
            height="7"
            patternTransform="rotate(35)"
          >
            <rect width="7" height="7" fill="#141210" />
            <line x1="0" y1="0" x2="0" y2="7" stroke="#3a3632" strokeWidth="2" />
          </pattern>
          {occupiedHatchPatterns.map(({ id, colorA, colorB }) => (
            <pattern
              key={id}
              id={id}
              patternUnits="userSpaceOnUse"
              width="14"
              height="14"
              patternTransform="rotate(45)"
            >
              <rect width="14" height="14" fill={colorB} fillOpacity={0.85} />
              <rect width="7" height="14" fill={colorA} fillOpacity={0.85} />
            </pattern>
          ))}
          {driftHatchPatterns.map(({ id, color }) => (
            <pattern
              key={id}
              id={id}
              patternUnits="userSpaceOnUse"
              width="11"
              height="11"
              patternTransform="rotate(20)"
            >
              <rect width="11" height="11" fill={color} fillOpacity={0.1} />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="11"
                stroke={color}
                strokeWidth="2.5"
                strokeOpacity={0.65}
                strokeDasharray="2 3"
              />
            </pattern>
          ))}
          {landPath && (
            <clipPath id="land-clip">
              <path d={landPath} />
            </clipPath>
          )}
        </defs>
        <rect width={size.w} height={size.h} fill="#152832" />
        <g ref={worldGroupRef}>
          <rect
            x={-mapW * 0.15}
            y={-mapH * 0.15}
            width={mapW * 1.3}
            height={mapH * 1.3}
            fill="url(#ocean-depth)"
          />
          <rect
            x={-mapW * 0.15}
            y={-mapH * 0.15}
            width={mapW * 1.3}
            height={mapH * 1.3}
            fill="url(#ocean-atlantique)"
          />
          {landPath && <path d={landPath} fill={LAND_COLOR} stroke="none" />}
          <g clipPath={landPath ? "url(#land-clip)" : undefined}>
            {unitPaths.map((p) => {
              if (!p.d) return null;
              const unitLevel = p.selectionLevel ?? level;
              const selected = selection?.level === unitLevel && selection.id === p.id;
              const highlighted = highlightId != null && p.id === highlightId;
              const isProvinceChild = p.selectionLevel === "province";
              const isDomainChild = p.selectionLevel === "domaine";
              return (
                <path
                  key={`${unitLevel}-${p.id}`}
                  data-unit-id={p.id}
                  data-unit-level={unitLevel}
                  d={p.d}
                  fill={p.fill}
                  fillOpacity={
                    highlighted
                      ? 1
                      : selected
                        ? 0.95
                        : isProvinceChild || isDomainChild
                          ? 0.9
                          : 0.85
                  }
                  stroke={highlighted ? "#f5f0e6" : selected ? "#1a1510" : p.stroke}
                  strokeWidth={
                    highlighted
                      ? 2.6
                      : selected
                        ? 1.8
                        : isProvinceChild
                          ? 1.15
                          : unitLevel === "royaume" ||
                              unitLevel === "possession" ||
                              unitLevel === "terrain" ||
                              unitLevel === "economy" ||
                              unitLevel === "opinion"
                            ? 1.25
                            : unitLevel === "province"
                              ? 1.05
                              : 0.55
                  }
                  strokeLinejoin="round"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => {
                    if (!onHover) return;
                    if (unitLevel === "domaine") {
                      const d =
                        world.domaines.find((x) => x.id === p.id) ?? world.domaines[p.id];
                      onHover(d?.possessionId ?? null);
                      return;
                    }
                    if (unitLevel === "possession") onHover(p.id);
                  }}
                  onMouseLeave={() => onHover?.(null)}
                />
              );
            })}
            {hoverOutline && (
              <path
                d={hoverOutline.d}
                fill={hoverOutline.fill}
                fillOpacity={0.28}
                stroke="#f5f0e6"
                strokeWidth={2.8}
                strokeLinejoin="round"
                style={{ pointerEvents: "none" }}
              />
            )}
            {occupiedOverlays.map((o) => (
              <path
                key={o.key}
                d={o.d}
                fill={`url(#${o.patternId})`}
                stroke="none"
                style={{ pointerEvents: "none" }}
              />
            ))}
            {warGoalOverlays.map((o) => (
              <path
                key={o.key}
                d={o.d}
                fill="none"
                stroke="#e8b93d"
                strokeWidth={1.6}
                strokeOpacity={0.9}
                strokeDasharray="5 3"
                strokeLinejoin="round"
                style={{ pointerEvents: "none" }}
              />
            ))}
            {siegeOverlays.map((o) => (
              <g key={`siege-${o.armyId}-${o.domainId}`} style={{ pointerEvents: "none" }}>
                <path d={o.d} fill={o.color} fillOpacity={o.opacity} stroke="none" />
                <path
                  d={o.d}
                  fill="none"
                  stroke={o.color}
                  strokeWidth={1.4}
                  strokeOpacity={0.85}
                  strokeDasharray="4 3"
                  strokeLinejoin="round"
                />
              </g>
            ))}
            {driftOverlays.map((o) => (
              <g key={`drift-${o.key}`} style={{ pointerEvents: "none" }}>
                <path d={o.d} fill={`url(#${o.patternId})`} stroke="none" />
                <path
                  d={o.d}
                  fill="none"
                  stroke={o.color}
                  strokeWidth={1.6}
                  strokeOpacity={0.7}
                  strokeDasharray="1 4"
                  strokeLinejoin="round"
                />
              </g>
            ))}
          </g>
          {hillshadeUrl && (
            <image
              href={hillshadeUrl}
              x={0}
              y={0}
              width={mapW}
              height={mapH}
              preserveAspectRatio="none"
              clipPath={landPath ? "url(#land-clip)" : undefined}
              style={{ mixBlendMode: "multiply", opacity: 0.32, pointerEvents: "none" }}
            />
          )}
          {impassablePath && (
            <path
              d={impassablePath}
              fill="url(#impassable-hatch)"
              stroke="#0a0908"
              strokeWidth={0.8}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}
          {riversPath && (
            <path
              d={riversPath}
              fill="none"
              stroke="#2a6a8a"
              strokeWidth={1.35}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.95}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {landPath && (
            <path
              d={landPath}
              fill="none"
              stroke="rgba(18, 28, 36, 0.85)"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {level === "domaine" &&
            cityMarkers.map(({ city, x, y }) => {
            const selected = selectedCity?.id === city.id;
            const r = city.kind === "civitas" ? 2.4 : city.kind === "city" ? 1.7 : 1.35;
            return (
              <circle
                key={city.id}
                data-city-id={city.id}
                cx={x}
                cy={y}
                r={selected ? r + 1.2 : r}
                fill={
                  selected
                    ? "#1a1510"
                    : city.kind === "civitas"
                      ? "#3a2a18"
                      : city.kind === "city"
                        ? "#5a4030"
                        : "#6a5545"
                }
                stroke="#efe6d4"
                strokeWidth={selected ? 1.1 : 0.55}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "pointer" }}
              />
            );
          })}
          {selectedKingdomOutline && (
            <path
              d={selectedKingdomOutline.d}
              fill="none"
              stroke={selectedKingdomOutline.stroke}
              strokeWidth={2.4}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.92}
              pointerEvents="none"
            />
          )}
          {claimFocusOutline && (
            <path
              d={claimFocusOutline.d}
              fill="none"
              stroke={claimFocusOutline.stroke}
              strokeWidth={3.2}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.95}
              pointerEvents="none"
            />
          )}
          {armyMoveArrows.map((a) => (
            <g key={`arrow-${a.id}`} style={{ pointerEvents: "none" }}>
              <path
                d={a.d}
                fill="none"
                stroke="#f5f0e6"
                strokeOpacity={0.9}
                strokeWidth={a.friendly ? 3 : 2.4}
                strokeDasharray={a.friendly ? undefined : "3 2.5"}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={a.d}
                fill="none"
                stroke={a.color}
                strokeWidth={a.friendly ? 1.6 : 1.1}
                strokeOpacity={a.friendly ? 0.95 : 0.75}
                strokeDasharray={a.friendly ? undefined : "3 2.5"}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path d={a.head} fill="#f5f0e6" fillOpacity={0.9} stroke="none" />
              <path
                d={a.head}
                fill={a.color}
                fillOpacity={a.friendly ? 0.95 : 0.75}
                stroke="none"
                transform={`translate(0 0) scale(0.72)`}
                style={{ transformBox: "fill-box", transformOrigin: "center" }}
              />
            </g>
          ))}
          {armyMarkers.map((m) => {
            const selected = selectedArmyId === m.id;
            // w = profondeur (axe de marche, pointe vers l’avant une fois orienté),
            // h = largeur (grand côté, porte les diagonales/points) — face avant vers la marche.
            const w = 8.4;
            const h = 12;
            const tier = armySizeTier(m.troops);
            // Glyphe en coordonnées locales (centré sur l’origine) — le
            // groupe est translaté/orienté, pas les points eux-mêmes.
            const glyph = armyGlyphParts(tier, -w / 2, -h / 2, w, h);
            return (
              <g key={`army-${m.id}`}>
                <g
                  data-army-id={m.id}
                  className="army-marker-group"
                  transform={`translate(${m.x.toFixed(2)} ${m.y.toFixed(2)}) rotate(${m.angleDeg.toFixed(1)})`}
                  style={{ cursor: "pointer" }}
                >
                  {selected && (
                    <rect
                      x={-w / 2 - 2.5}
                      y={-h / 2 - 2.5}
                      width={w + 5}
                      height={h + 5}
                      fill="none"
                      stroke="#f5f0e6"
                      strokeWidth={1.2}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  <rect
                    x={-w / 2}
                    y={-h / 2}
                    width={w}
                    height={h}
                    fill={m.color}
                    stroke={m.stance === "battling" ? "#c23b2a" : "#1a1510"}
                    strokeWidth={m.stance === "battling" ? 2.2 : 1}
                    strokeDasharray={m.stance === "sieging" ? "2 1.5" : undefined}
                    className={m.stance === "battling" ? "army-marker-battling" : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                  {glyph.lines.map(([x1, y1, x2, y2], i) => (
                    <line
                      key={i}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="#1a1510"
                      strokeWidth={0.8}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {glyph.dots.map(([dx, dy], i) => (
                    <circle key={i} cx={dx} cy={dy} r={0.75} fill="#1a1510" />
                  ))}
                </g>
                <g
                  className="army-marker-label"
                  transform={`translate(${m.x.toFixed(2)} ${m.y.toFixed(2)})`}
                >
                  <text
                    x={0}
                    y={h / 2 + 6.5}
                    textAnchor="middle"
                    fontSize={5.5}
                    fill={m.labelColor}
                    stroke="#1a1510"
                    strokeWidth={0.6}
                    paintOrder="stroke fill"
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {formatCount(m.troops)}
                  </text>
                </g>
              </g>
            );
          })}
          {territoryLabels.flatMap((l) =>
            (l.curveDs || []).map((d, i) => (
              <path
                key={`curve-${l.key}-${i}`}
                id={`label-curve-${l.key}-${i}`}
                d={d}
                fill="none"
                stroke="none"
                pointerEvents="none"
              />
            )),
          )}
          {territoryLabels.flatMap((l) => {
            // Provinces : texte plat (rapide). Realms : textPath courbé.
            if (l.curveDs && l.curveDs.length > 0) {
              return l.lines.map((line, i) => (
                <text
                  key={`label-${l.key}-${i}`}
                  fontSize={l.fontSize}
                  fontWeight={700}
                  fill="#1a1510"
                  stroke="rgba(245, 236, 220, 0.55)"
                  strokeWidth={1.1}
                  strokeLinejoin="round"
                  paintOrder="stroke fill"
                  style={{
                    pointerEvents: "none",
                    userSelect: "none",
                    fontFamily:
                      "Palatino, 'Palatino Linotype', 'Book Antiqua', 'Times New Roman', serif",
                  }}
                >
                  <textPath
                    href={`#label-curve-${l.key}-${i}`}
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    {line}
                  </textPath>
                </text>
              ));
            }
            const x = l.x ?? 0;
            const y = l.y ?? 0;
            const ang = l.angle ?? 0;
            const lineH = l.fontSize * 1.05;
            const startY = y - ((l.lines.length - 1) * lineH) / 2;
            return l.lines.map((line, i) => (
              <text
                key={`label-${l.key}-${i}`}
                x={x}
                y={startY + i * lineH}
                textAnchor="middle"
                dominantBaseline="middle"
                transform={
                  Math.abs(ang) > 0.5 ? `rotate(${ang.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})` : undefined
                }
                fontSize={l.fontSize}
                fontWeight={600}
                fill="#1a1510"
                stroke="rgba(245, 236, 220, 0.5)"
                strokeWidth={0.9}
                strokeLinejoin="round"
                paintOrder="stroke fill"
                style={{
                  pointerEvents: "none",
                  userSelect: "none",
                  fontFamily:
                    "Palatino, 'Palatino Linotype', 'Book Antiqua', 'Times New Roman', serif",
                }}
              >
                {line}
              </text>
            ));
          })}
        </g>
      </svg>
      {selectedCity && (
        <div className="city-tooltip">
          <strong>{selectedCity.name}</strong>
          {selectedCity.kind === "civitas" && <span className="city-kind">Civitas capital</span>}
        </div>
      )}
    </div>
  );
}
