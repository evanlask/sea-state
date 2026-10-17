import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite-plus';

// Draco and Basis (KTX2) decoders for drop-in GLB models, served from three.js in dev and copied
// into dist/libs/ at build time. Only the WASM builds: every WebGPU browser has WebAssembly.
// DRACOLoader and KTX2Loader also reference their decoders with new URL(…, import.meta.url), which
// would emit a second, unused copy of every variant into dist/assets/; the app always sets the
// paths to libs/, so those defaults are blanked out.
const DECODER_LIBS: Record<string, string> = {
  'libs/draco/draco_wasm_wrapper.js': 'draco/gltf/draco_wasm_wrapper.js',
  'libs/draco/draco_decoder.wasm': 'draco/gltf/draco_decoder.wasm',
  'libs/basis/basis_transcoder.js': 'basis/basis_transcoder.js',
  'libs/basis/basis_transcoder.wasm': 'basis/basis_transcoder.wasm',
};

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const decoderSource = (path: string): string =>
  fileURLToPath(new URL(`node_modules/three/examples/jsm/libs/${DECODER_LIBS[path]}`, import.meta.url));

function decoderLibs(): Plugin {
  return {
    name: 'sea-state:decoder-libs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]?.replace(/^\//, '') ?? '';
        if (!Object.hasOwn(DECODER_LIBS, path)) return next();
        res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(decoderSource(path)));
      });
    },
    transform(code, id) {
      if (!/[\\/]three[\\/]examples[\\/]jsm[\\/]loaders[\\/](DRACO|KTX2)Loader\.js$/.test(id)) return null;
      return code.replace(/new URL\(\s*'\.\.\/libs\/[^']+',\s*import\.meta\.url\s*\)\.toString\(\)/g, "''");
    },
    generateBundle() {
      for (const fileName of Object.keys(DECODER_LIBS))
        this.emitFile({ type: 'asset', fileName, source: readFileSync(decoderSource(fileName)) });
    },
  };
}

export default defineConfig({
  // index.html lives in src/, so the Vite root is src/ rather than the repo
  // root. public/ and dist/ stay at the repo root, one level up.
  root: 'src',
  publicDir: '../public',
  // Otherwise Vite caches to <root>/node_modules and creates a stray
  // src/node_modules.
  cacheDir: '../node_modules/.vite',

  // Relative rather than '/repo-name/', so the build works at a domain root, a
  // GitHub Pages subpath, and from the filesystem without reconfiguring.
  base: './',

  plugins: [decoderLibs()],

  // The package.json version, shown in a corner of the main menu.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2023',
    // The three.js chunk alone is ~930 kB minified (~255 kB gzipped); warn only beyond that.
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        // three.js is most of the bundle and changes rarely, so it gets its own long-cached chunk.
        // Its examples/ addons stay with whatever imports them (the GLB loaders load on demand).
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/](?!examples[\\/])/ }],
        },
      },
    },
  },

  // ES-module workers so the simulation worker can share code-split chunks.
  worker: {
    format: 'es',
  },

  fmt: {
    // Build output is gitignored, which already covers the default run — this
    // also stops `vp fmt dist` from reformatting it when given an explicit path.
    ignorePatterns: ['dist/**', '.claude/**'],
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    printWidth: 110,
    tabWidth: 2,
    // Off by default in Oxfmt.
    sortImports: true,
    sortPackageJson: { sortScripts: true },
  },

  lint: {
    // Same as fmt above: guards the explicit-path case, e.g. `vp lint dist`.
    // .claude/ holds agent worktrees, each a full checkout with its own checks.
    ignorePatterns: ['dist/**', '.claude/**'],
    env: {
      browser: true,
      es2024: true,
    },
    // Adding a `plugins` array replaces the defaults (unicorn, oxc, typescript)
    // rather than extending them, so list those too if you add one.
    options: {
      // Warnings fail the build. Without this `vp check` exits 0 on them, so
      // things like unused variables would accumulate silently.
      denyWarnings: true,
      // Type checking via tsgolint, which is what lets `vp check` stand in for
      // `tsc --noEmit`. Adding compilerOptions.baseUrl silently disables both.
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },

  test: {
    // Resolved against the Vite root, so this means src/**/*.test.ts, plus the asset pipeline's.
    include: ['**/*.test.ts', '../scripts/**/*.test.ts'],
  },

  staged: {
    '*': 'vp check --fix',
  },
});
