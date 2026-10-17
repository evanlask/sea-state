// Inline SVG icons for the HUD (weather, lights and signals, the moon). 24×24, drawn with
// currentColor so night mode recolours them with the rest of the HUD.

import type { LightSignal, WeatherIcon } from './model';

const svg = (body: string, cls = ''): string =>
  `<svg class="hud-icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

const CLOUD =
  '<path class="i-cloud" d="M7 17.5h10.2a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.8 1.2A3.2 3.2 0 0 0 7 17.5z"/>';
const SMALL_CLOUD =
  '<path class="i-cloud" d="M7 14.5h9a3.3 3.3 0 0 0 .3-6.6 5 5 0 0 0-9.6 1A2.8 2.8 0 0 0 7 14.5z"/>';
const SUN_RAYS =
  '<path class="i-line" d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>';

const WEATHER: Record<WeatherIcon, string> = {
  clear: `<circle class="i-sun" cx="12" cy="12" r="4.4"/>${SUN_RAYS}`,
  'partly-cloudy':
    '<circle class="i-sun" cx="9" cy="8.5" r="3.4"/><path class="i-line" d="M9 2.6v1.4M3.1 8.5h1.4M4.8 4.3l1 1M13.2 4.3l-1 1"/>' +
    '<path class="i-cloud" d="M9 19h8.6a3.3 3.3 0 0 0 .3-6.6 4.9 4.9 0 0 0-9.4 1A2.8 2.8 0 0 0 9 19z"/>',
  cloudy: CLOUD,
  fog: '<path class="i-line" d="M4 9h16M3 13h18M5 17h14M7 21h10"/><path class="i-cloud" d="M7 6.5h9a2.6 2.6 0 0 0-1-4 4 4 0 0 0-7 1.5"/>',
  drizzle: `${SMALL_CLOUD}<path class="i-drop" d="M9 18v.6M13 18.5v.6M11 21v.6M15 21v.6"/>`,
  rain: `${SMALL_CLOUD}<path class="i-drop" d="M9 17l-1 3M13 17l-1 3M17 17l-1 3"/>`,
  'heavy-rain': `${SMALL_CLOUD}<path class="i-drop" d="M8 16.5l-1.5 5M11.5 16.5l-1.5 5M15 16.5l-1.5 5M18.5 16.5l-1.5 5"/>`,
  squall: `${SMALL_CLOUD}<path class="i-line" d="M3 17.5h11a2 2 0 1 0-2-2M3 20.5h15a2 2 0 1 1-2 2"/>`,
  thunderstorm: `${SMALL_CLOUD}<path class="i-bolt" d="M12.5 14.5l-2.8 4.4h3l-1.8 4.1 4.6-5.6h-3l1.6-2.9z"/>`,
  snow: `${SMALL_CLOUD}<path class="i-line" d="M9 17.5v3M7.7 19h2.6M15 17.5v3M13.7 19h2.6"/>`,
  hurricane:
    '<path class="i-line" d="M12 8.5a3.5 3.5 0 1 1-3.5 3.5c0-4 3-7.5 8.5-8.5M12 15.5c0 4-3 7.5-8.5 8.5"/><circle class="i-sun" cx="12" cy="12" r="1.4"/>',
};

const MOON_ICON = '<path class="i-moon" d="M15.5 3.5a8.5 8.5 0 1 0 5 15 7 7 0 0 1-5-15z"/>';

export function weatherIcon(icon: WeatherIcon, night: boolean): string {
  if (night && icon === 'clear') return svg(MOON_ICON, 'i-weather');
  if (night && icon === 'partly-cloudy') {
    return svg(
      '<path class="i-moon" d="M10 2.8a6 6 0 1 0 4 10.4 5 5 0 0 1-4-10.4z"/><path class="i-cloud" d="M9 19h8.6a3.3 3.3 0 0 0 .3-6.6 4.9 4.9 0 0 0-9.4 1A2.8 2.8 0 0 0 9 19z"/>',
      'i-weather',
    );
  }
  return svg(WEATHER[icon], 'i-weather');
}

export const WAVE_ICON = svg(
  '<path class="i-line" d="M2 10c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3M2 16c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3"/>',
);
export const SWELL_ICON = svg('<path class="i-line" d="M2 15c3 0 4-7 10-7s7 7 10 7M2 20h20"/>');
export const BOLT_ICON = svg('<path class="i-bolt" d="M13 2L5 13.5h6L9.5 22 19 9.5h-6L15 2z"/>');
export const SUNRISE_ICON = svg(
  '<path class="i-line" d="M4 18h16M7 18a5 5 0 0 1 10 0M12 4v4M9.5 6.5L12 4l2.5 2.5"/>',
  'i-small',
);
export const SUNSET_ICON = svg(
  '<path class="i-line" d="M4 18h16M7 18a5 5 0 0 1 10 0M12 4v4M9.5 5.5L12 8l2.5-2.5"/>',
  'i-small',
);

// Lit part of the moon as an SVG path on a disc of radius r centred at the origin. Phase
// runs 0 new → 0.5 full → 1; the waxing moon is lit on the right (northern hemisphere).
export function moonPath(phase: number, r: number): string {
  const p = ((phase % 1) + 1) % 1;
  const rx = Math.abs(Math.cos(p * 2 * Math.PI)) * r;
  const waxing = p < 0.5;
  const crescent = p < 0.25 || p > 0.75;
  const limb = waxing ? 1 : 0;
  const terminator = waxing ? (crescent ? 0 : 1) : crescent ? 1 : 0;
  return `M 0 ${-r} A ${r} ${r} 0 0 ${limb} 0 ${r} A ${rx.toFixed(2)} ${r} 0 0 ${terminator} 0 ${-r} Z`;
}

export const LIGHT_ICONS = {
  nav: svg(
    '<path class="i-line" d="M12 3l5 9v8H7v-8z"/><circle class="i-port" cx="7" cy="13" r="2.4"/>' +
      '<circle class="i-stbd" cx="17" cy="13" r="2.4"/><circle class="i-white" cx="12" cy="6" r="1.8"/>',
  ),
  deck: svg(
    '<path class="i-line" d="M5 4h6l2 5H3zM8 9v11M5 20h6"/><path class="i-beam" d="M14 6l7-2M14 9h7M14 12l7 2"/>',
  ),
  cabin: svg(
    '<path class="i-line" d="M3 11l9-7 9 7v9H3z"/><rect class="i-window" x="9" y="12" width="6" height="5"/>',
  ),
  // A searchlight drum on its pedestal, throwing a beam.
  extra: svg(
    '<path class="i-line" d="M3 7h7v6H3zM10 6v8M6.5 13v4M4 20h5"/><path class="i-beam" d="M12 8l9-4M12 12l9 4M12 10h9"/>',
  ),
} as const;

export const SIGNAL_ICONS: Record<LightSignal, string> = {
  fishing: svg(
    '<path class="i-line" d="M12 2v20"/><circle class="i-red" cx="12" cy="7" r="3.2"/><circle class="i-white" cx="12" cy="16" r="3.2"/>',
  ),
  nuc: svg(
    '<path class="i-line" d="M12 2v20"/><circle class="i-red" cx="12" cy="7" r="3.2"/><circle class="i-red" cx="12" cy="16" r="3.2"/>',
  ),
  ram: svg(
    '<path class="i-line" d="M12 1v22"/><circle class="i-red" cx="12" cy="5" r="2.6"/><circle class="i-white" cx="12" cy="12" r="2.6"/><circle class="i-red" cx="12" cy="19" r="2.6"/>',
  ),
  anchor: svg('<path class="i-line" d="M12 5v15M8 9h8M5 14a7 7 0 0 0 14 0M12 5a1.8 1.8 0 1 0 0-.1"/>'),
};

export const SIGNAL_LABELS: Record<LightSignal, string> = {
  fishing: 'Fishing',
  nuc: 'NUC',
  ram: 'RAM',
  anchor: 'At anchor',
};

const BOAT_GLYPHS = {
  ship: '<path d="M2 14h20l-2.5 5h-15zM5 14V9h9v5M14 11h4v3"/>',
  sail: '<path d="M11 2v13M11 3l7 10h-7zM10 5l-5 8h5M3 16h18l-2 4H5z"/>',
  small: '<path d="M2 13h17l3-3M3 13l2 5h12l3-5M8 13l2-4h4"/>',
};

export function boatGlyph(kind: string): string {
  const shape =
    kind === 'sail'
      ? BOAT_GLYPHS.sail
      : kind === 'powerboat' || kind === 'pwc'
        ? BOAT_GLYPHS.small
        : BOAT_GLYPHS.ship;
  return svg(`<g class="i-line">${shape}</g>`, 'i-boat');
}
