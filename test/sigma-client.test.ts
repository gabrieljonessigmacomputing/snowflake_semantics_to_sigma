import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SigmaClient, SigmaApiError } from '../src/sigma/client.js';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (url: URL, init: RequestInit) => Reply | undefined;

const CREDS = { baseUrl: 'https://api.example.test', clientId: 'cid', clientSecret: 'TOP-SECRET-VALUE' };

function harness(routes: Route[], start = 0) {
  const calls: { method: string; url: URL; body?: string }[] = [];
  const sleeps: number[] = [];
  let clock = start;
  let tokens = 0;
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined });
    let reply: Reply | undefined;
    if (url.pathname === '/v2/auth/token') reply = { status: 200, body: { access_token: `tok${++tokens}` } };
    for (const r of routes) reply ??= r(url, init);
    reply ??= { status: 404, body: { message: 'not found' } };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof globalThis.fetch;
  const client = new SigmaClient(CREDS, { fetch, now: () => clock, sleep: async ms => { sleeps.push(ms); } });
  return { client, calls, sleeps, advance: (ms: number) => { clock += ms; }, tokenCalls: () => calls.filter(c => c.url.pathname === '/v2/auth/token').length };
}

const okSpec: Route = url => (url.pathname === '/v2/dataModels/dm1/spec' ? { status: 200, body: { schemaVersion: 1, pages: [] } } : undefined);

test('token is fetched once and reused', async () => {
  const h = harness([okSpec]);
  await h.client.getDataModelSpec('dm1');
  await h.client.getDataModelSpec('dm1');
  assert.equal(h.tokenCalls(), 1);
});

test('token refreshes after 50 minutes', async () => {
  const h = harness([okSpec]);
  await h.client.getDataModelSpec('dm1');
  h.advance(50 * 60 * 1000);
  await h.client.getDataModelSpec('dm1');
  assert.equal(h.tokenCalls(), 2);
});

test('401 refreshes once then retries; second 401 throws SigmaApiError(status 401)', async () => {
  let n = 0;
  const flaky: Route = url => (url.pathname === '/v2/dataModels/dm1/spec' ? (++n === 1 ? { status: 401, body: {} } : { status: 200, body: { pages: [] } }) : undefined);
  const h = harness([flaky]);
  assert.deepEqual(await h.client.getDataModelSpec('dm1'), { pages: [] });
  assert.equal(h.tokenCalls(), 2);

  const always401: Route = url => (url.pathname === '/v2/dataModels/dm2/spec' ? { status: 401, body: { message: 'nope' } } : undefined);
  const h2 = harness([always401]);
  await assert.rejects(h2.client.getDataModelSpec('dm2'), (e: unknown) => e instanceof SigmaApiError && e.status === 401);
  assert.equal(h2.tokenCalls(), 2);
});

test('429 and 5xx retry with backoff up to 3 attempts honoring Retry-After', async () => {
  let n = 0;
  const twice503: Route = url => (url.pathname === '/v2/dataModels/dm1/spec' ? (++n <= 2 ? { status: 503 } : { status: 200, body: { pages: [] } }) : undefined);
  const h = harness([twice503]);
  await h.client.getDataModelSpec('dm1');
  assert.deepEqual(h.sleeps, [1000, 2000]);

  let m = 0;
  const limited: Route = url => (url.pathname === '/v2/dataModels/dm1/spec' ? (++m === 1 ? { status: 429, headers: { 'Retry-After': '5' } } : { status: 200, body: { pages: [] } }) : undefined);
  const h2 = harness([limited]);
  await h2.client.getDataModelSpec('dm1');
  assert.deepEqual(h2.sleeps, [5000]);

  const down: Route = url => (url.pathname === '/v2/dataModels/dm1/spec' ? { status: 500, body: { message: 'boom' } } : undefined);
  const h3 = harness([down]);
  await assert.rejects(h3.client.getDataModelSpec('dm1'), (e: unknown) => e instanceof SigmaApiError && e.status === 500);
  assert.equal(h3.calls.filter(c => c.url.pathname === '/v2/dataModels/dm1/spec').length, 3);
});

test('listDataModelsInFolder follows nextPage', async () => {
  const filler = Array.from({ length: 200 }, (_, i) => ({ id: `wb${i}`, name: `Workbook ${i}`, type: 'workbook' }));
  const files: Route = url => {
    if (url.pathname !== '/v2/files') return undefined;
    assert.equal(url.searchParams.get('parentId'), 'fld');
    assert.equal(url.searchParams.get('limit'), '200');
    return url.searchParams.get('page') === 'p2'
      ? { status: 200, body: { entries: [{ id: 'dmX', name: 'SALES_VIEW', type: 'data-model' }], hasMore: false } }
      : { status: 200, body: { entries: filler, hasMore: true, nextPage: 'p2' } };
  };
  const h = harness([files]);
  assert.deepEqual(await h.client.listDataModelsInFolder('fld'), [{ id: 'dmX', name: 'SALES_VIEW' }]);
});

test('listDataModelColumns follows nextPage and maps type.type', async () => {
  const cols: Route = url => {
    if (url.pathname !== '/v2/dataModels/dm1/columns') return undefined;
    return url.searchParams.get('page') === 'c2'
      ? { status: 200, body: { entries: [{ elementId: 'e', columnId: 'c2', label: 'Bad', formula: '[X]', type: { type: 'error' } }] } }
      : { status: 200, body: { entries: [{ elementId: 'e', columnId: 'c1', label: 'Amount', formula: '[T/AMOUNT]', type: { type: 'number' } }], hasMore: true, nextPage: 'c2' } };
  };
  const h = harness([cols]);
  assert.deepEqual((await h.client.listDataModelColumns('dm1')).map(c => [c.label, c.type]), [['Amount', 'number'], ['Bad', 'error']]);
});

test('getDataModelSpec returns null on 404', async () => {
  assert.equal(await harness([]).client.getDataModelSpec('gone'), null);
});

test('resolveConnectionId and resolveFolderId match names exactly across pages', async () => {
  const routes: Route[] = [
    url => (url.pathname === '/v2/connections'
      ? (url.searchParams.get('page') === 'n2'
        ? { status: 200, body: { entries: [{ connectionId: 'conn-2', name: 'Snowflake Prod' }] } }
        : { status: 200, body: { entries: [{ connectionId: 'conn-1', name: 'snowflake prod' }], hasMore: true, nextPage: 'n2' } })
      : undefined),
    url => (url.pathname === '/v2/files' && url.searchParams.get('typeFilters') === 'folder'
      ? { status: 200, body: { entries: [{ id: 'f1', name: 'Models', type: 'folder' }, { id: 'f2', name: 'Dupe', type: 'folder' }, { id: 'f3', name: 'Dupe', type: 'folder' }] } }
      : undefined),
  ];
  const h = harness(routes);
  assert.equal(await h.client.resolveConnectionId('Snowflake Prod'), 'conn-2');
  await assert.rejects(h.client.resolveConnectionId('Missing'), /no Sigma connection named "Missing"/);
  assert.equal(await h.client.resolveFolderId('Models'), 'f1');
  await assert.rejects(h.client.resolveFolderId('Dupe'), /2 Sigma folders named "Dupe"/);
});

test('create, update and delete send the expected requests', async () => {
  const routes: Route[] = [
    (url, init) => (url.pathname === '/v2/dataModels/spec' && init.method === 'POST' ? { status: 200, body: { dataModelId: 'new-id' } } : undefined),
    (url, init) => (url.pathname === '/v2/dataModels/dm1/spec' && init.method === 'PUT' ? { status: 200, body: { dataModelId: 'dm1' } } : undefined),
    (url, init) => (url.pathname === '/v2/files/dm1' && init.method === 'DELETE' ? { status: 204 } : undefined),
  ];
  const h = harness(routes);
  assert.equal(await h.client.createDataModel({ schemaVersion: 1, pages: [] }, 'SALES_VIEW', 'fld'), 'new-id');
  await h.client.updateDataModel('dm1', { schemaVersion: 1, pages: [1] });
  await h.client.deleteFile('dm1');
  const post = h.calls.find(c => c.method === 'POST' && c.url.pathname === '/v2/dataModels/spec')!;
  assert.deepEqual(JSON.parse(post.body!), { schemaVersion: 1, pages: [], name: 'SALES_VIEW', folderId: 'fld' });
  const put = h.calls.find(c => c.method === 'PUT')!;
  assert.deepEqual(JSON.parse(put.body!), { schemaVersion: 1, pages: [1] });
  assert.ok(h.calls.some(c => c.method === 'DELETE' && c.url.pathname === '/v2/files/dm1'));
});

test('SigmaApiError never contains the client secret', async () => {
  const fetch = (async (input: string | URL, init: RequestInit = {}) =>
    new Response(JSON.stringify({ error: 'invalid_client', echo: String(init.body) }), { status: 401 })) as typeof globalThis.fetch;
  const client = new SigmaClient(CREDS, { fetch, sleep: async () => {} });
  await assert.rejects(client.getDataModelSpec('dm1'), (e: unknown) => {
    assert.ok(e instanceof SigmaApiError);
    assert.ok(!e.message.includes(CREDS.clientSecret));
    assert.ok(!e.body.includes(CREDS.clientSecret));
    return true;
  });
});

test('POST is not retried on 5xx or a reset connection, only on 429 and refused connections', async () => {
  let n = 0;
  const flaky: Route = (url, init) => (url.pathname === '/v2/dataModels/spec' && init.method === 'POST' ? (++n === 1 ? { status: 504 } : { status: 200, body: { dataModelId: 'dup' } }) : undefined);
  const h = harness([flaky]);
  await assert.rejects(h.client.createDataModel({ pages: [] }, 'V', 'f'), (e: unknown) => e instanceof SigmaApiError && e.status === 504);
  assert.equal(h.calls.filter(c => c.method === 'POST' && c.url.pathname === '/v2/dataModels/spec').length, 1);

  let m = 0;
  const limited: Route = (url, init) => (url.pathname === '/v2/dataModels/spec' && init.method === 'POST' ? (++m === 1 ? { status: 429 } : { status: 200, body: { dataModelId: 'ok' } }) : undefined);
  assert.equal(await harness([limited]).client.createDataModel({ pages: [] }, 'V', 'f'), 'ok');

  const mk = (err: Error) => {
    let k = 0;
    const fetch = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/auth/token') return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      if (++k === 1) throw err;
      return new Response(JSON.stringify({ dataModelId: 'after-retry' }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { client: new SigmaClient(CREDS, { fetch, sleep: async () => {} }), attempts: () => k };
  };
  const reset = mk(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  await assert.rejects(reset.client.createDataModel({ pages: [] }, 'V', 'f'), /fetch failed/);
  assert.equal(reset.attempts(), 1);
  const refused = mk(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  assert.equal(await refused.client.createDataModel({ pages: [] }, 'V', 'f'), 'after-retry');
});

test('SigmaApiError message includes nested error summaries', async () => {
  const body = { message: '1 schema error in data model spec', code: 'invalid_request', errors: [{ summary: "Cannot resolve columns on table 'order_fact': dependency not found: formula reference 'order_fact/not a real column'" }] };
  const bad: Route = (url, init) => (url.pathname === '/v2/dataModels/spec' && init.method === 'POST' ? { status: 400, body } : undefined);
  await assert.rejects(harness([bad]).client.createDataModel({ pages: [] }, 'V', 'f'), (e: unknown) => {
    assert.ok(e instanceof SigmaApiError);
    assert.match(e.message, /1 schema error in data model spec: Cannot resolve columns on table 'order_fact'.*not a real column/);
    return true;
  });
});
