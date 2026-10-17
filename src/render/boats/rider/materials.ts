// Node materials for the skinned rider (character from Quaternius' Universal Base Characters, CC0).
// The outfit regions of outfit.ts are evaluated per fragment from the bind-pose position (the
// geometry attribute, untouched by skinning), with screen-space antialiased edges:
//  - body: the character's skin texture on the head, neck and hands; elsewhere a dark neoprene
//    wetsuit with coloured stripes, flatlock seams, knee pads, collar and cuff bindings and booties,
//    smoothing the anatomy of the normal map under the neoprene;
//  - vest: the life vest's foam shell cut to its outline, with edge tape, webbing straps, buckles,
//    a front zip and dark side panels;
//  - hair (tinted: the texture is grey) and eyes.
// Everything gets wetter-looking in rain and spray (boatEnvironment.wetness), and the head is cut
// away within a few decimetres of the camera, so the helm camera (at the rider's eyes) looks out
// rather than at the inside of his head. Two textures at most per material.

import {
  Color,
  type ColorRepresentation,
  DoubleSide,
  MeshStandardNodeMaterial,
  type Texture,
} from 'three/webgpu';

import { type N, tsl } from '../../tsl';
import { boatEnvironment } from '../kit/environment';
import { SUIT, VEST } from './outfit';

const {
  abs,
  cameraPosition,
  distance,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  normalGeometry,
  normalMap,
  positionGeometry,
  positionWorld,
  saturate,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
} = tsl;

const RIDER_COLORS = {
  suit: 0x1b1e25, // neoprene, blue-black
  stripe: 0xc8231d, // the jet ski's red
  knee: 0x2f333b,
  seam: 0x6c7078,
  bootie: 0x24262a,
  sole: 0x4a4d52,
  vest: 0xf3c01c, // high-visibility yellow
  webbing: 0x141518,
  buckle: 0x8d9197,
  hair: 0x2a1c12,
};

// Within this distance of the camera the head is not drawn (the helm camera sits at the eyes).
const HEAD_CLEARANCE = 0.25;

const rgb = (c: ColorRepresentation): N => {
  const color = new Color(c);
  return vec3(color.r, color.g, color.b);
};

// Coverage of `d > 0` with an antialiased edge.
const inside = (d: N): N => saturate(d.div(fwidth(d).add(1e-6)).add(0.5));

// A line of `width` (m) along d = 0.
const line = (d: N, width: number): N => float(1).sub(inside(abs(d).sub(width / 2)));

const smoothstepJs =
  (a: number, b: number): ((x: N) => N) =>
  (x) =>
    smoothstep(float(a), float(b), x);

// Keeps fragments off the head near the camera: the opacity for alphaTest.
const headClearance = (head: N): N =>
  float(1).sub(head.mul(step(distance(positionWorld, cameraPosition), float(HEAD_CLEARANCE))));

// Neoprene and skin darken and turn glossy when wet.
function wet(color: N, roughness: N, porosity: number): { color: N; roughness: N } {
  const w = boatEnvironment.wetness;
  return {
    color: color.mul(float(1).sub(w.mul(porosity * 0.35))),
    roughness: mix(roughness, roughness.min(0.2), w.mul(0.85)),
  };
}

export function riderBodyMaterial(skin: Texture, normal: Texture | null): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'rider:body';
  const p = positionGeometry;
  const ax = abs(p.x);
  const s = SUIT;
  const collar = mix(float(s.collarBack), float(s.collarFront), smoothstepJs(-0.04, 0.06)(p.z));
  const toCollar = collar.sub(p.y);
  const toCuff = float(s.cuffX).sub(ax);
  const skinHead = inside(toCollar.negate());
  const skinHand = inside(toCuff.negate()).mul(step(float(1.2), p.y));
  const skinMask = max(skinHead, skinHand);
  // Stripes: along the top of the sleeves and down the outside of the legs.
  const ay = p.y.sub(s.arm.y);
  const az = p.z.sub(s.arm.z);
  const armR = length(vec2(ay, az)).max(1e-4);
  const armSin = Math.sqrt(1 - s.arm.cos ** 2);
  const dArm = ay.div(armR).sub(s.arm.cos).mul(armR).div(armSin);
  const onSleeve = inside(ax.sub(0.19))
    .mul(inside(toCuff))
    .mul(step(float(1.3), p.y));
  const lx = ax.sub(s.leg.x);
  const lz = p.z.sub(float(s.leg.z0).add(smoothstepJs(s.leg.y0, s.leg.y1)(p.y).mul(s.leg.z1 - s.leg.z0)));
  const legR = length(vec2(lx, lz)).max(1e-4);
  const legSin = Math.sqrt(1 - s.leg.cos ** 2);
  const dLeg = lx.div(legR).sub(s.leg.cos).mul(legR).div(legSin);
  const onLeg = inside(p.y.sub(s.leg.bottom)).mul(inside(float(s.leg.top).sub(p.y)));
  const stripe = max(inside(dArm).mul(onSleeve), inside(dLeg).mul(onLeg));
  const kneeSin = Math.sqrt(1 - s.knee.cos ** 2);
  const dKnee = lz.div(legR).sub(s.knee.cos).mul(legR).div(kneeSin);
  const knee = inside(dKnee)
    .mul(inside(p.y.sub(s.knee.y0)))
    .mul(inside(float(s.knee.y1).sub(p.y)));
  // Flatlock seams on the stripe and pad edges; bindings at the collar and cuffs.
  const seam = max(
    max(line(dArm, 0.003).mul(onSleeve), line(dLeg, 0.003).mul(onLeg)),
    line(dKnee, 0.003)
      .mul(inside(p.y.sub(s.knee.y0)))
      .mul(inside(float(s.knee.y1).sub(p.y))),
  );
  const binding = max(
    inside(toCollar).mul(inside(float(0.009).sub(toCollar))),
    inside(toCuff)
      .mul(inside(float(0.011).sub(toCuff)))
      .mul(step(float(1.2), p.y)),
  );
  const bootie = inside(float(s.bootieY).sub(p.y));
  const sole = inside(float(s.soleY).sub(p.y));
  let suit: N = rgb(RIDER_COLORS.suit);
  suit = mix(suit, rgb(RIDER_COLORS.knee), knee);
  suit = mix(suit, rgb(RIDER_COLORS.stripe), max(stripe, binding));
  suit = mix(suit, rgb(RIDER_COLORS.seam), seam.mul(0.7));
  suit = mix(suit, rgb(RIDER_COLORS.bootie), bootie);
  suit = mix(suit, rgb(RIDER_COLORS.sole), sole);
  const suitRough = mix(mix(float(0.55), float(0.68), knee), float(0.75), bootie);
  const skinColor = texture(skin).rgb;
  const suitWet = wet(suit, suitRough, 1);
  const skinWet = wet(skinColor, float(0.5), 0.3);
  m.colorNode = mix(suitWet.color, skinWet.color, skinMask);
  m.roughnessNode = mix(suitWet.roughness, skinWet.roughness, skinMask);
  m.metalness = 0;
  // The anatomy stays sharp on bare skin; neoprene smooths it.
  if (normal) m.normalNode = normalMap(texture(normal), vec2(mix(float(0.35), float(1), skinMask)));
  m.opacityNode = headClearance(step(collar.sub(0.03), p.y));
  m.alphaTest = 0.5;
  return m;
}

// The life vest shell (outfit.ts buildVestShell): its own bind-pose position and normal.
export function riderVestMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'rider:vest';
  const p = positionGeometry;
  const n = normalGeometry;
  const ax = abs(p.x);
  const v = VEST;
  // vestDistance() in node form.
  const ellipse = (dx: N, dy: N, rx: number, ry: number): N =>
    length(vec2(dx.div(rx), dy.div(ry)))
      .sub(1)
      .mul(Math.min(rx, ry));
  const neckY = float(v.neck.y).sub(smoothstepJs(-0.03, 0.05)(p.z).mul(v.neck.drop));
  const d = min(
    min(p.y.sub(v.hem), float(v.top).sub(p.y)),
    min(
      min(
        ellipse(p.x, p.y.sub(neckY), v.neck.rx, v.neck.ry),
        ellipse(ax.sub(v.armhole.x), p.y.sub(v.armhole.y), v.armhole.rx, v.armhole.ry),
      ),
      float(v.side).sub(ax),
    ),
  );
  const front = smoothstep(float(0.35), float(0.6), n.z);
  const halfStrap = v.strapWidth / 2;
  let strap: N = float(0);
  for (const y of v.straps) strap = max(strap, float(1).sub(inside(abs(p.y.sub(y)).sub(halfStrap))));
  const buckle = strap.mul(front).mul(float(1).sub(inside(ax.sub(0.03))));
  const zip = line(p.x, 0.007)
    .mul(front)
    .mul(inside(p.y.sub(v.straps[1]! + halfStrap)));
  const side = inside(abs(n.x).sub(0.72));
  const tape = float(1).sub(inside(d.sub(v.binding)));
  let color: N = rgb(RIDER_COLORS.vest);
  color = mix(color, rgb(RIDER_COLORS.webbing), max(max(strap, tape), max(side, zip)));
  color = mix(color, rgb(RIDER_COLORS.buckle), buckle);
  const rough = mix(float(0.72), float(0.35), buckle);
  const w = wet(color, rough, 0.6);
  m.colorNode = w.color;
  m.roughnessNode = w.roughness;
  m.metalness = 0;
  m.opacityNode = inside(d);
  m.alphaTest = 0.5;
  return m;
}

export function riderHairMaterial(map: Texture | null, normal: Texture | null): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'rider:hair';
  const tint = rgb(RIDER_COLORS.hair);
  const w = wet(map ? texture(map).rgb.mul(tint).mul(1.6) : tint, float(0.7), 0.4);
  m.colorNode = w.color;
  m.roughnessNode = w.roughness;
  if (normal) m.normalNode = normalMap(texture(normal));
  m.side = DoubleSide;
  m.opacityNode = headClearance(float(1));
  m.alphaTest = 0.5;
  return m;
}

export function riderEyeMaterial(map: Texture | null): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'rider:eyes';
  m.colorNode = map ? texture(map).rgb : vec3(0.85, 0.85, 0.85);
  m.roughness = 0.15;
  m.opacityNode = headClearance(float(1));
  m.alphaTest = 0.5;
  return m;
}
