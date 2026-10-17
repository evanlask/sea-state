// TSL for the surface-detail layers (see tuning.ts for what each strength does). Detail is sampled
// triplanar in the body frame, in metres, so it sticks to the boat and has a physical scale on any
// mesh, UVs or not. The packed surface map gives a normal offset, roughness and AO / metal mask;
// the colour map modulates or tints the procedural colour.
//
// Distance: normal and roughness variation fade out (to the flat normal and the map's mean) so
// distant hulls don't shimmer; colour effects converge on their mean through the mipmaps anyway.

import { type N, tsl } from '../../tsl';
import type { DetailBinding, ResolvedDetail } from './detail';
import { type DetailLayer, fadeRange, tileScale, type WornLayer } from './tuning';

const {
  abs,
  dot,
  faceDirection,
  float,
  mix,
  modelViewMatrix,
  modelWorldMatrix,
  normalView,
  positionView,
  pow,
  saturate,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} = tsl;

// Per-axis scale of the object: 1 for the kit's meshes, the length for stretched link meshes (sheets).
const modelScale = (): N =>
  vec3(
    modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz.length(),
    modelWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz.length(),
    modelWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz.length(),
  );

// 1 up close, 0 from the layer's `fade` metres away (starting at FADE_START of it).
export function detailFade(layer: DetailLayer): N {
  const [start, end] = fadeRange(layer);
  return float(1).sub(smoothstep(float(start), float(end), positionView.length()));
}

const luminance = (rgb: N): N => dot(rgb, vec3(0.2126, 0.7152, 0.0722));

interface LayerSample {
  delta: N; // body-frame normal offset, already × strength × fade
  roughness: N; // the map's roughness, 0..1
  alpha: N; // AO or metal mask, 0..1
  color: N; // linear RGB, or null when the set has no colour map
  fade: N;
}

// Triplanar sample of one layer at body position p (as from bodyPosition()) with body normal n. The
// colour map is only sampled when asked for: every texture costs a sampler, and WebGPU allows 16 per
// fragment stage including the lights' shadow maps.
function sampleLayer(binding: DetailBinding, p: N, n: N, withColor = true): LayerSample {
  const { layer, maps } = binding;
  const q = p.mul(modelScale());
  const scale = vec2(...tileScale(layer));
  const w0 = pow(abs(n), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z).add(1e-5));
  const alongZ = layer.along === 'z';
  const uvX = q.zy.mul(scale);
  const uvY = (alongZ ? q.zx : q.xz).mul(scale);
  const uvZ = q.xy.mul(scale);
  const sx = texture(maps.surface, uvX);
  const sy = texture(maps.surface, uvY);
  const sz = texture(maps.surface, uvZ);
  const tri = (a: N, b: N, c: N): N => a.mul(w.x).add(b.mul(w.y)).add(c.mul(w.z));
  // Tangent slopes along (u, v). KTX2 rows run top-down (v grows down the image) while the
  // OpenGL map's green points up the image, hence the minus.
  const slope = (t: N): N => vec2(t.r.mul(2).sub(1), float(1).sub(t.g.mul(2)));
  const nX = slope(sx);
  const nY = slope(sy);
  const nZ = slope(sz);
  // Each plane's u/v axes in the body frame: X plane (z, y), Y plane (x, z) or (z, x), Z plane (x, y).
  const dX = vec3(0, nX.y, nX.x);
  const dY = alongZ ? vec3(nY.y, 0, nY.x) : vec3(nY.x, 0, nY.y);
  const dZ = vec3(nZ.x, nZ.y, 0);
  const fade = detailFade(layer);
  const color =
    withColor && maps.color
      ? tri(texture(maps.color, uvX).rgb, texture(maps.color, uvY).rgb, texture(maps.color, uvZ).rgb)
      : null;
  return {
    delta: tri(dX, dY, dZ).mul(fade.mul(layer.normal)),
    roughness: tri(sx.b, sy.b, sz.b),
    alpha: tri(sx.a, sy.a, sz.a),
    color,
    fade,
  };
}

// View-space normal for a material's normalNode: the procedural one (null: the geometric normal) tilted
// by a body-frame detail offset (null: none, and the result is `base`, possibly null too).
export function detailNormal(base: N, delta: N): N {
  if (!delta) return base;
  const nb = base ?? normalView;
  const d = modelViewMatrix.mul(vec4(delta.div(modelScale()), 0)).xyz.mul(faceDirection);
  return nb.add(d.sub(nb.mul(dot(d, nb)))).normalize();
}

const addDelta = (a: N, b: N): N => (a && b ? a.add(b) : (a ?? b));

export interface Surface {
  color: N;
  roughness: N;
  ao: N;
  metalness: N;
  delta: N; // accumulated body-frame normal offset, or null
}

const BARE_STEEL = [0.52, 0.53, 0.55] as const;

// The base layer on any surface: micro relief, roughness variation, colour, AO and metal masks.
function applyBaseLayer(binding: DetailBinding | null, p: N, n: N, s: Surface): Surface {
  if (!binding) return s;
  const { layer, info } = binding;
  const d = sampleLayer(binding, p, n, !!(layer.color || layer.albedo));
  let { color, roughness, ao, metalness } = s;
  if (layer.roughness)
    roughness = roughness.add(d.roughness.sub(info.roughness).mul(d.fade.mul(layer.roughness)));
  if (d.color && layer.color && info.luminance > 0) {
    const ratio = luminance(d.color).div(info.luminance).clamp(0, 3);
    color = color.mul(mix(float(1), ratio, layer.color));
  }
  if (d.color && layer.albedo) color = mix(color, d.color, layer.albedo);
  if (info.alpha === 'ao' && layer.ao) {
    // Far away the AO settles on its mean, so the average brightness doesn't change with distance.
    const occ = mix(float(1), mix(float(info.alphaMean), d.alpha, d.fade), layer.ao);
    ao = ao.mul(occ);
    color = color.mul(mix(float(1), occ, 0.6)); // the AO node only darkens indirect light
  }
  if (info.alpha === 'metal') {
    if (layer.scratches) {
      const scratch = smoothstep(float(0.3), float(0.7), d.alpha).mul(layer.scratches);
      color = mix(color, vec3(...BARE_STEEL), scratch);
      roughness = mix(roughness, float(0.3), scratch);
      metalness = mix(metalness, float(0.9), scratch);
    }
    if (layer.metal) metalness = mix(metalness, d.alpha, layer.metal);
  }
  return { color, roughness: saturate(roughness), ao, metalness, delta: addDelta(s.delta, d.delta) };
}

export interface WornResult extends Surface {
  coverage: N; // 0..1 where the worn texture shows
}

// The worn layer inside the weathering: `wear` (0..1, from the procedural rust/grime) sets how much of
// the texture's damage mask breaks through. Damage takes the procedural rust colour, mottled by the
// texture's roughness and pitting (its colour map isn't sampled, to save a sampler).
export function applyWornLayer(
  binding: DetailBinding<WornLayer> | null,
  p: N,
  n: N,
  s: Surface,
  wear: N,
  rustTint: N,
): WornResult | null {
  if (!binding) return null;
  const { layer, info } = binding;
  const d = sampleLayer(binding, p, n, false);
  const damage = info.wear === 'unmetal' ? float(1).sub(d.alpha) : d.roughness;
  // Threshold so roughly `wear × amount` of the area is damaged (the masks are spread over 0..1).
  const level = saturate(wear.mul(layer.amount));
  const t = float(1).sub(level);
  const coverage = smoothstep(t.sub(0.06), t.add(0.06), damage).mul(saturate(level.mul(12)));
  const mottle = saturate(d.roughness.sub(info.roughness).mul(1.5).add(0.5));
  const pits = info.alpha === 'ao' ? mix(float(1), d.alpha, 0.5) : float(1);
  const chip = rustTint.mul(mix(float(0.65), float(1.3), mottle)).mul(pits);
  let ao = s.ao;
  if (info.alpha === 'ao' && layer.ao)
    ao = ao.mul(mix(float(1), d.alpha, coverage.mul(layer.ao).mul(d.fade)));
  const roughness = mix(
    s.roughness,
    saturate(float(0.8).add(d.roughness.sub(info.roughness).mul(layer.roughness ?? 0))),
    coverage,
  );
  // Chip edges and pitting: relief wherever the paint is weathered, strongest in the damage.
  const relief = saturate(level.mul(3)).mul(coverage.mul(0.6).add(0.4));
  return {
    color: mix(s.color, chip, coverage),
    roughness,
    ao,
    metalness: mix(s.metalness, float(0), coverage),
    delta: addDelta(s.delta, d.delta.mul(relief)),
    coverage,
  };
}

// Convenience for materials without weathering: base layer only.
export function applyDetail(detail: ResolvedDetail | null | undefined, p: N, n: N, s: Surface): Surface {
  return detail ? applyBaseLayer(detail.base, p, n, s) : s;
}
