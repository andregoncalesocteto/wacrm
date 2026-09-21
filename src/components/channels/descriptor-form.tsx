'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  buildPayload,
  initialValues,
  validateValues,
  type FormErrors,
  type FormValues,
} from '@/lib/channels/descriptor-form';
import type { DescriptorField } from '@/lib/channels/types';

export interface DescriptorFormSubmit {
  displayName: string;
  config: Record<string, string | boolean>;
  credentials: Record<string, string | boolean>;
}

interface Props {
  channelType: string;
  fields: DescriptorField[];
  submitting: boolean;
  disabled?: boolean;
  onSubmit: (payload: DescriptorFormSubmit) => void;
}

/**
 * Generic connection form driven by a provider's field descriptor (text,
 * secret, select, switch). Labels and help come from
 * `Channels.providers.<type>.fields.<name>.label|help`. The pure parts
 * (validation, payload) live in lib/channels/descriptor-form.ts.
 */
export function DescriptorForm({
  channelType,
  fields,
  submitting,
  disabled,
  onSubmit,
}: Props) {
  const t = useTranslations('Settings.channels.wizard');
  const tp = useTranslations(`Channels.providers.${channelType}`);
  const [displayName, setDisplayName] = useState('');
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));
  const [errors, setErrors] = useState<FormErrors>({});
  const [nameError, setNameError] = useState(false);

  const label = (name: string) =>
    tp.has(`fields.${name}.label`) ? tp(`fields.${name}.label`) : name;
  const help = (name: string) =>
    tp.has(`fields.${name}.help`) ? tp(`fields.${name}.help`) : null;
  const optionLabel = (name: string, value: string) =>
    tp.has(`fields.${name}.options.${value}`)
      ? tp(`fields.${name}.options.${value}`)
      : value;

  const set = (name: string, v: string | boolean) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = validateValues(fields, values);
    const missingName = displayName.trim() === '';
    setErrors(found);
    setNameError(missingName);
    if (missingName || Object.keys(found).length > 0) return;
    onSubmit({
      displayName: displayName.trim(),
      ...buildPayload(fields, values),
    });
  }

  return (
    <form onSubmit={submit} className="max-w-xl space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="df-display-name">{t('displayName')}</Label>
        <Input
          id="df-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-invalid={nameError}
          disabled={disabled}
        />
        {nameError ? (
          <p className="text-xs text-red-400">{t('errorRequired')}</p>
        ) : null}
      </div>

      {fields.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noFields')}</p>
      ) : null}

      {fields.map((f) => {
        const id = `df-${f.name}`;
        const err = errors[f.name];
        const helpText = help(f.name);
        return (
          <div key={f.name} className="space-y-1.5">
            {f.type === 'switch' ? (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={id}>{label(f.name)}</Label>
                <Switch
                  id={id}
                  checked={values[f.name] === true}
                  onCheckedChange={(v) => set(f.name, v)}
                  disabled={disabled}
                />
              </div>
            ) : (
              <>
                <Label htmlFor={id}>
                  {label(f.name)}
                  {f.required ? ' *' : ''}
                </Label>
                {f.type === 'select' ? (
                  <select
                    id={id}
                    value={String(values[f.name] ?? '')}
                    onChange={(e) => set(f.name, e.target.value)}
                    disabled={disabled}
                    aria-invalid={!!err}
                    className="border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
                  >
                    <option value="" />
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {optionLabel(f.name, o)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={id}
                    type={f.type === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    value={String(values[f.name] ?? '')}
                    onChange={(e) => set(f.name, e.target.value)}
                    disabled={disabled}
                    aria-invalid={!!err}
                  />
                )}
              </>
            )}
            {helpText ? (
              <p className="text-muted-foreground text-xs">{helpText}</p>
            ) : null}
            {err ? (
              <p className="text-xs text-red-400">
                {err === 'required' ? t('errorRequired') : t('errorPattern')}
              </p>
            ) : null}
          </div>
        );
      })}

      <Button type="submit" disabled={submitting || disabled}>
        {submitting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
        {submitting ? t('creating') : t('saveContinue')}
      </Button>
    </form>
  );
}
