// ============================================================
// Write tools — registered only when WACRM_ENABLE_WRITES is set.
//
// These change data or send a message. They are gated so a
// read-only deployment never exposes them to the model at all. (The
// API key's scopes are still enforced server-side; a call without the
// right scope returns a clean `forbidden` error.)
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { handle, jsonResult } from './shared.js';

const templateSchema = z
  .object({
    name: z.string().describe('Meta-approved template name.'),
    language: z.string().describe('Template language code, e.g. "en_US".'),
    params: z
      .array(z.string())
      .optional()
      .describe('Positional body variables, in order.'),
  })
  .describe('Template payload — required when type is "template".');

export function registerWriteTools(server: McpServer, client: WacrmClient): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Send a message. Address it with conversation_id (reply in an existing conversation) OR with to (+ optional connection_id); never both. With to, WhatsApp takes an E.164 number (contact and conversation are found-or-created); other channels take their own address (e.g. a Telegram chat id that already wrote to the bot). connection_id (see list_connections) may be omitted only when the account has exactly one enabled connection. Use type "text" for free-form text (on WhatsApp only inside the 24-hour window), or "template" for an approved WhatsApp template. Media types need a media_url. The response has external_message_id, connection_id and channel. This sends a real message to a real person — confirm the recipient and content with the user before calling.',
      inputSchema: {
        conversation_id: z
          .string()
          .optional()
          .describe('Existing conversation to reply in. Mutually exclusive with to / connection_id.'),
        connection_id: z
          .string()
          .optional()
          .describe('Channel connection to send through (from list_connections). Used with to.'),
        to: z
          .string()
          .optional()
          .describe(
            'Recipient address: E.164 phone (e.g. +14155550123) for WhatsApp, or the channel address for other channels.',
          ),
        type: z
          .enum(['text', 'template', 'image', 'video', 'document', 'audio'])
          .default('text')
          .describe('Message type. Defaults to "text".'),
        text: z
          .string()
          .optional()
          .describe('Message body for "text", or the caption for a media type.'),
        media_url: z
          .string()
          .url()
          .optional()
          .describe('Publicly reachable URL of the media file (required for media types).'),
        filename: z.string().optional().describe('File name for a "document" send.'),
        template: templateSchema.optional(),
        reply_to_message_id: z
          .string()
          .optional()
          .describe('Optional id of a message in the same conversation to reply to.'),
      },
      annotations: { title: 'Send message', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.sendMessage(args))),
  );

  server.registerTool(
    'create_contact',
    {
      title: 'Create contact',
      description:
        'Create a contact from a phone number (E.164, WhatsApp shortcut) and/or channel identities; at least one is required. Find-or-create: a contact matching ANY given identity or phone is returned unchanged (name/email/company are applied only to a new contact). Optional: name, email, company, and tags (tag names, created if missing).',
      inputSchema: {
        phone: z.string().optional().describe('Phone number in E.164 format, e.g. +14155550123.'),
        identities: z
          .array(
            z.object({
              kind: z.string().describe('Identity kind, e.g. "whatsapp:phone" or "telegram:chat".'),
              external_id: z.string().describe('The address in that channel.'),
              handle: z.string().optional().describe('Optional display handle.'),
            }),
          )
          .optional()
          .describe('Channel identities of the contact.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Tag names; created if they do not exist.'),
      },
      annotations: { title: 'Create contact', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createContact(args))),
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description:
        'Update an existing contact. Only the fields you pass are changed. Pass tags (an array of tag names) to replace the contact’s tags entirely.',
      inputSchema: {
        id: z.string().describe('Contact id.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Replaces the contact’s tags.'),
      },
      annotations: { title: 'Update contact', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateContact(id, body))),
  );
}
