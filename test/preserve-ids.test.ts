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
const factOf = (spec: any) => spec.pages.flatMap((p: any) => p.elements).find((e: any) => (e.metrics ?? []).length > 0 && (e.columns ?? []).length > 0);
const FACT = factOf(STAR);

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
  const addedId = `${FACT.id}__m__max_qty`;
  el(next, (e: any) => e.id === FACT.id).metrics.push({ id: addedId, formula: 'Max([L Quantity])', name: 'Max Quantity' });
  const { spec: out, fresh } = preserveIds(next, live);
  const liveIds = new Set(collectIds(live));
  const outIds = collectIds(out);
  assert.deepEqual(outIds.filter(id => !liveIds.has(id)), [addedId]);
  assert.equal(fresh, 1);
});

test('elements that read the same source match by name, not position', () => {
  const base = {
    schemaVersion: 1,
    pages: [{ id: 'page1', elements: [
      { id: 'orders', kind: 'table', name: 'Orders', source: { kind: 'warehouse-table', connectionId: 'c', path: ['DB', 'SC', 'ORDER_FACT'] }, columns: [{ id: 'orders__id', formula: '[ORDER_FACT/ORDER_ID]' }] },
      { id: 'ship', kind: 'table', name: 'Order Fact (via Ship Date)', source: { kind: 'table', elementId: 'orders' }, columns: [{ id: 'ship__c', formula: '[Ship Date]' }] },
      { id: 'ret', kind: 'table', name: 'Order Fact (via Return Date)', source: { kind: 'table', elementId: 'orders' }, columns: [{ id: 'ret__c', formula: '[Return Date]' }] },
    ] }],
  };
  const live = serverRemap(base, { addNames: true });
  const next = structuredClone(base);
  const els = next.pages[0].elements;
  const a = els.findIndex((e: any) => e.name === 'Order Fact (via Ship Date)');
  const b = els.findIndex((e: any) => e.name === 'Order Fact (via Return Date)');
  [els[a], els[b]] = [els[b], els[a]];
  const { spec: out } = preserveIds(next, live);
  for (const name of ['Order Fact (via Ship Date)', 'Order Fact (via Return Date)']) {
    assert.equal(el(out, (e: any) => e.name === name).id, el(live, (e: any) => e.name === name).id, name);
  }
});

test('a renamed metric keeps its id when the formula is unchanged', () => {
  const live = serverRemap(STAR, { addNames: true });
  const next = structuredClone(STAR);
  const metricName = FACT.metrics[0].name;
  const m = el(next, (e: any) => e.id === FACT.id).metrics.find((x: any) => x.name === metricName);
  m.name = 'Net Revenue';
  const { spec: out } = preserveIds(next, live);
  const liveId = el(live, (e: any) => e.name === FACT.name).metrics.find((x: any) => x.name === metricName).id;
  assert.equal(el(out, (e: any) => e.id === el(live, (x: any) => x.name === FACT.name).id).metrics.find((x: any) => x.name === 'Net Revenue').id, liveId);
});

test('reordered columns keep their ids (matched by formula)', () => {
  const live = serverRemap(STAR, { addNames: true });
  const next = structuredClone(STAR);
  el(next, (e: any) => e.id === FACT.id).columns.reverse();
  const { spec: out, fresh } = preserveIds(next, live);
  assert.equal(fresh, 0);
  const liveCols = el(live, (e: any) => e.name === FACT.name).columns;
  const outCols = el(out, (e: any) => e.id === el(live, (x: any) => x.name === FACT.name).id).columns;
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

// Live Sigma (2026-10) keeps the engine's ids on create but rewrites display names inside formulas
// (`[DATE_DIM/Day Of Week]` comes back as `[DATE_DIM/Day of Week]`).
const liveShaped = (): { schemaVersion: number; pages: { id: string; name: string; elements: any[] }[] } => ({
  schemaVersion: 1,
  pages: [{ id: 'page1', name: 'Page 1', elements: [
    { id: 'date_dim', kind: 'table', name: 'DATE_DIM', source: { kind: 'warehouse-table', connectionId: 'c', path: ['CSA', 'TJ', 'DATE_DIM'] },
      columns: [{ id: 'date_dim__day_of_week', formula: '[DATE_DIM/Day of Week]' }, { id: 'date_dim__year', formula: '[DATE_DIM/Year]' }],
      order: ['date_dim__day_of_week', 'date_dim__year'] },
    { id: 'order_fact', kind: 'table', name: 'ORDER_FACT', source: { kind: 'warehouse-table', connectionId: 'c', path: ['CSA', 'TJ', 'ORDER_FACT'] },
      columns: [{ id: 'order_fact__days_to_ship', formula: '[ORDER_FACT/Days to Ship]' }],
      metrics: [{ id: 'order_fact__m__avg_days_to_ship', formula: 'Avg([Days to Ship])', name: 'Avg Days To Ship' }] },
  ] }],
});
const engineShaped = () => ({
  schemaVersion: 1,
  pages: [{ id: 'page1', elements: [
    { id: 'date_dim', kind: 'table', source: { kind: 'warehouse-table', connectionId: 'c', path: ['CSA', 'TJ', 'DATE_DIM'] },
      columns: [{ id: 'date_dim__day_of_week', formula: '[DATE_DIM/Day Of Week]' }, { id: 'date_dim__year', formula: '[DATE_DIM/Year]' }],
      order: ['date_dim__day_of_week', 'date_dim__year'] },
    { id: 'order_fact', kind: 'table', source: { kind: 'warehouse-table', connectionId: 'c', path: ['CSA', 'TJ', 'ORDER_FACT'] },
      columns: [{ id: 'order_fact__days_to_ship', formula: '[ORDER_FACT/Days To Ship]' }],
      metrics: [{ id: 'order_fact__m__average_days_to_ship', formula: 'Avg([Days To Ship])', name: 'Average Days To Ship' }] },
  ] }],
});

test('ids Sigma kept verbatim stay put even when Sigma rewrote the formula casing', () => {
  const { spec: out, fresh } = preserveIds(engineShaped(), liveShaped());
  assert.deepEqual(collectIds(out).filter(id => id.endsWith('__new')), []);
  assert.equal(el(out, (e: any) => e.id === 'date_dim').columns[0].id, 'date_dim__day_of_week');
  assert.deepEqual(el(out, (e: any) => e.id === 'date_dim').order, ['date_dim__day_of_week', 'date_dim__year']);
  assert.equal(fresh, 0);
});

test('a renamed metric keeps its live id when the formula differs only in casing', () => {
  const { spec: out } = preserveIds(engineShaped(), liveShaped());
  const m = el(out, (e: any) => e.id === 'order_fact').metrics[0];
  assert.equal(m.id, 'order_fact__m__avg_days_to_ship');
  assert.equal(m.name, 'Average Days To Ship');
});

test('a second update after ids were re-keyed keeps the current live ids', () => {
  const live = liveShaped();
  live.pages[0].elements[0].columns[0].id = 'date_dim__day_of_week__new';
  live.pages[0].elements[0].order![0] = 'date_dim__day_of_week__new';
  const { spec: out } = preserveIds(engineShaped(), live);
  assert.equal(el(out, (e: any) => e.id === 'date_dim').columns[0].id, 'date_dim__day_of_week__new');
});
