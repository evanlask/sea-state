// Renders the sailboat's two cloth sails (and, optionally, a thin lab rig: mast, boom, forestay and
// sheets) from a snapshot's 'sail.*' telemetry. The cloth runs here on the main thread, in the boat's
// body frame: add `group` under the boat's Object3D (bow −Z, up +Y, starboard +X, origin on the design
// waterline) and call update() every frame with the interpolated boat orientation.
//
// Sailcloth: off-white Dacron, double-sided, with procedural cross-cut panel seams, luff/leech tapes,
// corner patches and (main) batten pockets, plus a back-lit translucency term so a sail glows where
// the sun shines through it. With the sailcloth detail set loaded, a faint weave in the normal map.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Line,
  LineBasicNodeMaterial,
  Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import { type ClothQuality, MAIN_BATTENS, SailCloth } from '../../cloth/SailCloth';
import { sailFrame, sailFramesFromTelemetry } from '../../cloth/sailFrames';
import { CC115_RIG, type RigSpec } from '../../sim/sail/rig';
import { SAIL_KEYS as K } from '../../sim/sail/telemetry';
import { disposeOwnedTree } from '../gpuResources';
import { type N, tsl } from '../tsl';
import { type ClothBudget, ClothStepper, FULL_CLOTH } from './clothBudget';
import { boatDetail } from './detail/detail';
import { detailFade } from './detail/nodes';

const {
  Fn,
  abs,
  attribute,
  float,
  fract,
  fwidth,
  max,
  mix,
  normalMap,
  normalWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
  length,
  vec2,
} = tsl;

export type SailResolution = ClothQuality | readonly [number, number]; // preset or [cols, rows]

export interface SailViewOptions {
  parent: Object3D;
  quality?: SailResolution;
  rig?: RigSpec;
  showRig?: boolean; // thin mast/boom/forestay/sheets for labs (the boat model kit draws the real rig)
}

interface SailMesh {
  cloth: SailCloth;
  mesh: Mesh;
  geometry: BufferGeometry;
  position: BufferAttribute;
  normal: BufferAttribute;
  chord: BufferAttribute; // per vertex, its row's rest chord (m), so tapes and patches keep their size
  shapeVersion: number; // the cloth's shapeVersion the chords were written for
  material: MeshStandardNodeMaterial;
}

const PANEL_WIDTH = 1.05; // m, cross-cut panel height
const SEAM = 0.012; // m half-width of a seam
const sunDirection = uniform(new Vector3(0.3, 0.8, 0.2));
const sunColor = uniform(new Color(1, 0.97, 0.9));
const translucency = uniform(0.45);

// Procedural sailcloth colour for a sail of luff/foot (m) in uv (u chordwise, v up the luff); the
// 'chord' attribute is the local chord (m), which narrows to nothing at a pointed head.
function sailclothColor(luff: N, foot: N, battens: readonly number[]): N {
  return Fn(() => {
    const st = uv();
    const chord = attribute('chord', 'float');
    const along = st.y.mul(luff); // metres up the luff
    const across = st.x.mul(chord); // metres aft of the luff
    const base = vec3(0.92, 0.915, 0.89).toVar();
    // Cross-cut seams, a stitched double line each.
    const panel = along.div(PANEL_WIDTH);
    const d = abs(fract(panel.add(0.5)).sub(0.5)).mul(PANEL_WIDTH);
    const aa = fwidth(along).add(1e-4);
    const seam = float(1).sub(smoothstep(SEAM, aa.add(SEAM), d));
    base.assign(mix(base, vec3(0.8, 0.79, 0.76), seam.mul(0.7)));
    // Luff and leech tapes.
    const tape = max(
      float(1).sub(smoothstep(0.04, aa.add(0.04), across)),
      float(1).sub(smoothstep(0.035, aa.add(0.035), chord.sub(across))),
    );
    base.assign(mix(base, vec3(0.78, 0.77, 0.74), tape.mul(0.8)));
    // Corner reinforcement patches at tack, clew and head.
    const corner = (cu: number, cv: number, r: number): N =>
      float(1).sub(smoothstep(r, r + 0.02, length(vec2(across.sub(foot.mul(cu)), along.sub(luff.mul(cv))))));
    const patches = max(max(corner(0, 0, 0.7), corner(1, 0, 0.8)), corner(0, 1, 0.5));
    base.assign(mix(base, vec3(0.86, 0.85, 0.82), patches.mul(0.6)));
    // Batten pockets on the aft third of the main.
    for (const b of battens) {
      const pocket = float(1)
        .sub(smoothstep(0.03, aa.add(0.03), abs(along.sub(luff.mul(b)))))
        .mul(smoothstep(0.55, 0.6, st.x));
      base.assign(mix(base, vec3(0.83, 0.82, 0.79), pocket));
    }
    return base;
  })();
}

// Sailcloth weave from the detail set (tuning.ts BOAT_DETAIL.sail.sail), in metres of sail, or null.
function sailclothNormal(luff: N): N {
  const detail = boatDetail('sail', 'sail')?.base;
  if (!detail) return null;
  const { layer, maps } = detail;
  const st = uv();
  const across = st.x.mul(attribute('chord', 'float'));
  const t = texture(maps.surface, vec2(across, st.y.mul(luff)).div(layer.tile));
  // KTX2 rows run top-down, so the OpenGL map's green is flipped for uv space.
  return normalMap(vec3(t.r, float(1).sub(t.g), 1), vec2(detailFade(layer).mul(layer.normal)));
}

function addNormal(nor: Float32Array, k: number, nx: number, ny: number, nz: number): void {
  nor[k] = nor[k]! + nx;
  nor[k + 1] = nor[k + 1]! + ny;
  nor[k + 2] = nor[k + 2]! + nz;
}

const qInv = new Quaternion();
const gravity = new Vector3();
const g3 = { x: 0, y: -9.81, z: 0 };

export class SailView {
  readonly group = new Group();
  readonly rig: RigSpec;
  private main!: SailMesh;
  private jib!: SailMesh;
  private readonly mainFrame = sailFrame();
  private readonly jibFrame = sailFrame();
  private readonly luffUniforms = { main: uniform(14.3), jib: uniform(15.3) };
  private readonly footUniforms = { main: uniform(5), jib: uniform(5.3) };
  private readonly boomPivot = new Group();
  private readonly furledRoll: Mesh;
  private readonly sheets: Line | null = null;
  private readonly sheetPositions = new Float32Array(12);
  private quality: SailResolution;
  private readonly showRig: boolean;
  private readonly stepper = new ClothStepper(Math.floor(Math.random() * 8));

  constructor(options: SailViewOptions) {
    this.rig = options.rig ?? CC115_RIG;
    this.quality = options.quality ?? 'high';
    this.showRig = options.showRig ?? false;
    this.group.name = 'sails';
    options.parent.add(this.group);
    this.buildSails();
    const r = this.rig;
    const spar = new MeshStandardNodeMaterial({ color: 0x9aa3ab, roughness: 0.35, metalness: 0.8 });
    // The rolled genoa on the forestay.
    const fx = r.tack;
    const head = new Vector3(0, r.deckY + r.I - r.genoaHeadDrop, r.mastZ - 0.1);
    const stay = new Vector3().subVectors(head, new Vector3(fx.x, fx.y, fx.z));
    this.furledRoll = new Mesh(new CylinderGeometry(1, 0.35, 1, 10), this.main.material);
    this.furledRoll.position.set(fx.x, fx.y, fx.z).addScaledVector(stay, 0.5);
    this.furledRoll.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), stay.clone().normalize());
    this.furledRoll.scale.set(0.001, stay.length(), 0.001);
    this.group.add(this.furledRoll);
    if (this.showRig) {
      const mast = new Mesh(new CylinderGeometry(0.07, 0.09, r.mastheadY - r.deckY, 12), spar);
      mast.position.set(0, (r.mastheadY + r.deckY) / 2, r.mastZ);
      const boom = new Mesh(new CylinderGeometry(0.06, 0.06, r.boomLength, 10), spar);
      boom.rotation.x = Math.PI / 2;
      boom.position.z = r.boomLength / 2;
      this.boomPivot.add(boom);
      this.boomPivot.position.set(0, r.boomY - 0.08, r.mastZ);
      const forestay = new Mesh(new CylinderGeometry(0.012, 0.012, stay.length() * 1.03, 6), spar);
      forestay.position.copy(this.furledRoll.position);
      forestay.quaternion.copy(this.furledRoll.quaternion);
      this.group.add(mast, this.boomPivot, forestay);
      const geometry = new BufferGeometry();
      const attribute = new BufferAttribute(this.sheetPositions, 3);
      attribute.setUsage(DynamicDrawUsage);
      geometry.setAttribute('position', attribute);
      this.sheets = new Line(geometry, new LineBasicNodeMaterial({ color: 0x2b3440 }));
      this.sheets.frustumCulled = false;
      this.group.add(this.sheets);
    }
  }

  private buildSail(kind: 'main' | 'jib'): SailMesh {
    const cloth = new SailCloth(kind, this.quality);
    const n = cloth.cloth.count;
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(3 * n), 3);
    const normal = new BufferAttribute(new Float32Array(3 * n), 3);
    const chord = new BufferAttribute(new Float32Array(n).fill(1), 1);
    position.setUsage(DynamicDrawUsage);
    normal.setUsage(DynamicDrawUsage);
    chord.setUsage(DynamicDrawUsage);
    const uvs = new Float32Array(2 * n);
    for (let r = 0; r < cloth.rows; r++) {
      for (let q = 0; q < cloth.cols; q++) {
        const i = r * cloth.cols + q;
        uvs[2 * i] = q / (cloth.cols - 1);
        uvs[2 * i + 1] = r / (cloth.rows - 1);
      }
    }
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('chord', chord);
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setIndex(new BufferAttribute(cloth.triangles, 1));
    const material = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.62, metalness: 0 });
    const colorNode = sailclothColor(
      this.luffUniforms[kind],
      this.footUniforms[kind],
      kind === 'main' ? MAIN_BATTENS : [],
    );
    material.colorNode = colorNode;
    const weave = sailclothNormal(this.luffUniforms[kind]);
    if (weave) material.normalNode = weave;
    // Light through the cloth from behind (normalWorld already faces the viewer on back faces).
    material.emissiveNode = colorNode
      .mul(sunColor)
      .mul(translucency)
      .mul(max(normalWorld.dot(sunDirection).negate(), 0));
    const mesh = new Mesh(geometry, material);
    mesh.name = kind === 'main' ? 'mainsail' : 'genoa';
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false; // a thin double-sided sheet only shadow-acnes itself
    this.group.add(mesh);
    return { cloth, mesh, geometry, position, normal, chord, shapeVersion: -1, material };
  }

  private buildSails(): void {
    this.main = this.buildSail('main');
    this.jib = this.buildSail('jib');
  }

  setQuality(quality: SailResolution): void {
    if (String(quality) === String(this.quality)) return;
    this.quality = quality;
    for (const s of [this.main, this.jib]) {
      this.group.remove(s.mesh);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.buildSails();
    this.furledRoll.material = this.main.material;
  }

  // Sun direction (world, toward the sun), colour and a 0..1 strength for the back-lit glow.
  setSun(direction: Vector3, color: Color, strength = 1): void {
    sunDirection.value.copy(direction).normalize();
    sunColor.value.copy(color);
    translucency.value = 0.45 * strength;
  }

  get mainCloth(): SailCloth {
    return this.main.cloth;
  }

  get jibCloth(): SailCloth {
    return this.jib.cloth;
  }

  // Advances the cloth by dt from the latest telemetry; `orientation` is the boat's render quaternion.
  // `budget` lets distant sails step less often and more coarsely (clothBudget.ts).
  update(
    dt: number,
    telemetry: Readonly<Record<string, number>>,
    orientation: Quaternion,
    time: number,
    budget: Readonly<ClothBudget> = FULL_CLOTH,
  ): void {
    const step = this.stepper.advance(dt, budget);
    if (step <= 0) return;
    dt = step;
    qInv.copy(orientation).invert();
    gravity.set(0, -9.81, 0).applyQuaternion(qInv);
    g3.x = gravity.x;
    g3.y = gravity.y;
    g3.z = gravity.z;
    const furl = sailFramesFromTelemetry(telemetry, g3, this.mainFrame, this.jibFrame, this.rig);
    const mf = this.mainFrame;
    const jf = this.jibFrame;
    this.luffUniforms.main.value = mf.head.y - mf.tack.y;
    this.footUniforms.main.value = Math.hypot(mf.clew.x - mf.tack.x, mf.clew.z - mf.tack.z);
    this.luffUniforms.jib.value = Math.hypot(jf.head.y - jf.tack.y, jf.head.z - jf.tack.z);
    this.footUniforms.jib.value = Math.hypot(
      jf.clew.x - jf.tack.x,
      jf.clew.y - jf.tack.y,
      jf.clew.z - jf.tack.z,
    );
    this.main.cloth.update(dt, mf, time, budget.maxSubsteps);
    this.writeMesh(this.main);
    const jibVisible = furl < 0.97;
    this.jib.mesh.visible = jibVisible;
    if (jibVisible) {
      this.jib.cloth.update(dt, jf, time, budget.maxSubsteps);
      this.writeMesh(this.jib);
    }
    // The rolled-up part thickens the furler.
    const radius = 0.03 + 0.11 * Math.min(1, furl);
    this.furledRoll.scale.x = this.furledRoll.scale.z = furl > 0.01 ? radius : 0.001;
    if (this.showRig) this.updateRig(telemetry);
  }

  private updateRig(t: Readonly<Record<string, number>>): void {
    const r = this.rig;
    this.boomPivot.rotation.y = t[K.boomAngle] ?? 0;
    const p = this.sheetPositions;
    // Mainsheet: boom end → traveller; genoa sheet: clew → lead on the clew's side.
    p[0] = t[K.boomEndX] ?? 0;
    p[1] = (t[K.boomEndY] ?? r.boomY) - 0.05;
    p[2] = t[K.boomEndZ] ?? r.mastZ + r.boomLength;
    p[3] = r.traveller.x;
    p[4] = r.traveller.y;
    p[5] = r.traveller.z;
    const side = (t[K.jibAngle] ?? 0) >= 0 ? 1 : -1;
    p[6] = side * r.jibLead.x;
    p[7] = r.jibLead.y;
    p[8] = r.jibLead.z;
    p[9] = t[K.jibClewX] ?? 0;
    p[10] = t[K.jibClewY] ?? r.tack.y;
    p[11] = t[K.jibClewZ] ?? r.mastZ;
    const attribute = this.sheets?.geometry.getAttribute('position');
    if (attribute) attribute.needsUpdate = true;
  }

  private writeMesh(s: SailMesh): void {
    const src = s.cloth.positions;
    const pos = s.position.array as Float32Array;
    const nor = s.normal.array as Float32Array;
    for (let i = 0; i < src.length; i++) pos[i] = src[i]!;
    // Area-weighted vertex normals.
    nor.fill(0);
    const tri = s.cloth.triangles;
    for (let t = 0; t < tri.length; t += 3) {
      const a = 3 * tri[t]!;
      const b = 3 * tri[t + 1]!;
      const c = 3 * tri[t + 2]!;
      const e1x = pos[b]! - pos[a]!;
      const e1y = pos[b + 1]! - pos[a + 1]!;
      const e1z = pos[b + 2]! - pos[a + 2]!;
      const e2x = pos[c]! - pos[a]!;
      const e2y = pos[c + 1]! - pos[a + 1]!;
      const e2z = pos[c + 2]! - pos[a + 2]!;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      addNormal(nor, a, nx, ny, nz);
      addNormal(nor, b, nx, ny, nz);
      addNormal(nor, c, nx, ny, nz);
    }
    for (let i = 0; i < nor.length; i += 3) {
      const len = Math.hypot(nor[i]!, nor[i + 1]!, nor[i + 2]!) || 1;
      nor[i] = nor[i]! / len;
      nor[i + 1] = nor[i + 1]! / len;
      nor[i + 2] = nor[i + 2]! / len;
    }
    s.position.needsUpdate = true;
    s.normal.needsUpdate = true;
    if (s.shapeVersion !== s.cloth.shapeVersion) {
      s.shapeVersion = s.cloth.shapeVersion;
      const chord = s.chord.array as Float32Array;
      const { cols, rows, chords } = s.cloth;
      for (let r = 0; r < rows; r++) chord.fill(chords[r]!, r * cols, (r + 1) * cols);
      s.chord.needsUpdate = true;
    }
  }

  // Everything under the group is the view's own: sails, the furled genoa, spars and sheets.
  dispose(): void {
    disposeOwnedTree(this.group);
    this.group.removeFromParent();
  }
}
