import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideView, type DecideInput } from '../src/decide.js';
import type { SnowflakeViewResult } from '../src/convert.js';
import type { LockEntry } from '../src/lock.js';

const ok: SnowflakeViewResult = { viewName: 'V', ok: true, model: { name: 'V', pages: [] }, findings: [], bestEffortWouldConvert: false, overriddenErrors: [] };
const refused: SnowflakeViewResult = { ...ok, ok: false, model: undefined };
const lockEntry = { dataModelId: 'dm-lock' } as LockEntry;
const input = (over: Partial<DecideInput>): DecideInput => ({ key: 'D.S.V', conversion: ok, modelName: 'V', folderModels: [], adoptExisting: false, ...over });

test('refused conversion wins', () => {
  const r = decideView(input({ conversion: refused, lockEntry, lockModelExists: true }));
  assert.deepEqual(r.decision, { kind: 'refuse-conversion' });
});

test('lock entry updates', () => {
  const r = decideView(input({ lockEntry, lockModelExists: true, folderModels: [{ id: 'other', name: 'V' }] }));
  assert.deepEqual(r.decision, { kind: 'update', dataModelId: 'dm-lock' });
  assert.equal(r.verified, true);
});

test('deleted lock model falls through and warns', () => {
  const r = decideView(input({ lockEntry, lockModelExists: false, folderModels: [] }));
  assert.deepEqual(r.decision, { kind: 'create' });
  assert.deepEqual(r.warnings, ['D.S.V: data model dm-lock no longer exists in Sigma; recreating']);
  const clash = decideView(input({ lockEntry, lockModelExists: false, folderModels: [{ id: 'x', name: 'V' }] }));
  assert.equal(clash.decision.kind, 'refuse-name-clash');
});

test('name clash refuses by default', () => {
  const r = decideView(input({ folderModels: [{ id: 'hand-built', name: 'V' }, { id: 'unrelated', name: 'W' }] }));
  assert.deepEqual(r.decision, { kind: 'refuse-name-clash', reason: 'exists-not-adopted', matches: ['hand-built'] });
});

test('adoptExisting adopts single match', () => {
  const r = decideView(input({ adoptExisting: true, folderModels: [{ id: 'hand-built', name: 'V' }] }));
  assert.deepEqual(r.decision, { kind: 'adopt', dataModelId: 'hand-built' });
});

test('multiple matches always refuse even with adoptExisting', () => {
  const r = decideView(input({ adoptExisting: true, folderModels: [{ id: 'a', name: 'V' }, { id: 'b', name: 'V' }] }));
  assert.deepEqual(r.decision, { kind: 'refuse-name-clash', reason: 'multiple-matches', matches: ['a', 'b'] });
});

test('no match creates', () => {
  const r = decideView(input({ folderModels: [{ id: 'x', name: 'v' }] }));
  assert.deepEqual(r.decision, { kind: 'create' });
  assert.equal(r.verified, true);
});

test('offline creates unverified', () => {
  const r = decideView(input({ folderModels: undefined }));
  assert.deepEqual(r.decision, { kind: 'create' });
  assert.equal(r.verified, false);
});

test('offline with lock updates unverified', () => {
  const r = decideView(input({ lockEntry, lockModelExists: undefined, folderModels: undefined }));
  assert.deepEqual(r.decision, { kind: 'update', dataModelId: 'dm-lock' });
  assert.equal(r.verified, false);
});
