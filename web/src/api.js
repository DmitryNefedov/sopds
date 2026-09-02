import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = import.meta.env.VITE_API_BASE || '';

export async function apiGet(pathAndQuery) {
  const res = await fetch(`${BASE}/api${pathAndQuery}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export const bookDownloadUrl = (id, zip = false) =>
  `${BASE}/api/books/${id}/download${zip ? '?zip=1' : ''}`;
export const bookCoverUrl = (id) => `${BASE}/api/books/${id}/cover`;

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
