/**
 * Test double for the service-role client that `getConnectionCredentials`
 * uses (`@/lib/channels/admin-client`). Serves one
 * `channel_connection_credentials` row and swallows the best-effort
 * `wa_token_v0` -> `json_v1` upgrade write. Imported inside `vi.mock`
 * factories by the send-side tests (US-014).
 */
type CredentialsRow = { secrets_encrypted: string; secrets_format: string };

export function fakeCredentialsAdmin(read: () => CredentialsRow | null) {
  return {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'update']) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve({ data: read(), error: null });
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null });
      return b;
    },
  };
}

/** A whatsapp_cloud connection row, as the legacy config would map to it. */
export function whatsappConnectionRow(
  accountId: string,
  phoneNumberId: string,
  extra: Record<string, unknown> = {}
) {
  return {
    id: `conn-${accountId}`,
    account_id: accountId,
    channel_type: 'whatsapp_cloud',
    external_id: phoneNumberId,
    status: 'connected',
    config: {},
    disabled_at: null,
    ...extra,
  };
}
