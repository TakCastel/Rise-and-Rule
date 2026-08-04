// Carte fidèle Natural Earth : littoral 10m (sans mini-îles),
// rivières 10m, massifs = Alpes + Pyrénées (polygones NE, blocs unis).
// Writes public/world.json

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as turf from "@turf/turf";
import {
  loadRivers,
  loadHeightmap,
  partitionDomainsFromCities,
} from "./terrain-domains.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "cache");
const PUBLIC_DIR = join(__dirname, "..", "public");
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(PUBLIC_DIR, { recursive: true });

const BBOX = { lonMin: -9.8, lonMax: 18.8, latMin: 35.8, latMax: 59.5 };
const franceBbox = { lonMin: -5.0, lonMax: 16.0, latMin: 41.0, latMax: 52.0 };
const bboxPoly = turf.bboxPolygon([BBOX.lonMin, BBOX.latMin, BBOX.lonMax, BBOX.latMax]);

/** Îles sous ce seuil (km²) → écartées */
const MIN_ISLAND_KM2 = 1500;

function closeRing(ring) {
  if (!ring?.length) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, ring[0]];
}
function ringsFromGeometry(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates[0]];
  if (geom.type === "MultiPolygon") return geom.coordinates.map((p) => p[0]);
  return [];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// 1) Terre — Natural Earth 10m, sans mini-îles
// ---------------------------------------------------------------------------
console.log("Littoral Natural Earth 10m (sans mini-îles)...");
const landCachePath = join(
  CACHE_DIR,
  `land_clean_${MIN_ISLAND_KM2}_${BBOX.lonMin}_${BBOX.lonMax}_${BBOX.latMin}_${BBOX.latMax}.json`,
);
let landMask;
if (existsSync(landCachePath)) {
  landMask = readJson(landCachePath);
} else {
  const landPath = join(CACHE_DIR, "ne_10m_land.geojson");
  if (!existsSync(landPath)) throw new Error("Manque ne_10m_land.geojson dans scripts/cache/");
  const neLand = readJson(landPath);
  const kept = [];
  let dropped = 0;
  for (const f of neLand.features) {
    try {
      if (!turf.booleanIntersects(f, bboxPoly)) continue;
      const clipped = turf.intersect(turf.featureCollection([f, bboxPoly]));
      if (!clipped) continue;
      // Sépare chaque polygone / île
      for (const piece of turf.flatten(clipped).features) {
        const km2 = turf.area(piece) / 1e6;
        if (km2 < MIN_ISLAND_KM2) {
          dropped++;
          continue;
        }
        kept.push(piece);
      }
    } catch {
      /* skip */
    }
  }
  if (!kept.length) throw new Error("Aucune terre conservée");
  landMask = kept[0];
  for (let i = 1; i < kept.length; i++) {
    try {
      const u = turf.union(turf.featureCollection([landMask, kept[i]]));
      if (u) landMask = u;
    } catch {
      /* keep */
    }
  }
  // Simplification douce : fidèle mais lisible (pas fractale)
  landMask = turf.simplify(landMask, { tolerance: 0.0025, highQuality: true });
  writeFileSync(landCachePath, JSON.stringify(landMask));
  console.log(`  gardé ${kept.length} masses, écarté ${dropped} mini-îles (< ${MIN_ISLAND_KM2} km²)`);
}
console.log(`  terre: ${landMask.geometry.type}, ${(turf.area(landMask) / 1e9).toFixed(0)} Gm²`);

// ---------------------------------------------------------------------------
// 2) Rivières — Natural Earth 10m
// ---------------------------------------------------------------------------
console.log("Rivières Natural Earth 10m...");
const riverLines = loadRivers(CACHE_DIR, BBOX, landMask);
console.log(`  ${riverLines.length} tronçons`);

// ---------------------------------------------------------------------------
// 3) Massifs — chaînes Alpes + Pyrénées (empreinte Natural Earth, topo continue)
// ---------------------------------------------------------------------------
console.log("Chaînes de montagnes Alpes + Pyrénées (topo continue)...");
const geoPath = join(CACHE_DIR, "ne_10m_geography_regions_polys.geojson");
if (!existsSync(geoPath)) {
  throw new Error("Manque ne_10m_geography_regions_polys.geojson — télécharge-le dans scripts/cache/");
}
const geoRegions = readJson(geoPath);

const HEIGHT_META = {
  url: "/heightmap.png",
  width: 950,
  height: 796,
  minElevation: -30,
  maxElevation: 4157,
};
const { elevAt } = loadHeightmap(PUBLIC_DIR, BBOX, HEIGHT_META);

function chaikinRing(ring, passes = 3) {
  let pts = ring.slice(0, -1);
  for (let p = 0; p < passes; p++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    pts = out;
  }
  return closeRing(pts);
}

/**
 * Chaîne impraticable : polygone NE (topo de la chaîne) ∩ terre,
 * resserré au relief haut puis fortement refermé/lissé → un massif continu.
 */
function mountainChainMask(regionFeat, minElev) {
  const [minX, minY, maxX, maxY] = turf.bbox(regionFeat);
  const step = 0.025;
  const cols = Math.ceil((maxX - minX) / step) + 1;
  const rows = Math.ceil((maxY - minY) / step) + 1;
  const owner = new Uint8Array(cols * rows);
  let n = 0;
  for (let y = 0; y < rows; y++) {
    const lat = maxY - y * step;
    for (let x = 0; x < cols; x++) {
      const lon = minX + x * step;
      try {
        if (!turf.booleanPointInPolygon(turf.point([lon, lat]), regionFeat)) continue;
      } catch {
        continue;
      }
      if (elevAt(lon, lat) < minElev) continue;
      owner[y * cols + x] = 1;
      n++;
    }
  }
  if (!n) return null;

  function dilate(src) {
    const out = Uint8Array.from(src);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        if (src[i]) continue;
        if (src[i - 1] || src[i + 1] || src[i - cols] || src[i + cols]) out[i] = 1;
      }
    }
    return out;
  }
  function erode(src) {
    const out = Uint8Array.from(src);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        if (!src[i]) continue;
        if (!src[i - 1] || !src[i + 1] || !src[i - cols] || !src[i + cols]) out[i] = 0;
      }
    }
    return out;
  }
  // Closing fort : une chaîne continue, pas un fractal de pics
  let grid = owner;
  for (let i = 0; i < 4; i++) grid = dilate(grid);
  for (let i = 0; i < 3; i++) grid = erode(grid);

  const edges = new Map();
  const ek = (a, b, c, d) => `${a},${b},${c},${d}`;
  const add = (x1, y1, x2, y2) => {
    const rev = ek(x2, y2, x1, y1);
    if (edges.has(rev)) edges.delete(rev);
    else edges.set(ek(x1, y1, x2, y2), [x1, y1, x2, y2]);
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!grid[y * cols + x]) continue;
      if (x === 0 || !grid[y * cols + x - 1]) add(x, y, x, y + 1);
      if (x === cols - 1 || !grid[y * cols + x + 1]) add(x + 1, y + 1, x + 1, y);
      if (y === 0 || !grid[(y - 1) * cols + x]) add(x + 1, y, x, y);
      if (y === rows - 1 || !grid[(y + 1) * cols + x]) add(x, y + 1, x + 1, y + 1);
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
    const sk = byStart.keys().next().value;
    const list = byStart.get(sk);
    if (!list?.length) {
      byStart.delete(sk);
      continue;
    }
    const first = list.pop();
    if (!list.length) byStart.delete(sk);
    const ring = [
      [first[0], first[1]],
      [first[2], first[3]],
    ];
    let cx = first[2],
      cy = first[3];
    const sx = first[0],
      sy = first[1];
    let guard = edges.size + 5;
    while ((cx !== sx || cy !== sy) && guard-- > 0) {
      const k = `${cx},${cy}`;
      const L = byStart.get(k);
      if (!L?.length) break;
      const n2 = L.pop();
      if (!L.length) byStart.delete(k);
      ring.push([n2[2], n2[3]]);
      cx = n2[2];
      cy = n2[3];
    }
    if (ring.length >= 4) {
      rings.push(closeRing(ring.map(([gx, gy]) => [minX + gx * step, maxY - gy * step])));
    }
  }
  if (!rings.length) return null;

  // Plus grand anneau = corps de la chaîne
  let best = rings[0];
  let bestA = 0;
  for (const r of rings) {
    try {
      const a = turf.area(turf.polygon([r]));
      if (a > bestA) {
        bestA = a;
        best = r;
      }
    } catch {
      /* skip */
    }
  }

  let smooth = chaikinRing(best, 4);
  try {
    const s = turf.simplify(turf.polygon([smooth]), {
      tolerance: 0.018,
      highQuality: true,
    });
    smooth = chaikinRing(closeRing(s.geometry.coordinates[0]), 2);
  } catch {
    /* keep */
  }
  // Clip terre pour coller au littoral / ne pas déborder
  try {
    const clipped = turf.intersect(
      turf.featureCollection([turf.polygon([smooth]), landMask]),
    );
    if (clipped?.geometry) {
      const g = clipped.geometry;
      if (g.type === "Polygon") return closeRing(g.coordinates[0]);
      if (g.type === "MultiPolygon") {
        let top = g.coordinates[0][0];
        let topA = 0;
        for (const poly of g.coordinates) {
          const a = turf.area(turf.polygon([poly[0]]));
          if (a > topA) {
            topA = a;
            top = poly[0];
          }
        }
        return closeRing(top);
      }
    }
  } catch {
    /* keep smooth */
  }
  return smooth;
}

const WANT = {
  ALPS: 1600,
  PYRENEES: 1400,
};

const impassable = [];
for (const f of geoRegions.features) {
  const name = f.properties?.NAME;
  if (!(name in WANT)) continue;
  try {
    if (!turf.booleanIntersects(f, bboxPoly)) continue;
    let feat = turf.intersect(turf.featureCollection([f, bboxPoly]));
    if (!feat) continue;
    try {
      const onLand = turf.intersect(turf.featureCollection([feat, landMask]));
      if (onLand) feat = onLand;
    } catch {
      /* keep */
    }
    const ring = mountainChainMask(feat, WANT[name]);
    if (!ring) {
      console.warn(`  ${name}: chaîne introuvable`);
      continue;
    }
    const a = turf.area(turf.polygon([ring])) / 1e6;
    impassable.push(ring);
    console.log(`  ${name}: chaîne OK (${a.toFixed(0)} km², ≥ ${WANT[name]} m)`);
  } catch (e) {
    console.warn(`  ${name}: échec`, e.message);
  }
}

const landRings = ringsFromGeometry(landMask.geometry).map(closeRing);
const landPts = landRings.reduce((n, r) => n + r.length, 0);

// ---------------------------------------------------------------------------
// 4) Villes c. 400 — DARE, répartition homogène
//    densités fortes → 1 seule (la plus importante)
//    zones vides → on complète avec cities / towns
// ---------------------------------------------------------------------------
console.log("Villes historiques (DARE, répartition homogène)...");

/** Priorité relative des cités majeures (plus haut = plus connue) */
const FAMOUS = [
  ["Roma", 100],
  ["Lutetia", 96],
  ["Mediolanum", 94], // Milan — exclu si Aulercorum / Convenarum
  ["Ravenna", 93],
  ["Lugdunum", 92],
  ["Arelate", 91],
  ["Massalia", 90],
  ["Burdigala", 89],
  ["Treverorum", 88],
  ["Agrippinensium", 87],
  ["Londinium", 86],
  ["Aquileia", 85],
  ["Narbo", 84],
  ["Tolosa", 83],
  ["Corduba", 82],
  ["Hispalis", 81],
  ["Tarraco", 80],
  ["Carthago", 79],
  ["Durocortorum", 78],
  ["Eburacum", 77],
  ["Nemausus", 76],
  ["Augustodunum", 75],
  ["Gesoriacum", 74],
  ["Bononia", 73],
  ["Caesarodunum", 72],
  ["Limonum", 71],
  ["Samarobriva", 70],
  ["Vienna", 69],
  ["Arausio", 68],
  ["Vindobona", 67],
  ["Asturica", 66],
  ["Bracara", 65],
  ["Emerita", 64],
  ["Caesaraugusta", 63],
  ["Neapolis", 62],
  ["Capua", 61],
  ["Syracusae", 60],
  ["Panormus", 59],
  ["Brigantium", 58],
];

function fameBonus(name) {
  const n = name.toLowerCase();
  if (n.includes("aulercorum") || n.includes("convenarum") || n.includes("santonum")) return 0;
  let best = 0;
  for (const [f, b] of FAMOUS) {
    const key = f.toLowerCase();
    const re = new RegExp(`(^|[^a-z])${key.replace(/\./g, "\\.")}([^a-z]|$)`, "i");
    if (re.test(n) && b > best) best = b;
  }
  return best;
}

function cleanAncientName(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^\*+/, "").replace(/\?+/g, "").replace(/^\[|\]$/g, "").trim();
  const parts = s.split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const joined = parts.join(" ").toLowerCase();
  // Homonymes : garder le qualificatif (Saintes, Évreux…)
  if (/santonum|aulercorum|convenarum|ebroicorum/i.test(joined)) {
    return parts.slice(0, 2).join(" ");
  }
  // Préfère un segment célèbre (Mediolanium/Mediolanum → Mediolanum)
  for (const p of parts) {
    if (fameBonus(p) > 0) return p;
  }
  return parts[0];
}

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function loadDareMajorCities() {
  /** @type {{lon:number,lat:number,name:string,modern:string|null,kind:string,score:number}[]} */
  const candidates = [];
  const seen = new Set();

  function add(lon, lat, name, kind, modern) {
    if (lon < BBOX.lonMin || lon > BBOX.lonMax || lat < BBOX.latMin || lat > BBOX.latMax) return;
    try {
      if (!turf.booleanPointInPolygon(turf.point([lon, lat]), landMask)) return;
    } catch {
      /* keep */
    }
    const ancient = cleanAncientName(name);
    if (!ancient) return;
    const key = `${lon.toFixed(3)},${lat.toFixed(3)},${ancient}`;
    if (seen.has(key)) return;
    seen.add(key);
    const base = kind === "civitas" ? 100 : kind === "city" ? 55 : 22;
    candidates.push({
      lon,
      lat,
      name: ancient,
      modern: modern || null,
      kind,
      score: base + fameBonus(ancient),
    });
  }

  const civPath = join(CACHE_DIR, "dare_civitas_capitals.json");
  const cityPath = join(CACHE_DIR, "dare_cities.json");
  const townPath = join(CACHE_DIR, "dare_towns.json");
  if (existsSync(civPath)) {
    for (const f of readJson(civPath).features || []) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (lon == null) continue;
      add(lon, lat, f.properties?.ancient || f.properties?.name, "civitas", f.properties?.name);
    }
  }
  if (existsSync(cityPath)) {
    for (const f of readJson(cityPath).features || []) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (lon == null) continue;
      add(lon, lat, f.properties?.ancient || f.properties?.name, "city", f.properties?.name);
    }
  }
  if (existsSync(townPath)) {
    for (const f of readJson(townPath).features || []) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (lon == null) continue;
      add(lon, lat, f.properties?.ancient || f.properties?.name, "town", f.properties?.name);
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // 1) Thinning dense : garde la plus importante ; remplace si une plus célèbre arrive
  const MIN_KM_DENSE = 65;
  const kept = [];
  const rejected = [];
  for (const c of candidates) {
    let conflictIdx = -1;
    let conflictDist = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      const d = haversineKm(c.lon, c.lat, k.lon, k.lat);
      const minD = k.score >= 150 ? MIN_KM_DENSE : k.score >= 100 ? 58 : 48;
      if (d < minD && d < conflictDist) {
        conflictDist = d;
        conflictIdx = i;
      }
    }
    if (conflictIdx < 0) {
      kept.push(c);
      continue;
    }
    const rival = kept[conflictIdx];
    // La plus connue gagne (même à score proche)
    if (c.score > rival.score) {
      rejected.push(rival);
      kept[conflictIdx] = c;
    } else {
      rejected.push(c);
    }
  }

  // 2) Remplir les zones trop vides (maille ~95 km)
  const CELL_DEG = 0.95; // ~100 km
  const cols = Math.ceil((BBOX.lonMax - BBOX.lonMin) / CELL_DEG);
  const rows = Math.ceil((BBOX.latMax - BBOX.latMin) / CELL_DEG);
  const cellHas = new Uint8Array(cols * rows);
  function cellIndex(lon, lat) {
    const x = Math.min(cols - 1, Math.max(0, Math.floor((lon - BBOX.lonMin) / CELL_DEG)));
    const y = Math.min(rows - 1, Math.max(0, Math.floor((BBOX.latMax - lat) / CELL_DEG)));
    return y * cols + x;
  }
  for (const k of kept) cellHas[cellIndex(k.lon, k.lat)] = 1;

  const FILL_MIN_KM = 38; // plus souple pour densifier
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ci = y * cols + x;
      if (cellHas[ci]) continue;
      // Cellule a-t-elle de la terre ?
      const clon = BBOX.lonMin + (x + 0.5) * CELL_DEG;
      const clat = BBOX.latMax - (y + 0.5) * CELL_DEG;
      try {
        if (!turf.booleanPointInPolygon(turf.point([clon, clat]), landMask)) continue;
      } catch {
        continue;
      }
      // Meilleure candidate dans / près de la cellule
      let best = null;
      for (const c of rejected) {
        if (cellIndex(c.lon, c.lat) !== ci) {
          // aussi voisines immédiates
          const dx = Math.abs(c.lon - clon);
          const dy = Math.abs(c.lat - clat);
          if (dx > CELL_DEG * 0.7 || dy > CELL_DEG * 0.7) continue;
        }
        let farEnough = true;
        for (const k of kept) {
          if (haversineKm(c.lon, c.lat, k.lon, k.lat) < FILL_MIN_KM) {
            farEnough = false;
            break;
          }
        }
        if (!farEnough) continue;
        if (!best || c.score > best.score) best = c;
      }
      if (best) {
        kept.push(best);
        cellHas[ci] = 1;
        const ix = rejected.indexOf(best);
        if (ix >= 0) rejected.splice(ix, 1);
      }
    }
  }

  kept.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return kept.map((c, id) => ({
    id,
    name: c.name,
    modern: c.modern,
    kind: c.kind,
    lon: c.lon,
    lat: c.lat,
  }));
}

const citiesAll = loadDareMajorCities();
const nCiv0 = citiesAll.filter((c) => c.kind === "civitas").length;
const nCity0 = citiesAll.filter((c) => c.kind === "city").length;
const nTown0 = citiesAll.filter((c) => c.kind === "town").length;
console.log(
  `  ${citiesAll.length} villes homogènes (civitas ${nCiv0}, cities ${nCity0}, towns ${nTown0})`,
);

// Villes dans les chaînes impraticables → retirées
let mtnFeat = null;
if (impassable.length) {
  try {
    mtnFeat =
      impassable.length === 1
        ? turf.polygon([impassable[0]])
        : turf.multiPolygon(impassable.map((r) => [r]));
  } catch {
    mtnFeat = null;
  }
}
const cities = [];
const removedInMtn = [];
for (const c of citiesAll) {
  let inside = false;
  if (mtnFeat) {
    try {
      inside = turf.booleanPointInPolygon(turf.point([c.lon, c.lat]), mtnFeat);
    } catch {
      inside = false;
    }
  }
  if (inside) removedInMtn.push(c.name);
  else cities.push(c);
}

// Îles : 1 ville / île majeure quand deux cités se partagent le même îlot
// Majorque — Pollentia + Guium → Pollentia seule (1 domaine pour toute l’île)
{
  const mallorca = cities.filter(
    (c) => c.lon >= 2.6 && c.lon <= 3.5 && c.lat >= 39.2 && c.lat <= 40.05,
  );
  if (mallorca.length > 1) {
    const keep =
      mallorca.find((c) => /pollentia/i.test(c.name)) ||
      mallorca.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
    const drop = new Set(mallorca.filter((c) => c !== keep).map((c) => c.name));
    const before = cities.length;
    for (let i = cities.length - 1; i >= 0; i--) {
      if (drop.has(cities[i].name) && mallorca.some((m) => m.name === cities[i].name)) {
        cities.splice(i, 1);
      }
    }
    console.log(
      `  Majorque: ${before - cities.length} ville(s) fusionnée(s) → ${keep.name} seule`,
    );
  }
}

// Re-index ids after removal
for (let i = 0; i < cities.length; i++) cities[i] = { ...cities[i], id: i };
console.log(
  `  ${removedInMtn.length} villes retirées (dans massifs)${
    removedInMtn.length ? `: ${removedInMtn.slice(0, 12).join(", ")}${removedInMtn.length > 12 ? "…" : ""}` : ""
  }`,
);
console.log(`  ${cities.length} villes conservées`);
console.log(`  ex: ${cities.slice(0, 10).map((c) => c.name).join(", ")}`);

// ---------------------------------------------------------------------------
// 5) Domaines = expansion autour des villes (massifs = barrières continues)
// ---------------------------------------------------------------------------
console.log("Domaines depuis les villes...");
const { domains: rawDomains } = partitionDomainsFromCities({
  bbox: BBOX,
  cities,
  landMask,
  impassableRings: impassable,
});
const domaines = rawDomains.map((d, id) => ({
  id,
  code: null,
  name: d.name,
  cityId: d.cityId,
  centroid: d.centroid,
  avgElevation: 0,
  boundary: d.rings,
  neighbors: d.neighbors,
}));
console.log(`  ${domaines.length} domaines`);

// ---------------------------------------------------------------------------
// 6) Royaumes = groupes de domaines (carte type Clovis ~486–507).
//    Assignation géographique fidèle à la carte de référence (pas Cliopatria).
//    Contours = domaines, recalculés à l’affichage.
// ---------------------------------------------------------------------------
console.log("Royaumes (carte Clovis ~486)…");

/** Grande-Bretagne (île) — exclut la côte gauloise (Calais, Boulogne…). */
function isBritain(lon, lat) {
  if (lat < 49.9 || lat > 59.2) return false;
  if (lon < -6.5 || lon > 1.95) return false;
  // Pas-de-Calais / Flandre maritime (continent)
  if (lon > 1.35 && lat < 51.25) return false;
  if (lon > 0.9 && lat < 50.9) return false;
  return true;
}

/** Îles / hors-carte → domaines seuls (pas de royaume). */
function isSoloDomain(_lon, _lat) {
  // Baléares, Corse et Sardaigne ont désormais leur propre royaume (voir KINGDOM_ZONES).
  return false;
}

/** Assignment zones — order = priority (specific → broad). */
const KINGDOM_ZONES = [
  {
    name: "Suebian Kingdom",
    code: "SUEB",
    hit: (lon, lat) => lon >= -9.8 && lon <= -5.9 && lat >= 40.7 && lat <= 43.95,
  },
  {
    name: "Vandal Kingdom",
    code: "VAND",
    // North Africa only (islands = solo domains)
    hit: (lon, lat) => lat <= 37.4 && lon >= -2.2 && lon <= 12.5,
  },
  {
    name: "Ostrogothic Kingdom",
    code: "OSTG",
    hit: (lon, lat) => {
      // Corsica / Sardinia → solos
      if (lon >= 8.05 && lon <= 9.95 && lat >= 38.75 && lat <= 41.35) return false;
      if (lon >= 8.4 && lon <= 9.7 && lat >= 41.25 && lat <= 43.05) return false;
      if (lon < 6.6 || lon > 18.9) return false;
      if (lat < 36.4) return false;
      if (lon < 7.35 && lat > 43.5) return false; // Provence
      // Swiss plateau / north of Alps → not Ostrogothic
      if (lon < 11.2 && lat > 46.35) return false;
      // East foothills (Iuvavum / Salzburg+) → Carinthia, not Ostrogothic
      if (lon >= 11.2 && lat > 47.55) return false;
      // Italy / Po ceiling
      if (lon < 11.2 && lat > 46.55) return false;
      return true;
    },
  },
  {
    name: "Kingdom of Burgundy",
    code: "BURG",
    hit: (lon, lat) => {
      // Inland (Lyon / Geneva / Saône–Rhône) — no Mediterranean coast
      if (lat < 44.85) return false;
      if (lon < 4.0 || lon > 7.5) return false;
      if (lat > 47.35) return false;
      return true;
    },
  },
  {
    name: "Alemannic Kingdom",
    code: "ALAM",
    // North of Alps only (Alsace / Swabia / Raetia) — not south/east alpine
    hit: (lon, lat) => lon >= 7.3 && lon <= 11.2 && lat >= 46.9 && lat <= 49.3,
  },
  {
    name: "Kingdom of Soissons",
    code: "SYAG",
    hit: (lon, lat) => {
      if (isBritain(lon, lat)) return false;
      // Bassin parisien / Soissons — s’arrête avant Cambrai (Francs)
      return lon >= -1.0 && lon <= 4.9 && lat >= 47.35 && lat < 49.65;
    },
  },
  // England ~486: Anglo-Saxons east/SE, Britons west/north
  {
    name: "Anglo-Saxon Kingdom",
    code: "ANGL",
    hit: (lon, lat) => {
      if (!isBritain(lon, lat)) return false;
      // East / SE (Kent, East Anglia, lower Thames, coastal Yorkshire…)
      if (lon >= -2.4 && lon <= 1.95 && lat >= 50.5 && lat <= 54.8) {
        // Not Wales / Cornwall
        if (lon < -2.0 && lat < 52.8) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Kingdom of the Britons",
    code: "BRIT",
    hit: (lon, lat) => {
      if (!isBritain(lon, lat)) return false;
      // Rest of the island (Wales, West, North, Cornwall)
      return true;
    },
  },
  {
    name: "Kingdom of Brittany",
    code: "BRYT",
    // Armorica (peninsula)
    hit: (lon, lat) => lon >= -5.6 && lon <= -1.15 && lat >= 46.95 && lat <= 49.05,
  },
  {
    // Toulouse-based Gaulish half of the pre-507 Visigothic realm — split
    // out from Hispania so the two read as distinct in-game kingdoms.
    name: "Kingdom of Aquitaine",
    code: "AQUI",
    hit: (lon, lat) => {
      // Aquitaine / Midi up to the Loire (~47.3)
      if (lon >= -1.9 && lon <= 4.2 && lat >= 42.7 && lat <= 47.35) return true;
      // Septimania / Narbonensis / Provence to Maritime Alps (coast)
      if (lon >= 2.4 && lon <= 7.3 && lat >= 42.4 && lat <= 44.85) return true;
      return false;
    },
  },
  {
    name: "Kingdom of the Balearics",
    code: "BALE",
    hit: (lon, lat) => lon >= 1.0 && lon <= 4.5 && lat >= 38.5 && lat <= 40.3,
  },
  {
    name: "Kingdom of Corsica",
    code: "CORS",
    hit: (lon, lat) => lon >= 8.4 && lon <= 9.7 && lat >= 41.25 && lat <= 43.05,
  },
  {
    name: "Kingdom of Sardinia",
    code: "SARD",
    hit: (lon, lat) => lon >= 8.05 && lon <= 9.95 && lat >= 38.75 && lat <= 41.35,
  },
  {
    name: "Visigothic Kingdom",
    code: "VISI",
    hit: (lon, lat) => {
      // Hispania outside Suebi (Aquitaine/Septimania/Provence now AQUI, above)
      if (lon >= -9.6 && lon <= 3.4 && lat >= 36.0 && lat <= 43.75) {
        if (lon <= -5.9 && lat >= 40.7) return false;
        return true;
      }
      return false;
    },
  },
  {
    name: "Kingdom of the Franks",
    code: "FRAN",
    hit: (lon, lat) => {
      // Continent only — not England
      if (isBritain(lon, lat)) return false;
      // Flandre / Toxandria / Cambrai / Rhin — au N de Soissons
      if (lon >= 1.2 && lon <= 8.8 && lat >= 49.65 && lat <= 51.6) return true;
      if (lon >= 4.8 && lon <= 8.8 && lat >= 47.6 && lat <= 50.8) return true;
      return false;
    },
  },
  {
    // Coastal NL / NW Germany — carved out of what would otherwise fall to Saxony.
    name: "Frisian Kingdom",
    code: "FRIS",
    hit: (lon, lat) => lon >= 4.5 && lon <= 7.6 && lat >= 52.7 && lat <= 54.3,
  },
  {
    // Jutland + Danish isles — currently unclaimed / swallowed by the Saxon fallback.
    name: "Kingdom of the Danes",
    code: "DANE",
    hit: (lon, lat) => lon >= 8.0 && lon <= 12.5 && lat >= 54.6 && lat <= 59.3,
  },
  {
    name: "Saxon Kingdom",
    code: "SAXO",
    hit: (lon, lat) => lon >= 6.4 && lon <= 11.8 && lat >= 51.4 && lat <= 54.6,
  },
  {
    name: "Kingdom of Thuringia",
    code: "THUR",
    hit: (lon, lat) => lon >= 9.4 && lon <= 13.8 && lat >= 49.4 && lat <= 52.2,
  },
  {
    name: "Kingdom of Carinthia",
    code: "CARN",
    hit: (lon, lat) => lon >= 11.5 && lon <= 16.9 && lat >= 47.5 && lat <= 50.5,
  },
];

const LABELS = Object.fromEntries(
  KINGDOM_ZONES.map((z) => [z.name, { name: z.name, code: z.code }]),
);

/** @returns {{ name: string, code: string } | null} null = solo domain */
function labelKingdom(d) {
  let lon = d.centroid[0],
    lat = d.centroid[1];
  if (d.cityId != null && cities[d.cityId]) {
    lon = cities[d.cityId].lon;
    lat = cities[d.cityId].lat;
  }
  if (isSoloDomain(lon, lat)) return null;
  for (const z of KINGDOM_ZONES) {
    if (z.hit(lon, lat)) return LABELS[z.name];
  }
  // Nearest seed (fallback) — always resolves to some kingdom, see below.
  let best = null;
  let bestD = Infinity;
  const FALLBACK_SEEDS = [
    ["Visigothic Kingdom", -3.5, 40.5],
    ["Kingdom of Aquitaine", 1.4, 43.6],
    ["Kingdom of the Balearics", 3.1, 39.85],
    ["Kingdom of Corsica", 9.2, 42.2],
    ["Kingdom of Sardinia", 9.0, 39.8],
    ["Ostrogothic Kingdom", 12.5, 42.5],
    ["Kingdom of the Franks", 4.5, 50.5],
    ["Kingdom of Burgundy", 5.5, 45.8],
    ["Kingdom of Soissons", 2.5, 48.8],
    ["Alemannic Kingdom", 9.0, 48.0],
    ["Suebian Kingdom", -8.0, 42.5],
    ["Vandal Kingdom", 10.0, 36.5],
    ["Kingdom of Brittany", -3.0, 48.2],
    ["Kingdom of the Britons", -3.5, 52.5],
    ["Anglo-Saxon Kingdom", 0.5, 52.0],
    ["Frisian Kingdom", 6.0, 53.3],
    ["Kingdom of the Danes", 9.5, 55.5],
    ["Saxon Kingdom", 9.0, 53.0],
    ["Kingdom of Thuringia", 11.0, 50.8],
  ];
  for (const [name, sx, sy] of FALLBACK_SEEDS) {
    const dx = lon - sx;
    const dy = (lat - sy) * 1.4;
    const dist = dx * dx + dy * dy;
    if (dist < bestD) {
      bestD = dist;
      best = LABELS[name];
    }
  }
  // Pas de coupure de distance : un royaume quelque part sur la carte, même
  // lointain, vaut mieux qu'un domaine sans maître — plus aucune terre
  // franchement vide.
  return best;
}

const usedKingdomKeys = new Map();
let soloCount = 0;
for (const d of domaines) {
  const k = labelKingdom(d);
  if (!k) {
    delete d.royaumeId;
    soloCount++;
    continue;
  }
  const key = k.name;
  if (!usedKingdomKeys.has(key)) usedKingdomKeys.set(key, usedKingdomKeys.size);
  d.royaumeId = usedKingdomKeys.get(key);
}
console.log(`  domaines solos (hors royaume): ${soloCount}`);

const royaumeNames = [...usedKingdomKeys.keys()];
const royaumes = royaumeNames.map((name, rid) => {
  const lab = LABELS[name] || { name, code: name.slice(0, 4).toUpperCase() };
  const members = domaines.filter((d) => d.royaumeId === rid);
  let sx = 0,
    sy = 0;
  for (const d of members) {
    sx += d.centroid[0];
    sy += d.centroid[1];
  }
  const n = Math.max(1, members.length);
  console.log(`  ${lab.name}: ${members.length} domaines`);
  return {
    id: rid,
    name: lab.name,
    code: lab.code,
    centroid: [sx / n, sy / n],
    domaines: members.map((d) => d.id),
    neighbors: [],
  };
});

{
  const nb = royaumes.map(() => new Set());
  for (const d of domaines) {
    const a = d.royaumeId;
    if (a == null) continue;
    for (const n of d.neighbors || []) {
      const b = domaines[n]?.royaumeId;
      if (b == null || b === a) continue;
      nb[a].add(b);
      nb[b].add(a);
    }
  }
  for (let i = 0; i < royaumes.length; i++) {
    royaumes[i].neighbors = [...nb[i]];
  }
}

/** Provinces = historical regions, contiguous, 2–6 domains each. */
const MAX_DOMAINS_PER_PROVINCE = 6;
const MIN_DOMAINS_PER_PROVINCE = 2;

function domainLonLat(d) {
  if (d.cityId != null && cities[d.cityId]) {
    return [cities[d.cityId].lon, cities[d.cityId].lat];
  }
  return d.centroid;
}

function dist2dom(a, b) {
  const [ax, ay] = domainLonLat(a);
  const [bx, by] = domainLonLat(b);
  const dx = ax - bx;
  const dy = (ay - by) * 1.4;
  return dx * dx + dy * dy;
}

/** Composantes connexes (via neighbors) restreintes à `members`. */
function connectedComponents(members) {
  const byId = new Map(members.map((d) => [d.id, d]));
  const memberIds = new Set(members.map((d) => d.id));
  const seen = new Set();
  const comps = [];
  for (const start of members) {
    if (seen.has(start.id)) continue;
    const stack = [start];
    const comp = [];
    seen.add(start.id);
    while (stack.length) {
      const d = stack.pop();
      comp.push(d);
      for (const nid of d.neighbors || []) {
        if (!memberIds.has(nid) || seen.has(nid)) continue;
        seen.add(nid);
        stack.push(byId.get(nid));
      }
    }
    comps.push(comp);
  }
  return comps;
}

function isConnected(members) {
  if (members.length <= 1) return true;
  return connectedComponents(members).length === 1;
}

function clustersTouch(a, b) {
  const ids = new Set(b.map((d) => d.id));
  for (const d of a) {
    for (const nid of d.neighbors || []) {
      if (ids.has(nid)) return true;
    }
  }
  return false;
}

/**
 * Découpe un ensemble connexe en provinces contigues de taille ∈ [minSize, maxSize].
 */
function splitConnectedIntoProvinces(members, maxSize, minSize = MIN_DOMAINS_PER_PROVINCE) {
  const n = members.length;
  if (n === 0) return [];
  if (n <= maxSize) return [members.slice()];

  let k = Math.ceil(n / maxSize);
  while (k > 1 && Math.floor(n / k) < minSize) k--;
  const base = Math.floor(n / k);
  const extra = n % k;
  const targets = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));

  const byId = new Map(members.map((d) => [d.id, d]));
  const memberIds = new Set(members.map((d) => d.id));
  const remaining = new Set(members.map((d) => d.id));
  const clusters = [];

  for (const target of targets) {
    if (remaining.size === 0) break;
    let seed = null;
    if (clusters.length === 0) {
      let bestLon = Infinity;
      for (const id of remaining) {
        const d = byId.get(id);
        const lon = domainLonLat(d)[0];
        if (lon < bestLon) {
          bestLon = lon;
          seed = d;
        }
      }
    } else {
      let bestMin = -1;
      for (const id of remaining) {
        const d = byId.get(id);
        let mind = Infinity;
        for (const c of clusters) {
          for (const cd of c) mind = Math.min(mind, dist2dom(d, cd));
        }
        if (mind > bestMin) {
          bestMin = mind;
          seed = d;
        }
      }
    }
    if (!seed) break;

    const cluster = [seed];
    remaining.delete(seed.id);
    const frontier = [];
    for (const nid of seed.neighbors || []) {
      if (remaining.has(nid) && memberIds.has(nid)) frontier.push(nid);
    }

    const want = Math.min(target, remaining.size + 1);
    while (cluster.length < want && frontier.length > 0) {
      let sx = 0,
        sy = 0;
      for (const d of cluster) {
        const [lon, lat] = domainLonLat(d);
        sx += lon;
        sy += lat;
      }
      sx /= cluster.length;
      sy /= cluster.length;

      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < frontier.length; i++) {
        const d = byId.get(frontier[i]);
        const [lon, lat] = domainLonLat(d);
        const dx = lon - sx;
        const dy = (lat - sy) * 1.4;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          bestIdx = i;
        }
      }
      const nextId = frontier.splice(bestIdx, 1)[0];
      if (!remaining.has(nextId)) continue;
      const next = byId.get(nextId);
      cluster.push(next);
      remaining.delete(nextId);
      for (const nid of next.neighbors || []) {
        if (remaining.has(nid) && memberIds.has(nid) && !frontier.includes(nid)) {
          frontier.push(nid);
        }
      }
    }
    clusters.push(cluster);
  }

  if (remaining.size > 0) {
    const leftover = [...remaining].map((id) => byId.get(id));
    for (const d of leftover) {
      let attached = false;
      for (const c of clusters) {
        if (c.length >= maxSize) continue;
        if (!(d.neighbors || []).some((nid) => c.some((x) => x.id === nid))) continue;
        c.push(d);
        remaining.delete(d.id);
        attached = true;
        break;
      }
      if (!attached) break;
    }
    if (remaining.size > 0) {
      const rest = [...remaining].map((id) => byId.get(id));
      clusters.push(...splitConnectedIntoProvinces(rest, maxSize, minSize));
    }
  }

  return clusters.filter((c) => c.length > 0);
}

/**
 * Garantit min≤|province|≤max (fusion / vol voisin contigu).
 */
function enforceProvinceSizes(clusters, minSize = MIN_DOMAINS_PER_PROVINCE, maxSize = MAX_DOMAINS_PER_PROVINCE) {
  let list = clusters
    .map((c) => ({ region: c.region, members: c.members.slice() }))
    .filter((c) => c.members.length > 0);

  let guard = 0;
  while (guard++ < 500) {
    let grew = false;
    const next = [];
    for (const c of list) {
      if (c.members.length <= maxSize) {
        next.push(c);
        continue;
      }
      const parts = splitConnectedIntoProvinces(c.members, maxSize, minSize);
      for (const p of parts) next.push({ region: c.region, members: p });
      grew = true;
    }
    list = next;
    if (grew) continue;

    const tinyIdx = list.findIndex((c) => c.members.length > 0 && c.members.length < minSize);
    if (tinyIdx < 0) break;

    const tiny = list[tinyIdx];
    let merged = false;
    for (let j = 0; j < list.length; j++) {
      if (j === tinyIdx) continue;
      if (list[j].members.length + tiny.members.length > maxSize) continue;
      if (!clustersTouch(tiny.members, list[j].members)) continue;
      list[j].members.push(...tiny.members);
      list.splice(tinyIdx, 1);
      merged = true;
      break;
    }
    if (merged) continue;

    let stolen = false;
    for (let j = 0; j < list.length; j++) {
      if (j === tinyIdx) continue;
      if (list[j].members.length <= minSize) continue;
      const donor = list[j];
      const steal = donor.members.find((d) =>
        tiny.members.some((s) => (s.neighbors || []).includes(d.id)),
      );
      if (!steal) continue;
      const remain = donor.members.filter((d) => d.id !== steal.id);
      if (!isConnected(remain)) continue;
      donor.members = remain;
      tiny.members.push(steal);
      stolen = true;
      break;
    }
    if (stolen) continue;

    // 3) Force-merge into any touching province (may exceed max → split next iter)
    let forced = false;
    for (let j = 0; j < list.length; j++) {
      if (j === tinyIdx) continue;
      if (!clustersTouch(tiny.members, list[j].members)) continue;
      list[j].members.push(...tiny.members);
      list.splice(tinyIdx, 1);
      forced = true;
      break;
    }
    if (forced) continue;

    // Isolated singleton — cannot grow while staying contiguous
    tiny._stuck = true;
    if (list.filter((c) => c.members.length < minSize && !c._stuck).length === 0) break;
  }

  return list
    .map(({ region, members }) => ({ region, members }))
    .filter((c) => c.members.length > 0);
}

/** Dernier passage : toute province non connexe est resplitée, puis tailles re-normalisées. */
function repairProvinceConnectivity(clusters, minSize = MIN_DOMAINS_PER_PROVINCE, maxSize = MAX_DOMAINS_PER_PROVINCE) {
  const parts = [];
  for (const c of clusters) {
    for (const comp of connectedComponents(c.members)) {
      if (comp.length <= maxSize) parts.push({ region: c.region, members: comp });
      else {
        for (const p of splitConnectedIntoProvinces(comp, maxSize, minSize)) {
          parts.push({ region: c.region, members: p });
        }
      }
    }
  }
  // Re-enforce sizes once (force-merge tinies); do not recurse repair
  return enforceProvinceSizes(parts, minSize, maxSize).flatMap((c) => {
    // Final connectivity check without re-entering size hell for isolates
    const comps = connectedComponents(c.members);
    if (comps.length === 1) return [c];
    return comps.map((m) => ({ region: c.region, members: m }));
  })
    // En dessous de la taille min mais non vide : un exclave isolé (aucun
    // voisin dans le même royaume) ne peut jamais fusionner — mieux vaut
    // une province à un seul domaine qu'un domaine sans aucune province.
    .filter((c) => c.members.length > 0);
}

/**
 * Régions historiques ~486 (noms anglais) — ordre = priorité dans un royaume.
 * Les domaines d’une même région sont ensuite découpés en provinces contigues ≤6.
 */
const HIST_PROVINCE_ZONES = [
  // —— Suebi ——
  { kingdom: "SUEB", name: "Suebian Kingdom", seed: [-8.2, 42.5], hit: () => true },

  // —— Vandals (Africa) ——
  { kingdom: "VAND", name: "Zeugitana", seed: [10.2, 36.8], hit: (lon, lat) => lon <= 11.2 && lat >= 36.0 },
  { kingdom: "VAND", name: "Byzacena", seed: [10.5, 35.5], hit: (lon, lat) => lon >= 9.5 && lon <= 12.0 && lat < 36.0 },
  { kingdom: "VAND", name: "Numidia", seed: [7.0, 36.2], hit: (lon, lat) => lon < 9.5 },
  { kingdom: "VAND", name: "Tripolitania", seed: [13.0, 32.9], hit: () => true },

  // —— Visigoths (Hispania) ——
  { kingdom: "VISI", name: "Baetica", seed: [-5.0, 37.5], hit: (lon, lat) => lon >= -7.5 && lon <= -1.5 && lat >= 36.0 && lat <= 38.6 },
  { kingdom: "VISI", name: "Lusitania", seed: [-7.5, 39.5], hit: (lon, lat) => lon >= -9.6 && lon <= -5.5 && lat >= 37.5 && lat <= 41.5 },
  { kingdom: "VISI", name: "Carthaginensis", seed: [-1.0, 38.5], hit: (lon, lat) => lon >= -3.5 && lon <= 0.5 && lat >= 36.5 && lat <= 40.2 },
  { kingdom: "VISI", name: "Tarraconensis", seed: [0.5, 41.5], hit: (lon, lat) => lon >= -2.5 && lon <= 3.4 && lat >= 40.0 && lat <= 43.75 },
  { kingdom: "VISI", name: "Celtiberia", seed: [-3.0, 40.5], hit: () => true },

  // —— Kingdom of Aquitaine (Gaulish half of the old Visigothic realm) ——
  { kingdom: "AQUI", name: "Novempopulania", seed: [-0.5, 43.5], hit: (lon, lat) => lon >= -1.9 && lon <= 0.8 && lat >= 42.7 && lat <= 44.8 },
  { kingdom: "AQUI", name: "Aquitania", seed: [0.5, 45.5], hit: (lon, lat) => lon >= -1.9 && lon <= 2.5 && lat >= 44.0 && lat <= 47.35 },
  { kingdom: "AQUI", name: "Narbonensis", seed: [3.0, 43.5], hit: (lon, lat) => lon >= 2.4 && lon <= 5.0 && lat >= 42.4 && lat <= 44.5 },
  { kingdom: "AQUI", name: "Provincia", seed: [5.5, 43.5], hit: (lon, lat) => lon >= 4.5 && lon <= 7.3 && lat >= 42.8 && lat <= 44.85 },

  // —— Baléares / Corsica / Sardinia ——
  { kingdom: "BALE", name: "Balearic Isles", seed: [3.1, 39.85], hit: () => true },
  { kingdom: "CORS", name: "Corsica", seed: [9.2, 42.2], hit: () => true },
  { kingdom: "SARD", name: "Sardinia", seed: [9.0, 39.8], hit: () => true },

  // —— Frisia / Danes ——
  { kingdom: "FRIS", name: "Frisia", seed: [6.0, 53.3], hit: () => true },
  { kingdom: "DANE", name: "Jutland", seed: [9.5, 55.8], hit: () => true },

  // —— Ostrogoths / Italy ——
  // North first (Noricum / Pannonia) so alpine foothills aren’t swallowed by catch-alls
  { kingdom: "OSTG", name: "Noricum Mediterraneum", seed: [14.5, 46.5], hit: (lon, lat) => lon >= 12.0 && lon <= 16.8 && lat >= 45.6 && lat <= 48.0 },
  { kingdom: "OSTG", name: "Pannonia", seed: [17.0, 46.8], hit: (lon, lat) => lon >= 15.8 && lat >= 45.5 && lat <= 48.2 },
  { kingdom: "OSTG", name: "Sicilia", seed: [14.0, 37.5], hit: (lon, lat) => lat < 38.6 && lon >= 12.0 },
  { kingdom: "OSTG", name: "Bruttium", seed: [16.5, 39.0], hit: (lon, lat) => lon >= 15.5 && lat >= 37.5 && lat < 40.5 },
  { kingdom: "OSTG", name: "Apulia", seed: [16.5, 41.0], hit: (lon, lat) => lon >= 15.0 && lat >= 40.3 && lat <= 42.3 },
  { kingdom: "OSTG", name: "Campania", seed: [14.2, 41.0], hit: (lon, lat) => lon >= 12.8 && lon <= 15.2 && lat >= 40.5 && lat <= 41.8 },
  { kingdom: "OSTG", name: "Samnium", seed: [14.5, 42.0], hit: (lon, lat) => lon >= 13.5 && lon <= 15.5 && lat >= 41.5 && lat <= 42.8 },
  { kingdom: "OSTG", name: "Picenum", seed: [13.5, 43.2], hit: (lon, lat) => lon >= 12.5 && lon <= 14.5 && lat >= 42.5 && lat <= 44.0 },
  { kingdom: "OSTG", name: "Tuscia", seed: [11.2, 43.5], hit: (lon, lat) => lon >= 9.8 && lon <= 12.5 && lat >= 42.0 && lat <= 44.2 },
  { kingdom: "OSTG", name: "Umbria", seed: [12.5, 42.8], hit: (lon, lat) => lon >= 11.8 && lon <= 13.2 && lat >= 42.2 && lat <= 43.5 },
  { kingdom: "OSTG", name: "Latium", seed: [12.5, 41.9], hit: (lon, lat) => lon >= 11.8 && lon <= 13.5 && lat >= 41.2 && lat <= 42.5 },
  { kingdom: "OSTG", name: "Aemilia", seed: [11.5, 44.5], hit: (lon, lat) => lon >= 9.5 && lon <= 12.8 && lat >= 44.0 && lat <= 45.2 },
  { kingdom: "OSTG", name: "Liguria", seed: [8.5, 44.5], hit: (lon, lat) => lon >= 7.0 && lon <= 10.0 && lat >= 43.8 && lat <= 45.5 },
  { kingdom: "OSTG", name: "Venetia", seed: [12.5, 45.5], hit: (lon, lat) => lon >= 10.5 && lon <= 14.0 && lat >= 44.8 && lat <= 46.4 },
  { kingdom: "OSTG", name: "Histria", seed: [14.0, 45.2], hit: (lon, lat) => lon >= 13.5 && lon <= 14.8 && lat >= 44.8 && lat <= 45.8 },
  { kingdom: "OSTG", name: "Italia Annonaria", seed: [10.0, 45.2], hit: () => true },

  // —— Burgundians ——
  { kingdom: "BURG", name: "Sapaudia", seed: [6.2, 46.2], hit: (lon, lat) => lon >= 5.5 },
  { kingdom: "BURG", name: "Lugdunensis", seed: [4.8, 45.8], hit: () => true },

  // —— Alemanni ——
  { kingdom: "ALAM", name: "Alsace", seed: [7.6, 48.0], hit: (lon, lat) => lon <= 8.2 },
  { kingdom: "ALAM", name: "Alamannia", seed: [9.2, 48.2], hit: () => true },

  // —— Syagrius ——
  { kingdom: "SYAG", name: "Armorica Minor", seed: [-0.5, 48.5], hit: (lon, lat) => lon < 0.3 },
  { kingdom: "SYAG", name: "Senonia", seed: [2.3, 48.5], hit: (lon, lat) => lon >= 0.3 && lon <= 3.2 && lat <= 49.2 },
  { kingdom: "SYAG", name: "Soissonnais", seed: [3.3, 49.4], hit: (lon, lat) => lat >= 49.0 },
  { kingdom: "SYAG", name: "Aurelianensis", seed: [1.9, 47.9], hit: () => true },

  // —— Franks ——
  { kingdom: "FRAN", name: "Toxandria", seed: [4.5, 51.3], hit: (lon, lat) => lat >= 50.8 && lon <= 6.0 },
  { kingdom: "FRAN", name: "Belgica", seed: [4.0, 50.3], hit: (lon, lat) => lon <= 5.5 && lat >= 49.5 && lat < 50.8 },
  { kingdom: "FRAN", name: "Ripuaria", seed: [6.8, 50.5], hit: (lon, lat) => lon >= 5.5 && lon <= 8.0 && lat >= 49.5 },
  { kingdom: "FRAN", name: "Mosella", seed: [6.3, 49.3], hit: (lon, lat) => lon >= 5.0 && lat < 49.6 },
  { kingdom: "FRAN", name: "Germania Prima", seed: [8.0, 49.5], hit: () => true },

  // —— Anglo-Saxons ——
  { kingdom: "ANGL", name: "Cantium", seed: [1.0, 51.2], hit: (lon, lat) => lon >= 0.2 && lat <= 51.6 },
  { kingdom: "ANGL", name: "East Anglia", seed: [1.2, 52.5], hit: (lon, lat) => lon >= 0.0 && lat >= 51.8 && lat <= 53.2 },
  { kingdom: "ANGL", name: "Lindsey", seed: [0.0, 53.5], hit: (lon, lat) => lat >= 53.0 },
  { kingdom: "ANGL", name: "Saxon Shore", seed: [-0.5, 51.5], hit: () => true },

  // —— Britons ——
  { kingdom: "BRIT", name: "Dumnonia", seed: [-4.0, 50.7], hit: (lon, lat) => lon <= -2.5 && lat <= 51.5 },
  { kingdom: "BRIT", name: "Wales", seed: [-3.5, 52.5], hit: (lon, lat) => lon <= -2.5 && lat >= 51.4 && lat <= 53.5 },
  { kingdom: "BRIT", name: "Hen Ogledd", seed: [-3.0, 55.0], hit: (lon, lat) => lat >= 54.0 },
  { kingdom: "BRIT", name: "Britannia Secunda", seed: [-2.0, 53.0], hit: () => true },

  // —— Bretons ——
  { kingdom: "BRYT", name: "Armorica", seed: [-3.0, 48.2], hit: () => true },

  // —— Saxons ——
  { kingdom: "SAXO", name: "Old Saxony", seed: [9.0, 53.0], hit: () => true },

  // —— Thuringians ——
  { kingdom: "THUR", name: "Kingdom of Thuringia", seed: [11.0, 50.8], hit: () => true },

  // —— Carinthia ——
  { kingdom: "CARN", name: "Noricum Ripense", seed: [14.0, 48.0], hit: (lon, lat) => lat <= 48.6 },
  { kingdom: "CARN", name: "Bohemia", seed: [14.5, 49.8], hit: (lon, lat) => lon >= 13.5 && lat >= 48.8 },
  { kingdom: "CARN", name: "Raetia Secunda", seed: [12.0, 48.2], hit: () => true },
];

function labelHistoricalRegion(d, kingdomCode) {
  const [lon, lat] = domainLonLat(d);
  const zones = HIST_PROVINCE_ZONES.filter((z) => z.kingdom === kingdomCode);
  for (const z of zones) {
    if (z.hit(lon, lat)) return z.name;
  }
  // Nearest seed of this kingdom
  let best = zones[0]?.name || "Province";
  let bestD = Infinity;
  for (const z of zones) {
    const [sx, sy] = z.seed;
    const dx = lon - sx;
    const dy = (lat - sy) * 1.4;
    const dist = dx * dx + dy * dy;
    if (dist < bestD) {
      bestD = dist;
      best = z.name;
    }
  }
  return best;
}

function provinceCodeFromName(name) {
  return name
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 4)
    .toUpperCase()
    .padEnd(4, "X");
}

/**
 * Assignation historique puis découpe contigues 2–6.
 * @returns {{ members: object[], region: string }[]}
 */
function clusterDomainsIntoProvinces(members, kingdomCode) {
  if (members.length === 0) return [];

  const zones = HIST_PROVINCE_ZONES.filter((z) => z.kingdom === kingdomCode);
  if (
    zones.length === 1 &&
    members.length <= MAX_DOMAINS_PER_PROVINCE &&
    isConnected(members)
  ) {
    return [{ members: members.slice(), region: zones[0].name }];
  }

  const byRegion = new Map();
  for (const d of members) {
    const region = labelHistoricalRegion(d, kingdomCode);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(d);
  }

  const out = [];
  for (const [region, group] of byRegion) {
    for (const comp of connectedComponents(group)) {
      const chunks =
        comp.length <= MAX_DOMAINS_PER_PROVINCE
          ? [comp]
          : splitConnectedIntoProvinces(comp, MAX_DOMAINS_PER_PROVINCE, MIN_DOMAINS_PER_PROVINCE);
      for (const chunk of chunks) {
        out.push({ members: chunk, region });
      }
    }
  }

  return repairProvinceConnectivity(
    enforceProvinceSizes(out, MIN_DOMAINS_PER_PROVINCE, MAX_DOMAINS_PER_PROVINCE),
    MIN_DOMAINS_PER_PROVINCE,
    MAX_DOMAINS_PER_PROVINCE,
  );
}

function nameHistoricalProvince(region, partIndex, partCount, members) {
  if (partCount <= 1) {
    return { name: region, code: provinceCodeFromName(region) };
  }
  const rank = { civitas: 0, city: 1, town: 2 };
  let best = members[0];
  let bestR = 99;
  for (const d of members) {
    const c = d.cityId != null ? cities[d.cityId] : null;
    const r = c ? (rank[c.kind] ?? 3) : 4;
    if (r < bestR) {
      bestR = r;
      best = d;
    }
  }
  const city = best.cityId != null ? cities[best.cityId] : null;
  const cityName = city?.name || best.name;
  const name = `${region} (${cityName})`;
  return { name, code: provinceCodeFromName(region) };
}

console.log("Provinces (historical, contiguous, 2–6 domains)…");
const provinces = [];
for (const r of royaumes) {
  const members = r.domaines.map((id) => domaines.find((d) => d.id === id)).filter(Boolean);
  const clusters = clusterDomainsIntoProvinces(members, r.code);
  // Group by region to assign I/II suffixes
  const byRegion = new Map();
  for (const c of clusters) {
    if (!byRegion.has(c.region)) byRegion.set(c.region, []);
    byRegion.get(c.region).push(c);
  }
  const ordered = [];
  for (const [, parts] of byRegion) {
    // Sort parts west→east for stable naming
    parts.sort((a, b) => {
      const ca = a.members.reduce((s, d) => s + domainLonLat(d)[0], 0) / a.members.length;
      const cb = b.members.reduce((s, d) => s + domainLonLat(d)[0], 0) / b.members.length;
      return ca - cb;
    });
    parts.forEach((p, i) => ordered.push({ ...p, partIndex: i, partCount: parts.length }));
  }

  const pids = [];
  for (const cluster of ordered) {
    const pid = provinces.length;
    const { name, code } = nameHistoricalProvince(
      cluster.region,
      cluster.partIndex,
      cluster.partCount,
      cluster.members,
    );
    let sx = 0,
      sy = 0;
    for (const d of cluster.members) {
      const [lon, lat] = domainLonLat(d);
      sx += lon;
      sy += lat;
      d.provinceId = pid;
    }
    const n = cluster.members.length;
    provinces.push({
      id: pid,
      name,
      code,
      royaumeId: r.id,
      centroid: [sx / n, sy / n],
      domaines: cluster.members.map((d) => d.id),
      neighbors: [],
    });
    pids.push(pid);
  }
  r.provinces = pids;
  console.log(`  ${r.name}: ${pids.length} province(s) / ${members.length} domains`);
}

{
  const nb = provinces.map(() => new Set());
  for (const d of domaines) {
    const a = d.provinceId;
    if (a == null) continue;
    for (const n of d.neighbors || []) {
      const b = domaines[n]?.provinceId;
      if (b == null || b === a) continue;
      nb[a].add(b);
      nb[b].add(a);
    }
  }
  for (let i = 0; i < provinces.length; i++) {
    provinces[i].neighbors = [...nb[i]];
  }
}

/** Fusionne des anneaux de domaines → contour extérieur (sans frontières internes). */
function domainRingsToFeature(rings) {
  const polys = [];
  for (const ring of rings || []) {
    if (!ring || ring.length < 3) continue;
    const closed = closeRing(ring.map((p) => [p[0], p[1]]));
    if (closed.length < 4) continue;
    polys.push([closed]);
  }
  if (!polys.length) return null;
  try {
    if (polys.length === 1) return turf.polygon(polys[0]);
    return turf.multiPolygon(polys);
  } catch {
    return null;
  }
}

function featureToExteriorRings(feat) {
  if (!feat?.geometry) return [];
  const g = feat.geometry;
  if (g.type === "Polygon") {
    return [g.coordinates[0].map(([lon, lat]) => [lon, lat])];
  }
  if (g.type === "MultiPolygon") {
    return g.coordinates.map((poly) => poly[0].map(([lon, lat]) => [lon, lat]));
  }
  return [];
}

function dissolveDomainBoundaries(members) {
  let acc = null;
  for (const d of members) {
    const f = domainRingsToFeature(d.boundary);
    if (!f) continue;
    if (!acc) {
      acc = f;
      continue;
    }
    try {
      const u = turf.union(turf.featureCollection([acc, f]));
      if (u) acc = u;
    } catch {
      /* keep acc */
    }
  }
  if (!acc) return members.flatMap((d) => d.boundary || []);
  try {
    acc = turf.simplify(acc, { tolerance: 0.0015, highQuality: true });
  } catch {
    /* ok */
  }
  const rings = featureToExteriorRings(acc);
  return rings.length ? rings : members.flatMap((d) => d.boundary || []);
}

console.log("Dissolving province & kingdom outlines…");
for (const p of provinces) {
  const members = p.domaines.map((id) => domaines.find((d) => d.id === id)).filter(Boolean);
  p.boundary = dissolveDomainBoundaries(members);
}
for (const r of royaumes) {
  const members = r.domaines.map((id) => domaines.find((d) => d.id === id)).filter(Boolean);
  r.boundary = dissolveDomainBoundaries(members);
  console.log(`  outline ${r.name}: ${r.boundary.length} ring(s)`);
}

// ---------------------------------------------------------------------------
// Possessions de facto ~486 — hiérarchie roi → vassal → domaine
// Rois : demesne 2–4 domaines cœur. Vassaux attestés : 2–3 domaines chacun.
// ---------------------------------------------------------------------------
console.log("Possessions (kings + vassals ~486)…");

/**
 * Rois + vassaux / proches documentés (Grégoire, Eugippius, chroniques…).
 * Pas de vassal inventé : si rien d’attesté, tableau vide.
 */
const KING_DEFS = [
  {
    realm: "Kingdom of the Franks",
    realmCode: "FRAN",
    holder: "Clovis",
    title: "King of the Franks",
    code: "CLOV",
    heart: [3.38, 50.61], // Tournai
    count: 2,
    maxKm: 80,
    bounds: { minLat: 50.4 }, // reste au N, laisse Cambrai à Ragnachar
    vassals: [
      // Réguli francs de l’orbite de Clovis (Grégoire) — proches / alliés, pas généraux nommés
      {
        holder: "Sigebert",
        title: "King at Cologne",
        code: "SIGE",
        heart: [6.96, 50.94], // Cologne
        count: 2,
        maxKm: 110,
      },
      {
        holder: "Chararic",
        title: "Frankish king",
        code: "CHAR",
        heart: [2.55, 50.75], // Flandre maritime / Cassel
        count: 2,
        maxKm: 90,
      },
    ],
  },
  // Soissons avant Ragnachar : sinon Cambrai déborde sur le bassin de Soissons
  {
    realm: "Kingdom of Soissons",
    realmCode: "SYAG",
    holder: "Syagrius",
    title: "Rex Romanorum",
    code: "SYAG",
    heart: [3.32, 49.38], // Soissons
    count: 3,
    maxKm: 95,
    bounds: { minLat: 48.4, maxLat: 49.65 },
    vassals: [
      {
        holder: "Paulus",
        title: "Count",
        code: "PAUL",
        heart: [2.35, 48.86], // Paris — sphère de Soissons
        count: 2,
        maxKm: 85,
      },
    ],
  },
  {
    realm: "Kingdom of the Franks",
    realmCode: "FRAN",
    holder: "Ragnachar",
    title: "King at Cambrai",
    code: "RAGN",
    heart: [3.24, 50.18], // Cambrai
    count: 3,
    maxKm: 110,
    bounds: { minLat: 49.65, maxLat: 50.55, minLon: 2.4, maxLon: 4.4 },
    vassals: [
      {
        holder: "Ricchar",
        title: "Brother of Ragnachar",
        code: "RICC",
        heart: [3.05, 50.05], // près Cambrai
        count: 1,
        maxKm: 70,
        bounds: { minLat: 49.65, maxLat: 50.55, minLon: 2.2, maxLon: 4.2 },
      },
      {
        holder: "Farro",
        title: "Companion of Ragnachar",
        code: "FARR",
        heart: [4.0, 50.15], // entre Cambrai et la Meuse
        count: 1,
        maxKm: 90,
        bounds: { minLat: 49.7, maxLat: 50.7, minLon: 3.0, maxLon: 5.2 },
        loose: true,
      },
      {
        holder: "Rignomer",
        title: "King at Le Mans",
        code: "RIGN",
        heart: [0.2, 48.0], // Le Mans
        count: 2,
        maxKm: 100,
        anyRealm: true, // hors zone FRAN (bassin de la Loire)
      },
    ],
  },
  {
    // Toulouse est en Aquitaine (Gaule), pas en Hispania — Alaric II bascule
    // avec son royaume gaulois lors de la scission du royaume wisigoth.
    realm: "Kingdom of Aquitaine",
    realmCode: "AQUI",
    holder: "Alaric II",
    title: "King of the Visigoths",
    code: "ALAR",
    heart: [1.44, 43.6], // Toulouse
    count: 3,
    vassals: [
      // Pas de général nommé ; Anianus = référendaire du Bréviaire (506)
      {
        holder: "Anianus",
        title: "Referendary",
        code: "ANIA",
        heart: [0.6, 43.65], // près Toulouse / Gascogne
        count: 1,
      },
    ],
  },
  {
    // Moitié hispanique du royaume, administrée séparément d'Aquitaine.
    realm: "Visigothic Kingdom",
    realmCode: "VISI",
    holder: "Ebrimund",
    title: "Dux Hispaniarum",
    code: "EBRI",
    heart: [-4.02, 39.86], // Toledo
    count: 3,
  },
  {
    realm: "Kingdom of the Balearics",
    realmCode: "BALE",
    holder: "Nespus",
    title: "King of the Balearics",
    code: "NESP",
    heart: [3.12, 39.85], // Pollentia
    count: 1,
  },
  {
    realm: "Kingdom of Corsica",
    realmCode: "CORS",
    holder: "Marcellinus",
    title: "Count of Corsica",
    code: "MARC",
    heart: [9.5, 42.54], // Mariana
    count: 2,
  },
  {
    realm: "Kingdom of Sardinia",
    realmCode: "SARD",
    holder: "Godas",
    title: "King of Sardinia",
    code: "GODA",
    heart: [9.12, 39.22], // Carales
    count: 2,
  },
  {
    realm: "Frisian Kingdom",
    realmCode: "FRIS",
    holder: "Finn",
    title: "King of the Frisians",
    code: "FINN",
    heart: [6.0, 53.3], // near Ezinge
    count: 2,
  },
  {
    realm: "Kingdom of the Danes",
    realmCode: "DANE",
    holder: "Skjöld",
    title: "King of the Danes",
    code: "SKJO",
    heart: [9.5, 55.5], // Jutland
    count: 2,
  },
  {
    realm: "Kingdom of Burgundy",
    realmCode: "BURG",
    holder: "Gundobad",
    title: "King of the Burgundians",
    code: "GUND",
    heart: [4.84, 45.76], // Lyon
    count: 3,
    vassals: [
      {
        holder: "Aridius",
        title: "Counselor of Gundobad",
        code: "ARID",
        heart: [4.9, 45.55],
        count: 1,
      },
      {
        holder: "Sigismund",
        title: "Son of Gundobad",
        code: "SIGI",
        heart: [5.25, 45.95],
        count: 2,
      },
    ],
  },
  {
    realm: "Kingdom of Burgundy",
    realmCode: "BURG",
    holder: "Godegisel",
    title: "King at Geneva",
    code: "GODE",
    heart: [6.15, 46.2], // Geneva
    count: 2,
    vassals: [], // aucun proche nommé
  },
  {
    realm: "Ostrogothic Kingdom",
    realmCode: "OSTG",
    holder: "Odoacer",
    title: "King at Ravenna",
    code: "ODOA",
    heart: [12.21, 44.42], // Ravenna
    count: 3,
    vassals: [
      {
        holder: "Onoulphus",
        title: "Brother of Odoacer",
        code: "ONOU",
        heart: [9.19, 45.46], // Milan
        count: 2,
      },
      {
        holder: "Tufa",
        title: "Magister militum",
        code: "TUFA",
        heart: [11.0, 45.44], // Verona
        count: 2,
      },
    ],
  },
  {
    realm: "Vandal Kingdom",
    realmCode: "VAND",
    holder: "Gunthamund",
    title: "King of the Vandals",
    code: "GUNT",
    heart: [10.32, 36.85], // Carthage
    count: 3,
    vassals: [
      {
        holder: "Thrasamund",
        title: "Brother of Gunthamund",
        code: "THRA",
        heart: [10.05, 36.7],
        count: 2,
      },
    ],
  },
  {
    realm: "Suebian Kingdom",
    realmCode: "SUEB",
    holder: "Veremund",
    title: "King of the Suebi",
    code: "VERE",
    heart: [-8.42, 41.55], // Braga
    count: 2,
    vassals: [], // période obscure
  },
  {
    realm: "Alemannic Kingdom",
    realmCode: "ALAM",
    holder: "Gibuld",
    title: "King of the Alemanni",
    code: "GIBU",
    heart: [7.75, 48.58], // Strasbourg
    count: 2,
    vassals: [], // seul nom connu (Eugippius)
  },
  {
    realm: "Anglo-Saxon Kingdom",
    realmCode: "ANGL",
    holder: "Aelle",
    title: "King of the South Saxons",
    code: "AELL",
    heart: [-0.15, 50.85], // Sussex
    count: 2,
    vassals: [
      // Fils selon la Chronique anglo-saxonne (tradition)
      {
        holder: "Cissa",
        title: "Son of Aelle",
        code: "CISS",
        heart: [-0.78, 50.83], // Chichester
        count: 1,
      },
      {
        holder: "Cymen",
        title: "Son of Aelle",
        code: "CYME",
        heart: [-0.95, 50.78],
        count: 1,
      },
    ],
  },
  {
    realm: "Kingdom of the Britons",
    realmCode: "BRIT",
    holder: "Ambrosius",
    title: "British leader",
    code: "AMBR",
    heart: [-1.78, 51.18],
    count: 2,
    vassals: [], // aucun général nommé
  },
  {
    realm: "Kingdom of Brittany",
    realmCode: "BRYT",
    holder: "Budic",
    title: "Armorican chief",
    code: "BUDI",
    heart: [-2.76, 47.66],
    count: 2,
    vassals: [],
  },
  {
    realm: "Saxon Kingdom",
    realmCode: "SAXO",
    holder: "Hadugato",
    title: "Saxon chief",
    code: "HADU",
    heart: [8.8, 53.1],
    count: 2,
    vassals: [],
  },
  {
    realm: "Kingdom of Thuringia",
    realmCode: "THUR",
    holder: "Bisinus",
    title: "King of the Thuringians",
    code: "BISI",
    heart: [11.0, 50.98],
    count: 2,
    vassals: [
      {
        holder: "Hermanfrid",
        title: "Son of Bisinus",
        code: "HERM",
        heart: [10.5, 51.05],
        count: 2,
      },
      {
        holder: "Baderic",
        title: "Son of Bisinus",
        code: "BADE",
        heart: [11.6, 50.75],
        count: 1,
      },
    ],
  },
  {
    realm: "Rugii",
    realmCode: "CARN",
    holder: "Feletheus",
    title: "King of the Rugii",
    code: "FELE",
    heart: [16.37, 48.21], // Vindobona / Rugiland (N du Danube)
    count: 2,
    vassals: [
      {
        holder: "Ferderuchus",
        title: "Brother of Feletheus",
        code: "FERD",
        heart: [15.6, 48.35],
        count: 1,
      },
      {
        holder: "Frideric",
        title: "Son of Feletheus",
        code: "FRID",
        heart: [16.1, 48.45],
        count: 2,
      },
    ],
  },
];

// +1 domaine pour chaque roi et chaque vassal
for (const def of KING_DEFS) {
  def.count = (def.count ?? 1) + 1;
  for (const v of def.vassals || []) v.count = (v.count ?? 1) + 1;
}

const realmByCode = new Map(royaumes.map((r) => [r.code, r]));

/** Distance² lon/lat (lat weighted). */
function dist2(lon, lat, hlon, hlat) {
  const dx = lon - hlon;
  const dy = (lat - hlat) * 1.4;
  return dx * dx + dy * dy;
}

/**
 * Demesne : domaine le plus proche du heart + voisins contigus libres.
 */
function pickNear(
  heartLon,
  heartLat,
  count,
  maxKm = 120,
  preferNeighborIds = null,
  preferRoyaumeId = null,
  bounds = null,
) {
  const maxD2 = (maxKm / 85) ** 2;
  const inBounds = (d) => {
    if (!bounds) return true;
    const [lon, lat] = d.centroid;
    if (bounds.minLat != null && lat < bounds.minLat) return false;
    if (bounds.maxLat != null && lat > bounds.maxLat) return false;
    if (bounds.minLon != null && lon < bounds.minLon) return false;
    if (bounds.maxLon != null && lon > bounds.maxLon) return false;
    return true;
  };
  const neighborOfRealm = new Set();
  if (preferNeighborIds && preferNeighborIds.size) {
    for (const id of preferNeighborIds) {
      const d = domaines.find((x) => x.id === id) || domaines[id];
      if (!d) continue;
      for (const nid of d.neighbors || []) {
        if (!preferNeighborIds.has(nid)) neighborOfRealm.add(nid);
      }
    }
  }

  let near = domaines
    .filter((d) => d.possessionId == null)
    .filter((d) =>
      preferRoyaumeId == null ? true : d.royaumeId === preferRoyaumeId,
    )
    .filter(inBounds)
    .filter((d) => dist2(d.centroid[0], d.centroid[1], heartLon, heartLat) <= maxD2);

  // Vassaux : privilégier les domaines collés au territoire déjà tenu
  if (neighborOfRealm.size) {
    const adj = near.filter((d) => neighborOfRealm.has(d.id));
    if (adj.length) near = adj;
  }

  if (near.length >= 1) {
    near.sort(
      (a, b) =>
        dist2(a.centroid[0], a.centroid[1], heartLon, heartLat) -
        dist2(b.centroid[0], b.centroid[1], heartLon, heartLat),
    );
    const seed = near[0];
    const picked = [seed];
    const pickedSet = new Set([seed.id]);
    while (picked.length < count) {
      let best = null;
      let bestD = Infinity;
      for (const d of picked) {
        for (const nid of d.neighbors || []) {
          const o = domaines.find((x) => x.id === nid) || domaines[nid];
          if (!o || o.possessionId != null || pickedSet.has(o.id)) continue;
          if (
            preferRoyaumeId != null &&
            o.royaumeId !== preferRoyaumeId
          ) {
            continue;
          }
          if (!inBounds(o)) continue;
          if (dist2(o.centroid[0], o.centroid[1], heartLon, heartLat) > maxD2) continue;
          const dd = dist2(o.centroid[0], o.centroid[1], heartLon, heartLat);
          if (dd < bestD) {
            bestD = dd;
            best = o;
          }
        }
      }
      if (!best) best = near.find((d) => !pickedSet.has(d.id)) || null;
      if (!best) break;
      picked.push(best);
      pickedSet.add(best.id);
    }
    return picked;
  }
  return pickDemesneRaw(heartLon, heartLat, count, preferRoyaumeId, bounds);
}

function pickDemesneRaw(
  heartLon,
  heartLat,
  count,
  preferRoyaumeId = null,
  bounds = null,
) {
  const inBounds = (d) => {
    if (!bounds) return true;
    const [lon, lat] = d.centroid;
    if (bounds.minLat != null && lat < bounds.minLat) return false;
    if (bounds.maxLat != null && lat > bounds.maxLat) return false;
    if (bounds.minLon != null && lon < bounds.minLon) return false;
    if (bounds.maxLon != null && lon > bounds.maxLon) return false;
    return true;
  };
  const free = domaines.filter(
    (d) =>
      d.possessionId == null &&
      (preferRoyaumeId == null || d.royaumeId === preferRoyaumeId) &&
      inBounds(d),
  );
  if (!free.length) {
    return domaines
      .filter((d) => d.possessionId == null && inBounds(d))
      .sort(
        (a, b) =>
          dist2(a.centroid[0], a.centroid[1], heartLon, heartLat) -
          dist2(b.centroid[0], b.centroid[1], heartLon, heartLat),
      )
      .slice(0, count);
  }
  free.sort(
    (a, b) =>
      dist2(a.centroid[0], a.centroid[1], heartLon, heartLat) -
      dist2(b.centroid[0], b.centroid[1], heartLon, heartLat),
  );
  const seed = free[0];
  const picked = [seed];
  const pickedSet = new Set([seed.id]);
  while (picked.length < count) {
    let best = null;
    let bestD = Infinity;
    for (const d of picked) {
      for (const nid of d.neighbors || []) {
        const o = domaines.find((x) => x.id === nid) || domaines[nid];
        if (!o || o.possessionId != null || pickedSet.has(o.id)) continue;
        if (
          preferRoyaumeId != null &&
          o.royaumeId !== preferRoyaumeId
        ) {
          continue;
        }
        if (!inBounds(o)) continue;
        const dd = dist2(o.centroid[0], o.centroid[1], heartLon, heartLat);
        if (dd < bestD) {
          bestD = dd;
          best = o;
        }
      }
    }
    if (!best) best = free.find((d) => !pickedSet.has(d.id)) || null;
    if (!best) break;
    picked.push(best);
    pickedSet.add(best.id);
  }
  return picked;
}

function makePossession(def, rank, liegeId, realmName, realmCode, preferNeighborIds = null) {
  const realm = realmByCode.get(realmCode);
  const members = pickNear(
    def.heart[0],
    def.heart[1],
    def.count,
    def.maxKm ?? (rank === "king" ? 110 : 100),
    preferNeighborIds,
    def.anyRealm ? null : (realm?.id ?? null),
    def.bounds ?? null,
  );
  if (!members.length) return null;
  const id = nextPossessionId++;
  for (const d of members) d.possessionId = id;
  let sx = 0,
    sy = 0;
  for (const d of members) {
    sx += d.centroid[0];
    sy += d.centroid[1];
  }
  const p = {
    id,
    name: realmName,
    holderName: def.holder,
    title: def.title,
    code: def.code,
    rank,
    liegeId: liegeId ?? undefined,
    vassalIds: [],
    royaumeId: realm?.id,
    centroid: [sx / members.length, sy / members.length],
    domaines: members.map((d) => d.id),
    neighbors: [],
    boundary: dissolveDomainBoundaries(members),
  };
  possessions.push(p);
  return p;
}

const possessions = [];
let nextPossessionId = 0;

// 1) Rois d’abord (évite que les vassaux de Clovis mangent Cambrai / Soissons)
for (const def of KING_DEFS) {
  const king = makePossession(def, "king", null, def.realm, def.realmCode);
  if (!king) {
    console.warn(`  skip ${def.holder}: no free domain near heart`);
    continue;
  }
  def._kingId = king.id;
  console.log(
    `  ${def.holder} → ${def.realm}: ${king.domaines.length} demesne (${king.domaines
      .map((id) => domaines.find((d) => d.id === id)?.name)
      .join(", ")})`,
  );
}

// 2) Vassaux ensuite, collés au demesne royal
for (const def of KING_DEFS) {
  if (def._kingId == null) continue;
  const king = possessions.find((p) => p.id === def._kingId);
  if (!king) continue;
  const realmDomainIds = new Set(king.domaines);
  for (const vdef of def.vassals || []) {
    const vas = makePossession(
      vdef,
      "vassal",
      king.id,
      def.realm,
      def.realmCode,
      vdef.loose ? null : realmDomainIds,
    );
    if (!vas) {
      console.warn(`    skip vassal ${vdef.holder}`);
      continue;
    }
    king.vassalIds.push(vas.id);
    for (const id of vas.domaines) realmDomainIds.add(id);
    console.log(
      `    vassal ${vdef.holder}: ${vas.domaines.length} (${vas.domaines
        .map((id) => domaines.find((d) => d.id === id)?.name)
        .join(", ")})`,
    );
  }
  const realmMembers = [...realmDomainIds]
    .map((id) => domaines.find((d) => d.id === id))
    .filter(Boolean);
  king.boundary = dissolveDomainBoundaries(realmMembers);
  delete def._kingId;
}

const held = domaines.filter((d) => d.possessionId != null).length;
const nKings = possessions.filter((p) => p.rank === "king").length;
const nVassals = possessions.filter((p) => p.rank === "vassal").length;
console.log(`  ${nKings} kings, ${nVassals} vassals; held ${held} / ${domaines.length} domains`);

// ---------------------------------------------------------------------------
// Chefs indépendants — tous les domaines encore libres, paquets de 1–3
// ---------------------------------------------------------------------------
console.log("Independent chiefs…");

/**
 * Noms / titres par culture de realm (~486). Listes assez longues pour ~200 chefs.
 */
const CHIEF_CULTURE = {
  FRAN: {
    title: "Chieftain",
    names: [
      "Chloderic", "Theudomer", "Ragnachar", "Munderic", "Chramn", "Sunnegisil",
      "Aurelianus", "Audovald", "Berthar", "Chlodomer", "Droctulf", "Gararic",
      "Gunthar", "Hagano", "Ingomer", "Leudast", "Merovech", "Ragnvald",
      "Sigivald", "Theudebald", "Waldebert", "Ansbert", "Baudulf", "Childebert",
      "Ebrulf", "Fredegar", "Gundoald", "Hunald", "Landric", "Magnachar",
    ],
  },
  VISI: {
    title: "Warlord",
    names: [
      "Gesalec", "Theudis", "Amalaric", "Agila", "Athanagild", "Liuva",
      "Reccared", "Witteric", "Gundemar", "Sisebut", "Suinthila", "Sisenand",
      "Chindasuinth", "Reccesuinth", "Wamba", "Erwig", "Egica", "Wittiza",
      "Oppas", "Sunifred", "Froila", "Hermenegild", "Reccared", "Segismund",
      "Theodisclus", "Gardingus", "Ildibad", "Totila", "Teia", "Baduila",
    ],
  },
  OSTG: {
    title: "Comes",
    names: [
      "Tufa", "Odoin", "Ibba", "Pitza", "Tuluin", "Widin",
      "Ragnaris", "Usdrilas", "Asbadus", "Indulf", "Ragnaris", "Scipuar",
      "Gibal", "Ragnaris", "Vaccarus", "Cyprianus", "Liberius", "Cassiodorus",
      "Boethius", "Symmachus", "Fidelis", "Avienus", "Opilio", "Decoratus",
      "Agnellus", "Ecclesius", "Ursicinus", "Reparatus", "Vitalis", "Johannes",
    ],
  },
  BURG: {
    title: "Chieftain",
    names: [
      "Godomar", "Chilperic", "Gundobad", "Godegisel", "Sigismund", "Sedeleuba",
      "Caretene", "Willibold", "Hunimund", "Ricimer", "Gundioc", "Chilperic",
      "Gundomar", "Sigeric", "Aunemund", "Lupicinus", "Romanus", "Eugendus",
      "Clotild", "Gundioc", "Hilperic", "Gundoberga", "Williachar", "Magnachar",
    ],
  },
  ALAM: {
    title: "Chieftain",
    names: [
      "Gibuld", "Crocus", "Chnodomar", "Vadomar", "Vithicab", "Hortarius",
      "Urius", "Ursicinus", "Vestralp", "Agilo", "Lentienses", "Macrian",
      "Hariobaud", "Vadomarius", "Gundomad", "Suomar", "Urius", "Agenaric",
    ],
  },
  SYAG: {
    title: "Comes",
    names: [
      "Aegidius", "Paulus", "Arbogast", "Syagrius", "Tetradius", "Lupus",
      "Remigius", "Vedast", "Medard", "Eleutherius", "Genebaud", "Ruricius",
      "Sidonius", "Avitus", "Ecdicius", "Agricola", "Tonantius", "Apollinaris",
      "Namatius", "Consentius", "Thaumastus", "Proculus", "Rusticus", "Volusianus",
    ],
  },
  ANGL: {
    title: "Ealdorman",
    names: [
      "Cissa", "Cymen", "Wlencing", "Port", "Bieda", "Maegla",
      "Stuf", "Wihtgar", "Cerdic", "Cynric", "Ceawlin", "Cutha",
      "Cuthwulf", "Cuthwine", "Ceol", "Ceolwulf", "Penda", "Wulfhere",
      "Aethelric", "Ida", "Glappa", "Adda", "Aethelric", "Theodric",
    ],
  },
  BRIT: {
    title: "Chieftain",
    names: [
      "Vortigern", "Ambrosius", "Uther", "Cuneglas", "Maglocunus", "Constantine",
      "Aurelius", "Vitalinus", "Cunedda", "Einion", "Cadwallon", "Maelgwn",
      "Vortimer", "Catigern", "Pascent", "Faustus", "Riothamus", "Budic",
      "Gradlon", "Conan", "Iudicael", "Judhael", "Hoel", "Alan",
    ],
  },
  BRYT: {
    title: "Chieftain",
    names: [
      "Budic", "Gradlon", "Conan", "Iudicael", "Judhael", "Hoel",
      "Alan", "Nominoe", "Erispoe", "Salomon", "Wrhoc", "Riwal",
      "Deroc", "Canao", "Macliau", "Waroc", "Eusebius", "Melanius",
    ],
  },
  SAXO: {
    title: "Ealdorman",
    names: [
      "Hadugato", "Widukind", "Theoderic", "Hatheburg", "Liudolf", "Bruno",
      "Otto", "Herman", "Billung", "Wichmann", "Ekbert", "Dietrich",
      "Gero", "Markward", "Hesso", "Unwan", "Thietmar", "Bernhard",
    ],
  },
  THUR: {
    title: "Chieftain",
    names: [
      "Bisinus", "Hermanfrid", "Baderic", "Berthar", "Radegund", "Amalafrid",
      "Irminfried", "Balderich", "Fish", "Hathagat", "Theodoric", "Amalaib",
      "Ranild", "Basina", "Childeric", "Clovis", "Theudebert", "Theudebald",
    ],
  },
  SUEB: {
    title: "Warlord",
    names: [
      "Hermeric", "Rechila", "Rechiar", "Aioulf", "Maldras", "Framta",
      "Richimund", "Frumar", "Remismund", "Veremund", "Theodemund", "Chararic",
      "Theodemir", "Miro", "Eboric", "Andeca", "Malaric", "Ariamir",
    ],
  },
  VAND: {
    title: "Warlord",
    names: [
      "Genseric", "Huneric", "Gunthamund", "Thrasamund", "Hilderic", "Gelimer",
      "Tzazo", "Ammatas", "Hoamer", "Euagees", "Gento", "Theudisclus",
      "Godigisel", "Gunderic", "Geiseric", "Thrasaric", "Gibamund", "Hoamer",
    ],
  },
  CARN: {
    title: "Chieftain",
    names: [
      "Feletheus", "Frideric", "Ferderuchus", "Flaccitheus", "Hunimund", "Valamer",
      "Thiudimer", "Vidimer", "Beremud", "Gesimund", "Ardaric", "Elemund",
      "Thurisind", "Cunimund", "Alboin", "Cleph", "Authari", "Agilulf",
    ],
  },
  NONE: {
    title: "Chieftain",
    names: [
      "Maurus", "Severinus", "Boniface", "Julianus", "Marcellinus", "Prosper",
      "Cassius", "Felix", "Donatus", "Cyprianus", "Optatus", "Victor",
      "Quodvultdeus", "Fulgentius", "Facundus", "Primasius", "Liberatus", "Ferrandus",
    ],
  },
};

function chiefCultureForDomain(d) {
  const realm = d.royaumeId != null ? royaumes.find((r) => r.id === d.royaumeId) : null;
  const code = realm?.code || "NONE";
  return CHIEF_CULTURE[code] || CHIEF_CULTURE.NONE;
}

function pickChiefHolding(seed, targetCount) {
  const picked = [seed];
  const pickedSet = new Set([seed.id]);
  while (picked.length < targetCount) {
    let best = null;
    let bestD = Infinity;
    const [slon, slat] = seed.centroid;
    for (const d of picked) {
      for (const nid of d.neighbors || []) {
        const o = domaines.find((x) => x.id === nid) || domaines[nid];
        if (!o || o.possessionId != null || pickedSet.has(o.id)) continue;
        // Rester dans le même realm de jure si possible
        if (seed.royaumeId != null && o.royaumeId !== seed.royaumeId) continue;
        const dd = dist2(o.centroid[0], o.centroid[1], slon, slat);
        if (dd < bestD) {
          bestD = dd;
          best = o;
        }
      }
    }
    // Relâche la contrainte de realm si besoin
    if (!best) {
      for (const d of picked) {
        for (const nid of d.neighbors || []) {
          const o = domaines.find((x) => x.id === nid) || domaines[nid];
          if (!o || o.possessionId != null || pickedSet.has(o.id)) continue;
          const dd = dist2(o.centroid[0], o.centroid[1], slon, slat);
          if (dd < bestD) {
            bestD = dd;
            best = o;
          }
        }
      }
    }
    if (!best) break;
    picked.push(best);
    pickedSet.add(best.id);
  }
  return picked;
}

{
  let nameCursor = Object.fromEntries(
    Object.keys(CHIEF_CULTURE).map((k) => [k, 0]),
  );
  let nChiefs = 0;
  let guard = 0;
  while (guard++ < domaines.length + 10) {
    const free = domaines.filter((d) => d.possessionId == null);
    if (!free.length) break;
    // Seed stable : plus à l’ouest puis au sud (parcours déterministe)
    free.sort(
      (a, b) =>
        a.centroid[0] - b.centroid[0] ||
        a.centroid[1] - b.centroid[1] ||
        a.id - b.id,
    );
    const seed = free[0];
    const target = 1 + (seed.id % 3); // 1, 2 ou 3
    const members = pickChiefHolding(seed, target);
    const culture = chiefCultureForDomain(seed);
    const realm = seed.royaumeId != null ? royaumes.find((r) => r.id === seed.royaumeId) : null;
    const codeKey = realm?.code || "NONE";
    const idx = nameCursor[codeKey] || 0;
    nameCursor[codeKey] = idx + 1;
    const baseName = culture.names[idx % culture.names.length];
    const cycle = Math.floor(idx / culture.names.length);
    const holderName = cycle === 0 ? baseName : `${baseName} ${cycle + 1}`;

    const id = nextPossessionId++;
    for (const d of members) d.possessionId = id;
    let sx = 0,
      sy = 0;
    for (const d of members) {
      sx += d.centroid[0];
      sy += d.centroid[1];
    }
    possessions.push({
      id,
      name: realm?.name || "Independent",
      holderName,
      title: culture.title,
      code: `CHF${String(id).padStart(3, "0")}`,
      rank: "chief",
      vassalIds: [],
      royaumeId: realm?.id,
      centroid: [sx / members.length, sy / members.length],
      domaines: members.map((d) => d.id),
      neighbors: [],
      boundary: dissolveDomainBoundaries(members),
    });
    nChiefs++;
  }
  const heldAfter = domaines.filter((d) => d.possessionId != null).length;
  console.log(
    `  ${nChiefs} chiefs; held ${heldAfter} / ${domaines.length} domains (all allocated)`,
  );
}

// Voisins entre possessions (demesne + vassaux qui se touchent)
{
  const byId = new Map(possessions.map((p) => [p.id, p]));
  const nb = possessions.map(() => new Set());
  const controllers = (possessionId) => {
    const out = [possessionId];
    const p = byId.get(possessionId);
    if (p?.liegeId != null) out.push(p.liegeId);
    return out;
  };
  for (const d of domaines) {
    if (d.possessionId == null) continue;
    const aHolders = controllers(d.possessionId);
    for (const nid of d.neighbors || []) {
      const o = domaines.find((x) => x.id === nid) || domaines[nid];
      if (!o || o.possessionId == null || o.possessionId === d.possessionId) continue;
      const bHolders = controllers(o.possessionId);
      for (const a of aHolders) {
        for (const b of bHolders) {
          if (a === b) continue;
          nb[a].add(b);
          nb[b].add(a);
        }
      }
    }
  }
  for (let i = 0; i < possessions.length; i++) possessions[i].neighbors = [...nb[i]];
}

// ---------------------------------------------------------------------------
// Terrains — types de sol / végétation (indépendant des royaumes)
// ---------------------------------------------------------------------------
console.log("Terrains…");

const TERRAIN_META = {
  mountains: { name: "Mountains", code: "MNT" },
  hills: { name: "Hills", code: "HIL" },
  forest: { name: "Forest", code: "FOR" },
  farmland: { name: "Farmland", code: "FRM" },
  plains: { name: "Plains", code: "PLN" },
  marsh: { name: "Marsh", code: "MRS" },
  desert: { name: "Desert", code: "DST" },
  scrub: { name: "Scrub", code: "SCR" },
  coast: { name: "Coast", code: "CST" },
};

/** Grille de proximité rivières */
const RIVER_CELL = 0.12;
const riverCells = new Set();
for (const line of riverLines) {
  for (const pt of line) {
    if (!pt || pt.length < 2) continue;
    const [lon, lat] = pt;
    riverCells.add(`${Math.floor(lon / RIVER_CELL)},${Math.floor(lat / RIVER_CELL)}`);
  }
}
function nearRiver(lon, lat) {
  const cx = Math.floor(lon / RIVER_CELL);
  const cy = Math.floor(lat / RIVER_CELL);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (riverCells.has(`${cx + dx},${cy + dy}`)) return true;
    }
  }
  return false;
}

let mtnFeatTerrain = null;
if (impassable.length) {
  try {
    mtnFeatTerrain =
      impassable.length === 1
        ? turf.polygon([impassable[0]])
        : turf.multiPolygon(impassable.map((r) => [r]));
  } catch {
    mtnFeatTerrain = null;
  }
}
function inMassif(lon, lat) {
  if (!mtnFeatTerrain) return false;
  try {
    return turf.booleanPointInPolygon(turf.point([lon, lat]), mtnFeatTerrain);
  } catch {
    return false;
  }
}

function isCoastal(lon, lat) {
  // Façades maritimes approximatives (basse altitude traitée ailleurs)
  if (lat > 50.5 && lon > -1.5 && lon < 8.5) return true; // Mer du Nord / Manche E
  if (lat > 48.2 && lat < 51.2 && lon > -5.5 && lon < 2.2) return true; // Manche
  if (lat > 42.2 && lat < 44.8 && lon > 3.0 && lon < 9.8) return true; // Méditerranée N
  if (lat > 36.5 && lat < 38.5 && lon > -1.5 && lon < 12) return true; // Méditerranée S / Afrique
  if (lat > 35.8 && lat < 43.5 && lon > -9.8 && lon < -8.2) return true; // Atlantique ibérique
  if (lat > 36.0 && lat < 43.8 && lon > -9.5 && lon < -5.5 && lat < 38.2) return true;
  return false;
}

function isDesert(lon, lat) {
  // Afrique du Nord intérieure / semi-aride
  if (lat <= 36.2 && lon >= -2.0 && lon <= 12.0) return true;
  if (lat <= 37.0 && lon >= 8.0 && lon <= 12.5) return true;
  return false;
}

function isScrub(lon, lat, elev) {
  // Meseta ibérique, arrière-pays méditerranéen sec
  if (lon >= -6.5 && lon <= -1.0 && lat >= 38.0 && lat <= 41.8 && elev >= 350 && elev < 1100)
    return true;
  if (lon >= -1.5 && lon <= 3.5 && lat >= 36.8 && lat <= 38.8 && elev < 600) return true; // SE Espagne
  if (lon >= 12.5 && lon <= 15.5 && lat >= 36.8 && lat <= 38.2) return true; // Sicile intérieure
  if (lon >= 8.5 && lon <= 9.8 && lat >= 39.2 && lat <= 40.5) return true; // Sardaigne
  return false;
}

function isFarmland(lon, lat, elev) {
  if (elev > 450) return false;
  // Bassin parisien / Soissons
  if (lon >= 0.5 && lon <= 4.5 && lat >= 47.5 && lat <= 50.0) return true;
  // Vallée du Pô
  if (lon >= 7.5 && lon <= 13.5 && lat >= 44.5 && lat <= 46.2) return true;
  // Aquitaine / Garonne
  if (lon >= -1.5 && lon <= 1.5 && lat >= 43.2 && lat <= 45.5) return true;
  // Vallée du Rhône bas
  if (lon >= 4.3 && lon <= 5.2 && lat >= 43.5 && lat <= 45.5) return true;
  // Plaine du Rhin
  if (lon >= 7.4 && lon <= 8.6 && lat >= 47.8 && lat <= 50.5) return true;
  // Guadalquivir / Andalousie
  if (lon >= -6.5 && lon <= -4.5 && lat >= 36.5 && lat <= 38.0) return true;
  // Tunisie / Cap Bon fertile
  if (lon >= 9.5 && lon <= 11.2 && lat >= 36.3 && lat <= 37.3) return true;
  // Campanie / Latium
  if (lon >= 12.0 && lon <= 14.5 && lat >= 40.8 && lat <= 42.2) return true;
  // Flandre intérieure (hors marais strict)
  if (lon >= 2.5 && lon <= 5.0 && lat >= 50.2 && lat <= 51.2 && elev > 20) return true;
  return false;
}

function isMarshZone(lon, lat, elev) {
  if (elev > 120) return false;
  // Camargue / delta Rhône
  if (lon >= 4.2 && lon <= 5.0 && lat >= 43.3 && lat <= 43.7) return true;
  // Po delta / Veneto bas
  if (lon >= 11.8 && lon <= 13.0 && lat >= 44.7 && lat <= 45.6) return true;
  // Flandre / bas pays
  if (lon >= 2.2 && lon <= 5.5 && lat >= 50.8 && lat <= 51.8 && elev < 40) return true;
  // Estuaire Gironde
  if (lon >= -1.3 && lon <= -0.5 && lat >= 44.8 && lat <= 45.6 && elev < 50) return true;
  // Norfolk / Wash-ish
  if (lon >= -0.5 && lon <= 1.5 && lat >= 52.4 && lat <= 53.2 && elev < 40) return true;
  return false;
}

function classifyTerrain(lon, lat, elev) {
  if (isDesert(lon, lat)) return "desert";
  if (inMassif(lon, lat) || elev >= 1100) return "mountains";
  if (elev >= 550) return "hills";
  if (isMarshZone(lon, lat, elev) || (elev < 45 && nearRiver(lon, lat) && lat > 42))
    return "marsh";
  if (isScrub(lon, lat, elev)) return "scrub";
  if (isFarmland(lon, lat, elev)) return "farmland";
  if (elev < 55 && isCoastal(lon, lat)) return "coast";
  // Europe tempérée : forêt par défaut ; plaines ouvertes plus sèches / plus bas
  if (elev < 180 && lat < 44 && lon > -5 && lon < 4 && !isFarmland(lon, lat, elev))
    return "plains";
  if (elev < 120 && lon > 10 && lat > 47 && lat < 50) return "plains"; // Pannonie edge
  return "forest";
}

const terrainCounts = {};
for (const d of domaines) {
  const [lon, lat] = d.centroid;
  let elev = elevAt(lon, lat);
  if (!Number.isFinite(elev)) elev = 0;
  // Moyenne légère avec voisins du centroïde
  let e2 = elevAt(lon + 0.05, lat);
  let e3 = elevAt(lon, lat + 0.05);
  if (Number.isFinite(e2) && Number.isFinite(e3)) elev = (elev + e2 + e3) / 3;
  d.avgElevation = Math.round(elev);
  d.terrainType = classifyTerrain(lon, lat, elev);
  terrainCounts[d.terrainType] = (terrainCounts[d.terrainType] || 0) + 1;
}
console.log(
  "  " +
    Object.entries(terrainCounts)
      .map(([k, n]) => `${k}:${n}`)
      .join(" | "),
);

/** Une entrée Terrain par type (tous les domaines de ce type). */
const terrains = [];
let nextTerrainId = 0;
const byType = new Map();
for (const d of domaines) {
  if (!byType.has(d.terrainType)) byType.set(d.terrainType, []);
  byType.get(d.terrainType).push(d);
}

for (const [type, members] of byType) {
  const meta = TERRAIN_META[type];
  if (!meta || !members.length) continue;
  const id = nextTerrainId++;
  for (const d of members) d.terrainId = id;
  let sx = 0,
    sy = 0;
  for (const d of members) {
    sx += d.centroid[0];
    sy += d.centroid[1];
  }
  terrains.push({
    id,
    name: meta.name,
    code: meta.code,
    terrainType: type,
    centroid: [sx / members.length, sy / members.length],
    domaines: members.map((d) => d.id),
    neighbors: [],
    boundary: dissolveDomainBoundaries(members),
  });
  console.log(`  ${meta.name}: ${members.length} domains, ${terrains[terrains.length - 1].boundary.length} ring(s)`);
}

// Voisins terrains (types adjacents)
{
  const nb = terrains.map(() => new Set());
  for (const d of domaines) {
    if (d.terrainId == null) continue;
    for (const nid of d.neighbors || []) {
      const o = domaines.find((x) => x.id === nid) || domaines[nid];
      if (!o || o.terrainId == null || o.terrainId === d.terrainId) continue;
      nb[d.terrainId].add(o.terrainId);
    }
  }
  for (let i = 0; i < terrains.length; i++) terrains[i].neighbors = [...nb[i]];
}

// ---------------------------------------------------------------------------
// Progression économique / techno (0–100) — foyers culturels urbains ~486
// ---------------------------------------------------------------------------
console.log("Economy / development…");

/**
 * Foyers culturels / urbains de l’époque (capitale, civitas majeures, sièges).
 * score = intensité locale (0–100).
 */
const CULTURE_HUBS = [
  // Italie — cœur romain / ostrogoth
  { name: "Roma", lon: 12.48, lat: 41.89, score: 98 },
  { name: "Ravenna", lon: 12.21, lat: 44.42, score: 94 },
  { name: "Mediolanum", lon: 9.19, lat: 45.46, score: 88 },
  { name: "Neapolis", lon: 14.25, lat: 40.85, score: 82 },
  { name: "Syracusae", lon: 15.29, lat: 37.07, score: 78 },
  { name: "Aquileia", lon: 13.37, lat: 45.77, score: 76 },
  { name: "Capua", lon: 14.22, lat: 41.11, score: 74 },
  // Afrique — Vandales
  { name: "Carthago", lon: 10.32, lat: 36.85, score: 90 },
  { name: "Hippo Regius", lon: 7.75, lat: 36.9, score: 72 },
  // Gaule — romanité persistante
  { name: "Lugdunum", lon: 4.84, lat: 45.76, score: 80 },
  { name: "Arelate", lon: 4.63, lat: 43.68, score: 78 },
  { name: "Massalia", lon: 5.37, lat: 43.3, score: 76 },
  { name: "Tolosa", lon: 1.44, lat: 43.6, score: 74 },
  { name: "Burdigala", lon: -0.58, lat: 44.84, score: 72 },
  { name: "Narbo", lon: 3.0, lat: 43.18, score: 70 },
  { name: "Treverorum", lon: 6.64, lat: 49.76, score: 70 },
  { name: "Lutetia", lon: 2.35, lat: 48.86, score: 62 },
  { name: "Soissons", lon: 3.32, lat: 49.38, score: 58 },
  // Hispania
  { name: "Toletum", lon: -4.02, lat: 39.86, score: 72 },
  { name: "Corduba", lon: -4.78, lat: 37.89, score: 74 },
  { name: "Hispalis", lon: -5.99, lat: 37.39, score: 70 },
  { name: "Emerita", lon: -6.34, lat: 38.92, score: 68 },
  { name: "Caesaraugusta", lon: -0.88, lat: 41.65, score: 66 },
  { name: "Barcino", lon: 2.17, lat: 41.39, score: 64 },
  { name: "Bracara", lon: -8.42, lat: 41.55, score: 55 },
  // Bretagne / Germanie — plus bas
  { name: "Londinium", lon: -0.13, lat: 51.51, score: 52 },
  { name: "Eboracum", lon: -1.08, lat: 53.96, score: 48 },
  { name: "Colonia Agrippina", lon: 6.96, lat: 50.94, score: 55 },
];

const TERRAIN_DEV_MOD = {
  farmland: 8,
  coast: 5,
  plains: 2,
  scrub: -2,
  forest: -6,
  hills: -4,
  marsh: -8,
  mountains: -14,
  desert: -10,
};

function cultureInfluence(lon, lat) {
  let best = 0;
  for (const h of CULTURE_HUBS) {
    const dx = (lon - h.lon) * 85;
    const dy = (lat - h.lat) * 111;
    const km = Math.sqrt(dx * dx + dy * dy);
    // Influence décroît : pleine force à 0 km, ~0 à 280 km
    const fall = Math.max(0, 1 - km / 280);
    const v = h.score * fall * fall; // décroissance douce
    if (v > best) best = v;
  }
  return best;
}

let devMin = 100,
  devMax = 0,
  devSum = 0;
for (const d of domaines) {
  const [lon, lat] = d.centroid;
  let score = cultureInfluence(lon, lat);

  // Bonus urbain (kind de la ville seed)
  const city = d.cityId != null ? cities[d.cityId] : null;
  if (city) {
    if (city.kind === "civitas") score += 10;
    else if (city.kind === "city") score += 6;
    else score += 2;
  } else {
    score -= 5;
  }

  // Terrain
  score += TERRAIN_DEV_MOD[d.terrainType] || 0;

  // Germanie / Calédonie / zones périphériques
  if (lat > 52 && lon > 6) score -= 12; // Saxe / nord
  if (lat > 54) score -= 8;
  if (lon < -6 && lat > 50) score -= 10; // ouest Bretagne sauvage
  if (lat > 46 && lon > 9 && lon < 14 && lat < 49 && d.avgElevation > 500) score -= 6;

  score = Math.max(0, Math.min(100, Math.round(score)));
  d.development = score;
  devMin = Math.min(devMin, score);
  devMax = Math.max(devMax, score);
  devSum += score;
}
console.log(
  `  development ${devMin}–${devMax} (avg ${Math.round(devSum / domaines.length)})`,
);

// ---------------------------------------------------------------------------
// Population & levées — terrain + développement → habitants → 10 % levée
// ---------------------------------------------------------------------------
console.log("Population / levies…");

/**
 * Densité de peuplement de base (hab/km²) vers ~486, après contraction post-romaine.
 * Les « domaines » sont de grands hinterlands (souvent 2–8k km²) : on ne peut pas
 * coller des densités de cœur agricole moderne sur toute la cellule.
 * Ordres de grandeur : Gaule / Hispanie / Italie du Nord sparsément peuplées ;
 * une civitas riche ≈ quelques milliers à ~15k âmes sur tout le hinterland,
 * pas 80k (chiffre digne d’une métropole haut Moyen Âge / moderne).
 */
const TERRAIN_POP_DENSITY = {
  farmland: 5,
  coast: 4,
  plains: 3.2,
  hills: 2,
  forest: 0.8,
  scrub: 0.8,
  marsh: 0.5,
  mountains: 0.25,
  desert: 0.1,
};

/**
 * Levée de campagne mobilisable ≈ 2 % de la population.
 * Les armées de terrain ~Ve–VIe s. se comptent plutôt en milliers (Delbrück / consensus
 * actuel), pas en dizaines de % ; un Heerbann total est rare et peu durable.
 */
const LEVY_RATE = 0.02;

/**
 * Multiplicateur économique : développement 0 → habitat très clairsemé,
 * 100 → hinterland de civitas encore peuplé.
 *   f(d) = 0.32 + 0.68 × (d/100)^1.1
 */
function developmentPopFactor(dev) {
  const t = Math.max(0, Math.min(100, dev ?? 0)) / 100;
  return 0.32 + 0.68 * Math.pow(t, 1.1);
}

/**
 * Aire utile : plein rendement jusqu’à ~1400 km², puis log
 * (sinon les grands polygones farmland gonflent à des populations absurdes).
 */
function effectivePopArea(areaKm2) {
  const soft = 1400;
  if (areaKm2 <= soft) return areaKm2;
  return soft + soft * Math.log1p((areaKm2 - soft) / soft);
}

function domainAreaKm2(d) {
  const feat = domainRingsToFeature(d.boundary);
  if (!feat) return 0;
  try {
    return turf.area(feat) / 1e6;
  } catch {
    return 0;
  }
}

let popSum = 0;
let levySum = 0;
let areaSum = 0;
for (const d of domaines) {
  const areaKm2 = domainAreaKm2(d);
  const density = TERRAIN_POP_DENSITY[d.terrainType] ?? 10;
  const factor = developmentPopFactor(d.development);
  // population = aire_efficace × densité(terrain) × f(richesse)
  const population = Math.max(
    200,
    Math.round(effectivePopArea(areaKm2) * density * factor),
  );
  const levies = Math.round(population * LEVY_RATE);
  d.areaKm2 = Math.round(areaKm2 * 10) / 10;
  d.population = population;
  d.levies = levies;
  popSum += population;
  levySum += levies;
  areaSum += areaKm2;
}
console.log(
  `  pop ${popSum.toLocaleString()} (avg ${Math.round(popSum / domaines.length)}/domain) · levies ${levySum.toLocaleString()} @ ${LEVY_RATE * 100}% · land ${(areaSum / 1000).toFixed(0)}k km²`,
);

// ---------------------------------------------------------------------------
// Revenu mensuel (or) — development + population
// ---------------------------------------------------------------------------
console.log("Domain income…");
let incomeSum = 0;
let incomeMin = Infinity;
let incomeMax = 0;
for (const d of domaines) {
  const dev = Math.max(0, Math.min(100, d.development ?? 0));
  const pop = Math.max(0, d.population ?? 0);
  const income = Math.max(0.1, Math.round(dev * 0.4 + (pop / 350) * (0.45 + dev / 200)) / 10);
  d.income = income;
  incomeSum += income;
  incomeMin = Math.min(incomeMin, income);
  incomeMax = Math.max(incomeMax, income);
}
console.log(
  `  income ${incomeMin}–${incomeMax}/mo (avg ${Math.round(incomeSum / domaines.length)}, total ${incomeSum.toLocaleString()})`,
);

// ---------------------------------------------------------------------------
// Zones maritimes — mers navigables (mouvement naval, revendications outre-mer).
// Générées après tout le reste : jamais vues par les boucles royaume/possession/
// développement/population ci-dessus (elles restent neutres, sans royaumeId,
// provinceId ni possessionId, et sans économie).
// ---------------------------------------------------------------------------
console.log("Sea zones…");

/** Mers historiques — même schéma que KINGDOM_ZONES (première zone qui matche gagne). */
const SEA_ZONES = [
  {
    name: "Oceanus Britannicus",
    code: "OCBR",
    hit: (lon, lat) => lon >= -5.5 && lon <= 2.2 && lat >= 48.2 && lat <= 51.2,
  },
  {
    name: "Mare Germanicum",
    code: "GERM",
    hit: (lon, lat) => lat >= 50.5 && lon >= -1.5 && lon <= 12.8,
  },
  {
    name: "Sinus Aquitanicus",
    code: "AQUI",
    hit: (lon, lat) => lon >= -5.5 && lon <= -1.0 && lat >= 43.0 && lat < 48.2,
  },
  {
    name: "Oceanus Cantabricus",
    code: "CANT",
    hit: (lon, lat) => lon < -5.5 && lat >= 35.8 && lat <= 46.0,
  },
  {
    name: "Mare Ligusticum",
    code: "LIGU",
    hit: (lon, lat) => lon >= 5.0 && lon <= 9.5 && lat >= 42.5 && lat <= 44.8,
  },
  {
    name: "Mare Tyrrhenum",
    code: "TYRR",
    hit: (lon, lat) => lon >= 8.0 && lon <= 15.5 && lat > 37.5 && lat <= 43.0,
  },
  {
    name: "Mare Hadriaticum",
    code: "HADR",
    hit: (lon, lat) => lon >= 12.0 && lat > 37.5 && lat <= 46.0,
  },
  {
    name: "Mare Africum",
    code: "AFRI",
    hit: (lon, lat) => lat <= 37.5,
  },
  {
    // Catch-all : golfe de Gascogne sud / côte ibéro-provençale.
    name: "Mare Balearicum",
    code: "BALE",
    hit: () => true,
  },
];

function labelSea(lon, lat) {
  for (const z of SEA_ZONES) {
    if (z.hit(lon, lat)) return z;
  }
  return SEA_ZONES[SEA_ZONES.length - 1];
}

/**
 * La mer est générée contre le contour RÉEL des 486 domaines terrestres déjà
 * produits (union de leurs polygones), pas contre le littoral vectoriel lisse
 * (`landMask`) : les domaines terrestres approximent déjà ce littoral avec
 * leur propre raster (bords en marches d'escalier, jamais lissés), à un
 * endroit légèrement différent de celui qu'une approximation indépendante
 * de la même côte donnerait. Mer et terre utilisant le même `BBOX` et le
 * même pas de grille (0.034°) plus bas, caler la mer sur ce contour réel
 * aligne les deux rasters cellule à cellule — plus de décalage en dents de
 * scie à la jonction terre/mer.
 */
console.log("  fusion des domaines terrestres pour caler la côte maritime…");
const landDomainsUnion = dissolveDomainBoundaries(domaines);
const landDomainsFeature = domainRingsToFeature(landDomainsUnion) ?? landMask;

/** Bande d'eau navigable : eau à moins de ~220 km de la côte (pas l'océan ouvert entier). */
const waterMask = turf.difference(turf.featureCollection([bboxPoly, landDomainsFeature]));
let coastalWaterMask = waterMask;
try {
  const bufferedLand = turf.buffer(landDomainsFeature, 220, { units: "kilometers" });
  const nearCoast = turf.intersect(turf.featureCollection([bufferedLand, waterMask]));
  if (nearCoast) coastalWaterMask = nearCoast;
} catch (e) {
  console.warn("  sea buffer failed, falling back to full water mask:", e.message);
}

/** Graines maritimes : grille ~110 km, propriétés minimales attendues par partitionDomainsFromCities. */
const seaSeedGrid = turf.pointGrid(
  [BBOX.lonMin, BBOX.latMin, BBOX.lonMax, BBOX.latMax],
  110,
  { mask: coastalWaterMask, units: "kilometers" },
);
const seaSeeds = seaSeedGrid.features.map((f, i) => {
  const [lon, lat] = f.geometry.coordinates;
  return { id: i, name: labelSea(lon, lat).name, lon, lat };
});
console.log(`  ${seaSeeds.length} graines maritimes`);

// Cellules brutes (raster, angles droits) — JAMAIS lissées individuellement :
// lisser chaque cellule séparément (chaïkin) fait diverger deux voisines le
// long de leur bord commun (l'arrondi dépend de l'ordre des sommets propre
// à chaque anneau), ce qui recrée un liseré en dents de scie à l'échelle de
// la côte entière — pire que sans lissage. On les garde brutes, exactement
// comme les domaines terrestres (`d.rings` directement, jamais post-traités
// non plus) — au même pas que la terre (0.034°), le cran d'escalier de la
// mer reste du même ordre que celui, déjà accepté, des domaines terrestres.
const { domains: rawSeaCells } = partitionDomainsFromCities({
  bbox: BBOX,
  cities: seaSeeds,
  landMask: coastalWaterMask,
  impassableRings: [],
  stepDeg: 0.034,
});
const rawSeaWithZone = rawSeaCells.map((d) => ({ ...d, zoneName: labelSea(d.centroid[0], d.centroid[1]).name }));

// Une mer nommée regroupe plusieurs cellules distinctes — chacune reste un
// domaine à part entière (« un peu plus grand qu'un domaine terrestre »,
// pas un unique bassin géant) : on peut y stationner/déplacer des armées
// cellule par cellule, comme sur terre.
const seaIdOffset = domaines.length;
const seaDomaines = rawSeaWithZone.map((d, i) => ({
  id: seaIdOffset + i,
  code: null,
  name: d.zoneName,
  cityId: null,
  centroid: d.centroid,
  avgElevation: 0,
  development: 0,
  population: 0,
  levies: 0,
  income: 0,
  areaKm2: Math.round((domainAreaKm2({ boundary: d.rings }) || 0) * 10) / 10,
  terrainType: "sea",
  boundary: d.rings,
  neighbors: (d.neighbors || []).map((n) => seaIdOffset + n),
}));
console.log(`  ${seaDomaines.length} domaines maritimes`);

// Rattache chaque côte à la/les mer(s) nommée(s) qu'elle touche (test
// géométrique — deux maillages indépendants, pas de correspondance directe
// via un index de cellule commun). Léger buffer côté mer pour absorber les
// écarts de discrétisation entre les deux rasters.
console.log("Linking coasts to sea zones…");
const seaTouchFeatures = seaDomaines
  .map((d) => {
    const feat = domainRingsToFeature(d.boundary);
    if (!feat) return null;
    let buffered = feat;
    try {
      buffered = turf.buffer(feat, 4, { units: "kilometers" });
    } catch {
      /* garde le contour non bufferisé */
    }
    return { d, feat: buffered, bbox: turf.bbox(buffered) };
  })
  .filter(Boolean);
let coastLinks = 0;
for (const land of domaines) {
  const landFeat = domainRingsToFeature(land.boundary);
  if (!landFeat) continue;
  const [lMinX, lMinY, lMaxX, lMaxY] = turf.bbox(landFeat);
  for (const { d: sea, feat: seaFeat, bbox } of seaTouchFeatures) {
    if (lMaxX < bbox[0] || lMinX > bbox[2] || lMaxY < bbox[1] || lMinY > bbox[3]) continue;
    let touches = false;
    try {
      touches = turf.booleanIntersects(landFeat, seaFeat);
    } catch {
      touches = false;
    }
    if (!touches) continue;
    if (!land.neighbors.includes(sea.id)) land.neighbors.push(sea.id);
    if (!sea.neighbors.includes(land.id)) sea.neighbors.push(land.id);
    coastLinks++;
  }
}
console.log(`  ${coastLinks} coast↔sea links`);

// Chaque mer nommée devient aussi sa propre entrée `terrains` (même schéma
// que les types terrestres — contour fusionné de toutes ses cellules) :
// cliquable/labellisable via le même pipeline Terrain existant, sans mêler
// les 9 mers en un seul blob générique de type "sea".
const seaByZoneName = new Map();
for (const d of seaDomaines) {
  if (!seaByZoneName.has(d.name)) seaByZoneName.set(d.name, []);
  seaByZoneName.get(d.name).push(d);
}
for (const [zoneName, members] of seaByZoneName) {
  const zone = SEA_ZONES.find((z) => z.name === zoneName);
  const id = nextTerrainId++;
  for (const d of members) d.terrainId = id;
  let sx = 0,
    sy = 0;
  for (const d of members) {
    sx += d.centroid[0];
    sy += d.centroid[1];
  }
  terrains.push({
    id,
    name: zoneName,
    code: zone?.code ?? zoneName.slice(0, 4).toUpperCase(),
    terrainType: "sea",
    centroid: [sx / members.length, sy / members.length],
    domaines: members.map((d) => d.id),
    neighbors: [],
    boundary: dissolveDomainBoundaries(members),
  });
  console.log(`  ${zoneName}: ${members.length} cells, ${terrains[terrains.length - 1].boundary.length} ring(s)`);
}
// Voisins entre mers nommées et terrains terrestres (via les cellules qu'elles contiennent).
{
  const seaTerrainNb = new Map();
  for (const d of seaDomaines) {
    if (d.terrainId == null) continue;
    for (const nid of d.neighbors || []) {
      const o = domaines.find((x) => x.id === nid) ?? seaDomaines.find((x) => x.id === nid);
      if (!o || o.terrainId == null || o.terrainId === d.terrainId) continue;
      if (!seaTerrainNb.has(d.terrainId)) seaTerrainNb.set(d.terrainId, new Set());
      seaTerrainNb.get(d.terrainId).add(o.terrainId);
      const landTerrain = terrains.find((t) => t.id === o.terrainId);
      if (landTerrain && !landTerrain.neighbors.includes(d.terrainId)) {
        landTerrain.neighbors.push(d.terrainId);
      }
    }
  }
  for (const [tid, set] of seaTerrainNb) {
    const t = terrains.find((x) => x.id === tid);
    if (t) t.neighbors = [...new Set([...t.neighbors, ...set])];
  }
}

domaines.push(...seaDomaines);
console.log(
  `  ${domaines.length} domaines total (${seaDomaines.length} maritimes)`,
);

const worldData = {
  bbox: { lonMin: BBOX.lonMin, lonMax: BBOX.lonMax, latMin: BBOX.latMin, latMax: BBOX.latMax },
  franceBbox,
  heightmap: HEIGHT_META,
  land: landRings,
  impassable,
  rivers: riverLines,
  cities,
  sources: [
    "Natural Earth 10m land (mini-islands removed)",
    "Natural Earth 10m rivers",
    "Natural Earth geography — Alps & Pyrenees continuous chains (elevation-closed)",
    "DARE cities outside impassable ranges",
    "Domains = city flood-fill tessellation (mountains as barriers)",
    "Provinces = historical late-antique regions within kingdoms (contiguous, 2–6 domains)",
    "Realms = geographic zones ~486 Clovis map (de jure claims)",
    "Possessions = de facto hierarchy (kings → vassals → independent chiefs on remaining domains)",
    "Terrains = elevation + hydrography + climate zones (independent of realms)",
    "Economy = urban-cultural development 0–100 from late-antique hubs (~486)",
    "Population ≈ late-antique hinterland densities (hab/km²) × f(development); civitas ≈ low thousands–15k, not modern cities; levies ≈ 2%",
    "Income = monthly gold from domain wealth (development + population)",
  ],
  domaines,
  provinces,
  royaumes,
  possessions,
  terrains,
};

writeFileSync(join(PUBLIC_DIR, "world.json"), JSON.stringify(worldData));
console.log("Écrit public/world.json");
console.log(
  `  terre: ${landRings.length} anneaux / ${landPts} pts | rivières: ${riverLines.length} | massifs: ${impassable.length} | villes: ${cities.length} | domaines: ${domaines.length} | provinces: ${provinces.length} | royaumes: ${royaumes.length} | possessions: ${possessions.length} | terrains: ${terrains.length}`,
);
