/**
 * Carries out one view's decision against Sigma: create / update / adopt, with
 * drift detection, the column-resolution check, and rollback when it fails.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbedFinding } from './convert.js';
import type { Decision } from './decide.js';
import type { ViewSource } from './discover.js';
import { keyFileName } from './identity.js';
import { specHash, type LockEntry } from './lock.js';
import { preserveIds } from './preserve-ids.js';
import { SigmaApiError, type SigmaClient } from './sigma/client.js';

export type SigmaWriter = Pick<SigmaClient, 'getDataModelSpec' | 'createDataModel' | 'updateDataModel' | 'deleteFile' | 'listDataModelColumns' | 'listDataModelsInFolder'>;

export type Status = 'created' | 'updated' | 'adopted' | 'unchanged' | 'refused' | 'failed' | 'would-create' | 'would-update' | 'would-adopt';

export interface ViewOutcome {
  key: string;
  status: Status;
  dataModelId?: string;
  modelName: string;
  drift: boolean;
  findings: EmbedFinding[];
  errorColumns?: { elementId: string; label: string; formula: string }[];
  error?: string;
  getBackSpec?: Record<string, unknown>;
  /** '' when the deploy succeeded but the spec could not be read back (drift unknown next run). */
  specSha256?: string;
  /** A failed view whose data model this action still owns: record it so the next run retries instead of disowning it. */
  keepInLock?: boolean;
  warnings?: string[];
}

export interface ExecuteArgs {
  view: ViewSource;
  decision: Decision;
  spec?: Record<string, unknown>;
  modelName: string;
  folderId?: string;
  lockEntry?: Pick<LockEntry, 'dataModelId' | 'specSha256'>;
  findings: EmbedFinding[];
  dryRun: boolean;
  /** Where pre-update specs are saved (drift / adopt) for the run artifact. */
  preUpdateDir: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function errorColumns(client: SigmaWriter, id: string) {
  const cols = await client.listDataModelColumns(id);
  return cols.filter(c => c.type === 'error').map(c => ({ elementId: c.elementId, label: c.label, formula: c.formula }));
}

function savePre(dir: string, key: string, spec: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${keyFileName(key)}.json`), JSON.stringify(spec, null, 2) + '\n');
}

export async function executeView(client: SigmaWriter | undefined, args: ExecuteArgs): Promise<ViewOutcome> {
  const { view, decision, modelName } = args;
  const out: ViewOutcome = { key: view.key, status: 'failed', modelName, drift: false, findings: args.findings };

  if (decision.kind === 'refuse-conversion') return { ...out, status: 'refused' };
  if (decision.kind === 'refuse-name-clash') {
    const error =
      decision.reason === 'multiple-matches'
        ? `${decision.matches.length} data models named "${modelName}" already exist in the target folder (${decision.matches.join(', ')}); refusing to guess which one this view owns`
        : `a data model named "${modelName}" (${decision.matches[0]}) already exists in the target folder and is not tracked in the lockfile; set adopt_existing: true to take it over, or rename it`;
    return { ...out, status: 'refused', error };
  }
  if (args.dryRun) {
    const would = { create: 'would-create', update: 'would-update', adopt: 'would-adopt' } as const;
    return { ...out, status: would[decision.kind], ...(decision.kind !== 'create' && { dataModelId: decision.dataModelId }) };
  }
  if (!client || !args.spec) return { ...out, error: 'internal: no Sigma client or spec for a write' };

  if (decision.kind === 'create') return create(client, args, out);
  return update(client, args, { ...out, dataModelId: decision.dataModelId }, decision.kind);
}

/** A failure after which the request may still have been applied (gateway timeout, reset connection). */
const ambiguous = (e: unknown) => !(e instanceof SigmaApiError) || e.status >= 500;

async function create(client: SigmaWriter, args: ExecuteArgs, out: ViewOutcome): Promise<ViewOutcome> {
  const { modelName, folderId, spec } = args;
  if (!folderId || !spec) return { ...out, error: 'internal: no folder id or spec for create' };
  const warnings: string[] = [];
  let id: string;
  try {
    id = await client.createDataModel(spec, modelName, folderId);
  } catch (e) {
    if (!ambiguous(e)) return { ...out, error: message(e) };
    // The POST may have gone through. The decision saw no model of this name, so one now is ours.
    let mine: { id: string }[];
    try {
      mine = (await client.listDataModelsInFolder(folderId)).filter(m => m.name === modelName);
    } catch {
      return { ...out, error: `${message(e)}; could not check whether Sigma created "${modelName}" anyway — look in the target folder before the next run` };
    }
    if (mine.length !== 1) return { ...out, error: mine.length === 0 ? message(e) : `${message(e)}; ${mine.length} data models named "${modelName}" now exist (${mine.map(m => m.id).join(', ')})` };
    id = mine[0].id;
    warnings.push(`${args.view.key}: creating "${modelName}" returned an error (${message(e)}) but Sigma had created it; recovered data model ${id}`);
  }

  let bad: Awaited<ReturnType<typeof errorColumns>>;
  try {
    bad = await errorColumns(client, id);
  } catch (e) {
    // Unverified: remove our own just-created model rather than leave a possibly broken one.
    try {
      await client.deleteFile(id);
      return { ...out, warnings, error: `the column check could not run (${message(e)}); the new data model was deleted` };
    } catch (d) {
      return { ...out, warnings, dataModelId: id, keepInLock: true, error: `the column check could not run (${message(e)}) and deleting the new data model failed (${message(d)}); it will be re-checked next run` };
    }
  }
  if (bad.length > 0) {
    try {
      await client.deleteFile(id);
    } catch (e) {
      return { ...out, warnings, dataModelId: id, keepInLock: true, errorColumns: bad, error: `${bad.length} column(s) did not resolve, and deleting the new model failed: ${message(e)}` };
    }
    return { ...out, warnings, errorColumns: bad, error: `${bad.length} column(s) did not resolve; the new data model was deleted` };
  }
  try {
    const getBack = await client.getDataModelSpec(id);
    if (getBack) return { ...out, warnings, status: 'created', dataModelId: id, getBackSpec: getBack, specSha256: specHash(getBack) };
  } catch {
    // fall through: created and verified, just not read back
  }
  warnings.push(`${args.view.key}: data model ${id} was created and verified but could not be read back; drift will not be checked on its next update`);
  return { ...out, warnings, status: 'created', dataModelId: id, specSha256: '' };
}

async function update(client: SigmaWriter, args: ExecuteArgs, out: ViewOutcome, kind: 'update' | 'adopt'): Promise<ViewOutcome> {
  const id = out.dataModelId!;
  const spec = args.spec!;
  let pre: Record<string, unknown> | null;
  try {
    pre = await client.getDataModelSpec(id);
  } catch (e) {
    return { ...out, error: message(e) };
  }
  if (!pre) return { ...out, error: `data model ${id} no longer exists in Sigma` };
  const known = args.lockEntry?.specSha256;
  const drift = kind === 'update' && !!known && specHash(pre) !== known;
  out.drift = drift;
  if (drift || kind === 'adopt') savePre(args.preUpdateDir, args.view.key, pre);

  // Keep the live element/column ids (workbooks depend on them) and the model's name and folder.
  const body: Record<string, unknown> = {
    ...preserveIds(spec, pre).spec,
    ...(pre.name !== undefined && { name: pre.name }),
    ...(pre.folderId !== undefined && { folderId: pre.folderId }),
  };
  let failure: { error: string; errorColumns?: ViewOutcome['errorColumns'] } | undefined;
  try {
    await client.updateDataModel(id, body);
  } catch (e) {
    // Sigma refused the spec outright (4xx): nothing was applied, so there is nothing to roll back.
    if (!ambiguous(e)) return { ...out, error: `Sigma rejected the update, so the live spec is unchanged: ${message(e)}` };
    failure = { error: `the update failed (${message(e)})` };
  }
  if (!failure) {
    try {
      const bad = await errorColumns(client, id);
      if (bad.length > 0) failure = { error: `${bad.length} column(s) did not resolve`, errorColumns: bad };
    } catch (e) {
      failure = { error: `the column check could not run (${message(e)})` };
    }
  }
  if (failure) {
    try {
      await client.updateDataModel(id, pre);
    } catch (e) {
      return { ...out, ...failure, keepInLock: true, error: `${failure.error}, and rolling back failed: ${message(e)}; the live spec is unverified and will be redeployed next run` };
    }
    return { ...out, ...failure, error: `${failure.error}; the previous spec was restored` };
  }
  const status = kind === 'adopt' ? 'adopted' : 'updated';
  try {
    const getBack = await client.getDataModelSpec(id);
    if (getBack) return { ...out, status, getBackSpec: getBack, specSha256: specHash(getBack) };
  } catch {
    // fall through
  }
  return { ...out, status, specSha256: '', warnings: [`${args.view.key}: data model ${id} was updated and verified but could not be read back; drift will not be checked on its next update`] };
}
