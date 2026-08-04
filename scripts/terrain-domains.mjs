/**
 * Domaines = tuiles de base (grille mondiale unique → topologie sans trous).
 * Provinces / royaumes = unions de domaines (côté generate-ck-map).
 *
 * Relief influence le coût ; rivières peuvent traverser un domaine (capitale).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import * as turf from "@turf/turf";

const IMPASSABLE_M = 1600;
const HARD_IMPASSABLE_M = 1900;
/** ~4.5 km — assez fin pour la côte, une seule grille pour toute la carte */
const GRID_STEP_DEG = 0.042;

class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].c <= a[i].c) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let s = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < a.length && a[l].c < a[s].c) s = l;
        if (r < a.length && a[r].c < a[s].c) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

export function loadHeightmap(publicDir, bbox, meta) {
  const png = PNG.sync.read(readFileSync(join(publicDir, "heightmap.png")));
  const { width, height, data } = png;
  const range = meta.maxElevation - meta.minElevation;
  const elev = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const hi = data[i * 4];
    const lo = data[i * 4 + 1];
    elev[i] = meta.minElevation + (((hi << 8) | lo) / 65535) * range;
  }
  function elevAt(lon, lat) {
    const u = ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * (width - 1);
    const v = ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * (height - 1);
    const x0 = Math.min(width - 2, Math.max(0, Math.floor(u)));
    const y0 = Math.min(height - 2, Math.max(0, Math.floor(v)));
    const fx = u - x0;
    const fy = v - y0;
    const i00 = y0 * width + x0;
    return (
      elev[i00] * (1 - fx) * (1 - fy) +
      elev[i00 + 1] * fx * (1 - fy) +
      elev[i00 + width] * (1 - fx) * fy +
      elev[i00 + width + 1] * fx * fy
    );
  }
  return { elevAt, width, height };
}

export function loadRivers(cacheDir, bbox, landMask) {
  const clippedPath = join(
    cacheDir,
    `rivers10_raw_${bbox.lonMin}_${bbox.lonMax}_${bbox.latMin}_${bbox.latMax}.json`,
  );
  if (existsSync(clippedPath)) {
    return JSON.parse(readFileSync(clippedPath, "utf8"));
  }
  const src = existsSync(join(cacheDir, "ne_10m_rivers.geojson"))
    ? join(cacheDir, "ne_10m_rivers.geojson")
    : join(cacheDir, "ne_50m_rivers.geojson");
  const raw = JSON.parse(readFileSync(src, "utf8"));
  const bboxPoly = turf.bboxPolygon([bbox.lonMin, bbox.latMin, bbox.lonMax, bbox.latMax]);
  const lines = [];
  for (const f of raw.features) {
    if (!f.geometry) continue;
    try {
      if (!turf.booleanIntersects(f, bboxPoly)) continue;
      const clipped = turf.bboxClip(f, [bbox.lonMin, bbox.latMin, bbox.lonMax, bbox.latMax]);
      if (!clipped?.geometry) continue;
      const sr = f.properties?.scalerank ?? 6;
      if (sr > 6) continue;
      const coords =
        clipped.geometry.type === "LineString"
          ? [clipped.geometry.coordinates]
          : clipped.geometry.type === "MultiLineString"
            ? clipped.geometry.coordinates
            : [];
      for (const line of coords) {
        if (line.length < 2) continue;
        const mid = line[Math.floor(line.length / 2)];
        try {
          if (!turf.booleanPointInPolygon(turf.point(mid), landMask)) continue;
        } catch {
          /* keep */
        }
        const maxPts = 120;
        if (line.length <= maxPts) lines.push(line);
        else {
          for (let i = 0; i < line.length - 1; i += maxPts - 1) {
            lines.push(line.slice(i, Math.min(line.length, i + maxPts)));
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  writeFileSync(clippedPath, JSON.stringify(lines));
  return lines;
}

function closeRing(ring) {
  if (!ring?.length) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, ring[0]];
}

/** Supprime les anneaux aplatis / lames (hauteur nulle, aspect extrême, aire nulle). */
function isDegenerateRing(ring) {
  if (!ring || ring.length < 4) return true;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 1e-8) || !(h > 1e-8)) return true;
  const aspect = w > h ? w / h : h / w;
  let area = 0;
  try {
    area = turf.area(turf.polygon([closeRing(ring)]));
  } catch {
    return true;
  }
  if (!(area > 8e5)) return true; // < 0.8 km²
  // Lame horizontale/verticale
  if (aspect > 6) return true;
  return false;
}

function cleanRings(rings) {
  if (!rings?.length) return [];
  return rings.map(closeRing).filter((r) => !isDegenerateRing(r));
}

/** Contours raster — sommets partagés entre voisins (pas de lissage). */
function polygonizeLabel(owner, cols, rows, label, west, north, step) {
  const edges = new Map();
  const key = (x1, y1, x2, y2) => `${x1},${y1},${x2},${y2}`;
  const addEdge = (x1, y1, x2, y2) => {
    const rev = key(x2, y2, x1, y1);
    if (edges.has(rev)) edges.delete(rev);
    else edges.set(key(x1, y1, x2, y2), [x1, y1, x2, y2]);
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (owner[y * cols + x] !== label) continue;
      if (x === 0 || owner[y * cols + x - 1] !== label) addEdge(x, y, x, y + 1);
      if (x === cols - 1 || owner[y * cols + x + 1] !== label) addEdge(x + 1, y + 1, x + 1, y);
      if (y === 0 || owner[(y - 1) * cols + x] !== label) addEdge(x + 1, y, x, y);
      if (y === rows - 1 || owner[(y + 1) * cols + x] !== label) addEdge(x, y + 1, x + 1, y + 1);
    }
  }

  const byStart = new Map();
  for (const e of edges.values()) {
    const k = `${e[0]},${e[1]}`;
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(e);
  }

  const rings = [];
  while (byStart.size) {
    const startKey = byStart.keys().next().value;
    const startList = byStart.get(startKey);
    if (!startList?.length) {
      byStart.delete(startKey);
      continue;
    }
    const first = startList.pop();
    if (!startList.length) byStart.delete(startKey);
    const ring = [
      [first[0], first[1]],
      [first[2], first[3]],
    ];
    let cx = first[2];
    let cy = first[3];
    const sx = first[0];
    const sy = first[1];
    let guard = edges.size + 5;
    while ((cx !== sx || cy !== sy) && guard-- > 0) {
      const k = `${cx},${cy}`;
      const list = byStart.get(k);
      if (!list?.length) break;
      const next = list.pop();
      if (!list.length) byStart.delete(k);
      ring.push([next[2], next[3]]);
      cx = next[2];
      cy = next[3];
    }
    if (ring.length < 4) continue;
    rings.push(
      closeRing(
        ring.map(([gx, gy]) => [west + gx * step, north - gy * step]),
      ),
    );
  }
  return rings;
}

function openRing(ring) {
  if (!ring?.length) return [];
  if (
    ring.length >= 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    return ring.slice(0, -1);
  }
  return ring.slice();
}

function pk(p) {
  return `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
}
function parsePk(k) {
  const i = k.indexOf(",");
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

/** Densifie une fois (Chaikin) puis lisse sans exploser le nombre de points. */
function chaikinOpenOnce(pts) {
  if (pts.length < 2) return pts.map((q) => [q[0], q[1]]);
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
    out.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Moyenne glissante extrémités figées — casse les marches d’escalier. */
function smoothOpenFixedEnds(pts, passes) {
  let p = pts.map((q) => [q[0], q[1]]);
  for (let pass = 0; pass < passes; pass++) {
    if (p.length < 3) break;
    const out = new Array(p.length);
    out[0] = p[0];
    out[p.length - 1] = p[p.length - 1];
    for (let i = 1; i < p.length - 1; i++) {
      out[i] = [
        0.22 * p[i - 1][0] + 0.56 * p[i][0] + 0.22 * p[i + 1][0],
        0.22 * p[i - 1][1] + 0.56 * p[i][1] + 0.22 * p[i + 1][1],
      ];
    }
    p = out;
  }
  return p;
}

function smoothClosed(pts, passes) {
  let p = pts.map((q) => [q[0], q[1]]);
  for (let pass = 0; pass < passes; pass++) {
    const n = p.length;
    if (n < 3) break;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n];
      const b = p[i];
      const c = p[(i + 1) % n];
      out[i] = [0.22 * a[0] + 0.56 * b[0] + 0.22 * c[0], 0.22 * a[1] + 0.56 * b[1] + 0.22 * c[1]];
    }
    p = out;
  }
  return p;
}

function polishOpen(pts, passes) {
  // 1 densification + lissage court — 2× Chaikin créait des filaments
  let p = chaikinOpenOnce(pts);
  return smoothOpenFixedEnds(p, passes);
}

function polishClosed(pts, passes) {
  let p = pts.map((q) => [q[0], q[1]]);
  // densify closed once
  {
    const n = p.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[(i + 1) % n];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
      out.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    p = out;
  }
  return smoothClosed(p, passes);
}

/** Lissage d’un anneau isolé (pas de topo partagée → pas de barres fantômes). */
function polishRingIndependent(ring, passes = 14) {
  const open = openRing(ring);
  if (open.length < 4) return closeRing(ring);
  return closeRing(polishClosed(open, passes));
}

/** Force les sommets proches à des coordonnées identiques (jonctions propres). */
function weldVertices(domains, decimals = 5) {
  const f = 10 ** decimals;
  const keyOf = (x, y) => `${Math.round(x * f)},${Math.round(y * f)}`;
  const canon = new Map();
  for (const d of domains) {
    for (const ring of d.rings) {
      for (const [x, y] of openRing(ring)) {
        const k = keyOf(x, y);
        if (!canon.has(k)) canon.set(k, [Math.round(x * f) / f, Math.round(y * f) / f]);
      }
    }
  }
  for (const d of domains) {
    d.rings = d.rings.map((ring) =>
      closeRing(openRing(ring).map(([x, y]) => canon.get(keyOf(x, y)))),
    );
  }
}

/**
 * Lissage laplacien partagé : déplace chaque sommet de degré 2
 * une seule fois pour toutes les tuiles → pas de trous.
 * Les jonctions (degré ≠ 2) et sommets côtiers restent fixes.
 */
function laplacianShared(domains, iterations = 12, lambda = 0.55, pinned = null) {
  for (let it = 0; it < iterations; it++) {
    const adj = new Map();
    const addAdj = (a, b) => {
      if (a === b) return;
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b);
      adj.get(b).add(a);
    };
    for (const d of domains) {
      for (const ring of d.rings) {
        const keys = openRing(ring).map(pk);
        for (let i = 0; i < keys.length; i++) addAdj(keys[i], keys[(i + 1) % keys.length]);
      }
    }
    const next = new Map();
    for (const [k, nbs] of adj) {
      if (nbs.size !== 2 || (pinned && pinned.has(k))) {
        next.set(k, parsePk(k));
        continue;
      }
      const arr = [...nbs];
      const [x0, y0] = parsePk(k);
      const [x1, y1] = parsePk(arr[0]);
      const [x2, y2] = parsePk(arr[1]);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      next.set(k, [x0 * (1 - lambda) + mx * lambda, y0 * (1 - lambda) + my * lambda]);
    }
    for (const d of domains) {
      for (let ri = 0; ri < d.rings.length; ri++) {
        const keys = openRing(d.rings[ri]).map(pk);
        if (keys.length < 3) continue;
        const pts = [];
        for (const k of keys) {
          const p = next.get(k) || parsePk(k);
          const last = pts[pts.length - 1];
          if (last && Math.abs(last[0] - p[0]) < 1e-10 && Math.abs(last[1] - p[1]) < 1e-10) continue;
          pts.push(p);
        }
        if (pts.length >= 3) d.rings[ri] = closeRing(pts);
      }
    }
  }
}

/**
 * Lisse les frontières sans trous : densify léger + lissage fort + laplacien.
 * Les jonctions (degré ≠ 2) restent fixes.
 */
function smoothSharedBoundaries(domains, passes = 28) {
  const adj = new Map();
  const addAdj = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };

  const ringKeysList = []; // {di, ri, keys}
  for (let di = 0; di < domains.length; di++) {
    const d = domains[di];
    for (let ri = 0; ri < d.rings.length; ri++) {
      const keys = openRing(d.rings[ri]).map(pk);
      if (keys.length < 3) continue;
      ringKeysList.push({ di, ri, keys });
      for (let i = 0; i < keys.length; i++) {
        addAdj(keys[i], keys[(i + 1) % keys.length]);
      }
    }
  }
  if (!adj.size) return;

  const degree = (k) => adj.get(k)?.size ?? 0;
  const isJunction = (k) => degree(k) !== 2;

  const segKey = (a, b) => (a < b ? `${a}\t${b}` : `${b}\t${a}`);
  const visited = new Set();
  /** @type {Map<string, [number, number][]>} */
  const chainFwd = new Map(); // "a→b" -> smoothed points including ends

  const storeChain = (keyPath, closed) => {
    const pts = keyPath.map(parsePk);
    const smooth = closed ? polishClosed(pts, passes) : polishOpen(pts, passes);
    const a = keyPath[0];
    const b = keyPath[keyPath.length - 1];
    chainFwd.set(`${a}→${b}`, smooth);
    if (!closed && a !== b) {
      chainFwd.set(`${b}→${a}`, [...smooth].reverse());
    }
    if (closed) {
      chainFwd.set(`${a}→${a}`, smooth);
    }
  };

  // Chaînes entre jonctions
  for (const [start, nbs] of adj) {
    if (!isJunction(start)) continue;
    for (const first of nbs) {
      const sk0 = segKey(start, first);
      if (visited.has(sk0)) continue;
      const path = [start];
      let prev = start;
      let cur = first;
      visited.add(sk0);
      path.push(cur);
      while (!isJunction(cur)) {
        const nexts = [...adj.get(cur)].filter((x) => x !== prev);
        if (!nexts.length) break;
        const next = nexts[0];
        visited.add(segKey(cur, next));
        path.push(next);
        prev = cur;
        cur = next;
      }
      if (path.length >= 2) storeChain(path, false);
    }
  }

  // Boucles sans jonction
  for (const [start, nbs] of adj) {
    for (const first of nbs) {
      const sk0 = segKey(start, first);
      if (visited.has(sk0)) continue;
      const path = [start];
      let prev = start;
      let cur = first;
      visited.add(sk0);
      for (;;) {
        const nexts = [...adj.get(cur)].filter((x) => x !== prev);
        if (!nexts.length) break;
        const next = nexts[0];
        const sk = segKey(cur, next);
        if (next === start) {
          visited.add(sk);
          break;
        }
        if (visited.has(sk)) break;
        visited.add(sk);
        path.push(next);
        prev = cur;
        cur = next;
        if (path.length > adj.size + 2) break;
      }
      if (path.length >= 3) storeChain(path, true);
    }
  }

  // Reconstruire chaque anneau
  for (const { di, ri, keys } of ringKeysList) {
    const n = keys.length;
    const junctIdx = [];
    for (let i = 0; i < n; i++) {
      if (isJunction(keys[i])) junctIdx.push(i);
    }

    let out = [];
    if (junctIdx.length === 0) {
      // Boucle entière
      const smooth = chainFwd.get(`${keys[0]}→${keys[0]}`);
      out = smooth ? smooth.map((p) => [p[0], p[1]]) : keys.map(parsePk);
    } else {
      for (let j = 0; j < junctIdx.length; j++) {
        const i0 = junctIdx[j];
        const i1 = junctIdx[(j + 1) % junctIdx.length];
        const a = keys[i0];
        const b = keys[i1];
        let smooth = chainFwd.get(`${a}→${b}`);
        if (!smooth) {
          // Fallback : points bruts le long de l’anneau
          const raw = [];
          let i = i0;
          for (;;) {
            raw.push(parsePk(keys[i]));
            if (i === i1 && raw.length > 1) break;
            i = (i + 1) % n;
            if (raw.length > n + 2) break;
          }
          smooth = raw;
        }
        if (j === 0) out.push(...smooth.map((p) => [p[0], p[1]]));
        else out.push(...smooth.slice(1).map((p) => [p[0], p[1]]));
      }
    }
    if (out.length >= 3) domains[di].rings[ri] = closeRing(out);
  }

  // 2ᵉ passe : laplacien partagé léger (trop fort → spikes / auto-intersections)
  laplacianShared(domains, 6, 0.35);
}

export function buildImpassable(elevAt, landMask, bbox, onLand) {
  const step = 0.025; // plus fin → contours de massifs plus naturels
  const cols = Math.ceil((bbox.lonMax - bbox.lonMin) / step) + 1;
  const rows = Math.ceil((bbox.latMax - bbox.latMin) / step) + 1;
  const owner = new Int16Array(cols * rows);
  let n = 0;
  for (let y = 0; y < rows; y++) {
    const lat = bbox.latMax - y * step;
    for (let x = 0; x < cols; x++) {
      const lon = bbox.lonMin + x * step;
      if (!onLand(lon, lat)) continue;
      const e = elevAt(lon, lat);
      if (e < IMPASSABLE_M) continue;
      if (e < HARD_IMPASSABLE_M) {
        const relief = Math.max(
          Math.abs(e - elevAt(lon + step, lat)),
          Math.abs(e - elevAt(lon, lat - step)),
        );
        if (relief < 180 && e < 1700) continue;
      }
      owner[y * cols + x] = 1;
      n++;
    }
  }
  if (!n) return { feature: null, rings: [] };

  // Opening morphologique léger : retire le bruit 1 cellule
  {
    const next = Int16Array.from(owner);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        if (!owner[i]) continue;
        let same = 0;
        if (owner[i - 1]) same++;
        if (owner[i + 1]) same++;
        if (owner[i - cols]) same++;
        if (owner[i + cols]) same++;
        if (same < 2) next[i] = 0;
      }
    }
    owner.set(next);
  }

  const rings = polygonizeLabel(owner, cols, rows, 1, bbox.lonMin, bbox.latMax, step).filter((r) => {
    if (r.length < 4) return false;
    try {
      return turf.area(turf.polygon([r])) > 1.2e8; // ≥ ~120 km²
    } catch {
      return false;
    }
  });
  if (!rings.length) return { feature: null, rings: [] };

  let feature =
    rings.length === 1 ? turf.polygon([rings[0]]) : turf.multiPolygon(rings.map((r) => [r]));
  try {
    const clipped = turf.intersect(turf.featureCollection([feature, landMask]));
    if (clipped) feature = clipped;
  } catch {
    /* keep */
  }

  const outRings =
    feature.geometry.type === "Polygon"
      ? [closeRing(feature.geometry.coordinates[0])]
      : feature.geometry.coordinates.map((p) => closeRing(p[0]));

  return { feature, rings: outRings };
}


/**
 * 1) DOMAINES d’abord — tuiles terrain uniquement (mer + montagnes = barrières).
 *    Taille ~uniforme ; près des massifs → graines plus espacées → domaines plus grands.
 *    Duchés / royaumes viennent après (generate-ck-map).
 */
export function partitionWorldDomains({
  bbox,
  elevAt,
  riverLines,
  impassableFeat,
  cellSizeKm,
  onLand,
  rng,
  minCells = 8,
  /** Points historiques (DARE civitates / villes) — style pagi autour des cités */
  historicSeeds = [],
}) {
  const step = GRID_STEP_DEG;
  const west = bbox.lonMin;
  const north = bbox.latMax;
  const cols = Math.ceil((bbox.lonMax - bbox.lonMin) / step) + 1;
  const rows = Math.ceil((bbox.latMax - bbox.latMin) / step) + 1;
  const N = cols * rows;

  // 0 = mer, 1 = terre praticable, 2 = montagne
  const mask = new Uint8Array(N);
  const elev = new Float32Array(N);
  const river = new Uint8Array(N);

  console.log(`  grille ${cols}×${rows} (${N} cellules) — domaines terrain seuls...`);

  for (let y = 0; y < rows; y++) {
    const lat = north - y * step;
    for (let x = 0; x < cols; x++) {
      const lon = west + x * step;
      const i = y * cols + x;
      elev[i] = elevAt(lon, lat);
      if (!onLand(lon, lat)) continue;
      if (elev[i] >= HARD_IMPASSABLE_M || elev[i] >= IMPASSABLE_M) {
        mask[i] = 2;
        continue;
      }
      if (impassableFeat) {
        try {
          if (turf.booleanPointInPolygon(turf.point([lon, lat]), impassableFeat)) {
            mask[i] = 2;
            continue;
          }
        } catch {
          /* fallthrough */
        }
      }
      mask[i] = 1;
    }
  }

  for (const line of riverLines) {
    for (const [lon, lat] of line) {
      const x = Math.round((lon - west) / step);
      const y = Math.round((north - lat) / step);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
          const i = yy * cols + xx;
          if (mask[i] === 1) river[i] = 1;
        }
      }
    }
  }

  // Micro-pics → terre
  {
    const seen = new Uint8Array(N);
    const stack = [];
    let purged = 0;
    const MIN_RIDGE = 18;
    for (let i = 0; i < N; i++) {
      if (mask[i] !== 2 || seen[i]) continue;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      const comp = [];
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        const x = c % cols;
        const y = (c / cols) | 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (seen[ni] || mask[ni] !== 2) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      if (comp.length >= MIN_RIDGE) continue;
      for (const c of comp) mask[c] = 1;
      purged += comp.length;
    }
    console.log(`  ${purged} cellules de micro-pics → terre`);
  }

  // Bassins séparés par montagnes/mer
  const basinOf = new Int32Array(N).fill(-1);
  const basinSize = [];
  {
    const stack = [];
    for (let i = 0; i < N; i++) {
      if (mask[i] !== 1 || basinOf[i] >= 0) continue;
      const id = basinSize.length;
      let sz = 0;
      stack.length = 0;
      stack.push(i);
      basinOf[i] = id;
      while (stack.length) {
        const c = stack.pop();
        sz++;
        const x = c % cols;
        const y = (c / cols) | 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (basinOf[ni] >= 0 || mask[ni] !== 1) continue;
          basinOf[ni] = id;
          stack.push(ni);
        }
      }
      basinSize.push(sz);
    }
    console.log(`  ${basinSize.length} bassins (montagne/mer)`);
  }

  // Graines : d’abord cités historiques (DARE), puis combler comme des pagi
  const seeds = [];
  const seedTaken = new Uint8Array(N);
  const minSepCells = Math.max(3, Math.round(cellSizeKm / (step * 111.32) * 0.55));

  /** Part de cellules montagne dans un rayon (0–1) — domaines plus grands près des massifs. */
  function mountainProx(i, radius = 4) {
    const x = i % cols;
    const y = (i / cols) | 0;
    let n = 0;
    let tot = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        tot++;
        if (mask[ny * cols + nx] === 2) n++;
      }
    }
    return tot ? n / tot : 0;
  }

  /** Séparation² locale : jusqu’à ~2.2× près des montagnes / hautes altitudes. */
  function sep2At(i) {
    const mp = mountainProx(i);
    const eBoost = Math.min(1, Math.max(0, (elev[i] - 350) / 1300));
    const scale = 1 + 1.1 * mp + 0.45 * eBoost;
    const sep = minSepCells * scale;
    return sep * sep;
  }

  function tooClose(i) {
    const x = i % cols;
    const y = (i / cols) | 0;
    const need = sep2At(i);
    for (const s of seeds) {
      const sx = s.i % cols;
      const sy = (s.i / cols) | 0;
      const d2 = (sx - x) ** 2 + (sy - y) ** 2;
      // Respecte aussi l’espace exigé par la graine déjà posée
      if (d2 < Math.max(need, sep2At(s.i))) return true;
    }
    return false;
  }

  function snapLand(lon, lat) {
    let x = Math.round((lon - west) / step);
    let y = Math.round((north - lat) / step);
    if (x < 0 || y < 0 || x >= cols || y >= rows) return -1;
    let i = y * cols + x;
    if (mask[i] === 1) return i;
    // cherche cellule praticable autour
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
          const ni = yy * cols + xx;
          if (mask[ni] === 1) return ni;
        }
      }
    }
    return -1;
  }

  const historic = [...historicSeeds].sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  let histUsed = 0;
  for (const h of historic) {
    const i = snapLand(h.lon, h.lat);
    if (i < 0 || seedTaken[i] || tooClose(i)) continue;
    seedTaken[i] = 1;
    seeds.push({
      i,
      capital: (h.rank ?? 9) <= 1, // cité / chef-lieu ≈ « capitale » de domaine
      name: h.name || null,
      historic: true,
    });
    histUsed++;
  }
  console.log(`  ${histUsed} graines historiques (DARE civitates / villes)`);

  const cellAreaKm2 =
    step * 111.32 * (step * 111.32 * Math.cos((((bbox.latMin + bbox.latMax) / 2) * Math.PI) / 180));
  for (let b = 0; b < basinSize.length; b++) {
    const sz = basinSize[b];
    if (sz < 1) continue; // même les îlots / micro-bassins
    const cells = [];
    for (let i = 0; i < N; i++) if (basinOf[i] === b) cells.push(i);
    let elevSum = 0;
    let mpSum = 0;
    for (const c of cells) {
      elevSum += elev[c];
      mpSum += mountainProx(c, 3);
    }
    const avgE = elevSum / cells.length;
    const avgMp = mpSum / cells.length;
    // Moins de graines en piémont / haute vallée → domaines plus grands près des massifs
    const highlandBias = 1 + Math.min(1.35, avgE / 850) + Math.min(0.9, avgMp * 2.2);
    const target = Math.max(
      1,
      Math.round((sz * cellAreaKm2) / (cellSizeKm * cellSizeKm) / highlandBias),
    );
    const already = seeds.filter((s) => basinOf[s.i] === b).map((s) => s.i);
    const picked = already.length ? already.slice() : [];
    if (!picked.length) {
      // bassin sans cité : 1 graine vallée
      let best = cells[0];
      let bestE = elev[best];
      for (let t = 0; t < Math.min(40, cells.length); t++) {
        const cand = cells[Math.floor(rng() * cells.length)];
        if (elev[cand] < bestE) {
          bestE = elev[cand];
          best = cand;
        }
      }
      picked.push(best);
    }
    while (picked.length < target && picked.length < cells.length) {
      let best = null;
      let bestD = -1;
      for (let t = 0; t < Math.min(70, cells.length); t++) {
        const cand = cells[Math.floor(rng() * cells.length)];
        if (seedTaken[cand]) continue;
        const need = sep2At(cand);
        let minD = Infinity;
        for (const p of picked) {
          const dx = (cand % cols) - (p % cols);
          const dy = ((cand / cols) | 0) - ((p / cols) | 0);
          minD = Math.min(minD, dx * dx + dy * dy);
        }
        if (minD < need) continue;
        // Préfère les vallées pour les graines ; laisse les piémonts moins densément peuplés
        const adj = minD / (1 + elev[cand] / 600 + mountainProx(cand) * 2);
        if (adj > bestD) {
          bestD = adj;
          best = cand;
        }
      }
      if (best == null) break;
      picked.push(best);
    }
    for (const i of picked) {
      if (seedTaken[i]) continue;
      seedTaken[i] = 1;
      seeds.push({ i, capital: river[i] && rng() < 0.25, name: null, historic: false });
    }
  }
  if (!seeds.length) {
    for (let i = 0; i < N; i++) {
      if (mask[i] === 1) {
        seeds.push({ i, capital: false, name: null, historic: false });
        break;
      }
    }
  }
  console.log(`  ${seeds.length} graines de domaines (historique + comblement)`);

  const owner = new Int32Array(N).fill(-1);
  const dist = new Float32Array(N).fill(Infinity);
  const heap = new MinHeap();
  for (let s = 0; s < seeds.length; s++) {
    dist[seeds[s].i] = 0;
    owner[seeds[s].i] = s;
    heap.push({ i: seeds[s].i, c: 0, s });
  }
  const neigh = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
  ];
  while (heap.size) {
    const { i, c, s } = heap.pop();
    if (c > dist[i] || owner[i] !== s) continue;
    const capital = seeds[s].capital;
    const x = i % cols;
    const y = (i / cols) | 0;
    const e0 = elev[i];
    for (const [dx, dy, diag] of neigh) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (mask[ni] !== 1) continue; // mer / montagne = mur
      const e1 = elev[ni];
      const slope = Math.abs(e1 - e0) / (diag * step * 111000);
      // Coût plus doux en altitude : les domaines peuvent envelopper les massifs sans se fragmenter
      let cost = diag * (1 + e1 / 1700 + slope * 7);
      if (river[ni] && !river[i]) cost *= capital ? 1.15 : 2.2;
      else if (river[ni]) cost *= capital ? 0.95 : 1.25;
      if (e1 < 250) cost *= 0.88;
      const nc = c + cost;
      if (nc < dist[ni]) {
        dist[ni] = nc;
        owner[ni] = s;
        heap.push({ i: ni, c: nc, s });
      }
    }
  }

  for (let i = 0; i < N; i++) {
    if (mask[i] !== 1 || owner[i] >= 0) continue;
    const x = i % cols, y = (i / cols) | 0;
    let best = -1, bestD = Infinity;
    for (let s = 0; s < seeds.length; s++) {
      const sx = seeds[s].i % cols;
      const sy = (seeds[s].i / cols) | 0;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best >= 0) owner[i] = best;
  }

  // Fusion petits domaines
  const counts = new Int32Array(seeds.length);
  for (let i = 0; i < N; i++) if (owner[i] >= 0) counts[owner[i]]++;
  const remap = new Int32Array(seeds.length);
  for (let s = 0; s < seeds.length; s++) remap[s] = s;
  for (let s = 0; s < seeds.length; s++) {
    if (counts[s] >= minCells) continue;
    const vote = new Map();
    for (let i = 0; i < N; i++) {
      if (owner[i] !== s) continue;
      const x = i % cols, y = (i / cols) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const o = owner[ny * cols + nx];
        if (o >= 0 && o !== s) vote.set(o, (vote.get(o) || 0) + 1);
      }
    }
    let best = -1, bestN = 0;
    for (const [o, n] of vote) if (n > bestN) { bestN = n; best = o; }
    // Îlot isolé (pas de voisin terrestre) : on garde, même tout petit
    if (best >= 0) remap[s] = best;
  }
  for (let s = 0; s < seeds.length; s++) {
    let t = s;
    const seen = new Set();
    while (remap[t] !== t && !seen.has(t)) { seen.add(t); t = remap[t]; }
    remap[s] = t;
  }
  for (let i = 0; i < N; i++) if (owner[i] >= 0) owner[i] = remap[owner[i]];

  // Égalisation : absorber les trop petits, rogner les trop gros vers voisins sous-médiane
  {
    function recount() {
      counts.fill(0);
      for (let i = 0; i < N; i++) if (owner[i] >= 0) counts[owner[i]]++;
    }
    function neighborVote(s) {
      const vote = new Map();
      for (let i = 0; i < N; i++) {
        if (owner[i] !== s) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const o = owner[ny * cols + nx];
          if (o >= 0 && o !== s) vote.set(o, (vote.get(o) || 0) + 1);
        }
      }
      let best = -1;
      let bestN = 0;
      for (const [o, n] of vote) {
        if (n > bestN) {
          bestN = n;
          best = o;
        }
      }
      return best;
    }
    for (let pass = 0; pass < 12; pass++) {
      recount();
      const liveSizes = [];
      for (let s = 0; s < seeds.length; s++) if (counts[s] > 0) liveSizes.push(counts[s]);
      if (!liveSizes.length) break;
      liveSizes.sort((a, b) => a - b);
      const median = liveSizes[(liveSizes.length / 2) | 0];
      const floor = Math.max(minCells, Math.floor(median * 0.62));
      const ceil = Math.ceil(median * 1.55);
      let changed = 0;
      // Merge undersized
      for (let s = 0; s < seeds.length; s++) {
        if (counts[s] <= 0 || counts[s] >= floor) continue;
        const best = neighborVote(s);
        if (best < 0) continue;
        for (let i = 0; i < N; i++) if (owner[i] === s) owner[i] = best;
        counts[best] += counts[s];
        counts[s] = 0;
        changed++;
      }
      // Peel border cells from oversized → undersized / below-median neighbors
      recount();
      for (let i = 0; i < N; i++) {
        const s = owner[i];
        if (s < 0 || counts[s] <= ceil) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        let best = -1;
        let bestNeed = -1;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const o = owner[ny * cols + nx];
          if (o < 0 || o === s) continue;
          if (counts[o] >= median) continue;
          const need = median - counts[o];
          if (need > bestNeed) {
            bestNeed = need;
            best = o;
          }
        }
        if (best < 0) continue;
        owner[i] = best;
        counts[s]--;
        counts[best]++;
        changed++;
      }
      if (!changed) break;
    }
    recount();
    const finals = [];
    for (let s = 0; s < seeds.length; s++) if (counts[s] > 0) finals.push(counts[s]);
    finals.sort((a, b) => a - b);
    const med = finals[(finals.length / 2) | 0] || 0;
    const mn = finals[0] || 0;
    const mx = finals[finals.length - 1] || 0;
    console.log(
      `  tailles domaines (cellules): ${mn}–${mx}, médiane ${med}, n=${finals.length}`,
    );
  }

  const used = [...new Set(owner.filter((v) => v >= 0))].sort((a, b) => a - b);
  const idOf = new Map(used.map((s, idx) => [s, idx]));
  const owner2 = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) if (owner[i] >= 0) owner2[i] = idOf.get(owner[i]);

  // Montagnes stratégiques : barrière seulement si gros massif séparant ≥2 domaines.
  // Petits pics / crêtes inutiles → fondus dans le territoire voisin.
  {
    const seen = new Uint8Array(N);
    const stack = [];
    let kept = 0, removed = 0;
    const MIN_BARRIER_CELLS = 120; // petites crêtes → fondues dans le territoire
    for (let i = 0; i < N; i++) {
      if (mask[i] !== 2 || seen[i]) continue;
      stack.length = 0; stack.push(i); seen[i] = 1;
      const comp = [];
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        const x = c % cols, y = (c / cols) | 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (seen[ni] || mask[ni] !== 2) continue;
          seen[ni] = 1; stack.push(ni);
        }
      }
      const touch = new Set();
      const vote = new Map();
      for (const c of comp) {
        const x = c % cols, y = (c / cols) | 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const o = owner2[ny * cols + nx];
          if (o < 0) continue;
          touch.add(o);
          vote.set(o, (vote.get(o) || 0) + 1);
        }
      }
      const isBarrier =
        touch.size >= 3 || (touch.size >= 2 && comp.length >= MIN_BARRIER_CELLS);
      if (isBarrier) {
        kept++;
        continue;
      }
      let best = -1, bestN = 0;
      for (const [o, n] of vote) if (n > bestN) { bestN = n; best = o; }
      if (best < 0) { for (const c of comp) mask[c] = 0; removed++; continue; }
      for (const c of comp) { mask[c] = 1; owner2[c] = best; }
      removed++;
    }
    console.log(`  montagnes: ${kept} barrières, ${removed} absorbées dans le territoire`);
  }

  // Dilatation côtière prudente : seulement si ≥2 voisins déjà peints (évite peignes 1 cellule)
  {
    const next = Int32Array.from(owner2);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (mask[i] !== 1 || owner2[i] >= 0) continue;
        const vote = new Map();
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const o = owner2[ny * cols + nx];
          if (o >= 0) vote.set(o, (vote.get(o) || 0) + 1);
        }
        let best = -1;
        let bestN = 0;
        for (const [o, n] of vote) {
          if (n > bestN) {
            bestN = n;
            best = o;
          }
        }
        if (best >= 0 && bestN >= 2) next[i] = best;
      }
    }
    owner2.set(next);
  }

  // Compactage : coupe les bras fins / lames d’1 cellule (évite les spikes polygonisés)
  {
    const ortho = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    let pruned = 0;
    for (let pass = 0; pass < 10; pass++) {
      const next = Int32Array.from(owner2);
      let changed = 0;
      for (let i = 0; i < N; i++) {
        const s = owner2[i];
        if (s < 0) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        let same = 0;
        const foreign = new Map();
        for (const [dx, dy] of ortho) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const o = owner2[ny * cols + nx];
          if (o === s) same++;
          else if (o >= 0) foreign.set(o, (foreign.get(o) || 0) + 1);
        }
        const left = x > 0 && owner2[i - 1] === s;
        const right = x < cols - 1 && owner2[i + 1] === s;
        const up = y > 0 && owner2[i - cols] === s;
        const down = y < rows - 1 && owner2[i + cols] === s;
        const thinCorridor =
          same === 2 && ((left && right && !up && !down) || (up && down && !left && !right));
        // Extrémité / filament : ≤1 voisin même propriétaire, ou corridor d’1 cellule
        if (same > 1 && !thinCorridor) continue;
        if (!foreign.size) {
          // Corridor vers le vide : laisser tel quel (ne pas percer la terre → mer)
          continue;
        }
        let best = -1;
        let bestN = 0;
        for (const [o, n] of foreign) {
          if (n > bestN) {
            bestN = n;
            best = o;
          }
        }
        if (best < 0) continue;
        next[i] = best;
        changed++;
      }
      owner2.set(next);
      pruned += changed;
      if (!changed) break;
    }
    if (pruned) console.log(`  compactage domaines: ${pruned} cellules filament/corridor → voisin`);
  }

  // Coupe les « lamelles » : runs horizontaux/verticaux d’1 cellule d’épaisseur
  {
    let peeled = 0;
    function majorityAround(x, y, s) {
      const vote = new Map();
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const o = owner2[ny * cols + nx];
        if (o >= 0 && o !== s) vote.set(o, (vote.get(o) || 0) + 1);
      }
      let best = -1;
      let bestN = 0;
      for (const [o, n] of vote) {
        if (n > bestN) {
          bestN = n;
          best = o;
        }
      }
      return best;
    }
    for (let pass = 0; pass < 6; pass++) {
      let changed = 0;
      // Horizontal 1-row fingers
      for (let y = 0; y < rows; y++) {
        let x = 0;
        while (x < cols) {
          const s = owner2[y * cols + x];
          if (s < 0) {
            x++;
            continue;
          }
          let x1 = x;
          while (x1 < cols && owner2[y * cols + x1] === s) x1++;
          const len = x1 - x;
          if (len >= 2) {
            let thin = true;
            for (let xx = x; xx < x1; xx++) {
              const up = y > 0 && owner2[(y - 1) * cols + xx] === s;
              const down = y < rows - 1 && owner2[(y + 1) * cols + xx] === s;
              if (up || down) {
                thin = false;
                break;
              }
            }
            if (thin) {
              for (let xx = x; xx < x1; xx++) {
                const best = majorityAround(xx, y, s);
                if (best >= 0) {
                  owner2[y * cols + xx] = best;
                  changed++;
                }
              }
            }
          }
          x = x1;
        }
      }
      // Vertical 1-col fingers
      for (let x = 0; x < cols; x++) {
        let y = 0;
        while (y < rows) {
          const s = owner2[y * cols + x];
          if (s < 0) {
            y++;
            continue;
          }
          let y1 = y;
          while (y1 < rows && owner2[y1 * cols + x] === s) y1++;
          const len = y1 - y;
          if (len >= 2) {
            let thin = true;
            for (let yy = y; yy < y1; yy++) {
              const left = x > 0 && owner2[yy * cols + x - 1] === s;
              const right = x < cols - 1 && owner2[yy * cols + x + 1] === s;
              if (left || right) {
                thin = false;
                break;
              }
            }
            if (thin) {
              for (let yy = y; yy < y1; yy++) {
                const best = majorityAround(x, yy, s);
                if (best >= 0) {
                  owner2[yy * cols + x] = best;
                  changed++;
                }
              }
            }
          }
          y = y1;
        }
      }
      peeled += changed;
      if (!changed) break;
    }
    if (peeled) console.log(`  lamelles 1×N coupées: ${peeled} cellules`);
  }

  // Opening morphologique : retire les crêtes d’1–2 cellules (marches / doigts)
  {
    let opened = 0;
    for (let pass = 0; pass < 3; pass++) {
      const next = Int32Array.from(owner2);
      let changed = 0;
      for (let i = 0; i < N; i++) {
        const s = owner2[i];
        if (s < 0) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        let same = 0;
        const foreign = new Map();
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const o = owner2[ny * cols + nx];
          if (o === s) same++;
          else if (o >= 0) foreign.set(o, (foreign.get(o) || 0) + 1);
        }
        // Moins de 2 voisins ortho identiques → bout de filament seulement
        if (same >= 2) continue;
        if (!foreign.size) continue;
        let best = -1;
        let bestN = 0;
        for (const [o, n] of foreign) {
          if (n > bestN) {
            bestN = n;
            best = o;
          }
        }
        if (best < 0) continue;
        next[i] = best;
        changed++;
      }
      owner2.set(next);
      opened += changed;
      if (!changed) break;
    }
    if (opened) console.log(`  opening morphologique: ${opened} cellules`);
  }

  // Absorbe les domaines trop plats (lamelles 2–3 cellules d’épaisseur / aspect extrême)
  {
    const nOwners = used.length;
    let mergedFlat = 0;
    for (let pass = 0; pass < 5; pass++) {
      const minX = new Int32Array(nOwners).fill(1e9);
      const maxX = new Int32Array(nOwners).fill(-1);
      const minY = new Int32Array(nOwners).fill(1e9);
      const maxY = new Int32Array(nOwners).fill(-1);
      const counts = new Int32Array(nOwners);
      for (let i = 0; i < N; i++) {
        const s = owner2[i];
        if (s < 0) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        counts[s]++;
        if (x < minX[s]) minX[s] = x;
        if (x > maxX[s]) maxX[s] = x;
        if (y < minY[s]) minY[s] = y;
        if (y > maxY[s]) maxY[s] = y;
      }
      const remap = new Int32Array(nOwners);
      for (let s = 0; s < nOwners; s++) remap[s] = s;
      let passMerge = 0;
      for (let s = 0; s < nOwners; s++) {
        if (counts[s] < 1) continue;
        const w = maxX[s] - minX[s] + 1;
        const h = maxY[s] - minY[s] + 1;
        const asp = Math.max(w / h, h / w);
        const flat =
          (h <= 3 && w >= 4) ||
          (w <= 3 && h >= 4) ||
          asp >= 3.8 ||
          counts[s] < minCells;
        if (!flat) continue;
        const vote = new Map();
        for (let i = 0; i < N; i++) {
          if (owner2[i] !== s) continue;
          const x = i % cols;
          const y = (i / cols) | 0;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const o = owner2[ny * cols + nx];
            if (o >= 0 && o !== s && remap[o] === o) vote.set(o, (vote.get(o) || 0) + 1);
          }
        }
        let best = -1;
        let bestN = 0;
        for (const [o, n] of vote) {
          if (n > bestN) {
            bestN = n;
            best = o;
          }
        }
        if (best < 0) continue;
        remap[s] = best;
        passMerge++;
      }
      if (!passMerge) break;
      for (let s = 0; s < nOwners; s++) {
        let t = s;
        const seen = new Set();
        while (remap[t] !== t && !seen.has(t)) {
          seen.add(t);
          t = remap[t];
        }
        remap[s] = t;
      }
      for (let i = 0; i < N; i++) if (owner2[i] >= 0) owner2[i] = remap[owner2[i]];
      mergedFlat += passMerge;
    }
    if (mergedFlat) console.log(`  domaines plats fusionnés: ${mergedFlat}`);
  }

  // Bandeaux horizontaux de 2 rangées → voisins
  {
    let bands = 0;
    for (let pass = 0; pass < 3; pass++) {
      let changed = 0;
      for (let y = 0; y < rows - 1; y++) {
        let x = 0;
        while (x < cols) {
          const s = owner2[y * cols + x];
          if (s < 0 || owner2[(y + 1) * cols + x] !== s) {
            x++;
            continue;
          }
          let x1 = x;
          while (
            x1 < cols &&
            owner2[y * cols + x1] === s &&
            owner2[(y + 1) * cols + x1] === s
          )
            x1++;
          const len = x1 - x;
          if (len >= 4) {
            let onlyTwo = true;
            for (let xx = x; xx < x1; xx++) {
              const up = y > 0 && owner2[(y - 1) * cols + xx] === s;
              const down = y + 2 < rows && owner2[(y + 2) * cols + xx] === s;
              if (up || down) {
                onlyTwo = false;
                break;
              }
            }
            if (onlyTwo) {
              for (let xx = x; xx < x1; xx++) {
                const vote = new Map();
                for (const yy of [y, y + 1]) {
                  for (const [dx, dy] of [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1],
                  ]) {
                    const nx = xx + dx;
                    const ny = yy + dy;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                    const o = owner2[ny * cols + nx];
                    if (o >= 0 && o !== s) vote.set(o, (vote.get(o) || 0) + 1);
                  }
                }
                let best = -1;
                let bestN = 0;
                for (const [o, n] of vote) {
                  if (n > bestN) {
                    bestN = n;
                    best = o;
                  }
                }
                if (best >= 0) {
                  owner2[y * cols + xx] = best;
                  owner2[(y + 1) * cols + xx] = best;
                  changed += 2;
                }
              }
            }
          }
          x = Math.max(x1, x + 1);
        }
      }
      bands += changed;
      if (!changed) break;
    }
    if (bands) console.log(`  bandeaux 2×N absorbés: ${bands} cellules`);
  }

  // Seconde passe anti-lamelles après fusions (peut recréer des doigts)
  {
    let peeled2 = 0;
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      for (let y = 0; y < rows; y++) {
        let x = 0;
        while (x < cols) {
          const s = owner2[y * cols + x];
          if (s < 0) {
            x++;
            continue;
          }
          let x1 = x;
          while (x1 < cols && owner2[y * cols + x1] === s) x1++;
          if (x1 - x >= 2) {
            let thin = true;
            for (let xx = x; xx < x1; xx++) {
              const up = y > 0 && owner2[(y - 1) * cols + xx] === s;
              const down = y < rows - 1 && owner2[(y + 1) * cols + xx] === s;
              if (up || down) {
                thin = false;
                break;
              }
            }
            if (thin) {
              for (let xx = x; xx < x1; xx++) {
                const vote = new Map();
                for (const [dx, dy] of [
                  [1, 0],
                  [-1, 0],
                  [0, 1],
                  [0, -1],
                  [1, 1],
                  [1, -1],
                  [-1, 1],
                  [-1, -1],
                ]) {
                  const nx = xx + dx;
                  const ny = y + dy;
                  if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                  const o = owner2[ny * cols + nx];
                  if (o >= 0 && o !== s) vote.set(o, (vote.get(o) || 0) + 1);
                }
                let best = -1;
                let bestN = 0;
                for (const [o, n] of vote) {
                  if (n > bestN) {
                    bestN = n;
                    best = o;
                  }
                }
                const i = y * cols + xx;
                if (best >= 0) {
                  owner2[i] = best;
                  changed++;
                }
              }
            }
          }
          x = x1;
        }
      }
      peeled2 += changed;
      if (!changed) break;
    }
    if (peeled2) console.log(`  re-passe lamelles: ${peeled2} cellules`);
  }

  // Remplit toute terre non assignée (évite franges beige / trous côtiers)
  {
    const dist = new Int32Array(N).fill(-1);
    const q = [];
    for (let i = 0; i < N; i++) {
      if (mask[i] !== 1) continue;
      if (owner2[i] >= 0) {
        dist[i] = 0;
        q.push(i);
      }
    }
    let qi = 0;
    while (qi < q.length) {
      const i = q[qi++];
      const x = i % cols;
      const y = (i / cols) | 0;
      const s = owner2[i];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (mask[ni] !== 1 || owner2[ni] >= 0) continue;
        owner2[ni] = s;
        dist[ni] = dist[i] + 1;
        q.push(ni);
      }
    }
    let nFill = 0;
    for (let i = 0; i < N; i++) if (dist[i] > 0) nFill++;
    if (nFill) console.log(`  terre non assignée rattachée: ${nFill} cellules`);
  }

  const neighborSets = new Map();
  const ens = (a) => { if (!neighborSets.has(a)) neighborSets.set(a, new Set()); return neighborSets.get(a); };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const a = owner2[i];
      if (a < 0) continue;
      if (x + 1 < cols) {
        const b = owner2[i + 1];
        if (b >= 0 && b !== a) { ens(a).add(b); ens(b).add(a); }
      }
      if (y + 1 < rows) {
        const b = owner2[i + cols];
        if (b >= 0 && b !== a) { ens(a).add(b); ens(b).add(a); }
      }
    }
  }

  const domains = [];
  const domainIdByOwner = new Map();
  const liveOwners = [...new Set([...owner2].filter((v) => v >= 0))].sort((a, b) => a - b);
  for (const newId of liveOwners) {
    let rings = cleanRings(polygonizeLabel(owner2, cols, rows, newId, west, north, step));
    if (!rings.length) continue;
    let area = 0;
    try {
      const f = rings.length === 1 ? turf.polygon([rings[0]]) : turf.multiPolygon(rings.map((r) => [r]));
      area = turf.area(f);
    } catch { continue; }
    if (area < 1.2e6) continue; // ~1.2 km² — filtre îlots / peignes
    let sx = 0, sy = 0, n = 0, eSum = 0;
    for (let i = 0; i < N; i++) {
      if (owner2[i] !== newId) continue;
      const x = i % cols, y = (i / cols) | 0;
      sx += west + (x + 0.5) * step;
      sy += north - (y + 0.5) * step;
      eSum += elev[i];
      n++;
    }
    if (!n) continue;
    const seedIdx = used[newId];
    domainIdByOwner.set(newId, domains.length);
    domains.push({
      rings,
      centroid: [sx / n, sy / n],
      avgElevation: Math.round(eSum / n),
      capital: seedIdx != null ? !!seeds[seedIdx].capital : false,
      seedName: seedIdx != null ? seeds[seedIdx].name || null : null,
      historic: seedIdx != null ? !!seeds[seedIdx].historic : false,
      neighbors: [],
    });
  }
  for (const [oid, nbs] of neighborSets) {
    const di = domainIdByOwner.get(oid);
    if (di == null) continue;
    for (const nb of nbs) {
      const dj = domainIdByOwner.get(nb);
      if (dj == null || dj === di) continue;
      if (!domains[di].neighbors.includes(dj)) domains[di].neighbors.push(dj);
    }
  }

  const impOwner = new Int16Array(N);
  for (let i = 0; i < N; i++) if (mask[i] === 2) impOwner[i] = 1;
  let impassableRings = cleanRings(
    polygonizeLabel(impOwner, cols, rows, 1, west, north, step),
  ).filter((r) => {
    try { return turf.area(turf.polygon([r])) > 5e7; } catch { return false; }
  });

  // Lissage PARTAGÉ léger — sommets côtiers figés (évite double carte / frange beige)
  console.log("  lissage partagé des frontières...");
  const pinnedCoast = new Set();
  {
    // Coin de grille (gx,gy) : 4 cellules adjacentes — côtier si une est mer
    const mark = (gx, gy) => {
      for (const [cx, cy] of [
        [gx - 1, gy - 1],
        [gx, gy - 1],
        [gx - 1, gy],
        [gx, gy],
      ]) {
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) {
          const lon = west + gx * step;
          const lat = north - gy * step;
          pinnedCoast.add(pk([lon, lat]));
          return;
        }
        if (owner2[cy * cols + cx] < 0) {
          const lon = west + gx * step;
          const lat = north - gy * step;
          pinnedCoast.add(pk([lon, lat]));
          return;
        }
      }
    };
    for (let gy = 0; gy <= rows; gy++) {
      for (let gx = 0; gx <= cols; gx++) mark(gx, gy);
    }
    // Snap pinned keys to domain vertex precision after weld
  }
  weldVertices(domains, 5);
  // Re-pin after weld (coords quantized)
  {
    const pinned2 = new Set();
    const f = 1e5;
    for (const k of pinnedCoast) {
      const [x, y] = parsePk(k);
      pinned2.add(`${Math.round(x * f) / f},${Math.round(y * f) / f}`);
      // also round variants
      pinned2.add(pk([Math.round(x * f) / f, Math.round(y * f) / f]));
    }
    // Collect actual domain vertices near coast (any vertex within ~0.6 cell of sea)
    for (const d of domains) {
      for (const ring of d.rings) {
        for (const [lon, lat] of openRing(ring)) {
          const gx = Math.round((lon - west) / step);
          const gy = Math.round((north - lat) / step);
          let coast = false;
          for (let dy = -1; dy <= 0; dy++) {
            for (let dx = -1; dx <= 0; dx++) {
              const cx = gx + dx;
              const cy = gy + dy;
              if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) {
                coast = true;
                break;
              }
              if (owner2[cy * cols + cx] < 0) {
                coast = true;
                break;
              }
            }
            if (coast) break;
          }
          if (coast) pinned2.add(pk([lon, lat]));
        }
      }
    }
    laplacianShared(domains, 8, 0.38, pinned2);
    weldVertices(domains, 5);
    laplacianShared(domains, 4, 0.22, pinned2);
    weldVertices(domains, 5);
  }
  for (let i = 0; i < domains.length; i++) {
    domains[i].rings = cleanRings(domains[i].rings);
  }
  const kept = [];
  const oldToNew = new Map();
  for (let i = 0; i < domains.length; i++) {
    if (!domains[i].rings.length) continue;
    oldToNew.set(i, kept.length);
    kept.push(domains[i]);
  }
  if (kept.length < domains.length) {
    console.log(`  anneaux dégénérés écartés (${domains.length - kept.length} domaines vides)`);
  }
  for (const d of kept) {
    d.neighbors = [
      ...new Set(d.neighbors.map((j) => oldToNew.get(j)).filter((j) => j != null && j !== undefined)),
    ];
  }
  // Massifs : lissage isolé léger (pas mélangé aux domaines)
  impassableRings = cleanRings(
    impassableRings.map((r) => polishRingIndependent(r, 8)),
  );

  return { domains: kept, impassableRings, grid: { cols, rows, step } };
}


/**
 * Domaines = expansion multi-source depuis les villes.
 * Terre praticable jointive ; massifs lisses (anneaux fournis) = barrières strictes.
 * Pas de carve / pas de re-raster des montagnes.
 */
export function partitionDomainsFromCities({
  bbox,
  cities,
  landMask,
  impassableRings = [],
  stepDeg = 0.034,
}) {
  const step = stepDeg;
  const west = bbox.lonMin;
  const north = bbox.latMax;
  const cols = Math.ceil((bbox.lonMax - bbox.lonMin) / step) + 1;
  const rows = Math.ceil((bbox.latMax - bbox.latMin) / step) + 1;
  const N = cols * rows;

  let impassableFeat = null;
  if (impassableRings?.length) {
    try {
      impassableFeat =
        impassableRings.length === 1
          ? turf.polygon([closeRing(impassableRings[0])])
          : turf.multiPolygon(impassableRings.map((r) => [closeRing(r)]));
    } catch {
      impassableFeat = null;
    }
  }

  const mask = new Uint8Array(N);
  console.log(`  grille domaines ${cols}×${rows} (${N} cellules, pas ${step}°)…`);
  for (let y = 0; y < rows; y++) {
    const lat = north - y * step;
    for (let x = 0; x < cols; x++) {
      const lon = west + x * step;
      const i = y * cols + x;
      let onLand = false;
      for (const [sx, sy] of [
        [lon, lat],
        [lon + step * 0.45, lat],
        [lon - step * 0.45, lat],
        [lon, lat + step * 0.45],
        [lon, lat - step * 0.45],
      ]) {
        try {
          if (turf.booleanPointInPolygon(turf.point([sx, sy]), landMask)) {
            onLand = true;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (!onLand) continue;
      let mtn = false;
      if (impassableFeat) {
        try {
          mtn = turf.booleanPointInPolygon(turf.point([lon, lat]), impassableFeat);
        } catch {
          mtn = false;
        }
      }
      mask[i] = mtn ? 2 : 1;
    }
  }

  function cellOf(lon, lat) {
    const x = Math.round((lon - west) / step);
    const y = Math.round((north - lat) / step);
    if (x < 0 || y < 0 || x >= cols || y >= rows) return -1;
    return y * cols + x;
  }

  const seeds = [];
  for (const c of cities) {
    let si = cellOf(c.lon, c.lat);
    if (si < 0) continue;
    if (mask[si] === 2) continue; // dans massif → ignorée (filtre amont aussi)
    if (mask[si] === 0) {
      let found = -1;
      for (let r = 1; r <= 12 && found < 0; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = (si % cols) + dx;
            const y = ((si / cols) | 0) + dy;
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            const ni = y * cols + x;
            if (mask[ni] === 1) {
              found = ni;
              break;
            }
          }
          if (found >= 0) break;
        }
      }
      if (found < 0) continue;
      si = found;
    }
    seeds.push({ city: c, i: si });
  }
  console.log(`  ${seeds.length} graines urbaines`);

  function edgeNoise(i, j) {
    let h = (i * 374761393 + j * 668265263) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return 0.78 + ((h % 1000) / 1000) * 0.55;
  }

  const owner = new Int32Array(N).fill(-1);
  const cost = new Float32Array(N).fill(Infinity);
  const heap = new MinHeap();
  for (let s = 0; s < seeds.length; s++) {
    const i = seeds[s].i;
    owner[i] = s;
    cost[i] = 0;
    heap.push({ i, c: 0, s });
  }

  const neigh = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, 1.414],
    [1, -1, 1.414],
    [-1, 1, 1.414],
    [-1, -1, 1.414],
  ];

  while (heap.size) {
    const { i, c, s } = heap.pop();
    if (c > cost[i] || owner[i] !== s) continue;
    const x = i % cols,
      y = (i / cols) | 0;
    for (const [dx, dy, w] of neigh) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (mask[ni] !== 1) continue;
      const nc = c + w * edgeNoise(i, ni);
      if (nc < cost[ni]) {
        cost[ni] = nc;
        owner[ni] = s;
        heap.push({ i: ni, c: nc, s });
      }
    }
  }

  {
    const q = [];
    for (let i = 0; i < N; i++) if (mask[i] === 1 && owner[i] >= 0) q.push(i);
    let qi = 0;
    while (qi < q.length) {
      const i = q[qi++];
      const x = i % cols,
        y = (i / cols) | 0;
      const s = owner[i];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (mask[ni] !== 1 || owner[ni] >= 0) continue;
        owner[ni] = s;
        q.push(ni);
      }
    }
  }

  {
    for (let i = 0; i < N; i++) {
      if (mask[i] !== 1 || owner[i] >= 0) continue;
      let best = 0,
        bestD = Infinity;
      const x = i % cols,
        y = (i / cols) | 0;
      for (let s = 0; s < seeds.length; s++) {
        const sx = seeds[s].i % cols,
          sy = (seeds[s].i / cols) | 0;
        const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      owner[i] = best;
    }
  }

  const neighborSets = new Map();
  const ens = (a) => {
    if (!neighborSets.has(a)) neighborSets.set(a, new Set());
    return neighborSets.get(a);
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const a = owner[i];
      if (a < 0) continue;
      if (x + 1 < cols) {
        const b = owner[i + 1];
        if (b >= 0 && b !== a) {
          ens(a).add(b);
          ens(b).add(a);
        }
      }
      if (y + 1 < rows) {
        const b = owner[i + cols];
        if (b >= 0 && b !== a) {
          ens(a).add(b);
          ens(b).add(a);
        }
      }
    }
  }

  const domains = [];
  const domainIdBySeed = new Map();
  for (let s = 0; s < seeds.length; s++) {
    let rings = cleanRings(polygonizeLabel(owner, cols, rows, s, west, north, step));
    if (!rings.length) continue;
    let area = 0;
    try {
      const f =
        rings.length === 1 ? turf.polygon([rings[0]]) : turf.multiPolygon(rings.map((r) => [r]));
      area = turf.area(f);
    } catch {
      continue;
    }
    if (area < 2e5) continue;
    let sx = 0,
      sy = 0,
      n = 0;
    for (let i = 0; i < N; i++) {
      if (owner[i] !== s) continue;
      const x = i % cols,
        y = (i / cols) | 0;
      sx += west + (x + 0.5) * step;
      sy += north - (y + 0.5) * step;
      n++;
    }
    if (!n) continue;
    domainIdBySeed.set(s, domains.length);
    const city = seeds[s].city;
    domains.push({
      rings,
      centroid: [sx / n, sy / n],
      cityId: city.id,
      name: city.name,
      neighbors: [],
    });
  }
  for (const [sid, nbs] of neighborSets) {
    const di = domainIdBySeed.get(sid);
    if (di == null) continue;
    for (const nb of nbs) {
      const dj = domainIdBySeed.get(nb);
      if (dj == null || dj === di) continue;
      if (!domains[di].neighbors.includes(dj)) domains[di].neighbors.push(dj);
    }
  }

  console.log("  lissage frontières partagées…");
  weldVertices(domains, 5);
  const pinned = new Set();
  for (const d of domains) {
    for (const ring of d.rings) {
      for (const [lon, lat] of openRing(ring)) {
        const gx = Math.round((lon - west) / step);
        const gy = Math.round((north - lat) / step);
        let coastOrMtn = false;
        for (let dy = -1; dy <= 0 && !coastOrMtn; dy++) {
          for (let dx = -1; dx <= 0; dx++) {
            const cx = gx + dx,
              cy = gy + dy;
            if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) {
              coastOrMtn = true;
              break;
            }
            const m = mask[cy * cols + cx];
            if (m === 0 || m === 2) {
              coastOrMtn = true;
              break;
            }
          }
        }
        if (coastOrMtn) pinned.add(pk([lon, lat]));
      }
    }
  }
  laplacianShared(domains, 14, 0.45, pinned);
  weldVertices(domains, 5);
  laplacianShared(domains, 8, 0.32, pinned);
  weldVertices(domains, 5);
  for (const d of domains) d.rings = cleanRings(d.rings);

  const out = [];
  const remap = new Map();
  for (let i = 0; i < domains.length; i++) {
    if (!domains[i].rings.length) continue;
    remap.set(i, out.length);
    out.push(domains[i]);
  }
  for (const d of out) {
    d.neighbors = [
      ...new Set(d.neighbors.map((n) => remap.get(n)).filter((n) => n != null)),
    ];
  }

  console.log(`  ${out.length} domaines jointifs`);
  return { domains: out, grid: { cols, rows, step } };
}
