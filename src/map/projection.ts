import type { WorldData } from "../types/world";

const KM_PER_DEG_LAT = 111.32;

export interface Projection {
  worldWidthKm: number;
  worldHeightKm: number;
  lonLatToXZ(lon: number, lat: number): [number, number];
  xzToLonLat(x: number, z: number): [number, number];
}

/** Equirectangular projection corrected for latitude, in real kilometers, centered on the map. */
export function makeProjection(bbox: WorldData["bbox"]): Projection {
  const latAvgRad = (((bbox.latMin + bbox.latMax) / 2) * Math.PI) / 180;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos(latAvgRad);
  const worldWidthKm = (bbox.lonMax - bbox.lonMin) * kmPerDegLon;
  const worldHeightKm = (bbox.latMax - bbox.latMin) * KM_PER_DEG_LAT;

  return {
    worldWidthKm,
    worldHeightKm,
    lonLatToXZ(lon, lat) {
      const x = ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * worldWidthKm - worldWidthKm / 2;
      const z = ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * worldHeightKm - worldHeightKm / 2;
      return [x, z];
    },
    xzToLonLat(x, z) {
      const lon = bbox.lonMin + ((x + worldWidthKm / 2) / worldWidthKm) * (bbox.lonMax - bbox.lonMin);
      const lat = bbox.latMax - ((z + worldHeightKm / 2) / worldHeightKm) * (bbox.latMax - bbox.latMin);
      return [lon, lat];
    },
  };
}

function boxBlurPass(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.min(width - 1, Math.max(0, x + dx));
        sum += src[row + sx];
        count++;
      }
      horizontal[row + x] = sum / count;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.min(height - 1, Math.max(0, y + dy));
        sum += horizontal[sy * width + x];
        count++;
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/** Real elevation data, box-blurred then sampled bilinearly by lon/lat. */
export class Heightmap {
  private elevations: Float32Array;
  private width: number;
  private height: number;
  private bbox: WorldData["bbox"];

  constructor(elevations: Float32Array, width: number, height: number, bbox: WorldData["bbox"]) {
    this.elevations = elevations;
    this.width = width;
    this.height = height;
    this.bbox = bbox;
  }

  elevationAt(lon: number, lat: number): number {
    const { lonMin, lonMax, latMin, latMax } = this.bbox;
    const u = ((lon - lonMin) / (lonMax - lonMin)) * (this.width - 1);
    const v = ((latMax - lat) / (latMax - latMin)) * (this.height - 1);
    const x0 = Math.min(this.width - 2, Math.max(0, Math.floor(u)));
    const y0 = Math.min(this.height - 2, Math.max(0, Math.floor(v)));
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = u - x0;
    const fy = v - y0;
    const e00 = this.elevations[y0 * this.width + x0];
    const e10 = this.elevations[y0 * this.width + x1];
    const e01 = this.elevations[y1 * this.width + x0];
    const e11 = this.elevations[y1 * this.width + x1];
    return e00 * (1 - fx) * (1 - fy) + e10 * fx * (1 - fy) + e01 * (1 - fx) * fy + e11 * fx * fy;
  }
}

export async function loadHeightmap(world: WorldData): Promise<Heightmap> {
  const meta = world.heightmap;
  const res = await fetch(meta.url);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = meta.width;
  canvas.height = meta.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, meta.width, meta.height);
  const raw = new Float32Array(meta.width * meta.height);
  const range = meta.maxElevation - meta.minElevation;
  for (let i = 0; i < meta.width * meta.height; i++) {
    const hi = img.data[i * 4];
    const lo = img.data[i * 4 + 1];
    const norm = (hi << 8) | lo;
    raw[i] = meta.minElevation + (norm / 65535) * range;
  }
  const blurred = boxBlurPass(boxBlurPass(raw, meta.width, meta.height, 3), meta.width, meta.height, 2);
  return new Heightmap(blurred, meta.width, meta.height, world.bbox);
}
