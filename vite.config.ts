import { defineConfig } from 'vite-plus';

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

  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },

  fmt: {
    // Build output is gitignored, which already covers the default run — this
    // also stops `vp fmt dist` from reformatting it when given an explicit path.
    ignorePatterns: ['dist/**'],
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
    ignorePatterns: ['dist/**'],
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
    // Resolved against the Vite root, so this means src/*.test.ts.
    include: ['**/*.test.ts'],
  },

  staged: {
    '*': 'vp check --fix',
  },
});
