// Pure game-feel helpers for the app: gamepad rumble for slams and collisions, winch clicks from the
// sail telemetry, the HUD alert after a collision, and the capsize card's content.

import type { SpeedUnit } from '../sim/core/units';
import { SAIL_KEYS } from '../sim/sail/telemetry';
import { formatSpeed } from '../ui/hud/format';
import type { CapsizeCardModel, HudAlert, InputDeviceKind } from '../ui/hud/model';
import { formatDuration } from '../ui/menu/setup';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface Rumble {
  strong: number; // 0..1 low-frequency motor
  weak: number; // 0..1 high-frequency motor
  ms: number;
}

// A hull slam on the helm boat (impact speed, m/s): light slaps buzz, hard slams thump.
export function rumbleForSlam(strength: number): Rumble | null {
  if (!(strength >= 1.5)) return null;
  return {
    strong: clamp01((strength - 1.5) / 6.5),
    weak: clamp01(strength / 5),
    ms: Math.min(320, 80 + 25 * strength),
  };
}

// Hitting another boat (closing speed, m/s): heavier and longer than a slam.
export function rumbleForCollision(speed: number): Rumble | null {
  if (!(speed > 0.3)) return null;
  return { strong: clamp01(speed / 4), weak: clamp01(speed / 2.5), ms: Math.min(600, 200 + 80 * speed) };
}

const WINCH_LINE = 0.3; // m of sheet ground in per click
const WINCH_GAP = 0.18; // minimum s between clicks
const REEF_LINE = 2.5; // "metres" of line per whole reef / furl (reefProgress and jibFurl are 0..n)

// Winch clicks from a sailboat's telemetry: sheets ground in (by hand or auto-trim), reefs tucked or
// shaken out, the genoa furled. Easing a sheet runs it off the drum without the pawls clicking.
export class WinchTracker {
  private last: { main: number; jib: number; reef: number; furl: number } | null = null;
  private line = 0;
  private gap = 0;

  update(t: Readonly<Record<string, number>>, dt: number): number {
    const now = {
      main: t[SAIL_KEYS.mainSheetLength] ?? 0,
      jib: t[SAIL_KEYS.jibSheetLength] ?? 0,
      reef: t[SAIL_KEYS.reefProgress] ?? 0,
      furl: t[SAIL_KEYS.jibFurl] ?? 0,
    };
    const last = this.last;
    this.last = now;
    this.gap -= dt;
    if (!last) return 0;
    const ground =
      Math.max(0, last.main - now.main) +
      Math.max(0, last.jib - now.jib) +
      Math.abs(now.reef - last.reef) * REEF_LINE +
      Math.max(0, now.furl - last.furl) * REEF_LINE;
    // The clicks stop when the grinding does.
    this.line = ground > 0 ? this.line + ground : 0;
    if (this.line < WINCH_LINE || this.gap > 0) {
      this.line = Math.min(this.line, 4 * WINCH_LINE); // don't bank a burst while waiting
      return 0;
    }
    const clicks = Math.min(2, Math.floor(this.line / WINCH_LINE));
    this.line -= clicks * WINCH_LINE;
    this.gap = WINCH_GAP;
    return clicks;
  }

  reset(): void {
    this.last = null;
    this.line = 0;
  }
}

const COLLISION_ALERT_S = 4;

// The HUD's alert after the helm boat hits another: holds a few seconds, harder hits in red.
export class CollisionAlert {
  private age = Infinity;
  private text = '';
  private severity: HudAlert['severity'] = 'warning';

  hit(otherName: string, speed: number, unit: SpeedUnit = 'kn'): void {
    this.age = 0;
    this.severity = speed > 3 ? 'danger' : 'warning';
    this.text = `Hit ${otherName} at ${formatSpeed(speed, unit)}`;
  }

  update(dt: number): HudAlert | null {
    this.age += dt;
    return this.age < COLLISION_ALERT_S
      ? { id: 'collision', severity: this.severity, text: this.text }
      : null;
  }
}

export interface RunStatsLike {
  survived: number; // s
  maxRoll: number; // rad
  slams: number;
}

// The card shown while the helm boat is over (or gone): how the voyage went and how to recover.
export function capsizeCard(
  stats: RunStatsLike,
  options: { device: InputDeviceKind; sunk?: boolean; survival?: { isBest: boolean } },
): CapsizeCardModel {
  const rows = [
    { label: 'Time afloat', value: formatDuration(stats.survived) },
    { label: 'Max roll', value: `${Math.round((stats.maxRoll * 180) / Math.PI)}°` },
    { label: 'Slams', value: String(stats.slams) },
  ];
  if (options.survival?.isBest) rows.push({ label: 'Storm Survival', value: 'New best!' });
  const recover = options.device === 'gamepad' ? 'Hold View' : 'Press Backspace';
  return {
    title: options.sunk ? 'Sunk' : 'Capsized',
    rows,
    hint: options.sunk ? 'Respawning…' : `${recover} to recover`,
  };
}
