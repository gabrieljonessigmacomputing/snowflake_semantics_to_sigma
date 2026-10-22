#!/usr/bin/env node
// Regenerates test/golden/*.json from this action's converter.
//   node --import tsx/esm scripts/refresh-goldens.mjs

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSnowflakeSemanticView } from '../src/convert.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_OPTIONS = { connectionId: '00000000-0000-4000-8000-000000000000', database: 'ANALYTICS', schema: 'MODELS' };
const BEST_EFFORT = new Set(['retail_analytics_sv_best_effort']);

const project = (r) => ({
  refused: r.refused,
  refusedViews: r.refusedViews,
  results: r.results.map(v => ({ viewName: v.viewName, ok: v.ok, model: v.model, findingCodes: v.findings.map(f => f.code) })),
});

const fixtures = join(ROOT, 'test/fixtures');
const files = [
  ...readdirSync(fixtures).filter(f => /\.(sql|ya?ml)$/.test(f)).map(f => join(fixtures, f)),
  ...readdirSync(join(fixtures, 'embed')).map(f => join(fixtures, 'embed', f)),
];
mkdirSync(join(ROOT, 'test/golden'), { recursive: true });
for (const file of files) {
  const name = (file.includes('/embed/') ? 'embed_' : '') + basename(file).replace(/\./g, '_');
  const stem = basename(file, extname(file));
  const opts = { ...GOLDEN_OPTIONS, ...(BEST_EFFORT.has(stem) && { bestEffort: true }) };
  const r = convertSnowflakeSemanticView(readFileSync(file, 'utf8'), opts);
  writeFileSync(join(ROOT, 'test/golden', name + '.json'), JSON.stringify({ fixture: file.slice(ROOT.length + 1), options: opts, ...project(r) }, null, 2) + '\n');
  console.log(`${name}: ${r.refused ? 'REFUSED ' + r.refusedViews.join(',') : 'ok'} (${r.results.length} view)`);
}
