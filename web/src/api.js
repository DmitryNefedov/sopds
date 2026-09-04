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
