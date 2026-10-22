import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type RunDeps } from '../src/run.js';
import type { Config } from '../src/inputs.js';
import { FakeSigma } from './helpers/fake-sigma.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SALES = 'ANALYTICS.MODELS.SALES_VIEW';
const TPCH = 'ANALYTICS.MODELS.TPCH_SALES';
const BROKEN = 'ANALYTICS.MODELS.BROKEN_VIEW';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssv-run-'));
  for (const [dest, src] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, dest)), { recursive: true });
    copyFileSync(join(ROOT, 'test/fixtures', src), join(dir, dest));
  }
  return dir;
}
const STD = { 'views/sales.sql': 'star_schema_ddl.sql', 'views/tpch.yaml': 'embed/tpch.yaml' };

const config = (over: Partial<Config> = {}): Config => ({
  sigma: { baseUrl: 'https://api.example.test', clientId: 'id', clientSecret: 'secret' },
  connection: { id: 'conn-1' }, folder: { id: 'fld-1' },
  paths: '**/*.{yml,yaml,sql}', database: 'ANALYTICS', schema: 'MODELS', mode: 'auto', dryRun: false,
  bestEffort: false, failOnRefused: true, lockFile: 'sigma/semantic-views.lock.json', saveSpecs: true, specsDir: 'sigma/models',
  commitMode: 'push', adoptExisting: false, modelNameTemplate: '{view}', gitUserName: 'bot', gitUserEmail: 'bot@example.com', ...over,
});

function deps(cwd: string, client: FakeSigma | undefined, over: Partial<RunDeps> = {}) {
  const writeBacks: { mode: string; paths: string[] }[] = [];
  const uploads: { files: string[]; root: string }[] = [];
  const d: RunDeps = {
    cwd, client, ref: 'main', repo: { owner: 'acme', repo: 'views' }, now: () => '2026-10-22T12:00:00Z',
    tempDir: mkdtempSync(join(tmpdir(), 'ssv-tmp-')),
    writeBack: async (mode, paths) => { writeBacks.push({ mode, paths }); return { ok: true, detail: 'ok' }; },
    upload: async (files, root) => { uploads.push({ files, root }); },
    ...over,
  };
  return { d, writeBacks, uploads };
}
const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'sigma/semantic-views.lock.json'), 'utf8'));
const statusOf = (r: Awaited<ReturnType<typeof run>>) => Object.fromEntries(r.outcomes.map(o => [o.key, o.status]));

test('first run creates every view and writes lock', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  const { d, writeBacks } = deps(dir, s);
  const r = await run(config(), d);
  assert.deepEqual(statusOf(r), { [SALES]: 'created', [TPCH]: 'created' });
  assert.equal(r.exitCode, 0);
  const lock = lockOf(dir);
  assert.deepEqual(Object.keys(lock.views).sort(), [SALES, TPCH]);
  assert.equal(lock.views[SALES].sourcePath, 'views/sales.sql');
  assert.ok(existsSync(join(dir, 'sigma/models', `${SALES}.yml`)));
  assert.deepEqual(writeBacks.map(w => [w.mode, w.paths.sort()]), [['push', ['sigma/models/ANALYTICS.MODELS.SALES_VIEW.yml', 'sigma/models/ANALYTICS.MODELS.TPCH_SALES.yml', 'sigma/semantic-views.lock.json']]]);
  const create = s.calls.find(c => c.op === 'create')!.body as any;
  assert.equal(create.folderId, 'fld-1');
  assert.ok(['SALES_VIEW', 'TPCH_SALES'].includes(create.name));
  assert.equal(create.spec.name, undefined, 'name goes only through createDataModel');
  assert.ok(JSON.stringify(create.spec).includes('conn-1'));
});

test('second run with no changes is all unchanged and makes no Sigma writes', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  const before = s.writes().length;
  const r = await run(config(), deps(dir, s).d);
  assert.deepEqual(statusOf(r), { [SALES]: 'unchanged', [TPCH]: 'unchanged' });
  assert.equal(s.writes().length, before);
  assert.equal(r.exitCode, 0);
});

test('editing one file updates only its views', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  appendFileSync(join(dir, 'views/tpch.yaml'), '\n# edited\n');
  const tpchId = lockOf(dir).views[TPCH].dataModelId;
  const live = s.liveIds(tpchId);
  const r = await run(config(), deps(dir, s).d);
  assert.deepEqual(statusOf(r), { [SALES]: 'unchanged', [TPCH]: 'updated' });
  const put = s.calls.find(c => c.op === 'update' && c.id === tpchId)!.body as any;
  const { collectIds } = await import('./helpers/server-remap.js');
  assert.deepEqual(collectIds(put).filter(id => !live.has(id)), [], 'an unchanged view keeps every live id');
});

test('deleted file reports orphan and never calls deleteFile', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  const salesId = lockOf(dir).views[SALES].dataModelId;
  rmSync(join(dir, 'views/sales.sql'));
  const r = await run(config(), deps(dir, s).d);
  assert.deepEqual(r.orphans, [{ key: SALES, dataModelId: salesId }]);
  assert.equal(lockOf(dir).views[SALES].orphaned, true);
  assert.equal(s.calls.filter(c => c.op === 'delete').length, 0);
  assert.equal(r.exitCode, 0);
});

test('refused view fails run but others deploy and lock records them', async () => {
  const dir = repo({ ...STD, 'views/broken.sql': 'broken_view.sql' });
  const r = await run(config(), deps(dir, new FakeSigma()).d);
  assert.deepEqual(statusOf(r), { [SALES]: 'created', [TPCH]: 'created', [BROKEN]: 'refused' });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(Object.keys(lockOf(dir).views).sort(), [SALES, TPCH]);
  assert.ok(r.outcomes.find(o => o.key === BROKEN)!.findings.some(f => f.code === 'UNTRANSLATED'));
});

test('failOnRefused false exits 0 with refusals', async () => {
  const dir = repo({ ...STD, 'views/broken.sql': 'broken_view.sql' });
  const r = await run(config({ failOnRefused: false }), deps(dir, new FakeSigma()).d);
  assert.equal(statusOf(r)[BROKEN], 'refused');
  assert.equal(r.exitCode, 0);
});

test('name collision fails both views before any write', async () => {
  const dir = repo({ 'a/sales.sql': 'star_schema_ddl.sql' });
  const other = readFileSync(join(ROOT, 'test/fixtures/star_schema_ddl.sql'), 'utf8').replace('ANALYTICS.MODELS.SALES_VIEW', 'OTHER_DB.MODELS.SALES_VIEW');
  writeFileSync(join(dir, 'a/other.sql'), other);
  const s = new FakeSigma();
  const r = await run(config(), deps(dir, s).d);
  assert.deepEqual(statusOf(r), { [SALES]: 'failed', 'OTHER_DB.MODELS.SALES_VIEW': 'failed' });
  assert.match(r.outcomes[0].error!, /model_name_template: "\{schema\}\.\{view\}"|\{database\}/);
  assert.deepEqual(s.writes(), []);
  assert.equal(r.exitCode, 1);
});

test('dry run offline converts and writes nothing', async () => {
  const dir = repo(STD);
  const { d, writeBacks } = deps(dir, undefined);
  const r = await run(config({ dryRun: true, sigma: undefined, connection: { name: 'Prod' }, folder: { name: 'Models' } }), d);
  assert.equal(r.offline, true);
  assert.deepEqual(statusOf(r), { [SALES]: 'would-create', [TPCH]: 'would-create' });
  assert.equal(existsSync(join(dir, 'sigma')), false);
  assert.deepEqual(writeBacks, []);
  assert.equal(r.exitCode, 0);
});

test('dry run online reads Sigma but writes nothing', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  s.seed('hand-built', 'SALES_VIEW');
  const r = await run(config({ dryRun: true }), deps(dir, s).d);
  assert.equal(r.offline, false);
  assert.deepEqual(statusOf(r), { [SALES]: 'refused', [TPCH]: 'would-create' });
  assert.deepEqual(s.writes(), []);
  assert.equal(existsSync(join(dir, 'sigma')), false);
});

test('corrupt lock exits before discovery with zero client calls', async () => {
  const dir = repo(STD);
  mkdirSync(join(dir, 'sigma'));
  writeFileSync(join(dir, 'sigma/semantic-views.lock.json'), '<<<<<<< HEAD\n');
  const s = new FakeSigma();
  const r = await run(config(), deps(dir, s).d);
  assert.equal(r.exitCode, 1);
  assert.match(r.errors[0].message, /lockfile/);
  assert.deepEqual(r.outcomes, []);
  assert.deepEqual(s.calls, []);
});

test('write-back failure uploads artifact and exits 1', async () => {
  const dir = repo(STD);
  const { d, uploads } = deps(dir, new FakeSigma(), { writeBack: async () => ({ ok: false, detail: 'protected branch' }) });
  const r = await run(config(), d);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.writeBack, { ok: false, detail: 'protected branch' });
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].files.some(f => f.endsWith('semantic-views.lock.json')));
  for (const f of uploads[0].files) assert.ok(f.startsWith(uploads[0].root));
  assert.deepEqual(Object.keys(r.lockAfter!.views).sort(), [SALES, TPCH]);
});

test('model deleted in Sigma is recreated with a warning on a full run', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  const oldId = lockOf(dir).views[SALES].dataModelId;
  s.models.delete(oldId);
  const r = await run(config({ mode: 'all' }), deps(dir, s).d);
  assert.equal(statusOf(r)[SALES], 'created');
  assert.notEqual(lockOf(dir).views[SALES].dataModelId, oldId);
  assert.ok(r.warnings.some(w => w.includes(oldId) && w.includes('no longer exists')));
});

test('drift uploads the pre-update spec', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  const id = lockOf(dir).views[TPCH].dataModelId;
  s.models.get(id)!.spec = { schemaVersion: 1, pages: ['edited in Sigma'] };
  appendFileSync(join(dir, 'views/tpch.yaml'), '\n# edited\n');
  const { d, uploads } = deps(dir, s);
  const r = await run(config(), d);
  assert.equal(r.outcomes.find(o => o.key === TPCH)!.drift, true);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].files.some(f => f.endsWith(`pre-update/${TPCH}.json`)));
  assert.equal(r.exitCode, 0);
});

test('connection and folder names are resolved online', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  const r = await run(config({ connection: { name: 'Prod' }, folder: { name: 'Models' } }), deps(dir, s).d);
  assert.equal(r.exitCode, 0);
  assert.ok(JSON.stringify((s.calls.find(c => c.op === 'create')!.body as any).spec).includes('conn-resolved'));
});

test('a file with discovery errors does not orphan its views', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  copyFileSync(join(dir, 'views/sales.sql'), join(dir, 'views/sales_copy.sql'));
  const r = await run(config(), deps(dir, s).d);
  assert.ok(r.errors.some(e => e.path === 'views/sales.sql'));
  assert.deepEqual(r.orphans, []);
  assert.equal(lockOf(dir).views[SALES].orphaned, false);
  assert.equal(r.exitCode, 1);
});

test('a tracked file that stops parsing is an error, not an orphan', async () => {
  const dir = repo(STD);
  const s = new FakeSigma();
  await run(config(), deps(dir, s).d);
  writeFileSync(join(dir, 'views/tpch.yaml'), 'name: [broken\n');
  const r = await run(config(), deps(dir, s).d);
  assert.ok(r.errors.some(e => e.path === 'views/tpch.yaml' && /no longer recognized/.test(e.message)), JSON.stringify(r.errors));
  assert.deepEqual(r.orphans, []);
  assert.equal(lockOf(dir).views[TPCH].orphaned, false);
  assert.equal(r.exitCode, 1);
});

test('a USE preamble still converts', async () => {
  const dir = repo({});
  mkdirSync(join(dir, 'views'));
  writeFileSync(join(dir, 'views/sales.sql'), 'USE SCHEMA ANALYTICS.MODELS;\n' + readFileSync(join(ROOT, 'test/fixtures/star_schema_ddl.sql'), 'utf8'));
  const r = await run(config(), deps(dir, new FakeSigma()).d);
  const o = r.outcomes.find(x => x.key === SALES)!;
  assert.equal(o.status, 'created');
  assert.equal(o.findings.some(f => f.severity === 'error'), false);
});

test('state is refreshed before the lock is read, and not on dry runs', async () => {
  const dir = repo(STD);
  const order: string[] = [];
  const s = new FakeSigma();
  const { d } = deps(dir, s, { refreshState: async () => { order.push(`refresh:${s.calls.length}`); return { warnings: ['refreshed'] }; } });
  const r = await run(config(), d);
  assert.deepEqual(order, ['refresh:0']);
  assert.ok(r.warnings.includes('refreshed'));
  order.length = 0;
  await run(config({ dryRun: true }), deps(dir, s, { refreshState: async () => { order.push('refresh'); return { warnings: [] }; } }).d);
  assert.deepEqual(order, []);
});
