// Engineering telemetry panel: hull, resistance vs thrust, stability, propulsion and sail aero
// readouts for the boat at the helm. Off by default; toggled with G. Refreshed at ~5 Hz.

import './telemetry-panel.css';
import { msToKnots } from '../../sim/core/units';
import type { BoatKind } from '../../sim/world/protocol';

interface TelemetryRow {
  label: string;
  value: string;
}

export interface TelemetrySection {
  title: string;
  rows: TelemetryRow[];
}

const deg = (rad: number): string => `${((rad * 180) / Math.PI).toFixed(1)}°`;
const kn = (ms: number): string => `${msToKnots(ms).toFixed(2)} kn`;
const kN = (n: number): string =>
  Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)} MN` : `${(n / 1e3).toFixed(1)} kN`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const tonnes = (kg: number): string => (kg >= 1e4 ? `${(kg / 1000).toFixed(0)} t` : `${kg.toFixed(0)} kg`);

// Pure: which readouts to show for this boat's telemetry (keys a boat lacks are skipped).
export function telemetrySections(kind: BoatKind, t: Readonly<Record<string, number>>): TelemetrySection[] {
  const has = (key: string): boolean => key in t;
  const v = (key: string): number => t[key] ?? 0;
  const rows = (pairs: [string, string, (x: number) => string][]): TelemetryRow[] =>
    pairs.filter(([key]) => has(key)).map(([key, label, fmt]) => ({ label, value: fmt(v(key)) }));

  const sections: TelemetrySection[] = [
    {
      title: 'Hull',
      rows: rows([
        ['speedThroughWater', 'Speed through water', kn],
        ['froude', 'Froude number', (x) => x.toFixed(3)],
        ['heel', 'Heel', deg],
        ['trim', 'Trim', deg],
        ['immersion', 'Immersion', pct],
        ['wettedArea', 'Wetted area', (x) => `${x.toFixed(1)} m²`],
        ['mass', 'Mass (incl. water)', tonnes],
      ]),
    },
    {
      title: 'Forces',
      rows: rows([
        ['resistance', 'Calm-water resistance', kN],
        ['slipDrag', 'Slide drag', kN],
        ['thrust', 'Thrust', kN],
        ['breaking', 'Breaking-crest impact', kN],
        ['slam', 'Last slam', (x) => `${x.toFixed(1)} m/s`],
      ]),
    },
    {
      title: 'Stability',
      rows: rows([
        ['gmEffective', 'GM (free-surface corrected)', (x) => `${x.toFixed(2)} m`],
        ['avs', 'Angle of vanishing stability', deg],
        ['deckWater', 'Deck water', pct],
        ['flooding', 'Flooding', pct],
      ]),
    },
  ];

  const drive = rows([
    ['rpm', 'Shaft / engine rpm', (x) => x.toFixed(0)],
    ['load', 'Engine load', pct],
    ['propSlip', 'Propeller slip', pct],
    ['propEmersion', 'Propeller emersion', pct],
    ['rudderAngle', 'Rudder', deg],
    ['eng0Rpm', 'Port engine rpm', (x) => x.toFixed(0)],
    ['eng1Rpm', 'Starboard engine rpm', (x) => x.toFixed(0)],
    ['outboardTrim', 'Outboard trim', pct],
    ['nozzle', 'Jet nozzle', deg],
    ['ventilated', 'Intake ventilation', pct],
  ]);
  if (drive.length > 0) sections.push({ title: 'Propulsion', rows: drive });

  if (kind === 'sail') {
    const sail = rows([
      ['sail.aws', 'Apparent wind', kn],
      ['sail.awa', 'Apparent wind angle', deg],
      ['sail.mainAlpha', 'Main angle of attack', deg],
      ['sail.jibAlpha', 'Jib angle of attack', deg],
      ['sail.mainCl', 'Main CL', (x) => x.toFixed(2)],
      ['sail.mainCd', 'Main CD', (x) => x.toFixed(2)],
      ['sail.drive', 'Drive force', kN],
      ['sail.side', 'Side force', kN],
      ['sail.vmg', 'VMG', kn],
    ]);
    if (sail.length > 0) sections.push({ title: 'Sails', rows: sail });
  }
  return sections.filter((section) => section.rows.length > 0);
}

export class TelemetryPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private visible = false;
  private elapsed = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('aside');
    this.root.className = 'telemetry-panel';
    this.root.setAttribute('aria-label', 'Engineering telemetry');
    this.root.innerHTML = '<h2>Telemetry</h2>';
    this.body = document.createElement('div');
    this.root.append(this.body);
    this.root.hidden = true;
    parent.append(this.root);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  update(dt: number, kind: BoatKind, telemetry: Readonly<Record<string, number>>): void {
    if (!this.visible) return;
    this.elapsed += dt;
    if (this.elapsed < 0.2) return;
    this.elapsed = 0;
    const html = telemetrySections(kind, telemetry)
      .map(
        (section) =>
          `<section><h3>${section.title}</h3><dl>${section.rows
            .map((row) => `<dt>${row.label}</dt><dd>${row.value}</dd>`)
            .join('')}</dl></section>`,
      )
      .join('');
    this.body.innerHTML = html;
  }

  dispose(): void {
    this.root.remove();
  }
}
