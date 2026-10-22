import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverViews, listCandidateFiles } from '../src/discover.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (p: string) => ({ path: p, content: readFileSync(join(ROOT, 'test/fixtures', p), 'utf8') });

test('discovers DDL and YAML fixtures with defaults applied', () => {
  const ddl = discoverViews([fx('star_schema_ddl.sql')], {});
  assert.deepEqual(ddl.views.map(v => v.key), ['ANALYTICS.MODELS.SALES_VIEW']);
  assert.equal(ddl.views[0].format, 'ddl');
  const yaml = discoverViews([fx('embed/tpch.yaml')], { database: 'D', schema: 'S' });
  assert.deepEqual(yaml.views.map(v => v.key), ['D.S.TPCH_SALES']);
  assert.equal(yaml.views[0].format, 'yaml');
  assert.deepEqual(discoverViews([fx('embed/tpch.yaml')], {}).views.map(v => v.key), ['TPCH_SALES']);
});

test('skips non-semantic files quietly', () => {
  const r = discoverViews([
    { path: 'models/schema.yml', content: 'version: 2\nmodels:\n  - name: orders\n' },
    { path: 'sql/adhoc.sql', content: 'select 1;\n' },
  ], {});
  assert.deepEqual(r.skipped, ['models/schema.yml', 'sql/adhoc.sql']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.views, []);
});

test('CRLF and BOM produce the same keys and fileSha256 differs only by content', () => {
  const lf = fx('star_schema_ddl.sql');
  const crlf = { path: 'crlf.sql', content: '﻿' + lf.content.replace(/\n/g, '\r\n') };
  const a = discoverViews([lf], {}).views;
  const b = discoverViews([crlf], {}).views;
  assert.deepEqual(b.map(v => v.key), a.map(v => v.key));
  assert.notEqual(b[0].fileSha256, a[0].fileSha256);
  const yamlCrlf = discoverViews([{ path: 't.yaml', content: '﻿' + fx('embed/tpch.yaml').content.replace(/\n/g, '\r\n') }], {});
  assert.deepEqual(yamlCrlf.views.map(v => v.key), ['TPCH_SALES']);
});

test('duplicate key across files is an error', () => {
  const r = discoverViews([
    { path: 'a.sql', content: 'create semantic view S.V tables (t as d.s.t) dimensions (t.x as x)' },
    { path: 'b.sql', content: 'create semantic view s.v tables (t as d.s.t) dimensions (t.x as x)' },
  ], {});
  assert.deepEqual(r.views, []);
  assert.deepEqual(r.errors.map(e => e.path).sort(), ['a.sql', 'b.sql']);
});

test('multi-view file yields one ViewSource per statement with index', () => {
  const r = discoverViews([{ path: 'm.sql', content: 'create semantic view A tables (t);\ncreate semantic view B tables (t);' }], { database: 'D', schema: 'S' });
  assert.deepEqual(r.views.map(v => [v.key, v.index]), [['D.S.A', 0], ['D.S.B', 1]]);
});

test('listCandidateFiles honors default glob and excludes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssv-glob-'));
  for (const p of ['views/a.yaml', 'views/b.yml', 'ddl/c.sql', 'notes.md', 'node_modules/x/d.sql', 'sigma/models/E.yml', 'sigma/semantic-views.lock.json']) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), 'x');
  }
  const files = await listCandidateFiles('**/*.{yml,yaml,sql}', dir, ['sigma/semantic-views.lock.json', 'sigma/models']);
  assert.deepEqual(files, ['ddl/c.sql', 'views/a.yaml', 'views/b.yml']);
});

test('DDL with a header comment, block comment or USE preamble is discovered', () => {
  const ddl = fx('star_schema_ddl.sql').content;
  for (const content of ['-- Sales view (c) Acme\n' + ddl, '/* header\n * more */\n' + ddl, 'USE SCHEMA ANALYTICS.MODELS;\n' + ddl]) {
    const r = discoverViews([{ path: 'v.sql', content }], {});
    assert.deepEqual(r.views.map(v => v.key), ['ANALYTICS.MODELS.SALES_VIEW'], content.slice(0, 30));
    assert.deepEqual(r.skipped, []);
  }
});

test('non-view YAML is skipped: workflow file, dbt_project.yml, k8s manifest', () => {
  const r = discoverViews([
    { path: '.github/workflows/sync.yml', content: 'name: Sync semantic views\non:\n  push:\n    branches: [main]\njobs:\n  sync:\n    runs-on: ubuntu-latest\n' },
    { path: 'dbt_project.yml', content: "name: 'jaffle'\nversion: '1.0.0'\nprofile: 'jaffle'\n" },
    { path: 'k8s/deploy.yaml', content: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n' },
    { path: 'compose.yml', content: 'services:\n  db:\n    image: postgres\n    container_name: db\n' },
  ], {});
  assert.deepEqual(r.views, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.skipped.length, 4);
});

test('listCandidateFiles excludes .github by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssv-glob-'));
  for (const p of ['.github/workflows/sync.yml', 'views/a.yaml']) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), 'x');
  }
  assert.deepEqual(await listCandidateFiles('**/*.{yml,yaml,sql}', dir, []), ['views/a.yaml']);
});
