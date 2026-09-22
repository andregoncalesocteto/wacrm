'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Store, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { STORE_LIMITS } from '@/lib/stores/validation';
import {
  connectionChipState,
  hoursToText,
  textToHours,
  validateDraft,
  type ConnectionChipState,
  type StoreDraft,
} from '@/lib/stores/ui';
import { SettingsPanelHead } from './settings-panel-head';

interface StoreConnection {
  id: string;
  channel_type: string;
  display_name: string | null;
  status: string;
  disabled_at: string | null;
}

interface StoreRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  business_hours: Record<string, unknown> | null;
  manager_name: string | null;
  connections: StoreConnection[];
}

const CHIP_TONE: Record<ConnectionChipState, string> = {
  connected: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  degraded: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  disconnected: 'bg-muted text-muted-foreground',
  needs_action: 'bg-red-500/10 text-red-600 dark:text-red-400',
  disabled: 'bg-muted text-muted-foreground line-through',
};

const CHANNEL_TYPES = ['whatsapp_cloud', 'telegram'] as const;

function emptyDraft(): StoreDraft {
  return { name: '', address: '', phone: '', hours: '', manager_name: '' };
}

/**
 * Stores section: list, create/edit dialog and delete. Write actions require
 * `edit-settings`; other roles see the list read-only.
 */
export function StoresPanel() {
  const t = useTranslations('Settings.stores');
  const tc = useTranslations('Settings.channels');
  const canEditSettings = useCan('edit-settings');

  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [draft, setDraft] = useState<StoreDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<StoreRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stores', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastLoadFailed'));
        return;
      }
      setStores((data.stores as StoreRow[]) ?? []);
    } catch {
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditing({});
  };

  const openEdit = (s: StoreRow) => {
    setDraft({
      name: s.name,
      address: s.address ?? '',
      phone: s.phone ?? '',
      hours: hoursToText(s.business_hours),
      manager_name: s.manager_name ?? '',
    });
    setEditing({ id: s.id });
  };

  const save = async () => {
    if (!editing) return;
    const problem = validateDraft(draft);
    if (problem) {
      toast.error(
        problem === 'nameRequired'
          ? t('toastNameRequired')
          : problem === 'nameTooLong'
            ? t('toastNameTooLong', { max: STORE_LIMITS.name })
            : t('toastFieldTooLong')
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        editing.id ? `/api/stores/${editing.id}` : '/api/stores',
        {
          method: editing.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.name,
            address: draft.address,
            phone: draft.phone,
            manager_name: draft.manager_name,
            business_hours: textToHours(draft.hours),
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastSaveFailed'));
        return;
      }
      toast.success(editing.id ? t('toastUpdated') : t('toastCreated'));
      setEditing(null);
      await load();
    } catch {
      toast.error(t('toastSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/stores/${toDelete.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          data.code === 'has_connections'
            ? t('deleteBlocked')
            : (data.error ?? t('toastDeleteFailed'))
        );
        return;
      }
      toast.success(t('toastDeleted'));
      setToDelete(null);
      await load();
    } catch {
      toast.error(t('toastDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  const channelLabel = (type: string) =>
    (CHANNEL_TYPES as readonly string[]).includes(type)
      ? tc(`type.${type as (typeof CHANNEL_TYPES)[number]}`)
      : type;

  return (
    <section className="animate-in fade-in-50 max-w-3xl space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canEditSettings ? (
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t('newButton')}
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : stores.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <Store className="text-muted-foreground size-6" />
          <p className="text-foreground text-sm font-medium">
            {t('listTitle')}
          </p>
          <p className="text-muted-foreground max-w-[46ch] text-sm">
            {t('empty')}
          </p>
          {!canEditSettings ? (
            <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
          ) : null}
        </Card>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {stores.map((s) => {
              const hasConnections = s.connections.length > 0;
              return (
                <li
                  key={s.id}
                  className="border-border bg-card flex items-start gap-3 rounded-lg border p-3"
                >
                  <Store className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {s.name}
                    </p>
                    {s.address || s.phone ? (
                      <p className="text-muted-foreground truncate text-xs">
                        {[s.address, s.phone].filter(Boolean).join(' · ')}
                      </p>
                    ) : null}
                    {hasConnections ? (
                      <ul className="flex flex-wrap gap-1.5 pt-1">
                        {s.connections.map((c) => {
                          const state = connectionChipState(c);
                          return (
                            <li
                              key={c.id}
                              className={`rounded-full px-2 py-0.5 text-xs ${CHIP_TONE[state]}`}
                            >
                              {c.display_name || channelLabel(c.channel_type)}
                              {' · '}
                              {tc(`status.${state}`)}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        {t('noConnections')}
                      </p>
                    )}
                    {canEditSettings && hasConnections ? (
                      <p className="text-muted-foreground text-xs">
                        {t('deleteDisabledHint')}
                      </p>
                    ) : null}
                  </div>
                  {canEditSettings ? (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('edit')}
                        onClick={() => openEdit(s)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <span
                        title={
                          hasConnections ? t('deleteDisabledHint') : undefined
                        }
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('delete')}
                          disabled={hasConnections}
                          onClick={() => setToDelete(s)}
                          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!canEditSettings ? (
            <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
          ) : null}
        </>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing?.id ? t('editTitle') : t('newTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="store-name">{t('nameLabel')}</Label>
              <Input
                id="store-name"
                value={draft.name}
                maxLength={STORE_LIMITS.name}
                placeholder={t('namePlaceholder')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="store-address">{t('addressLabel')}</Label>
              <Input
                id="store-address"
                value={draft.address}
                maxLength={STORE_LIMITS.address}
                onChange={(e) =>
                  setDraft({ ...draft, address: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="store-phone">{t('phoneLabel')}</Label>
              <Input
                id="store-phone"
                value={draft.phone}
                maxLength={STORE_LIMITS.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="store-hours">{t('hoursLabel')}</Label>
              <Input
                id="store-hours"
                value={draft.hours}
                placeholder={t('hoursPlaceholder')}
                onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="store-manager">{t('managerLabel')}</Label>
              <Input
                id="store-manager"
                value={draft.manager_name}
                maxLength={STORE_LIMITS.manager_name}
                onChange={(e) =>
                  setDraft({ ...draft, manager_name: e.target.value })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteConfirm', { name: toDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setToDelete(null)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
