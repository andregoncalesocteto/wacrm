'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step0ChooseConnection } from '@/components/broadcasts/step0-choose-connection';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step1ComposeMessage } from '@/components/broadcasts/step1-compose-message';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import type { BroadcastConnectionContext } from '@/lib/contacts/broadcast-eligibility';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'connection', key: 'connection' },
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

// `useSearchParams` (the `?draft=<id>` resume below) requires a Suspense
// boundary or the production build bails to CSR and errors out — same
// pattern as /inbox's `?c=<id>` deep link.
export default function NewBroadcastPage() {
  return (
    <Suspense fallback={null}>
      <NewBroadcastPageInner />
    </Suspense>
  );
}

function NewBroadcastPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftIdParam = searchParams.get('draft');
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [loadingDraft, setLoadingDraft] = useState(!!draftIdParam);
  // The draft row being edited, once loaded — null for a brand-new
  // broadcast. `handleSaveDraft`/`handleSend` below check it to update
  // that same row instead of inserting a second one.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  // Free-message content for a connection without templates (US-011).
  // Mutually exclusive with `template` — only one is read at send time.
  const [messageText, setMessageText] = useState('');
  const [messageMediaUrl, setMessageMediaUrl] = useState('');

  // Chosen at step 0 (Step0ChooseConnection) — the user's own pick now,
  // no more auto-resolving "the" WhatsApp connection (US-010).
  const [connection, setConnection] = useState<BroadcastConnectionContext | null>(
    null
  );

  // `?draft=<id>` — reopen a broadcast saved as a draft and land on the
  // last step with everything filled back in. `handleSaveDraft`/`handleSend`
  // below check `draftId` to update the same row instead of inserting a
  // second one.
  useEffect(() => {
    if (!draftIdParam) return;
    let alive = true;
    (async () => {
      const supabase = createClient();
      const [{ data: broadcast, error }, cRes, pRes] = await Promise.all([
        supabase.from('broadcasts').select('*').eq('id', draftIdParam).single(),
        fetch('/api/channels/connections', { cache: 'no-store' }),
        fetch('/api/channels/providers', { cache: 'no-store' }),
      ]);
      if (!alive) return;
      if (error || !broadcast || !cRes.ok || !pRes.ok) {
        toast.error(t('toastDraftNotFound'));
        setLoadingDraft(false);
        return;
      }
      const cData = await cRes.json();
      const pData = await pRes.json();
      if (!alive) return;

      const connRow = (cData.connections ?? []).find(
        (c: { id: string }) => c.id === broadcast.connection_id
      );
      const providerRow = (pData.providers ?? []).find(
        (p: { type: string }) => p.type === connRow?.channel_type
      );
      if (connRow) {
        setConnection({
          connectionId: connRow.id,
          channelType: connRow.channel_type,
          initiate: providerRow?.capabilities.initiate ?? 'template',
        });
      }

      if (broadcast.template_name) {
        const { data: templateRow } = await supabase
          .from('message_templates')
          .select('*')
          .eq('connection_id', broadcast.connection_id)
          .eq('name', broadcast.template_name)
          .eq('language', broadcast.template_language)
          .maybeSingle();
        if (alive && templateRow) setTemplate(templateRow as MessageTemplate);
      } else {
        setMessageText(broadcast.message_text ?? '');
        setMessageMediaUrl(broadcast.message_media_url ?? '');
      }

      setName(broadcast.name);
      setVariables(
        (broadcast.template_variables as typeof variables | null) ?? {}
      );
      const filter = broadcast.audience_filter as
        | (typeof audience & { csvContacts?: typeof audience.csvContacts })
        | null;
      if (filter?.type) setAudience(filter);

      setDraftId(broadcast.id);
      setCurrentStep(4);
      setLoadingDraft(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the draft id in the URL, not on every state change it sets
  }, [draftIdParam]);

  async function handleSend() {
    if ((!template && !messageText) || !connection) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        messageText: messageText || undefined,
        messageMediaUrl: messageMediaUrl || undefined,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
        connection,
      });
      // Sending a resumed draft supersedes it with a real broadcast row
      // (created above) — drop the now-redundant draft so it doesn't
      // linger in the list. Best-effort: a failure here doesn't affect
      // the send that already succeeded.
      if (draftId) {
        const supabase = createClient();
        await supabase.from('broadcasts').delete().eq('id', draftId);
      }
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : t('failed');
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page (or the report page's "Continue
   * editing" banner) to finish the flow later: `?draft=<id>` reloads
   * every field saved here, including the full audience config, so the
   * round-trip is exact. Updates the same row in place when resuming an
   * existing draft (`draftId` set), inserts a new one otherwise.
   */
  async function handleSaveDraft() {
    if ((!template && !messageText) || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    if (!connection) {
      toast.error(t('toastNoConnection'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const fields = {
      connection_id: connection.connectionId,
      name: name.trim(),
      template_name: template ? template.name : null,
      template_language: template ? (template.language ?? 'en_US') : null,
      template_variables: variables,
      message_text: template ? null : messageText || null,
      message_media_url: template ? null : messageMediaUrl || null,
      // Full config, not just type/tagIds — needed to round-trip an
      // exact resume (`?draft=<id>` above), not just to label the row.
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
        customField: audience.customField,
        excludeTagIds: audience.excludeTagIds,
        csvContacts: audience.csvContacts,
      },
    };

    const { error } = draftId
      ? await supabase.from('broadcasts').update(fields).eq('id', draftId)
      : await supabase.from('broadcasts').insert({
          ...fields,
          user_id: user.id,
          account_id: accountId,
          status: 'draft',
          total_recipients: 0,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  if (loadingDraft) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step0ChooseConnection
              selected={connection}
              onSelect={setConnection}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && connection?.initiate === 'template' && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 1 && connection && connection.initiate !== 'template' && (
            <Step1ComposeMessage
              connection={connection}
              text={messageText}
              onTextChange={setMessageText}
              mediaUrl={messageMediaUrl}
              onMediaUrlChange={setMessageMediaUrl}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
              connection={connection}
            />
          )}
          {currentStep === 3 && (template || messageText) && (
            <Step3Personalize
              template={template}
              messageText={messageText}
              messageMediaUrl={messageMediaUrl}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(4)}
              onBack={() => setCurrentStep(2)}
            />
          )}
          {currentStep === 4 && (template || messageText) && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              messageText={messageText}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(3)}
              isProcessing={isProcessing}
              progress={progress}
              connection={connection}
            />
          )}
        </div>
      </div>
    </div>
  );
}
