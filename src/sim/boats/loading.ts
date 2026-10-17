// Loading conditions: the setup screen's choice (the cargo ship laden or in ballast, the crab boat's
// pot count) → a LoadingCondition, and a boat model rebuilt for it. The hull keeps its shape; the
// load changes the mass, KG (and so GM), the draft it floats at, its inertia and its windage. The
// design condition is the committed calibration's, so a design-load boat uses the shared model.

import { DEG } from '../core/conventions';
import { RHO_SEAWATER } from '../core/units';
import type { BoatModel } from '../physics/boatModel';
import { Hydrostatics } from '../physics/hydrostatics';
import { inertiaFromGyration } from '../physics/RigidBody';
import type { BoatKind, BoatLoad } from '../world/protocol';
import type { BoatSpec, LoadingCondition, PotStackSpec } from './BoatSpec';
import { BOAT_SPECS } from './specs/index';

export interface PotStack {
  count: number;
  tiers: number; // tiers started (the top one may be part full)
  centreHeight: number; // m above the design waterline, mean over the pots
  lateralArea: number; // m² above the bulwark, solidity applied
}

export function potStack(spec: PotStackSpec, pots: number): PotStack {
  // A NaN count (a bad deep link) is no pots rather than a NaN mass.
  const count = Number.isNaN(pots) ? 0 : Math.max(0, Math.min(spec.maxPots, Math.round(pots)));
  const p = spec.perTier;
  const full = Math.floor(count / p);
  const rest = count - full * p;
  // Mean tier centre over the pots: full tiers 0..k−1 plus the part tier k.
  const meanTier = count > 0 ? ((p * full * full) / 2 + rest * (full + 0.5)) / count : 0;
  const height = (count / p) * spec.tierHeight;
  return {
    count,
    tiers: Math.ceil(count / p),
    centreHeight: spec.deckHeight + meanTier * spec.tierHeight,
    lateralArea: Math.max(0, height - spec.bulwark) * spec.length * spec.solidity,
  };
}

// The condition a boat sails in, or null for its design condition.
export function loadingConditionFor(kind: BoatKind, load: BoatLoad | undefined): LoadingCondition | null {
  const spec = BOAT_SPECS[kind];
  if (!load) return null;
  if (spec.potStack && load.crabPots !== undefined) {
    const stack = potStack(spec.potStack, load.crabPots);
    if (stack.count === 0) return null;
    return {
      name: `${stack.count} pots`,
      extraMass: stack.count * spec.potStack.potMass,
      extraMassHeight: stack.centreHeight,
      extraLateralArea: stack.lateralArea,
    };
  }
  if (kind === 'cargo' && load.cargo === 'ballast') {
    return spec.loadingConditions?.find((c) => c.name === 'ballast') ?? null;
  }
  return null;
}

// Telemetry describing the load (sim/world/telemetry.ts): the renderer shows the pots and boxes.
export function loadTelemetry(kind: BoatKind, load: BoatLoad | undefined): Record<string, number> {
  const spec = BOAT_SPECS[kind];
  if (spec.potStack) return { crabPots: potStack(spec.potStack, load?.crabPots ?? 0).count };
  if (kind === 'cargo') return { ballast: load?.cargo === 'ballast' ? 1 : 0 };
  return {};
}

export interface LoadedModel extends BoatModel {
  condition: LoadingCondition | null;
  restHeight: number; // body-origin height above still water at rest (− = deeper than designed)
  avs: number; // rad, angle of vanishing stability in this condition
}

function loadedSpec(spec: BoatSpec, c: LoadingCondition): BoatSpec {
  const w = spec.windage;
  const lateral = Math.max(0.3 * w.lateralArea, w.lateralArea + (c.extraLateralArea ?? 0));
  // Frontal area follows the side area's proportion (stacks and topsides are as wide as the hull).
  const frontal = w.frontalArea * (lateral / w.lateralArea);
  return {
    ...spec,
    mass: spec.mass + c.extraMass,
    windage: { ...w, lateralArea: lateral, frontalArea: frontal },
  };
}

// The design model rebuilt for a loading condition: same hull mesh, new mass and CG height, with GM,
// the rest draft and the AVS solved from the hydrostatics. `designAvs` is the calibrated AVS used
// when the condition is the design one.
export function loadedBoatModel(
  design: BoatModel,
  condition: LoadingCondition | null,
  designAvs: number,
): LoadedModel {
  if (!condition) return { ...design, condition: null, restHeight: 0, avs: designAvs };
  const spec = loadedSpec(design.spec, condition);
  const mass = spec.mass;
  // Body frame y: 0 = design waterline. The load sits over the centre of buoyancy (no trim change).
  const yG = (design.mass * design.cg.y + condition.extraMass * condition.extraMassHeight) / mass;
  const cg = { x: design.cg.x, y: yG, z: design.cg.z };
  const volume = mass / RHO_SEAWATER;
  const hydro = new Hydrostatics(design.buoyant);
  const eq = hydro.equilibrium(cg, volume, 0, true);
  const curve = hydro.gzCurve(cg, volume, { step: 5 * DEG });
  const draft = design.spec.dimensions.draft;
  const restHeight = eq.height - yG;
  return {
    ...design,
    spec,
    mass,
    designVolume: volume,
    design: eq.hydro,
    cg,
    inertia: inertiaFromGyration(mass, spec.gyration),
    kb: eq.hydro.centre.y - restHeight + draft, // the keel is at body y = −draft
    bm: eq.hydro.waterplaneIxx / volume,
    kg: yG + draft,
    gm: curve.gm,
    condition,
    restHeight,
    avs: curve.avs,
  };
}

const cache = new Map<string, LoadedModel>();

// Cached per kind and condition (the GZ curve takes a moment); design-condition models are shared.
export function cachedLoadedModel(
  kind: BoatKind,
  design: BoatModel,
  condition: LoadingCondition | null,
  designAvs: number,
): LoadedModel {
  const key = condition
    ? `${kind}|${condition.extraMass}|${condition.extraMassHeight}|${condition.extraLateralArea ?? 0}`
    : kind;
  let model = cache.get(key);
  if (!model) {
    model = loadedBoatModel(design, condition, designAvs);
    cache.set(key, model);
  }
  return model;
}
