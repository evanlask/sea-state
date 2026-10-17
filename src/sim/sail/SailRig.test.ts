import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { type Vec3, vec3 } from '../core/math';
import {
  CC115_RIG,
  genoaCentre,
  genoaPlan,
  MAIN_HEADBOARD,
  mainCentre,
  mainCut,
  mainCutChord,
  mainPlan,
  reefDepth,
} from './rig';
import { SailRig, type SailRigInputs } from './SailRig';

// Body-frame air moving away from an apparent wind angle `awa` off the bow (+ from starboard).
const airFrom = (out: Vec3, awaDeg: number, speed: number): Vec3 => {
  out.x = -Math.sin(awaDeg * DEG) * speed;
  out.y = 0;
  out.z = Math.cos(awaDeg * DEG) * speed;
  return out;
};

function run(
  rig: SailRig,
  awaDeg: number,
  speed: number,
  seconds: number,
  extra: Partial<SailRigInputs> = {},
): void {
  const input: SailRigInputs = {
    dt: 1 / 240,
    mainAir: airFrom(vec3(), awaDeg, speed),
    jibAir: airFrom(vec3(), awaDeg, speed),
    gravity: vec3(0, -9.81, 0),
    heel: 0,
    mainSheet: 0,
    jibSheet: 0,
    arcade: false,
    ...extra,
  };
  for (let t = 0; t < seconds; t += input.dt) {
    rig.step(input);
    expect(Math.abs(rig.boomAngle)).toBeLessThanOrEqual(rig.mainSheetLimit + 1e-9);
    expect(Math.abs(rig.jibAngle)).toBeLessThanOrEqual(rig.jibSheetLimit + 1e-9);
  }
}

describe('rig geometry', () => {
  it('matches the measured sail areas and a 16.5–17 m mast', () => {
    expect(mainPlan(CC115_RIG, 0).area).toBeCloseTo(CC115_RIG.mainArea, 6);
    expect(genoaPlan(CC115_RIG, 0).area).toBeCloseTo(CC115_RIG.genoaArea, 6);
    expect(CC115_RIG.mastheadY).toBeGreaterThanOrEqual(16.5);
    expect(CC115_RIG.mastheadY).toBeLessThanOrEqual(17);
  });

  it('cuts the main with a small headboard and a roach, with the measured area and nearly the aero centroid', () => {
    const rig = CC115_RIG;
    const n = 4000;
    let area = 0;
    let moment = 0;
    let chordMoment = 0;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) / n;
      const c = mainCutChord(rig, s);
      area += (c * rig.P) / n;
      moment += (c * s * rig.P * rig.P) / n;
      chordMoment += ((c * c) / 2) * (rig.P / n);
      // Never past the clew, and always beyond the straight leech (a convex roach).
      expect(c).toBeLessThanOrEqual(rig.E + 1e-9);
      expect(c).toBeGreaterThanOrEqual(rig.E + (MAIN_HEADBOARD - rig.E) * s - 1e-9);
    }
    expect(mainCutChord(rig, 0)).toBeCloseTo(rig.E, 9);
    expect(mainCutChord(rig, 1)).toBeCloseTo(MAIN_HEADBOARD, 9);
    expect(MAIN_HEADBOARD).toBeGreaterThanOrEqual(0.1);
    expect(MAIN_HEADBOARD).toBeLessThanOrEqual(0.2);
    expect(area / rig.mainArea).toBeCloseTo(1, 3);
    // A pointed head: the top 5% of the luff carries well under a metre of chord.
    expect(mainCutChord(rig, 0.95)).toBeLessThan(0.75);
    // The aero model's trapezoid has the same area; its centroid is within 4% of the cut's.
    const plan = mainPlan(rig, 0);
    expect(Math.abs(moment / area / plan.ceHeight - 1)).toBeLessThan(0.04);
    expect(Math.abs(chordMoment / area / plan.ceAft - 1)).toBeLessThan(0.04);
  });

  it('reefs the cut main from the bottom: the reef clew sits on the roached leech, within the boom', () => {
    for (const reef of [0, 1, 1.5, 2, 3]) {
      const cut = mainCut(CC115_RIG, reef);
      const d = reefDepth(CC115_RIG, reef);
      expect(cut.luff).toBeCloseTo(CC115_RIG.P - d, 9);
      expect(cut.from).toBeCloseTo(d / CC115_RIG.P, 9);
      expect(cut.foot).toBeCloseTo(mainCutChord(CC115_RIG, d / CC115_RIG.P), 9);
      expect(cut.foot).toBeLessThanOrEqual(CC115_RIG.boomLength);
      // The aero model's reefed foot runs to its straight leech; the cut's is within 20 cm of it.
      expect(Math.abs(cut.foot - mainPlan(CC115_RIG, reef).foot)).toBeLessThan(0.2);
    }
  });

  it('each reef takes area off and lowers the centre of effort', () => {
    let prevArea = Infinity;
    let prevCe = Infinity;
    for (let r = 0; r <= 3; r++) {
      const plan = mainPlan(CC115_RIG, r);
      const ce = mainCentre(vec3(), CC115_RIG, plan, 0);
      expect(plan.area).toBeLessThan(prevArea);
      expect(ce.y).toBeLessThan(prevCe);
      prevArea = plan.area;
      prevCe = ce.y;
    }
    expect(mainPlan(CC115_RIG, 3).area / CC115_RIG.mainArea).toBeLessThan(0.6);
  });

  it('furling rolls the genoa away and pulls its centre of effort toward the forestay', () => {
    const full = genoaPlan(CC115_RIG, 0);
    const half = genoaPlan(CC115_RIG, 0.5);
    expect(half.area).toBeCloseTo(full.area / 2, 6);
    expect(genoaPlan(CC115_RIG, 1).area).toBeLessThan(0.01 * full.area);
    const ceFull = genoaCentre(vec3(), CC115_RIG, full, 0);
    const ceHalf = genoaCentre(vec3(), CC115_RIG, half, 0);
    expect(ceHalf.z).toBeLessThan(ceFull.z);
  });

  it('the rig animates reefing and furling toward the commanded level', () => {
    const rig = new SailRig();
    rig.setReef(2);
    rig.cycleFurl();
    run(rig, 60, 6, 12);
    expect(rig.reef).toBe(2);
    expect(rig.furl).toBeCloseTo(1 / 3, 9);
    expect(rig.main.area).toBeCloseTo(mainPlan(CC115_RIG, 2).area, 6);
  });
});

describe('trim', () => {
  it('ideal angles go out as the apparent wind goes aft, on the leeward side', () => {
    const angles = [28, 60, 90, 170].map((awa) => {
      const rig = new SailRig();
      run(rig, awa, 7, 0.1);
      expect(rig.main.ideal).toBeLessThan(0);
      expect(rig.jib.ideal).toBeLessThan(0);
      return -rig.main.ideal;
    });
    expect(angles[0]! / DEG).toBeLessThan(15);
    for (let i = 1; i < angles.length; i++) expect(angles[i]!).toBeGreaterThan(angles[i - 1]!);
    expect(angles[3]!).toBeCloseTo(CC115_RIG.boomMaxOut, 6);
    // Port tack mirrors it.
    const port = new SailRig();
    run(port, -60, 7, 0.1);
    expect(port.main.ideal).toBeCloseTo(angles[1]!, 6);
  });

  it('auto-trim settles on the ideal angles with both sails optimal', () => {
    for (const awa of [30, 75, 120]) {
      const rig = new SailRig();
      rig.autoTrim = true;
      run(rig, awa, 7, 12);
      expect(Math.abs(rig.boomAngle - rig.main.ideal) / DEG).toBeLessThan(3);
      expect(Math.abs(rig.jibAngle - rig.jib.ideal) / DEG).toBeLessThan(3);
      expect(rig.main.trim).toBe(0);
      expect(rig.jib.trim).toBe(0);
      expect(rig.telltaleJibWindward).toBeGreaterThan(0.9);
    }
  });

  it('over-eased sails luff and flog; over-trimmed ones stall', () => {
    const eased = new SailRig();
    eased.autoTrim = false;
    eased.mainSheetLimit = 80 * DEG;
    eased.jibSheetLimit = 50 * DEG;
    run(eased, 35, 7, 8);
    expect(eased.main.trim).toBe(-1);
    expect(eased.jib.trim).toBe(-1);
    expect(eased.main.luff).toBeGreaterThan(0.5);
    expect(eased.telltaleJibWindward).toBeLessThan(0.5);

    const tight = new SailRig();
    tight.autoTrim = false;
    tight.mainSheetLimit = 5 * DEG;
    tight.jibSheetLimit = 8 * DEG;
    run(tight, 100, 7, 5);
    expect(tight.main.trim).toBe(1);
    expect(tight.jib.trim).toBe(1);
    expect(tight.telltaleMainLeech).toBeLessThan(0);
    expect(tight.telltaleJibLeeward).toBeLessThan(0);
  });

  it('sheet inputs are rates and take over from auto-trim', () => {
    const rig = new SailRig();
    rig.autoTrim = true;
    run(rig, 90, 7, 3);
    const before = rig.mainSheetLimit;
    run(rig, 90, 7, 1, { mainSheet: 1 });
    expect(rig.autoTrim).toBe(false);
    expect(before - rig.mainSheetLimit).toBeCloseTo(8 * DEG, 2);
  });

  it('letting fly runs both sheets out while held; auto-trim takes them back after', () => {
    const rig = new SailRig();
    rig.autoTrim = true;
    run(rig, 60, 7, 6);
    const trimmed = rig.mainSheetLimit;
    run(rig, 60, 7, 2, { letFly: true, mainSheet: 1 });
    expect(rig.mainSheetLimit).toBe(CC115_RIG.boomMaxOut);
    expect(rig.jibSheetLimit).toBe(CC115_RIG.jibMaxOut);
    expect(Math.abs(rig.boomAngle)).toBeGreaterThan(trimmed + 20 * DEG);
    expect(rig.autoTrim).toBe(true);
    run(rig, 60, 7, 6);
    expect(Math.abs(rig.mainSheetLimit - trimmed) / DEG).toBeLessThan(3);

    const manual = new SailRig();
    manual.autoTrim = false;
    manual.mainSheetLimit = 20 * DEG;
    run(manual, 60, 7, 1, { letFly: true });
    run(manual, 60, 7, 1);
    expect(manual.mainSheetLimit).toBe(CC115_RIG.boomMaxOut);
  });

  it('the arcade light-air assist keeps the sails drawing in a near calm', () => {
    const calm = new SailRig();
    run(calm, 70, 0.8, 3);
    const assisted = new SailRig();
    run(assisted, 70, 0.8, 3, { arcade: true });
    expect(assisted.lightAir).toBe(true);
    expect(Math.hypot(assisted.main.force.x, assisted.main.force.z)).toBeGreaterThan(
      10 * Math.hypot(calm.main.force.x, calm.main.force.z),
    );
  });
});

describe('boom and genoa hinges', () => {
  it('an accidental gybe: the wind crossing the stern slams the boom across into the sheet', () => {
    const rig = new SailRig();
    rig.autoTrim = false;
    rig.mainSheetLimit = 80 * DEG;
    // Running on starboard tack: boom out to port.
    run(rig, 172, 6, 6);
    expect(rig.boomAngle / DEG).toBeLessThan(-70);
    const crossings = rig.boom.crossings;
    // The wind goes by the lee (now from the port quarter): the boom comes across.
    run(rig, -168, 6, 6);
    expect(rig.boomAngle / DEG).toBeGreaterThan(70);
    expect(rig.boom.crossings).toBe(crossings + 1);
    expect(rig.boom.impacts).toBeGreaterThanOrEqual(1);
    expect(rig.boom.lastImpactSpeed).toBeGreaterThan(2);
  });

  it('a sheeted-in boom crosses gently on a tack and stays within the sheet', () => {
    const rig = new SailRig();
    rig.autoTrim = false;
    rig.mainSheetLimit = 8 * DEG;
    run(rig, 35, 7, 4);
    expect(rig.boomAngle).toBeLessThan(0);
    // Tacking through head to wind over 4 s.
    for (let awa = 35; awa >= -35; awa -= 1) run(rig, awa, 7, 4 / 70);
    run(rig, -35, 7, 2);
    expect(rig.boomAngle).toBeGreaterThan(0);
    expect(rig.boom.lastImpactSpeed).toBeLessThan(1.5);
  });

  it('the genoa switches sides on a tack, the clew following the leeward sheet', () => {
    const rig = new SailRig();
    rig.autoTrim = true;
    run(rig, 40, 7, 5);
    expect(rig.jibAngle).toBeLessThan(0);
    expect(rig.jib.clew.x).toBeLessThan(0);
    run(rig, -40, 7, 5);
    expect(rig.jibAngle).toBeGreaterThan(0);
    expect(rig.jib.clew.x).toBeGreaterThan(0);
    expect(rig.jibHinge.crossings).toBeGreaterThanOrEqual(1);
  });

  it('heeled in a calm, gravity swings the eased boom to the low side', () => {
    const rig = new SailRig();
    rig.autoTrim = false;
    rig.mainSheetLimit = 60 * DEG;
    // Starboard down: gravity has a +x component in the body frame.
    const g = vec3(9.81 * Math.sin(15 * DEG), -9.81 * Math.cos(15 * DEG), 0);
    run(rig, 0, 0, 10, { gravity: g, heel: 15 * DEG });
    expect(rig.boomAngle / DEG).toBeGreaterThan(55);
  });
});
