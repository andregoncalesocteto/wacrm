'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface JourneyFilterOptions {
  channelTypes: string[];
  stores: { id: string; name: string }[];
}

export interface JourneyFilterValue {
  /** `all` or a channel type. */
  channelType: string;
  /** `all` or a store id. */
  storeId: string;
  /** `all`, `crm_link` or `menu_direct`. */
  origin: OriginFilter;
}

export const ALL_FILTER = 'all';
export type OriginFilter = 'all' | 'crm_link' | 'menu_direct';

interface JourneyFiltersProps {
  options: JourneyFilterOptions;
  value: JourneyFilterValue;
  onChange: (value: JourneyFilterValue) => void;
}

/** Channel-type, store and origin filters for the order Journey pipeline. */
export function JourneyFilters({
  options,
  value,
  onChange,
}: JourneyFiltersProps) {
  const t = useTranslations('Pipelines.journey.filters');
  const tType = useTranslations('Settings.channels.type');
  const channelLabel = (type: string) => (tType.has(type) ? tType(type) : type);
  const storeName =
    options.stores.find((s) => s.id === value.storeId)?.name ?? value.storeId;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.channelType}
        onValueChange={(v) => v && onChange({ ...value, channelType: v })}
      >
        <SelectTrigger
          aria-label={t('channel')}
          className="bg-card border-border text-foreground w-48"
        >
          <SelectValue>
            {value.channelType === ALL_FILTER
              ? t('allChannels')
              : channelLabel(value.channelType)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER}>{t('allChannels')}</SelectItem>
          {options.channelTypes.map((type) => (
            <SelectItem key={type} value={type}>
              {channelLabel(type)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={value.storeId}
        onValueChange={(v) => v && onChange({ ...value, storeId: v })}
      >
        <SelectTrigger
          aria-label={t('store')}
          className="bg-card border-border text-foreground w-48"
        >
          <SelectValue>
            {value.storeId === ALL_FILTER ? t('allStores') : storeName}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER}>{t('allStores')}</SelectItem>
          {options.stores.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={value.origin}
        onValueChange={(v) =>
          v && onChange({ ...value, origin: v as OriginFilter })
        }
      >
        <SelectTrigger
          aria-label={t('origin')}
          className="bg-card border-border text-foreground w-48"
        >
          <SelectValue>
            {value.origin === ALL_FILTER
              ? t('allOrigins')
              : t(`originOption.${value.origin}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER}>{t('allOrigins')}</SelectItem>
          <SelectItem value="crm_link">{t('originOption.crm_link')}</SelectItem>
          <SelectItem value="menu_direct">
            {t('originOption.menu_direct')}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
