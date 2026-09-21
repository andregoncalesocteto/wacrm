'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import {
  CONTACT_IDENTITIES_EMBED,
  withIdentities,
} from '@/lib/contacts/display-name';
import { useContactDisplay } from '@/hooks/use-contact-display';
import type { Contact } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface MergeContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The contact being viewed: it survives, the picked one is merged into it. */
  survivor: Contact;
  onMerged: () => void;
}

interface Summary {
  conversations: number;
  deals: number;
  notes: number;
  tags: number;
  identities: number;
}

const SEARCH_LIMIT = 8;

export function MergeContactDialog({
  open,
  onOpenChange,
  survivor,
  onMerged,
}: MergeContactDialogProps) {
  const t = useTranslations('Contacts.detailView.mergeDialog');
  const display = useContactDisplay();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Contact | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (open) {
      setTerm('');
      setResults([]);
      setPicked(null);
      setSummary(null);
    }
  }, [open]);

  // Debounced search (the RPC also matches channel handles / external ids).
  useEffect(() => {
    if (!open || picked) return;
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc('filter_contacts_by_tags', {
        p_tag_ids: [],
        p_search: term.trim() || null,
        p_limit: SEARCH_LIMIT + 1,
        p_offset: 0,
      });
      if (cancelled) return;
      const rows = ((data ?? []) as { contact: Contact }[])
        .map((r) => r.contact)
        .filter((c) => c.id !== survivor.id)
        .slice(0, SEARCH_LIMIT);
      // The RPC does not embed identities: fetch them for the shown rows.
      let hydrated = rows;
      if (rows.length > 0) {
        const { data: withIds } = await supabase
          .from('contacts')
          .select(`*, ${CONTACT_IDENTITIES_EMBED}`)
          .in(
            'id',
            rows.map((r) => r.id)
          );
        if (cancelled) return;
        const byId = new Map(
          (withIds ?? []).map((c) => [c.id as string, withIdentities(c)])
        );
        hydrated = rows.map((r) => (byId.get(r.id) as Contact) ?? r);
      }
      setResults(hydrated);
      setSearching(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, picked, term, survivor.id]);

  async function pick(contact: Contact) {
    setPicked(contact);
    setSummary(null);
    const supabase = createClient();
    const count = (table: string) =>
      supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contact.id);
    const [conv, deals, notes, tags, ids] = await Promise.all([
      count('conversations'),
      count('deals'),
      count('contact_notes'),
      count('contact_tags'),
      count('contact_identities'),
    ]);
    if ([conv, deals, notes, tags, ids].some((r) => r.error)) {
      toast.error(t('loadFailed'));
      setPicked(null);
      return;
    }
    setSummary({
      conversations: conv.count ?? 0,
      deals: deals.count ?? 0,
      notes: notes.count ?? 0,
      tags: tags.count ?? 0,
      identities: ids.count ?? 0,
    });
  }

  async function confirm() {
    if (!picked) return;
    setMerging(true);
    try {
      const res = await fetch('/api/contacts/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          survivor_id: survivor.id,
          duplicate_id: picked.id,
        }),
      });
      if (!res.ok) {
        toast.error(t('failed'));
        return;
      }
      toast.success(t('success'));
      onOpenChange(false);
      onMerged();
    } catch {
      toast.error(t('failed'));
    } finally {
      setMerging(false);
    }
  }

  const survivorName = display.name(survivor);
  const otherName = picked ? display.name(picked) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('desc', { name: survivorName })}
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <div className="space-y-2">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-2 left-2.5 size-4" />
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder={t('search')}
                aria-label={t('search')}
                className="pl-8"
                autoFocus
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {searching ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="text-primary size-4 animate-spin" />
                </div>
              ) : results.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  {t('noResults')}
                </p>
              ) : (
                results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => pick(c)}
                    className="hover:bg-muted flex w-full flex-col rounded-md px-2 py-1.5 text-left"
                  >
                    <span className="text-sm font-medium">
                      {display.name(c)}
                    </span>
                    {display.secondary(c) && (
                      <span className="text-muted-foreground text-xs">
                        {display.secondary(c)}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p>{t('willMove', { other: otherName, name: survivorName })}</p>
            {summary ? (
              <ul className="list-disc space-y-0.5 pl-5">
                <li>{t('conversations', { count: summary.conversations })}</li>
                <li>{t('deals', { count: summary.deals })}</li>
                <li>{t('notes', { count: summary.notes })}</li>
                <li>{t('tags', { count: summary.tags })}</li>
                <li>{t('identities', { count: summary.identities })}</li>
              </ul>
            ) : (
              <Loader2 className="text-primary size-4 animate-spin" />
            )}
            <p className="text-muted-foreground text-xs">
              {t('warning', { other: otherName })}
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPicked(null)}
                disabled={merging}
              >
                {t('back')}
              </Button>
              <Button onClick={confirm} disabled={!summary || merging}>
                {merging && <Loader2 className="size-4 animate-spin" />}
                {merging ? t('merging') : t('confirm')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
