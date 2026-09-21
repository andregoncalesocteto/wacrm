import { sendOutbound } from '@/lib/channels/send';
import type { OutboundMessage } from '@/lib/channels/types';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import { supabaseAdmin } from './admin-client';

// ------------------------------------------------------------
// Automation-side senders (US-028). Thin adapters over the single outbound
// path (`sendOutbound`, actor `automation`): the engine keeps its per-step
// call shape and `{ whatsapp_message_id }` return, while recipient
// resolution, phone-variant retry, persistence and the conversation preview
// live in the core. A failed provider send persists NOTHING and throws, so
// the engine ends the step (and the run) as failed.
//
// Runs with the service-role client (no user session); every query in the
// core is scoped by `accountId`.
// ------------------------------------------------------------

interface BaseArgs {
  accountId: string;
  /** Original automation author. Not needed for sending; kept for call-site parity. */
  userId: string;
  conversationId: string;
  contactId: string;
}

async function send(
  args: BaseArgs,
  message: OutboundMessage,
  fallbackPreview?: string
): Promise<{ whatsapp_message_id: string }> {
  const r = await sendOutbound({
    accountId: args.accountId,
    conversationId: args.conversationId,
    message,
    actor: { type: 'automation' },
    fallbackPreview,
    db: supabaseAdmin(),
  });
  return { whatsapp_message_id: r.externalMessageId };
}

export function engineSendText(
  args: BaseArgs & { text: string }
): Promise<{ whatsapp_message_id: string }> {
  return send(args, { type: 'text', text: args.text });
}

export function engineSendTemplate(
  args: BaseArgs & {
    templateName: string;
    language?: string;
    params?: string[];
  }
): Promise<{ whatsapp_message_id: string }> {
  return send(
    args,
    {
      type: 'template',
      template: {
        name: args.templateName,
        // '' = unspecified: the core resolves it from the template row.
        language: args.language ?? '',
        provider: { params: args.params ?? [] },
      },
    },
    // Without a local template row automations preview "[template:name]".
    `[template:${args.templateName}]`
  );
}

export function engineSendInteractive(
  args: BaseArgs & { payload: InteractiveMessagePayload }
): Promise<{ whatsapp_message_id: string }> {
  const { payload } = args;
  if (payload.kind === 'buttons') {
    return send(args, { type: 'interactive', interactive: payload });
  }
  const { button_label, ...rest } = payload;
  return send(args, {
    type: 'interactive',
    interactive: { ...rest, buttonLabel: button_label },
  });
}
