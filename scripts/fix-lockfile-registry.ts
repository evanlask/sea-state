// Rewrites every `resolved` URL in package-lock.json to the public npm registry.
//
// Local installs may go through a private mirror, which records the mirror's
// host in the lockfile. CI runs `npm ci` against the public registry and cannot
// reach that mirror, so the lockfile must only reference registry.npmjs.org.
// Tarball paths and integrity hashes are identical across npm-compatible
// mirrors, so only the host (and any mirror path prefix) changes.
import { readFileSync, writeFileSync } from 'node:fs';

const lockfile = new URL('../package-lock.json', import.meta.url);
const original = readFileSync(lockfile, 'utf8');

// Captures `<name>/-/<file>.tgz` or `@scope/<name>/-/<file>.tgz` after any host/prefix.
const resolved = /"resolved": "https:\/\/[^"]*?\/((?:@[^/"]+\/)?[^/"]+\/-\/[^"]+\.tgz)"/g;
const rewritten = original.replace(resolved, '"resolved": "https://registry.npmjs.org/$1"');

const foreign = rewritten.match(/"resolved": "https:\/\/(?!registry\.npmjs\.org\/)[^"]+"/g) ?? [];
if (foreign.length > 0) {
  console.error(`Could not rewrite ${foreign.length} resolved URL(s):\n${foreign.join('\n')}`);
  process.exit(1);
}

if (rewritten === original) {
  console.log('package-lock.json already uses registry.npmjs.org');
} else {
  writeFileSync(lockfile, rewritten);
  console.log('package-lock.json now resolves every package from registry.npmjs.org');
}
