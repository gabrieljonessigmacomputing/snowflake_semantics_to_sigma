// In-memory Sigma for orchestration tests: just enough of SigmaClient's surface.
import type { DataModelColumn } from '../../src/sigma/client.js';
import type { RunClient } from '../../src/run.js';

export class FakeSigma implements RunClient {
  models = new Map<string, { name: string; folderId: string; spec: Record<string, unknown> }>();
  calls: { op: string; id?: string; body?: unknown }[] = [];
  errorColumnsFor = new Set<string>();
  private n = 0;

  seed(id: string, name: string, folderId = 'fld-1', spec: Record<string, unknown> = { schemaVersion: 1, pages: [] }) {
    this.models.set(id, { name, folderId, spec });
  }
  async resolveConnectionId(name: string) { this.calls.push({ op: 'resolveConnection', body: name }); return 'conn-resolved'; }
  async resolveFolderId(name: string) { this.calls.push({ op: 'resolveFolder', body: name }); return 'fld-1'; }
  async listDataModelsInFolder(folderId: string) {
    this.calls.push({ op: 'listFolder', id: folderId });
    return [...this.models].filter(([, m]) => m.folderId === folderId).map(([id, m]) => ({ id, name: m.name }));
  }
  async getDataModelSpec(id: string) { this.calls.push({ op: 'get', id }); const m = this.models.get(id); return m ? structuredClone(m.spec) : null; }
  async createDataModel(spec: Record<string, unknown>, name: string, folderId: string) {
    this.calls.push({ op: 'create', body: { spec, name, folderId } });
    const id = `dm-${++this.n}`;
    this.models.set(id, { name, folderId, spec: structuredClone(spec) });
    return id;
  }
  async updateDataModel(id: string, spec: Record<string, unknown>) {
    this.calls.push({ op: 'update', id, body: spec });
    const m = this.models.get(id)!;
    m.spec = structuredClone(spec);
  }
  async deleteFile(id: string) { this.calls.push({ op: 'delete', id }); this.models.delete(id); }
  async listDataModelColumns(id: string): Promise<DataModelColumn[]> {
    this.calls.push({ op: 'columns', id });
    return [{ elementId: 'e', columnId: 'c', label: 'X', formula: '[X]', type: this.errorColumnsFor.has(id) ? 'error' : 'number' }];
  }
  writes() { return this.calls.filter(c => ['create', 'update', 'delete'].includes(c.op)); }
}
