import polylabel from "polylabel";
import type { LevelName } from "../types/world";

export interface TerritoryLabel {
  key: string;
  lines: string[];
  fontSize: number;
  labelLevel: "royaume" | "province" | "possession" | "terrain";
  /** Courbes (realm) — absentes pour provinces / possessions / terrains (texte plat). */
  curveDs?: string[];
  /** Ancrage texte plat. */
  x?: number;
  y?: number;
  angle?: number;
}

const CHAR_W = 0.75;
const MAX_TILT_RAD = (18 * Math.PI) / 180;

function ringsToXY(
  rings: [number, number][][],
  toXY: (lon: number, lat: number) => [number, number],
  /** Sous-échantillonnage pour polylabel / PCA (perf provinces). */
  maxPts = 0,
): [number, number][][] {
  const out: [number, number][][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let src = ring;
    if (maxPts > 0 && ring.length > maxPts) {
      const step = Math.ceil(ring.length / maxPts);
      src = ring.filter((_, i) => i % step === 0 || i === ring.length - 1);
    }
    const pts: [number, number][] = src.map(([lon, lat]) => toXY(lon, lat));
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]);
    out.push(pts);
  }
  return out;
}

function ringArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(a) * 0.5;
}

function bboxOf(ringsXY: [number, number][][]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of ringsXY) {
    for (const [x, y] of r) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-15) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInRings(x: number, y: number, rings: [number, number][][]): boolean {
  for (const r of rings) {
    if (pointInRing(x, y, r)) return true;
  }
  return false;
}

function sampleQuad(
  x0: number,
  y0: number,
  mx: number,
  my: number,
  x1: number,
  y1: number,
  n: number,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * x0 + 2 * u * t * mx + t * t * x1,
      u * u * y0 + 2 * u * t * my + t * t * y1,
    ]);
  }
  return pts;
}

function curveEnds(cx: number, cy: number, halfLen: number, angle: number, bend: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x0: cx - cos * halfLen,
    y0: cy - sin * halfLen,
    x1: cx + cos * halfLen,
    y1: cy + sin * halfLen,
    mx: cx + -sin * bend,
    my: cy + cos * bend,
  };
}

function curveInside(
  cx: number,
  cy: number,
  halfLen: number,
  angle: number,
  bend: number,
  unitXY: [number, number][][],
): boolean {
  const e = curveEnds(cx, cy, halfLen, angle, bend);
  for (const [x, y] of sampleQuad(e.x0, e.y0, e.mx, e.my, e.x1, e.y1, 8)) {
    if (!pointInRings(x, y, unitXY)) return false;
  }
  return true;
}

function approxLen(
  x0: number,
  y0: number,
  mx: number,
  my: number,
  x1: number,
  y1: number,
): number {
  const pts = sampleQuad(x0, y0, mx, my, x1, y1, 12);
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len;
}

function axisAngle(pts: [number, number][], cx: number, cy: number): number {
  let sxx = 0,
    sxy = 0,
    syy = 0;
  const step = Math.max(1, (pts.length / 20) | 0);
  for (let i = 0; i < pts.length; i += step) {
    const dx = pts[i][0] - cx;
    const dy = pts[i][1] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return Math.max(-MAX_TILT_RAD, Math.min(MAX_TILT_RAD, angle));
}

function bestLabelPoint(ringsXY: [number, number][][]): {
  x: number;
  y: number;
  clearance: number;
  main: [number, number][];
} | null {
  if (!ringsXY.length) return null;
  const sorted = [...ringsXY].sort((a, b) => ringArea(b) - ringArea(a));
  const main = sorted[0];

  try {
    const p = polylabel([main], 3.0) as [number, number] & { distance: number };
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      return { x: p[0], y: p[1], clearance: p.distance || 0, main };
    }
  } catch {
    /* fallback */
  }

  const bb = bboxOf([main]);
  return {
    x: (bb.minX + bb.maxX) * 0.5,
    y: (bb.minY + bb.maxY) * 0.5,
    clearance: Math.min(bb.w, bb.h) * 0.25,
    main,
  };
}

function curvedPath(
  cx: number,
  cy: number,
  halfLen: number,
  angle: number,
  bend: number,
): string {
  const e = curveEnds(cx, cy, halfLen, angle, bend);
  return `M${e.x0.toFixed(1)},${e.y0.toFixed(1)} Q${e.mx.toFixed(1)},${e.my.toFixed(1)} ${e.x1.toFixed(1)},${e.y1.toFixed(1)}`;
}

function territoryBend(
  halfLen: number,
  clearance: number,
  w: number,
  h: number,
): number {
  const minDim = Math.min(w, h);
  const elong = Math.max(w, h) / (minDim || 1);
  const plump = Math.max(0, Math.min(1, (2.4 - elong) / 1.4));
  const raw = halfLen * (0.04 + plump * 0.16);
  return Math.min(raw, clearance * 0.45, minDim * 0.12);
}

function maxHalfLenInside(
  cx: number,
  cy: number,
  angle: number,
  bendMag: (hl: number) => number,
  unitXY: [number, number][][],
  hiCap: number,
): { halfLen: number; bend: number } {
  const search = (sign: 1 | -1) => {
    let lo = 2;
    let hi = Math.max(4, hiCap);
    let bestHl = 0;
    let bestBend = 0;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const bend = sign * bendMag(mid);
      if (curveInside(cx, cy, mid, angle, bend, unitXY)) {
        bestHl = mid;
        bestBend = bend;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    bestHl *= 0.9;
    bestBend *= 0.9;
    if (bestHl >= 3 && !curveInside(cx, cy, bestHl, angle, bestBend, unitXY)) {
      bestBend = 0;
      if (!curveInside(cx, cy, bestHl, angle, 0, unitXY)) {
        return { halfLen: 0, bend: 0 };
      }
    }
    return { halfLen: bestHl, bend: bestBend };
  };

  const a = search(1);
  const b = search(-1);
  if (a.halfLen > b.halfLen + 0.5) return a;
  if (b.halfLen > a.halfLen + 0.5) return b;
  return Math.abs(a.bend) >= Math.abs(b.bend) ? a : b;
}

function displayName(
  name: string,
  labelLevel: "royaume" | "province" | "possession" | "terrain",
): string {
  if (labelLevel === "royaume") {
    return name.replace(/\s+Kingdom$/i, "").replace(/^Domain of\s+/i, "").trim() || name;
  }
  // Provinces : enlever la ville entre parenthèses si long
  const m = name.match(/^(.+?)\s*\([^)]+\)\s*$/);
  if (m && name.length > 16) return m[1].trim();
  return name;
}

function splitName(name: string): [string, string] {
  const upper = name.toUpperCase();
  const dash = upper.indexOf("-");
  if (dash > 0 && dash < upper.length - 1) {
    return [upper.slice(0, dash), upper.slice(dash + 1)];
  }
  const space = upper.lastIndexOf(" ", Math.ceil(upper.length / 2));
  if (space > 0 && space < upper.length - 1) {
    return [upper.slice(0, space), upper.slice(space + 1)];
  }
  const mid = Math.ceil(upper.length / 2);
  const cut = Math.max(2, Math.min(upper.length - 2, mid));
  return [upper.slice(0, cut), upper.slice(cut)];
}

/** Labels plats (provinces / possessions) : polylabel, pas de textPath. */
function buildFlatLabel(
  u: { id: number; name: string; boundary: [number, number][][] },
  toXY: (lon: number, lat: number) => [number, number],
  labelLevel: "royaume" | "province" | "possession" | "terrain",
): TerritoryLabel | null {
  const ringsXY = ringsToXY(u.boundary, toXY, 64);
  if (!ringsXY.length) return null;
  const pt = bestLabelPoint(ringsXY);
  if (!pt) return null;
  const bb = bboxOf(ringsXY);
  const minDim = Math.min(bb.w, bb.h);
  // Demesne rois / petits royaumes (île, enclave) = seuils plus bas pour les labels
  if (
    minDim <
    (labelLevel === "possession" || labelLevel === "royaume"
      ? 8
      : labelLevel === "terrain"
        ? 18
        : 22)
  )
    return null;

  const full = displayName(u.name, labelLevel).toUpperCase();
  const preferTwo = /[- ]/.test(full);
  const byClear = pt.clearance * 0.8;
  const byWidth = (bb.w * 0.82) / Math.max(3, (preferTwo ? full.length * 0.55 : full.length) * CHAR_W);
  const byHeight = bb.h * (labelLevel === "possession" || labelLevel === "royaume" ? 0.4 : labelLevel === "terrain" ? 0.32 : 0.26);
  const raw = Math.min(byClear || byHeight, byWidth, byHeight);
  const fontSize = Math.max(
    labelLevel === "possession" || labelLevel === "royaume" ? 5.5 : 6.5,
    Math.min(labelLevel === "possession" || labelLevel === "royaume" ? 13 : labelLevel === "terrain" ? 18 : 14, raw || 6.5),
  );

  const angleDeg = (axisAngle(pt.main, pt.x, pt.y) * 180) / Math.PI;

  if (preferTwo || fontSize * full.length * CHAR_W > bb.w * 0.95) {
    const [l1, l2] = splitName(full);
    return {
      key: `${labelLevel}-${u.id}`,
      lines: [l1, l2],
      fontSize: Math.max(6, fontSize * 0.92),
      labelLevel,
      x: pt.x,
      y: pt.y,
      angle: angleDeg,
    };
  }

  return {
    key: `${labelLevel}-${u.id}`,
    lines: [full],
    fontSize,
    labelLevel,
    x: pt.x,
    y: pt.y,
    angle: angleDeg,
  };
}

/** Labels realms : courbes adaptées (peu nombreux). */
function buildRealmLabel(
  u: { id: number; name: string; boundary: [number, number][][] },
  toXY: (lon: number, lat: number) => [number, number],
): TerritoryLabel | null {
  const ringsXY = ringsToXY(u.boundary, toXY, 120);
  if (!ringsXY.length) return null;
  const pt = bestLabelPoint(ringsXY);
  if (!pt) return null;
  const bb = bboxOf(ringsXY);
  const full = displayName(u.name, "royaume").toUpperCase();
  const angle = axisAngle(pt.main, pt.x, pt.y);

  const bendFn = (hl: number) => territoryBend(hl, pt.clearance, bb.w, bb.h);
  const fit = maxHalfLenInside(
    pt.x,
    pt.y,
    angle,
    bendFn,
    ringsXY,
    Math.max(bb.w, bb.h) * 0.48,
  );
  if (fit.halfLen < 4) return null;

  const e0 = curveEnds(pt.x, pt.y, fit.halfLen, angle, fit.bend);
  const pathLen = approxLen(e0.x0, e0.y0, e0.mx, e0.my, e0.x1, e0.y1) * 0.9;
  if (pathLen < 8) return null;

  const minFs = 9;
  const maxFs = 24;
  const fsOne = Math.min(maxFs, (pathLen * 0.88) / (Math.max(2, full.length) * CHAR_W));
  const canOneLine = fsOne >= minFs * 0.9;

  // Une seule ligne dès que ça tient : la couper en deux n’a d’intérêt que
  // quand c’est nécessaire — sinon le gap entre les deux lignes peut
  // s’effondrer sur les petits territoires et les deux textes se
  // chevauchent (illisible), voir le repli du gap minimal plus bas.
  if (canOneLine) {
    return {
      key: `royaume-${u.id}`,
      lines: [full],
      curveDs: [curvedPath(pt.x, pt.y, fit.halfLen, angle, fit.bend)],
      fontSize: fsOne,
      labelLevel: "royaume",
    };
  }

  const [l1, l2] = splitName(full);
  const longest = Math.max(l1.length, l2.length);
  let fontSize = Math.min(maxFs * 0.92, (pathLen * 0.88) / (longest * CHAR_W));
  fontSize = Math.max(minFs * 0.8, fontSize);

  // Plancher absolu sur le gap : sans ça, un territoire étroit peut donner
  // un gap proche de 0 et les deux lignes de texte se superposent lettre
  // par lettre (illisible) au lieu de rester lisibles l’une sous l’autre.
  const gap = Math.max(
    fontSize * 0.95,
    Math.min(fontSize * 1.15, pt.clearance * 0.55, fit.halfLen * 0.22),
  );
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const sign: 1 | -1 = fit.bend >= 0 ? 1 : -1;

  const mkLine = (cx: number, cy: number) => {
    const hl = fit.halfLen;
    let useBend = sign * territoryBend(hl, pt.clearance, bb.w, bb.h);
    if (!curveInside(cx, cy, hl, angle, useBend, ringsXY)) useBend = -useBend;
    if (!curveInside(cx, cy, hl, angle, useBend, ringsXY)) useBend = 0;
    if (!curveInside(cx, cy, hl, angle, useBend, ringsXY)) {
      const shrunk = hl * 0.85;
      if (curveInside(cx, cy, shrunk, angle, 0, ringsXY)) {
        return curvedPath(cx, cy, shrunk, angle, 0);
      }
    }
    return curvedPath(cx, cy, hl, angle, useBend);
  };

  return {
    key: `royaume-${u.id}`,
    lines: [l1, l2],
    curveDs: [
      mkLine(pt.x - nx * gap * 0.5, pt.y - ny * gap * 0.5),
      mkLine(pt.x + nx * gap * 0.5, pt.y + ny * gap * 0.5),
    ],
    fontSize,
    labelLevel: "royaume",
  };
}

export function buildMapLabels(
  units: {
    id: number;
    name: string;
    boundary: [number, number][][];
    selectionLevel?: LevelName;
  }[],
  mapLevel: LevelName,
  selection: { level: LevelName; id: number } | null,
  toXY: (lon: number, lat: number) => [number, number],
): TerritoryLabel[] {
  const out: TerritoryLabel[] = [];

  for (const u of units) {
    const unitLevel = u.selectionLevel ?? mapLevel;
    if (
      unitLevel !== "royaume" &&
      unitLevel !== "province" &&
      unitLevel !== "possession" &&
      unitLevel !== "terrain"
    )
      continue;
    if (selection?.level === unitLevel && selection.id === u.id) continue;
    if (mapLevel === "domaine" && !u.selectionLevel) continue;

    // Royaumes : label courbe si assez grand ; sinon repli sur un label
    // plat (comme les provinces) — sans ça, les petits royaumes (île,
    // enclave) n’affichaient carrément aucun nom sur la carte.
    const label =
      unitLevel === "royaume"
        ? (buildRealmLabel(u, toXY) ?? buildFlatLabel(u, toXY, "royaume"))
        : buildFlatLabel(
            u,
            toXY,
            unitLevel === "possession"
              ? "possession"
              : unitLevel === "terrain"
                ? "terrain"
                : "province",
          );
    if (label) out.push(label);
  }

  return out;
}
