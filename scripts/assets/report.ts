// Prints the before/after size table from public/assets-manifest.json.
//
// Usage: node scripts/assets/report.ts

import { fileURLToPath } from 'node:url';

import { formatSizeReport } from './format.ts';
import { readManifest } from './manifest.ts';

const path = fileURLToPath(new URL('../../public/assets-manifest.json', import.meta.url));
const manifest = readManifest(path);
if (!manifest) {
  console.error('No public/assets-manifest.json yet; run `npm run assets` first.');
  process.exit(1);
}
console.log(formatSizeReport(manifest));
