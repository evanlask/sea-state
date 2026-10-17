// Picks which body drives the scene's single directional light. Pure TS.
//
// The sun drives it while any of its disk is above the horizon (its illuminance already fades to
// zero as it sets). Once the sun is down the light jumps to the moon, whose weight ramps up through
// civil twilight so the switch is invisible: at that point the sky outshines both.

export type LightSource = 'sun' | 'moon' | 'none';

export interface LightSourceChoice {
  source: LightSource;
  weight: number; // 0..1 multiplier on the chosen body's illuminance
}

const DEG = Math.PI / 180;
const MOON_FADE_START = -0.6 * DEG; // sun elevation where the moon starts to take over
const MOON_FADE_END = -5 * DEG; // sun elevation where the moon has full weight

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export function chooseLightSource(
  sunElevation: number,
  sunLuminance: number,
  moonLuminance: number,
): LightSourceChoice {
  if (sunElevation > MOON_FADE_START && sunLuminance > 0) return { source: 'sun', weight: 1 };
  const weight = smoothstep(MOON_FADE_START, MOON_FADE_END, sunElevation);
  if (moonLuminance > 0 && weight > 0) return { source: 'moon', weight };
  return { source: 'none', weight: 0 };
}
