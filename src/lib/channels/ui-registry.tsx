import type { ComponentType } from 'react';
import { MessageCircle, Send, type LucideIcon } from 'lucide-react';

import type { DescriptorField } from './types';
import type { ChannelConnectionRow } from './ui';
import { telegramDescriptor } from './providers/telegram/descriptor';
import { WhatsAppConnectionPanel } from './providers/whatsapp-cloud/ui/whatsapp-connection-panel';

/**
 * The ONLY place the settings UI names channels. A channel_type maps to
 * either a provider-owned panel or a generic form descriptor (simple
 * providers: a list of fields, no custom code). The screens look entries up
 * by `channel_type` and never import a provider panel themselves.
 */

/** What every provider panel receives. `connection` null = create mode. */
export interface ChannelPanelProps {
  connection: ChannelConnectionRow | null;
  storeId: string;
  /** Called after any write so the list behind the panel can refresh. */
  onChanged: () => void;
  /** Wizard hosting: create only, the host connects + tests (see the panel). */
  onCreated?: (connection: ChannelConnectionRow, opts: { pin: string }) => void;
  /** Wizard hosting: hide the panel's own heading. */
  hideChrome?: boolean;
}

interface EntryBase {
  icon: LucideIcon;
}

export interface PanelEntry extends EntryBase {
  kind: 'panel';
  Panel: ComponentType<ChannelPanelProps>;
}

/** Generic form for simple providers; rendered by `DescriptorForm` from the providers endpoint descriptor. */
export interface FormEntry extends EntryBase {
  kind: 'form';
  fields: DescriptorField[];
  /** Public docs page the connect step links to (optional). */
  docsUrl?: string;
}

export type ChannelUiEntry = PanelEntry | FormEntry;

const REGISTRY: Record<string, ChannelUiEntry> = {
  whatsapp_cloud: {
    kind: 'panel',
    icon: MessageCircle,
    Panel: WhatsAppConnectionPanel,
  },
  telegram: {
    kind: 'form',
    icon: Send,
    fields: telegramDescriptor.fields,
    docsUrl:
      'https://github.com/andregoncalesocteto/wacrm/blob/main/docs/telegram.md',
  },
};

export function getChannelUi(channelType: string): ChannelUiEntry | null {
  return REGISTRY[channelType] ?? null;
}

/** Channel types whose panel can be opened (create or edit) today. */
export function configurableChannelTypes(): string[] {
  return Object.entries(REGISTRY)
    .filter(([, e]) => e.kind === 'panel')
    .map(([type]) => type);
}
