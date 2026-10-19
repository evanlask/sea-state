// Alert thresholds: turns the boat's state into the HUD's transient alerts. Pure and
// stateless apart from the previous frame's alert ids, which give each threshold some
// hysteresis so an alert doesn't flicker as a value hovers around it.
//
// Capsizing is a skill here: the alerts are how a player learns to read the danger, so each
// says in plain words what is risky and what to do (a short headline, then an action line).
// Things a gauge already shows, or that the player can't act on, stay off the strip.

import { BOAT_LENGTH } from '../../app/Scenario';
import { DEG, signedAngle } from '../../sim/core/conventions';
import { convertSpeed, GRAVITY } from '../../sim/core/units';
import type { BoatKind } from '../../sim/world/protocol';
import { closestApproach, trackFrom } from './cpa';
import {
  DEFAULT_UNITS,
  formatDegrees,
  formatDuration,
  formatPercent,
  formatRange,
  type HudUnits,
  relativeSector,
  SPEED_UNIT_LABEL,
} from './format';
import type { FleetEntry, HudAlert, HudSeverity, StabilityInfo } from './model';

export interface AlertInput {
  kind: BoatKind;
  speed: number; // m/s
  heading: number;
  cog: number;
  roll: number;
  pitch?: number; // rad, + bow up (the hydroplane's blow-over)
  stability: StabilityInfo;
  // The sea, for the causes of a capsize: where the waves come from, how big and how long.
  waveFrom?: number; // rad true
  hs?: number; // significant wave height, m
  tp?: number; // peak period, s
  breakingHit?: boolean; // a breaking crest hit the hull hard in the last few seconds
  deckWater?: number; // 0..1 of the deck reservoir
  flooding?: number; // 0..1 of reserve buoyancy lost
  floodingRising?: boolean; // water still coming in (or was a moment ago)
  airborne?: boolean; // held a moment after landing, so a run of jumps reads as one alert
  inIrons?: boolean;
  accidentalGybe?: boolean; // held true for a moment after an uncommanded gybe
  rudder?: { angle: number; max: number } | null;
  isNight: boolean;
  navLights: boolean;
  fleet?: readonly FleetEntry[];
  units?: HudUnits;
}

interface CollisionLimits {
  cpa: number; // m
  tcpa: number; // s
}

export interface AlertThresholds {
  // The big ships don't capsize in these seas; they roll, and this much is worth a course change.
  heavyRoll: Partial<Record<BoatKind, number>>; // rad
  // Seas big enough to roll, broach or launch this boat (Hs, m); the big ships have none.
  bigSeas: Partial<Record<BoatKind, number>>;
  // Capsize risk starts this far from the danger heel toward the AVS.
  capsizeFraction: number;
  deckWater: number;
  deckAwash: number;
  flooding: number;
  beamSector: number; // rad either side of the beam that counts as waves on the side
  followingSector: number; // rad either side of the stern that counts as waves from behind
  // Running before the sea at this share of the waves' speed or faster risks surfing and broaching.
  surfSpeedFraction: number;
  hardTurn: number; // fraction of full helm that counts as a hard turn
  // The hydroplane: how far above its running trim the bow may climb at speed before the tunnel's
  // lift takes it over backwards (the margin shrinks as the air gets a grip: 3° at 100 mph, 1.2°
  // at 200), and the chop it can race through.
  hydro: {
    runningTrim: number; // rad
    margin: readonly [number, number]; // rad above the running trim at fromSpeed and topSpeed
    fromSpeed: number; // m/s, below this the air can't throw it over
    topSpeed: number; // m/s
    blowOver: number; // rad past the warning: going over now
    chopFloor: number; // m of effective chop (hs, less for long swell) worth an alert
    chopSpeed: number; // m/s safe in 0.4 m of chop; scales as (0.4 / chop)^0.75
    turnSpeed: number; // m/s above which a hard turn trips it over
    turnHelm: number; // share of full helm that counts as hard there
  };
  collision: Record<BoatKind, CollisionLimits>;
  // Thresholds relax by this factor once an alert is showing.
  hysteresis: number;
}

export const ALERT_THRESHOLDS: AlertThresholds = {
  heavyRoll: { cargo: 15 * DEG, cruise: 12 * DEG },
  bigSeas: { crab: 4, sail: 2.5, powerboat: 1.5, pwc: 1 },
  capsizeFraction: 0.5,
  deckWater: 0.15,
  deckAwash: 0.4,
  flooding: 0.01,
  beamSector: 35 * DEG,
  followingSector: 45 * DEG,
  surfSpeedFraction: 0.4,
  hardTurn: 0.6,
  hydro: {
    runningTrim: 2 * DEG,
    margin: [3 * DEG, 1.2 * DEG],
    fromSpeed: 45,
    topSpeed: 89,
    blowOver: 2.5 * DEG,
    chopFloor: 0.2,
    chopSpeed: 48,
    turnSpeed: 76, // 170 mph: from there full lock to the left trips it (half lock holds)
    turnHelm: 0.5,
  },
  collision: {
    cargo: { cpa: 926, tcpa: 12 * 60 },
    cruise: { cpa: 926, tcpa: 12 * 60 },
    crab: { cpa: 556, tcpa: 6 * 60 },
    sail: { cpa: 370, tcpa: 4 * 60 },
    powerboat: { cpa: 150, tcpa: 60 },
    pwc: { cpa: 100, tcpa: 45 },
    hydro: { cpa: 300, tcpa: 30 },
  },
  hysteresis: 0.85,
};

// A sector widens by this much once its alert is up.
const SECTOR_HYSTERESIS = 5 * DEG;

const RANK: Record<HudSeverity, number> = { danger: 0, warning: 1, info: 2 };

// Most urgent first; alerts of one severity keep their order (most important first within it).
export function sortAlerts(alerts: readonly HudAlert[]): HudAlert[] {
  return [...alerts].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// The likeliest cause of a heavy heel, and the heel alert's action line for it.
type Cause = 'breaking' | 'water' | 'turn' | 'surf' | 'beam' | 'sail' | 'other';
const HEEL_ACTION: Record<Cause, string> = {
  breaking: 'Breaking waves on your side — turn into them',
  water: 'Water on deck — slow down and let it drain',
  turn: 'Ease the turn and slow down',
  surf: 'Slow down — the waves behind are pushing you',
  beam: 'Turn to meet the waves bow-first',
  sail: 'Let fly (Space) or reef to spill wind',
  other: 'Slow down and turn into the waves',
};

// Deep-water speed of waves of the peak period, m/s.
const waveSpeed = (tp: number): number => (GRAVITY * tp) / (2 * Math.PI);

// The hydroplane's bow-high warning pitch at this speed (rad), or null when it is too slow for the
// air to throw it over.
export function bowHighPitch(speed: number, t: AlertThresholds = ALERT_THRESHOLDS): number | null {
  const h = t.hydro;
  if (speed < h.fromSpeed) return null;
  const k = Math.min(1, (speed - h.fromSpeed) / (h.topSpeed - h.fromSpeed));
  return h.runningTrim + h.margin[0] + (h.margin[1] - h.margin[0]) * k;
}

// The chop a hydroplane feels (m): the sea's Hs, less for long swell, which it rides over.
export const effectiveChop = (hs: number, tp: number): number =>
  Math.max(0, hs) * Math.min(1, (6 / Math.max(tp, 0.5)) ** 2);

// The fastest a hydroplane should race through this chop, m/s (Infinity below the floor).
export function chopSafeSpeed(chop: number, t: AlertThresholds = ALERT_THRESHOLDS): number {
  return chop < t.hydro.chopFloor ? Infinity : t.hydro.chopSpeed * (0.4 / chop) ** 0.75;
}

export function evaluateAlerts(
  input: AlertInput,
  previous: ReadonlySet<string> = new Set(),
  t: AlertThresholds = ALERT_THRESHOLDS,
): HudAlert[] {
  const alerts: HudAlert[] = [];
  const add = (id: string, severity: HudSeverity, text: string, detail?: string): void => {
    alerts.push(detail ? { id, severity, text, detail } : { id, severity, text });
  };
  const held = (id: string): boolean => previous.has(id);
  // value ≥ threshold, relaxed while the alert is already up.
  const over = (id: string, value: number, threshold: number): boolean =>
    value >= (held(id) ? threshold * t.hysteresis : threshold);
  const units = input.units ?? DEFAULT_UNITS;
  const heel = Math.abs(input.roll);
  const side = input.roll > 0 ? 'starboard' : 'port';
  const { dangerHeel, avs } = input.stability;

  // --- the sea against the boat: what rolls a small boat over or slews it sideways ---
  const bigSeas = t.bigSeas[input.kind];
  const seasHeld = held('beam-seas') || held('following-seas') || held('airborne');
  const seasBig = bigSeas !== undefined && (input.hs ?? 0) >= (seasHeld ? bigSeas * t.hysteresis : bigSeas);
  // Where the waves come from, off the bow: 0 head on, 90° on the beam, 180° from astern.
  const offBow = input.waveFrom === undefined ? null : Math.abs(signedAngle(input.waveFrom - input.heading));
  const sector = (id: string, width: number): number => (held(id) ? width + SECTOR_HYSTERESIS : width);
  const onBeam = offBow !== null && Math.abs(offBow - Math.PI / 2) <= sector('beam-seas', t.beamSector);
  const behind = offBow !== null && Math.PI - offBow <= sector('following-seas', t.followingSector);
  // Speed along the waves' travel against their own: close to it, a boat surfs down the face and slews.
  const runSpeed = behind && offBow !== null ? -input.speed * Math.cos(offBow) : 0;
  const surfing =
    seasBig && behind && over('following-seas', runSpeed, t.surfSpeedFraction * waveSpeed(input.tp ?? 0));
  const breakingSide = bigSeas !== undefined && (input.breakingHit ?? false) && onBeam;
  const water = input.deckWater ?? 0;
  const rudder = input.rudder;
  const hardTurn =
    !!rudder && rudder.max > 0 && input.speed > 3 && Math.abs(rudder.angle) / rudder.max >= t.hardTurn;

  // The likeliest cause of a heavy heel, and what to do about it.
  const cause: Cause = breakingSide
    ? 'breaking'
    : water >= t.deckWater
      ? 'water'
      : hardTurn
        ? 'turn'
        : surfing
          ? 'surf'
          : seasBig && onBeam
            ? 'beam'
            : input.kind === 'sail'
              ? 'sail'
              : 'other';

  // Stability: the worst applicable level only. Its action line names the cause, so the cause's
  // own alert below stays off while it shows.
  const capsizeHeel = dangerHeel + (avs - dangerHeel) * t.capsizeFraction;
  const heavyRoll = t.heavyRoll[input.kind];
  let explained: Cause | null = null;
  if (over('capsize-risk', heel, capsizeHeel)) {
    add('capsize-risk', 'danger', `About to capsize — ${formatDegrees(heel)} to ${side}`, HEEL_ACTION[cause]);
    explained = cause;
  } else if (over('heeling', heel, dangerHeel)) {
    add('heeling', 'warning', `Heeling hard — ${formatDegrees(heel)} to ${side}`, HEEL_ACTION[cause]);
    explained = cause;
  } else if (heavyRoll !== undefined && over('heavy-roll', heel, Math.min(heavyRoll, dangerHeel * 0.9))) {
    add(
      'heavy-roll',
      'warning',
      `Rolling heavily — ${formatDegrees(heel)} to ${side}`,
      onBeam ? 'Turn so the waves meet the bow' : 'Change course or slow down',
    );
  }

  // The causes on their own, before the heel builds: the ones to learn to read.
  if ((breakingSide || (seasBig && onBeam)) && explained !== 'breaking' && explained !== 'beam') {
    add(
      'beam-seas',
      'warning',
      breakingSide ? 'Breaking waves hitting your side' : 'Big waves on your side',
      'Turn to meet them bow-first',
    );
  }
  if (surfing && explained !== 'surf') {
    add(
      'following-seas',
      'warning',
      'Too fast with big waves behind',
      'Slow down, or a wave can spin you sideways',
    );
  }

  if (over('deck-awash', water, t.deckAwash)) {
    add(
      'deck-awash',
      'danger',
      'Deck swamped — you could capsize',
      'Slow down and keep the bow to the waves',
    );
  } else if (over('deck-water', water, t.deckWater) && explained !== 'water') {
    add('deck-water', 'warning', 'Water on deck', 'Slow down and let it drain');
  }

  const flooding = input.flooding ?? 0;
  if (over('flooding', flooding, t.flooding)) {
    if (input.floodingRising) {
      add(
        'flooding',
        'danger',
        `Taking on water — ${formatPercent(flooding)} flooded`,
        'Stay upright and slow down',
      );
    } else {
      add(
        'flooding',
        'warning',
        `Hull ${formatPercent(flooding)} flooded`,
        'The pumps are slowly clearing it',
      );
    }
  }

  // Leaving the water in a calm is fun; off the crests of big seas it's how fast boats flip.
  // Under way only: a ski bobbing clear of a crest while stopped isn't launching off anything.
  if (input.airborne && seasBig && input.speed > 4 && (input.kind === 'pwc' || input.kind === 'powerboat')) {
    add('airborne', 'warning', 'Launching off the waves', 'Ease the throttle before each crest');
  }

  if (input.kind === 'hydro') for (const alert of hydroAlerts(input, over, held, t)) alerts.push(alert);

  if (input.kind === 'sail') {
    if (input.accidentalGybe) {
      add(
        'accidental-gybe',
        'warning',
        'Accidental gybe — boom swung across',
        'Keep the wind off the stern on a run',
      );
    }
    if (input.inIrons) {
      add(
        'in-irons',
        'warning',
        'In irons — stuck head to wind',
        'Steer away from the wind to fill the sails',
      );
    }
  }

  // Jet skis carry no navigation lights (and shouldn't be out after dark anyway).
  if (input.isNight && !input.navLights && input.kind !== 'pwc') {
    add('nav-lights-off', 'info', 'Navigation lights off', 'Press 1 so other boats can see you');
  }

  for (const alert of collisionAlerts(input, previous, t, units)) alerts.push(alert);

  return sortAlerts(alerts);
}

// The hydroplane's own dangers: the bow climbing at speed (the blow-over), and racing in a chop.
function hydroAlerts(
  input: AlertInput,
  over: (id: string, value: number, threshold: number) => boolean,
  held: (id: string) => boolean,
  t: AlertThresholds,
): HudAlert[] {
  const out: HudAlert[] = [];
  const limit = bowHighPitch(input.speed, t);
  const pitch = input.pitch ?? 0;
  if (limit !== null && over('blow-over', pitch, limit + t.hydro.blowOver)) {
    out.push({
      id: 'blow-over',
      severity: 'danger',
      text: 'Blowing over — throttle off!',
      detail: 'Space cuts the power; Q trims the wing down',
    });
  } else if (limit !== null && over('bow-high', pitch, limit)) {
    out.push({
      id: 'bow-high',
      severity: 'warning',
      text: 'Bow high — ease off',
      detail: 'Ease the throttle or trim the wing down (Q)',
    });
  }
  const rudder = input.rudder;
  if (
    rudder &&
    rudder.max > 0 &&
    over('hydro-turn', input.speed, t.hydro.turnSpeed) &&
    Math.abs(rudder.angle) / rudder.max >= (held('hydro-turn') ? 0.7 : 1) * t.hydro.turnHelm
  ) {
    out.push({
      id: 'hydro-turn',
      severity: 'warning',
      text: 'Turning hard flat out — ease off',
      detail: 'Above 170 mph a hard left turn trips it over: lift first',
    });
  }
  const chop = effectiveChop(input.hs ?? 0, input.tp ?? 6);
  const safe = chopSafeSpeed(chop, t);
  if (safe < Infinity && over('hydro-chop', input.speed, held('hydro-chop') ? safe : safe * 1.05)) {
    const unit = (input.units ?? DEFAULT_UNITS).speed;
    const under = Math.max(5, Math.floor(convertSpeed(safe, unit) / 5) * 5);
    out.push({
      id: 'hydro-chop',
      severity: 'warning',
      text: 'Too fast for this chop',
      detail: `Off a crest the bow lifts and it flies: keep under ${under} ${SPEED_UNIT_LABEL[unit]}`,
    });
  }
  return out;
}

function collisionAlerts(
  input: AlertInput,
  previous: ReadonlySet<string>,
  t: AlertThresholds,
  units: HudUnits,
): HudAlert[] {
  const fleet = input.fleet;
  if (!fleet || fleet.length < 2) return [];
  const limits = t.collision[input.kind];
  const own = trackFrom(0, 0, input.cog, input.speed);
  const out: HudAlert[] = [];
  for (const other of fleet) {
    if (other.active) continue;
    const id = `collision-${other.id}`;
    const held = previous.has(id);
    const cpaLimit = held ? limits.cpa / t.hysteresis : limits.cpa;
    const tcpaLimit = held ? limits.tcpa / t.hysteresis : limits.tcpa;
    const { cpa, tcpa } = closestApproach(
      own,
      trackFrom(other.bearing, other.range, other.heading, other.speed),
    );
    // Closing means it really gets nearer: a companion keeping station alongside (CPA ≈ range)
    // isn't a collision risk, however close the formation.
    const gain = other.range - cpa;
    const closing =
      tcpa > 0 && tcpa <= tcpaLimit && cpa < cpaLimit && gain > Math.max(25, 0.25 * other.range);
    // Very near and not opening: worth a warning even without a closing track.
    const proximity = 40 + 0.25 * (BOAT_LENGTH[input.kind] + BOAT_LENGTH[other.kind]);
    const close = other.range < Math.min(cpaLimit * 0.5, proximity) && tcpa >= 0;
    if (!closing && !close) continue;
    const severity = cpa < cpaLimit / 3 && tcpa < tcpaLimit / 2 ? 'danger' : 'warning';
    const sector = relativeSector(other.bearing - input.heading);
    const range = formatRange(other.range, units);
    const where = sector === 'ahead' || sector === 'astern' ? `${range} ${sector}` : `${range} off ${sector}`;
    out.push(
      closing
        ? {
            id,
            severity,
            text: `${other.name} on a collision course`,
            detail: `${where} · closest ${formatRange(cpa, units)} in ${formatDuration(tcpa)}`,
          }
        : { id, severity, text: `${other.name} very close`, detail: where },
    );
  }
  return out;
}
