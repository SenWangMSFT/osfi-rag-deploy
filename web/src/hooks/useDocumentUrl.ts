import { useEffect, useState } from 'react';
import { documentUrl } from '../api';

// Links live 15 minutes on the server; refresh a little early.
const TTL_MS = 12 * 60 * 1000;
const cache = new Map<string, { url: string; expires: number }>();

function cached(file: string | null): string | null {
  const entry = file ? cache.get(file) : undefined;
  return entry && entry.expires > Date.now() ? entry.url : null;
}

/** A read-only PDF URL, cached per file so switching pages in the same report doesn't reload it. */
export function useDocumentUrl(file: string | null) {
  const [result, setResult] = useState<{ file: string; url?: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const hit = cached(file);

  useEffect(() => {
    if (!file || cached(file)) return;
    let cancelled = false;
    documentUrl(file).then(
      (url) => {
        cache.set(file, { url, expires: Date.now() + TTL_MS });
        if (!cancelled) setResult({ file, url });
      },
      (error: unknown) => {
        if (!cancelled) setResult({ file, error: error instanceof Error ? error.message : 'Could not open the PDF.' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file, attempt]);

  const current = result?.file === file ? result : null;
  return {
    url: hit ?? current?.url ?? null,
    error: hit ? null : (current?.error ?? null),
    retry: () => {
      if (file) cache.delete(file);
      setResult(null);
      setAttempt((value) => value + 1);
    },
  };
}
