// ============================================================
// Where an outbound webhook event came from: the connection, its store
// and channel, and the contact (phone + identities). Merged into every
// event's `data` so an integrator can tell a WhatsApp number from a
// Telegram bot without a second lookup.
//
// Best-effort like the delivery itself: a failed lookup degrades to an
// empty contact block rather than dropping the event.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { serializeIdentities, type ApiIdentity } from '@/lib/api/v1/contacts';

export interface WebhookOrigin {
  connection_id: string;
  store_id: string | null;
  channel: string;
  contact: {
    id: string | null;
    /** `null` when the contact has no phone (e.g. Telegram-only). */
    phone: string | null;
    identities: ApiIdentity[];
  };
}

export async function buildWebhookOrigin(
  db: SupabaseClient,
  connection: { id: string; store_id?: string | null; channel_type: string },
  contactId: string | null | undefined
): Promise<WebhookOrigin> {
  const contact: WebhookOrigin['contact'] = {
    id: contactId ?? null,
    phone: null,
    identities: [],
  };
  if (contactId) {
    try {
      const { data: row } = await db
        .from('contacts')
        .select('phone')
        .eq('id', contactId)
        .maybeSingle();
      // The DB keeps '' for "no phone"; the API says null.
      contact.phone = (row as { phone?: string | null } | null)?.phone || null;
      const { data: ids } = await db
        .from('contact_identities')
        .select('kind, external_id, handle')
        .eq('contact_id', contactId);
      contact.identities = serializeIdentities(ids);
    } catch (err) {
      console.error('[webhooks] origin lookup failed:', err);
    }
  }
  return {
    connection_id: connection.id,
    store_id: connection.store_id ?? null,
    channel: connection.channel_type,
    contact,
  };
}
