// Builds the physical model of a boat from its spec: canoe-body mesh solved to
// displace the spec mass at the design draft, superstructure volumes, the
// design hydrostatics, the CG placed over the LCB with KG solved from the
// target GM, and the dry inertia from the radii of gyration.

import type { BoatSpec } from '../boats/BoatSpec';
import type { Vec3 } from '../core/math';
import { vec3 } from '../core/math';
import { RHO_SEAWATER } from '../core/units';
import { generateHull, type HullBuild } from './hull/generateHull';
import { buildSuperstructure } from './hull/superstructure';
import { type HydrostaticResult, Hydrostatics } from './hydrostatics';
import { mergeMeshes, meshArea, meshVolume, type TriMesh } from './mesh';
import { inertiaFromGyration } from './RigidBody';
import type { WindageSpec } from './windage';

export interface BoatModel {
  spec: BoatSpec;
  hull: HullBuild;
  canoe: TriMesh; // canoe body only
  superstructures: TriMesh[];
  buoyant: TriMesh; // canoe body + watertight superstructure
  mass: number;
  designVolume: number; // m³ displaced at the design draft
  design: HydrostaticResult; // upright at the design waterline
  cg: Vec3; // body frame
  inertia: Vec3; // dry, body principal (x pitch, y yaw, z roll)
  kb: number; // centre of buoyancy above the keel (midship baseline), m
  bm: number; // transverse metacentric radius I_T/∇, m
  kg: number; // CG above the keel, m
  gm: number; // KB + BM − KG (= spec target)
  hullVolume: number; // enclosed canoe-body volume, m³
  hullArea: number; // canoe-body surface area, m²
}

export function buildBoatModel(spec: BoatSpec, rho = RHO_SEAWATER): BoatModel {
  const designVolume = spec.mass / rho;
  const hull = generateHull({ ...spec.hull, targetVolume: designVolume });
  const superstructures = spec.superstructures.map((s) => buildSuperstructure(hull, s));
  const buoyant = mergeMeshes([hull.mesh, ...superstructures]);
  const design = new Hydrostatics(hull.mesh).upright(0);
  const bm = design.waterplaneIxx / design.volume;
  const yG = design.centre.y + bm - spec.gmTarget;
  const draft = spec.dimensions.draft;
  return {
    spec,
    hull,
    canoe: hull.mesh,
    superstructures,
    buoyant,
    mass: spec.mass,
    designVolume,
    design,
    cg: vec3(0, yG, design.centre.z),
    inertia: inertiaFromGyration(spec.mass, spec.gyration),
    kb: design.centre.y + draft,
    bm,
    kg: yG + draft,
    gm: spec.gmTarget,
    hullVolume: meshVolume(hull.mesh),
    hullArea: meshArea(hull.mesh),
  };
}

// The windage without the rider (spec.rider): his areas out, and the centres of what is left.
export function riderlessWindage(spec: BoatSpec): WindageSpec {
  const w = spec.windage;
  const r = spec.rider;
  if (!r) return w;
  const lateral = Math.max(0.1 * w.lateralArea, w.lateralArea - r.lateralArea);
  const frontal = Math.max(0.1 * w.frontalArea, w.frontalArea - r.frontalArea);
  return {
    ...w,
    lateralArea: lateral,
    frontalArea: frontal,
    lateralCentreHeight: (w.lateralArea * w.lateralCentreHeight - r.lateralArea * r.windageHeight) / lateral,
    frontalCentreHeight: (w.frontalArea * w.frontalCentreHeight - r.frontalArea * r.windageHeight) / frontal,
  };
}

export interface MassProperties {
  mass: number;
  cg: Vec3; // body frame
  inertia: Vec3; // body principal about the CG (x pitch, y yaw, z roll)
}

// The craft without its rider (spec.rider): his mass, at his seat, taken out of the mass, CG and inertia
// (parallel axes, plus his own gyration). Each axis keeps at least half of what the craft's own radii of
// gyration would give it, so a guessed rider position can't leave a hull with next to no inertia.
export function riderlessMassProperties(model: BoatModel): MassProperties {
  const rider = model.spec.rider;
  if (!rider) return { mass: model.mass, cg: { ...model.cg }, inertia: { ...model.inertia } };
  const m = rider.mass;
  const mass = model.mass - m;
  const c0 = model.cg;
  const r = rider.position;
  const cg = vec3(
    (model.mass * c0.x - m * r.x) / mass,
    (model.mass * c0.y - m * r.y) / mass,
    (model.mass * c0.z - m * r.z) / mass,
  );
  // Offsets from the old CG of the rider and of the new CG; each axis loses m·d⊥² + M·D⊥² + m·k².
  const dx = r.x - c0.x;
  const dy = r.y - c0.y;
  const dz = r.z - c0.z;
  const ex = cg.x - c0.x;
  const ey = cg.y - c0.y;
  const ez = cg.z - c0.z;
  const own = m * rider.gyration * rider.gyration;
  const floor = inertiaFromGyration(mass, model.spec.gyration);
  const axis = (i0: number, d2: number, e2: number, min: number): number =>
    Math.max(0.5 * min, i0 - m * d2 - mass * e2 - own);
  const inertia = vec3(
    axis(model.inertia.x, dy * dy + dz * dz, ey * ey + ez * ez, floor.x),
    axis(model.inertia.y, dx * dx + dz * dz, ex * ex + ez * ez, floor.y),
    axis(model.inertia.z, dx * dx + dy * dy, ex * ex + ey * ey, floor.z),
  );
  return { mass, cg, inertia };
}
