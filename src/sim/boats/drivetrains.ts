// Assembles each boat's force modules: drive train (sized from the committed
// calibration), MMG hull forces for the ships, the calibrated resistance
// table, appendage foils and added-mass Coriolis terms, the planing hulls'
// carve into turns and the drag of sliding in them, fin stabilisers, deck water,
// downflooding and breaking-wave impacts, a hydroplane's aerodynamics, and for the sailboat the
// sail module.

import { AddedMassCoriolis } from '../physics/addedMassCoriolis';
import { BoatDynamics } from '../physics/BoatDynamics';
import { type BoatModel, buildBoatModel } from '../physics/boatModel';
import { BreakingWaves, breakingSpecFromHull, DeckWater, Flooding } from '../physics/flooding';
import { HydroAero } from '../physics/hydroAero';
import { kijimaDerivatives, KCS_DERIVATIVES, MmgHull } from '../physics/mmg';
import type { ForceModule } from '../physics/modules';
import { PlaningCarve } from '../physics/planingCarve';
import { PlaningSlip } from '../physics/planingSlip';
import { Azipod } from '../physics/propulsion/azipod';
import { FinStabilizers } from '../physics/propulsion/finStabilizers';
import { FixedFoil, HelmFoil } from '../physics/propulsion/foilModules';
import { JetDrive } from '../physics/propulsion/jet';
import { Outboard } from '../physics/propulsion/outboard';
import type { PropellerCurve } from '../physics/propulsion/propeller';
import { RiderBalance } from '../physics/propulsion/rider';
import { BowThruster, ShaftPropeller, ShipRudder } from '../physics/propulsion/ship';
import { SurfaceProp } from '../physics/propulsion/surfaceProp';
import { ResidualResistance } from '../physics/resistanceModule';
import { physicsTuning, type PhysicsTuning } from '../physics/tuning';
import { createSailModule } from '../sail/sailModule';
import type { BoatKind } from '../world/protocol';
import type { BoatSpec } from './BoatSpec';
import { type BoatCalibration, CALIBRATION } from './calibration/index';
import { DRIVE_CONFIGS } from './driveConfig';
import { BOAT_SPECS } from './specs/index';

const models = new Map<BoatKind, BoatModel>();

// Built once per kind (hull generation and hydrostatics take a few ms).
export function boatModel(kind: BoatKind): BoatModel {
  let m = models.get(kind);
  if (!m) {
    m = buildBoatModel(BOAT_SPECS[kind]);
    models.set(kind, m);
  }
  return m;
}

function curve(kind: BoatKind, cal: BoatCalibration = CALIBRATION[kind]): PropellerCurve {
  const p = cal.propeller;
  if (!p) throw new Error(`No propeller calibration for ${kind}; run scripts/calibrate.ts`);
  return { diameter: p.diameter, kt0: p.kt0, j0: p.j0, kq0: p.kq0, j0q: p.j0q };
}

const isMmg = (spec: BoatSpec): boolean => !spec.kerner.horizontalVelocityTerms;

function driveModules(kind: BoatKind, model: BoatModel, cal: BoatCalibration): ForceModule[] {
  const spec = model.spec;
  const cfg = DRIVE_CONFIGS[kind];
  const steerMax = spec.propulsion.steeringMaxAngle ?? 0.6;
  const steerRate = spec.propulsion.steeringRate ?? 0.5;
  switch (cfg.kind) {
    case 'shaft': {
      const shaft = new ShaftPropeller({
        engine: cfg.engine,
        propeller: curve(kind, cal),
        position: cfg.position,
        wake: cfg.wake,
        thrustDeduction: cfg.thrustDeduction,
      });
      const out: ForceModule[] = [shaft];
      const rudderFoil = spec.foils.find((f) => f.kind === 'rudder');
      if (rudderFoil && cfg.rudder) {
        out.push(
          new ShipRudder(
            {
              foil: rudderFoil,
              maxAngle: rudderFoil.maxDeflection ?? steerMax,
              rate: steerRate,
              length: spec.dimensions.lwl,
              wake: cfg.wake,
              interaction: cfg.rudder,
            },
            shaft,
          ),
        );
      }
      if (cfg.thruster) out.push(new BowThruster({ ...cfg.thruster, fadeSpeed: 2.8 }));
      return out;
    }
    case 'pods': {
      const c = curve(kind, cal);
      // Readout scale: one pod's thrust at full power and top speed.
      const p = cal.propeller!;
      const n = cfg.engine.ratedRpm / 60;
      const fullThrust = p.kt0 * (1 - p.jDesign / p.j0) * 1025 * n * n * p.diameter ** 4;
      const out: ForceModule[] = cfg.positions.map(
        (position, index) =>
          new Azipod({
            index,
            position,
            engine: cfg.engine,
            propeller: c,
            wake: cfg.wake,
            thrustDeduction: cfg.thrustDeduction,
            maxAngle: cfg.maxAngle,
            rate: cfg.rate,
            housing: { ...cfg.housing, centre: { x: position.x, y: position.y + 2.5, z: position.z } },
            fullThrust,
          }),
      );
      out.push(new BowThruster({ ...cfg.thruster, fadeSpeed: 2.8 }));
      return out;
    }
    case 'outboards': {
      const c = curve(kind, cal);
      return cfg.positions.map(
        (position, index) =>
          new Outboard({
            index,
            position,
            engine: cfg.engine,
            gearRatio: cfg.gearRatio,
            propeller: c,
            wake: cfg.wake,
            thrustDeduction: cfg.thrustDeduction,
            maxSteer: cfg.maxSteer,
            steerRate: cfg.steerRate,
            trimMin: cfg.trimMin,
            trimMax: cfg.trimMax,
            trimRate: cfg.trimRate,
            lowerUnit: {
              name: 'lower unit',
              kind: 'fin',
              centre: { x: position.x, y: position.y + 0.15, z: position.z + 0.05 },
              spanAxis: { x: 0, y: -1, z: 0 },
              chordAxis: { x: 0, y: 0, z: 1 },
              span: 0.4,
              area: 0.1,
              effectiveAspectRatio: 1.6,
            },
          }),
      );
    }
    case 'jet': {
      const k = cal.jetPumpConstant;
      if (k === null) throw new Error('No jet calibration; run scripts/calibrate.ts');
      return [
        new JetDrive({ ...cfg, pumpConstant: k }),
        new RiderBalance(spec.rider?.mass ?? 90, spec.carve?.maxBank ?? 0),
      ];
    }
    case 'surfaceProp':
      return [
        new SurfaceProp({
          turbine: cfg.turbine,
          propeller: curve(kind, cal),
          position: cfg.position,
          shaftAngle: cfg.shaftAngle,
          verticalForce: cfg.verticalForce,
          wake: cfg.wake,
          thrustDeduction: cfg.thrustDeduction,
          rudder: cfg.rudder,
          maxRudder: steerMax,
          rudderRate: steerRate,
        }),
      ];
    case 'sail':
      return sailModules(spec);
  }
}

function sailModules(spec: BoatSpec): ForceModule[] {
  const out: ForceModule[] = [];
  for (const foil of spec.foils) {
    if (foil.kind === 'rudder')
      out.push(new HelmFoil(foil, foil.maxDeflection ?? 0.6, spec.propulsion.steeringRate ?? 0.5));
  }
  out.push(createSailModule(spec));
  return out;
}

// `cal` defaults to the committed calibration (scripts/calibrate.ts passes trial ones).
export function createModules(
  kind: BoatKind,
  model: BoatModel = boatModel(kind),
  cal: BoatCalibration = CALIBRATION[kind],
): ForceModule[] {
  const spec = model.spec;
  const modules: ForceModule[] = [];
  if (isMmg(spec)) {
    const d = spec.dimensions;
    const cb = model.designVolume / (d.lwl * d.beam * d.draft);
    modules.push(
      new MmgHull({
        length: d.lwl,
        draft: d.draft,
        derivatives: kind === 'cargo' ? KCS_DERIVATIVES : kijimaDerivatives(d.lwl, d.beam, d.draft, cb),
        forceDepth: -d.draft / 2,
        surgeAddedMass: model.mass * spec.addedMass.surge,
        swayAddedMass: model.mass * spec.addedMass.sway,
      }),
    );
  } else {
    // Keels and skegs (MMG hulls have them in their derivatives), and the added-mass
    // Coriolis terms the MMG module makes for the ships.
    for (const foil of spec.foils) if (foil.kind !== 'rudder') modules.push(new FixedFoil(foil));
    modules.push(new AddedMassCoriolis());
  }
  modules.push(
    new ResidualResistance(
      { speeds: cal.speeds, perArea: cal.residualPerArea },
      -spec.dimensions.draft / 3,
      spec.dimensions.lwl,
    ),
  );
  modules.push(...driveModules(kind, model, cal));
  if (spec.aero) modules.push(new HydroAero(spec.aero));
  if (spec.carve) modules.push(new PlaningCarve(spec.carve));
  if (spec.slip) modules.push(new PlaningSlip(spec.slip));
  if (spec.finStabilizers) modules.push(new FinStabilizers(spec.finStabilizers));
  if (spec.openVolumes.length) modules.push(new DeckWater(spec.openVolumes, model.hull));
  if (spec.openings?.length && spec.compartments?.length)
    modules.push(new Flooding(spec.openings, spec.compartments));
  modules.push(new BreakingWaves(breakingSpecFromHull(model.hull, spec.dimensions.lwl), spec.dimensions.lwl));
  return modules;
}

export function createBoatDynamics(
  kind: BoatKind,
  tuning: PhysicsTuning = physicsTuning(kind, 'arcade'),
): BoatDynamics {
  const model = boatModel(kind);
  return new BoatDynamics(model, { modules: createModules(kind, model), tuning });
}
