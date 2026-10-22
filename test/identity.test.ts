import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDdlViewNames, parseYamlViewName, viewKey, renderModelName, findNameCollisions, type QualifiedName } from '../src/identity.js';
import type { ViewSource } from '../src/discover.js';

const plain = (q: QualifiedName) => ({ database: q.database, schema: q.schema, view: q.view });

test('parses qualified and unqualified DDL names', () => {
  const [full] = parseDdlViewNames('CREATE OR REPLACE SEMANTIC VIEW ANALYTICS.MODELS.SALES_VIEW TABLES (x AS a.b.c)');
  assert.deepEqual(plain(full), { database: 'ANALYTICS', schema: 'MODELS', view: 'SALES_VIEW' });
  const [partial] = parseDdlViewNames('create semantic view if not exists s.v tables (x as a.b.c)');
  assert.deepEqual(plain(partial), { database: undefined, schema: 's', view: 'v' });
  assert.equal(viewKey(partial), 'S.V');
});

test('quoted identifiers keep case and inner dots', () => {
  const [q] = parseDdlViewNames('CREATE SEMANTIC VIEW "Sales"."my.view" TABLES (x AS a.b.c)');
  assert.equal(q.schema, 'Sales');
  assert.equal(q.view, 'my.view');
  assert.equal(viewKey(q), 'Sales.my.view');
  const [esc] = parseDdlViewNames('create semantic view "a""b" tables (x as t)');
  assert.equal(esc.view, 'a"b');
});

test('multi-statement DDL keeps order', () => {
  const names = parseDdlViewNames('create semantic view FIRST_SV tables (t);\ncreate or replace semantic view D.S.SECOND_SV tables (t);');
  assert.deepEqual(names.map(viewKey), ['FIRST_SV', 'D.S.SECOND_SV']);
});

test('ignores names inside comments and string literals', () => {
  const sql = "-- create semantic view X\n/* create semantic view Z */\nselect 'create semantic view Y', $$create semantic view W$$;";
  assert.deepEqual(parseDdlViewNames(sql), []);
});

test('parseYamlViewName reads top-level name', () => {
  assert.equal(parseYamlViewName('name: TPCH_SALES\ntables: []\n'), 'TPCH_SALES');
  assert.equal(parseYamlViewName('tables: []\n'), undefined);
});

test('renderModelName', () => {
  assert.equal(renderModelName('{view}', { schema: 'S', view: 'V' }), 'V');
  assert.equal(renderModelName('{schema}.{view}', { view: 'V' }), 'V');
  assert.equal(renderModelName('{database}.{schema}.{view}', { database: 'D', schema: 'S', view: 'V' }), 'D.S.V');
});

const vs = (key: string, name: QualifiedName): ViewSource => ({ key, name, path: `${key}.sql`, format: 'ddl', index: 0, fileSha256: 'x' });

test('findNameCollisions', () => {
  const views = [vs('A.S.V', { database: 'A', schema: 'S', view: 'V' }), vs('B.S.V', { database: 'B', schema: 'S', view: 'V' })];
  assert.deepEqual(findNameCollisions(views, '{view}'), [['A.S.V', 'B.S.V']]);
  assert.deepEqual(findNameCollisions(views, '{database}.{view}'), []);
});
