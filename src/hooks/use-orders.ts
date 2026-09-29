'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { OrderSummaryData } from '@/components/orders/order-list';

/**
 * Orders (RLS-bound: members read) of a contact or of a deal, newest first.
 * Pass exactly one of `contactId` / `dealId`; with neither, nothing is fetched.
 */
export function useOrders({
  contactId,
  dealId,
}: {
  contactId?: string | null;
  dealId?: string | null;
}): OrderSummaryData[] {
  const [orders, setOrders] = useState<OrderSummaryData[]>([]);
  const column = contactId ? 'contact_id' : dealId ? 'deal_id' : null;
  const id = contactId || dealId || null;

  useEffect(() => {
    if (!column || !id) return;
    let cancelled = false;
    createClient()
      .from('orders')
      .select(
        'id, external_order_id, status, value, currency, items, placed_at, status_history'
      )
      .eq(column, id)
      .order('placed_at', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setOrders((data ?? []) as OrderSummaryData[]);
      });
    return () => {
      cancelled = true;
    };
  }, [column, id]);

  // Stale rows of the previous contact/deal never show for the next one.
  return column && id ? orders : [];
}
