// The detail materials compile to WGSL (no GPU needed: the node builder runs on the CPU) and stay
// inside WebGPU's 16 samplers per fragment stage once the scene's lighting adds its own.

import {
  DataTexture,
  DirectionalLight,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Mesh,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  TorusGeometry,
  WebGPURenderer,
} from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  deckMaterial,
  hullPaintMaterial,
  nonSkidMaterial,
  paintMaterial,
  simpleMaterial,
  teakMaterial,
} from '../kit/materials';
import { SailView } from '../SailView';
import {
  boatDetail,
  type DetailMaps,
  registerDetailMaps,
  resetDetailState,
  resolveRecipe,
  setDetailEnabled,
} from './detail';
import { BOAT_DETAIL } from './tuning';

// Samplers the scene adds to every lit boat material at most: AO volume, environment map, cloud
// shadow, 4 sun shadow cascades and 3 shadowed deck lights (Ultra). The BRDF LUT is in the WGSL here.
const LIGHTING_SAMPLERS = 1 + 1 + 1 + 4 + 3;
const MAX_SAMPLERS = 16;

function texture(): DataTexture {
  const t = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  return t;
}
const maps = (): DetailMaps => ({ surface: texture(), color: texture() });

function fragmentShader(material: Material): string {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const renderer = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  renderer.hasFeature = () => false;
  const scene = new Scene();
  scene.add(new DirectionalLight());
  const camera = new PerspectiveCamera();
  const mesh = new Mesh(new TorusGeometry(), material);
  scene.add(mesh);
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = renderer.backend as any;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.material = material;
  builder.camera = camera;
  builder.context.material = material;
  // oxlint-disable-next-line typescript/no-explicit-any
  builder.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  builder.build();
  return builder.fragmentShader as string;
}

const samplers = (wgsl: string): number => (wgsl.match(/: sampler(_comparison)?;/g) ?? []).length;

afterEach(() => resetDetailState());

describe('detail materials', () => {
  const all = (recipe: (typeof BOAT_DETAIL)['crab'][string]) => resolveRecipe(recipe, maps);
  const cases: [string, () => Material][] = [
    [
      'crab hull (mask + paint + chipped paint)',
      () =>
        hullPaintMaterial({
          topside: 0x1f3a5c,
          bands: [],
          rust: 1,
          grime: 0.6,
          plates: { horizontal: 4.5, vertical: 1.5, frames: 0.5 },
          mask: { texture: texture(), zBow: -19, length: 38, yMin: -3, yMax: 5 },
          detail: all(BOAT_DETAIL.crab.hull!),
        }),
    ],
    [
      'crab machinery (paint + rust through)',
      () => paintMaterial({ color: 0x3f5f78, rust: 0.6, detail: all(BOAT_DETAIL.crab.machinery!) }),
    ],
    [
      'crab deck (diamond plate)',
      () => deckMaterial({ color: 0x5c605e, rust: 0.27, wear: 0.6, detail: all(BOAT_DETAIL.crab.deck!) }),
    ],
    [
      'cargo deck (paint + chips)',
      () => deckMaterial({ color: 0x4a5a4b, rust: 0.15, detail: all(BOAT_DETAIL.cargo.deck!) }),
    ],
    [
      'crab steel (rusty steel)',
      () => simpleMaterial({ color: 0x8c9091, metalness: 0.85, detail: all(BOAT_DETAIL.crab.steel!) }),
    ],
    [
      'sail hull (gelcoat, clear coat)',
      () =>
        hullPaintMaterial({
          topside: 0xf3f2ed,
          bands: [],
          clearcoat: 1,
          detail: all(BOAT_DETAIL.sail.hull!),
        }),
    ],
    ['sail teak (planks)', () => teakMaterial({ detail: all(BOAT_DETAIL.sail.teak!) })],
    ['pwc mat (rubber)', () => nonSkidMaterial({ color: 0x1d1e20, detail: all(BOAT_DETAIL.pwc.mat!) })],
    [
      'sailcloth',
      () => {
        setDetailEnabled(true);
        registerDetailMaps('sailcloth', maps());
        const view = new SailView({ parent: new Group() });
        let material: Material | null = null;
        view.group.traverse((o) => {
          if (o instanceof Mesh && o.name === 'mainsail') material = o.material as Material;
        });
        return material!;
      },
    ],
  ];

  for (const [name, make] of cases)
    it(`compiles: ${name}`, () => {
      const wgsl = fragmentShader(make());
      expect(wgsl).toContain('textureSample');
      expect(samplers(wgsl) + LIGHTING_SAMPLERS).toBeLessThanOrEqual(MAX_SAMPLERS);
    });

  it('falls back to the procedural shader when the textures are missing', () => {
    // Enabled, but nothing loaded (not in the manifest, or the download failed).
    setDetailEnabled(true);
    const pairs: [Material, Material][] = [
      [
        paintMaterial({ color: 0x3f5f78, rust: 0.6 }),
        paintMaterial({ color: 0x3f5f78, rust: 0.6, detail: boatDetail('crab', 'machinery') }),
      ],
      [
        hullPaintMaterial({ topside: 0x1f3a5c, bands: [], rust: 1 }),
        hullPaintMaterial({ topside: 0x1f3a5c, bands: [], rust: 1, detail: boatDetail('crab', 'hull') }),
      ],
      [teakMaterial(), teakMaterial({ detail: boatDetail('sail', 'teak') })],
      [
        simpleMaterial({ color: 0xf0efea, clearcoat: 0.6 }),
        simpleMaterial({ color: 0xf0efea, clearcoat: 0.6, detail: boatDetail('sail', 'gelcoat') }),
      ],
    ];
    for (const [plain, fallback] of pairs) expect(fragmentShader(fallback)).toBe(fragmentShader(plain));
  });
});
