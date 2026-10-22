import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeView, type SigmaWriter } from '../src/execute.js';
import { SigmaApiError, type DataModelColumn } from '../src/sigma/client.js';
import { canonicalSha256, type LockEntry } from '../src/lock.js';
import type { Decision } from '../src/decide.js';
import type { ViewSource } from '../src/discover.js';

class FakeSigma implements SigmaWriter {
  models = new Map<string, Record<string, unknown>>();
  calls: { op: string; id?: string; body?: unknown }[] = [];
  errorColumnsFor = new Set<string>();
  failOn?: string;
  private n = 0;
  private check(op: string) { if (this.failOn === op) throw new SigmaApiError(`Sigma ${op}`, 500, '{}', 'boom'); }
  async getDataModelSpec(id: string) { this.calls.push({ op: 'get', id }); this.check('get'); const m = this.models.get(id); return m ? structuredClone(m) : null; }
  async createDataModel(spec: Record<string, unknown>, name: string, folderId: string) {
    this.calls.push({ op: 'create', body: { spec, name, folderId } }); this.check('create');
    const id = `new-${++this.n}`; this.models.set(id, { ...structuredClone(spec), name, id }); return id;
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
const base = (decision: Decision, over: Record<string, unknown> = {}) => ({ view, decision, spec, modelName: 'V', folderId: 'fld', findings: [], dryRun: false, preUpdateDir: dir(), ...over });
const lockFor = (s: FakeSigma, id: string): LockEntry => ({ dataModelId: id, specSha256: canonicalSha256(s.models.get(id)) } as LockEntry);

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
  assert.equal(o.specSha256, canonicalSha256(s.models.get('new-1')));
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

test('api error marks failed without further writes', async () => {
  const s = new FakeSigma();
  s.models.set('dm1', { pages: [] });
  s.failOn = 'update';
  const o = await executeView(s, base({ kind: 'update', dataModelId: 'dm1' }, { lockEntry: lockFor(s, 'dm1') }));
  assert.equal(o.status, 'failed');
  assert.match(o.error!, /boom/);
  assert.equal(s.writes().length, 1);

  const s2 = new FakeSigma();
  s2.failOn = 'columns';
  const o2 = await executeView(s2, base({ kind: 'create' }));
  assert.equal(o2.status, 'failed');
  assert.equal(o2.dataModelId, 'new-1');
  assert.deepEqual(s2.writes().map(c => c.op), ['create']);
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
