import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = import.meta.env.VITE_API_BASE || '';

export async function apiGet(pathAndQuery) {
  const res = await fetch(`${BASE}/api${pathAndQuery}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export async function apiSend(method, pathAndQuery, body) {
  const res = await fetch(`${BASE}/api${pathAndQuery}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `API ${res.status}`);
    err.fields = data.fields || null;
    throw err;
  }
  return data;
}

export const bookDownloadUrl = (id, zip = false) =>
  `${BASE}/api/books/${id}/download${zip ? '?zip=1' : ''}`;

// The e-ink theme greyscales cover images with a CSS filter, so the URL is
// the same in every mode.
export const bookCoverUrl = (id) => `${BASE}/api/books/${id}/cover`;

// Minimal data-fetching hook with request cancellation and a manual `reload`.
// Pass `null` as the path to skip the request entirely — hooks have to be
// called unconditionally, so this is how a component asks for nothing.
export function useApi(pathAndQuery, deps = []) {
  const [state, setState] = useState({
    data: null,
    loading: pathAndQuery != null,
    error: null,
  });
  // When the request path changes, drop the previous result in the same render
  // that sees the new path. Otherwise a consumer briefly gets stale `data` (or
  // `null`, if the path was previously skipped) with `loading` still false —
  // the window between the deps change and the effect below firing — which
  // makes `<Async>` hand `null` to its render function and throw.
  const [prevPath, setPrevPath] = useState(pathAndQuery);
  if (pathAndQuery !== prevPath) {
    setPrevPath(pathAndQuery);
    setState({ data: null, loading: pathAndQuery != null, error: null });
  }
  const idRef = useRef(0);

  const load = useCallback(() => {
    if (pathAndQuery == null) {
      idRef.current++;
      setState({ data: null, loading: false, error: null });
      return;
    }
    const reqId = ++idRef.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    apiGet(pathAndQuery)
      .then((data) => {
        if (reqId === idRef.current) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (reqId === idRef.current)
          setState({ data: null, loading: false, error });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
    return () => {
      idRef.current++;
    };
  }, [load]);

  return { ...state, reload: load };
}

// ---- two-phase book search ---------------------------------------------

/** Append the items of `next` that `shown` does not already have, keeping the
 *  order of what is on screen so nothing a reader is pointing at moves. */
function mergeBooks(shown, next) {
  const seen = new Set(shown.map((b) => b.id));
  return shown.concat(next.filter((b) => !seen.has(b.id)));
}

/**
 * Search books in two passes at once. The anchored `match=prefix` pass is
 * served off a btree and lands in milliseconds; the full substring pass needs
 * the trigram index and can take much longer on a large catalog. Whichever
 * arrives first is painted, and the other is merged into it.
 *
 * Prefix results are a subset of full results, so merging only ever adds rows:
 * a book shown in the partial phase stays exactly where it is, and stays
 * downloadable, while the rest of the catalog is still being searched.
 *
 * Returns `phase`: 'loading' (nothing yet), 'partial' (fast pass only, still
 * searching) or 'complete'. Only the first page runs both passes — later pages
 * are offsets into the full result, which the anchored pass cannot align with.
 */
export function useBookSearch(q, { page = 1, limit } = {}) {
  const idle = { items: [], meta: null, phase: 'idle', error: null };
  const [state, setState] = useState(() => (q ? { ...idle, phase: 'loading' } : idle));
  // Drop the previous query's results in the same render that sees the new
  // one, the way `useApi` does. Otherwise the window between the deps changing
  // and the effect firing paints the old books under the new heading.
  const key = `${q}\u0000${page}\u0000${limit ?? ''}`;
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setState(q ? { ...idle, phase: 'loading' } : idle);
  }
  const runRef = useRef(0);

  const load = useCallback(() => {
    const run = ++runRef.current;
    if (!q) {
      setState({ items: [], meta: null, phase: 'idle', error: null });
      return;
    }
    setState({ items: [], meta: null, phase: 'loading', error: null });

    const live = () => run === runRef.current;
    const qs = new URLSearchParams({ q, type: 'books', page: String(page) });
    if (limit) qs.set('limit', String(limit));
    const url = (match) => `/search?${qs}${match ? `&match=${match}` : ''}`;

    // Tracked outside React state so the two callbacks can see each other's
    // progress without waiting for a re-render.
    let shown = [];
    let fullSettled = false;

    const full = apiGet(url()).then((data) => {
      if (!live()) return;
      fullSettled = true;
      shown = mergeBooks(shown, data.results.items);
      setState({ items: shown, meta: data.results, phase: 'complete', error: null });
    });

    if (page === 1) {
      apiGet(url('prefix'))
        .then((data) => {
          // If the full pass already settled, leave the result alone: on
          // success its ordering is authoritative and these rows are in it
          // already, and on failure this would clear the error and leave
          // "still searching" on screen for a pass that is never coming.
          if (!live() || fullSettled) return;
          shown = data.results.items;
          if (!shown.length) return; // nothing to show early; wait for the full pass
          setState({ items: shown, meta: null, phase: 'partial', error: null });
        })
        .catch(() => {
          // The fast pass is an optimisation. Losing it costs latency, not
          // results, so the full pass is left to report any real failure.
        });
    }

    full.catch((error) => {
      if (!live()) return;
      fullSettled = true;
      setState((s) => ({ ...s, phase: 'complete', error }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page, limit]);

  useEffect(() => {
    load();
    return () => {
      runRef.current++;
    };
  }, [load]);

  return { ...state, reload: load };
}
