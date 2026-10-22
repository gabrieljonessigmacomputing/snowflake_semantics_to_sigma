/**
 * What to do with one converted view, decided from the lock and what Sigma
 * already holds. Pure: the caller fetches folder contents and existence first.
 */

import type { SnowflakeViewResult } from './convert.js';
import type { LockEntry } from './lock.js';

export type Decision =
  | { kind: 'create' }
  | { kind: 'update'; dataModelId: string }
  | { kind: 'adopt'; dataModelId: string }
  | { kind: 'refuse-conversion' }
  | { kind: 'refuse-name-clash'; reason: 'exists-not-adopted' | 'multiple-matches'; matches: string[] };

export interface DecideInput {
  key: string;
  conversion: SnowflakeViewResult;
  modelName: string;
  lockEntry?: LockEntry;
  /** undefined = offline (not checked). */
  lockModelExists?: boolean;
  /** Data models in the target folder; undefined = offline. */
  folderModels?: { id: string; name: string }[];
  adoptExisting: boolean;
}

export function decideView(input: DecideInput): { decision: Decision; verified: boolean; warnings: string[] } {
  const verified = input.folderModels !== undefined;
  const warnings: string[] = [];
  if (!input.conversion.ok) return { decision: { kind: 'refuse-conversion' }, verified, warnings };

  if (input.lockEntry) {
    if (input.lockModelExists !== false) {
      return { decision: { kind: 'update', dataModelId: input.lockEntry.dataModelId }, verified: verified && input.lockModelExists === true, warnings };
    }
    warnings.push(`${input.key}: data model ${input.lockEntry.dataModelId} no longer exists in Sigma; recreating`);
  }

  if (input.folderModels === undefined) return { decision: { kind: 'create' }, verified: false, warnings };
  const matches = input.folderModels.filter(m => m.name === input.modelName).map(m => m.id);
  if (matches.length === 0) return { decision: { kind: 'create' }, verified, warnings };
  if (matches.length > 1) return { decision: { kind: 'refuse-name-clash', reason: 'multiple-matches', matches }, verified, warnings };
  if (input.adoptExisting) return { decision: { kind: 'adopt', dataModelId: matches[0] }, verified, warnings };
  return { decision: { kind: 'refuse-name-clash', reason: 'exists-not-adopted', matches }, verified, warnings };
}
