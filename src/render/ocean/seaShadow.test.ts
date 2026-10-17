// How dark a boat's shadow on open water is: OceanMaterial's sea radiance (sky reflection, the
// water body and its subsurface glow, oceanOptics.seaUpwelling) with the sun's share removed, over
// the same radiance in sunlight, glassy water, sun 30° up behind the camera (no glint either way).
// Sky inputs: the game's clear atmosphere (atmosphereParams, haze 1) integrated on the CPU, single
// scattering × 1.2 for the multiple-scattering part. Aerial perspective is left out.
//
// SHADOW_REPORT=1 prints the numbers.

import { describe, expect, it } from 'vite-plus/test';

import { fresnelExact, seaUpwelling, WATER_F0 } from './oceanOptics';

type Rgb = readonly [number, number, number];

const SUN_ELEVATION = 30 * (Math.PI / 180);
const BEAM: Rgb = [113_267, 96_516, 74_566]; // lux normal to the beam (sunIlluminanceAt, 30°)
const SKY_IRRADIANCE: Rgb = [3_505, 6_161, 10_710]; // lux on the horizontal from the sky
const SKY_ONTO_SEA: Rgb = [949, 1_694, 3_025]; // cd/m², the probe's roughness-1 lookup straight up
const SKY_ZENITH: Rgb = [502, 1_010, 2_042]; // cd/m², reflected looking straight down
const SKY_LOW: Rgb = [1_680, 3_048, 4_730]; // cd/m², 12° up away from the sun (reflected from chase)
// The default region's water (sim/astro/regions, OceanShadingUniforms).
const WATER = {
  deepColor: [0.012, 0.05, 0.058] as Rgb,
  bodyScale: 0.6,
  subsurfaceTint: [0.12, 0.48, 0.42] as Rgb,
};
const ROUGHNESS = Math.sqrt(0.012); // perceptual roughness of glassy water (√α at the base variance)

const luminance = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Sea radiance seen at `view` (cosine between the view ray and the flat surface normal), reflecting
// `reflected`; `lit` scales the sun's part (1 in sunlight, 0 in a boat's shadow).
function seaRadiance(view: number, reflected: Rgb, lit: number): Rgb {
  const fresnelView = fresnelExact(view);
  const grazing = (Math.max(1 - ROUGHNESS, WATER_F0) - WATER_F0) / (1 - WATER_F0);
  const fresnel = WATER_F0 + (fresnelView - WATER_F0) * grazing;
  const up = seaUpwelling({
    ...WATER,
    sun: BEAM,
    sky: SKY_ONTO_SEA,
    elevation: Math.sin(SUN_ELEVATION),
    nl: Math.sin(SUN_ELEVATION),
    view,
  });
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] =
      (reflected[c] as number) * fresnel +
      (up.sky[c] as number) * (1 - fresnel) +
      (up.sun[c] as number) * (1 - fresnelView) * lit;
  }
  return out as unknown as Rgb;
}

function contrast(view: number, reflected: Rgb): { lit: number; shadow: number; ratio: number } {
  const lit = luminance(seaRadiance(view, reflected, 1));
  const shadow = luminance(seaRadiance(view, reflected, 0));
  return { lit, shadow, ratio: shadow / lit };
}

describe('a boat’s shadow on the sea (clear sky, sun 30°)', () => {
  const above = contrast(1, SKY_ZENITH);
  const chase = contrast(Math.sin(12 * (Math.PI / 180)), SKY_LOW);
  const sunHorizontal = luminance(BEAM) * Math.sin(SUN_ELEVATION);
  const directShare = sunHorizontal / (sunHorizontal + luminance(SKY_IRRADIANCE));
  const up = seaUpwelling({
    ...WATER,
    sun: BEAM,
    sky: SKY_ONTO_SEA,
    elevation: Math.sin(SUN_ELEVATION),
    nl: Math.sin(SUN_ELEVATION),
    view: 1,
  });
  const sunShare = luminance(up.sun) / (luminance(up.sun) + luminance(up.sky));
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SHADOW_REPORT) {
    const f = (x: number): string => x.toFixed(3);
    console.log(`direct share of downwelling ${f(directShare)}, sun share of upwelling ${f(sunShare)}`);
    console.log(
      `from above: lit ${above.lit.toFixed(0)}, shadow ${above.shadow.toFixed(0)}, ${f(above.ratio)}`,
    );
    console.log(
      `from chase: lit ${chase.lit.toFixed(0)}, shadow ${chase.shadow.toFixed(0)}, ${f(chase.ratio)}`,
    );
  }

  it('the sun drives the upwelling light at least in proportion to its share of the daylight', () => {
    expect(directShare).toBeGreaterThan(0.85);
    expect(sunShare).toBeGreaterThanOrEqual(directShare - 0.02);
  });

  it('is a dark band seen from above', () => {
    expect(above.ratio).toBeLessThan(0.25);
  });

  it('stays visible at the chase camera’s grazing angle, where the sky reflection dominates', () => {
    expect(chase.ratio).toBeLessThan(0.85);
    expect(chase.ratio).toBeGreaterThan(above.ratio);
  });
});
