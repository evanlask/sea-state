// COLREG light maths: sectors and cut-offs, vertical spread, intensities, colours, light sets.

import { describe, expect, it } from 'vite-plus/test';

import {
  bearingOf,
  COLREG_CHROMATICITY,
  edgeRamp,
  horizontalVisibility,
  LIGHT_COLOURS,
  lightsRequired,
  linearToChromaticity,
  luminousIntensity,
  NAUTICAL_MILE,
  type NavRole,
  navRoles,
  type NavState,
  OTHER_EDGE,
  requiredIntensity,
  requiredRangeNm,
  SECTORS,
  sectorWidth,
  SIDELIGHT_FORWARD_EDGE,
  verticalVisibility,
  VERTICAL_FLOOR_SAIL,
  visibility,
  visibleRangeNm,
  vesselClass,
} from './colregs';

const DEG = Math.PI / 180;
// Body-frame direction toward a relative bearing (degrees clockwise from the bow) and elevation.
const toward = (bearingDeg: number, elevationDeg = 0) => {
  const b = bearingDeg * DEG;
  const e = elevationDeg * DEG;
  return { x: Math.sin(b) * Math.cos(e), y: Math.sin(e), z: -Math.cos(b) * Math.cos(e) };
};
// Rounded so exact plateau values compare with toBe.
const h = (kind: keyof typeof SECTORS, bearingDeg: number): number =>
  Math.round(horizontalVisibility(SECTORS[kind], bearingDeg * DEG) * 1e9) / 1e9;

describe('sectors', () => {
  it('have the Rule 21 arcs', () => {
    expect(sectorWidth(SECTORS.masthead) / DEG).toBeCloseTo(225);
    expect(sectorWidth(SECTORS.starboard) / DEG).toBeCloseTo(112.5);
    expect(sectorWidth(SECTORS.port) / DEG).toBeCloseTo(112.5);
    expect(sectorWidth(SECTORS.stern) / DEG).toBeCloseTo(135);
    expect(sectorWidth(SECTORS.allRound) / DEG).toBeCloseTo(360);
  });

  it('measure bearings clockwise from the bow in the body frame', () => {
    expect(bearingOf({ x: 0, y: 0, z: -1 })).toBeCloseTo(0);
    expect(bearingOf({ x: 1, y: 0, z: 0 }) / DEG).toBeCloseTo(90); // starboard
    expect(bearingOf({ x: -1, y: 0, z: 0 }) / DEG).toBeCloseTo(-90); // port
    expect(Math.abs(bearingOf({ x: 0, y: 0, z: 1 })) / DEG).toBeCloseTo(180);
  });

  it('show green to starboard and red to port, both dead ahead', () => {
    expect(h('starboard', 45)).toBe(1);
    expect(h('port', 45)).toBe(0);
    expect(h('port', -45)).toBe(1);
    expect(h('starboard', -45)).toBe(0);
    expect(h('port', 0)).toBe(1);
    expect(h('starboard', 0)).toBe(1);
  });

  it('cut sidelights off 1–3° across the bow', () => {
    expect(h('starboard', -0.5)).toBeGreaterThan(0.5);
    expect(h('starboard', -1)).toBeCloseTo(0.5);
    expect(h('starboard', -SIDELIGHT_FORWARD_EDGE.outsideCutoff / DEG)).toBe(0);
    expect(h('starboard', -3)).toBe(0);
    expect(h('port', 1)).toBeCloseTo(0.5);
    expect(h('port', 3)).toBe(0);
    expect(SIDELIGHT_FORWARD_EDGE.outsideCutoff / DEG).toBeGreaterThanOrEqual(1);
    expect(SIDELIGHT_FORWARD_EDGE.outsideCutoff / DEG).toBeLessThanOrEqual(3);
  });

  it('keep full intensity to 5° inside the aft edges, ≥ 50 % at the limit, cut-off ≤ 5° outside', () => {
    expect(h('starboard', 107.5)).toBe(1);
    expect(h('starboard', 110)).toBeCloseTo(0.75);
    expect(h('starboard', 112.5)).toBeCloseTo(0.5);
    expect(h('starboard', 114.5)).toBeCloseTo(0.25);
    expect(h('starboard', 117.5)).toBe(0);
    expect(h('port', -112.5)).toBeCloseTo(0.5);
    expect(h('port', -118)).toBe(0);
    expect(OTHER_EDGE.outsideCutoff / DEG).toBeLessThanOrEqual(5);
  });

  it('hand over from masthead and sidelights to the sternlight at 22.5° abaft the beam', () => {
    for (const b of [-112.5, 112.5]) {
      expect(h('masthead', b)).toBeCloseTo(0.5);
      expect(h('stern', b)).toBeCloseTo(0.5);
    }
    expect(h('stern', 180)).toBe(1);
    expect(h('stern', -150)).toBe(1);
    expect(h('stern', 100)).toBe(0);
    expect(h('masthead', 0)).toBe(1);
    expect(h('masthead', 100)).toBe(1);
    expect(h('masthead', 120)).toBe(0);
    expect(h('masthead', 180)).toBe(0);
  });

  it('only the sternlight shows from right astern; all-round lights everywhere', () => {
    const astern = toward(180);
    expect(visibility('stern', astern)).toBeCloseTo(1, 9);
    for (const kind of ['masthead', 'port', 'starboard'] as const)
      expect(visibility(kind, astern)).toBeCloseTo(0, 9);
    for (let b = -180; b <= 180; b += 7.5) expect(h('allRound', b)).toBe(1);
  });

  it('edge ramps are continuous at the limit', () => {
    expect(edgeRamp(OTHER_EDGE, -1e-9)).toBeCloseTo(edgeRamp(OTHER_EDGE, 1e-9));
    expect(edgeRamp(SIDELIGHT_FORWARD_EDGE, -1)).toBe(1);
  });
});

describe('vertical spread', () => {
  it('meets Annex I 10', () => {
    expect(verticalVisibility(0)).toBe(1);
    expect(verticalVisibility(5 * DEG)).toBe(1);
    expect(verticalVisibility(-5 * DEG)).toBe(1);
    expect(verticalVisibility(7.5 * DEG)).toBeGreaterThanOrEqual(0.6);
    expect(verticalVisibility(25 * DEG, VERTICAL_FLOOR_SAIL)).toBeGreaterThanOrEqual(0.5);
    expect(verticalVisibility(60 * DEG)).toBeGreaterThan(0);
    expect(verticalVisibility(60 * DEG)).toBeLessThan(0.5);
  });

  it('combines with the sector', () => {
    expect(visibility('starboard', toward(45, 30))).toBeCloseTo(verticalVisibility(30 * DEG));
  });
});

describe('intensity', () => {
  it('matches the Annex I 8 table', () => {
    const table: [number, number][] = [
      [1, 0.9],
      [2, 4.3],
      [3, 12],
      [5, 52],
      [6, 94],
    ];
    for (const [nm, cd] of table) expect(luminousIntensity(nm)).toBeCloseTo(cd, cd < 10 ? 1 : 0);
  });

  it('inverts to a visible range', () => {
    expect(visibleRangeNm(luminousIntensity(3))).toBeCloseTo(3, 4);
    expect(visibleRangeNm(94)).toBeCloseTo(6, 1);
  });

  it('follows the Rule 22 ranges by length', () => {
    expect(vesselClass(243)).toBe('large');
    expect(vesselClass(38)).toBe('medium');
    expect(vesselClass(10)).toBe('small');
    expect([
      requiredRangeNm('masthead', 243),
      requiredRangeNm('port', 243),
      requiredRangeNm('stern', 243),
    ]).toEqual([6, 3, 3]);
    expect([
      requiredRangeNm('masthead', 38),
      requiredRangeNm('starboard', 38),
      requiredRangeNm('stern', 38),
    ]).toEqual([5, 2, 2]);
    expect(requiredRangeNm('masthead', 15)).toBe(3); // 12–20 m exception
    expect(requiredRangeNm('allRound', 38)).toBe(2);
    expect([
      requiredRangeNm('masthead', 10),
      requiredRangeNm('port', 10),
      requiredRangeNm('stern', 10),
    ]).toEqual([2, 1, 2]);
    expect(requiredRangeNm('allRound', 10)).toBe(2);
    expect(requiredIntensity('masthead', 243)).toBeCloseTo(94, 0);
    expect(requiredIntensity('starboard', 243)).toBeCloseTo(12, 0);
    expect(requiredIntensity('masthead', 38)).toBeCloseTo(52, 0);
    expect(requiredIntensity('port', 11.5)).toBeCloseTo(0.9, 1);
  });

  it('switches on from sunset or in restricted visibility', () => {
    expect(lightsRequired(10 * DEG)).toBe(false);
    expect(lightsRequired(-2 * DEG)).toBe(true);
    expect(lightsRequired(10 * DEG, 0.5 * NAUTICAL_MILE)).toBe(true);
  });
});

describe('colours', () => {
  it('have unit luminance', () => {
    for (const c of Object.values(LIGHT_COLOURS)) {
      expect(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toBeCloseTo(1, 5);
    }
  });

  it('round-trip their chromaticities and sit in or next to the COLREG regions', () => {
    for (const key of ['white', 'green'] as const) {
      const [x, y] = linearToChromaticity(LIGHT_COLOURS[key]);
      expect(x).toBeCloseTo(COLREG_CHROMATICITY[key][0], 3);
      expect(y).toBeCloseTo(COLREG_CHROMATICITY[key][1], 3);
    }
    const [wx, wy] = linearToChromaticity(LIGHT_COLOURS.white);
    expect(wx).toBeGreaterThan(0.31);
    expect(wx).toBeLessThan(0.5);
    expect(wy).toBeGreaterThan(0.28);
    expect(wy).toBeLessThan(0.44);
    const [rx, ry] = linearToChromaticity(LIGHT_COLOURS.red);
    expect(rx).toBeGreaterThan(0.63);
    expect(ry).toBeLessThan(0.34);
    const [gx, gy] = linearToChromaticity(LIGHT_COLOURS.green);
    expect(gx).toBeLessThan(0.3);
    expect(gy).toBeGreaterThan(0.385);
    const [yx, yy] = linearToChromaticity(LIGHT_COLOURS.yellow);
    expect(yx).toBeGreaterThan(0.57);
    expect(yy).toBeGreaterThan(0.33);
  });
});

describe('light sets', () => {
  const state = (signals: NavState['signals'] = {}, makingWay = true): NavState => ({
    on: true,
    makingWay,
    signals,
  });
  const set = (roles: NavRole[]): string[] => [...roles].sort();

  it('are empty with the lights off', () => {
    expect(navRoles('cargo', { on: false, makingWay: true, signals: { nuc: true } })).toEqual([]);
  });

  it('underway: two mastheads on ships, one on the crabber, all-round white on the console boat', () => {
    expect(set(navRoles('cargo', state()))).toEqual(
      set(['masthead', 'mastheadAft', 'port', 'starboard', 'stern']),
    );
    expect(set(navRoles('cruise', state()))).toEqual(
      set(['masthead', 'mastheadAft', 'port', 'starboard', 'stern']),
    );
    expect(set(navRoles('crab', state()))).toEqual(set(['masthead', 'port', 'starboard', 'stern']));
    expect(set(navRoles('powerboat', state()))).toEqual(set(['port', 'starboard', 'allRoundWhite']));
    expect(navRoles('pwc', state())).toEqual(['allRoundWhite']);
  });

  it('sail: sidelights and sternlight, or the masthead tricolour', () => {
    expect(set(navRoles('sail', state()))).toEqual(set(['port', 'starboard', 'stern']));
    expect(set(navRoles('sail', state({ tricolour: true })))).toEqual(
      set(['tricolourPort', 'tricolourStarboard', 'tricolourStern']),
    );
    expect(navRoles('sail', state({ tricolour: true, anchor: true }))).toEqual(['anchorForward']);
  });

  it('NUC: two all-round red, plus sidelights and sternlight only when making way', () => {
    expect(set(navRoles('cargo', state({ nuc: true }, false)))).toEqual(
      set(['signalRedUpper', 'signalRedLower']),
    );
    expect(set(navRoles('cargo', state({ nuc: true }, true)))).toEqual(
      set(['signalRedUpper', 'signalRedLower', 'port', 'starboard', 'stern']),
    );
    expect(navRoles('cargo', state({ nuc: true, anchor: true }))).toEqual(['anchorForward', 'anchorAft']);
  });

  it('RAM: red-white-red plus the underway set when making way, anchor lights at anchor', () => {
    const ram = ['signalRedUpper', 'signalWhite', 'signalRedLower'] as NavRole[];
    expect(set(navRoles('cruise', state({ ram: true }, false)))).toEqual(set(ram));
    expect(set(navRoles('cruise', state({ ram: true })))).toEqual(
      set([...ram, 'masthead', 'mastheadAft', 'port', 'starboard', 'stern']),
    );
    expect(set(navRoles('cruise', state({ ram: true, anchor: true })))).toEqual(
      set([...ram, 'anchorForward', 'anchorAft']),
    );
  });

  it('fishing (pots): red over white, no masthead, sidelights and sternlight when making way', () => {
    expect(set(navRoles('crab', state({ fishing: true })))).toEqual(
      set(['signalRedUpper', 'signalWhite', 'port', 'starboard', 'stern']),
    );
    expect(set(navRoles('crab', state({ fishing: true }, false)))).toEqual(
      set(['signalRedUpper', 'signalWhite']),
    );
    expect(set(navRoles('crab', state({ fishing: true, anchor: true })))).toEqual(
      set(['signalRedUpper', 'signalWhite']),
    );
  });

  it('anchor: two whites on ≥ 50 m, one below', () => {
    expect(set(navRoles('cargo', state({ anchor: true })))).toEqual(set(['anchorForward', 'anchorAft']));
    expect(navRoles('crab', state({ anchor: true }))).toEqual(['anchorForward']);
    expect(navRoles('powerboat', state({ anchor: true }))).toEqual(['anchorForward']);
  });

  it('ignore signals a boat does not carry', () => {
    expect(set(navRoles('cargo', state({ fishing: true })))).toEqual(set(navRoles('cargo', state())));
    expect(set(navRoles('powerboat', state({ nuc: true })))).toEqual(set(navRoles('powerboat', state())));
    expect(navRoles('pwc', state({ anchor: true }))).toEqual(['allRoundWhite']);
    expect(set(navRoles('crab', state({ tricolour: true })))).toEqual(set(navRoles('crab', state())));
  });
});
