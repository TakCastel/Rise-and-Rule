import type { Heightmap } from "./projection";
import type { WorldData } from "../types/world";

const KM_PER_DEG_LAT = 111.32;

export function buildHillshadeCanvas(heightmap: Heightmap, bbox: WorldData["bbox"], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);

  const lonStep = (bbox.lonMax - bbox.lonMin) / width;
  const latStep = (bbox.latMax - bbox.latMin) / height;
  const latAvgRad = (((bbox.latMin + bbox.latMax) / 2) * Math.PI) / 180;
  const metersPerDegLon = KM_PER_DEG_LAT * Math.cos(latAvgRad) * 1000;
  const metersPerDegLat = KM_PER_DEG_LAT * 1000;

  const azimuth = (315 * Math.PI) / 180;
  const altitude = (40 * Math.PI) / 180;
  const lightX = Math.cos(altitude) * Math.sin(azimuth);
  const lightY = Math.cos(altitude) * Math.cos(azimuth);
  const lightZ = Math.sin(altitude);
  // Exagère un peu les pentes pour un relief plus lisible en 2D
  const zFactor = 1.85;

  let p = 0;
  for (let y = 0; y < height; y++) {
    const lat = bbox.latMax - (y / height) * (bbox.latMax - bbox.latMin);
    for (let x = 0; x < width; x++) {
      const lon = bbox.lonMin + (x / width) * (bbox.lonMax - bbox.lonMin);
      const hL = heightmap.elevationAt(lon - lonStep, lat);
      const hR = heightmap.elevationAt(lon + lonStep, lat);
      const hD = heightmap.elevationAt(lon, lat - latStep);
      const hU = heightmap.elevationAt(lon, lat + latStep);
      const dzdx = ((hR - hL) * zFactor) / (2 * lonStep * metersPerDegLon);
      const dzdy = ((hU - hD) * zFactor) / (2 * latStep * metersPerDegLat);

      const nx = -dzdx,
        ny = -dzdy,
        nz = 1;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      let shade = (nx * lightX + ny * lightY + nz * lightZ) / nlen;
      shade = Math.max(0, Math.min(1, shade));

      const elevation = heightmap.elevationAt(lon, lat);
      const coastalFade = Math.max(0, Math.min(1, elevation / 35));
      shade = shade * coastalFade + 1 * (1 - coastalFade);

      // Contraste plus fort qu'avant (0.52–1.0)
      const mult = 0.52 + shade * 0.48;
      const v = Math.round(mult * 255);
      img.data[p] = v;
      img.data[p + 1] = v;
      img.data[p + 2] = v;
      img.data[p + 3] = 255;
      p += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
