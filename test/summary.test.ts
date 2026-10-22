import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary } from '../src/summary.js';
import type { RunResult } from '../src/run.js';

const result: RunResult = {
  outcomes: [
    { key: 'D.S.OK', status: 'created', dataModelId: 'dm-1', modelName: 'OK', drift: false, findings: [] },
    { key: 'D.S.DRIFTED', status: 'updated', dataModelId: 'dm-2', modelName: 'DRIFTED', drift: true, findings: [{ code: 'W1', severity: 'warning', message: 'a warning', object: { kind: 'metric', name: 'm' } }] },
    { key: 'D.S.BAD', status: 'refused', modelName: 'BAD', drift: false, findings: [{ code: 'SEMI_ADDITIVE_METRIC', severity: 'error', message: 'semi-additive metric', remediation: 'pre-aggregate it', object: { kind: 'metric', name: 'bal' } }] },
    { key: 'D.S.BROKEN', status: 'failed', dataModelId: 'dm-3', modelName: 'BROKEN', drift: false, findings: [], error: '1 column(s) did not resolve', errorColumns: [{ elementId: 'e', label: 'Amount', formula: '[X]' }] },
  ],
  orphans: [{ key: 'D.S.GONE', dataModelId: 'dm-9' }],
  skipped: ['models/schema.yml'],
  errors: [{ path: 'dup.sql', message: 'defined more than once' }],
  warnings: ['D.S.X: data model dm-0 no longer exists in Sigma; recreating'],
  offline: true,
  writeBack: { ok: false, detail: 'protected branch' },
  lockAfter: { version: 1, views: { 'D.S.OK': { dataModelId: 'dm-1' } as any } },
  exitCode: 1,
};

test('summary lists refused remediation, orphans and offline skipped checks', () => {
  const md = renderSummary(result);
  for (const s of [
    '| View | Status | Sigma data model | Errors | Warnings |',
    '| D.S.OK | created | dm-1 | 0 | 0 |',
    'SEMI_ADDITIVE_METRIC', 'pre-aggregate it',
    'D.S.GONE', 'dm-9', 'never deleted',
    'D.S.DRIFTED',
    'Amount', '[X]',
    'offline',
    'protected branch', '| D.S.OK | dm-1 |',
    'dup.sql', 'no longer exists',
  ]) assert.ok(md.includes(s), `summary missing ${JSON.stringify(s)}\n${md}`);
});

test('a clean run has only the table', () => {
  const md = renderSummary({ outcomes: [result.outcomes[0]], orphans: [], skipped: [], errors: [], warnings: [], offline: false, exitCode: 0 });
  assert.ok(md.includes('| D.S.OK | created | dm-1 | 0 | 0 |'));
  assert.ok(!md.includes('offline'));
  assert.ok(!md.includes('Orphaned'));
});
