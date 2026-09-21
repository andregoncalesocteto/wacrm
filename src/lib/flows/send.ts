import { sendOutbound } from '@/lib/channels/send';
import type { InteractivePayload, MediaKind } from '@/lib/channels/types';
import { supabaseAdmin } from './admin-client';

// ------------------------------------------------------------
// Flows-side senders (US-027). Thin adapters over the single outbound
// path (`sendOutbound`, actor `flow`): the engine keeps its per-node
// call shape and `{ whatsapp_message_id }` return, while recipient
// resolution, phone-variant retry, persistence and the conversation
// preview live in the core. A failed provider send persists NOTHING and
// throws, so the runner ends the run with `send_*_failed`.
//
// Runs with the service-role client (no user session); every query in
// the core is scoped by `accountId`.
// ------------------------------------------------------------

interface BaseArgs {
  accountId: string;
  /** Original flow author. Not needed for sending; kept for call-site parity. */
  userId: string;
  conversationId: string;
  contactId: string;
}

async function send(
  args: BaseArgs,
  message: Parameters<typeof sendOutbound>[0]['message']
): Promise<{ whatsapp_message_id: string }> {
  const r = await sendOutbound({
    accountId: args.accountId,
    conversationId: args.conversationId,
    message,
    actor: { type: 'flow' },
    db: supabaseAdmin(),
  });
  return { whatsapp_message_id: r.externalMessageId };
}

export function engineSendText(
  args: BaseArgs & { text: string }
): Promise<{ whatsapp_message_id: string }> {
  return send(args, { type: 'text', text: args.text });
}

export function engineSendMedia(
  args: BaseArgs & {
    kind: MediaKind;
    /** Public URL the provider fetches at send time. */
    link: string;
    caption?: string;
    /** Document-only. */
    filename?: string;
  }
): Promise<{ whatsapp_message_id: string }> {
  return send(args, {
    type: 'media',
    kind: args.kind,
    url: args.link,
    caption: args.caption,
    fileName: args.filename,
  });
}

type ButtonsPayload = Extract<InteractivePayload, { kind: 'buttons' }>;
type ListPayload = Extract<InteractivePayload, { kind: 'list' }>;

export function engineSendInteractiveButtons(
  args: BaseArgs & {
    bodyText: string;
    buttons: ButtonsPayload['buttons'];
    headerText?: string;
    footerText?: string;
  }
): Promise<{ whatsapp_message_id: string }> {
  return send(args, {
    type: 'interactive',
    interactive: {
      kind: 'buttons',
      body: args.bodyText,
      header: args.headerText,
      footer: args.footerText,
      buttons: args.buttons,
    },
  });
}

export function engineSendInteractiveList(
  args: BaseArgs & {
    bodyText: string;
    buttonLabel: string;
    sections: ListPayload['sections'];
    headerText?: string;
    footerText?: string;
  }
): Promise<{ whatsapp_message_id: string }> {
  return send(args, {
    type: 'interactive',
    interactive: {
      kind: 'list',
      body: args.bodyText,
      header: args.headerText,
      footer: args.footerText,
      buttonLabel: args.buttonLabel,
      sections: args.sections,
    },
  });
}
