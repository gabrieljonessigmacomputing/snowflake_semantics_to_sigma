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
import { canonicalSha256, type LockEntry } from './lock.js';
import { preserveIds } from './preserve-ids.js';
import type { SigmaClient } from './sigma/client.js';

export type SigmaWriter = Pick<SigmaClient, 'getDataModelSpec' | 'createDataModel' | 'updateDataModel' | 'deleteFile' | 'listDataModelColumns'>;

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
  specSha256?: string;
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

  if (decision.kind === 'create') {
    if (!args.folderId) return { ...out, error: 'internal: no folder id for create' };
    let id: string | undefined;
    try {
      id = await client.createDataModel(args.spec, modelName, args.folderId);
      const bad = await errorColumns(client, id);
      if (bad.length > 0) {
        try {
          await client.deleteFile(id);
        } catch (e) {
          return { ...out, dataModelId: id, errorColumns: bad, error: `${bad.length} column(s) did not resolve, and deleting the new model failed: ${message(e)}` };
        }
        return { ...out, errorColumns: bad, error: `${bad.length} column(s) did not resolve; the new data model was deleted` };
      }
      const getBack = await client.getDataModelSpec(id);
      if (!getBack) return { ...out, dataModelId: id, error: `data model ${id} was created but could not be read back` };
      return { ...out, status: 'created', dataModelId: id, getBackSpec: getBack, specSha256: canonicalSha256(getBack) };
    } catch (e) {
      return { ...out, ...(id && { dataModelId: id }), error: message(e) };
    }
  }

  const id = decision.dataModelId;
  out.dataModelId = id;
  try {
    const pre = await client.getDataModelSpec(id);
    if (!pre) return { ...out, error: `data model ${id} no longer exists in Sigma` };
    const drift = decision.kind === 'update' && args.lockEntry !== undefined && canonicalSha256(pre) !== args.lockEntry.specSha256;
    out.drift = drift;
    if (drift || decision.kind === 'adopt') savePre(args.preUpdateDir, view.key, pre);

    // Keep the live element/column ids (workbooks depend on them) and the model's name and folder.
    const body: Record<string, unknown> = {
      ...preserveIds(args.spec, pre).spec,
      ...(pre.name !== undefined && { name: pre.name }),
      ...(pre.folderId !== undefined && { folderId: pre.folderId }),
    };
    await client.updateDataModel(id, body);
    const bad = await errorColumns(client, id);
    if (bad.length > 0) {
      try {
        await client.updateDataModel(id, pre);
      } catch (e) {
        return { ...out, errorColumns: bad, error: `${bad.length} column(s) did not resolve, and rolling back failed: ${message(e)}` };
      }
      return { ...out, errorColumns: bad, error: `${bad.length} column(s) did not resolve; the previous spec was restored` };
    }
    const getBack = await client.getDataModelSpec(id);
    if (!getBack) return { ...out, error: `data model ${id} was updated but could not be read back` };
    return { ...out, status: decision.kind === 'adopt' ? 'adopted' : 'updated', getBackSpec: getBack, specSha256: canonicalSha256(getBack) };
  } catch (e) {
    return { ...out, error: message(e) };
  }
}
