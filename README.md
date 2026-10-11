# viteplus-starter

A minimal starter for quick browser experiments, built on [Vite+](https://viteplus.dev).
TypeScript is set up and ready, but plain JavaScript works just as well.

Everything comes from one dependency. Vite+ bundles the dev server and bundler
(Vite 8 + Rolldown), the test runner (Vitest), the linter (Oxlint), the formatter
(Oxfmt), the type checker (tsgolint) and the commit-hook runner — so there is no
ESLint, Prettier, husky or lint-staged to install or configure.

## Quick start

Needs Node 24 (see `.node-version`). The `vp` CLI ships as a real binary in
`node_modules/.bin`, so there is nothing to install globally.

```sh
npm install
npm run dev
```

| Script               | What it does                            |
| -------------------- | --------------------------------------- |
| `npm run build`      | Production build into `dist/`           |
| `npm run check`      | Format, lint and type-check in one pass |
| `npm run check:fix`  | Same, but writes fixes                  |
| `npm run clean`      | Remove everything generated             |
| `npm run dev`        | Dev server with HMR                     |
| `npm run preview`    | Serve the built output                  |
| `npm run test`       | Run tests once                          |
| `npm run test:watch` | Run tests in watch mode                 |

`check` covers type checking too, so there is no separate `typecheck` script.
`clean` removes `node_modules` along with the build output, so follow it with
`npm install`.

## Layout

```
.
├── public/          Copied to dist/ untouched
├── src/
│   ├── index.html   Entry point — the Vite root is src/, not the repo root
│   ├── main.ts
│   ├── counter.ts
│   ├── counter.test.ts
│   └── style.css
├── vite.config.ts   Dev/build, format, lint, test and pre-commit config
└── tsconfig.json
```

`index.html` lives in `src/` so the repo root holds only configuration, which is
why `vite.config.ts` sets `root: 'src'`, `publicDir: '../public'` and
`build.outDir: '../dist'`.

## Configuration

`vite.config.ts` is the single source of truth — formatting, linting, tests and
staged-file checks are all blocks in that one file. Keep them there: `vp` ignores
`.oxlintrc.json` and `.oxfmtrc.json` entirely, and while a `vitest.config.ts`
_is_ read, it silently overrides the `test` block. Two traps worth knowing:

- A `plugins` array in the `lint` block **replaces** the defaults (`unicorn`,
  `oxc`, `typescript`) rather than extending them. List those too.
- `compilerOptions.baseUrl` in `tsconfig.json` silently disables type-aware
  linting and type checking. For aliases, use `paths` without `baseUrl`.

Vite+ is in beta and has shipped breaking changes in patch releases, so
`vite-plus` is pinned exactly. Move it with `npx vp upgrade`.

## Tests

Tests sit next to the code they cover as `*.test.ts`. Import helpers from
`vite-plus/test`, **not** `vitest` — a lint rule flags the wrong one:

```ts
import { describe, expect, it } from 'vite-plus/test';
```

## Using JavaScript instead of TypeScript

Nothing here is TypeScript-only, and mixing the two is fine. To drop to plain JS:

1. Rename the `.ts` files to `.js` (`allowJs` is already on).
2. Update the `<script type="module" src="/main.ts">` tag in `src/index.html`.
3. Widen the test glob in `vite.config.ts` to `['**/*.test.{js,ts}']`.

## Commit hooks

`.vite-hooks/pre-commit` runs `vp staged`, which formats and autofixes staged
files, re-stages the result, and fails the commit on anything it cannot fix. The
dispatcher installs itself on `npm install` via the `prepare` script. Commit the
`pre-commit` file; the generated `.vite-hooks/_/` directory ignores itself.

To skip the hook for one commit:

```sh
VP_GIT_HOOKS=0 git commit -m "wip"
```

## Continuous integration

`.github/workflows/ci.yml` runs check, test and build on every pull request and
on pushes to any branch except `main`.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs the same checks and then deploys, on every
push to `main`. It needs one manual step in the new repo: **Settings → Pages →
Source: GitHub Actions**.

The build uses a relative `base`, so it works both at a project subpath
(`user.github.io/repo-name/`) and at a domain root with no config change.

## After copying this template

- [ ] `npm install`, then commit the `package-lock.json` it generates — CI runs
      `npm ci` and needs one
- [ ] Update `name`, `description` and `license` in `package.json`
- [ ] Enable GitHub Pages (see above)
- [ ] Replace this README
