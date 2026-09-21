import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { syncWhatsappConnection } from '@/lib/channels/whatsapp-dual-write';

/**
 * POST /api/whatsapp/config/mirror-media
 *
 * The media-mirroring switch writes whatsapp_config straight from the
 * browser (RLS). This route is called right after and copies the saved state
 * into channel_connections. It takes no value from the client: the caller's
 * own RLS-bound read of whatsapp_config proves they may see the row, and the
 * mirror is rebuilt from that row, so this cannot be used to set anything.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 }
    );
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!config) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration.' },
      { status: 404 }
    );
  }

  const synced = await syncWhatsappConnection(accountId);
  return NextResponse.json({ success: true, synced });
}
