/**
 * Sigma REST API client for the calls this action makes. OAuth client
 * credentials, proactive token refresh at 50 minutes, one refresh + retry on a
 * 401, and backoff on 429 / 5xx / network errors. Request and response shapes
 * follow sigmacomputing/semantic-tools packages/connectors/src/sigma.ts.
 */

export interface SigmaCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export class SigmaApiError extends Error {
  readonly status: number;
  readonly operation: string;
  /** Raw response body (secrets redacted). */
  readonly body: string;

  constructor(operation: string, status: number, body: string, detail?: string) {
    super(`${operation} failed with status ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'SigmaApiError';
    this.operation = operation;
    this.status = status;
    this.body = body;
  }
}

export interface DataModelColumn {
  elementId: string;
  columnId: string;
  label: string;
  formula: string;
  type: string;
}

interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const TOKEN_TTL_MS = 50 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

interface Page {
  entries?: unknown;
  nextPage?: unknown;
  hasMore?: unknown;
}

function detailOf(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    for (const k of ['message', 'error_description', 'error', 'detail']) if (typeof r[k] === 'string') return r[k] as string;
  }
  return undefined;
}

export class SigmaClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private token?: { value: string; mintedAt: number };

  constructor(private readonly creds: SigmaCredentials, deps: Deps = {}) {
    this.base = creds.baseUrl.replace(/\/+$/, '');
    this.doFetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  private redact(text: string): string {
    const secret = this.creds.clientSecret;
    if (!secret) return text;
    return text.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
  }

  /**
   * fetch with retry (1s, 2s, … or Retry-After). 429 and connection-refused
   * failures are always retried (the request was not processed / never sent);
   * 5xx and other network errors only when `idempotent`, because a POST that
   * timed out may already have created its model.
   */
  private async send(url: string, init: RequestInit, idempotent = true): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await this.doFetch(url, init);
      } catch (e) {
        netErr = e;
      }
      const neverSent = res === undefined && NOT_SENT.has(String((netErr as { cause?: { code?: unknown } })?.cause?.code));
      const retryable = res === undefined ? idempotent || neverSent : res.status === 429 || (idempotent && res.status >= 500);
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        if (res === undefined) throw netErr;
        return res;
      }
      const retryAfter = Number(res?.headers.get('retry-after'));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
    }
  }

  private async fail(operation: string, res: Response): Promise<never> {
    const raw = this.redact(await res.text().catch(() => ''));
    let detail: string | undefined;
    try {
      detail = detailOf(JSON.parse(raw));
    } catch {
      detail = raw || undefined;
    }
    throw new SigmaApiError(operation, res.status, raw, detail && this.redact(detail));
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.now() - this.token.mintedAt < TOKEN_TTL_MS) return this.token.value;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.creds.clientId, client_secret: this.creds.clientSecret });
    const res = await this.send(`${this.base}/v2/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) await this.fail('Sigma token exchange', res);
    const parsed = (await res.json()) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string') throw new Error('Sigma token exchange returned no access_token');
    this.token = { value: parsed.access_token, mintedAt: this.now() };
    return this.token.value;
  }

  /** Authenticated request; refreshes the token once on a 401. Returns the response (any status). */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const go = async (token: string) =>
      this.send(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }, method !== 'POST');
    let res = await go(await this.accessToken());
    if (res.status === 401) res = await go(await this.accessToken(true));
    return res;
  }

  private async json<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) await this.fail(operation, res);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Every entry of a paginated listing (follows `nextPage` until absent or `hasMore: false`). */
  private async listAll<T>(operation: string, path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let page: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ ...params, ...(page !== undefined && { page }) });
      const qs = q.toString();
      const body = await this.json<Page>(operation, 'GET', `${path}${qs ? `?${qs}` : ''}`);
      if (Array.isArray(body.entries)) out.push(...(body.entries as T[]));
      if (body.hasMore === false || typeof body.nextPage !== 'string' || body.nextPage === '') return out;
      page = body.nextPage;
    }
  }

  async resolveConnectionId(name: string): Promise<string> {
    const all = await this.listAll<{ connectionId?: unknown; name?: unknown }>('Sigma connection lookup', '/v2/connections');
    const hit = all.find(c => c.name === name && typeof c.connectionId === 'string');
    if (!hit) throw new Error(`no Sigma connection named "${name}"`);
    return hit.connectionId as string;
  }

  async resolveFolderId(name: string): Promise<string> {
    const all = await this.listAll<{ id?: unknown; name?: unknown }>('Sigma folder lookup', '/v2/files', { typeFilters: 'folder', limit: '200' });
    const hits = all.filter(f => f.name === name && typeof f.id === 'string');
    if (hits.length === 0) throw new Error(`no Sigma folder named "${name}"`);
    if (hits.length > 1) throw new Error(`${hits.length} Sigma folders named "${name}"; use folder_id instead`);
    return hits[0].id as string;
  }

  async listDataModelsInFolder(folderId: string): Promise<{ id: string; name: string }[]> {
    const all = await this.listAll<{ id?: unknown; name?: unknown; type?: unknown }>('Sigma folder listing', '/v2/files', { parentId: folderId, limit: '200' });
    return all
      .filter(f => f.type === 'data-model' && typeof f.id === 'string' && typeof f.name === 'string')
      .map(f => ({ id: f.id as string, name: f.name as string }));
  }

  async getDataModelSpec(id: string): Promise<Record<string, unknown> | null> {
    const res = await this.request('GET', `/v2/dataModels/${encodeURIComponent(id)}/spec`);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail('Sigma data model read', res);
    return (await res.json()) as Record<string, unknown>;
  }

  async createDataModel(spec: Record<string, unknown>, name: string, folderId: string): Promise<string> {
    const r = await this.json<{ dataModelId?: unknown }>('Sigma data model creation', 'POST', '/v2/dataModels/spec', { ...spec, name, folderId });
    if (typeof r.dataModelId !== 'string') throw new Error('Sigma data model creation returned no dataModelId');
    return r.dataModelId;
  }

  async updateDataModel(id: string, spec: Record<string, unknown>): Promise<void> {
    await this.json('Sigma data model update', 'PUT', `/v2/dataModels/${encodeURIComponent(id)}/spec`, spec);
  }

  async deleteFile(id: string): Promise<void> {
    const res = await this.request('DELETE', `/v2/files/${encodeURIComponent(id)}`);
    if (!res.ok) await this.fail('Sigma file deletion', res);
  }

  async listDataModelColumns(id: string): Promise<DataModelColumn[]> {
    const all = await this.listAll<Record<string, unknown>>('Sigma data model columns', `/v2/dataModels/${encodeURIComponent(id)}/columns`);
    return all.map(c => ({
      elementId: String(c.elementId ?? ''),
      columnId: String(c.columnId ?? ''),
      label: String(c.label ?? c.name ?? ''),
      formula: String(c.formula ?? ''),
      type: String((c.type as { type?: unknown } | undefined)?.type ?? c.type ?? ''),
    }));
  }
}
