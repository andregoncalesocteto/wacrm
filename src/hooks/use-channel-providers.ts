'use client';

import { useEffect, useState } from 'react';
import type { ProviderCapabilities } from '@/lib/channels/composer-capabilities';

// One fetch per page load, shared by every composer instance. Capabilities
// come from GET /api/channels/providers (no secrets); a failed fetch clears the
// cache so the next mount retries.
let cache: Promise<ProviderCapabilities[]> | null = null;

function load(): Promise<ProviderCapabilities[]> {
  if (!cache) {
    cache = fetch('/api/channels/providers')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => (json.providers ?? []) as ProviderCapabilities[])
      .catch((err) => {
        cache = null;
        throw err;
      });
  }
  return cache;
}

/** Provider capabilities, or null while loading / if the fetch failed. */
export function useChannelProviders(): ProviderCapabilities[] | null {
  const [providers, setProviders] = useState<ProviderCapabilities[] | null>(
    null
  );
  useEffect(() => {
    let alive = true;
    load()
      .then((p) => alive && setProviders(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return providers;
}
