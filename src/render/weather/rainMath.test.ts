// Rain rate, fall speed and the slant/length of the streaks.
import { describe, expect, it } from 'vite-plus/test';

import {
  RAIN_EXPOSURE,
  RAIN_MAX_STREAK,
  rainDropFraction,
  rainFallSpeed,
  rainRate,
  rainStreak,
  rainStreakOpacity,
} from './rainMath';

const still = { x: 0, y: 0, z: 0 };

describe('rain intensity', () => {
  it('spans drizzle to torrential', () => {
    expect(rainRate(0)).toBe(0);
    expect(rainRate(0.1)).toBeLessThan(1);
    expect(rainRate(1)).toBeCloseTo(100);
    expect(rainRate(2)).toBeCloseTo(100);
  });

  it('gives terminal speeds of real drops, faster in heavier rain', () => {
    expect(rainFallSpeed(0.05)).toBeGreaterThan(1.5);
    expect(rainFallSpeed(0.05)).toBeLessThan(4);
    expect(rainFallSpeed(1)).toBeGreaterThan(6.5);
    expect(rainFallSpeed(1)).toBeLessThan(9.65);
    for (let i = 0.05; i < 0.95; i += 0.05) expect(rainFallSpeed(i + 0.05)).toBeGreaterThan(rainFallSpeed(i));
  });

  it('draws more drops as intensity rises', () => {
    expect(rainDropFraction(0)).toBe(0);
    expect(rainDropFraction(0.01)).toBeGreaterThan(0);
    expect(rainDropFraction(1)).toBe(1);
    expect(rainDropFraction(0.5)).toBeGreaterThan(rainDropFraction(0.2));
  });
});

describe('rainStreak', () => {
  it('is vertical in calm air for a still camera', () => {
    const streak = rainStreak(still, still, 8, 0.05);
    expect(streak.slant).toBeCloseTo(0);
    expect(streak.dx).toBeCloseTo(0);
    expect(streak.dy).toBe(-1);
    expect(streak.dz).toBeCloseTo(0);
    expect(streak.length).toBeCloseTo(0.4);
  });

  it('slants 45° downwind when the wind equals the fall speed', () => {
    const streak = rainStreak({ x: 8, y: 0, z: 0 }, still, 8, 0.05);
    expect(streak.slant).toBeCloseTo(Math.PI / 4);
    expect(streak.dx).toBeCloseTo(Math.SQRT1_2);
    expect(streak.dy).toBeCloseTo(-Math.SQRT1_2);
    expect(streak.length).toBeCloseTo(8 * Math.SQRT2 * 0.05);
  });

  it('slants towards a camera moving through calm rain', () => {
    // Heading north (−Z) at 8 m/s: drops appear to come from ahead, moving +Z.
    const streak = rainStreak(still, { x: 0, y: 0, z: -8 }, 8, 0.05);
    expect(streak.dz).toBeGreaterThan(0);
    expect(streak.slant).toBeCloseTo(Math.PI / 4);
  });

  it('vanishes when the camera moves with the drops', () => {
    const streak = rainStreak({ x: 5, y: 0, z: 0 }, { x: 5, y: -8, z: 0 }, 8, 0.05);
    expect(streak.length).toBe(0);
    expect(streak.speed).toBe(0);
  });

  it('caps the streak length', () => {
    expect(rainStreak({ x: 70, y: 0, z: 0 }, still, 8, 0.1, 2).length).toBe(2);
  });
});

describe('rain streaks as drawn', () => {
  const streak = (wind: number) =>
    rainStreak({ x: wind, y: 0, z: 0 }, still, rainFallSpeed(1), RAIN_EXPOSURE, RAIN_MAX_STREAK);

  it('paints short dashes in calm rain and at most a metre and a half in a hurricane', () => {
    expect(streak(0).length).toBeGreaterThan(0.05);
    expect(streak(0).length).toBeLessThan(0.15);
    expect(streak(25).length).toBeLessThan(0.45); // storm
    expect(streak(70).length).toBeLessThanOrEqual(RAIN_MAX_STREAK); // Category 5
    expect(RAIN_MAX_STREAK).toBeLessThan(2);
  });

  it('fades long streaks: a drop lingers on each point of its streak for less of the exposure', () => {
    expect(rainStreakOpacity(0)).toBe(1);
    expect(rainStreakOpacity(0.1)).toBeGreaterThan(rainStreakOpacity(0.5));
    expect(rainStreakOpacity(streak(70).length)).toBeLessThan(0.45);
    expect(rainStreakOpacity(streak(0).length)).toBeGreaterThan(0.75);
  });
});
