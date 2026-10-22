/**
 * Carries Sigma's server-assigned IDs onto a freshly converted spec before a PUT.
 *
 * The engine emits readable placeholder IDs (`lineitem__l_quantity`); Sigma's
 * POST remaps every one of them, and a later PUT must keep the live IDs on
 * unchanged objects or workbooks built on the data model break. So pages,
 * elements and each element's child objects (columns, metrics, relationships, …)
 * are paired with their live counterparts by natural key, and every ID and ID
 * reference in the new spec is rewritten to the live one. Objects with no live
 * counterpart keep their placeholder, which Sigma remaps as new.
 *
 * Observed live (2026-10): Sigma keeps the engine's ids on create, so an
 * identical id is the first and strongest match; it also rewrites display-name
 * casing inside formulas (`Day Of Week` → `Day of Week`), so names and formulas
 * are compared case-insensitively.
 */

type Obj = Record<string, any>;
type KeyFn<T> = (x: T, i: number) => string | undefined;

const ID_KEY = /^(id|.*Id|.*Ids|order|uniqueKeys)$/;
const norm = (s: unknown) => (typeof s === 'string' && s.trim() !== '' ? s.replace(/\s+/g, ' ').trim().toLowerCase() : undefined);
const sameId: KeyFn<Obj> = x => (typeof x.id === 'string' ? `id:${x.id}` : undefined);

/** Pairs items of `a` with items of `b`: each key function in turn, equal keys matched in occurrence order. */
function pairBy<T>(a: T[], b: T[], keys: KeyFn<T>[]): [T, T][] {
  const pairs: [T, T][] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  for (const key of keys) {
    const pool = new Map<string, number[]>();
    b.forEach((x, i) => {
      if (usedB.has(i)) return;
      const k = key(x, i);
      if (k !== undefined) pool.set(k, [...(pool.get(k) ?? []), i]);
    });
    a.forEach((x, i) => {
      if (usedA.has(i)) return;
      const k = key(x, i);
      const j = k === undefined ? undefined : pool.get(k)?.shift();
      if (j === undefined) return;
      usedA.add(i);
      usedB.add(j);
      pairs.push([x, b[j]]);
    });
  }
  return pairs;
}

const elementsOf = (spec: Obj): Obj[] => (spec.pages ?? []).flatMap((p: Obj) => p.elements ?? []);

/** A position-independent description of what an element reads from. */
function signatures(spec: Obj): Map<Obj, string> {
  const els = elementsOf(spec);
  const byId = new Map(els.filter(e => typeof e.id === 'string').map(e => [e.id as string, e]));
  const memo = new Map<Obj, string>();
  const sig = (e: Obj | undefined, seen: Set<Obj>): string => {
    if (!e) return '?';
    if (memo.has(e)) return memo.get(e)!;
    if (seen.has(e)) return 'cycle';
    seen.add(e);
    const s: Obj = e.source ?? {};
    const ref = (id: unknown) => `el(${sig(typeof id === 'string' ? byId.get(id) : undefined, seen)})`;
    let out: string;
    if (Array.isArray(s.path)) out = `path:${s.path.map((p: unknown) => String(p).toUpperCase()).join('.')}`;
    else if (typeof s.statement === 'string') out = `sql:${norm(s.statement)}`;
    else if (typeof s.elementId === 'string') out = ref(s.elementId);
    else if (Array.isArray(s.sources)) out = `union(${s.sources.map((x: Obj) => (typeof x?.elementId === 'string' ? ref(x.elementId) : JSON.stringify(x))).join(',')})`;
    else {
      const { connectionId: _c, ...rest } = s;
      out = JSON.stringify(rest);
    }
    out = `${e.kind ?? ''}|${s.kind ?? ''}|${out}`;
    memo.set(e, out);
    return out;
  };
  for (const e of els) sig(e, new Set());
  return memo;
}

function childKeys(field: string, targetSig: (r: Obj) => string | undefined): KeyFn<Obj>[] {
  const name: KeyFn<Obj> = x => norm(x.name);
  const formula: KeyFn<Obj> = x => norm(x.formula);
  if (field === 'columns') return [formula, name];
  if (field === 'metrics') return [name, formula];
  if (field === 'relationships') return [name, x => targetSig(x)];
  return [name, formula, x => norm(x.label)];
}

function rewrite(value: unknown, key: string, map: Map<string, string>): unknown {
  if (typeof value === 'string') return ID_KEY.test(key) && map.has(value) ? map.get(value) : value;
  if (Array.isArray(value)) return value.map(v => rewrite(v, key, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k, map)]));
  return value;
}

function allIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => allIds(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' && typeof v === 'string') out.push(v);
      allIds(v, out);
    }
  }
  return out;
}

export function preserveIds(next: Obj, live: Obj): { spec: Obj; mapped: number; fresh: number } {
  const map = new Map<string, string>();
  const link = (a: Obj, b: Obj) => {
    if (typeof a.id === 'string' && typeof b.id === 'string') map.set(a.id, b.id);
  };

  for (const [a, b] of pairBy<Obj>(next.pages ?? [], live.pages ?? [], [sameId, x => norm(x.name), (_x, i) => String(i)])) link(a, b);

  const nextSig = signatures(next);
  const liveSig = signatures(live);
  const nextById = new Map(elementsOf(next).map(e => [e.id, e]));
  const liveById = new Map(elementsOf(live).map(e => [e.id, e]));
  const elementPairs = pairBy<Obj>(elementsOf(next), elementsOf(live), [
    sameId,
    x => (norm(x.name) ? `${(nextSig.get(x) ?? liveSig.get(x))}|${norm(x.name)}` : undefined),
    x => nextSig.get(x) ?? liveSig.get(x),
  ]);
  for (const [a, b] of elementPairs) {
    link(a, b);
    for (const [field, items] of Object.entries(a)) {
      if (!Array.isArray(items) || !items.every(i => i && typeof i === 'object' && typeof i.id === 'string')) continue;
      const liveItems = Array.isArray(b[field]) ? (b[field] as Obj[]) : [];
      const targetSig = (r: Obj) => {
        const t = nextById.get(r.targetElementId) ?? liveById.get(r.targetElementId);
        return t ? (nextSig.get(t) ?? liveSig.get(t)) : undefined;
      };
      for (const [x, y] of pairBy<Obj>(items, liveItems, [sameId, ...childKeys(field, targetSig)])) link(x, y);
    }
  }

  // A placeholder that happens to equal some other live id would alias it: rename it.
  const liveIds = new Set(allIds(live));
  for (const id of allIds(next)) {
    if (!map.has(id) && liveIds.has(id)) map.set(id, `${id}__new`);
  }
  const spec = rewrite(structuredClone(next), '', map) as Obj;
  const mapped = [...map.values()].filter(v => liveIds.has(v)).length;
  const fresh = allIds(spec).filter(id => !liveIds.has(id)).length;
  return { spec, mapped, fresh };
}
