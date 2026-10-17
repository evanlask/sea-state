// Rain ripples on the sea (pure, Node-testable): how the procedural ring ripples in OceanMaterial
// scale with rain intensity. Every cell of a world-space grid starts a ring at a random spot each
// period; the share of cells that do, and the rings' slope, grow with the rain. Ripples are
// centimetres across, so beyond a few tens of metres they turn into extra roughness instead
// (their slope variance joins the GGX α² like the filtered-out waves' does).

export interface RainRippleParams {
  density: number; // 0..1 share of cells with a ring each period
  slope: number; // peak slope of a fresh ring
  period: number; // s between rings in a cell
  variance: number; // mean-square slope the rings add where they are sub-pixel
}

export const RIPPLE_CELL = 0.6; // m
export const RIPPLE_MAX_RADIUS = 0.24; // m, ring radius at the end of its life
export const RIPPLE_WAVELENGTH = 0.07; // m
const RIPPLE_PERIOD = 0.8; // s between rings in a cell
// Pixel footprints (m) where the rings are fully drawn / gone (then only roughness remains).
export const RIPPLE_FOOTPRINT_FULL = 0.008;
export const RIPPLE_FOOTPRINT_GONE = 0.03;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function rainRippleParams(intensity: number): RainRippleParams {
  const rain = clamp01(intensity);
  if (rain <= 0) return { density: 0, slope: 0, period: RIPPLE_PERIOD, variance: 0 };
  const density = clamp01(0.12 + 0.88 * rain ** 0.6);
  const slope = 0.2 + 0.25 * rain;
  // The period stays fixed: ring phases are time / period, so a period that followed the rain
  // through a weather blend would restart every ring each frame.
  const period = RIPPLE_PERIOD;
  // Rings cover roughly a third of a cell over their life; slope² averaged over that.
  const variance = density * slope * slope * 0.12;
  return { density, slope, period, variance };
}
