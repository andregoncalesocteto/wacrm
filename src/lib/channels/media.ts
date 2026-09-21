import type { SupabaseClient } from '@supabase/supabase-js';
import {
  mirrorInboundMedia,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';
import type { IngestHooks } from './ingest';
import { MediaTransferError, type ChannelProvider } from './types';

/**
 * `IngestHooks.resolveMedia` implementation (US-021): copies inbound media
 * into the `chat-media` bucket through `provider.downloadMedia` and the same
 * storage code the WhatsApp webhook uses today (`mirrorInboundMedia`), so a
 * provider needs no storage knowledge of its own.
 *
 * Same outcomes as the route's `verifyAndBuildUrl`:
 *  - mirror on (connection `config.mirror_inbound_media !== false`) and the
 *    upload works        -> the durable public URL;
 *  - mirror off, or the download worked but the mirror was refused/failed
 *    (oversized, MIME outside the bucket allow-list, storage outage)
 *                        -> the provider's fallback URL (WhatsApp: the Meta
 *                           proxy `/api/whatsapp/media/<id>`);
 *  - the provider's media LOOKUP fails -> null (the route returned null when
 *    Meta refused the media lookup); a MediaTransferError (oversized, transfer
 *    failed) keeps the fallback URL like a refused mirror.
 * Never throws and never logs or stores a token: the provider resolves
 * credentials itself, and no download URL reaches the stored value.
 *
 * Difference from the route: with the mirror OFF the route still asked Meta
 * for the media URL (a lookup that returned null on failure). Without a
 * provider-neutral "verify" call, this stores the fallback URL directly.
 */

export interface MediaResolverOptions {
  provider: Pick<ChannelProvider, 'downloadMedia'>;
  /** Service-role `supabase.storage`, or a fake in tests. */
  storage: MirrorStorage | SupabaseClient['storage'];
  /**
   * URL to keep when the media is not mirrored. Defaults to the WhatsApp Meta
   * proxy for `whatsapp_cloud` connections and to null for other channels.
   */
  fallbackUrl?: (ref: { id: string }, channelType: string) => string | null;
}

const defaultFallback = (ref: { id: string }, channelType: string) =>
  channelType === 'whatsapp_cloud' ? `/api/whatsapp/media/${ref.id}` : null;

export function createMediaResolver(
  opts: MediaResolverOptions
): NonNullable<IngestHooks['resolveMedia']> {
  const fallback = opts.fallbackUrl ?? defaultFallback;
  return async (content, { connection, event }) => {
    const ref = content.media;
    const fallbackUrl = fallback(ref, connection.channel_type);
    const mirrorEnabled = connection.config?.mirror_inbound_media !== false;
    if (!mirrorEnabled || !opts.provider.downloadMedia) {
      return { url: fallbackUrl };
    }

    let downloadFailed = false;
    try {
      const url = await mirrorInboundMedia({
        storage: opts.storage as MirrorStorage,
        accountId: connection.account_id,
        mediaId: ref.id,
        // Unused: the download below goes through the provider.
        downloadUrl: '',
        accessToken: '',
        mimeType: ref.mimeType,
        fileName: ref.fileName,
        messageTimestamp: Math.floor(event.at.getTime() / 1000),
        download: async () => {
          try {
            const blob = await opts.provider.downloadMedia!(connection, ref);
            return {
              buffer: Buffer.from(await blob.arrayBuffer()),
              contentType: blob.type,
            };
          } catch (err) {
            // A failed lookup means Meta no longer has the media (nothing to
            // link to); a failed transfer keeps the proxy link.
            downloadFailed = !(err instanceof MediaTransferError);
            throw err;
          }
        },
      });
      if (url) return { url };
    } catch (err) {
      console.error(
        `[channel:media] could not resolve media ${ref.id}:`,
        err instanceof Error ? err.message : err
      );
    }
    return { url: downloadFailed ? null : fallbackUrl };
  };
}
