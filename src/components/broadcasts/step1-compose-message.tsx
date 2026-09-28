'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Loader2, Paperclip, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { uploadAccountMedia, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';
import { useChannelProviders } from '@/hooks/use-channel-providers';
import type { MediaKind } from '@/lib/channels/types';
import type { BroadcastConnectionContext } from '@/lib/contacts/broadcast-eligibility';

const ACCEPT_BY_KIND: Record<MediaKind, string> = {
  image: 'image/png,image/jpeg,image/webp,image/gif',
  video: 'video/mp4,video/3gpp,video/quicktime',
  audio: 'audio/mpeg,audio/ogg,audio/mp4,audio/aac',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

function mediaKindFromFile(file: File): MediaKind {
  const mime = file.type;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

interface Step1ComposeMessageProps {
  connection: BroadcastConnectionContext;
  text: string;
  onTextChange: (text: string) => void;
  mediaUrl: string;
  onMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Wizard step 1 for a connection whose `capabilities.initiate !== 'template'`
 * (design.md section 5, US-011): free-text body (reusing the template's
 * `{{n}}` token style, US-012 maps them to contact fields) + an optional
 * media attachment, mirroring `template-manager.tsx`'s header-media upload
 * (file picker + manual URL fallback + preview).
 *
 * Text/caption length and media type/size limits come from the CHOSEN
 * connection's provider (`GET /api/channels/providers`), never a fixed
 * number — a Telegram broadcast must not be validated against WhatsApp's
 * caps, or vice versa (same principle already fixed in Flows' validation).
 */
export function Step1ComposeMessage({
  connection,
  text,
  onTextChange,
  mediaUrl,
  onMediaUrlChange,
  onNext,
  onBack,
}: Step1ComposeMessageProps) {
  const t = useTranslations('Broadcasts.wizard');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(false);

  const providers = useChannelProviders();
  const capabilities = providers?.find(
    (p) => p.type === connection.channelType
  )?.capabilities;

  // `captionMaxLength` is the only per-provider text-length limit the
  // channel contract exposes (`lib/channels/types.ts`) — `broadcast-core.ts`
  // (US-005) already treats this same text as the media caption when media
  // is attached, so one limit governs both cases.
  const textMax = capabilities?.captionMaxLength ?? 1024;
  const mediaKinds = capabilities?.mediaKinds ?? [];
  // The bucket's own `file_size_limit` (migrations 016/020/023) is a real
  // infrastructure ceiling below some providers' cap (Telegram allows 50 MB,
  // the bucket only 16) — never advertise a limit the upload can't honor.
  const maxMediaBytes = Math.min(
    capabilities?.maxMediaBytes ?? MEDIA_MAX_BYTES,
    MEDIA_MAX_BYTES
  );
  const accept = mediaKinds.map((k) => ACCEPT_BY_KIND[k]).join(',');

  const textTooLong = text.length > textMax;
  const hasContent = text.trim().length > 0 || !!mediaUrl;

  function insertVariable() {
    const existing = new Set(
      [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
    );
    let next = 1;
    while (existing.has(next)) next++;
    const token = `{{${next}}}`;
    const el = textareaRef.current;
    if (el && document.activeElement === el) {
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      onTextChange(text.slice(0, start) + token + text.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    } else {
      onTextChange(text + token);
    }
  }

  async function handleFile(file: File) {
    const kind = mediaKindFromFile(file);
    if (!mediaKinds.includes(kind)) {
      toast.error(t('composeMessage.unsupportedMedia'));
      return;
    }
    if (file.size > maxMediaBytes) {
      toast.error(
        t('composeMessage.mediaTooLarge', {
          size: (file.size / 1024 / 1024).toFixed(1),
          max: Math.round(maxMediaBytes / 1024 / 1024),
        })
      );
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      onMediaUrlChange(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('composeMessage.uploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('composeMessage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('composeMessage.subtitle')}</p>
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-card/50 p-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">
            {t('composeMessage.textLabel')}
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={insertVariable}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('composeMessage.insertVariable')}
          </Button>
        </div>
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t('composeMessage.textPlaceholder')}
          className="min-h-32 border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <p
          className={`text-xs ${textTooLong ? 'text-red-400' : 'text-muted-foreground'}`}
        >
          {t('composeMessage.charCount', { count: text.length, max: textMax })}
        </p>
        {textTooLong && (
          <p className="text-xs text-red-400">
            {t('composeMessage.textTooLong', { max: textMax })}
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-card/50 p-4">
        <label className="text-sm font-medium text-foreground">
          {t('composeMessage.mediaLabel')}
        </label>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading || mediaKinds.length === 0}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Paperclip className="h-3.5 w-3.5" />
            )}
            {t('composeMessage.uploadButton')}
          </Button>
          {mediaUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onMediaUrlChange('')}
            >
              <X className="h-3.5 w-3.5" />
              {t('composeMessage.removeMedia')}
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{t('composeMessage.mediaHint')}</p>
        {mediaUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt={t('composeMessage.mediaPreviewAlt')}
            className="mt-2 max-h-40 rounded-lg border border-border object-contain"
          />
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!hasContent || textTooLong || uploading}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
