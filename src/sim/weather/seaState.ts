// Sea state from wind: Pierson-Moskowitz (fully developed) and JONSWAP (fetch-limited) bulk relations,
// a soft hurricane cap, and the Auto / Manual sea-state settings the UI edits.

import { GRAVITY } from '../core/units';
import { douglasFromHs, douglasRepresentativeHs } from './tables';

// Pierson-Moskowitz in terms of the 19.5 m wind they were fitted to. Hs = 0.21 U19.5²/g and
// ωp = 0.877 g/U19.5 come from the same spectrum, so Hs and Tp stay mutually consistent.
const U19_5_PER_U10 = 1.026;
export const PM_HS_COEFF = (0.21 * U19_5_PER_U10 * U19_5_PER_U10) / GRAVITY; // ≈ 0.0225 s²/m
export const PM_TP_COEFF = (2 * Math.PI * U19_5_PER_U10) / (0.877 * GRAVITY); // ≈ 0.750 s²/m

// JONSWAP growth curves (Hasselmann 1973): gHs/U² = 1.6e-3 (gF/U²)^½, gTp/U = 0.286 (gF/U²)^⅓.
// In practical units: Hs ≈ 0.0163 U10 √F_km, Tp ≈ 0.62 (U10 F_km)^⅓.
const JONSWAP_HS_COEFF = 1.6e-3 / Math.sqrt(GRAVITY); // per √m
const JONSWAP_TP_COEFF = 0.286 * Math.pow(GRAVITY, -2 / 3);

export const DEFAULT_FETCH = 400_000; // m; matches the Beaufort "probable" heights
export const JONSWAP_GAMMA = 3.3;

// Measured hurricane seas top out near 18 m (Ivan 17.9 m; buoy 42040 in Katrina 16.9 m).
const HS_SOFT_KNEE = 12;
export const HS_CAP = 20;

export interface WaveBulk {
  hs: number; // significant wave height, m
  tp: number; // peak period, s
}

export function piersonMoskowitz(u10: number, out: WaveBulk = { hs: 0, tp: 0 }): WaveBulk {
  out.hs = PM_HS_COEFF * u10 * u10;
  out.tp = PM_TP_COEFF * u10;
  return out;
}

export function jonswapFetchLimited(u10: number, fetch: number, out: WaveBulk = { hs: 0, tp: 0 }): WaveBulk {
  out.hs = JONSWAP_HS_COEFF * u10 * Math.sqrt(fetch);
  out.tp = JONSWAP_TP_COEFF * Math.cbrt(u10 * fetch);
  return out;
}

// Continuous above the knee, asymptotic to the cap: extreme winds grow seas ever more slowly.
export function softCapHs(hs: number): number {
  if (hs <= HS_SOFT_KNEE) return hs;
  const span = HS_CAP - HS_SOFT_KNEE;
  return HS_SOFT_KNEE + span * Math.tanh((hs - HS_SOFT_KNEE) / span);
}

const pmScratch: WaveBulk = { hs: 0, tp: 0 };

// The sea is whichever limit bites first: duration-unlimited growth stops at the fetch-limited value or
// at full development, whichever is smaller. The two curves cross near F ≈ 1.9 U10² (m) where their
// Tp also agree (≈ 0.75 U10), so switching regime is nearly seamless.
export function autoSeaBulk(
  u10: number,
  fetch: number = DEFAULT_FETCH,
  fullyDeveloped = false,
  out: WaveBulk = { hs: 0, tp: 0 },
): WaveBulk {
  const pm = piersonMoskowitz(u10, pmScratch);
  if (fullyDeveloped) {
    out.hs = pm.hs;
    out.tp = pm.tp;
  } else {
    jonswapFetchLimited(u10, fetch, out);
    if (pm.hs < out.hs) {
      out.hs = pm.hs;
      out.tp = pm.tp;
    }
  }
  out.hs = softCapHs(out.hs);
  return out;
}

// Inverse of Pierson-Moskowitz: the period of a fully developed sea of this height (Tp ≈ 5.0 √Hs).
export function fullyDevelopedTp(hs: number): number {
  return PM_TP_COEFF * Math.sqrt(Math.max(0, hs) / PM_HS_COEFF);
}

export interface SwellSettings {
  height: number; // significant height of the swell alone, m
  period: number; // peak period, s
  from: number; // meteorological "from" direction, radians
}

// Short-crested seas spread wider than Donelan-Banner; long-crested ones are narrower.
type CrestLength = 'short' | 'normal' | 'long';

const CREST_SPREADING: Readonly<Record<CrestLength, number>> = { short: 0.6, normal: 1, long: 2.5 };

interface AutoSeaStateSettings {
  mode: 'auto';
  fetch: number; // m
  fullyDeveloped: boolean;
  swell: SwellSettings | null;
}

type ManualHeight = { kind: 'hs'; hs: number } | { kind: 'douglas'; code: number };

interface ManualSeaStateSettings {
  mode: 'manual';
  height: ManualHeight;
  tp: number | null; // null: period of a fully developed sea of that height
  choppiness: number; // horizontal displacement scale, 1 = linear (Gerstner) theory
  crestLength: CrestLength;
  directionOffset: number; // wind-sea direction relative to the wind's "from", radians clockwise
  swell: SwellSettings | null;
}

export type SeaStateSettings = AutoSeaStateSettings | ManualSeaStateSettings;

// Everything the spectrum needs, independent of how the user specified it.
export interface ResolvedSeaState {
  hs: number; // wind sea, m
  tp: number; // wind sea, s
  gamma: number;
  windSeaFrom: number; // radians, meteorological
  choppiness: number;
  spreading: number; // Donelan-Banner β multiplier
  swell: SwellSettings | null;
  totalHs: number; // wind sea and swell combined (energies add)
  douglas: number; // code of totalHs
}

const bulkScratch: WaveBulk = { hs: 0, tp: 0 };

export function resolveSeaState(
  settings: SeaStateSettings,
  windSpeed: number,
  windFrom: number,
): ResolvedSeaState {
  let hs: number;
  let tp: number;
  let choppiness = 1;
  let spreading = 1;
  let from = windFrom;
  if (settings.mode === 'auto') {
    const bulk = autoSeaBulk(windSpeed, settings.fetch, settings.fullyDeveloped, bulkScratch);
    hs = bulk.hs;
    tp = bulk.tp;
  } else {
    hs =
      settings.height.kind === 'hs'
        ? Math.max(0, settings.height.hs)
        : douglasRepresentativeHs(settings.height.code);
    tp = settings.tp ?? fullyDevelopedTp(hs);
    choppiness = Math.max(0, settings.choppiness);
    spreading = CREST_SPREADING[settings.crestLength];
    from = windFrom + settings.directionOffset;
  }
  // A swell with no period isn't one: the spectrum drops it, so it must not count towards Hs either.
  const swell =
    settings.swell && settings.swell.height > 0 && settings.swell.period > 0 ? { ...settings.swell } : null;
  const swellHs = swell?.height ?? 0;
  const totalHs = Math.sqrt(hs * hs + swellHs * swellHs);
  return {
    hs,
    tp,
    gamma: JONSWAP_GAMMA,
    windSeaFrom: from,
    choppiness,
    spreading,
    swell,
    totalHs,
    douglas: douglasFromHs(totalHs).code,
  };
}
