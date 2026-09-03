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

let _eink = false;
export function setCoverEink(on) {
  _eink = !!on;
}
// `eink` defaults to the last value set via setCoverEink so plain callers
// still get the right variant; components pass it explicitly for reactivity.
export const bookCoverUrl = (id, eink = _eink) =>
  `${BASE}/api/books/${id}/cover${eink ? '?eink=1' : ''}`;

// Minimal data-fetching hook with request cancellation and a manual `reload`.
export function useApi(pathAndQuery, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const idRef = useRef(0);

  const load = useCallback(() => {
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
