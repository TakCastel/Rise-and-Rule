import { domainMonthlyIncome } from "../game/economy";
import { getOpinion } from "../game/opinion";
import { controlsDomain, realmDisplayName, type Title } from "../game/titles";
import type { Alliance } from "../game/types";
import { getTopLiege } from "../game/war";
import type {
  Domaine,
  LevelName,
  Possession,
  Province,
  Royaume,
  Selection,
  Terrain,
  TerrainType,
  WorldData,
} from "../types/world";

export interface RenderUnit {
  id: number;
  name: string;
  boundary: [number, number][][];
  /** Remplissage */
  color: string;
  /** Contour */
  colorSecondary: string;
  neighbors: number[];
  /** Niveau de sélection au clic (défaut = niveau carte) */
  selectionLevel?: LevelName;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clamp01(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

function toHex(r: number, g: number, b: number): string {
  const h = (c: number) => clampByte(c).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (hh < 60) [rp, gp, bp] = [c, x, 0];
  else if (hh < 120) [rp, gp, bp] = [x, c, 0];
  else if (hh < 180) [rp, gp, bp] = [0, c, x];
  else if (hh < 240) [rp, gp, bp] = [0, x, c];
  else if (hh < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255];
}

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
  const max = Math.max(rr, gg, bb),
    min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h * 360, s, l];
}

function lerpHue(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Champ de couleur géographique — balaye toute la roue sur la carte
 * (ouest grisâtre / basque, est plus froid, nord plus vert-jaune, sud plus chaud…).
 */
function geoHsl(lon: number, lat: number): [number, number, number] {
  const u = clamp01((lon + 9.8) / 28.6);
  const v = clamp01((lat - 35.8) / 23.7);
  let h =
    32 +
    u * 210 +
    v * 95 +
    Math.sin(u * Math.PI * 3.1) * 58 +
    Math.cos(v * Math.PI * 2.6) * 50 +
    Math.sin((u * 1.4 + v) * Math.PI * 3.5) * 36;
  h = ((h % 360) + 360) % 360;

  // Basque / west Pyrenees → desaturate toward gray-slate
  const basque = Math.exp(-(((lon + 1.8) / 3.8) ** 2 + ((lat - 43.1) / 2.2) ** 2));
  // Pull toward Burgundy frontier (SE Gaul) → cyan-blue
  const burgEdge = Math.exp(-(((lon - 5.2) / 2.8) ** 2 + ((lat - 45.2) / 2.0) ** 2));
  // Britain cool slate
  const britain = lat > 50 && lon < 2 ? clamp01((lat - 50) / 4) * clamp01((2 - lon) / 4) : 0;

  h = lerpHue(h, 205, burgEdge * 0.55);
  h = lerpHue(h, 210, britain * 0.35);
  h = lerpHue(h, 200, basque * 0.4);

  let s = 0.38 + 0.22 * Math.sin(u * Math.PI) + 0.1 * Math.cos(v * Math.PI * 2);
  s = s * (1 - 0.55 * basque) * (1 - 0.15 * britain) + burgEdge * 0.08;
  const l = 0.34 + 0.12 * v + 0.05 * Math.cos(u * 4.2) - basque * 0.06 + britain * 0.04;
  return [h, clamp01(s, 0.22, 0.72), clamp01(l, 0.28, 0.58)];
}

function domainPoint(world: WorldData, d: Domaine): [number, number] {
  if (d.cityId != null && world.cities) {
    const c = world.cities.find((x) => x.id === d.cityId);
    if (c) return [c.lon, c.lat];
  }
  return d.centroid;
}

/**
 * Couleur domaine (fallback id-only).
 */
export function uniqueDomainColor(id: number, total: number): string {
  const n = Math.max(1, total);
  const h = ((id * 360) / n + id * 0.37) % 360;
  const bandS = id % 4;
  const bandL = Math.floor(id / 4) % 5;
  const s = 0.5 + bandS * 0.1;
  const l = 0.36 + bandL * 0.055;
  const [r, g, b] = hslToRgb(h, s, l);
  return toHex(r, g, b);
}

/**
 * Couleurs royaumes — palette carte de référence (~486–507).
 * Clé = code Royaume. Progression chromatique délibérée : les 20 royaumes
 * balaient la roue teinte par pas de 18° (360°/20), dans un ordre à peu
 * près géographique (NO → SE), en alternant deux profils S/L (vif/moyen ↔
 * plus profond) pour que des teintes voisines restent bien distinguables.
 */
export const KINGDOM_PALETTE: Record<string, string> = {
  BRIT: "#d03939", // Britons — rouge
  BRYT: "#995233", // Bretons (Armorique) — brun-rouge
  ANGL: "#d09439", // Anglo-Saxons — orange
  FRIS: "#998f33", // Frisons — olive
  SAXO: "#b2d039", // Saxons — vert-jaune
  DANE: "#669933", // Danois — vert
  THUR: "#57d039", // Thuringiens — vert vif
  CARN: "#33993d", // Carinthia — vert profond
  FRAN: "#39d075", // Francs — vert d’eau
  SYAG: "#33997a", // Syagrius — sarcelle
  ALAM: "#39d0d0", // Alamans — cyan
  AQUI: "#337a99", // Aquitaine — bleu ardoise
  BURG: "#3975d0", // Burgondes — bleu
  OSTG: "#333d99", // Ostrogoths — bleu profond
  BALE: "#5739d0", // Baléares — indigo
  CORS: "#663399", // Corse — mauve
  SARD: "#b239d0", // Sardaigne — violet
  VAND: "#99338f", // Vandales — magenta profond
  SUEB: "#d03994", // Suèves — rose vif
  VISI: "#993352", // Wisigoths (Hispanie) — rose foncé
};

/** Fallback procédural si code inconnu. */
export function uniqueKingdomColor(id: number, _total: number): string {
  const h = (id * 137.508 + 18) % 360;
  const s = 0.55 + (id % 3) * 0.1;
  const l = 0.38 + (id % 4) * 0.05;
  const [r, g, b] = hslToRgb(h, s, l);
  return toHex(r, g, b);
}

const domainColorCache = new WeakMap<WorldData, Map<number, string>>();
const kingdomColorCache = new WeakMap<WorldData, Map<number, string>>();

/** Couleur terre (fond de carte) — domaines hors royaume. */
export const LAND_COLOR = "#d2c6a8";

/** Couleur mer — zones maritimes, neutres dans toutes les vues. */
export const SEA_COLOR = "#2f5f78";

function isSeaUnit(d: { terrainType?: TerrainType }): boolean {
  return d.terrainType === "sea";
}

function buildDomainColors(world: WorldData): Map<number, string> {
  const cache = new Map<number, string>();
  const hslMap = new Map<number, [number, number, number]>();

  // Group domains by province (variations of province color)
  const byProvince = new Map<number, Domaine[]>();
  const noProvince: Domaine[] = [];
  for (const d of world.domaines) {
    if (isSeaUnit(d)) {
      const [r, g, b] = parseHex(SEA_COLOR);
      hslMap.set(d.id, rgbToHsl(r, g, b));
      continue;
    }
    if (d.royaumeId == null) {
      const [r, g, b] = parseHex(LAND_COLOR);
      hslMap.set(d.id, rgbToHsl(r, g, b));
      continue;
    }
    if (d.provinceId == null) {
      noProvince.push(d);
      continue;
    }
    if (!byProvince.has(d.provinceId)) byProvince.set(d.provinceId, []);
    byProvince.get(d.provinceId)!.push(d);
  }

  for (const [pid, group] of byProvince) {
    const baseHex = provinceColor(world, pid);
    const [pr, pg, pb] = parseHex(baseHex);
    const [ph, ps, pl] = rgbToHsl(pr, pg, pb);

    const ordered = group.slice().sort((a, b) => {
      const [ax, ay] = domainPoint(world, a);
      const [bx, by] = domainPoint(world, b);
      return ax + ay * 0.4 - (bx + by * 0.4);
    });
    const n = ordered.length;

    // Dégradé continu le long de la province (ordre géographique) : chaque
    // domaine avance légèrement sur `t` plutôt que de sauter au hasard —
    // lisible comme UNE progression, tout en couvrant large (bien plus que
    // la province seule) grâce au grand spread de teinte.
    ordered.forEach((d, i) => {
      const [lon, lat] = domainPoint(world, d);
      const [, gs, gl] = geoHsl(lon, lat);
      const t = n <= 1 ? 0.5 : i / (n - 1);
      const j1 = hash01(d.id * 9.13);
      const j2 = hash01(d.id * 2.3);
      const j3 = hash01(d.id * 7.9);
      const j4 = hash01(d.id * 5.1);

      // Déclinaison de la province, pas un territoire à part — spread plus
      // resserré qu’avant ; c’est le lissage inter-domaines plus bas qui
      // fait le gros du travail de morph, y compris au-delà de la province.
      const spread = 38;
      const h = (ph + (t - 0.5) * spread + (j1 - 0.5) * 10 + 360) % 360;

      // Saturation : rampe douce du quasi-gris au vif le long de la province.
      const s = clamp01(0.16 + t * 0.62 + ps * 0.12 + (j2 - 0.5) * 0.1 + gs * 0.05, 0.04, 0.95);

      // Luminosité : onde douce clair ↔ foncé, pas de saut d’un domaine à l’autre.
      const lWave = 0.28 + 0.3 * Math.sin(t * Math.PI * 1.5 + j3 * 0.4);
      let l = clamp01(lWave * 0.8 + pl * 0.16 + (j4 - 0.5) * 0.06 + gl * 0.04, 0.14, 0.78);

      // Keep gray variants readable (avoid too dark when S is tiny)
      if (s < 0.15) l = clamp01(l + 0.04, 0.28, 0.66);

      hslMap.set(d.id, [h, s, l]);
    });
  }

  // Domains with kingdom but no province — variantes toujours diversifiées
  for (const d of noProvince) {
    const baseHex = kingdomColor(world, d.royaumeId!);
    const [kr, kg, kb] = parseHex(baseHex);
    const [kh, ks, kl] = rgbToHsl(kr, kg, kb);
    const [lon, lat] = domainPoint(world, d);
    const [gh, gs, gl] = geoHsl(lon, lat);
    const fullSpreadHue = hash01(d.id * 11.7) * 360;
    const h = lerpHue(lerpHue(fullSpreadHue, kh, 0.3), gh, 0.15);
    const s = clamp01(ks * 0.35 + hash01(d.id * 6.3) * 0.55 + gs * 0.08, 0.08, 0.9);
    const l = clamp01(kl * 0.3 + hash01(d.id * 3.9) * 0.4 + 0.24 + gl * 0.08, 0.2, 0.72);
    hslMap.set(d.id, [h, s, l]);
  }

  // Lissage par vraies voisines (pas restreint à la même province) — comme
  // pour les royaumes/provinces, plusieurs passes pour que la couleur morphe
  // de proche en proche à travers les frontières de province, au lieu de
  // former des blocs à bords nets.
  for (let pass = 0; pass < 3; pass++) {
    const next = new Map<number, [number, number, number]>();
    for (const d of world.domaines) {
      const cur = hslMap.get(d.id)!;
      if (d.royaumeId == null || isSeaUnit(d)) {
        next.set(d.id, cur);
        continue;
      }
      const neigh = (d.neighbors || [])
        .filter((nid) => {
          const nd = world.domaines.find((x) => x.id === nid) ?? world.domaines[nid];
          return nd && !isSeaUnit(nd);
        })
        .map((nid) => hslMap.get(nid))
        .filter((v): v is [number, number, number] => !!v);
      if (neigh.length === 0) {
        next.set(d.id, cur);
        continue;
      }
      let ss = 0,
        sl = 0,
        cx = 0,
        cy = 0;
      for (const [nh, ns, nl] of neigh) {
        const rad = (nh * Math.PI) / 180;
        cx += Math.cos(rad);
        cy += Math.sin(rad);
        ss += ns;
        sl += nl;
      }
      const nn = neigh.length;
      const sh = ((Math.atan2(cy / nn, cx / nn) * 180) / Math.PI + 360) % 360;
      const blend = 0.22;
      next.set(d.id, [
        lerpHue(cur[0], sh, blend),
        lerp(cur[1], ss / nn, blend),
        lerp(cur[2], sl / nn, blend),
      ]);
    }
    for (const [id, hsl] of next) hslMap.set(id, hsl);
  }

  for (const d of world.domaines) {
    if (isSeaUnit(d)) {
      cache.set(d.id, SEA_COLOR);
      continue;
    }
    if (d.royaumeId == null) {
      cache.set(d.id, LAND_COLOR);
      continue;
    }
    const [h, s, l] = hslMap.get(d.id)!;
    const [r, g, b] = hslToRgb(h, s, l);
    cache.set(d.id, toHex(r, g, b));
  }
  return cache;
}

function domainColor(world: WorldData, id: number): string {
  let cache = domainColorCache.get(world);
  if (!cache) {
    cache = buildDomainColors(world);
    domainColorCache.set(world, cache);
  }
  return cache.get(id) ?? uniqueDomainColor(id, world.domaines.length);
}

export function kingdomColor(world: WorldData, id: number): string {
  const list = world.royaumes || [];
  let cache = kingdomColorCache.get(world);
  if (!cache) {
    cache = new Map();
    const n = list.length;
    for (const r of list) {
      const fromPalette =
        (r.code && KINGDOM_PALETTE[r.code]) ||
        KINGDOM_PALETTE[r.name] ||
        null;
      cache.set(r.id, fromPalette ?? uniqueKingdomColor(r.id, n));
    }
    kingdomColorCache.set(world, cache);
  }
  return cache.get(id) ?? uniqueKingdomColor(id, list.length);
}

/** Contour : crème / gris → léger assombrissement lisible. */
export function secondaryFromPrimary(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const lum = (r + g + b) / 3;
  const factor = lum > 200 ? 0.72 : lum > 160 ? 0.62 : 0.55;
  return toHex(r * factor, g * factor, b * factor);
}

function toRender(
  u: { id: number; name: string; boundary: [number, number][][]; neighbors: number[] },
  color: string,
): RenderUnit {
  return {
    id: u.id,
    name: u.name,
    boundary: u.boundary,
    color,
    colorSecondary: secondaryFromPrimary(color),
    neighbors: u.neighbors,
  };
}

/** Quantifie un sommet pour matcher les arêtes partagées entre domaines. */
function vertexKey(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * Fusionne des anneaux adjacents en annulant les arêtes internes partagées.
 * Évite le flatMap qui redessine chaque domaine.
 */
export function dissolveRings(rings: [number, number][][]): [number, number][][] {
  type Pt = [number, number];
  const edgeUse = new Map<string, { a: Pt; b: Pt; n: number }>();

  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    const n = ring.length;
    const closed =
      ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
    for (let i = 0; i < closed; i++) {
      const a = ring[i] as Pt;
      const b = ring[(i + 1) % closed] as Pt;
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const ka = vertexKey(a[0], a[1]);
      const kb = vertexKey(b[0], b[1]);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const prev = edgeUse.get(key);
      if (prev) prev.n += 1;
      else edgeUse.set(key, { a, b, n: 1 });
    }
  }

  // Arêtes externes uniquement (non partagées)
  const adj = new Map<string, Pt[]>();
  const addAdj = (from: Pt, to: Pt) => {
    const k = vertexKey(from[0], from[1]);
    const list = adj.get(k);
    if (list) list.push(to);
    else adj.set(k, [to]);
  };

  for (const { a, b, n } of edgeUse.values()) {
    if (n !== 1) continue;
    addAdj(a, b);
    addAdj(b, a);
  }

  const usedDir = new Set<string>();
  const out: [number, number][][] = [];

  for (const [startKey, outs] of adj) {
    for (const firstTo of outs) {
      const start = startKey.split(",").map(Number) as Pt;
      const dir0 = `${startKey}>${vertexKey(firstTo[0], firstTo[1])}`;
      if (usedDir.has(dir0)) continue;

      const ring: Pt[] = [start];
      let cur = start;
      let next = firstTo;
      for (let guard = 0; guard < 20000; guard++) {
        const ck = vertexKey(cur[0], cur[1]);
        const nk = vertexKey(next[0], next[1]);
        const dir = `${ck}>${nk}`;
        if (usedDir.has(dir)) break;
        usedDir.add(dir);
        ring.push(next);
        if (nk === startKey && ring.length > 2) break;

        const candidates = adj.get(nk) || [];
        // Tourner à gauche préférentiellement pour contour extérieur
        let best: Pt | null = null;
        let bestAng = -Infinity;
        const inAng = Math.atan2(next[1] - cur[1], next[0] - cur[0]);
        for (const cand of candidates) {
          const candKey = vertexKey(cand[0], cand[1]);
          if (candKey === ck) continue;
          if (usedDir.has(`${nk}>${candKey}`)) continue;
          const outAng = Math.atan2(cand[1] - next[1], cand[0] - next[0]);
          let turn = outAng - inAng;
          while (turn <= -Math.PI) turn += 2 * Math.PI;
          while (turn > Math.PI) turn -= 2 * Math.PI;
          if (turn > bestAng) {
            bestAng = turn;
            best = cand;
          }
        }
        if (!best) break;
        cur = next;
        next = best;
      }

      if (ring.length >= 4) {
        out.push(ring);
        // Marquer le sens inverse : sinon chaque contour sort en CW + CCW
        // et le fill SVG (nonzero) s’annule → carte beige.
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i];
          const b = ring[i + 1];
          usedDir.add(`${vertexKey(b[0], b[1])}>${vertexKey(a[0], a[1])}`);
        }
      }
    }
  }

  return out.length > 0 ? out : rings;
}

/**
 * Contour fusionné : outline starter si présent, sinon dissolve live.
 * Après conquête/allégeance, boundary est invalidé → dissolve.
 */
function unitBoundary(
  stored: [number, number][][] | undefined,
  members: { boundary: [number, number][][] }[],
): [number, number][][] {
  const memberRings = members
    .flatMap((d) => d.boundary || [])
    .filter((r) => r.length >= 3);
  if (!memberRings.length) return [];
  if (stored && stored.length > 0) return stored;
  if (memberRings.length <= 1) return memberRings;
  const dissolved = dissolveRings(memberRings);
  return dissolved.length > 0 ? dissolved : memberRings;
}

export function getDomainUnits(world: WorldData): RenderUnit[] {
  return world.domaines.map((d) => {
    if (isSeaUnit(d)) {
      // Contour naturel (pas aplati comme les terres non revendiquées) —
      // chaque cellule maritime doit rester visible/cliquable comme un
      // territoire à part entière, pas se fondre en un seul bloc uniforme.
      return toRender(d, SEA_COLOR);
    }
    if (d.royaumeId == null) {
      const u = toRender(d, LAND_COLOR);
      u.colorSecondary = LAND_COLOR;
      return u;
    }
    return toRender(d, domainColor(world, d.id));
  });
}

const provinceColorCache = new WeakMap<WorldData, Map<number, string>>();

function provinceColor(world: WorldData, id: number): string {
  let cache = provinceColorCache.get(world);
  if (!cache) {
    cache = new Map();
    const list = world.provinces || [];
    const byKingdom = new Map<number, typeof list>();
    for (const p of list) {
      if (!byKingdom.has(p.royaumeId)) byKingdom.set(p.royaumeId, []);
      byKingdom.get(p.royaumeId)!.push(p);
    }

    // Passe 1 : chaque province tire sa teinte de base de son royaume
    // (déclinaison — même famille de couleur, S/L variées).
    const hslMap = new Map<number, [number, number, number]>();
    for (const [rid, group] of byKingdom) {
      const base = kingdomColor(world, rid);
      const [kr, kg, kb] = parseHex(base);
      const [kh, ks, kl] = rgbToHsl(kr, kg, kb);
      // Geographic order → progressive hue fan (easier to read on the map)
      const ordered = group.slice().sort((a, b) => {
        const da = a.centroid[0] + a.centroid[1] * 0.4;
        const db = b.centroid[0] + b.centroid[1] * 0.4;
        return da - db;
      });
      const n = ordered.length;
      // Stay in kingdom hue family; vary S/L hard (incl. gray), moderate hue drift
      ordered.forEach((p, i) => {
        const [lon, lat] = p.centroid;
        const [, gs, gl] = geoHsl(lon, lat);
        const t = n <= 1 ? 0.5 : i / (n - 1);
        const j1 = hash01(p.id * 8.1);
        const j2 = hash01(p.id * 3.3);
        const j3 = hash01(p.id * 6.7);

        const h = (kh + (t - 0.5) * 60 + (j1 - 0.5) * 28 + 360) % 360;

        const sTargets = [0.08, 0.22, 0.38, 0.55, 0.7, 0.85, 0.95];
        const s = clamp01(sTargets[i % sTargets.length] * 0.7 + ks * 0.3 + (j2 - 0.5) * 0.12 + gs * 0.05, 0.06, 0.92);

        const lTargets = [0.24, 0.32, 0.4, 0.48, 0.56, 0.64];
        let l = clamp01(lTargets[(i * 3) % lTargets.length] * 0.65 + kl * 0.2 + (j3 - 0.5) * 0.08 + gl * 0.05, 0.22, 0.66);
        if (s < 0.18) l = clamp01(l + 0.05, 0.32, 0.58);

        if (kl > 0.75) {
          l = clamp01(0.5 + (i % 4) * 0.05 + (j3 - 0.5) * 0.06, 0.42, 0.72);
        }

        hslMap.set(p.id, [h, s, l]);
      });
    }

    // Passe 2 : lissage par vraies voisines géographiques (`province.neighbors`,
    // pas l’ordre de tri) — plusieurs itérations pour que la teinte « morphe »
    // progressivement de proche en proche, y compris à travers une frontière
    // de royaume, au lieu d’un dégradé en éventail sans lien avec la carte réelle.
    for (let pass = 0; pass < 3; pass++) {
      const next = new Map<number, [number, number, number]>();
      for (const p of list) {
        const cur = hslMap.get(p.id);
        if (!cur) continue;
        const neigh = (p.neighbors || [])
          .map((nid) => hslMap.get(nid))
          .filter((v): v is [number, number, number] => !!v);
        if (!neigh.length) {
          next.set(p.id, cur);
          continue;
        }
        let cx = 0,
          cy = 0,
          ss = 0,
          sl = 0;
        for (const [nh, ns, nl] of neigh) {
          const rad = (nh * Math.PI) / 180;
          cx += Math.cos(rad);
          cy += Math.sin(rad);
          ss += ns;
          sl += nl;
        }
        const nn = neigh.length;
        const sh = ((Math.atan2(cy / nn, cx / nn) * 180) / Math.PI + 360) % 360;
        const blend = 0.3;
        next.set(p.id, [
          lerpHue(cur[0], sh, blend),
          lerp(cur[1], ss / nn, blend),
          lerp(cur[2], sl / nn, blend),
        ]);
      }
      for (const [pid, hsl] of next) hslMap.set(pid, hsl);
    }

    for (const p of list) {
      const hsl = hslMap.get(p.id);
      if (!hsl) continue;
      const [h, s, l] = hsl;
      const [r, g, b] = hslToRgb(h, s, l);
      cache!.set(p.id, toHex(r, g, b));
    }
    provinceColorCache.set(world, cache);
  }
  return cache.get(id) ?? LAND_COLOR;
}

/**
 * Province = cluster de domaines dans un royaume (≤6).
 * Contours = domaines membres. Solos hors royaume → fond de carte.
 */
export function getProvinceUnits(world: WorldData): RenderUnit[] {
  const list = world.provinces || [];
  const provinces = list.map((p) => {
    // Boundary précalculé → pas de lookup domaines / dissolve
    const boundary =
      p.boundary && p.boundary.length > 0
        ? p.boundary
        : unitBoundary(
            undefined,
            p.domaines
              .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
              .filter(Boolean),
          );
    return toRender(
      {
        id: p.id,
        name: p.name,
        boundary,
        neighbors: p.neighbors,
      },
      provinceColor(world, p.id),
    );
  });
  const solos = world.domaines
    .filter((d) => d.royaumeId == null)
    .map((d) => {
      const u = isSeaUnit(d) ? toRender(d, SEA_COLOR) : toRender(d, LAND_COLOR);
      if (!isSeaUnit(d)) u.colorSecondary = LAND_COLOR;
      u.selectionLevel = "domaine";
      return u;
    });
  return [...provinces, ...solos];
}

/**
 * Royaume = groupe de domaines.
 * Contour = boundary fusionné (sans arêtes de domaines).
 * Domaines sans royaume → solos couleur fond de carte.
 */
export function getKingdomUnits(world: WorldData): RenderUnit[] {
  const list = world.royaumes || [];
  const kingdoms = list.map((r) => {
    const boundary =
      r.boundary && r.boundary.length > 0
        ? r.boundary
        : unitBoundary(
            undefined,
            r.domaines
              .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
              .filter(Boolean),
          );
    return toRender(
      {
        id: r.id,
        name: r.name,
        boundary,
        neighbors: r.neighbors,
      },
      kingdomColor(world, r.id),
    );
  });
  const solos = world.domaines
    .filter((d) => d.royaumeId == null)
    .map((d) => {
      const u = isSeaUnit(d) ? toRender(d, SEA_COLOR) : toRender(d, LAND_COLOR);
      if (!isSeaUnit(d)) u.colorSecondary = LAND_COLOR;
      u.selectionLevel = "domaine";
      return u;
    });
  return [...kingdoms, ...solos];
}

function blendHex(hexA: string, hexB: string, t: number): string {
  const [ar, ag, ab] = parseHex(hexA);
  const [br, bg, bb] = parseHex(hexB);
  const [ah, as, al] = rgbToHsl(ar, ag, ab);
  const [bh, bs, bl] = rgbToHsl(br, bg, bb);
  const [r, g, b] = hslToRgb(lerpHue(ah, bh, t), lerp(as, bs, t), lerp(al, bl, t));
  return toHex(r, g, b);
}

/** Domaine principal (le plus développé du demesne) — sert de « capitale » pour la couleur. */
function mainDomain(world: WorldData, p: Possession): Domaine | undefined {
  let best: Domaine | undefined;
  let bestScore = -1;
  for (const did of p.domaines || []) {
    const d = world.domaines.find((x) => x.id === did) ?? world.domaines[did];
    if (!d) continue;
    const score = d.development ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Couleur possession — cohérente avec la hiérarchie royaume → province →
 * domaine plutôt qu’un calcul indépendant :
 * - roi : teinte du royaume, nuancée par la province de sa capitale.
 * - vassal / chef : couleur de la province dont il détient le titre s’il en
 *   a un, sinon celle de la province de son domaine principal, sinon celle
 *   du domaine lui-même (pas de province — cas résiduel).
 */
export function possessionColor(world: WorldData, id: number, titles?: Title[]): string {
  const p = (world.possessions || []).find((x) => x.id === id);
  if (!p) return LAND_COLOR;

  if (p.rank === "king" && p.royaumeId != null) {
    const base = kingdomColor(world, p.royaumeId);
    const capitalProvinceId = mainDomain(world, p)?.provinceId;
    return capitalProvinceId != null ? blendHex(base, provinceColor(world, capitalProvinceId), 0.35) : base;
  }

  const provinceTitle = (titles || []).find(
    (t) => t.tier === "province" && t.holderId === id,
  );
  if (provinceTitle) return provinceColor(world, provinceTitle.deJureId);

  const home = mainDomain(world, p);
  if (home?.provinceId != null) return provinceColor(world, home.provinceId);
  if (home) return domainColor(world, home.id);

  return p.royaumeId != null
    ? kingdomColor(world, p.royaumeId)
    : uniqueKingdomColor(p.id, (world.possessions || []).length);
}

/**
 * Vue Possession : rois (territoire de facto complet) + chefs indépendants.
 * Vassaux inclus dans le blob du roi jusqu’au drill-down.
 * `majorOnly` : uniquement les rois (écran de choix de faction).
 */
export function getPossessionUnits(
  world: WorldData,
  opts?: { majorOnly?: boolean; titles?: Title[] },
): RenderUnit[] {
  const majorOnly = !!opts?.majorOnly;
  const titles = opts?.titles || [];
  const list = (world.possessions || []).filter((p) => {
    if (p.rank === "king") return true;
    if (majorOnly) return false;
    return p.rank === "chief";
  });

  const heldIds = new Set<number>();
  const possessions = list
    .map((p) => {
      if (p.rank === "king") {
        const domainIds = getRealmDomainIds(world, p.id);
        if (!domainIds.length) return null;
        for (const id of domainIds) heldIds.add(id);
        const boundary = getRealmBoundary(world, p.id);
        if (!boundary.length) return null;
        const labelName = realmDisplayName(world, titles, p);
        return toRender(
          {
            id: p.id,
            name: labelName,
            boundary,
            neighbors: p.neighbors,
          },
          possessionColor(world, p.id, titles),
        );
      }
      // Chef : demesne seulement, label = personnage
      if (!p.domaines.length) return null;
      for (const id of p.domaines) heldIds.add(id);
      const members = p.domaines
        .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
        .filter(Boolean);
      const boundary = unitBoundary(p.boundary, members);
      if (!boundary.length) return null;
      return toRender(
        {
          id: p.id,
          name: p.holderName,
          boundary,
          neighbors: p.neighbors,
        },
        possessionColor(world, p.id, titles),
      );
    })
    .filter((u): u is RenderUnit => !!u);
  const solos = world.domaines
    .filter((d) => !heldIds.has(d.id))
    .map((d) => {
      const u = isSeaUnit(d) ? toRender(d, SEA_COLOR) : toRender(d, LAND_COLOR);
      if (!isSeaUnit(d)) u.colorSecondary = LAND_COLOR;
      u.selectionLevel = "domaine";
      return u;
    });
  return [...possessions, ...solos];
}

export function getUnits(
  world: WorldData,
  level: LevelName,
  opts?: {
    majorOnly?: boolean;
    playerId?: number | null;
    opinions?: Record<string, number>;
    titles?: Title[];
    alliances?: Alliance[];
  },
): RenderUnit[] {
  if (level === "royaume") return getKingdomUnits(world);
  if (level === "province") return getProvinceUnits(world);
  if (level === "possession") return getPossessionUnits(world, opts);
  if (level === "terrain") return getTerrainUnits(world);
  if (level === "economy") return getEconomyUnits(world);
  if (level === "opinion") {
    return getOpinionUnits(world, opts?.playerId, opts?.opinions, opts?.titles);
  }
  if (level === "alliance") {
    return getAllianceUnits(world, opts?.alliances, opts?.playerId, opts?.titles);
  }
  return getDomainUnits(world);
}

/** Palette terrain — tons naturels, indépendants des royaumes. */
export const TERRAIN_PALETTE: Record<TerrainType, string> = {
  mountains: "#6a5f55",
  hills: "#8f7a5c",
  forest: "#2f5d3f",
  farmland: "#6b9e3d", // vert culture — contrasté vs désert
  plains: "#9aab6e",
  marsh: "#3f6f62",
  desert: "#e8c99a", // sable clair
  scrub: "#b0895a",
  coast: "#5a8fa3",
  sea: SEA_COLOR,
};

export function terrainColor(_world: WorldData, id: number, type?: TerrainType): string {
  if (type && TERRAIN_PALETTE[type]) return TERRAIN_PALETTE[type];
  const t = (_world.terrains || []).find((x) => x.id === id);
  if (t) return TERRAIN_PALETTE[t.terrainType] ?? LAND_COLOR;
  return LAND_COLOR;
}

/**
 * Terrain = chaque domaine coloré par son type de sol (indépendant de la politique).
 * Pas d’agrégation : même maillage que Domain, palette terrain.
 */
export function getTerrainUnits(world: WorldData): RenderUnit[] {
  return world.domaines.map((d) => {
    const type = d.terrainType;
    const color = type ? TERRAIN_PALETTE[type] : LAND_COLOR;
    const u = toRender(d, color);
    u.selectionLevel = "domaine";
    return u;
  });
}

/** Domaines d’un type de terrain (liste / panneau). */
export function getDomainsOfTerrain(world: WorldData, terrainId: number): RenderUnit[] {
  const t = (world.terrains || []).find((x) => x.id === terrainId);
  if (!t) return [];
  return t.domaines
    .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
    .filter(Boolean)
    .map((d) => {
      const type = d!.terrainType;
      const color = type ? TERRAIN_PALETTE[type] : domainColor(world, d!.id);
      const u = toRender(d!, color);
      u.selectionLevel = "domaine";
      return u;
    });
}

/** Couleur progression économique 0–100 (froid → chaud). */
export function developmentColor(score: number): string {
  const t = Math.max(0, Math.min(100, score)) / 100;
  // bas: ardoise froide → milieu ambre → haut or chaud
  const stops: [number, number, number][] = [
    [45, 52, 64], // 0
    [58, 78, 110], // 25
    [120, 110, 70], // 50
    [180, 130, 50], // 75
    [220, 170, 55], // 100
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return toHex(r, g, bl);
}

/**
 * Economy = chaque domaine coloré par development (0–100).
 * Indépendant de la politique.
 */
export function getEconomyUnits(world: WorldData): RenderUnit[] {
  return world.domaines.map((d) => {
    const color = isSeaUnit(d) ? SEA_COLOR : developmentColor(d.development ?? 0);
    const u = toRender(d, color);
    u.selectionLevel = "domaine";
    return u;
  });
}

/** Couleur opinion −100…100 (bordeaux hostile → pierre → sarcelle amicale). */
export function opinionColor(score: number): string {
  const t = (Math.max(-100, Math.min(100, score)) + 100) / 200;
  const stops: [number, number, number][] = [
    [156, 52, 58], // −100 hostile — bordeaux
    [178, 102, 88], // −50 froid — rose poussiéreux
    [166, 156, 138], // 0 neutre — pierre chaude
    [78, 142, 118], // +50 amical — sauge
    [36, 108, 92], // +100 allié — sarcelle profonde
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return toHex(
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  );
}

/** Votre propre territoire sur la vue Opinion. */
const OPINION_SELF_COLOR = "#c4a35a";

/**
 * Vue Opinion : possessions colorées par l’avis du titulaire envers le focus
 * (personnage cliqué / survolé, ou le joueur en partie).
 * Même maillage que Possession (rois = blob realm, chefs = demesne).
 */
export function getOpinionUnits(
  world: WorldData,
  playerId: number | null | undefined,
  opinions?: Record<string, number>,
  titles?: Title[],
): RenderUnit[] {
  const list = (world.possessions || []).filter(
    (p) => p.rank === "king" || p.rank === "chief",
  );

  const heldIds = new Set<number>();
  const units = list
    .map((p) => {
      let boundary: [number, number][][];
      let labelName: string;
      if (p.rank === "king") {
        const domainIds = getRealmDomainIds(world, p.id);
        if (!domainIds.length) return null;
        for (const id of domainIds) heldIds.add(id);
        boundary = getRealmBoundary(world, p.id);
        if (!boundary.length) return null;
        labelName = realmDisplayName(world, titles || [], p);
      } else {
        if (!p.domaines.length) return null;
        for (const id of p.domaines) heldIds.add(id);
        const members = p.domaines
          .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
          .filter(Boolean);
        boundary = unitBoundary(p.boundary, members);
        if (!boundary.length) return null;
        labelName = p.holderName;
      }

      const isSelf = playerId != null && p.id === playerId;
      const score =
        isSelf || playerId == null
          ? 100
          : getOpinion(opinions || {}, p.id, playerId);
      const color = isSelf ? OPINION_SELF_COLOR : opinionColor(score);
      const u = toRender(
        {
          id: p.id,
          name: isSelf ? labelName : `${labelName} (${score > 0 ? "+" : ""}${score})`,
          boundary,
          neighbors: p.neighbors,
        },
        color,
      );
      u.selectionLevel = "possession";
      return u;
    })
    .filter((u): u is RenderUnit => !!u);

  const solos = world.domaines
    .filter((d) => !heldIds.has(d.id))
    .map((d) => {
      const u = isSeaUnit(d) ? toRender(d, SEA_COLOR) : toRender(d, LAND_COLOR);
      if (!isSeaUnit(d)) u.colorSecondary = LAND_COLOR;
      u.selectionLevel = "domaine";
      return u;
    });
  return [...units, ...solos];
}

/** Vue Alliances — aucune alliance (indépendant). */
export const ALLIANCE_NEUTRAL_COLOR = "#8a8172";

/**
 * Couleur d’un bloc allié — angle doré (137.508°) pour un maximum de
 * distinction visuelle entre blocs consécutifs, quel que soit leur nombre.
 */
function allianceClusterColor(index: number): string {
  const hue = (index * 137.508) % 360;
  const sat = 0.6;
  const light = index % 2 === 0 ? 0.5 : 0.38;
  return toHex(...hslToRgb(hue, sat, light));
}

/**
 * Vue Alliances : chaque roi/chef indépendant coloré selon son bloc
 * d’alliances (composantes connexes du graphe des alliances, y compris
 * transitives — A allié à B allié à C forment un seul bloc/couleur) — pour
 * repérer d’un coup d’œil qui est avec qui. Un pouvoir sans aucune alliance
 * reste en gris neutre.
 */
export function getAllianceUnits(
  world: WorldData,
  alliances: Alliance[] | undefined,
  playerId: number | null | undefined,
  titles?: Title[],
): RenderUnit[] {
  const list = (world.possessions || []).filter(
    (p) => p.rank === "king" || p.rank === "chief",
  );
  const idSet = new Set(list.map((p) => p.id));

  const parent = new Map<number, number>();
  function find(id: number): number {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  }
  function union(a: number, b: number) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const a of alliances || []) {
    if (idSet.has(a.aId) && idSet.has(a.bId)) union(a.aId, a.bId);
  }

  const clusterMembers = new Map<number, number[]>();
  for (const p of list) {
    if (!parent.has(p.id)) continue;
    const root = find(p.id);
    const arr = clusterMembers.get(root) ?? [];
    arr.push(p.id);
    clusterMembers.set(root, arr);
  }
  const roots = [...clusterMembers.keys()].sort((a, b) => a - b);
  const colorOf = new Map<number, string>();
  roots.forEach((root, i) => colorOf.set(root, allianceClusterColor(i)));

  const heldIds = new Set<number>();
  const units = list
    .map((p) => {
      let boundary: [number, number][][];
      let labelName: string;
      if (p.rank === "king") {
        const domainIds = getRealmDomainIds(world, p.id);
        if (!domainIds.length) return null;
        for (const id of domainIds) heldIds.add(id);
        boundary = getRealmBoundary(world, p.id);
        if (!boundary.length) return null;
        labelName = realmDisplayName(world, titles || [], p);
      } else {
        if (!p.domaines.length) return null;
        for (const id of p.domaines) heldIds.add(id);
        const members = p.domaines
          .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
          .filter(Boolean);
        boundary = unitBoundary(p.boundary, members);
        if (!boundary.length) return null;
        labelName = p.holderName;
      }

      const isSelf = playerId != null && p.id === playerId;
      const root = parent.has(p.id) ? find(p.id) : null;
      const blocSize = root != null ? (clusterMembers.get(root)?.length ?? 0) : 0;
      const color =
        root != null && blocSize >= 2 ? colorOf.get(root)! : ALLIANCE_NEUTRAL_COLOR;
      const u = toRender(
        {
          id: p.id,
          name: isSelf ? `${labelName} ★` : labelName,
          boundary,
          neighbors: p.neighbors,
        },
        color,
      );
      u.selectionLevel = "possession";
      return u;
    })
    .filter((u): u is RenderUnit => !!u);

  const solos = world.domaines
    .filter((d) => !heldIds.has(d.id))
    .map((d) => {
      const u = isSeaUnit(d) ? toRender(d, SEA_COLOR) : toRender(d, LAND_COLOR);
      if (!isSeaUnit(d)) u.colorSecondary = LAND_COLOR;
      u.selectionLevel = "domaine";
      return u;
    });
  return [...units, ...solos];
}

/** Vue Guerre — notre camp. */
export const WAR_SELF_COLOR = "#3d6fd6";
/** Vue Guerre — camp ennemi (y compris les alliés venus prêter main-forte à l’ennemi). */
export const WAR_ENEMY_COLOR = "#b3392b";
/** Vue Guerre — allié ayant rejoint notre camp dans cette guerre. */
export const WAR_ALLY_COLOR = "#3f9d52";
/** Vue Guerre — reste du monde, hors belligérants. */
export const WAR_NEUTRAL_COLOR = "#8a8172";

/**
 * Vue Guerre : maillage par domaine (comme Terrain/Economy — tous les
 * territoires restent finement contourés), coloré selon le camp qui
 * contrôle chaque domaine — notre camp en bleu, l’ennemi en rouge, un allié
 * ayant rejoint notre camp en vert, le reste du monde en neutre.
 */
export function getWarUnits(
  world: WorldData,
  myId: number | null,
  enemyIds: number[],
  allyIds: number[] = [],
): RenderUnit[] {
  return world.domaines.map((d) => {
    const color = isSeaUnit(d)
      ? SEA_COLOR
      : myId != null && controlsDomain(world, myId, d.possessionId)
        ? WAR_SELF_COLOR
        : enemyIds.some((eid) => controlsDomain(world, eid, d.possessionId))
          ? WAR_ENEMY_COLOR
          : allyIds.some((aid) => controlsDomain(world, aid, d.possessionId))
            ? WAR_ALLY_COLOR
            : WAR_NEUTRAL_COLOR;
    const u = toRender(d, color);
    u.selectionLevel = "domaine";
    return u;
  });
}

function rootPossessionId(world: WorldData, id: number): number {
  const p = (world.possessions || []).find((x) => x.id === id);
  if (!p) return id;
  return getTopLiege(world, p).id;
}

/**
 * Labels « possession » pour la vue Guerre : mon camp, les ennemis et les
 * alliés ayant rejoint (le reste du monde n’a pas besoin d’être nommé) —
 * pour repérer où porter le siège. Le maillage fin par domaine
 * (`getWarUnits`) reste seul responsable des couleurs/contours ; ceci ne
 * fournit que les étiquettes.
 */
export function getWarLabelUnits(
  world: WorldData,
  myId: number | null,
  enemyIds: number[],
  allyIds: number[] = [],
): RenderUnit[] {
  if (myId == null && enemyIds.length === 0 && allyIds.length === 0) return [];
  const myRoot = myId != null ? rootPossessionId(world, myId) : null;
  const enemyRoots = new Set(enemyIds.map((id) => rootPossessionId(world, id)));
  const allyRoots = new Set(allyIds.map((id) => rootPossessionId(world, id)));

  const list = (world.possessions || []).filter((p) => p.rank === "king" || p.rank === "chief");
  const out: RenderUnit[] = [];
  for (const p of list) {
    const isMine = myRoot != null && p.id === myRoot;
    const isEnemy = enemyRoots.has(p.id);
    const isAlly = allyRoots.has(p.id);
    if (!isMine && !isEnemy && !isAlly) continue;

    let boundary: [number, number][][];
    let labelName: string;
    if (p.rank === "king") {
      boundary = getRealmBoundary(world, p.id);
      labelName = p.name;
    } else {
      const members = p.domaines
        .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
        .filter(Boolean);
      boundary = unitBoundary(p.boundary, members);
      labelName = p.holderName;
    }
    if (!boundary.length) continue;
    const color = isMine ? WAR_SELF_COLOR : isEnemy ? WAR_ENEMY_COLOR : WAR_ALLY_COLOR;
    const u = toRender({ id: p.id, name: labelName, boundary, neighbors: p.neighbors }, color);
    u.selectionLevel = "possession";
    out.push(u);
  }
  return out;
}

/** Provinces d’un royaume (sans solos). */
export function getProvincesOfKingdom(world: WorldData, kingdomId: number): RenderUnit[] {
  return (world.provinces || [])
    .filter((p) => p.royaumeId === kingdomId)
    .map((p) => {
      const boundary =
        p.boundary && p.boundary.length > 0
          ? p.boundary
          : unitBoundary(
              undefined,
              p.domaines
                .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
                .filter(Boolean),
            );
      const u = toRender(
        {
          id: p.id,
          name: p.name,
          boundary,
          neighbors: p.neighbors,
        },
        provinceColor(world, p.id),
      );
      u.selectionLevel = "province";
      return u;
    });
}

/** Domaines d’une province. */
export function getDomainsOfProvince(world: WorldData, provinceId: number): RenderUnit[] {
  const p = (world.provinces || []).find((x) => x.id === provinceId);
  if (!p) return [];
  return p.domaines
    .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
    .filter(Boolean)
    .map((d) => {
      const u = toRender(d!, domainColor(world, d!.id));
      u.selectionLevel = "domaine";
      return u;
    });
}

/** Domaines d’une possession. */
export function getDomainsOfPossession(world: WorldData, possessionId: number): RenderUnit[] {
  const p = (world.possessions || []).find((x) => x.id === possessionId);
  if (!p) return [];
  return p.domaines
    .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
    .filter(Boolean)
    .map((d) => {
      const u = toRender(d!, domainColor(world, d!.id));
      u.selectionLevel = "domaine";
      return u;
    });
}

/** Roi (ou vassal) racine : le seigneur + tous ses vassaux. */
export function getPossessionLiege(
  world: WorldData,
  possessionId: number,
): NonNullable<WorldData["possessions"]>[number] | null {
  const p = (world.possessions || []).find((x) => x.id === possessionId);
  if (!p) return null;
  if (p.liegeId != null) {
    return (world.possessions || []).find((x) => x.id === p.liegeId) || p;
  }
  return p;
}

/** Tous les ids de domaines du « royaume » de facto d’un seigneur (demesne + vassaux récursifs). */
export function getRealmDomainIds(world: WorldData, kingId: number): number[] {
  const byId = new Map((world.possessions || []).map((p) => [p.id, p]));
  const ids: number[] = [];
  const seen = new Set<number>();

  function walk(pid: number) {
    if (seen.has(pid)) return;
    seen.add(pid);
    const p = byId.get(pid);
    if (!p) return;
    for (const id of p.domaines) ids.push(id);
    for (const vid of p.vassalIds || []) walk(vid);
  }

  walk(kingId);
  return ids;
}

/** Contour fusionné du royaume de facto (roi + vassaux). */
export function getRealmBoundary(
  world: WorldData,
  kingId: number,
): [number, number][][] {
  const king = (world.possessions || []).find((x) => x.id === kingId);
  const members = getRealmDomainIds(world, kingId)
    .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
    .filter(Boolean);
  if (!members.length) return [];
  return unitBoundary(king?.boundary, members);
}

/** Demesne du roi comme une seule unité (pas le maillage domaines). */
export function getDemesneUnit(world: WorldData, possessionId: number): RenderUnit | null {
  const p = (world.possessions || []).find((x) => x.id === possessionId);
  if (!p) return null;
  // Toujours dériver du demesne seul — p.boundary peut être le royaume entier
  const boundary = unitBoundary(
    undefined,
    p.domaines
      .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
      .filter(Boolean),
  );
  const u = toRender(
    {
      id: p.id,
      name: p.holderName,
      boundary,
      neighbors: p.neighbors,
    },
    possessionColor(world, p.id),
  );
  u.selectionLevel = "possession";
  return u;
}

/** Vassaux directs : blob = demesne + leurs propres vassaux (sous-vassaux inclus). */
export function getVassalsOfKing(world: WorldData, kingId: number): RenderUnit[] {
  const king = (world.possessions || []).find((x) => x.id === kingId);
  if (!king) return [];
  return (king.vassalIds || [])
    .map((id) => (world.possessions || []).find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => {
      const domainIds = getRealmDomainIds(world, p!.id);
      const members = domainIds
        .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
        .filter(Boolean);
      const boundary = unitBoundary(undefined, members);
      const u = toRender(
        {
          id: p!.id,
          name: p!.holderName,
          boundary,
          neighbors: p!.neighbors,
        },
        possessionColor(world, p!.id),
      );
      // Affiché / labellisé comme une province dans le drill-down
      u.selectionLevel = "possession";
      return u;
    })
    .filter((u) => u.boundary.length > 0);
}

/**
 * Unités à dessiner — Possession :
 * - vue : royaume entier (demesne + vassaux fusionnés)
 * - clic roi : domaines du demesne + territoires vassaux (type « province »)
 * - clic vassal : domaines du vassal
 */
export function getRenderUnits(
  world: WorldData,
  level: LevelName,
  selection: Selection,
  opts?: {
    majorOnly?: boolean;
    playerId?: number | null;
    opinions?: Record<string, number>;
    titles?: Title[];
    alliances?: Alliance[];
  },
): RenderUnit[] {
  // Domaine sélectionné hors vue Domain/Terrain/Economy → garder le maillage du parent
  // (sinon la carte retombe sur les blobs et le clic « ne marche pas »).
  if (selection?.level === "domaine") {
    if (level === "terrain") return getTerrainUnits(world);
    if (level === "economy") return getEconomyUnits(world);
    if (level === "opinion") {
      return getOpinionUnits(world, opts?.playerId, opts?.opinions, opts?.titles);
    }
    if (level === "alliance") {
      return getAllianceUnits(world, opts?.alliances, opts?.playerId, opts?.titles);
    }
    if (level === "domaine") return getUnits(world, "domaine");

    const d =
      world.domaines.find((x) => x.id === selection.id) ?? world.domaines[selection.id];
    if (!d) return getUnits(world, level, opts);

    if (level === "possession" && d.possessionId != null) {
      return getRenderUnits(world, level, { level: "possession", id: d.possessionId }, opts);
    }

    if (level === "province" && d.provinceId != null) {
      const base = getUnits(world, "province");
      const rest = base.filter((u) => u.selectionLevel != null || u.id !== d.provinceId);
      return [...rest, ...getDomainsOfProvince(world, d.provinceId)];
    }

    if (level === "royaume") {
      if (d.provinceId != null) {
        const prov = (world.provinces || []).find((p) => p.id === d.provinceId);
        if (prov) {
          const base = getUnits(world, "royaume");
          const rest = base.filter(
            (u) => u.selectionLevel != null || u.id !== prov.royaumeId,
          );
          const siblings = getProvincesOfKingdom(world, prov.royaumeId).filter(
            (u) => u.id !== prov.id,
          );
          return [...rest, ...siblings, ...getDomainsOfProvince(world, prov.id)];
        }
      }
      if (d.royaumeId != null) {
        const base = getUnits(world, "royaume");
        const rest = base.filter((u) => u.selectionLevel != null || u.id !== d.royaumeId);
        return [...rest, ...getProvincesOfKingdom(world, d.royaumeId)];
      }
    }

    // Domaine hors hiérarchie (ex. non alloué) : le montrer sur le fond courant
    {
      const base = getUnits(world, level, opts);
      const u = toRender(d, domainColor(world, d.id));
      u.selectionLevel = "domaine";
      return [...base, u];
    }
  }

  // Royaume sélectionné → toujours les provinces (contours fusionnés), jamais le maillage domaines
  if (selection?.level === "royaume") {
    const kid = selection.id;
    const baseK = getKingdomUnits(world);
    const rest = baseK.filter((u) => u.selectionLevel != null || u.id !== kid);
    return [...rest, ...getProvincesOfKingdom(world, kid)];
  }

  if (selection?.level === "possession" && level === "possession") {
    const pid = selection.id;
    const p = (world.possessions || []).find((x) => x.id === pid);
    const base = getPossessionUnits(world, opts);

    // Vassal / sous-vassal → demesne + ses vassaux ; le reste du suzerain reste visible
    if (p?.liegeId != null) {
      const liege = p.liegeId;
      const root = getPossessionLiege(world, liege);
      const rootId = root?.id ?? liege;
      const rest = base.filter(
        (u) => u.selectionLevel != null || (u.id !== rootId && u.id !== pid),
      );
      const siblings = getVassalsOfKing(world, liege).filter((u) => u.id !== pid);
      const subVassals = getVassalsOfKing(world, pid);
      return [
        ...rest,
        ...getDomainsOfPossession(world, liege),
        ...siblings,
        ...getDomainsOfPossession(world, pid),
        ...subVassals,
      ];
    }

    // Roi → domaines individuels du demesne + blocs vassaux (noms type province)
    if (p?.rank === "king") {
      const rest = base.filter((u) => u.selectionLevel != null || u.id !== pid);
      const vassals = getVassalsOfKing(world, pid);
      if (vassals.length === 0) {
        return [...rest, ...getDomainsOfPossession(world, pid)];
      }
      return [...rest, ...getDomainsOfPossession(world, pid), ...vassals];
    }

    // Chef indépendant → ses domaines (+ vassaux s’il en a)
    if (p?.rank === "chief") {
      const rest = base.filter((u) => u.selectionLevel != null || u.id !== pid);
      const vassals = getVassalsOfKing(world, pid);
      if (vassals.length === 0) {
        return [...rest, ...getDomainsOfPossession(world, pid)];
      }
      return [...rest, ...getDomainsOfPossession(world, pid), ...vassals];
    }

    const rest = base.filter((u) => u.selectionLevel != null || u.id !== pid);
    return [...rest, ...getDomainsOfPossession(world, pid)];
  }

  // Filtre terrain / economy / opinion = vue dédiée ; sélection n’altère pas le maillage
  if (level === "terrain") {
    return getTerrainUnits(world);
  }
  if (level === "economy") {
    return getEconomyUnits(world);
  }
  if (level === "opinion") {
    return getOpinionUnits(world, opts?.playerId, opts?.opinions, opts?.titles);
  }
  if (level === "alliance") {
    return getAllianceUnits(world, opts?.alliances, opts?.playerId, opts?.titles);
  }

  const base = getUnits(world, level, opts);

  if (selection?.level === "province") {
    const pid = selection.id;
    const prov = (world.provinces || []).find((p) => p.id === pid);
    if (!prov) return base;

    if (level === "province") {
      const rest = base.filter((u) => u.selectionLevel != null || u.id !== pid);
      return [...rest, ...getDomainsOfProvince(world, pid)];
    }

    if (level === "royaume") {
      const rest = base.filter((u) => u.selectionLevel != null || u.id !== prov.royaumeId);
      const siblings = getProvincesOfKingdom(world, prov.royaumeId).filter((u) => u.id !== pid);
      return [...rest, ...siblings, ...getDomainsOfProvince(world, pid)];
    }

    return base;
  }

  return base;
}

export function getPanelInfo(
  world: WorldData,
  selection: Selection,
): {
  name: string;
  code: string | null;
  color: string;
  colorSecondary: string;
  level: string;
  title?: string;
  holderName?: string;
  rank?: string;
  realmName?: string;
  royaumeId?: number;
  provinceId?: number;
  possessionId?: number;
  terrainId?: number;
  development?: number;
  liegeId?: number;
  domainCount?: number;
  provinceCount?: number;
  vassalCount?: number;
} | null {
  if (!selection) return null;
  if (selection.level === "royaume") {
    const r = (world.royaumes || []).find((x) => x.id === selection.id);
    if (!r) return null;
    const color = kingdomColor(world, r.id);
    return {
      name: r.name,
      code: r.code,
      color,
      colorSecondary: secondaryFromPrimary(color),
      level: "Realm",
      domainCount: r.domaines.length,
      provinceCount: r.provinces?.length,
    };
  }
  if (selection.level === "possession") {
    const p = (world.possessions || []).find((x) => x.id === selection.id);
    if (!p) return null;
    const color = possessionColor(world, p.id);
    const levelLabel =
      p.rank === "vassal" ? "Vassal" : p.rank === "chief" ? "Chief" : "Possession";
    return {
      name: p.rank === "king" ? p.name : p.holderName,
      code: p.code,
      color,
      colorSecondary: secondaryFromPrimary(color),
      level: levelLabel,
      title: p.title,
      holderName: p.holderName,
      rank: p.rank,
      royaumeId: p.royaumeId,
      liegeId: p.liegeId,
      realmName: p.name,
      domainCount: p.domaines.length,
      vassalCount: p.vassalIds?.length ?? 0,
    };
  }
  if (selection.level === "terrain") {
    const t = (world.terrains || []).find((x) => x.id === selection.id);
    if (!t) return null;
    const color = terrainColor(world, t.id, t.terrainType);
    return {
      name: t.name,
      code: t.code,
      color,
      colorSecondary: secondaryFromPrimary(color),
      level: "Terrain",
      domainCount: t.domaines.length,
    };
  }
  if (selection.level === "province") {
    const p = (world.provinces || []).find((x) => x.id === selection.id);
    if (!p) return null;
    const color = provinceColor(world, p.id);
    return {
      name: p.name,
      code: p.code,
      color,
      colorSecondary: secondaryFromPrimary(color),
      level: "Province",
      royaumeId: p.royaumeId,
      domainCount: p.domaines.length,
    };
  }
  const d = world.domaines.find((x) => x.id === selection.id) ?? world.domaines[selection.id];
  if (!d) return null;
  const terrainName =
    d.terrainType &&
    (
      (world.terrains || []).find((t) => t.id === d.terrainId) ??
      (world.terrains || []).find((t) => t.terrainType === d.terrainType)
    )?.name;
  const color = isSeaUnit(d) ? SEA_COLOR : d.royaumeId == null ? LAND_COLOR : domainColor(world, d.id);
  return {
    name: d.name,
    code: d.code,
    color,
    colorSecondary: secondaryFromPrimary(color),
    level: "Domain",
    title: (isSeaUnit(d)
      ? [terrainName ? `Terrain: ${terrainName}` : null]
      : [
          terrainName ? `Terrain: ${terrainName}` : null,
          d.development != null ? `Dev ${d.development}` : null,
          `+${domainMonthlyIncome(d)}/mo`,
        ]
    )
      .filter(Boolean)
      .join(" · ") || undefined,
    royaumeId: d.royaumeId,
    provinceId: d.provinceId,
    possessionId: d.possessionId,
    terrainId: d.terrainId,
    development: d.development,
  };
}

export type { Domaine, Possession, Province, Royaume, Terrain };
