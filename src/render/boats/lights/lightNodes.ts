// Shared GPU state and TSL for the boat lights: frame uniforms (pre-exposure, time, atmospheric
// extinction) and the per-instance visibility and glow maths of colregs.ts / glowMath.ts, evaluated
// against whichever camera renders (so split views and probes get their own arcs).

import { Vector3 } from 'three/webgpu';

import { type N, tsl } from '../../tsl';
import { VERTICAL_FLAT, VERTICAL_WIDTH } from './colregs';
import {
  GLARE_CORE_PX,
  GLARE_FLOOR,
  GLARE_K,
  lightExtinction,
  MAX_PRE_EXPOSED,
  PSF_SIGMA_PX,
  QUAD_MAX_PX,
  QUAD_MIN_PX,
  TWINKLE_AMOUNT,
  TWINKLE_FAR,
  TWINKLE_NEAR,
} from './glowMath';

const {
  abs,
  asin,
  atan,
  cameraPosition,
  cameraProjectionMatrix,
  clamp,
  dot,
  exp,
  float,
  floor,
  length,
  max,
  min,
  mix,
  modelWorldMatrixInverse,
  screenSize,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec3,
  vec4,
} = tsl;

const TWO_PI = Math.PI * 2;

// One set for all boats; BoatLights.update writes them (same values for every boat each frame).
export const lightUniforms = {
  preExposure: uniform(1) as N,
  time: uniform(0) as N,
  extinction: uniform(new Vector3(...lightExtinction())) as N, // 1/m per channel
  twinkle: uniform(1) as N, // 0 disables the scintillation
};

export function setLightAtmosphere(hazeDensity = 1, visibility = Number.POSITIVE_INFINITY): void {
  (lightUniforms.extinction.value as Vector3).set(...lightExtinction(hazeDensity, visibility));
}

export const MODE_SECTOR = 0;
export const MODE_CONE = 1;

// Per-instance shape attributes (see LampField):
//   shape  sector: (centre bearing, half width, vertical floor, 0)  cone: (beam dir xyz, cos inner)
//   edge0  sector: (from-edge inside fade, edge value, outside cut-off, mode) cone: (cos outer, floor, 0, mode)
//   edge1  sector: (to-edge inside fade, edge value, outside cut-off, 0)
export function visibilityNode(toViewer: N, shape: N, edge0: N, edge1: N): N {
  const n = toViewer.div(max(length(toViewer), 1e-6));
  // Sector (COLREG lights): horizontal cut-off ramps × vertical spread.
  const bearing = atan(n.x, n.z.negate());
  const raw = bearing.sub(shape.x);
  const delta = raw.sub(floor(raw.add(Math.PI).div(TWO_PI)).mul(TWO_PI));
  const outside = abs(delta).sub(shape.y);
  const fromSide = delta.lessThan(0);
  const insideFade = select(fromSide, edge0.x, edge1.x);
  const edgeValue = select(fromSide, edge0.y, edge1.y);
  const cutoff = select(fromSide, edge0.z, edge1.z);
  const inner = select(
    insideFade.greaterThan(1e-5),
    mix(edgeValue, float(1), clamp(outside.negate().div(max(insideFade, 1e-5)), 0, 1)),
    edgeValue,
  );
  const outer = edgeValue.mul(clamp(float(1).sub(outside.div(max(cutoff, 1e-5))), 0, 1));
  const horizontal = select(
    shape.y.greaterThanEqual(Math.PI - 1e-3),
    float(1),
    select(outside.lessThanEqual(0), inner, outer),
  );
  const x = max(abs(asin(clamp(n.y, -1, 1))).sub(VERTICAL_FLAT), 0).div(VERTICAL_WIDTH);
  const vertical = mix(shape.z, float(1), exp(x.mul(x).negate()));
  const sector = horizontal.mul(vertical);
  // Cone (work lights): full inside the beam, the housing's leak outside it.
  const cone = max(edge0.y, smoothstep(edge0.x, shape.w, dot(n, shape.xyz)));
  return select(edge0.w.greaterThan(0.5), cone, sector);
}

// The camera position in the object's (body) frame.
export const cameraInObject = (): N => modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;

// Radians per pixel at the image centre for the rendering camera and target.
export const pixelAngleNode = (): N => float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y));

export const transmittanceNode = (distance: N): N => exp(lightUniforms.extinction.mul(distance).negate());

export function twinkleNode(distance: N, phase: N): N {
  const t = lightUniforms.time;
  const wobble = sin(t.mul(5.3).add(phase))
    .mul(0.6)
    .add(sin(t.mul(11.7).add(phase.mul(1.7))).mul(0.4));
  const amount = smoothstep(TWINKLE_NEAR, TWINKLE_FAR, distance)
    .mul(TWINKLE_AMOUNT)
    .mul(lightUniforms.twinkle);
  return float(1).add(wobble.mul(amount));
}

// Glow sprite parameters per instance (vertex stage). `illuminance` is pre-exposed lux (vec3).
export function glowNodes(illuminance: N, lensAngle: N, px: N, lensDrawn: boolean) {
  const lensPx = lensAngle.mul(2).div(px);
  const coreSigma = lensDrawn ? px.mul(PSF_SIGMA_PX) : max(px.mul(PSF_SIGMA_PX), lensAngle.mul(0.5));
  const coreWeight = lensDrawn ? float(1).sub(smoothstep(1, 3, lensPx)) : float(1);
  const e = dot(illuminance, vec3(0.2126, 0.7152, 0.0722));
  const glareRadius = sqrt(e.mul(GLARE_K / GLARE_FLOOR));
  const quadRadius = min(px.mul(QUAD_MAX_PX), max(max(px.mul(QUAD_MIN_PX), coreSigma.mul(3)), glareRadius));
  return { coreSigma, coreWeight, quadRadius, theta0: px.mul(GLARE_CORE_PX) };
}

// Pre-exposed radiance at angle θ from the sprite centre.
export function glowRadiance(
  illuminance: N,
  theta: N,
  g: { coreSigma: N; coreWeight: N; quadRadius: N; theta0: N },
): N {
  const s2 = g.coreSigma.mul(g.coreSigma);
  const core = g.coreWeight.mul(exp(theta.mul(theta).div(s2.mul(-2)))).div(s2.mul(TWO_PI));
  const r = theta.div(g.quadRadius);
  const window = max(float(1).sub(r.mul(r)), 0);
  const halo = window
    .mul(window)
    .mul(GLARE_K)
    .div(theta.mul(theta).add(g.theta0.mul(g.theta0)));
  return min(illuminance.mul(core.add(halo)), MAX_PRE_EXPOSED);
}
