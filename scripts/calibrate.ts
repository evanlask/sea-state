// Calm-water calibration: tows each hull model through a virtual towing tank
// (surge locked, heave and pitch free), compares its resistance with the
// target method (Holtrop-Mennen for the ships and crab boat, ITTC + DSYHS-style
// residuary for the sailboat's canoe body, Savitsky / Mercier-Savitsky-style
// hump for the planing hulls), stores the residual per m² of wetted area,
// sizes each propeller (or the jet pump) so full power reaches the documented
// top speed, and exports each boat's GZ curve, AVS and downflooding angle.
//
// The hydroplane is the exception: Savitsky's prismatic hull doesn't describe two sponson pads, a
// propeller and a hull half carried by the air, so its resistance is the model's own (Kerner pads
// and hull, the aerodynamics of physics/hydroAero.ts, the windage's bluff drag, the skid fin), with
// no residuary table, and its surface-piercing propeller is sized by a virtual self-propulsion
// trial: the whole boat at full power, the design thrust and immersion corrected until it settles
// at its top speed.
//
// Usage: node scripts/calibrate.ts [kind ...]
// Writes src/sim/boats/calibration/<kind>.json (committed).

import './register-ts.ts';
import { writeFileSync } from 'node:fs';

const { BOAT_SPECS } = await import('../src/sim/boats/specs/index.ts');
const { DRIVE_CONFIGS } = await import('../src/sim/boats/driveConfig.ts');
const { buildBoatModel } = await import('../src/sim/physics/boatModel.ts');
const { Hydrostatics } = await import('../src/sim/physics/hydrostatics.ts');
const { towBoat } = await import('../src/sim/physics/towingTank.ts');
const { holtropMennen, planingResistance, yachtResistance, savitsky } =
  await import('../src/sim/physics/resistance.ts');
const { sizePropeller } = await import('../src/sim/physics/propulsion/propeller.ts');
const { BLENDERMANN, RHO_AIR_BLENDERMANN } = await import('../src/sim/physics/windage.ts');
const { createModules } = await import('../src/sim/boats/drivetrains.ts');
const { BoatDynamics } = await import('../src/sim/physics/BoatDynamics.ts');
const { physicsTuning } = await import('../src/sim/physics/tuning.ts');
const { flatWater } = await import('../src/sim/physics/water.ts');
const { neutralControls } = await import('../src/sim/world/protocol.ts');
const { RHO_SEAWATER } = await import('../src/sim/core/units.ts');

type Kind = keyof typeof BOAT_SPECS;
const kinds = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BOAT_SPECS)) as Kind[];
const DEG = Math.PI / 180;
const round = (v: number, digits = 5): number => Number(v.toPrecision(digits));

type Calibration = Parameters<typeof createModules>[2];

// Just enough calibration to build a boat's modules with this propeller and no residuary table.
function trialCalibration(propeller: Record<string, number>, top: number): Calibration {
  return {
    propeller,
    speeds: [0, 2 * top],
    residualPerArea: [0, 0],
    jetPumpConstant: null,
  } as unknown as Calibration;
}

// Virtual self-propulsion trial for a hydroplane's surface-piercing propeller: size it for a design
// thrust (and the immersion it ran at), run the whole boat at full power from rest until it settles
// (dropped into the water at 200 mph a hydroplane is launched and blows over, so it starts at rest),
// and correct the design thrust by the secant method until it settles at the top speed.
function selfPropulsion(
  kind: Kind,
  drive: Extract<(typeof DRIVE_CONFIGS)[Kind], { kind: 'surfaceProp' }>,
  top: number,
): Record<string, number> {
  const spec = BOAT_SPECS[kind];
  const model = buildBoatModel(spec);
  const n = drive.turbine.ratedRpm / 60;
  let immersion = 0.5;
  const trial = (thrust: number) => {
    const sized = sizePropeller(
      drive.diameter,
      n,
      (1 - drive.wake) * top,
      thrust / ((1 - drive.thrustDeduction) * immersion),
      drive.turbine.power / immersion,
    );
    const propeller = Object.fromEntries(Object.entries(sized).map(([k, v]) => [k, round(v)]));
    const dyn = new BoatDynamics(model, {
      modules: createModules(kind, model, trialCalibration(propeller, top)),
      tuning: physicsTuning(kind, 'realistic'),
    });
    const controls = { ...neutralControls(), throttle: 1 };
    const tel: Record<string, number> = {};
    const dt = 1 / 120;
    let v = 0;
    let imm = 0;
    let t = 0;
    let count = 0;
    let flipped = false;
    for (let step = 0; step < 70 / dt; step++) {
      dyn.step(dt, flatWater, null, step * dt, controls);
      dyn.writeTelemetry(tel);
      if (Math.abs(tel['trim']!) > 0.5 || Math.abs(tel['heel']!) > 0.5) flipped = true;
      if (step * dt >= 65) {
        v += tel['speedThroughWater']!;
        imm += 1 - tel['propEmersion']!;
        t += tel['thrust']!;
        count++;
      }
    }
    v /= count;
    immersion = imm / count;
    t /= count;
    const result = flipped
      ? 'blew over'
      : `${v.toFixed(2)} m/s (target ${top.toFixed(2)}), thrust ${(t / 1000).toFixed(2)} kN, ` +
        `immersion ${immersion.toFixed(3)}, J ${sized.jDesign.toFixed(3)}, η0 ${sized.efficiency.toFixed(3)}`;
    console.log(`${kind} self-propulsion: design ${(thrust / 1000).toFixed(2)} kN → ${result}`);
    return { v: flipped ? Number.NaN : v, propeller };
  };
  const air =
    0.5 * RHO_AIR_BLENDERMANN * top * top * spec.windage.frontalArea * BLENDERMANN[spec.windage.type].cdlHead;
  let x0 = air + 0.1 * spec.mass * 9.81;
  let r0 = trial(x0);
  if (Number.isNaN(r0.v)) throw new Error(`${kind}: blew over in the self-propulsion trial`);
  let x1 = x0 * (top / r0.v);
  for (let i = 0; i < 12; i++) {
    const r1 = trial(x1);
    if (Number.isNaN(r1.v)) throw new Error(`${kind}: blew over in the self-propulsion trial`);
    if (Math.abs(r1.v / top - 1) < 0.002) return r1.propeller;
    const x2 = x1 + ((top - r1.v) * (x1 - x0)) / (r1.v - r0.v);
    x0 = x1;
    r0 = r1;
    x1 = Math.max(0.5 * x1, Math.min(1.5 * x1, x2));
  }
  throw new Error(`${kind}: self-propulsion trial did not converge`);
}

for (const kind of kinds) {
  const spec = BOAT_SPECS[kind];
  const model = buildBoatModel(spec);
  const hull = spec.hull;
  const top = spec.propulsion.topSpeed;
  const L = spec.dimensions.lwl;

  // Stability: GZ at free trim, AVS, first downflooding angle (through an opening that can't be
  // closed weathertight, as the IMO criteria count it).
  const hs = new Hydrostatics(model.buoyant);
  const curve = hs.gzCurve(model.cg, model.designVolume, { step: 5 * DEG });
  let downflooding = Math.PI;
  for (let i = 0; i < curve.angles.length; i++) {
    const heel = curve.angles[i]!;
    const eq = hs.equilibrium(model.cg, model.designVolume, heel, true, curve.trim[i]!);
    for (const o of (spec.openings ?? []).filter((o) => !o.weathertight)) {
      const x = o.position.x - model.cg.x;
      const y = o.position.y - model.cg.y;
      const z = o.position.z - model.cg.z;
      const ch = Math.cos(-heel);
      const sh = Math.sin(-heel);
      const y1 = x * sh + y * ch;
      const wy = y1 * Math.cos(eq.trim) - z * Math.sin(eq.trim) + eq.height;
      if (wy < 0 && heel < downflooding) downflooding = heel;
    }
  }

  // Resistance target.
  let method: string;
  let target: (v: number) => number;
  // A hydroplane is towed whole (its aerodynamics and skid fin), and that is its resistance.
  const drive = DRIVE_CONFIGS[kind];
  let hydroProp: Record<string, number> | null = null;
  if (drive.kind === 'surfaceProp') hydroProp = selfPropulsion(kind, drive, top);
  const tankModules = () => (hydroProp ? createModules(kind, model, trialCalibration(hydroProp, top)) : []);
  if (hull.family === 'hydroplane') {
    method =
      'Kerner pads and hull + hydroplane aerodynamics + appendages, self-propelled (no residuary table)';
    target = (v) => towBoat(model, v, 14, 1 / 120, tankModules()).resistance;
  } else if (hull.family === 'planing') {
    method = 'Savitsky planing + Mercier-Savitsky-style hump';
    const ph = {
      mass: spec.mass,
      beam: hull.chineBeam,
      deadrise: hull.deadrise,
      lcg: model.hull.zStern - model.cg.z,
      length: L,
    };
    target = (v) => planingResistance(ph, v);
    const s = savitsky(ph, top);
    console.log(
      `${kind}: Savitsky at top speed trim ${(s.trim / DEG).toFixed(2)}°, λ ${s.wettedLengthBeams.toFixed(2)}`,
    );
  } else if (hull.family === 'sailing') {
    method = 'ITTC-57 + DSYHS-style residuary (canoe body)';
    const yh = {
      lwl: L,
      volume: model.designVolume,
      wettedArea: model.design.wettedArea,
      formFactor: spec.kerner.frictionFormFactor ?? 1.08,
    };
    target = (v) => yachtResistance(yh, v);
  } else {
    method = 'Holtrop-Mennen 1984';
    const B = hull.beamWaterline;
    const T = hull.draft;
    const rudders = spec.foils.filter((f) => f.kind === 'rudder');
    const bulb = hull.bulbRadius ?? 0;
    const transomImmersion = Math.max(0, T - hull.transomKeelHeight);
    const hh = {
      L,
      B,
      T,
      TF: T,
      volume: model.designVolume,
      lcb: (-model.design.centre.z / L) * 100,
      CM: hull.midshipCoefficient,
      CWP: model.design.waterplaneArea / (L * B),
      ABT: bulb > 0 ? 0.5 * Math.PI * bulb * bulb : 0,
      hB: 0.45 * T,
      AT: transomImmersion * B * hull.transomBeamRatio * 0.6,
      Sapp: rudders.reduce((a, f) => a + 2 * f.area, 0),
      k2app: 1.5,
      Cstern: hull.family === 'ship' ? 10 : 0,
    };
    target = (v) => holtropMennen(hh, v).total;
    console.log(
      `${kind}: HM 1+k1 ${holtropMennen(hh, top).formFactor.toFixed(3)}, S ${holtropMennen(hh, top).wettedArea.toFixed(0)} m²`,
    );
  }

  const fractions =
    hull.family === 'planing'
      ? [0.04, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3, 0.38, 0.46, 0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.15]
      : hull.family === 'hydroplane'
        ? [0.04, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3, 0.38, 0.46, 0.55, 0.65, 0.75, 0.85, 0.95, 1.0, 1.05]
        : [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.08, 1.16];
  const big = kind === 'cargo' || kind === 'cruise' || kind === 'crab';
  const speeds = [0];
  const modelR = [0];
  const targetR = [0];
  const wetted = [model.design.wettedArea];
  const sinkage = [0];
  const trim = [0];
  const perArea = [0];
  for (const f of fractions) {
    const v = f * top;
    const r = towBoat(model, v, big ? 60 : 14, 1 / 120, tankModules());
    const t = hull.family === 'hydroplane' ? r.resistance : target(v);
    speeds.push(round(v));
    modelR.push(round(r.resistance));
    targetR.push(round(t));
    wetted.push(round(r.wettedArea));
    sinkage.push(round(r.sinkage));
    trim.push(round(r.trim));
    perArea.push(round((t - r.resistance) / Math.max(r.wettedArea, 1e-3)));
    console.log(
      `${kind} V ${v.toFixed(2)} m/s: model ${(r.resistance / 1000).toFixed(2)} kN, target ${(t / 1000).toFixed(2)} kN, ` +
        `wet ${r.wettedArea.toFixed(1)} m², sink ${r.sinkage.toFixed(3)} m, trim ${(r.trim / DEG).toFixed(2)}°`,
    );
  }

  // Still-air drag at top speed (head wind of the boat's own speed).
  const bl = BLENDERMANN[spec.windage.type];
  const air = 0.5 * RHO_AIR_BLENDERMANN * top * top * spec.windage.frontalArea * bl.cdlHead;
  const rTop = target(top) + air;

  let propeller = hydroProp;
  let jetPumpConstant: number | null = null;
  if (drive.kind === 'shaft' || drive.kind === 'pods' || drive.kind === 'outboards') {
    const units = drive.kind === 'shaft' ? 1 : drive.positions.length;
    const n = drive.engine.ratedRpm / 60;
    const thrust = rTop / ((1 - drive.thrustDeduction) * units);
    const sized = sizePropeller(drive.diameter, n, (1 - drive.wake) * top, thrust, drive.engine.power);
    propeller = Object.fromEntries(Object.entries(sized).map(([k, v]) => [k, round(v)]));
    console.log(
      `${kind}: R_top ${(rTop / 1000).toFixed(1)} kN, prop J ${sized.jDesign.toFixed(3)}, η0 ${sized.efficiency.toFixed(3)}, KT0 ${sized.kt0.toFixed(3)}`,
    );
  } else if (drive.kind === 'jet') {
    const vj0 = ((2 * drive.power * drive.pumpEfficiency) / (RHO_SEAWATER * drive.nozzleArea)) ** (1 / 3);
    jetPumpConstant = round(vj0 / (drive.maxRpm / 60));
    console.log(`${kind}: R_top ${(rTop / 1000).toFixed(2)} kN, static jet ${vj0.toFixed(1)} m/s`);
  }

  const out = {
    kind,
    method,
    topSpeed: round(top),
    speeds,
    modelResistance: modelR,
    targetResistance: targetR,
    wettedArea: wetted,
    sinkage,
    trim,
    residualPerArea: perArea,
    airDragAtTop: round(air),
    propeller,
    jetPumpConstant,
    stability: {
      heel: Array.from(curve.angles, (a) => round(a)),
      gz: Array.from(curve.gz, (g) => round(g, 4)),
      avs: round(curve.avs),
      maxGz: round(curve.maxGz),
      gm: round(curve.gm),
      downflooding: round(downflooding),
    },
  };
  const path = new URL(`../src/sim/boats/calibration/${kind}.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `${kind}: AVS ${(curve.avs / DEG).toFixed(1)}°, downflooding ${(downflooding / DEG).toFixed(1)}° → ${path.pathname}`,
  );
}
