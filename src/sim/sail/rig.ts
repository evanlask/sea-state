// Sail-plan geometry from the classic rig dimensions I, J, P, E, in the boat body frame (x starboard,
// y up from the design waterline, z aft; bow = −Z):
//
//   I  forestay height: deck to where the forestay meets the mast
//   J  foretriangle base: forestay tack to the front of the mast
//   P  main luff: boom to the main's head
//   E  main foot: mast to the clew along the boom
//
// For the aerodynamics the mainsail is a trapezoid (luff on the mast, foot on the boom, a head width
// that makes the area match the measured one). The sail as cut (mainCut, what the cloth shows) is a
// near-triangle with a 15 cm headboard and a convex roach held out by the battens; it has the same area
// and its centroid is within ~4% of the trapezoid's. Slab reefing eases the halyard by the reef depth
// and ties the reef clew down to the boom, so the luff shortens from the bottom, the foot shortens
// along the leech and the head (and centre of effort) come down. The genoa is a triangle on the forestay whose
// clew sits LP from the luff; roller furling rolls it around the forestay, pulling the clew in along
// the perpendicular toward the luff (it rises as it goes, as on a real furler).
//
// The boom swings about the mast (vertical axis, angle β, + to starboard); the genoa swings about the
// forestay and its sheeting angle γ is measured horizontally at the tack from the centreline.

import { DEG } from '../core/conventions';
import type { Vec3 } from '../core/math';
import { clamp } from './util';

export interface HingeSpec {
  inertia: number; // kg·m² about the hinge, including the sail's apparent (air) mass
  massMoment: number; // kg·m, mass × CG distance from the hinge, for gravity when heeled
  damping: number; // N·m·s, hinge friction plus air damping
  restitution: number; // bounce off the sheet when it snubs the swing
}

export interface RigSpec {
  I: number;
  J: number;
  P: number;
  E: number;
  mainArea: number; // m², measured (roach included)
  genoaArea: number; // m²
  mastZ: number; // body z of the mast
  deckY: number; // sheer height at the mast, where I is measured from
  boomY: number; // boom height
  mastheadY: number;
  tack: Vec3; // genoa tack / forestay deck fitting
  genoaClewHeight: number; // m above the tack at full hoist
  genoaHeadDrop: number; // m the genoa's head sits below the hounds
  boomLength: number; // m (a little longer than E)
  traveller: Vec3; // mainsheet block on the traveller, centreline
  jibLead: Vec3; // starboard genoa-sheet lead block (port is mirrored)
  reefDepths: readonly number[]; // m of luff taken in at reefs 0..3
  boomMaxOut: number; // rad, shrouds/spreaders stop the boom here
  boomMinIn: number; // rad, with the mainsheet two-blocked
  jibMinIn: number; // rad, the genoa track's tightest sheeting angle
  jibMaxOut: number; // rad, sheet lead at the rail
  boom: HingeSpec;
  jib: HingeSpec;
}

// C&C 115 [E]: I/J/P/E from the plan, areas [V]; placement fits the hull in specs/sail.ts
// (stem at z ≈ −5.9, sheer ≈ 0.95 m amidships, cockpit aft of z ≈ 1.8).
export const CC115_RIG: RigSpec = {
  I: 15.0,
  J: 4.5,
  P: 14.3,
  E: 5.0,
  mainArea: 45.97,
  genoaArea: 38.09,
  mastZ: -1.1,
  deckY: 1.05,
  boomY: 1.95,
  mastheadY: 16.65,
  tack: { x: 0, y: 1.2, z: -5.6 },
  genoaClewHeight: 0.45,
  genoaHeadDrop: 0.25,
  boomLength: 5.25,
  traveller: { x: 0, y: 1.35, z: 3.75 },
  jibLead: { x: 1.55, y: 1.15, z: 0.6 },
  reefDepths: [0, 1.7, 3.3, 4.9],
  boomMaxOut: 85 * DEG, // eased until the main lies on the spreaders
  boomMinIn: 1 * DEG,
  jibMinIn: 8 * DEG,
  jibMaxOut: 50 * DEG, // further out the clew is well past the rail and the leech just twists off
  // Boom ~25 kg over 5.25 m plus ~14 kg of sail and its air mass; the sail's own aero damps it too.
  boom: { inertia: 650, massMoment: 90, damping: 600, restitution: 0.15 },
  jib: { inertia: 90, massMoment: 18, damping: 70, restitution: 0.1 },
};

export interface MainPlan {
  luff: number; // m, hoisted luff above the boom
  foot: number; // m along the boom
  headWidth: number; // m
  area: number; // m²
  ceHeight: number; // centroid above the boom, m
  ceAft: number; // centroid aft of the mast along the boom, m
  aspectRatio: number; // effective, with the partial end plate of the boom/deck
}

export interface GenoaPlan {
  luffLength: number; // tack to head, m
  luffDir: Vec3; // unit, tack → head
  footDir: Vec3; // unit, perpendicular to the luff in the centreline plane, pointing aft/down
  along: number; // m along the luff from the tack to the clew's perpendicular foot
  lp: number; // m, luff-perpendicular to the clew (shrinks with furling)
  area: number;
  aspectRatio: number;
  head: Vec3;
}

// The deck and boom are a partial end plate, worth ~1.2× the geometric span²/area [E].
const END_PLATE = 1.2;

const mainHeadWidth = (rig: RigSpec): number => Math.max(0.1, (2 * rig.mainArea) / rig.P - rig.E);

// The main as cut: chord c(s) = E + (h − E)·s + R·s^a·(1 − s)^b, measured along the boom at height s·P
// above it, where h is the headboard and R sizes the roach so the area is the measured one. a = 2, b = 1
// put the fullest roach (~1.1 m) two thirds of the way up, between the top battens, and run the leech
// into the head at a point rather than a square top. The centroid is 3% lower and 4% further aft than
// the aero trapezoid's (a fuller top would need a fat head; a plainer arc puts it 6% lower).
export const MAIN_HEADBOARD = 0.15; // m, C&C 115-size headboard
const ROACH_A = 2;
const ROACH_B = 1;

export const roachShape = (s: number): number => (s <= 0 || s >= 1 ? 0 : s ** ROACH_A * (1 - s) ** ROACH_B);

// ∫₀¹ roachShape (midpoint rule; the shape is smooth).
const ROACH_INTEGRAL = ((): number => {
  const n = 512;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += roachShape((i + 0.5) / n);
  return sum / n;
})();

// Roach scale R (m): the leech's offset beyond the straight line from the clew to the headboard is
// R·roachShape(s). Zero if the measured area is no bigger than the triangle.
export const mainRoach = (rig: RigSpec): number =>
  Math.max(0, rig.mainArea / rig.P - (rig.E + MAIN_HEADBOARD) / 2) / ROACH_INTEGRAL;

// Chord of the cut main (m along the boom) at fraction s of P above the boom, full hoist.
export function mainCutChord(rig: RigSpec, s: number): number {
  const t = clamp(s, 0, 1);
  return rig.E + (MAIN_HEADBOARD - rig.E) * t + mainRoach(rig) * roachShape(t);
}

export interface MainCut {
  luff: number; // m, hoisted luff above the boom
  foot: number; // m along the boom to the (reef) clew
  headboard: number; // m
  roach: number; // m, R
  from: number; // fraction of P the foot is cut at (d/P when reefed)
}

// The main as cut at a reef: the part of the full sail above the reef points, with the reef clew on
// the roached leech.
export function mainCut(rig: RigSpec, reef: number, out: MainCut = emptyMainCut()): MainCut {
  const d = reefDepth(rig, reef);
  out.luff = rig.P - d;
  out.from = d / rig.P;
  out.foot = mainCutChord(rig, out.from);
  out.headboard = MAIN_HEADBOARD;
  out.roach = mainRoach(rig);
  return out;
}

const emptyMainCut = (): MainCut => ({ luff: 0, foot: 0, headboard: 0, roach: 0, from: 0 });

// Reef depth for a fractional reef level (reefing is animated, so 1.4 is between reefs 1 and 2).
export function reefDepth(rig: RigSpec, reef: number): number {
  const r = clamp(reef, 0, rig.reefDepths.length - 1);
  const i = Math.min(Math.floor(r), rig.reefDepths.length - 2);
  const t = r - i;
  return rig.reefDepths[i]! + (rig.reefDepths[i + 1]! - rig.reefDepths[i]!) * t;
}

export function mainPlan(rig: RigSpec, reef: number, out: MainPlan = emptyMainPlan()): MainPlan {
  const d = reefDepth(rig, reef);
  const hw = mainHeadWidth(rig);
  const luff = rig.P - d;
  // The reef clew sits up the leech, which runs from the clew in to the head.
  const foot = rig.E - ((rig.E - hw) * d) / rig.P;
  out.luff = luff;
  out.foot = foot;
  out.headWidth = hw;
  out.area = (luff * (foot + hw)) / 2;
  // Trapezoid centroid: height and chordwise position from the luff.
  out.ceHeight = (luff / 3) * ((foot + 2 * hw) / (foot + hw));
  out.ceAft = (foot * foot + foot * hw + hw * hw) / (3 * (foot + hw));
  out.aspectRatio = (END_PLATE * luff * luff) / out.area;
  return out;
}

export const emptyMainPlan = (): MainPlan => ({
  luff: 0,
  foot: 0,
  headWidth: 0,
  area: 0,
  ceHeight: 0,
  ceAft: 0,
  aspectRatio: 0,
});

export function genoaPlan(rig: RigSpec, furl: number, out: GenoaPlan = emptyGenoaPlan()): GenoaPlan {
  const t = rig.tack;
  const hy = rig.deckY + rig.I - rig.genoaHeadDrop;
  const hz = rig.mastZ - 0.1; // just ahead of the mast
  const ly = hy - t.y;
  const lz = hz - t.z;
  const luff = Math.hypot(ly, lz);
  out.luffLength = luff;
  out.luffDir.x = 0;
  out.luffDir.y = ly / luff;
  out.luffDir.z = lz / luff;
  out.footDir.x = 0;
  out.footDir.y = -out.luffDir.z;
  out.footDir.z = out.luffDir.y;
  out.head.x = 0;
  out.head.y = hy;
  out.head.z = hz;
  // Full-hoist LP from the measured area; the clew sits genoaClewHeight above the tack.
  const lp0 = (2 * rig.genoaArea) / luff;
  const along0 = (rig.genoaClewHeight - lp0 * out.footDir.y) / out.luffDir.y;
  const f = clamp(furl, 0, 1);
  // Furling rolls the clew in along the perpendicular; a fully furled sail keeps a token 2 cm so the
  // geometry never degenerates.
  out.lp = Math.max(0.02, lp0 * (1 - f));
  out.along = along0;
  out.area = (luff * out.lp) / 2;
  out.aspectRatio = out.area > 1e-6 ? (END_PLATE * luff * luff) / out.area : 0;
  return out;
}

export const emptyGenoaPlan = (): GenoaPlan => ({
  luffLength: 0,
  luffDir: { x: 0, y: 1, z: 0 },
  footDir: { x: 0, y: 0, z: 1 },
  along: 0,
  lp: 0,
  area: 0,
  aspectRatio: 0,
  head: { x: 0, y: 0, z: 0 },
});

// Rotation of the clew about the forestay that gives horizontal sheeting angle γ at the tack. The clew
// is tack + along·l + lp·(cos θ·m + sin θ·x̂), so tan γ = lp·sin θ / (along·l_z + lp·m_z·cos θ).
function genoaRotationForAngle(plan: GenoaPlan, gamma: number): number {
  const g = Math.min(Math.abs(gamma), 89 * DEG);
  const a = plan.along * plan.luffDir.z;
  const b = plan.lp * plan.footDir.z;
  const dc = plan.lp * Math.cos(g);
  const bs = b * Math.sin(g);
  const r = Math.hypot(dc, bs);
  const theta = Math.atan2(bs, dc) + Math.asin(clamp((a * Math.sin(g)) / r, -1, 1));
  return Math.sign(gamma) * theta;
}

export function genoaClew(out: Vec3, rig: RigSpec, plan: GenoaPlan, gamma: number): Vec3 {
  const theta = genoaRotationForAngle(plan, gamma);
  const c = Math.cos(theta) * plan.lp;
  const s = Math.sin(theta) * plan.lp;
  out.x = rig.tack.x + s;
  out.y = rig.tack.y + plan.along * plan.luffDir.y + c * plan.footDir.y;
  out.z = rig.tack.z + plan.along * plan.luffDir.z + c * plan.footDir.z;
  return out;
}

// Centroid of the genoa triangle (tack, head, clew).
export function genoaCentre(out: Vec3, rig: RigSpec, plan: GenoaPlan, gamma: number): Vec3 {
  genoaClew(out, rig, plan, gamma);
  out.x = (rig.tack.x + plan.head.x + out.x) / 3;
  out.y = (rig.tack.y + plan.head.y + out.y) / 3;
  out.z = (rig.tack.z + plan.head.z + out.z) / 3;
  return out;
}

export function mainClew(out: Vec3, rig: RigSpec, plan: MainPlan, beta: number): Vec3 {
  out.x = Math.sin(beta) * plan.foot;
  out.y = rig.boomY;
  out.z = rig.mastZ + Math.cos(beta) * plan.foot;
  return out;
}

export function boomEnd(out: Vec3, rig: RigSpec, beta: number): Vec3 {
  out.x = Math.sin(beta) * rig.boomLength;
  out.y = rig.boomY;
  out.z = rig.mastZ + Math.cos(beta) * rig.boomLength;
  return out;
}

export function mainCentre(out: Vec3, rig: RigSpec, plan: MainPlan, beta: number): Vec3 {
  out.x = Math.sin(beta) * plan.ceAft;
  out.y = rig.boomY + plan.ceHeight;
  out.z = rig.mastZ + Math.cos(beta) * plan.ceAft;
  return out;
}

// Mainsheet length from the boom end to the traveller with the boom at β (rendering and readouts).
export function mainSheetLength(rig: RigSpec, beta: number): number {
  const sx = Math.sin(beta) * rig.boomLength - rig.traveller.x;
  const sy = rig.boomY - rig.traveller.y;
  const sz = rig.mastZ + Math.cos(beta) * rig.boomLength - rig.traveller.z;
  return Math.hypot(sx, sy, sz);
}

// Genoa sheet length from the clew to the lead on the clew's side.
export function jibSheetLength(rig: RigSpec, plan: GenoaPlan, gamma: number, scratch: Vec3): number {
  genoaClew(scratch, rig, plan, gamma);
  const side = gamma >= 0 ? 1 : -1;
  return Math.hypot(scratch.x - side * rig.jibLead.x, scratch.y - rig.jibLead.y, scratch.z - rig.jibLead.z);
}
