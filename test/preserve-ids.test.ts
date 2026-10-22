import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preserveIds } from '../src/preserve-ids.js';
import { collectIds, serverRemap } from './helpers/server-remap.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const model = (golden: string) => {
  const { name: _n, ...spec } = JSON.parse(readFileSync(join(ROOT, 'test/golden', golden + '.json'), 'utf8')).results[0].model;
  return spec as Record<string, any>;
};
const STAR = model('star_schema_ddl_sql');
const RETAIL = model('retail_analytics_sv_best_effort_sql');
const el = (spec: any, pred: (e: any) => boolean) => spec.pages.flatMap((p: any) => p.elements).find(pred);

test('unchanged conversion maps every id and reference to the live one', () => {
  for (const spec of [STAR, RETAIL]) {
    const live = serverRemap(spec, { addNames: true });
    const { spec: out, fresh } = preserveIds(spec, live);
    assert.deepEqual(out, serverRemap(spec));
    assert.equal(fresh, 0);
  }
});

test('an added metric keeps its placeholder id while everything else keeps live ids', () => {
  const live = serverRemap(STAR, { addNames: true });
  const next = structuredClone(STAR);
  el(next, (e: any) => e.id === 'lineitem').metrics.push({ id: 'lineitem__m__max_qty', formula: 'Max([L Quantity])', name: 'Max Quantity' });
  const { spec: out, fresh } = preserveIds(next, live);
  const liveIds = new Set(collectIds(live));
  const outIds = collectIds(out);
  assert.deepEqual(outIds.filter(id => !liveIds.has(id)), ['lineitem__m__max_qty']);
  assert.equal(fresh, 1);
});

test('derived elements over the same source match by name, not position', () => {
  const live = serverRemap(RETAIL, { addNames: true });
  const next = structuredClone(RETAIL);
  const els = next.pages[0].elements;
  const a = els.findIndex((e: any) => e.name === 'ORDER_FACT (via Order To Ship Date)');
  const b = els.findIndex((e: any) => e.name === 'ORDER_FACT (via Order To Return Date)');
  [els[a], els[b]] = [els[b], els[a]];
  const { spec: out } = preserveIds(next, live);
  for (const name of ['ORDER_FACT (via Order To Ship Date)', 'ORDER_FACT (via Order To Return Date)']) {
    assert.equal(el(out, (e: any) => e.name === name).id, el(live, (e: any) => e.name === name).id, name);
  }
});

test('a renamed metric keeps its id when the formula is unchanged', () => {
  const live = serverRemap(STAR, { addNames: true });
  const next = structuredClone(STAR);
  const m = el(next, (e: any) => e.id === 'lineitem').metrics.find((x: any) => x.name === 'Total Revenue');
  m.name = 'Net Revenue';
  const { spec: out } = preserveIds(next, live);
  const liveId = el(live, (e: any) => e.name === 'LINEITEM').metrics.find((x: any) => x.name === 'Total Revenue').id;
  assert.equal(el(out, (e: any) => e.id === el(live, (x: any) => x.name === 'LINEITEM').id).metrics.find((x: any) => x.name === 'Net Revenue').id, liveId);
});

test('reordered columns keep their ids (matched by formula)', () => {
  const live = serverRemap(STAR, { addNames: true });
  const next = structuredClone(STAR);
  el(next, (e: any) => e.id === 'lineitem').columns.reverse();
  const { spec: out, fresh } = preserveIds(next, live);
  assert.equal(fresh, 0);
  const liveCols = el(live, (e: any) => e.name === 'LINEITEM').columns;
  const outCols = el(out, (e: any) => e.id === el(live, (x: any) => x.name === 'LINEITEM').id).columns;
  for (const c of outCols) assert.equal(c.id, liveCols.find((l: any) => l.formula === c.formula).id);
});

test('a brand-new element and its columns keep placeholders; nothing collides', () => {
  const live = serverRemap(STAR, { addNames: true });
  const next = structuredClone(STAR);
  next.pages[0].elements.push({ id: 'nation', kind: 'table', source: { kind: 'warehouse-table', connectionId: 'c', path: ['SNOWFLAKE_SAMPLE_DATA', 'TPCH_SF1', 'NATION'] }, columns: [{ id: 'nation__n_name', formula: '[NATION/N Name]' }], order: ['nation__n_name'] });
  const { spec: out, fresh } = preserveIds(next, live);
  assert.equal(fresh, 2);
  const nation = el(out, (e: any) => e.id === 'nation');
  assert.deepEqual(nation.order, ['nation__n_name']);
});
