import { describe, expect, it } from 'vite-plus/test';

import { telemetrySections } from './TelemetryPanel';

describe('telemetrySections', () => {
  it('shows only the readouts a boat publishes', () => {
    const sections = telemetrySections('cargo', { speedThroughWater: 10, froude: 0.21, rpm: 80, load: 0.8 });
    const titles = sections.map((s) => s.title);
    expect(titles).toEqual(['Hull', 'Propulsion']);
    expect(sections[0]?.rows.map((r) => r.label)).toEqual(['Speed through water', 'Froude number']);
  });

  it('formats units', () => {
    const [hull] = telemetrySections('pwc', { speedThroughWater: 25 });
    expect(hull?.rows[0]?.value).toBe('48.60 kn');
  });

  it('adds sail aero for the sailboat only', () => {
    expect(telemetrySections('sail', { 'sail.aws': 8 }).some((s) => s.title === 'Sails')).toBe(true);
    expect(telemetrySections('crab', { 'sail.aws': 8 }).some((s) => s.title === 'Sails')).toBe(false);
  });
});
