# Sea State: developer notes

The details behind the README: every script, deep-link keys, the asset pipeline, the drop-in model slot and the project layout.

## Running it

Needs Node 24.11 or newer (see `.node-version`).

```sh
npm install
npm run dev
```

| Script                  | What it does                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`           | Dev server with HMR                                                                  |
| `npm run build`         | Production build into `dist/`                                                        |
| `npm run preview`       | Serve the built output                                                               |
| `npm run check`         | Format, lint and type-check                                                          |
| `npm run check:fix`     | Same, writing fixes                                                                  |
| `npm run check:scripts` | Type-check `scripts/` (not covered by `check`)                                       |
| `npm run test`          | Unit tests                                                                           |
| `npm run calibrate`     | Re-run the virtual towing tank and rewrite `src/sim/boats/calibration/*.json`        |
| `npm run lockfile:fix`  | Point `package-lock.json` back at registry.npmjs.org (after installing via a mirror) |
| `npm run assets`        | Optimize raw assets into `public/` and rewrite `public/assets-manifest.json`         |
| `npm run assets:report` | Before/after size table for everything in the manifest                               |

### Deep links

Any scenario opens straight from the URL, which also makes screenshots repeatable:

```
?boat=cargo&fleet=pwc,sail&weather=gale&time=18:30&date=2026-07-15&region=bering-sea
&cam=chase&physics=realistic&quality=high&seed=1
```

`boat`: `cargo` `cruise` `crab` `sail` `powerboat` `pwc` `hydro` · `weather`: `glassy-calm` `fair` `breezy`
`near-gale` `gale` `storm` `hurricane-1` `hurricane-3` `hurricane-5` `overcast-drizzle` `fog-bank`
`long-swell` `cross-seas` `squalls` `night-thunderstorm` · `cam`: `chase` `helm` `bridge-port` `bridge-starboard` (ships) `mast` (sailboat) `orbit` `bow` `stern`
`port` `starboard` `waterline` `drone` `fixed` `cinematic` `photo` · `region`: `caribbean`
`north-atlantic` `bering-sea` `mediterranean` `southern-ocean` `arctic` · `quality`: `low` `medium` `high` `ultra` · `physics`: `arcade` `realistic`. `play` skips the menu. Setup-only keys: `mode=storm-survival`, `cargo=ballast`, `pots=60`, `wx=windKn:30,gustKn:40,…` (with
`weather=custom`) and `sea=mode:manual,spec:hs,hs:4,tp:9,…`. The address bar never changes during play;
with `debug`, starting a voyage from the menu logs its deep link to the console. Debug flags: `debug` (lil-gui panel),
`parity` (CPU-sampled wave heights drawn on the GPU sea), `sim=local` (simulation on the main thread),
`contrail` (a jet passes nearly overhead as the voyage starts, its contrail already across the sky;
with `debug`, the panel's **jet contrail overhead** button or `seaState.forceContrail()` sends another).

Lab pages for individual systems live under `src/dev/` (e.g. `/dev/sky-lab.html`, `/dev/hud-lab.html`,
`/dev/boat-lab.html`, `/dev/sail-lab.html`) and are served by the dev server only.

## Assets

Every boat ships as a procedural model. On Medium quality and up, the models also get close-up
surface detail from tiling CC0 texture sets (scratched and chipped paint, rusty steel, diamond plate,
teak planks, gelcoat, rubber, rope and sailcloth; 3.6 MB in all, and a scenario downloads only the
sets its boats use). They sit on top of the procedural colours and weathering and fade out with
distance. Which part gets which set, tile sizes and strengths are in
`src/render/boats/detail/tuning.ts`. If a set is missing, the procedural look is used.

Each boat also has a **drop-in GLB slot** in case you want to use your own model:

1. Put the raw model in `assets-src/models/<kind>/model.glb` (or `.gltf`), where `<kind>` is one
   of `cargo` `cruise` `crab` `sail` `powerboat` `pwc` `hydro`. Add an optional `align.json` and `credits.json`
   next to it. `assets-src/` is gitignored.
2. Run `npm run assets` (add `--draco` to try Draco, or use `--no-lods` / `--no-ktx2`). The model is
   cleaned up (dedup, prune, weld, GPU instancing), its textures are capped at 2048 px and converted to
   KTX2, two simplified LODs are made for distant boats, and everything is compressed with lossless
   Meshopt. Draco with quantization is kept only if it is at least 15% smaller. The output goes to
   `public/models/<kind>/`.
3. The game loads a model only if `public/assets-manifest.json` lists it. The loading screen shows its
   download in bytes. If it fails to load, the procedural model is used and a short notice appears.

`align.json` places the model in the boat's frame, where the bow is −Z, +Y is up and 0 is the
waterline. All fields are optional:

```json
{
  "forward": "+X",
  "up": "+Z",
  "rotation": [0, 0, 0],
  "loa": 10.1,
  "draft": 0.6,
  "offset": [0, 0, 0],
  "eye": [0, 2.2, 1],
  "maskTop": 1.2,
  "lights": [{ "kind": "stern", "position": [0, 1.1, 5] }]
}
```

- `forward` and `up` default to −Z and +Y.
- By default the model is scaled to the boat's real length overall (LOA) and sunk to its overall draft.
  `scale` or `waterline` override this.
- Light mounts can also be empty nodes in the model named `light:<kind>` (`light:sidePort`) or
  `light:<mount>` (`light:masthead`). Mounts that aren't placed keep the boat's default positions.
- The sea is kept out of the hull by a convex hull of the model up to `maskTop` metres above the
  waterline, which defaults to the freeboard.
- Animated parts, the sail cloth and deck floods still follow the procedural model's layout.

The same command also handles other assets:

- `assets-src/textures/` becomes KTX2. Normal, ORM, roughness and AO maps use UASTC with Zstandard.
  Colour maps use ETC1S. In a texture-set folder (`textures/<set>/normal.jpg`, `roughness.jpg`,
  `ao.jpg`, `metalness.jpg`, `color.jpg`), the data maps are packed into one `surface.ktx2`
  (normal X/Y, roughness, AO or metalness), or into a glTF-style `orm.ktx2` if there is no normal map.
  Size caps and skipped maps per set are in `scripts/assets/texturePacking.ts`.
- `assets-src/ui/` becomes lossless WebP.
- `assets-src/audio/` goes through ffmpeg: silence is trimmed, loudness is normalized to −16 LUFS, and
  each file is saved as Opus/WebM plus AAC .m4a (Apple's AAC encoder when ffmpeg has it). Files in
  `ambience/` are encoded in stereo.
- Files in `audio/**/loops/` are seamless loops (mono Opus 32 kbps, AAC 48 kbps; stereo if also under
  `ambience/`). They are not trimmed and get one linear gain toward −16 LUFS, so the seam survives.
  Each is padded with copies of its own tail and head, and the loop points go into the manifest, so
  codec priming and padding can't put a gap at the wrap. The shipped sea and rain loops, the sections
  they were cut from and their level trims are listed in `src/audio/recordings.ts`; the one-off cutting
  step is not kept, and the loops are committed as they are.

The jet ski rider (`public/models/characters/rider/model.glb`, 648 KB) was produced once from
Quaternius' Superhero Male with the Hair Buzzed part, from the free Universal Base Characters pack,
and is committed as-is: the pipeline has no step for characters and leaves `models/characters/` alone
apart from hashing it into the manifest. The game loads it only for a voyage with a jet ski, and falls
back to a procedural figure if it's missing or fails.

It also re-hashes `public/data/`. To remove an asset, delete it from `public/` and run the command
again. The Draco and Basis decoders are copied from three.js into `dist/libs/` at build time.

## Layout

```
src/
  app/        App, sessions, game loop, render clock, scenario → sim config, HUD/audio frame builders
  sim/        pure TypeScript (runs in the Web Worker and in tests): astro, ocean, weather,
              physics, boats, sail, world
  cloth/      XPBD cloth for the sails
  render/     WebGPU scene: ocean, sky, clouds, lighting, post, particles, weather, boats
  camera/  input/  audio/  settings/  ui/ (menus, HUD, loading, telemetry, overlay)
  dev/        lab pages for single systems (dev server only)
scripts/      asset pipeline, calibration and tuning tools: capsize and spawn sweeps, sim bench,
              audio levels (run with Node's TypeScript type stripping)
public/       optimized models, textures and audio, the asset manifest, and data/ (Yale Bright
              Star Catalogue)
```

Conventions: +Y up, north is −Z, east is +X; boats' bow is −Z and starboard +X; headings are radians
clockwise from north; wind and swell directions are "from"; everything in the simulation is SI.

## Toolchain notes

Built on [Vite+](https://viteplus.dev): one dependency for the dev server, bundler, Vitest, Oxlint and
Oxfmt. `vite.config.ts` is the single source of truth for formatting, linting, tests and the pre-commit
hook (`vp staged`). `vite-plus` is pinned exactly; move it with `npx vp upgrade`, then run
`npm run check:fix`. Two traps: a `plugins` array in the `lint` block replaces the default plugins,
and `compilerOptions.baseUrl` silently disables type-aware linting.

Tests sit next to the code as `*.test.ts` and import from `vite-plus/test` (a lint rule enforces it).
Shader-graph code uses the loosely typed TSL facade in `src/render/tsl.ts`.

CI (`.github/workflows/ci.yml`) runs check, test and build on pull requests; pushes to `main` deploy to
GitHub Pages (`.github/workflows/deploy.yml`, needs **Settings → Pages → Source: GitHub Actions**). The
build uses a relative `base`, so it works at a project subpath or a domain root.

## Credits

three.js (MIT). Algorithms after Tessendorf, Horvath, Hillaire, Schneider (Nubis), Kerner, Macklin
(XPBD), Holtrop-Mennen, Savitsky, Blendermann and Yasukawa & Yoshimura (MMG). Data: Yale Bright Star
Catalogue (via brettonw/YaleBrightStarCatalog, MIT), ORC certificate data (via jieter/orc-data).
Textures: [ambientCG](https://ambientcg.com) PaintedMetal004, PaintedMetal006, Metal022, Planks023A,
DiamondPlate008A, Fabric061, Rope001, Rubber004 and Plastic013A, all CC0 (crediting is optional, but we
do). Model: the jet ski rider is Quaternius' [Universal Base Characters](https://quaternius.com)
(Superhero Male, Hair Buzzed; CC0). The full list is in [CREDITS.md](../CREDITS.md).
