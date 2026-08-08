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

/** Sommets du triangle de tête de flèche pointant selon `angle` (radians), pointe en (x, y). */
function arrowHeadPoints(x: number, y: number, angle: number, size: number): [number, number][] {
  const spread = 0.5;
  const back = angle + Math.PI;
  const x1 = x + Math.cos(back + spread) * size;
  const y1 = y + Math.sin(back + spread) * size;
  const x2 = x + Math.cos(back - spread) * size;
  const y2 = y + Math.sin(back - spread) * size;
  return [
    [x, y],
    [x1, y1],
    [x2, y2],
  ];
}

/** Triangle plein pointant selon `angle` (radians), pointe en (x, y). */
function arrowHeadPath(x: number, y: number, angle: number, size: number): string {
  const [[px, py], [x1, y1], [x2, y2]] = arrowHeadPoints(x, y, angle, size);
  return `M${px.toFixed(2)},${py.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} Z`;
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

/**
 * Tuile de motif hachuré (petit canvas offscreen mis en cache) — reproduit
 * le contenu d'un `<pattern>` SVG *sans* sa rotation : `patternTransform`
 * fait pivoter toute la grille de répétition comme un bloc rigide, ce qui
 * ne carrelle proprement à n'importe quel angle que si la rotation est
 * appliquée à `CanvasPattern.setTransform(...)`, pas dessinée dans la
 * tuile elle-même (sinon coutures visibles à tout angle hors 45°).
 */
interface PatternSpec {
  id: string;
  size: number;
  angleDeg: number;
  draw: (tileCtx: CanvasRenderingContext2D, size: number) => void;
}

const IMPASSABLE_PATTERN_ID = "impassable-hatch";

function drawImpassableTile(tileCtx: CanvasRenderingContext2D, size: number) {
  tileCtx.fillStyle = "#141210";
  tileCtx.fillRect(0, 0, size, size);
  tileCtx.strokeStyle = "#3a3632";
  tileCtx.lineWidth = 2;
  tileCtx.beginPath();
  tileCtx.moveTo(0, 0);
  tileCtx.lineTo(0, size);
  tileCtx.stroke();
}

function drawOccupiedTile(colorA: string, colorB: string) {
  return (tileCtx: CanvasRenderingContext2D, size: number) => {
    tileCtx.globalAlpha = 0.85;
    tileCtx.fillStyle = colorB;
    tileCtx.fillRect(0, 0, size, size);
    tileCtx.fillStyle = colorA;
    tileCtx.fillRect(0, 0, size / 2, size);
    tileCtx.globalAlpha = 1;
  };
}

function drawDriftTile(color: string) {
  return (tileCtx: CanvasRenderingContext2D, size: number) => {
    tileCtx.globalAlpha = 0.1;
    tileCtx.fillStyle = color;
    tileCtx.fillRect(0, 0, size, size);
    tileCtx.globalAlpha = 0.65;
    tileCtx.strokeStyle = color;
    tileCtx.lineWidth = 2.5;
    tileCtx.setLineDash([2, 3]);
    tileCtx.beginPath();
    tileCtx.moveTo(0, 0);
    tileCtx.lineTo(0, size);
    tileCtx.stroke();
    tileCtx.setLineDash([]);
    tileCtx.globalAlpha = 1;
  };
}

function getOrBuildPattern(
  ctx: CanvasRenderingContext2D,
  cache: Map<string, CanvasPattern>,
  spec: PatternSpec,
): CanvasPattern | null {
  const cached = cache.get(spec.id);
  if (cached) return cached;
  const tile = document.createElement("canvas");
  tile.width = spec.size;
  tile.height = spec.size;
  const tileCtx = tile.getContext("2d");
  if (!tileCtx) return null;
  spec.draw(tileCtx, spec.size);
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return null;
  if (spec.angleDeg) pattern.setTransform(new DOMMatrix().rotate(spec.angleDeg));
  cache.set(spec.id, pattern);
  return pattern;
}

/** Épaisseur de trait constante à l'écran quel que soit le zoom (équivalent canvas de `vectorEffect="non-scaling-stroke"`). */
function paintNonScalingStroke(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  color: string,
  cssWidth: number,
  k: number,
) {
  ctx.lineWidth = cssWidth / k;
  ctx.strokeStyle = color;
  ctx.stroke(path);
}

/**
 * Géométrie pré-construite (Path2D + styles déjà résolus) de toute la
 * couche statique de la carte — reconstruite uniquement quand le contenu
 * change (niveau, sélection, tick de jour…), jamais à chaque frame de
 * caméra. `paintStaticGeometry` ne fait que la rejouer.
 */
interface StaticGeometry {
  mapW: number;
  mapH: number;
  ocean: {
    x: number;
    y: number;
    w: number;
    h: number;
    depth: { cx: number; cy: number; r: number };
    atlantique: { x1: number; y1: number; x2: number; y2: number };
  };
  land: Path2D | null;
  units: { path2d: Path2D; fill: string; fillOpacity: number; stroke: string; strokeWidth: number }[];
  hoverOutline: { path2d: Path2D; fill: string; stroke: string } | null;
  occupiedOverlays: { path2d: Path2D; patternId: string }[];
  occupiedHatchSpecs: PatternSpec[];
  enemyRealmBorderOverlays: { path2d: Path2D }[];
  warGoalOverlays: { path2d: Path2D }[];
  siegeOverlays: { path2d: Path2D; color: string; opacity: number }[];
  driftOverlays: { path2d: Path2D; patternId: string; color: string }[];
  driftHatchSpecs: PatternSpec[];
  hillshade: HTMLCanvasElement | null;
  impassable: { path2d: Path2D } | null;
  rivers: Path2D | null;
  landOutline: Path2D | null;
  cityMarkers: { x: number; y: number; r: number; fill: string; strokeWidth: number }[];
  selectedKingdomOutline: { path2d: Path2D; stroke: string } | null;
  claimFocusOutline: { path2d: Path2D; stroke: string } | null;
  armyMoveArrows: {
    path2d: Path2D;
    head: Path2D;
    headCenter: [number, number];
    color: string;
    friendly: boolean;
  }[];
  /** Peint sur un canvas séparé (`drawLabelLayer`), pas ici — regroupé dans la même géométrie car construit à partir des mêmes déclencheurs de contenu. */
  labels: LabelPaint[];
}

/** Rejoue `geo` sur `ctx` (déjà positionné avec la transform caméra courante) — dans le même ordre de peinture que l'ancien rendu SVG. */
function paintStaticGeometry(
  ctx: CanvasRenderingContext2D,
  geo: StaticGeometry,
  k: number,
  patternCache: Map<string, CanvasPattern>,
) {
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);

  // Océan.
  const { x: ox, y: oy, w: ow, h: oh } = geo.ocean;
  const depthGrad = ctx.createRadialGradient(
    geo.ocean.depth.cx,
    geo.ocean.depth.cy,
    0,
    geo.ocean.depth.cx,
    geo.ocean.depth.cy,
    geo.ocean.depth.r,
  );
  depthGrad.addColorStop(0, "#4a7382");
  depthGrad.addColorStop(0.28, "#3a5f6e");
  depthGrad.addColorStop(0.58, "#2a4a58");
  depthGrad.addColorStop(1, "#152832");
  ctx.fillStyle = depthGrad;
  ctx.fillRect(ox, oy, ow, oh);
  const atlGrad = ctx.createLinearGradient(
    geo.ocean.atlantique.x1,
    geo.ocean.atlantique.y1,
    geo.ocean.atlantique.x2,
    geo.ocean.atlantique.y2,
  );
  atlGrad.addColorStop(0, "rgba(16, 31, 40, 0.75)");
  atlGrad.addColorStop(0.55, "rgba(26, 51, 64, 0.25)");
  atlGrad.addColorStop(1, "rgba(42, 74, 88, 0)");
  ctx.fillStyle = atlGrad;
  ctx.fillRect(ox, oy, ow, oh);

  // Terre.
  if (geo.land) {
    ctx.fillStyle = LAND_COLOR;
    ctx.fill(geo.land);
  }

  // Domaines/provinces/royaumes + overlays. Pas de clip sur le masque
  // terrestre grossier ici (contrairement au relief plus bas) : ce masque
  // ne couvre pas certains îlots/franges côtières que les frontières fines
  // des domaines couvrent bien — le clip masquait alors entièrement le
  // remplissage de ces territoires tout en laissant leur libellé de texte
  // s'afficher (non clippé), donnant des noms flottant sans couleur en
  // dessous. Chaque unité a déjà sa propre géométrie précise, pas besoin
  // du masque grossier pour la contenir.
  for (const u of geo.units) {
    ctx.globalAlpha = u.fillOpacity;
    ctx.fillStyle = u.fill;
    ctx.fill(u.path2d);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = u.stroke;
    ctx.lineWidth = u.strokeWidth;
    ctx.stroke(u.path2d);
  }
  if (geo.hoverOutline) {
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = geo.hoverOutline.fill;
    ctx.fill(geo.hoverOutline.path2d);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#f5f0e6";
    ctx.lineWidth = 2.8;
    ctx.stroke(geo.hoverOutline.path2d);
  }
  for (const o of geo.occupiedOverlays) {
    const spec = geo.occupiedHatchSpecs.find((s) => s.id === o.patternId);
    const pattern = spec ? getOrBuildPattern(ctx, patternCache, spec) : null;
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fill(o.path2d);
    }
  }
  for (const o of geo.enemyRealmBorderOverlays) {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = WAR_ENEMY_COLOR;
    ctx.lineWidth = 2.2;
    ctx.stroke(o.path2d);
  }
  ctx.globalAlpha = 1;
  for (const o of geo.warGoalOverlays) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "#e8b93d";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 3]);
    ctx.stroke(o.path2d);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  for (const o of geo.siegeOverlays) {
    ctx.globalAlpha = o.opacity;
    ctx.fillStyle = o.color;
    ctx.fill(o.path2d);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.stroke(o.path2d);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  for (const o of geo.driftOverlays) {
    const spec = geo.driftHatchSpecs.find((s) => s.id === o.patternId);
    const pattern = spec ? getOrBuildPattern(ctx, patternCache, spec) : null;
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fill(o.path2d);
    }
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([1, 4]);
    ctx.stroke(o.path2d);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Relief (hillshade), fondu multiplicatif, clippé à la terre.
  if (geo.hillshade && geo.land) {
    ctx.save();
    ctx.clip(geo.land);
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.32;
    ctx.drawImage(geo.hillshade, 0, 0, geo.mapW, geo.mapH);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  // Zones infranchissables.
  if (geo.impassable) {
    const spec: PatternSpec = { id: IMPASSABLE_PATTERN_ID, size: 7, angleDeg: 35, draw: drawImpassableTile };
    const pattern = getOrBuildPattern(ctx, patternCache, spec);
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fill(geo.impassable.path2d);
    }
    ctx.strokeStyle = "#0a0908";
    ctx.lineWidth = 0.8;
    ctx.stroke(geo.impassable.path2d);
  }

  // Rivières.
  if (geo.rivers) {
    ctx.globalAlpha = 0.95;
    ctx.lineCap = "round";
    paintNonScalingStroke(ctx, geo.rivers, "#2a6a8a", 1.35, k);
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt";
  }

  // Contour côtier.
  if (geo.landOutline) {
    paintNonScalingStroke(ctx, geo.landOutline, "rgba(18, 28, 36, 0.85)", 1.2, k);
  }

  // Villes.
  for (const c of geo.cityMarkers) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fillStyle = c.fill;
    ctx.fill();
    ctx.lineWidth = c.strokeWidth / k;
    ctx.strokeStyle = "#efe6d4";
    ctx.stroke();
  }

  // Contours sélection / claim.
  if (geo.selectedKingdomOutline) {
    ctx.globalAlpha = 0.92;
    ctx.lineCap = "round";
    ctx.strokeStyle = geo.selectedKingdomOutline.stroke;
    ctx.lineWidth = 2.4;
    ctx.stroke(geo.selectedKingdomOutline.path2d);
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt";
  }
  if (geo.claimFocusOutline) {
    ctx.globalAlpha = 0.95;
    ctx.lineCap = "round";
    ctx.strokeStyle = geo.claimFocusOutline.stroke;
    ctx.lineWidth = 3.2;
    ctx.stroke(geo.claimFocusOutline.path2d);
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt";
  }

  // Flèches de marche.
  ctx.lineCap = "round";
  for (const a of geo.armyMoveArrows) {
    ctx.globalAlpha = 0.9;
    if (!a.friendly) ctx.setLineDash([3, 2.5]);
    paintNonScalingStroke(ctx, a.path2d, "#f5f0e6", a.friendly ? 3 : 2.4, k);
    ctx.globalAlpha = a.friendly ? 0.95 : 0.75;
    paintNonScalingStroke(ctx, a.path2d, a.color, a.friendly ? 1.6 : 1.1, k);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#f5f0e6";
    ctx.fill(a.head);
    ctx.globalAlpha = a.friendly ? 0.95 : 0.75;
    ctx.fillStyle = a.color;
    ctx.save();
    ctx.translate(a.headCenter[0], a.headCenter[1]);
    ctx.scale(0.72, 0.72);
    ctx.translate(-a.headCenter[0], -a.headCenter[1]);
    ctx.fill(a.head);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
}

/* ------------------------------------------------------------------ */
/* Libellés de territoire peints au canvas (plus de <text>/<textPath> SVG) */
/* ------------------------------------------------------------------ */

const LABEL_FONT_FAMILY = "Palatino, 'Palatino Linotype', 'Book Antiqua', 'Times New Roman', serif";

/** Contexte 2D jetable, uniquement pour `measureText` au moment de la construction de la géométrie — jamais utilisé pour peindre à l'écran. */
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx!;
}

/**
 * Échantillonnage régulier d'une quadratique (`M x0,y0 Q cx,cy x1,y1`) pour
 * retrouver une position par longueur d'arc — les courbes de libellé de
 * royaume sont toujours très légèrement bombées (voir `territoryBend` dans
 * territoryLabels.ts), un échantillonnage grossier suffit largement.
 */
function sampleQuadraticByLength(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
): { total: number; pointAt: (len: number) => { x: number; y: number; angle: number } } {
  const N = 32;
  const pts: { x: number; y: number; len: number }[] = [{ x: x0, y: y0, len: 0 }];
  let prevX = x0;
  let prevY = y0;
  let acc = 0;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    acc += Math.hypot(x - prevX, y - prevY);
    pts.push({ x, y, len: acc });
    prevX = x;
    prevY = y;
  }
  const total = acc;
  function pointAt(targetLen: number) {
    const len = Math.max(0, Math.min(total, targetLen));
    let i = 1;
    while (i < pts.length - 1 && pts[i].len < len) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = b.len - a.len || 1;
    const frac = (len - a.len) / segLen;
    return {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }
  return { total, pointAt };
}

const QUAD_D_RE = /M(-?[\d.]+),(-?[\d.]+)\s+Q(-?[\d.]+),(-?[\d.]+)\s+(-?[\d.]+),(-?[\d.]+)/;

interface CurvedGlyph {
  char: string;
  x: number;
  y: number;
  angle: number;
}

/**
 * Place chaque caractère de `text` le long de la courbe `d` (quadratique,
 * toujours produite par `curvedPath` dans territoryLabels.ts), centré sur
 * la longueur totale — équivalent canvas de
 * `<textPath startOffset="50%" textAnchor="middle">`.
 */
function layoutCurvedText(d: string, text: string, fontPx: number): CurvedGlyph[] {
  const m = QUAD_D_RE.exec(d);
  if (!m) return [];
  const [x0, y0, cx, cy, x1, y1] = m.slice(1).map(Number);
  const { total, pointAt } = sampleQuadraticByLength(x0, y0, cx, cy, x1, y1);
  const ctx = getMeasureCtx();
  ctx.font = `700 ${fontPx}px ${LABEL_FONT_FAMILY}`;
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const textWidth = widths.reduce((a, b) => a + b, 0);
  let cursor = total / 2 - textWidth / 2;
  const glyphs: CurvedGlyph[] = [];
  for (let i = 0; i < chars.length; i++) {
    const w = widths[i];
    const { x, y, angle } = pointAt(cursor + w / 2);
    glyphs.push({ char: chars[i], x, y, angle });
    cursor += w;
  }
  return glyphs;
}

interface LabelPaintFlat {
  kind: "flat";
  lines: string[];
  x: number;
  y: number;
  angleDeg: number;
  fontSize: number;
}
interface LabelPaintCurved {
  kind: "curved";
  lines: { glyphs: CurvedGlyph[] }[];
  fontSize: number;
}
type LabelPaint = LabelPaintFlat | LabelPaintCurved;

function paintLabels(ctx: CanvasRenderingContext2D, labels: LabelPaint[]) {
  ctx.lineJoin = "round";
  ctx.textAlign = "center";
  for (const l of labels) {
    if (l.kind === "flat") {
      ctx.font = `600 ${l.fontSize}px ${LABEL_FONT_FAMILY}`;
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "rgba(245, 236, 220, 0.5)";
      ctx.lineWidth = 0.9;
      ctx.fillStyle = "#1a1510";
      const lineH = l.fontSize * 1.05;
      const startY = l.y - ((l.lines.length - 1) * lineH) / 2;
      const rot = Math.abs(l.angleDeg) > 0.5 ? (l.angleDeg * Math.PI) / 180 : 0;
      ctx.save();
      if (rot) {
        ctx.translate(l.x, l.y);
        ctx.rotate(rot);
        ctx.translate(-l.x, -l.y);
      }
      l.lines.forEach((line, i) => {
        const y = startY + i * lineH;
        ctx.strokeText(line, l.x, y);
        ctx.fillText(line, l.x, y);
      });
      ctx.restore();
    } else {
      ctx.font = `700 ${l.fontSize}px ${LABEL_FONT_FAMILY}`;
      ctx.textBaseline = "alphabetic";
      ctx.strokeStyle = "rgba(245, 236, 220, 0.55)";
      ctx.lineWidth = 1.1;
      ctx.fillStyle = "#1a1510";
      for (const line of l.lines) {
        for (const g of line.glyphs) {
          ctx.save();
          ctx.translate(g.x, g.y);
          ctx.rotate(g.angle);
          ctx.strokeText(g.char, 0, 0);
          ctx.fillText(g.char, 0, 0);
          ctx.restore();
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Marqueurs d'armée peints au canvas (plus de <g>/<rect>/<text> SVG)    */
/* ------------------------------------------------------------------ */

interface ArmyMarkerPaint {
  id: number;
  x: number;
  y: number;
  angleDeg: number;
  troops: number;
  stance: Army["stance"];
  color: string;
  labelColor: string;
}

/** Palier `t` de l'oscillation `stroke-opacity` CSS `army-battle-pulse` (0.55 → 1 → 0.55 sur 1s, approximé en cosinus). */
function battlePulseOpacity(nowMs: number): number {
  return 0.775 - 0.225 * Math.cos((2 * Math.PI * nowMs) / 1000);
}

function paintArmyMarkers(
  ctx: CanvasRenderingContext2D,
  markers: ArmyMarkerPaint[],
  selectedArmyId: number | null,
  k: number,
  pulseOpacity: number,
) {
  const w = 8.4;
  const h = 12;
  for (const m of markers) {
    const tier = armySizeTier(m.troops);
    const glyph = armyGlyphParts(tier, -w / 2, -h / 2, w, h);
    const angleRad = (m.angleDeg * Math.PI) / 180;

    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(angleRad);

    if (selectedArmyId === m.id) {
      ctx.strokeStyle = "#f5f0e6";
      ctx.lineWidth = 1.2 / k;
      ctx.strokeRect(-w / 2 - 2.5, -h / 2 - 2.5, w + 5, h + 5);
    }

    ctx.globalAlpha = m.stance === "routing" ? 0.55 : 1;
    ctx.fillStyle = m.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.globalAlpha = m.stance === "battling" ? pulseOpacity : 1;
    ctx.strokeStyle = m.stance === "battling" ? "#c23b2a" : "#1a1510";
    ctx.lineWidth = (m.stance === "battling" ? 2.2 : 1) / k;
    if (m.stance === "sieging") ctx.setLineDash([2 / k, 1.5 / k]);
    else if (m.stance === "routing") ctx.setLineDash([1 / k, 1.4 / k]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "#1a1510";
    ctx.lineWidth = 0.8 / k;
    for (const [x1, y1, x2, y2] of glyph.lines) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.fillStyle = "#1a1510";
    for (const [dx, dy] of glyph.dots) {
      ctx.beginPath();
      ctx.arc(dx, dy, 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Libellé du nombre de troupes — jamais tourné (groupe séparé en SVG à l'origine).
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.font = "5.5px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a1510";
    ctx.lineWidth = 0.6;
    ctx.fillStyle = m.labelColor;
    const text = formatCount(m.troops);
    const ty = h / 2 + 6.5;
    ctx.strokeText(text, 0, ty);
    ctx.fillText(text, 0, ty);
    ctx.restore();
  }
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const dynamicCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dynamicCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const staticGeometryRef = useRef<StaticGeometry | null>(null);
  const dynamicGeometryRef = useRef<{
    markers: ArmyMarkerPaint[];
    selectedArmyId: number | null;
  }>({ markers: [], selectedArmyId: null });
  const patternCacheRef = useRef<Map<string, CanvasPattern>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hillshadeCanvas, setHillshadeCanvas] = useState<HTMLCanvasElement | null>(null);
  const [selectedCity, setSelectedCity] = useState<City | null>(null);
  const camRef = useRef({ x: 0, y: 0, k: 1 });
  const framedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const movedRef = useRef(false);
  const camRafRef = useRef(0);

  /**
   * Rejoue toute la couche statique (terre, domaines, overlays, relief,
   * villes, contours, flèches de marche) sur le `<canvas>` posé sous le SVG.
   * N'accède qu'à des refs et à des propriétés DOM live (jamais à `size`,
   * aux props ou au state par fermeture) : cette fonction est aussi appelée
   * depuis `onWheel`, figé une bonne fois pour toutes par `useCallback([])`
   * (voir plus bas) — sa fermeture ne verrait plus jamais une valeur de
   * state mise à jour après le montage.
   */
  function drawStaticLayer() {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#152832";
    ctx.fillRect(0, 0, cssW, cssH);
    const geo = staticGeometryRef.current;
    if (!geo) return;
    const c = camRef.current;
    ctx.setTransform(dpr * c.k, 0, 0, dpr * c.k, dpr * c.x, dpr * c.y);
    paintStaticGeometry(ctx, geo, c.k, patternCacheRef.current);
  }

  /**
   * Libellés de territoire — canvas séparé, empilé au-dessus des marqueurs
   * d'armée (même ordre de peinture que l'ancien SVG où les libellés
   * passaient en dernier). Redessiné avec les mêmes déclencheurs que
   * `drawStaticLayer` (même géométrie source, `staticGeometryRef.labels`),
   * juste sur une surface différente pour préserver cet empilement.
   */
  function drawLabelLayer() {
    const ctx = labelCtxRef.current;
    const canvas = labelCanvasRef.current;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const geo = staticGeometryRef.current;
    if (!geo) return;
    const c = camRef.current;
    ctx.setTransform(dpr * c.k, 0, 0, dpr * c.k, dpr * c.x, dpr * c.y);
    paintLabels(ctx, geo.labels);
  }

  /**
   * Marqueurs d'armée — canvas séparé (entre la couche statique et les
   * libellés) redessiné à sa propre cadence, indépendante de la caméra :
   * `dayProgress` avance ~20×/s pendant qu'une armée marche, et le tout mis
   * ensemble sur le canvas statique aurait fallu re-rastériser les ~750
   * domaines à ce rythme — exactement le problème que la mémoïsation
   * `staticMapLayer`/`staticGeometry` évite déjà côté contenu statique.
   */
  function drawDynamicLayer() {
    const ctx = dynamicCtxRef.current;
    const canvas = dynamicCanvasRef.current;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const { markers, selectedArmyId } = dynamicGeometryRef.current;
    if (!markers.length) return;
    const c = camRef.current;
    ctx.setTransform(dpr * c.k, 0, 0, dpr * c.k, dpr * c.x, dpr * c.y);
    paintArmyMarkers(ctx, markers, selectedArmyId, c.k, battlePulseOpacity(performance.now()));
  }

  function applyCam() {
    const c = camRef.current;
    const g = worldGroupRef.current;
    if (g) g.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
    // Les trois appels sont synchrones, dans le même tick JS que la mise à
    // jour de `g` juste au-dessus : le navigateur ne peut composer une
    // frame qu'une fois ce tick terminé, donc les trois canvases (et le SVG,
    // qui ne porte plus rien de visible) affichent forcément le même état de
    // caméra au même instant — plus de risque de désynchronisation visuelle
    // entre eux, contrairement à une transform SVG (composée par le GPU,
    // quasi immédiate) posée à côté d'un canvas qui doit vraiment
    // re-rastériser (retard possible pendant un mouvement rapide et continu).
    drawStaticLayer();
    drawLabelLayer();
    drawDynamicLayer();
  }

  /**
   * `pointermove`/`wheel` peuvent tirer bien plus vite que l'écran ne rafraîchit
   * (souris/trackpad haute fréquence) — appliquer la caméra à chaque évènement
   * brut fait retransformer (et re-rastériser) la carte plusieurs fois pour une
   * seule image affichée. On ne garde que la dernière position par frame.
   */
  function scheduleApplyCam() {
    if (camRafRef.current) return;
    camRafRef.current = requestAnimationFrame(() => {
      camRafRef.current = 0;
      applyCam();
    });
  }

  useEffect(() => {
    return () => {
      if (camRafRef.current) cancelAnimationFrame(camRafRef.current);
    };
  }, []);

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

  // Vue Alliances : ennemis de guerre du focus actuel (joueur par défaut, ou
  // personnage sélectionné) — indépendant de `focusWarId` (qui ne concerne
  // que l'onglet Guerre) : on veut TOUTES les guerres en cours du focus,
  // pour pouvoir inspecter n'importe quel pays sélectionné, pas seulement soi.
  const allianceEnemyIds = useMemo(() => {
    if (playerId == null) return [] as number[];
    const enemies = new Set<number>();
    for (const w of wars) {
      const side = warSideOf(w, playerId);
      if (!side) continue;
      if (side === "attacker") {
        enemies.add(w.defenderId);
        for (const id of w.allyOfDefender || []) enemies.add(id);
      } else {
        enemies.add(w.attackerId);
        for (const id of w.allyOfAttacker || []) enemies.add(id);
      }
    }
    return [...enemies];
  }, [wars, playerId]);

  const warView = level === "war";

  const units = useMemo(() => {
    if (warView) return getWarUnits(world, viewerId, warEnemyIds, warAllyIds);
    return getRenderUnits(world, level, selection, {
      majorOnly: pickMajorOnly && level === "possession",
      playerId,
      opinions,
      titles,
      alliances,
      armies,
      allianceEnemyIds,
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
    armies,
    allianceEnemyIds,
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
   * Territoire réellement en jeu dans mes guerres en cours — ce qui
   * basculera à la victoire : le war goal précis pour une guerre de claim,
   * sinon le royaume adverse en entier (indépendance, renversement, ou
   * conquête sans claim précise) — même dénominateur que `canPressDemands`.
   * Simple contour, ne touche pas au remplissage (self/ennemi/allié/neutre).
   * En vue Guerre avec une guerre précise mise en avant, restreint à celle-ci
   * — sinon (vue Possession, ou vue Guerre sans focus) couvre TOUTES mes
   * guerres en cours à la fois, pour repérer chaque front d'un coup d'œil
   * même sans passer par l'onglet Guerre.
   */
  const warGoalOverlays = useMemo(() => {
    if (viewerId == null) return [];
    if (level !== "war" && level !== "possession" && level !== "domaine") return [];
    const relevantWars =
      warView && focusWarId != null ? wars.filter((w) => w.id === focusWarId) : wars;
    const out: { key: string; d: string }[] = [];
    const seenDomains = new Set<number>();
    for (const war of relevantWars) {
      const mySide = warSideOf(war, viewerId);
      if (!mySide) continue;
      const cb = war.casusBelli ?? "claim_province";
      const goalIds =
        mySide === "attacker"
          ? (cb === "claim_province" || cb === "conquest") && war.warGoalDomainIds?.length
            ? war.warGoalDomainIds
            : war.conquestOrder
          : war.attackerFrontOrder;
      if (!goalIds?.length) continue;
      for (const domainId of goalIds) {
        if (seenDomains.has(domainId)) continue;
        seenDomains.add(domainId);
        const domaine = world.domaines.find((d) => d.id === domainId) ?? world.domaines[domainId];
        if (!domaine?.boundary?.length) continue;
        const d = ringsToPath(domaine.boundary, toXY);
        if (!d) continue;
        out.push({ key: `goal-${domainId}`, d });
      }
    }
    return out;
  }, [viewerId, level, warView, focusWarId, wars, world, toXY]);

  /**
   * Frontière de chaque royaume ennemi (toutes guerres en cours confondues)
   * — simple liseret par-dessus la vue Possession, pour repérer qui on
   * affronte sans devoir passer par l'onglet Guerre.
   */
  const enemyRealmBorderOverlays = useMemo(() => {
    if (viewerId == null || (level !== "possession" && level !== "domaine")) return [];
    const out: { key: string; d: string }[] = [];
    const seen = new Set<number>();
    for (const war of wars) {
      const side = warSideOf(war, viewerId);
      if (!side) continue;
      const enemyId = side === "attacker" ? war.defenderId : war.attackerId;
      if (seen.has(enemyId)) continue;
      seen.add(enemyId);
      const rings = getRealmBoundary(world, enemyId);
      if (!rings.length) continue;
      const d = ringsToPath(rings, toXY);
      if (!d) continue;
      out.push({ key: `enemy-border-${enemyId}`, d });
    }
    return out;
  }, [wars, viewerId, world, toXY, level]);

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
    const out: {
      id: number;
      d: string;
      head: string;
      headPoints: [number, number][];
      color: string;
      friendly: boolean;
    }[] = [];
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
      const headSize = friendly ? 5 : 4;
      out.push({
        id: army.id,
        d,
        head: arrowHeadPath(ex, ey, endAngle, headSize),
        headPoints: arrowHeadPoints(ex, ey, endAngle, headSize),
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
        // `buildHillshadeCanvas` renvoie déjà un canvas — `ctx.drawImage`
        // l'accepte directement, inutile de repasser par `toDataURL()` +
        // un `<img>`/`<image>` qui redécoderait un PNG en base64 pour rien.
        if (!cancelled) setHillshadeCanvas(canvas);
      } catch {
        if (!cancelled) setHillshadeCanvas(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Le relief (heightmap/bbox) ne change jamais en jeu — seuls dépendent
    // ici, volontairement pas `world` en entier, qui change de référence à
    // chaque jour calendaire (`cloneWorldMutable`) et relançait tout le
    // traitement d'image (flou, échantillonnage d'élévation) plusieurs fois
    // par seconde à vitesse 3×.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.heightmap, world.bbox]);

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

  // Contextes 2D pris une fois au montage (les trois canvases empilés).
  useEffect(() => {
    ctxRef.current = canvasRef.current?.getContext("2d") ?? null;
    dynamicCtxRef.current = dynamicCanvasRef.current?.getContext("2d") ?? null;
    labelCtxRef.current = labelCanvasRef.current?.getContext("2d") ?? null;
  }, []);

  /**
   * Le buffer de chaque canvas (résolution interne, distincte de sa taille
   * CSS) doit être redimensionné manuellement — le SVG gère nativement le
   * DPR (vecteur, toujours net), pas le canvas. Un resize vide aussi son
   * contenu, d'où le redessin explicite juste après.
   */
  useEffect(() => {
    const canvases = [canvasRef.current, dynamicCanvasRef.current, labelCanvasRef.current];
    if (canvases.some((c) => !c) || size.w < 1 || size.h < 1) return;
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of canvases) {
      canvas!.width = Math.round(size.w * dpr);
      canvas!.height = Math.round(size.h * dpr);
    }
    drawStaticLayer();
    drawLabelLayer();
    drawDynamicLayer();
  }, [size.w, size.h]);

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

  const onWheel = useCallback((e: WheelEvent) => {
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
    scheduleApplyCam();
  }, []);

  /**
   * React attache les listeners `wheel` en passif par défaut (perf) — un
   * `onWheel` React ne peut donc pas appeler `preventDefault()` (warning
   * "Unable to preventDefault inside passive event listener invocation",
   * et le zoom scrollerait la page en dessous). Un listener natif avec
   * `{ passive: false }` est le seul moyen de bloquer le scroll par défaut
   * tout en zoomant la carte.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

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
    scheduleApplyCam();
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
    // Un marqueur d'armée (le sien ou un ennemi) est rendu par-dessus le
    // domaine et intercepte le clic en premier — sans ce cas, viser une
    // armée (la sienne pour la garder sur place, une ennemie pour l'attaquer)
    // ne trouvait aucun `data-unit-level="domaine"` en remontant le DOM et
    // retombait sur le domaine le plus proche par distance, qui pouvait être
    // celui de départ (marche vers soi-même : chemin vide, ordre ignoré).
    const armyHit = el?.closest?.("[data-army-id]") as HTMLElement | null;
    if (armyHit) {
      const hitArmy = armies.find((a) => a.id === Number(armyHit.dataset.armyId));
      if (hitArmy) {
        onOrderMarch(selectedArmyId, hitArmy.domainId);
        return;
      }
    }
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

  /**
   * Géométrie de tout ce qui ne dépend pas de `dayProgress` (terre, domaines,
   * rivières, overlays, flèches de marche…) — construite en `Path2D` une
   * seule fois ici, rejouée sur le canvas à chaque frame de caméra sans
   * jamais reparser aucun `d`. Mêmes deps que l'ancien `staticMapLayer` SVG
   * (voir historique) : en le mémoïsant à part des marqueurs d'armée (qui
   * glissent en continu), le pan/zoom pendant la marche d'une armée ne
   * reconstruit pas cette géométrie 20×/s pour rien.
   */
  const staticGeometry = useMemo<StaticGeometry>(() => {
    const land = landPath ? new Path2D(landPath) : null;

    const units: StaticGeometry["units"] = [];
    for (const p of unitPaths) {
      if (!p.d) continue;
      const unitLevel = p.selectionLevel ?? level;
      const selected = selection?.level === unitLevel && selection.id === p.id;
      const highlighted = highlightId != null && p.id === highlightId;
      const isProvinceChild = p.selectionLevel === "province";
      const isDomainChild = p.selectionLevel === "domaine";
      units.push({
        path2d: new Path2D(p.d),
        fill: p.fill,
        fillOpacity: highlighted ? 1 : selected ? 0.95 : isProvinceChild || isDomainChild ? 0.9 : 0.85,
        stroke: highlighted ? "#f5f0e6" : selected ? "#1a1510" : p.stroke,
        strokeWidth: highlighted
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
                  : 0.55,
      });
    }

    const occupiedHatchSpecs: PatternSpec[] = occupiedHatchPatterns.map(({ id, colorA, colorB }) => ({
      id,
      size: 14,
      angleDeg: 45,
      draw: drawOccupiedTile(colorA, colorB),
    }));
    const driftHatchSpecs: PatternSpec[] = driftHatchPatterns.map(({ id, color }) => ({
      id,
      size: 11,
      angleDeg: 20,
      draw: drawDriftTile(color),
    }));

    const cityMarkers: StaticGeometry["cityMarkers"] =
      level === "domaine"
        ? (world.cities || []).map((city) => {
            const [x, y] = toXY(city.lon, city.lat);
            const selected = selectedCity?.id === city.id;
            const r = city.kind === "civitas" ? 2.4 : city.kind === "city" ? 1.7 : 1.35;
            return {
              x,
              y,
              r: selected ? r + 1.2 : r,
              fill: selected
                ? "#1a1510"
                : city.kind === "civitas"
                  ? "#3a2a18"
                  : city.kind === "city"
                    ? "#5a4030"
                    : "#6a5545",
              strokeWidth: selected ? 1.1 : 0.55,
            };
          })
        : [];

    return {
      mapW,
      mapH,
      ocean: {
        x: -mapW * 0.15,
        y: -mapH * 0.15,
        w: mapW * 1.3,
        h: mapH * 1.3,
        depth: { cx: mapW * 0.42, cy: mapH * 0.48, r: mapW * 0.85 },
        atlantique: { x1: 0, y1: mapH * 0.4, x2: mapW * 0.55, y2: mapH * 0.45 },
      },
      land,
      units,
      hoverOutline: hoverOutline
        ? { path2d: new Path2D(hoverOutline.d), fill: hoverOutline.fill, stroke: hoverOutline.stroke }
        : null,
      occupiedOverlays: occupiedOverlays.map((o) => ({ path2d: new Path2D(o.d), patternId: o.patternId })),
      occupiedHatchSpecs,
      enemyRealmBorderOverlays: enemyRealmBorderOverlays.map((o) => ({ path2d: new Path2D(o.d) })),
      warGoalOverlays: warGoalOverlays.map((o) => ({ path2d: new Path2D(o.d) })),
      siegeOverlays: siegeOverlays.map((o) => ({ path2d: new Path2D(o.d), color: o.color, opacity: o.opacity })),
      driftOverlays: driftOverlays.map((o) => ({ path2d: new Path2D(o.d), patternId: o.patternId, color: o.color })),
      driftHatchSpecs,
      hillshade: hillshadeCanvas,
      impassable: impassablePath ? { path2d: new Path2D(impassablePath) } : null,
      rivers: riversPath ? new Path2D(riversPath) : null,
      landOutline: land,
      cityMarkers,
      selectedKingdomOutline: selectedKingdomOutline
        ? { path2d: new Path2D(selectedKingdomOutline.d), stroke: selectedKingdomOutline.stroke }
        : null,
      claimFocusOutline: claimFocusOutline
        ? { path2d: new Path2D(claimFocusOutline.d), stroke: claimFocusOutline.stroke }
        : null,
      armyMoveArrows: armyMoveArrows.map((a) => {
        const [c1, c2, c3] = a.headPoints;
        return {
          path2d: new Path2D(a.d),
          head: new Path2D(a.head),
          headCenter: [(c1[0] + c2[0] + c3[0]) / 3, (c1[1] + c2[1] + c3[1]) / 3] as [number, number],
          color: a.color,
          friendly: a.friendly,
        };
      }),
      // Provinces : texte plat (rapide, nombreux). Realms : texte courbé,
      // glyphe par glyphe le long de la courbe — nettement plus coûteux par
      // libellé, mais il n'y en a jamais qu'une poignée (un par royaume).
      labels: territoryLabels.map((l): LabelPaint => {
        if (l.curveDs && l.curveDs.length > 0) {
          return {
            kind: "curved",
            fontSize: l.fontSize,
            lines: l.curveDs.map((d, i) => ({
              glyphs: layoutCurvedText(d, l.lines[i] ?? "", l.fontSize),
            })),
          };
        }
        return {
          kind: "flat",
          lines: l.lines,
          x: l.x ?? 0,
          y: l.y ?? 0,
          angleDeg: l.angle ?? 0,
          fontSize: l.fontSize,
        };
      }),
    };
  }, [
    mapW,
    mapH,
    landPath,
    unitPaths,
    level,
    selection,
    highlightId,
    world,
    toXY,
    hoverOutline,
    occupiedOverlays,
    occupiedHatchPatterns,
    warGoalOverlays,
    enemyRealmBorderOverlays,
    siegeOverlays,
    driftOverlays,
    driftHatchPatterns,
    hillshadeCanvas,
    impassablePath,
    riversPath,
    selectedCity,
    selectedKingdomOutline,
    claimFocusOutline,
    armyMoveArrows,
    territoryLabels,
  ]);

  useEffect(() => {
    staticGeometryRef.current = staticGeometry;
    drawStaticLayer();
    drawLabelLayer();
  }, [staticGeometry]);

  /**
   * Marqueurs d'armée — déclencheur séparé (`armyMarkers`/`selectedArmyId`),
   * indépendant du reste du contenu : c'est ce qui change ~20×/s pendant
   * qu'une armée marche (`dayProgress`), sans jamais devoir toucher au
   * canvas statique.
   */
  useEffect(() => {
    dynamicGeometryRef.current = { markers: armyMarkers, selectedArmyId };
    drawDynamicLayer();
  }, [armyMarkers, selectedArmyId]);

  const anyArmyBattling = useMemo(
    () => armyMarkers.some((m) => m.stance === "battling"),
    [armyMarkers],
  );

  /**
   * Pulsation `army-battle-pulse` (CSS à l'origine, `stroke-opacity` 0.55→1
   * en boucle) : sur canvas, il faut une boucle `requestAnimationFrame`
   * dédiée tant qu'au moins une armée se bat. Dépend du booléen dérivé
   * `anyArmyBattling`, pas de `armyMarkers` lui-même (qui change de
   * référence à chaque tick de `dayProgress`) — sinon cet effet
   * redémarrerait la boucle en boucle pendant toute marche d'armée, pas
   * seulement pendant un combat.
   */
  useEffect(() => {
    if (!anyArmyBattling) return;
    let raf = 0;
    const loop = () => {
      drawDynamicLayer();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anyArmyBattling]);

  /**
   * Couche SVG invisible posée par-dessus le canvas — uniquement pour que
   * les clics/survols existants (`data-unit-id`, `data-city-id`,
   * `elementFromPoint` dans `onPointerUp`/`onContextMenu`) continuent de
   * fonctionner sans réécriture : `fill:none;stroke:none` + `pointer-events:
   * all` pour rester cliquable sans rien peindre. Ordre conservé identique
   * à l'ancien z-index de clic (domaines puis villes, avant les marqueurs
   * d'armée). Ne dépend plus de `selection`/`highlightId`/`selectedCity`
   * (qui n'affectaient que l'apparence, désormais gérée par le canvas) —
   * moins de dépendances que l'ancien bloc combiné, donc encore moins de
   * réconciliation.
   */
  const hitLayer = useMemo(
    () => (
      <>
        {unitPaths.map((p) => {
          if (!p.d) return null;
          const unitLevel = p.selectionLevel ?? level;
          return (
            <path
              key={`${unitLevel}-${p.id}`}
              data-unit-id={p.id}
              data-unit-level={unitLevel}
              d={p.d}
              fill="none"
              stroke="none"
              style={{ cursor: "pointer", pointerEvents: "all" }}
              onMouseEnter={() => {
                if (!onHover) return;
                if (unitLevel === "domaine") {
                  const d = world.domaines.find((x) => x.id === p.id) ?? world.domaines[p.id];
                  onHover(d?.possessionId ?? null);
                  return;
                }
                if (unitLevel === "possession") onHover(p.id);
              }}
              onMouseLeave={() => onHover?.(null)}
            />
          );
        })}
        {level === "domaine" &&
          cityMarkers.map(({ city, x, y }) => {
            const r = city.kind === "civitas" ? 2.4 : city.kind === "city" ? 1.7 : 1.35;
            return (
              <circle
                key={city.id}
                data-city-id={city.id}
                cx={x}
                cy={y}
                r={r + 1.2}
                fill="none"
                stroke="none"
                style={{ cursor: "pointer", pointerEvents: "all" }}
              />
            );
          })}
      </>
    ),
    [unitPaths, level, onHover, world, cityMarkers],
  );

  // Les libellés de territoire sont désormais peints sur `labelCanvasRef`
  // (voir `staticGeometry.labels` + `drawLabelLayer`/`paintLabels`) — plus
  // de <text>/<textPath> SVG ici.

  return (
    <div
      ref={containerRef}
      className="map2d"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      {/*
        Trois canvases empilés (ordre DOM = ordre de peinture, cf. App.css
        `.map2d-canvas { position:absolute; inset:0 }`) : terrain/domaines
        (redessiné sur changement de contenu/caméra) → marqueurs d'armée
        (redessiné en plus à chaque tick de `dayProgress`, cadence propre) →
        libellés (au-dessus des marqueurs, même déclencheurs que le
        terrain). Le SVG par-dessus ne porte plus que des formes invisibles
        pour les clics/survols.
      */}
      <canvas ref={canvasRef} className="map2d-canvas" />
      <canvas ref={dynamicCanvasRef} className="map2d-canvas" />
      <canvas ref={labelCanvasRef} className="map2d-canvas" />
      <svg width={size.w} height={size.h} className="map2d-svg" style={{ display: "block" }}>
        <g ref={worldGroupRef}>
          {hitLayer}
          {/* Peinture réelle sur dynamicCanvasRef (paintArmyMarkers) — ceci n'est plus qu'une zone de clic invisible, généreuse, alignée sur le rectangle visible. */}
          {armyMarkers.map((m) => (
            <rect
              key={`army-hit-${m.id}`}
              data-army-id={m.id}
              x={-7}
              y={-9}
              width={14}
              height={18}
              transform={`translate(${m.x.toFixed(2)} ${m.y.toFixed(2)}) rotate(${m.angleDeg.toFixed(1)})`}
              fill="none"
              stroke="none"
              style={{ cursor: "pointer", pointerEvents: "all" }}
            />
          ))}
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
