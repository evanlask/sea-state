// Hull of a three-point hydroplane (Unlimited class): lofted like the other hulls (generateHull.ts),
// from sections that all have the same five points per side, so the loft stays a closed manifold:
//
//   forward of the step:  tunnel roof at the centreline → the roof's edge at the sponson's inner wall
//                         → down the wall to the pad → across the pad to the outer chine → up the
//                         sponson's outer side to the deck edge (the tunnel is the notch);
//   aft of the step:      the same five points: the tunnel roof and walls running on and fading
//                         into the flat after-planing bottom, out to the hull side and up it.
//
// Two stations a centimetre apart make the step: the sponsons' transoms.
// Forward, the pads and the tunnel roof curve up to the deck over `noseLength`, so the noses are
// spoon-shaped; the bow cap is a thin slab under the deck. Running at speed only the pads' aft ends
// touch the water (with the propeller: physics/propulsion/surfaceProp.ts); at rest the boat floats on
// the sponsons and the after-planing bottom. Like the planing hulls, the shape is fixed and the
// draft (pad line below the waterline) is solved to float the mass.

import { Hydrostatics } from '../hydrostatics';
import { buildFromSections, type HullBuild, loft, type Section } from './generateHull';
import type { HydroplaneHullParams } from './types';

const STEP = 0.01; // m between the two step stations
const NOSE_GAP = 0.04; // m: the noses' pads stop this far under the deck, the tunnel roof half of it
const TUNNEL_RAMP = 2.2; // m aft of the step

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function sections(p: HydroplaneHullParams): Section[] {
  const L = p.length;
  const zBow = -L / 2;
  const zStep = zBow + p.sponsonLength;
  const zStern = L / 2;
  const half = p.beam / 2;
  const T = p.draft;
  const yDeck = p.depth;
  const out: Section[] = [];
  const push = (z: number, xs: number[], ys: number[]): void => {
    out.push({
      z,
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys, (y) => y - T),
      deckY: yDeck - T,
      deckHalf: xs[xs.length - 1]!,
    });
  };
  // Forward of the step.
  const nF = 14;
  for (let i = 0; i < nF; i++) {
    const u = i / (nF - 1);
    // Denser at the noses.
    const z = i === nF - 1 ? zStep - STEP : zBow + p.sponsonLength * (0.6 * u + 0.4 * u * u);
    const d = z - zBow;
    const nose = Math.max(0, 1 - d / p.noseLength); // 1 at the noses, 0 aft of the curve-up
    const curve = 1 - Math.sqrt(1 - nose * nose); // circular-ish: steep at the very nose
    const yPad = (yDeck - NOSE_GAP) * curve;
    const yRoof = p.tunnelHeight + (yDeck - NOSE_GAP / 2 - p.tunnelHeight) * curve;
    const xo = half * (p.noseBeamRatio + (1 - p.noseBeamRatio) * smooth(d / (0.3 * p.sponsonLength)));
    const xi = Math.max(0.05, xo - p.sponsonWidth);
    push(
      z,
      [0, xi, xi, xo, xo],
      [yRoof, yRoof, Math.min(yPad, yRoof - 0.01), Math.min(yPad, yRoof - 0.01), yDeck],
    );
  }
  // Aft of the step: the after-planing hull narrowing to the transom. The tunnel runs on and fades
  // out over `TUNNEL_RAMP`: its roof slopes down to the after-planing bottom and its walls splay out,
  // so the water through it meets a planing ramp, not a wall.
  const nA = 9;
  const xiStep = half - p.sponsonWidth;
  for (let i = 0; i < nA; i++) {
    const u = i / (nA - 1);
    const z = zStep + (zStern - zStep) * (0.7 * u + 0.3 * u * u);
    const along = (z - zStep) / (zStern - zStep);
    const y = p.afterPlaneStep + (p.afterPlaneTransom - p.afterPlaneStep) * along;
    const x = half + (p.transomBeam / 2 - half) * along;
    const fade = 1 - smooth((z - zStep) / TUNNEL_RAMP); // 1 at the step, 0 once the tunnel is gone
    const yRoof = y + (p.tunnelHeight - p.afterPlaneStep) * fade;
    const xi = (xiStep / half) * x * fade + 0.35 * x * (1 - fade);
    const xw = Math.min(0.9 * x, xi + 0.05 + 0.3 * (1 - fade));
    push(z, [0, xi, xw, x, x], [yRoof, yRoof, y, y, yDeck]);
  }
  return out;
}

function solveDraft(p: HydroplaneHullParams, target: number): number {
  const hs = new Hydrostatics(loft(sections({ ...p, draft: 0 })));
  let lo = 0;
  let hi = p.depth;
  if (hs.upright(hi).volume < target) {
    throw new Error(`hull: target volume ${target.toFixed(3)} m³ exceeds the hydroplane's volume`);
  }
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (hs.upright(mid).volume < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function hydroplaneHull(input: HydroplaneHullParams): HullBuild {
  const params =
    input.targetVolume === undefined ? input : { ...input, draft: solveDraft(input, input.targetVolume) };
  return buildFromSections(params, sections(params));
}
