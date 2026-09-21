import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from './admin-client';

/**
 * Dual write (US-013): whatsapp_config stays the source of truth for the
 * legacy readers; every save is mirrored into channel_connections and
 * channel_connection_credentials so the new tables never go stale while the
 * readers are migrated.
 *
 * SERVER-ONLY, service role (credentials have no RLS policy). Callers must
 * have authenticated the user and resolved `accountId` themselves. The state
 * is always read back FROM whatsapp_config, so the mirror can never diverge
 * from what the legacy table holds. Failures are logged, never thrown: the
 * legacy save must not break because the mirror did.
 */

const CHANNEL = 'whatsapp_cloud';
const LOG = '[channel:whatsapp_cloud]';

type Row = Record<string, unknown>;

function logFailure(op: string, err: unknown) {
  // Never log secrets: only the operation and the error message.
  console.error(
    `${LOG} dual-write ${op} failed:`,
    err instanceof Error ? err.message : err
  );
}

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

async function ensureStore(accountId: string): Promise<string> {
  const admin = supabaseAdmin();
  const stores = must(
    await admin
      .from('stores')
      .select('id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1)
  ) as Row[] | null;
  if (stores && stores.length > 0) return stores[0].id as string;

  const account = must(
    await admin
      .from('accounts')
      .select('name')
      .eq('id', accountId)
      .maybeSingle()
  ) as { name?: string } | null;
  const name = account?.name?.trim() || 'Loja principal';
  const created = must(
    await admin
      .from('stores')
      .insert({ account_id: accountId, name })
      .select('id')
      .single()
  ) as Row;
  return created.id as string;
}

/** The account's whatsapp_cloud connection (active one first), or null. */
async function findAccountConnection(accountId: string): Promise<Row | null> {
  const rows = (must(
    await supabaseAdmin()
      .from('channel_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('channel_type', CHANNEL)
      .order('created_at', { ascending: true })
  ) ?? []) as Row[];
  return rows.find((r) => r.disabled_at == null) ?? rows[0] ?? null;
}

function buildConfig(cfg: Row, previous: Row): Row {
  const merged: Row = {
    ...previous,
    waba_id: cfg.waba_id,
    mirror_inbound_media: cfg.mirror_inbound_media,
    registered_at: cfg.registered_at,
    subscribed_apps_at: cfg.subscribed_apps_at,
    last_registration_error: cfg.last_registration_error,
    verify_token: cfg.verify_token,
  };
  for (const k of Object.keys(merged)) {
    if (merged[k] == null) delete merged[k];
  }
  return merged;
}

/**
 * Reconciles the account's channel_connections row (+ store + credentials)
 * with its current whatsapp_config row. Covers create, update (including a
 * changed phone_number_id, which moves the same connection's external_id) and
 * the media-mirroring toggle. Returns true when the mirror was written.
 */
export async function syncWhatsappConnection(
  accountId: string
): Promise<boolean> {
  try {
    const admin = supabaseAdmin();
    const cfg = must(
      await admin
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .maybeSingle()
    ) as Row | null;
    if (!cfg) return false;

    const phoneNumberId = cfg.phone_number_id as string;
    const byAccount = await findAccountConnection(accountId);
    const byExternal = must(
      await admin
        .from('channel_connections')
        .select('*')
        .eq('channel_type', CHANNEL)
        .eq('external_id', phoneNumberId)
        .maybeSingle()
    ) as Row | null;

    if (byExternal && byExternal.account_id !== accountId) {
      throw new Error('phone_number_id is already mapped to another account');
    }
    // The connection that already carries this number wins; otherwise the
    // account's own connection is renamed to the new number.
    const target = byExternal ?? byAccount;

    const status = cfg.status === 'connected' ? 'connected' : 'disconnected';
    const values: Row = {
      external_id: phoneNumberId,
      status,
      connected_at: cfg.connected_at ?? null,
      disabled_at: null,
      config: buildConfig(cfg, (target?.config as Row | undefined) ?? {}),
    };

    let connectionId: string;
    if (target) {
      connectionId = target.id as string;
      must(
        await admin
          .from('channel_connections')
          .update(values)
          .eq('id', connectionId)
      );
    } else {
      const storeId = await ensureStore(accountId);
      const account = must(
        await admin
          .from('accounts')
          .select('name')
          .eq('id', accountId)
          .maybeSingle()
      ) as { name?: string } | null;
      const created = must(
        await admin
          .from('channel_connections')
          .insert({
            account_id: accountId,
            store_id: storeId,
            channel_type: CHANNEL,
            display_name: account?.name?.trim() || 'WhatsApp',
            ...values,
          })
          .select('id')
          .single()
      ) as Row;
      connectionId = created.id as string;
    }

    const token = decrypt(cfg.access_token as string);
    must(
      await admin.from('channel_connection_credentials').upsert(
        {
          connection_id: connectionId,
          account_id: accountId,
          secrets_encrypted: encrypt(JSON.stringify({ access_token: token })),
          secrets_format: 'json_v1',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'connection_id' }
      )
    );
    return true;
  } catch (err) {
    logFailure('sync', err);
    return false;
  }
}

/**
 * Mirrors the deletion of whatsapp_config. A connection without conversations
 * is removed; one that has history is only DISABLED (ADR-007), and its
 * credentials are dropped in both cases (the token was reset).
 */
export async function removeWhatsappConnection(
  accountId: string
): Promise<'deleted' | 'disabled' | 'none' | 'error'> {
  try {
    const admin = supabaseAdmin();
    const conn = await findAccountConnection(accountId);
    if (!conn) return 'none';
    const id = conn.id as string;

    const { count, error } = await admin
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('connection_id', id);
    if (error) throw new Error(error.message);

    if ((count ?? 0) === 0) {
      must(await admin.from('channel_connections').delete().eq('id', id));
      return 'deleted';
    }
    must(
      await admin
        .from('channel_connections')
        .update({
          disabled_at: new Date().toISOString(),
          status: 'disconnected',
        })
        .eq('id', id)
    );
    must(
      await admin
        .from('channel_connection_credentials')
        .delete()
        .eq('connection_id', id)
    );
    return 'disabled';
  } catch (err) {
    logFailure('remove', err);
    return 'error';
  }
}
