'use client';

import { useEffect, useState } from 'react';

/**
 * channel_type of each ENABLED connection of the account (one entry per
 * connection), from GET /api/channels/connections; null while loading or on
 * failure. Used for the informational step-capability warnings.
 */
export function useActiveChannelTypes(): string[] | null {
  const [types, setTypes] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/channels/connections')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http'))))
      .then((json) => {
        const rows = (json.connections ?? []) as {
          channel_type: string;
          disabled_at: string | null;
        }[];
        if (alive) {
          setTypes(
            rows.filter((r) => !r.disabled_at).map((r) => r.channel_type)
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return types;
}
