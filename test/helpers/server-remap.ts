// Simulates what Sigma's POST /v2/dataModels/spec does to IDs: every submitted id is
// replaced by a server id (assigned in document order) and every reference follows.
// With addNames, unnamed elements get the warehouse table name, as the server does.

const ID_KEY = /^(id|.*Id|.*Ids|order|uniqueKeys)$/;

export function collectIds(spec: unknown, out: string[] = []): string[] {
  if (Array.isArray(spec)) spec.forEach(v => collectIds(v, out));
  else if (spec && typeof spec === 'object') {
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'id' && typeof v === 'string') out.push(v);
      collectIds(v, out);
    }
  }
  return out;
}

function rewrite(value: unknown, key: string, map: Map<string, string>): unknown {
  if (typeof value === 'string') return ID_KEY.test(key) && map.has(value) ? map.get(value) : value;
  if (Array.isArray(value)) return value.map(v => rewrite(v, key, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k, map)]));
  }
  return value;
}

export function serverRemap(spec: Record<string, any>, opts: { addNames?: boolean; prefix?: string } = {}): Record<string, any> {
  const map = new Map<string, string>();
  for (const id of collectIds(spec)) if (!map.has(id)) map.set(id, `${opts.prefix ?? 'srv'}${map.size + 1}`);
  const out = rewrite(structuredClone(spec), '', map) as Record<string, any>;
  if (opts.addNames) {
    for (const p of out.pages ?? []) for (const e of p.elements ?? []) if (!e.name && e.source?.path) e.name = e.source.path.at(-1);
  }
  return out;
}
