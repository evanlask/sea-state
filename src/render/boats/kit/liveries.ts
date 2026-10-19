// Canvas-generated liveries: hull rust/grime masks, names and ports of
// registry, draft marks, the Plimsoll mark and container line logos. All names and brands are fictional. Pure layout helpers are
// exported for tests; painters need a DOM canvas.

import { type Texture } from 'three/webgpu';

import type { HullLines } from './hullLines';
import { rng } from './instancing';
import { canvasTexture, context2d, createCanvas, drawFittedText } from './textures';

// ------------------------------------------------------------------ pure layout

export interface DraftMark {
  y: number; // body y of the bottom of the numeral
  label: string;
}

// Metric draft marks: 10 cm numerals every 20 cm, whole metres suffixed with "M" (keel = y −draft).
export function draftMarks(draft: number, maxDraft: number): DraftMark[] {
  const out: DraftMark[] = [];
  for (let d = 0.2; d <= maxDraft + 1e-6; d += 0.2) {
    const dm = Math.round(d * 10);
    const metres = Math.floor(dm / 10);
    const tenths = dm % 10;
    const label = tenths === 0 ? `${metres}M` : `${tenths}`;
    out.push({ y: d - draft, label });
  }
  return out;
}

// Letter height (m) for a name painted over `available` metres of hull, capped at maxHeight.
export function nameLetterHeight(text: string, available: number, maxHeight: number, aspect = 0.62): number {
  const letters = Math.max(1, text.length);
  return Math.min(maxHeight, available / (letters * aspect * 1.08));
}

// IMO numbers have a check digit: Σ digit_i × (7 − i) for the first six, mod 10.
export function imoNumber(seed: number): string {
  const random = rng(seed);
  const digits = [9, ...Array.from({ length: 5 }, () => Math.floor(random() * 10))];
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += digits[i]! * (7 - i);
  return `IMO ${digits.join('')}${sum % 10}`;
}

// ------------------------------------------------------------------ painters

export interface HullMaskOptions {
  width?: number;
  height?: number;
  yMin: number;
  yMax: number;
  scuppers?: number[]; // body z of deck scuppers / freeing ports (rust runs down from the deck edge)
  hawse?: { z: number; y: number }[]; // hawse pipes and other openings
  extraStreaks?: number;
  seed?: number;
}

// Side-projected mask over the hull length: r = rust runs, g = grime/soot runs.
export function hullMaskTexture(lines: HullLines, o: HullMaskOptions): Texture {
  const W = o.width ?? 2048;
  const H = o.height ?? 512;
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // Channels accumulate (r rust, g grime) where runs overlap.
  ctx.globalCompositeOperation = 'lighter';
  const L = lines.zStern - lines.zBow;
  const px = (z: number): number => ((z - lines.zBow) / L) * W;
  const py = (y: number): number => (1 - (y - o.yMin) / (o.yMax - o.yMin)) * H;
  const random = rng(o.seed ?? 3);
  const streak = (x: number, y0: number, len: number, w: number, color: string, alpha: number): void => {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, color.replace('A', String(alpha)));
    g.addColorStop(0.35, color.replace('A', String(alpha * 0.6)));
    g.addColorStop(1, color.replace('A', '0'));
    ctx.fillStyle = g;
    // A few wobbling sub-streaks make it look like runs rather than a bar.
    for (let k = 0; k < 3; k++) {
      const dx = (random() - 0.5) * w * 1.5;
      const ww = w * (0.3 + random() * 0.7);
      ctx.beginPath();
      ctx.moveTo(x + dx - ww / 2, y0);
      ctx.lineTo(x + dx + ww / 2, y0);
      ctx.lineTo(x + dx + ww * 0.15, y0 + len * (0.6 + random() * 0.4));
      ctx.lineTo(x + dx - ww * 0.15, y0 + len * (0.6 + random() * 0.4));
      ctx.closePath();
      ctx.fill();
    }
  };
  const rust = 'rgba(255,0,0,A)';
  const soot = 'rgba(0,255,0,A)';
  const pxPerM = H / (o.yMax - o.yMin);
  for (const z of o.scuppers ?? []) {
    const y = lines.deckY(z);
    streak(px(z), py(y) - 2, (1 + random() * 3) * pxPerM, 0.25 * (W / L), rust, 0.5 + random() * 0.4);
  }
  for (const h of o.hawse ?? []) {
    streak(px(h.z), py(h.y), (3 + random() * 4) * pxPerM, 0.7 * (W / L), rust, 0.85);
    streak(px(h.z) + 4, py(h.y), (2 + random() * 3) * pxPerM, 0.4 * (W / L), soot, 0.6);
  }
  const extra = o.extraStreaks ?? 40;
  for (let i = 0; i < extra; i++) {
    const z = lines.zBow + random() * L;
    const y = lines.deckY(z) - random() * 2;
    const isRust = random() < 0.55;
    streak(
      px(z),
      py(y),
      (0.5 + random() * 3) * pxPerM,
      (0.1 + random() * 0.4) * (W / L),
      isRust ? rust : soot,
      0.2 + random() * 0.35,
    );
  }
  return canvasTexture(canvas, { srgb: false, anisotropy: 4 });
}

export interface TextDecalOptions {
  lines: string[];
  width: number; // px
  height: number; // px
  color?: string;
  outline?: string;
  font?: string;
  weight?: string;
  lineHeights?: number[]; // fraction of the canvas height per line
  align?: CanvasTextAlign;
}

// Painted lettering on a transparent canvas (one or more lines, fitted to the width).
export function textDecalTexture(o: TextDecalOptions): Texture {
  const canvas = createCanvas(o.width, o.height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, o.width, o.height);
  const n = o.lines.length;
  const heights = o.lineHeights ?? o.lines.map(() => 0.8 / n);
  let y = 0;
  const total = heights.reduce((a, b) => a + b, 0);
  y = ((1 - total) / 2) * o.height;
  o.lines.forEach((text, i) => {
    const h = heights[i]! * o.height;
    ctx.fillStyle = o.color ?? '#f4f1e8';
    const x = o.align === 'left' ? o.width * 0.02 : o.align === 'right' ? o.width * 0.98 : o.width / 2;
    if (o.outline) {
      ctx.strokeStyle = o.outline;
      ctx.lineWidth = h * 0.06;
    }
    drawFittedText(ctx, text, x, y + h / 2, o.width * 0.96, h * 0.86, {
      font: o.font,
      weight: o.weight,
      align: o.align,
    });
    y += h;
  });
  return canvasTexture(canvas, { anisotropy: 8 });
}

// Draft marks for one end of the hull: the canvas spans [yFrom, yTo] in body y, numerals on the left.
export function draftMarksTexture(
  draft: number,
  maxDraft: number,
  yFrom: number,
  yTo: number,
  color = '#f2efe6',
): Texture {
  const pxPerM = 200;
  const W = 128;
  const H = Math.round((yTo - yFrom) * pxPerM);
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = color;
  for (const mark of draftMarks(draft, maxDraft)) {
    if (mark.y < yFrom || mark.y + 0.1 > yTo) continue;
    const top = (yTo - (mark.y + 0.1)) * pxPerM;
    drawFittedText(ctx, mark.label, 6, top + 0.05 * pxPerM, W - 12, 0.1 * pxPerM, {
      align: 'left',
      weight: '700',
    });
  }
  return canvasTexture(canvas, { anisotropy: 8 });
}

// Plimsoll disc and load lines; the canvas is 3 m wide × 2.4 m tall centred on the summer line.
export function plimsollTexture(color = '#f2efe6'): Texture {
  const pxPerM = 200;
  const W = 3 * pxPerM;
  const H = Math.round(2.4 * pxPerM);
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const m = (v: number): number => v * pxPerM;
  const cx = m(0.9);
  const cy = H / 2; // summer load line through the disc centre
  // Deck line above.
  ctx.fillRect(cx - m(0.15), m(0.05), m(0.3), m(0.025));
  // Disc 300 mm, 25 mm line, with a 450 × 25 mm bar through the centre.
  ctx.lineWidth = m(0.025);
  ctx.beginPath();
  ctx.arc(cx, cy, m(0.15), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillRect(cx - m(0.225), cy - m(0.0125), m(0.45), m(0.025));
  // Assigning-authority letters (fictional).
  drawFittedText(ctx, 'N', cx - m(0.3), cy - m(0.12), m(0.12), m(0.11));
  drawFittedText(ctx, 'R', cx + m(0.3), cy - m(0.12), m(0.12), m(0.11));
  // Load-line grid 540 mm forward of the disc.
  const gx = cx + m(0.54);
  ctx.fillRect(gx, cy - m(0.45), m(0.025), m(0.9));
  const marks: [string, number][] = [
    ['TF', -0.32],
    ['F', -0.15],
    ['T', -0.17],
    ['S', 0],
    ['W', 0.15],
    ['WNA', 0.25],
  ];
  for (const [label, dy] of marks) {
    const y = cy + m(dy);
    const fwd = label === 'TF' || label === 'F';
    const x0 = fwd ? gx - m(0.23) : gx + m(0.025);
    ctx.fillRect(x0, y - m(0.0125), m(0.23), m(0.025));
    drawFittedText(ctx, label, fwd ? x0 - m(0.12) : x0 + m(0.32), y - m(0.06), m(0.18), m(0.09));
  }
  return canvasTexture(canvas, { anisotropy: 8 });
}

export interface ContainerLine {
  name: string;
  color: string; // box paint
  text: string; // logo colour
}

// Fictional box operators and lessors; colours as faded paint.
export const CONTAINER_LINES: readonly ContainerLine[] = [
  { name: 'NORVANTA', color: '#27507a', text: '#e9edf0' },
  { name: 'TRANSMARINO', color: '#a5402d', text: '#f2ece2' },
  { name: 'OCEANLYNX', color: '#2f6e5a', text: '#f0f0ea' },
  { name: 'MERIDIAN', color: '#2a3550', text: '#e7b64a' },
  { name: 'PACIFIQA', color: '#b98a2d', text: '#2a2a2a' },
  { name: 'CORALIS', color: '#c46a3e', text: '#ffffff' },
  { name: 'GREYFIN', color: '#7d8287', text: '#1c2a3a' },
  { name: 'SOLMAR', color: '#3f8fb0', text: '#ffffff' },
  { name: 'ATLANTICA', color: '#8a2c2c', text: '#f5f1e8' },
  { name: 'KESTRAL', color: '#d9d4c7', text: '#29507a' },
  { name: 'TRITEX', color: '#5b6b38', text: '#efeee6' },
  { name: '', color: '#9a4a2a', text: '#ffffff' }, // plain leased boxes, no logo
  { name: 'GLOBOXX', color: '#e0dcd2', text: '#a33025' },
  { name: 'VANTIS', color: '#3c4a8c', text: '#ffffff' },
];

// One row per line: the logo text on a transparent strip (9 m × 1.25 m on the box side).
export function containerLogoAtlas(lines: readonly ContainerLine[] = CONTAINER_LINES): {
  texture: Texture;
  rows: number;
} {
  const W = 1024;
  const rowH = 128;
  const canvas = createCanvas(W, rowH * lines.length);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lines.forEach((line, i) => {
    if (!line.name) return;
    ctx.fillStyle = line.text;
    drawFittedText(ctx, line.name, W / 2, i * rowH + rowH / 2, W * 0.92, rowH * 0.8, {
      weight: '800',
      spacing: 0.12,
    });
  });
  const texture = canvasTexture(canvas, { anisotropy: 8 });
  return { texture, rows: lines.length };
}
