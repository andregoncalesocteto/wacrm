'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { ChannelConnectionRow } from '@/lib/channels/ui';
import {
  buildConnectBody,
  buildCreateBody,
  buildMirrorBody,
  buildPatchBody,
  connectionView,
  generateVerifyToken,
  healthView,
  shouldConnect,
  validateDraft,
} from './panel-logic';

type Failure = { message: string };
type Probe = { live: boolean; reason: string | null };

export interface WhatsAppConnectionPanelProps {
  /** null = create mode. */
  connection: ChannelConnectionRow | null;
  /** Store the connection is (or will be) created in. */
  storeId: string;
  /** Called after any write, so the list behind the panel can refresh. */
  onChanged: () => void;
  /**
   * Embedding (wizard): when set, create mode only creates the connection and
   * hands it over with the PIN, and the host runs connect + test itself. The
   * PIN is passed along in memory only, never stored.
   */
  onCreated?: (connection: ChannelConnectionRow, opts: { pin: string }) => void;
  /** Hides the panel's own heading when a host provides the chrome. */
  hideChrome?: boolean;
}

/** The fields of the channels API responses this panel reads. */
interface ApiData {
  error?: string;
  code?: string;
  ok?: boolean;
  message?: string;
  details?: { registration?: string } | null;
  connection?: ChannelConnectionRow;
  health?: { state: string; reason: string | null };
}

async function callJson(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown
): Promise<{ ok: boolean; data: ApiData }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ApiData;
  return { ok: res.ok, data };
}

/**
 * WhatsApp Cloud panel for ONE connection (create mode when `connection` is
 * null). Secrets are never prefilled: the API does not return them, so the
 * access token and the verify token show "provided" plus a Replace action, and
 * only a newly typed/generated value is sent. The 2-step PIN is sent to
 * /connect only, never stored.
 */
export function WhatsAppConnectionPanel({
  connection,
  storeId,
  onChanged,
  onCreated,
  hideChrome = false,
}: WhatsAppConnectionPanelProps) {
  const t = useTranslations('Settings.whatsapp');
  const format = useFormatter();
  const canEditSettings = useCan('edit-settings');

  // Local copy: creating flips this panel to edit mode without remounting,
  // so a connect error stays on screen.
  const [conn, setConn] = useState<ChannelConnectionRow | null>(connection);
  const isCreate = conn === null;
  const view = connectionView(conn);

  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [saveFailure, setSaveFailure] = useState<Failure | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);

  const [displayName, setDisplayName] = useState(
    connection?.display_name ?? ''
  );
  const [phoneNumberId, setPhoneNumberId] = useState(
    connection?.external_id ?? ''
  );
  const [wabaId, setWabaId] = useState(view.wabaId);
  const [accessToken, setAccessToken] = useState('');
  const [replacingToken, setReplacingToken] = useState(false);
  // Create mode shows the generated token so it can be copied into Meta;
  // edit mode only ever holds one after the user asks to replace it.
  const [verifyToken, setVerifyToken] = useState(() =>
    connection ? '' : generateVerifyToken()
  );
  const [pin, setPin] = useState('');
  const [mirrorMedia, setMirrorMedia] = useState(view.mirrorMedia);
  const [savingMirror, setSavingMirror] = useState(false);

  const isRegistered = Boolean(view.registeredAt);
  const editingToken = isCreate || replacingToken;

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  function adopt(row: ChannelConnectionRow | null | undefined) {
    if (!row) return;
    setConn((prev) => ({ ...(prev ?? row), ...row }));
  }

  async function handleToggleMirrorMedia(next: boolean) {
    if (!conn || savingMirror) return;
    const previous = mirrorMedia;
    setMirrorMedia(next);
    setSavingMirror(true);
    try {
      const { ok, data } = await callJson(
        `/api/channels/connections/${conn.id}`,
        'PATCH',
        buildMirrorBody(next)
      );
      if (!ok) throw new Error(data.error ?? 'patch failed');
      adopt(data.connection);
      onChanged();
    } catch (error) {
      console.error('Failed to update media retention setting:', error);
      setMirrorMedia(previous);
      toast.error(t('mirrorInboundSaveFailed'));
    } finally {
      setSavingMirror(false);
    }
  }

  /** POST .../connect; returns true when Meta accepted the connection. */
  async function runConnect(id: string): Promise<boolean> {
    const { data } = await callJson(
      `/api/channels/connections/${id}/connect`,
      'POST',
      buildConnectBody(pin)
    );
    adopt(data.connection);
    onChanged();
    if (data.ok) {
      setSaveFailure(null);
      if (data.details?.registration === 'registered') {
        toast.success(t('connectedGeneric'));
      } else {
        toast.success(t('savedRegistrationSkipped'), { duration: 10000 });
      }
      setPin('');
      return true;
    }
    const message = data.message ?? data.error ?? t('saveFailed');
    setSaveFailure({
      message: t('savedButRegistrationFailed', { error: message }),
    });
    toast.error(t('savedButRegistrationFailed', { error: message }), {
      duration: 12000,
    });
    return false;
  }

  async function handleSave() {
    const invalid = validateDraft({
      isCreate,
      displayName,
      phoneNumberId,
      wabaId,
      accessToken,
    });
    if (invalid) {
      toast.error(t(invalid));
      return;
    }
    if (replacingToken && !accessToken.trim()) {
      toast.error(t('accessTokenRequired'));
      return;
    }

    setSaving(true);
    try {
      if (isCreate) {
        const { ok, data } = await callJson(
          '/api/channels/connections',
          'POST',
          buildCreateBody({
            storeId,
            displayName,
            phoneNumberId,
            wabaId,
            accessToken,
            verifyToken,
            mirrorMedia,
          })
        );
        if (!ok) {
          const message =
            data.code === 'duplicate_connection'
              ? t('duplicateConnection')
              : (data.error ?? t('saveFailed'));
          setSaveFailure({ message });
          toast.error(message, { duration: 10000 });
          return;
        }
        const row = data.connection as ChannelConnectionRow;
        onChanged();
        if (onCreated) {
          onCreated({ ...row, has_conversations: false }, { pin });
          return;
        }
        setConn({ ...row, has_conversations: false });
        setAccessToken('');
        await runConnect(row.id);
        return;
      }

      const tokenReplaced = replacingToken && accessToken.trim() !== '';
      const { ok, data } = await callJson(
        `/api/channels/connections/${conn.id}`,
        'PATCH',
        buildPatchBody({
          displayName,
          wabaId,
          mirrorMedia,
          newVerifyToken: verifyToken || null,
          newAccessToken: tokenReplaced ? accessToken : null,
        })
      );
      if (!ok) {
        const message = data.error ?? t('saveFailed');
        setSaveFailure({ message });
        toast.error(message, { duration: 10000 });
        return;
      }
      setSaveFailure(null);
      adopt(data.connection);
      onChanged();
      const connect = shouldConnect({
        tokenReplaced,
        pin,
        wabaChanged: wabaId.trim() !== view.wabaId,
        status: conn.status,
      });
      if (connect) {
        await runConnect(conn.id);
      } else {
        toast.success(t('saved'));
      }
      setAccessToken('');
      setReplacingToken(false);
      setVerifyToken('');
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleVerifyRegistration() {
    if (!conn) return;
    setVerifying(true);
    setProbe(null);
    try {
      const res = await fetch(`/api/channels/connections/${conn.id}/test`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as ApiData;
      if (!res.ok || !data.health) {
        toast.error(t('verifyEndpointUnreachable'));
        return;
      }
      const result = healthView(data.health);
      setProbe(result);
      adopt(data.connection);
      onChanged();
      if (result.live) {
        toast.success(t('fullyWired'));
      } else {
        toast.error(t('notFullyRegistered'), { duration: 8000 });
      }
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error(t('verifyEndpointUnreachable'));
    } finally {
      setVerifying(false);
    }
  }

  function handleCopy(value: string, message: string) {
    void navigator.clipboard.writeText(value);
    toast.success(message);
  }

  const mutable = canEditSettings;

  return (
    <section className="animate-in fade-in-50 duration-200">
      {hideChrome ? null : (
        <SettingsPanelHead title={t('title')} description={t('description')} />
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Main config form */}
        <div className="space-y-6">
          {/* Last save/connect failed: the explained reason stays on screen */}
          {saveFailure && (
            <Alert className="border-red-700/50 bg-red-950/30">
              <div className="flex items-start gap-3">
                <XCircle className="mt-0.5 size-5 shrink-0 text-red-400" />
                <div className="min-w-0 flex-1">
                  <AlertTitle className="mb-1 text-red-200">
                    {t('lastSaveFailed')}
                  </AlertTitle>
                  <AlertDescription className="text-sm text-red-100/80">
                    {saveFailure.message}
                  </AlertDescription>
                </div>
              </div>
            </Alert>
          )}

          {/* Connection Status */}
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {view.credentialsValid ? (
                <CheckCircle2 className="text-primary size-4" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {view.credentialsValid
                  ? t('credentialsValid')
                  : t('notConnected')}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {view.credentialsValid
                ? t('connectedDesc')
                : view.lastErrorMessage || t('notConnectedDesc')}
            </AlertDescription>
          </Alert>

          {/* Registration Status: credentials being valid is necessary but not
            sufficient; without a successful /register the number won't
            receive inbound events. */}
          {conn && (
            <Alert
              className={
                isRegistered
                  ? 'border-emerald-700/50 bg-emerald-950/30'
                  : 'border-amber-700/50 bg-amber-950/30'
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isRegistered ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-4 text-amber-400" />
                  )}
                  <AlertTitle
                    className={
                      'mb-0 ' +
                      (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                    }
                  >
                    {isRegistered ? t('registered') : t('notRegistered')}
                  </AlertTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleVerifyRegistration}
                  disabled={verifying || !mutable}
                  className="border-border text-foreground hover:bg-muted h-7 bg-transparent"
                >
                  {verifying ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  {t('verifyWithMeta')}
                </Button>
              </div>
              <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {isRegistered ? (
                  <span
                    dangerouslySetInnerHTML={{
                      __html: t('subscribedSince', {
                        date: view.registeredAt
                          ? format.dateTime(
                              new Date(view.registeredAt),
                              'dateTimeSeconds'
                            )
                          : t('unknownDate'),
                      }),
                    }}
                  />
                ) : view.lastRegistrationError ? (
                  <>
                    {t('lastAttemptFailed')}
                    <span className="text-red-300">
                      {'"'}
                      {view.lastRegistrationError}
                      {'"'}
                    </span>
                    {'.'} {t('retryHint')}
                  </>
                ) : (
                  <>{t('noRegistrationHint')}</>
                )}
              </AlertDescription>

              {probe && (
                <div className="border-border bg-card/60 mt-3 space-y-1.5 rounded border px-3 py-2 text-[11px]">
                  <p className="text-foreground font-medium">
                    {t('diagnosticLastRun')}
                    <span
                      className={
                        probe.live ? 'text-emerald-400' : 'text-amber-400'
                      }
                    >
                      {probe.live ? t('live') : t('notLive')}
                    </span>
                  </p>
                  {probe.reason && (
                    <p className="text-red-300">{probe.reason}</p>
                  )}
                </div>
              )}
            </Alert>
          )}

          {/* API Credentials */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {t('apiCredentialsTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('apiCredentialsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('displayName')}
                </Label>
                <Input
                  placeholder={t('displayNamePlaceholder')}
                  value={displayName}
                  maxLength={120}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('phoneNumberId')}
                </Label>
                <Input
                  placeholder={t('phoneNumberIdPlaceholder')}
                  value={phoneNumberId}
                  readOnly={!isCreate}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                {!isCreate && (
                  <p className="text-muted-foreground text-xs">
                    {t('phoneNumberIdLocked')}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('wabaId')}</Label>
                <Input
                  placeholder={t('wabaIdPlaceholder')}
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('accessToken')}
                </Label>
                {editingToken ? (
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type={showToken ? 'text' : 'password'}
                        placeholder={t('accessTokenPlaceholder')}
                        value={accessToken}
                        autoComplete="off"
                        onChange={(e) => setAccessToken(e.target.value)}
                        className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
                      >
                        {showToken ? (
                          <EyeOff className="size-4" />
                        ) : (
                          <Eye className="size-4" />
                        )}
                      </button>
                    </div>
                    {!isCreate && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setReplacingToken(false);
                          setAccessToken('');
                        }}
                      >
                        {t('keepCurrent')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="border-border bg-muted flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <span className="text-muted-foreground text-sm">
                      {t('tokenProvided')}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!mutable}
                      onClick={() => setReplacingToken(true)}
                    >
                      {t('replace')}
                    </Button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('webhookVerifyToken')}
                </Label>
                {verifyToken ? (
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={verifyToken}
                      className="bg-muted border-border text-muted-foreground font-mono text-sm"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleCopy(verifyToken, t('verifyTokenCopied'))
                      }
                      className="border-border text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                      aria-label={t('copyVerifyToken')}
                    >
                      <Copy className="size-4" />
                    </Button>
                    {!isCreate && (
                      <Button
                        variant="outline"
                        onClick={() => setVerifyToken('')}
                      >
                        {t('keepCurrent')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="border-border bg-muted flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <span className="text-muted-foreground text-sm">
                      {t('verifyTokenProvided')}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!mutable}
                      onClick={() => setVerifyToken(generateVerifyToken())}
                    >
                      {t('replace')}
                    </Button>
                  </div>
                )}
                <p className="text-muted-foreground text-xs">
                  {verifyToken
                    ? t('verifyTokenGeneratedHint')
                    : t('webhookVerifyTokenHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('twoStepPin')}
                  <span className="text-muted-foreground ml-1">
                    {t('optional')}
                  </span>
                </Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('pinPlaceholder')}
                  value={pin}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
                />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Webhook URL */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {t('webhookTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('webhookDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('webhookUrl')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="bg-muted border-border text-muted-foreground font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleCopy(webhookUrl, t('webhookCopied'))}
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                    aria-label={t('webhookUrl')}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Attachment retention: governs what the webhook does with inbound
            media, so it only makes sense once the connection exists. */}
          {conn && (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">
                  {t('mediaTitle')}
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  {t('mediaDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <p className="text-foreground text-sm font-medium">
                      {t('mirrorInbound')}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('mirrorInboundDesc')}
                    </p>
                    {!mirrorMedia && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                        {t('mirrorInboundOffWarning')}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={mirrorMedia}
                    onCheckedChange={handleToggleMirrorMedia}
                    disabled={savingMirror || !mutable}
                    aria-label={t('mirrorInbound')}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSave}
              disabled={saving || !mutable}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : isCreate ? (
                t('createConnection')
              ) : (
                t('saveConfig')
              )}
            </Button>
            {conn && (
              <Button
                variant="outline"
                onClick={handleVerifyRegistration}
                disabled={verifying || !mutable}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {verifying ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('testing')}
                  </>
                ) : (
                  <>
                    <Zap className="size-4" />
                    {t('testConnection')}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Setup Instructions Sidebar */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">
                {t('setupInstructions')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('setupInstructionsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        {'1'}
                      </span>
                      {t('step1')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                      <li>{t('step1_2')}</li>
                      <li>{t('step1_3')}</li>
                      <li>{t('step1_4')}</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        {'2'}
                      </span>
                      {t('step2')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>{t('step2_1')}</li>
                      <li>{t('step2_2')}</li>
                      <li>{t('step2_3')}</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        {'3'}
                      </span>
                      {t('step3')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>{t('step3_1')}</li>
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step3_2') }}
                      />
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step3_3') }}
                      />
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step3_4') }}
                      />
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        {'4'}
                      </span>
                      {t('step4')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>{t('step4_1')}</li>
                      <li>{t('step4_2')}</li>
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step4_3') }}
                      />
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step4_4') }}
                      />
                      <li>{t('step4_5')}</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <div className="border-border mt-4 border-t pt-4">
                <a
                  href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 inline-flex items-center gap-1.5 text-sm transition-colors"
                >
                  <ExternalLink className="size-3.5" />
                  {t('metaDocs')}
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
