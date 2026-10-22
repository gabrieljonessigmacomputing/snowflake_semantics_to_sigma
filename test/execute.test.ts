import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeView, type SigmaWriter } from '../src/execute.js';
import { SigmaApiError, type DataModelColumn } from '../src/sigma/client.js';
import { canonicalSha256, specHash, type LockEntry } from '../src/lock.js';
import type { Decision } from '../src/decide.js';
import type { ViewSource } from '../src/discover.js';

class FakeSigma implements SigmaWriter {
  models = new Map<string, Record<string, unknown>>();
  calls: { op: string; id?: string; body?: unknown }[] = [];
  errorColumnsFor = new Set<string>();
  failOn?: string;
  failAlso?: string;
  /** create succeeds in Sigma but the response is lost (gateway timeout). */
  createLost = false;
  private n = 0;
  private check(op: string) { if (this.failOn === op || this.failAlso === op) throw new SigmaApiError(`Sigma ${op}`, 500, '{}', 'boom'); }
  async listDataModelsInFolder(folderId: string) {
    this.calls.push({ op: 'list', id: folderId });
    return [...this.models].filter(([, m]) => m.folderId === folderId).map(([id, m]) => ({ id, name: String(m.name) }));
  }
  async getDataModelSpec(id: string) { this.calls.push({ op: 'get', id }); this.check('get'); const m = this.models.get(id); return m ? structuredClone(m) : null; }
  async createDataModel(spec: Record<string, unknown>, name: string, folderId: string) {
    this.calls.push({ op: 'create', body: { spec, name, folderId } }); this.check('create');
    const id = `new-${++this.n}`; this.models.set(id, { ...structuredClone(spec), name, id, folderId });
    if (this.createLost) throw new SigmaApiError('Sigma data model creation', 504, '', 'gateway timeout');
    return id;
  }
  async updateDataModel(id: string, spec: Record<string, unknown>) {
    this.calls.push({ op: 'update', id, body: structuredClone(spec) }); this.check('update');
    this.models.set(id, { ...this.models.get(id), ...structuredClone(spec) });
  }
  async deleteFile(id: string) { this.calls.push({ op: 'delete', id }); this.models.delete(id); }
  async listDataModelColumns(id: string): Promise<DataModelColumn[]> {
    this.calls.push({ op: 'columns', id }); this.check('columns');
    const bad = this.errorColumnsFor.has(id);
    return [{ elementId: 'e1', columnId: 'c1', label: 'Amount', formula: '[T/AMOUNT]', type: bad ? 'error' : 'number' }];
  }
  writes() { return this.calls.filter(c => ['create', 'update', 'delete'].includes(c.op)); }
}

const view: ViewSource = { key: 'D.S.V', name: { database: 'D', schema: 'S', view: 'V' }, path: 'v.sql', format: 'ddl', index: 0, fileSha256: 'sha' };
const spec = { schemaVersion: 1, pages: [{ id: 'p', elements: [] }] };
const dir = () => mkdtempSync(join(tmpdir(), 'ssv-exec-'));
const base = (decision: Decision, over: Record<string, unknown> = {}) => ({ view, decision, spec, modelName: 'V', folderId: 'fld', findings: [], dryRun: false, preUpdateDir: dir(), sleep: async () => {}, ...over });
const lockFor = (s: FakeSigma, id: string): LockEntry => ({ dataModelId: id, specSha256: specHash(s.models.get(id)!), specHashVersion: 2 } as LockEntry);

test('dry run never calls write methods', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: [] });
  const decisions: [Decision, string][] = [
    [{ kind: 'create' }, 'would-create'], [{ kind: 'update', dataModelId: 'dm1' }, 'would-update'], [{ kind: 'adopt', dataModelId: 'dm1' }, 'would-adopt'],
    [{ kind: 'refuse-conversion' }, 'refused'], [{ kind: 'refuse-name-clash', reason: 'exists-not-adopted', matches: ['dm1'] }, 'refused'],
  ];
  for (const [d, status] of decisions) {
    const o = await executeView(s, base(d, { dryRun: true }));
    assert.equal(o.status, status);
  }
  assert.deepEqual(s.writes(), []);
  const offline = await executeView(undefined, base({ kind: 'create' }, { dryRun: true }));
  assert.equal(offline.status, 'would-create');
});

test('create happy path', async () => {
  const s = new FakeSigma();
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'created');
  assert.equal(o.dataModelId, 'new-1');
  assert.deepEqual((s.calls[0].body as any).name, 'V');
  assert.equal(o.specSha256, specHash(s.models.get('new-1')!));
  assert.deepEqual(o.getBackSpec, s.models.get('new-1'));
});

test('create with error column deletes the new model', async () => {
  const s = new FakeSigma();
  s.errorColumnsFor.add('new-1');
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'failed');
  assert.deepEqual(s.calls.filter(c => c.op === 'delete').map(c => c.id), ['new-1']);
  assert.equal(o.errorColumns?.length, 1);
  assert.equal(o.dataModelId, undefined);
});

test('update detects drift and saves pre-spec', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: ['old'] });
  const lockEntry = lockFor(s, 'dm1');
  s.models.set('dm1', { pages: ['edited in Sigma UI'] });
  const args = base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry });
  const o = await executeView(s, args);
  assert.equal(o.status, 'updated');
  assert.equal(o.drift, true);
  const saved = join(args.preUpdateDir as string, 'D.S.V.json');
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), { pages: ['edited in Sigma UI'] });
});

test('update without drift saves nothing', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: ['old'] });
  const args = base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') });
  const o = await executeView(s, args);
  assert.equal(o.status, 'updated');
  assert.equal(o.drift, false);
  assert.equal(existsSync(join(args.preUpdateDir as string, 'D.S.V.json')), false);
});

test('update with error column rolls back', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: ['good'] });
  s.errorColumnsFor.add('dm1');
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'failed');
  const updates = s.calls.filter(c => c.op === 'update');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1].body, { pages: ['good'] });
  assert.deepEqual(s.models.get('dm1')!.pages, ['good']);
  assert.equal(o.errorColumns?.[0].label, 'Amount');
});

test('adopt saves pre-spec', async () => {
  const s = new FakeSigma();
  s.models.set('hand', { pages: ['hand built'] });
  const args = base({ kind: 'adopt', dataModelId: 'hand' });
  const o = await executeView(s, args);
  assert.equal(o.status, 'adopted');
  assert.equal(o.dataModelId, 'hand');
  assert.deepEqual(JSON.parse(readFileSync(join(args.preUpdateDir as string, 'D.S.V.json'), 'utf8')), { pages: ['hand built'] });
});

test('a failed update is rolled back; if the rollback fails too the model stays owned', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: [] });
  s.failOn = 'update';
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'failed');
  assert.match(o.error!, /boom/);
  assert.deepEqual(s.writes().map(c => c.op), ['update', 'update'], 'the update, then the rollback attempt');
  assert.equal(o.keepInLock, true);
  assert.equal(o.dataModelId, 'dm1');
});

test('a non-ambiguous create error makes no further calls', async () => {
  const s = new FakeSigma();
  s.createDataModel = async () => { throw new SigmaApiError('Sigma data model creation', 400, '{}', 'bad spec'); };
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'failed');
  assert.match(o.error!, /bad spec/);
  assert.deepEqual(s.calls, []);
});

test('update of a model that vanished fails', async () => {
  const s = new FakeSigma();
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'gone' }, { lockEntry: { dataModelId: 'gone', specSha256: 'x' } }));
  assert.equal(o.status, 'failed');
  assert.deepEqual(s.writes(), []);
});

test('refusals pass through', async () => {
  const s = new FakeSigma();
  const findings = [{ code: 'SEMI_ADDITIVE_METRIC', severity: 'error', message: 'm', object: { kind: 'metric', name: 'x' } }];
  const r1 = await executeView(s, base({ kind: 'refuse-conversion' }, { findings }));
  assert.equal(r1.status, 'refused');
  assert.deepEqual(r1.findings, findings);
  const r2 = await executeView(s, base({ kind: 'refuse-name-clash', reason: 'exists-not-adopted', matches: ['dmX'] }));
  assert.equal(r2.status, 'refused');
  assert.match(r2.error!, /dmX/);
  assert.match(r2.error!, /adopt_existing/);
  assert.deepEqual(s.calls, []);
});

test('update PUTs the live ids for unchanged objects and carries name and folderId', async () => {
  const { serverRemap } = await import('./helpers/server-remap.js');
  const { readFileSync } = await import('node:fs');
  const golden = JSON.parse(readFileSync(new URL('./golden/star_schema_ddl_sql.json', import.meta.url), 'utf8'));
  const { name: _n, ...fresh } = golden.results[0].model;
  const s = new FakeSigma();
  s.models.set('dm1', { ...serverRemap(fresh, { addNames: true }), name: 'SALES_VIEW', folderId: 'fld-9' });
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { spec: fresh, lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'updated');
  const put = s.calls.find(c => c.op === 'update')!.body as any;
  assert.deepEqual(put.pages, serverRemap(fresh).pages);
  assert.equal(put.name, 'SALES_VIEW');
  assert.equal(put.folderId, 'fld-9');
});

test('ambiguous create failure recovers the model Sigma created', async () => {
  const s = new FakeSigma();
  s.createLost = true;
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'created');
  assert.equal(o.dataModelId, 'new-1');
  assert.equal(s.calls.filter(c => c.op === 'create').length, 1);
  assert.ok(o.warnings?.some(w => /recovered/.test(w)));
});

test('ambiguous create failure with no model in the folder is failed', async () => {
  const s = new FakeSigma();
  s.failOn = 'create';
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'failed');
  assert.equal(o.dataModelId, undefined);
});

test('create whose column check cannot run deletes the new model', async () => {
  const s = new FakeSigma();
  s.failOn = 'columns';
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'failed');
  assert.deepEqual(s.calls.filter(c => c.op === 'delete').map(c => c.id), ['new-1']);
  assert.equal(o.dataModelId, undefined);
  assert.equal(o.keepInLock, undefined);
});

test('create whose read-back fails is still recorded as created', async () => {
  const s = new FakeSigma();
  const orig = s.getDataModelSpec.bind(s);
  s.getDataModelSpec = async (id: string) => { if (id === 'new-1') throw new SigmaApiError('Sigma read', 500, '', 'boom'); return orig(id); };
  const o = await executeView(s, base({ kind: 'create' }));
  assert.equal(o.status, 'created');
  assert.equal(o.dataModelId, 'new-1');
  assert.equal(o.specSha256, '');
  assert.ok(o.warnings?.length);
});

test('update whose column check cannot run is rolled back', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: ['good'] });
  s.failOn = 'columns';
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'failed');
  assert.deepEqual(s.models.get('dm1')!.pages, ['good']);
  assert.match(o.error!, /restored/);
});

test('update whose rollback also fails is kept in the lock for a retry', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: ['good'] });
  s.errorColumnsFor.add('dm1');
  let puts = 0;
  const orig = s.updateDataModel.bind(s);
  s.updateDataModel = async (id: string, spec: Record<string, unknown>) => { if (++puts === 2) throw new SigmaApiError('Sigma update', 500, '', 'boom'); return orig(id, spec); };
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'failed');
  assert.equal(o.keepInLock, true);
  assert.equal(o.dataModelId, 'dm1');
  assert.match(o.error!, /rolling back failed/);
});

test('an unknown lock specSha256 is not reported as drift', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: [] });
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: { dataModelId: 'dm1', specSha256: '' } }));
  assert.equal(o.status, 'updated');
  assert.equal(o.drift, false);
});

test('an update Sigma rejected (4xx) is not rolled back, since nothing was applied', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: ['good'] });
  s.updateDataModel = async (id: string, spec: Record<string, unknown>) => {
    s.calls.push({ op: 'update', id, body: spec });
    throw new SigmaApiError('Sigma data model update', 400, '{}', '1 schema error in data model spec');
  };
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'failed');
  assert.equal(s.calls.filter(c => c.op === 'update').length, 1);
  assert.match(o.error!, /rejected/);
  assert.equal(o.keepInLock, undefined);
});

test('metadata-only changes in Sigma are not drift', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { schemaVersion: 1, pages: ['same'], documentVersion: 1, updatedAt: 't1' });
  const lockEntry = lockFor(s, 'dm1');
  s.models.set('dm1', { schemaVersion: 1, pages: ['same'], documentVersion: 2, updatedAt: 't2', name: 'renamed in Sigma' });
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry }));
  assert.equal(o.status, 'updated');
  assert.equal(o.drift, false);
});

test('legacy full-spec lock hashes are not reported as drift', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { schemaVersion: 1, pages: ['same'], documentVersion: 1, updatedAt: 't1' });
  const lockEntry = { dataModelId: 'dm1', specSha256: canonicalSha256(s.models.get('dm1')) };
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry }));
  assert.equal(o.status, 'updated');
  assert.equal(o.drift, false);
  assert.equal(o.specSha256, specHash(s.models.get('dm1')!));
});

test('a lock hash written by an older version is not reported as drift', async () => {
  const { canonicalSha256 } = await import('../src/lock.js');
  const s = new FakeSigma();
  s.models.set('dm1', { schemaVersion: 1, pages: ['same'], documentVersion: 3, updatedAt: 't' });
  // v0 lockfiles hashed the whole GET body and carry no specHashVersion.
  const legacy = { dataModelId: 'dm1', specSha256: canonicalSha256(s.models.get('dm1')) };
  s.models.get('dm1')!.documentVersion = 4;
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: legacy }));
  assert.equal(o.status, 'updated');
  assert.equal(o.drift, false);
});

test('ambiguous create recovery waits for the folder listing to catch up', async () => {
  const s = new FakeSigma();
  s.createLost = true;
  let listings = 0;
  const realList = s.listDataModelsInFolder.bind(s);
  // Sigma's listing lags a new model by ~5-6 s: hide it from the first two listings.
  s.listDataModelsInFolder = async (folderId: string) => (++listings <= 2 ? [] : realList(folderId));
  const sleeps: number[] = [];
  const o = await executeView(s, base({ kind: 'create' }, { sleep: async (ms: number) => { sleeps.push(ms); } }));
  assert.equal(o.status, 'created');
  assert.equal(o.dataModelId, 'new-1');
  assert.equal(listings, 3);
  assert.deepEqual(sleeps, [4000, 4000]);
});

test('ambiguous create recovery gives up after about 20 seconds', async () => {
  const s = new FakeSigma();
  s.createLost = true;
  s.listDataModelsInFolder = async () => [];
  const sleeps: number[] = [];
  const o = await executeView(s, base({ kind: 'create' }, { sleep: async (ms: number) => { sleeps.push(ms); } }));
  assert.equal(o.status, 'failed');
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 20000);
  assert.match(o.error!, /look in the target folder/);
});
