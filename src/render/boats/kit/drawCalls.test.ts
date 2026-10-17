// Draw calls of the procedural boats (render CPU time is mostly per draw): each LOD draws fewer
// meshes than the one before, the static parts reach the shadow maps as one proxy mesh or two, a
// name on both bows is one decal, the plain simple and lamp slots share a merged mesh that carries
// their values, and the wheelhouse interior is hidden from far off.

import { BoxGeometry, type Material, type Mesh, type Object3D, PerspectiveCamera } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import type { BoatKind } from '../../../sim/world/protocol';
import { LampField } from '../lights/LampField';
import { cargoDraft } from '../models/cargo';
import { crabDraft } from '../models/crab';
import { cruiseDraft } from '../models/cruise';
import { hydroDraft } from '../models/hydro';
import { powerboatDraft } from '../models/powerboat';
import { pwcDraft } from '../models/pwc';
import { sailDraft } from '../models/sail';
import { assemble, type ModelDraft } from './assemble';
import { BoatVisual, type BoatTemplate } from './BoatVisual';
import { PartBuilder } from './geometry';
import { lampMaterial, SIMPLE_COLOR, SIMPLE_PBR, simpleMaterial } from './materials';
import { SHADOW_LAYER, SHADOW_PROXY } from './shadowProxy';
import { INTERIOR_MESH } from './slotMerge';

// The ship models paint liveries on canvases: a do-nothing 2D context is enough here.
function stubDocument(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const ctx: unknown = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'getImageData')
          return (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          });
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern')
          return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: () => true,
    },
  );
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

const DRAFTS: Record<BoatKind, () => ModelDraft> = {
  cargo: () => cargoDraft(false),
  cruise: cruiseDraft,
  crab: () => crabDraft(24),
  sail: sailDraft,
  powerboat: powerboatDraft,
  pwc: pwcDraft,
  hydro: hydroDraft,
};

// Main-pass draws by LOD (without surface-detail textures, which keep a few slots apart), and the
// shadow casters of LOD0. The procedural jet-ski rider's arms move on their own, so they cast apart.
const BUDGET: Record<BoatKind, { draws: [number, number, number]; casters: number }> = {
  cargo: { draws: [40, 24, 18], casters: 10 },
  cruise: { draws: [40, 25, 14], casters: 8 },
  crab: { draws: [33, 20, 13], casters: 5 },
  sail: { draws: [26, 21, 15], casters: 7 },
  powerboat: { draws: [33, 28, 20], casters: 7 },
  pwc: { draws: [30, 28, 15], casters: 16 },
  hydro: { draws: [12, 10, 6], casters: 6 },
};

const meshesOf = (root: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh || (o as { isSprite?: boolean }).isSprite || (o as { isLine?: boolean }).isLine)
      out.push(o as Mesh);
  });
  return out;
};

const templates = new Map<BoatKind, BoatTemplate>();
function template(kind: BoatKind): BoatTemplate {
  stubDocument();
  let t = templates.get(kind);
  if (!t) templates.set(kind, (t = assemble(DRAFTS[kind]())));
  return t;
}

describe('boat draw calls', () => {
  for (const kind of Object.keys(DRAFTS) as BoatKind[]) {
    it(`${kind}: fewer draws at each level of detail, within budget`, () => {
      const t = template(kind);
      const draws = t.lods.map((lod) => meshesOf(lod).filter((m) => m.name !== SHADOW_PROXY).length);
      expect(draws[0]!).toBeGreaterThan(draws[1]!);
      expect(draws[1]!).toBeGreaterThan(draws[2]!);
      draws.forEach((n, i) => expect(n).toBeLessThanOrEqual(BUDGET[kind].draws[i]!));
      expect(meshesOf(t.lods[0]!).filter((m) => m.castShadow).length).toBeLessThanOrEqual(
        BUDGET[kind].casters,
      );
    });

    it(`${kind}: static parts cast through shadow proxies only the shadow cameras see`, () => {
      for (const lod of template(kind).lods) {
        for (const proxy of meshesOf(lod).filter((m) => m.name === SHADOW_PROXY)) {
          expect(proxy.castShadow).toBe(true);
          expect(proxy.layers.mask).toBe(1 << SHADOW_LAYER);
          // The parts merged into it stopped casting; animated or instanced ones may still.
          for (const sibling of proxy.parent!.children as Mesh[]) {
            if (sibling === proxy || sibling.name === SHADOW_PROXY || !sibling.isMesh) continue;
            const m = sibling.material as Material;
            if (!m.transparent && m.alphaTest === 0 && m.side === (proxy.material as Material).side)
              expect(sibling.castShadow).toBe(false);
          }
        }
      }
    });

    it(`${kind}: one decal mesh per decal texture`, () => {
      for (const lod of template(kind).lods) {
        lod.traverse((parent) => {
          const decals = parent.children.filter((c) => c.name === 'decal') as Mesh[];
          expect(new Set(decals.map((d) => d.material)).size).toBe(decals.length);
        });
      }
    });
  }
});

describe('merged slots', () => {
  it('carry each slot’s colour and finish per vertex, the interior apart', () => {
    const b = new PartBuilder();
    b.add('chrome', new BoxGeometry(1, 1, 1));
    b.add('orange', new BoxGeometry(1, 1, 1));
    b.add('console', new BoxGeometry(1, 1, 1));
    b.add('ceiling', new BoxGeometry(1, 1, 1));
    b.add('lampRed', new BoxGeometry(0.1, 0.1, 0.1));
    b.add('lampGreen', new BoxGeometry(0.1, 0.1, 0.1));
    const materials = {
      chrome: simpleMaterial({ color: 0xffffff, roughness: 0.1, metalness: 1 }),
      orange: simpleMaterial({ color: 0xff8000, roughness: 0.4 }),
      console: simpleMaterial({ color: 0x222222, roughness: 0.6 }),
      ceiling: simpleMaterial({ color: 0xdddddd, roughness: 0.8 }),
      lampRed: lampMaterial({ color: 0xff0000, nits: 3000, channel: 'interior' }),
      lampGreen: lampMaterial({ color: 0x00ff00, nits: 3000, channel: 'interior' }),
    };
    const built = b.build(materials);
    const meshes = built.group.children.filter((c) => c.name !== SHADOW_PROXY);
    expect(meshes.map((m) => m.name).sort()).toEqual([INTERIOR_MESH, 'lamps', 'simple']);
    expect(built.meshes.get('chrome')).toBe(built.meshes.get('orange'));
    const simple = built.meshes.get('chrome')!.geometry;
    const pbr = simple.getAttribute(SIMPLE_PBR);
    const color = simple.getAttribute(SIMPLE_COLOR);
    const count = pbr.count;
    // Chrome first, then orange: 24 vertices each.
    expect([pbr.getX(0), pbr.getY(0)]).toEqual([expect.closeTo(0.1, 5), 1]);
    expect([pbr.getX(count - 1), pbr.getY(count - 1)]).toEqual([expect.closeTo(0.4, 5), 0]);
    expect(color.getX(count - 1)).toBeCloseTo(1, 5);
    expect(built.triangles).toBe(6 * 12);
  });
});

describe('wheelhouse interior', () => {
  it('is drawn near the ship and hidden where a metre spans under 2 pixels', () => {
    const visual = new BoatVisual(template('cargo'));
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 10_000);
    const at = (z: number): void => {
      camera.position.set(0, 30, z);
      camera.updateMatrixWorld();
      visual.update(1 / 60, camera, 1080);
    };
    at(150);
    expect(visual.interiorVisible).toBe(true);
    at(700); // still LOD0 for a 230 m ship
    expect(visual.lod).toBe(0);
    expect(visual.interiorVisible).toBe(false);
    at(150);
    expect(visual.interiorVisible).toBe(true);
    visual.setWarmup(true);
    at(700);
    expect(visual.interiorVisible).toBe(true);
  });
});

describe('lamp glows', () => {
  it('draw only while a lamp is lit, or while warming up', () => {
    const field = new LampField([
      {
        position: { x: 0, y: 1, z: 0 },
        lensRadius: 0.05,
        colour: [1, 1, 1],
        intensity: 10,
        shape: { mode: 'cone', direction: { x: 0, y: -1, z: 0 }, angle: 1, leak: 0.1 },
      },
    ]);
    const glow = field.object.getObjectByName('lamp-glow')!;
    expect(glow.visible).toBe(false);
    field.setOn(0, true);
    expect(glow.visible).toBe(true);
    field.setOn(0, false);
    expect(glow.visible).toBe(false);
    field.setWarmup(true);
    expect(glow.visible).toBe(true);
    field.setWarmup(false);
    expect(glow.visible).toBe(false);
  });
});
