// Before/after size table for `npm run assets:report`, from the manifest's source and output sizes.

import type { AssetManifest } from '../../src/app/loading/manifest.ts';

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

// "−62.5%" for a file that shrank to 37.5% of its source; empty without a source size.
export function formatSaving(before: number | undefined, after: number): string {
  if (before === undefined || before <= 0) return '';
  const change = ((after - before) / before) * 100;
  return `${change <= 0 ? '−' : '+'}${Math.abs(change).toFixed(1)}%`;
}

export function formatSizeReport(manifest: AssetManifest): string {
  const rows: string[][] = [['Asset', 'Kind', 'Before', 'After', 'Change']];
  let before = 0;
  let afterWithSource = 0;
  let after = 0;
  for (const [path, entry] of Object.entries(manifest.assets)) {
    after += entry.bytes;
    if (entry.sourceBytes !== undefined) {
      before += entry.sourceBytes;
      afterWithSource += entry.bytes;
    }
    rows.push([
      path,
      entry.kind,
      entry.sourceBytes === undefined ? '—' : formatBytes(entry.sourceBytes),
      formatBytes(entry.bytes),
      formatSaving(entry.sourceBytes, entry.bytes),
    ]);
  }
  rows.push([
    `Total (${Object.keys(manifest.assets).length} files)`,
    '',
    before > 0 ? formatBytes(before) : '—',
    formatBytes(after),
    before > 0 ? formatSaving(before, afterWithSource) : '',
  ]);
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  // Text columns align left, sizes right.
  const line = (row: string[]): string =>
    row
      .map((cell, c) => (c < 2 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join('  ')
      .trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(rows[0]!), rule, ...rows.slice(1, -1).map(line), rule, line(rows.at(-1)!)].join('\n');
}
