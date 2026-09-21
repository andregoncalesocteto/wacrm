'use client';

import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCan } from '@/hooks/use-can';
import {
  buildPayload,
  initialValues,
  validateValues,
  type FormErrors,
  type FormValues,
} from '@/lib/channels/descriptor-form';
import type { DescriptorField } from '@/lib/channels/types';
import type { ChannelConnectionRow } from '@/lib/channels/ui';

interface Props {
  connection: ChannelConnectionRow;
  channelType: string;
  fields: DescriptorField[];
  onChanged: () => void;
}

type Outcome = { ok: boolean; text: string } | null;

/**
 * Detail-screen panel for form-driven providers: each secret is shown as
 * "provided" (the value is never returned by the API) with a Replace action.
 * Replacing PATCHes the credentials and reconnects, because a provider may
 * rebuild derived secrets on connect (Telegram's webhook secret_token).
 */
export function CredentialsPanel({
  connection,
  channelType,
  fields,
  onChanged,
}: Props) {
  const t = useTranslations('Settings.channels.credentials');
  const tw = useTranslations('Settings.channels.wizard');
  const tp = useTranslations(`Channels.providers.${channelType}`);
  const canEdit = useCan('edit-settings');

  const secrets = fields.filter((f) => f.type === 'secret');
  const [editing, setEditing] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  if (secrets.length === 0) return null;

  const label = (name: string) =>
    tp.has(`fields.${name}.label`) ? tp(`fields.${name}.label`) : name;

  async function save() {
    const found = validateValues(fields, values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setOutcome(null);
    try {
      const base = `/api/channels/connections/${connection.id}`;
      const { credentials } = buildPayload(fields, values);
      const pRes = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials }),
      });
      if (!pRes.ok) {
        const d = await pRes.json().catch(() => ({}));
        setOutcome({ ok: false, text: d.error ?? t('saveFailed') });
        return;
      }
      setEditing(null);
      setValues(initialValues(fields));
      const cRes = await fetch(`${base}/connect`, { method: 'POST' });
      const cData = await cRes.json().catch(() => ({}));
      onChanged();
      if (cRes.ok && cData.ok) {
        setOutcome({ ok: true, text: t('replacedOk') });
      } else {
        setOutcome({
          ok: false,
          text: t('replacedNotConnected', {
            reason: cData.message ?? cData.error ?? tw('unreachable'),
          }),
        });
      }
    } catch {
      setOutcome({ ok: false, text: tw('unreachable') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="text-primary size-4" aria-hidden />
        <h3 className="text-foreground text-sm font-semibold">{t('title')}</h3>
      </div>
      {secrets.map((f) => {
        const id = `cp-${f.name}`;
        const isEditing = editing === f.name;
        return (
          <div key={f.name} className="space-y-1.5">
            <Label htmlFor={id}>{label(f.name)}</Label>
            {isEditing ? (
              <>
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  value={String(values[f.name] ?? '')}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.name]: e.target.value }))
                  }
                  aria-invalid={!!errors[f.name]}
                  disabled={busy}
                />
                {errors[f.name] ? (
                  <p className="text-xs text-red-400">
                    {errors[f.name] === 'required'
                      ? tw('errorRequired')
                      : tw('errorPattern')}
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void save()}>
                    {busy ? (
                      <Loader2 className="mr-1 size-4 animate-spin" />
                    ) : null}
                    {t('saveAndReconnect')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setErrors({});
                      setValues(initialValues(fields));
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <Input id={id} value="••••••••••" readOnly disabled />
                <span className="text-muted-foreground text-xs">
                  {t('provided')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canEdit || busy}
                  onClick={() => {
                    setEditing(f.name);
                    setOutcome(null);
                  }}
                >
                  {t('replace')}
                </Button>
              </div>
            )}
            <p className="text-muted-foreground text-xs">{t('help')}</p>
          </div>
        );
      })}
      {outcome ? (
        <Alert
          className={
            outcome.ok
              ? 'border-emerald-700/50 bg-emerald-950/30'
              : 'border-red-700/50 bg-red-950/30'
          }
        >
          <AlertDescription
            className={outcome.ok ? 'text-emerald-100/80' : 'text-red-100/80'}
          >
            {outcome.text}
          </AlertDescription>
        </Alert>
      ) : null}
    </Card>
  );
}
