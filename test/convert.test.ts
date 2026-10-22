// The port in src/convert.ts must produce exactly what the MCP converter produced
// for the same fixture and options (test/golden/*.json, from scripts/make-goldens.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSnowflakeSemanticView, CONNECTION_PLACEHOLDER, ENGINE, type SnowflakeConversionResult } from '../src/convert.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'test/golden');

const project = (r: SnowflakeConversionResult) => ({
  refused: r.refused,
  refusedViews: r.refusedViews,
  results: r.results.map(v => ({ viewName: v.viewName, ok: v.ok, model: v.model, findingCodes: v.findings.map(f => f.code) })),
});

for (const file of readdirSync(GOLDEN).filter(f => f.endsWith('.json')).sort()) {
  const golden = JSON.parse(readFileSync(join(GOLDEN, file), 'utf8'));
  test(`port output equals MCP output for ${file.replace(/\.json$/, '')}`, () => {
    const source = readFileSync(join(ROOT, golden.fixture), 'utf8');
    const r = convertSnowflakeSemanticView(source, golden.options);
    const { fixture: _f, options: _o, ...expected } = golden;
    assert.deepEqual(JSON.parse(JSON.stringify(project(r))), expected);
  });
}

test('retail_analytics_sv_best_effort refuses without bestEffort', () => {
  const source = readFileSync(join(ROOT, 'test/fixtures/retail_analytics_sv_best_effort.sql'), 'utf8');
  const r = convertSnowflakeSemanticView(source, { connectionId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(r.refused, true);
  assert.ok(r.findings.some(f => f.code === 'METRIC_JOIN_PATH_SELECTOR'));
});

test('blank connectionId uses placeholder', () => {
  const source = readFileSync(join(ROOT, 'test/fixtures/star_schema_ddl.sql'), 'utf8');
  const r = convertSnowflakeSemanticView(source, {});
  assert.equal(r.refused, false);
  assert.ok(JSON.stringify(r.model).includes(CONNECTION_PLACEHOLDER));
});

test('ENGINE.semanticToolsCommit matches vendor PROVENANCE.json', () => {
  const prov = JSON.parse(readFileSync(join(ROOT, 'vendor/semantic-tools/PROVENANCE.json'), 'utf8'));
  assert.equal(ENGINE.semanticToolsCommit, prov.semanticToolsCommit);
});
