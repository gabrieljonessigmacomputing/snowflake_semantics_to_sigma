/**
 * One sync run: lock → discover → select → convert → decide → execute → state.
 * All I/O that touches Sigma or git comes in through `deps`, so the whole run is
 * testable offline.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CONNECTION_PLACEHOLDER, convertSnowflakeSemanticView, ENGINE, type SnowflakeViewResult } from './convert.js';
import { decideView } from './decide.js';
import { discoverViews, listCandidateFiles, type ViewSource } from './discover.js';
import { executeView, type SigmaWriter, type ViewOutcome } from './execute.js';
import { findNameCollisions, normalizeSource, renderModelName } from './identity.js';
import { optionsSha256, type Config } from './inputs.js';
import { canonicalSha256, findOrphans, LockError, readLock, selectViews, writeLock, type Lock } from './lock.js';
import type { SigmaClient } from './sigma/client.js';
import { applyOutcomes, saveSpecs, type uploadStateArtifact, type writeBack } from './writeback.js';

export type RunClient = SigmaWriter & Pick<SigmaClient, 'resolveConnectionId' | 'resolveFolderId' | 'listDataModelsInFolder'>;

export interface RunDeps {
  cwd: string;
  client?: RunClient;
  writeBack: (mode: Config['commitMode'], paths: string[], ctx: Parameters<typeof writeBack>[2]) => ReturnType<typeof writeBack>;
  upload: (files: string[], rootDir: string) => ReturnType<typeof uploadStateArtifact>;
  ref: string;
  repo: { owner: string; repo: string };
  now: () => string;
  /** Scratch space for pre-update specs and the artifact (default: a fresh dir under the OS temp dir). */
  tempDir?: string;
  octokit?: Parameters<typeof writeBack>[2]['octokit'];
  /** Brings the checkout's state up to date (writeback.refreshState); called before the lock is read, never on dry runs. */
  refreshState?: () => Promise<{ warnings: string[] }>;
}

export interface RunResult {
  outcomes: ViewOutcome[];
  orphans: { key: string; dataModelId: string }[];
  skipped: string[];
  errors: { path: string; message: string }[];
  warnings: string[];
  offline: boolean;
  writeBack?: { ok: boolean; detail: string };
  /** The lock as written by this run (absent on dry runs and early exits). */
  lockAfter?: Lock;
  exitCode: 0 | 1;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function listFilesDeep(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFilesDeep(join(dir, e.name)) : [join(dir, e.name)]));
}

export async function run(cfg: Config, deps: RunDeps): Promise<RunResult> {
  const { cwd, client } = deps;
  const offline = client === undefined;
  const result: RunResult = { outcomes: [], orphans: [], skipped: [], errors: [], warnings: [], offline, exitCode: 0 };
  const finish = (): RunResult => {
    const failed = result.outcomes.some(o => o.status === 'failed') || result.errors.length > 0 || result.writeBack?.ok === false;
    const refused = cfg.failOnRefused && result.outcomes.some(o => o.status === 'refused');
    return { ...result, exitCode: failed || refused ? 1 : 0 };
  };

  // 1. Lock first (after refreshing it): a corrupt lock stops everything before Sigma is touched.
  if (!cfg.dryRun && deps.refreshState) result.warnings.push(...(await deps.refreshState()).warnings);
  const lockPath = join(cwd, cfg.lockFile);
  let lock: Lock;
  try {
    lock = readLock(lockPath);
  } catch (e) {
    if (!(e instanceof LockError)) throw e;
    result.errors.push({ path: cfg.lockFile, message: e.message });
    return finish();
  }

  // 2. Discover every view (all files, so orphans are known), then 3. name collisions.
  const paths = await listCandidateFiles(cfg.paths, cwd, [cfg.lockFile, cfg.specsDir]);
  const discovery = discoverViews(
    paths.map(p => ({ path: p, content: readFileSync(join(cwd, p), 'utf8') })),
    { database: cfg.database, schema: cfg.schema },
  );
  result.skipped = discovery.skipped;
  result.errors.push(...discovery.errors);
  // A file that defined a tracked view but no longer reads as one is an error, never an orphan.
  const skipped = new Set(discovery.skipped);
  for (const [key, e] of Object.entries(lock.views)) {
    if (!e.orphaned && skipped.has(e.sourcePath)) {
      result.errors.push({ path: e.sourcePath, message: `defined semantic view ${key} (Sigma data model ${e.dataModelId}) but is no longer recognized as a semantic view; fix the file or delete it` });
    }
  }
  const unseenPaths = new Set(result.errors.map(e => e.path));
  const colliding = new Set(findNameCollisions(discovery.views, cfg.modelNameTemplate).flat());
  for (const v of discovery.views.filter(v => colliding.has(v.key))) {
    const modelName = renderModelName(cfg.modelNameTemplate, v.name);
    result.outcomes.push({
      key: v.key, status: 'failed', modelName, drift: false, findings: [],
      error: `another semantic view would also be named "${modelName}" in Sigma; set model_name_template: "{schema}.{view}" (or "{database}.{schema}.{view}")`,
    });
  }
  const views = discovery.views.filter(v => !colliding.has(v.key));

  // 4. Connection / folder, 5. selection and conversion.
  let connectionId: string;
  let folderId: string | undefined;
  let columnTypes: Record<string, Record<string, string>> | undefined;
  try {
    connectionId = cfg.connection.id ?? (client && cfg.connection.name ? await client.resolveConnectionId(cfg.connection.name) : CONNECTION_PLACEHOLDER);
    folderId = cfg.folder.id ?? (client && cfg.folder.name ? await client.resolveFolderId(cfg.folder.name) : undefined);
    if (cfg.columnTypesFile) columnTypes = JSON.parse(readFileSync(join(cwd, cfg.columnTypesFile), 'utf8'));
  } catch (e) {
    result.errors.push({ path: '(inputs)', message: message(e) });
    return finish();
  }
  const optsSha = optionsSha256(cfg, columnTypes);
  const engineCommit = ENGINE.semanticToolsCommit;
  const { selected, unchanged } = selectViews(views, lock, { mode: cfg.mode, engineCommit, optionsSha256: optsSha });
  for (const v of unchanged) {
    const e = lock.views[v.key];
    result.outcomes.push({ key: v.key, status: 'unchanged', dataModelId: e.dataModelId, modelName: e.modelName, drift: false, findings: [] });
  }

  const conversions = new Map<string, SnowflakeViewResult>();
  for (const path of [...new Set(selected.map(v => v.path))]) {
    const conv = convertSnowflakeSemanticView(normalizeSource(readFileSync(join(cwd, path), 'utf8')), {
      connectionId,
      database: cfg.database,
      schema: cfg.schema,
      bestEffort: cfg.bestEffort,
      ...(columnTypes && { columnTypes }),
    });
    for (const v of selected.filter(s => s.path === path)) {
      const r = conv.results[v.index];
      // A statement the engine could not parse comes back unnamed (or "statement-N"); keep it so its findings are reported.
      if (r && (r.viewName.toUpperCase() === v.name.view.toUpperCase() || !r.ok)) conversions.set(v.key, r);
    }
  }

  // 6. What Sigma already holds (online only; reads, no writes).
  let folderModels: { id: string; name: string }[] | undefined;
  const lockModelExists = new Map<string, boolean>();
  if (client && selected.length > 0) {
    try {
      if (folderId) folderModels = await client.listDataModelsInFolder(folderId);
      for (const v of selected) {
        const e = lock.views[v.key];
        if (e && conversions.get(v.key)?.ok) lockModelExists.set(v.key, (await client.getDataModelSpec(e.dataModelId)) !== null);
      }
    } catch (e) {
      result.errors.push({ path: '(sigma)', message: message(e) });
      return finish();
    }
  }

  // 7. Decide and execute, one view at a time.
  const tempDir = deps.tempDir ?? mkdtempSync(join(tmpdir(), 'sigma-sync-'));
  const preUpdateDir = join(tempDir, 'state', 'pre-update');
  for (const v of selected) {
    const modelName = renderModelName(cfg.modelNameTemplate, v.name);
    const conversion = conversions.get(v.key);
    if (!conversion) {
      result.outcomes.push({ key: v.key, status: 'failed', modelName, drift: false, findings: [], error: `the engine returned no result for view ${v.name.view} in ${v.path}` });
      continue;
    }
    const lockEntry = lock.views[v.key];
    const { decision, warnings } = decideView({
      key: v.key, conversion, modelName, lockEntry, lockModelExists: lockModelExists.get(v.key), folderModels, adoptExisting: cfg.adoptExisting,
    });
    result.warnings.push(...warnings);
    const { name: _name, ...spec } = (conversion.model ?? {}) as Record<string, unknown>;
    const effectiveLock = decision.kind === 'update' ? lockEntry : undefined;
    const outcome = await executeView(client, { view: v, decision, spec, modelName, folderId, lockEntry: effectiveLock, findings: conversion.findings, dryRun: cfg.dryRun, preUpdateDir });
    result.warnings.push(...(outcome.warnings ?? []));
    result.outcomes.push(outcome);
  }

  // Views whose file errored this run were not seen, not removed: keep them out of the orphan list.
  const orphanKeys = findOrphans(discovery.views, lock).filter(k => !unseenPaths.has(lock.views[k].sourcePath));
  result.orphans = orphanKeys.map(key => ({ key, dataModelId: lock.views[key].dataModelId }));
  if (cfg.dryRun) return finish();

  // 8. State: lock + specs, 9. write-back, 10. artifact on failure or drift.
  const lockAfter = applyOutcomes(lock, result.outcomes, discovery.views, { engineCommit, optionsSha256: optsSha, now: deps.now() }, orphanKeys);
  result.lockAfter = lockAfter;
  const changed: string[] = [];
  if (existsSync(lockPath) || canonicalSha256(lockAfter) !== canonicalSha256(lock)) {
    writeLock(lockPath, lockAfter);
    changed.push(cfg.lockFile);
  }
  if (cfg.saveSpecs) {
    const specsDir = join(cwd, cfg.specsDir);
    changed.push(...saveSpecs(result.outcomes, specsDir).map(p => join(cfg.specsDir, basename(p)).split('\\').join('/')));
  }
  result.writeBack = await deps.writeBack(cfg.commitMode, changed, {
    cwd, ref: deps.ref, repo: deps.repo, token: cfg.githubToken, gitUserName: cfg.gitUserName, gitUserEmail: cfg.gitUserEmail, octokit: deps.octokit,
  });

  const drift = result.outcomes.some(o => o.drift || o.status === 'adopted');
  if (!result.writeBack.ok || drift) {
    const stateDir = join(tempDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    if (existsSync(lockPath)) copyFileSync(lockPath, join(stateDir, basename(cfg.lockFile)));
    if (existsSync(join(cwd, cfg.specsDir))) cpSync(join(cwd, cfg.specsDir), join(stateDir, 'models'), { recursive: true });
    try {
      await deps.upload(listFilesDeep(stateDir), stateDir);
    } catch (e) {
      result.warnings.push(`could not upload the state artifact: ${message(e)}`);
    }
  }
  return finish();
}
