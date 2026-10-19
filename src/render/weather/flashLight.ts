// Lightning light on the sea and the boats. The clouds light their own bases from a source inside
// the deck (cloudShading: radiance F·e^(−FALLOFF·d), d in km from the source). The environment probe
// leaves the flash out: it refreshes over several frames and eases between refreshes, so a captured
// flash would hold on the water for seconds. The ocean shader and a hemisphere light take it from
// here instead, for exactly as long as the flash lasts. Pure TS.

export const FLASH_CLOUD_RADIANCE = 900; // cd/m² of the lit cloud base near a nominal flash
export const FLASH_FALLOFF = 1.4; // km⁻¹, how fast the glow fades along the base
export const FLASH_ABOVE_BASE = 400; // m: the flash lights the cloud from at least this far inside

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

// Height of the light source (m): the strike's own height, but at least a little inside the base.
export const flashSourceHeight = (flashY: number, baseM: number): number =>
  Math.max(flashY, baseM + FLASH_ABOVE_BASE);

// Glow of the cloud base (0..1, per unit flash radiance) seen from `from` along the unit `dir`:
// the ray meets the base plane, and the glow falls off with that point's distance from the source.
export function flashGlowAlong(from: Vec3Like, dir: Vec3Like, source: Vec3Like, baseM: number): number {
  const t = (baseM - from.y) / Math.max(dir.y, 0.02);
  if (!(t > 0)) return 0;
  const dx = from.x + dir.x * t - source.x;
  const dy = from.y + dir.y * t - source.y;
  const dz = from.z + dir.z * t - source.z;
  return Math.exp((-FLASH_FALLOFF * Math.hypot(dx, dy, dz)) / 1000);
}

// Cosine-weighted directions over the upper hemisphere (stratified, fixed), for the mean glow.
const RINGS = 6;
const SECTORS = 12;
const HEMISPHERE: readonly Vec3Like[] = (() => {
  const dirs: Vec3Like[] = [];
  for (let i = 0; i < RINGS; i++) {
    const u = (i + 0.5) / RINGS;
    const r = Math.sqrt(u);
    const y = Math.sqrt(1 - u);
    for (let j = 0; j < SECTORS; j++) {
      // Each ring turned half a sector from the last, so the rings don't line up.
      const phi = (2 * Math.PI * (j + 0.5 * (i % 2))) / SECTORS;
      dirs.push({ x: r * Math.cos(phi), y, z: r * Math.sin(phi) });
    }
  }
  return dirs;
})();

// Mean glow of the base over the sky seen from `from` (irradiance / π, per unit flash radiance):
// the flash's share of the sky light on the sea and the boats.
export function flashSkyGlow(from: Vec3Like, source: Vec3Like, baseM: number): number {
  let sum = 0;
  for (const dir of HEMISPHERE) sum += flashGlowAlong(from, dir, source, baseM);
  return sum / HEMISPHERE.length;
}
