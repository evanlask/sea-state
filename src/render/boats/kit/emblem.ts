// Fictional funnel/house emblems painted on a canvas: a disc with a star, waves or a chevron.

import type { Texture } from 'three/webgpu';

import { canvasTexture, context2d, createCanvas } from './textures';

export interface EmblemOptions {
  disc: string;
  mark: string;
  ring?: string;
  kind: 'star' | 'wave' | 'chevron';
}

export function emblemTexture(o: EmblemOptions): Texture {
  const S = 512;
  const canvas = createCanvas(S, S);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, S, S);
  const c = S / 2;
  if (o.ring) {
    ctx.fillStyle = o.ring;
    ctx.beginPath();
    ctx.arc(c, c, S * 0.48, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = o.disc;
  ctx.beginPath();
  ctx.arc(c, c, S * 0.43, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = o.mark;
  ctx.strokeStyle = o.mark;
  ctx.beginPath();
  if (o.kind === 'star') {
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? S * 0.33 : S * 0.14;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  } else if (o.kind === 'wave') {
    ctx.lineWidth = S * 0.07;
    ctx.lineCap = 'round';
    for (const dy of [-0.11, 0.06, 0.23]) {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.3, c + S * dy);
      ctx.bezierCurveTo(
        c - S * 0.15,
        c + S * (dy - 0.12),
        c,
        c + S * (dy + 0.12),
        c + S * 0.3,
        c + S * (dy - 0.04),
      );
      ctx.stroke();
    }
  } else {
    ctx.moveTo(c - S * 0.28, c + S * 0.18);
    ctx.lineTo(c, c - S * 0.2);
    ctx.lineTo(c + S * 0.28, c + S * 0.18);
    ctx.lineTo(c + S * 0.14, c + S * 0.18);
    ctx.lineTo(c, c - S * 0.02);
    ctx.lineTo(c - S * 0.14, c + S * 0.18);
    ctx.closePath();
    ctx.fill();
  }
  return canvasTexture(canvas, { anisotropy: 8 });
}
