import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputs, optionsSha256 } from '../src/inputs.js';

const BASE: Record<string, string> = {
  sigma_base_url: 'https://api.example.test', sigma_client_id: 'id', sigma_client_secret: 'secret',
  connection_id: 'conn-1', folder_id: 'fld-1',
};
const getter = (over: Record<string, string> = {}) => (name: string) => ({ ...BASE, ...over })[name] ?? '';

test('defaults on push', () => {
  const c = parseInputs(getter(), { name: 'push' });
  assert.equal(c.mode, 'auto');
  assert.equal(c.dryRun, false);
  assert.equal(c.paths, '**/*.{yml,yaml,sql}');
  assert.equal(c.lockFile, 'sigma/semantic-views.lock.json');
  assert.equal(c.specsDir, 'sigma/models');
  assert.equal(c.saveSpecs, true);
  assert.equal(c.commitMode, 'push');
  assert.equal(c.adoptExisting, false);
  assert.equal(c.bestEffort, false);
  assert.equal(c.failOnRefused, true);
  assert.equal(c.modelNameTemplate, '{view}');
  assert.equal(c.gitUserName, 'github-actions[bot]');
  assert.equal(c.gitUserEmail, '41898282+github-actions[bot]@users.noreply.github.com');
  assert.deepEqual(c.sigma, { baseUrl: 'https://api.example.test', clientId: 'id', clientSecret: 'secret' });
  assert.deepEqual(c.connection, { id: 'conn-1' });
  assert.deepEqual(c.folder, { id: 'fld-1' });
});

test('workflow_dispatch defaults mode to all; pull requests default to dry run', () => {
  assert.equal(parseInputs(getter(), { name: 'workflow_dispatch' }).mode, 'all');
  assert.equal(parseInputs(getter(), { name: 'pull_request' }).dryRun, true);
  assert.equal(parseInputs(getter(), { name: 'pull_request_target' }).dryRun, true);
  assert.equal(parseInputs(getter({ dry_run: 'false' }), { name: 'pull_request' }).dryRun, false);
  assert.equal(parseInputs(getter({ mode: 'auto' }), { name: 'workflow_dispatch' }).mode, 'auto');
});

test('throws on missing credentials outside dry run, allows them in dry run', () => {
  assert.throws(() => parseInputs(getter({ sigma_client_secret: '' }), { name: 'push' }), /sigma_client_id, sigma_client_secret and sigma_base_url/);
  const c = parseInputs(getter({ sigma_client_secret: '', sigma_client_id: '' }), { name: 'pull_request' });
  assert.equal(c.sigma, undefined);
});

test('throws on both or neither connection / folder', () => {
  assert.throws(() => parseInputs(getter({ connection_name: 'Prod' }), { name: 'push' }), /exactly one of connection_id or connection_name/);
  assert.throws(() => parseInputs(getter({ connection_id: '' }), { name: 'push' }), /exactly one of connection_id or connection_name/);
  assert.throws(() => parseInputs(getter({ folder_name: 'Models' }), { name: 'push' }), /exactly one of folder_id or folder_name/);
  assert.throws(() => parseInputs(getter({ folder_id: '' }), { name: 'push' }), /exactly one of folder_id or folder_name/);
});

test('throws on invalid enum and boolean values', () => {
  assert.throws(() => parseInputs(getter({ mode: 'changed' }), { name: 'push' }), /mode/);
  assert.throws(() => parseInputs(getter({ commit_mode: 'force' }), { name: 'push' }), /commit_mode/);
  assert.throws(() => parseInputs(getter({ best_effort: 'yes please' }), { name: 'push' }), /best_effort/);
  assert.equal(parseInputs(getter({ best_effort: 'TRUE' }), { name: 'push' }).bestEffort, true);
});

test('optionsSha256 ignores the resolved connection id', () => {
  const byName = parseInputs(getter({ connection_id: '', connection_name: 'Prod' }), { name: 'push' });
  const again = parseInputs(getter({ connection_id: '', connection_name: 'Prod' }), { name: 'push' });
  assert.equal(optionsSha256(byName), optionsSha256(again));
  assert.notEqual(optionsSha256(byName), optionsSha256(parseInputs(getter(), { name: 'push' })));
  assert.notEqual(optionsSha256(byName), optionsSha256({ ...byName, bestEffort: true }));
  assert.notEqual(optionsSha256(byName), optionsSha256(byName, { 'D.S.T': { C: 'TIMESTAMP_TZ' } }));
});
