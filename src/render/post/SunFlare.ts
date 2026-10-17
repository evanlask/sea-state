// Sun lens flare: a soft glow and faint starburst around the sun plus a chain of tinted ghosts
// mirrored through the frame centre, added to the HDR image before exposure.
//
// Occlusion needs no extra pass: the flare reads the scene pass itself at a few points across the
// sun's disk. Wherever a hull, a mast, the sea or a cloud covers the disk, those pixels are no
// longer the blazing disk, so the flare fades with the visible part of the sun (and takes its
// colour, so a red sunset sun throws a red flare).

import { Vector2 } from 'three/webgpu';

import { type N, tsl } from '../tsl';

const {
  abs,
  atan,
  cos,
  exp,
  float,
  length,
  luminance,
  max,
  min,
  pow,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} = tsl;

// Pre-exposed luminance of the visible disk where the flare starts and where it is full. The disk is
// thousands of times diffuse white in daylight; thin cloud cuts that by orders of magnitude.
const FLARE_DISK_START = 30;
const FLARE_DISK_FULL = 400;

// Ghosts: position along the sun → centre axis (1 = at the sun, −1 = mirrored), radius (screen
// heights), RGB tint and strength.
const GHOSTS: readonly { at: number; radius: number; tint: [number, number, number]; gain: number }[] = [
  { at: 0.55, radius: 0.025, tint: [1, 0.85, 0.6], gain: 0.5 },
  { at: 0.2, radius: 0.012, tint: [0.7, 1, 0.8], gain: 0.6 },
  { at: -0.25, radius: 0.045, tint: [0.55, 0.75, 1], gain: 0.35 },
  { at: -0.45, radius: 0.02, tint: [1, 0.7, 0.9], gain: 0.5 },
  { at: -0.7, radius: 0.08, tint: [0.6, 1, 0.85], gain: 0.18 },
  { at: -1.05, radius: 0.035, tint: [1, 0.8, 0.55], gain: 0.3 },
  { at: -1.4, radius: 0.12, tint: [0.5, 0.65, 1], gain: 0.12 },
];

export class SunFlareUniforms {
  readonly sunUv: N = uniform(new Vector2(-10, -10)); // screen uv of the sun (y down); off-screen = none
  readonly diskRadius: N = uniform(0.004); // uv (of the screen height) of the sun's disk
  readonly aspect: N = uniform(16 / 9);
  readonly strength: N = uniform(1);
  readonly visible: N = uniform(0); // 0 when the sun is behind the camera or below the horizon
}

// `scene` is the raw scene pass colour (texture node, HDR pre-exposed).
export function sunFlare(scene: N, u: SunFlareUniforms, ghosts: number): N {
  // How much of the disk is showing, and in what colour: 7 taps over the inner disk.
  let sum: N = vec3(0);
  const taps: [number, number][] = [[0, 0]];
  for (let i = 0; i < 6; i++)
    taps.push([Math.cos((i * Math.PI) / 3) * 0.55, Math.sin((i * Math.PI) / 3) * 0.55]);
  for (const [x, y] of taps) {
    const at = u.sunUv.add(
      vec2(x, y)
        .mul(u.diskRadius)
        .mul(vec2(float(1).div(u.aspect), 1)),
    );
    sum = sum.add(scene.sample(at).level(0).rgb.min(1e4));
  }
  const disk = sum.div(taps.length).toVar();
  const lum = luminance(disk);
  const visibility = smoothstep(FLARE_DISK_START, FLARE_DISK_FULL, lum).mul(u.visible).toVar();
  const tint = disk.div(max(lum, 1e-3)).min(3);

  // Centred, aspect-correct coordinates (y up).
  const coord = uv();
  const p = vec2(coord.x.sub(0.5).mul(u.aspect), coord.y.oneMinus().sub(0.5));
  const s = vec2(u.sunUv.x.sub(0.5).mul(u.aspect), u.sunUv.y.oneMinus().sub(0.5));
  const toSun = p.sub(s);
  const r = length(toSun);

  // Glow and a faint six-point starburst around the sun.
  const glow = exp(r.mul(-28))
    .mul(0.5)
    .add(exp(r.mul(-7)).mul(0.08));
  const angle = atan(toSun.y, toSun.x);
  const burst = pow(abs(cos(angle.mul(3))), 60)
    .mul(exp(r.mul(-9)))
    .mul(0.12);
  let flare: N = vec3(glow.add(burst));

  // Ghosts fade as the sun nears the centre (the axis collapses) and toward the frame edge.
  const axis = length(s);
  const edge = smoothstep(1.1, 0.4, axis);
  for (const ghost of GHOSTS.slice(0, ghosts)) {
    const centre = s.mul(ghost.at);
    const d = length(p.sub(centre));
    const disc = smoothstep(ghost.radius, ghost.radius * 0.55, d);
    const ring = smoothstep(ghost.radius * 0.12, 0, abs(d.sub(ghost.radius))).mul(0.6);
    const shape = max(disc, ring).mul(ghost.gain * 0.05);
    flare = flare.add(
      vec3(...ghost.tint)
        .mul(shape)
        .mul(edge),
    );
  }
  return vec4(
    flare
      .mul(tint)
      .mul(visibility)
      .mul(u.strength)
      .min(vec3(min(lum, 60))),
    0,
  );
}
