import type { ChannelConnection, ConnectionCredentials } from './connections';

/**
 * Provider contract: everything a messaging channel must implement so the CRM
 * core stays independent of the channel (design.md section 5, ADR-002).
 *
 * This file is TYPES (plus ChannelError) only. It must stay channel-neutral:
 * do NOT import from `lib/whatsapp` or any provider module here.
 */

/** A connection row as read by `connections.ts` (single source of the shape). */
export type Connection = ChannelConnection;

/** Discriminator stored in `channel_connections.channel_type`. */
export type ChannelType = 'whatsapp_cloud' | 'telegram';

export type MediaKind = 'image' | 'video' | 'document' | 'audio';

/**
 * Minimal structural validator (zod-compatible: a zod schema satisfies it)
 * so the contract does not force a validation library on every provider.
 */
export interface Schema<T = unknown> {
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * What a channel can do. The core and the UI consult these flags instead of
 * branching on `channel_type`, so a new channel needs no core changes.
 */
export interface Capabilities {
  /** Approved message templates exist (WhatsApp); hides the template picker otherwise. */
  templates: boolean;
  /** Reply buttons can be sent; otherwise the composer hides them. */
  interactiveButtons: boolean;
  /** Tap-to-expand list messages can be sent. */
  interactiveList: boolean;
  /** Emoji reactions to a message are supported. */
  reactions: boolean;
  /** The channel can show "typing..." to the contact. */
  typingIndicator: boolean;
  /** The channel reports delivery ("delivered") receipts. */
  deliveryStatus: boolean;
  /** The channel reports read receipts. */
  readStatus: boolean;
  /**
   * How a conversation may be started by us: 'template' (only via an approved
   * template, WhatsApp), 'after_inbound' (only after the contact wrote first,
   * Telegram) or 'free' (any time).
   */
  initiate: 'template' | 'after_inbound' | 'free';
  /** Hours we may reply free-form after the last inbound (WhatsApp 24 h); null = no window. */
  replyWindowHours: number | null;
  /** Media kinds accepted on send; drives the attachment picker. */
  mediaKinds: MediaKind[];
  /** Upload size cap in bytes, checked before calling the provider. */
  maxMediaBytes: number;
  /** Max caption/text length attached to media. */
  captionMaxLength: number;
}

export type ChannelErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'recipient_unreachable'
  | 'unsupported'
  | 'window_closed'
  | 'invalid'
  | 'unknown';

/** Serializable error info carried by status events and stored as `last_error`. */
export interface ChannelErrorInfo {
  code: ChannelErrorCode;
  message: string;
  providerCode?: string | number;
  /** Provider's short title for the failure (Meta `errors[0].title`), when it has one. */
  title?: string;
  /** Provider's longer detail (Meta `errors[0].error_data.details`), when it has one. */
  details?: string | null;
}

/** Typed failure every provider throws, so the core can map it to HTTP/retry decisions. */
export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  /** Raw provider code (Meta error code, Telegram error_code) for diagnostics. */
  readonly providerCode?: string | number;
  /** Whether retrying the same call later may succeed (rate limit, transient). */
  readonly retryable: boolean;

  constructor(
    code: ChannelErrorCode,
    message: string,
    options: {
      providerCode?: string | number;
      retryable?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.name = 'ChannelError';
    this.code = code;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? code === 'rate_limited';
  }

  toInfo(): ChannelErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.providerCode !== undefined && {
        providerCode: this.providerCode,
      }),
    };
  }
}

/** Stable machine code of `ConnectionDisabledError` (HTTP 409 on the routes). */
export const CONNECTION_DISABLED_CODE = 'connection_disabled';

/**
 * The send was refused because the connection is disabled (`disabled_at` set,
 * US-078). Category `unsupported`; thrown BEFORE the provider is called and
 * before anything is persisted. `reason` is the stable code callers key on.
 */
export class ConnectionDisabledError extends ChannelError {
  readonly reason = CONNECTION_DISABLED_CODE;
  constructor() {
    super(
      'unsupported',
      'This connection is disabled. Enable it in Settings to send messages.'
    );
    this.name = 'ConnectionDisabledError';
  }
}

/**
 * The media was located but could not be fetched (over the size limit, or the
 * transfer failed). Unlike a failed lookup, the id is still valid, so a caller
 * may keep a fallback link to it instead of dropping the media.
 */
export class MediaTransferError extends ChannelError {}

/** A contact identity as stored in `contact_identities`. */
export interface ContactIdentity {
  /** e.g. 'whatsapp:phone', 'whatsapp:bsuid', 'telegram:chat_id'. */
  kind: string;
  externalId: string;
  handle?: string | null;
}

/** An identity extracted from an inbound event, before the contact is resolved. */
export type IdentityCandidate = ContactIdentity;

/** Where to deliver an outbound message, resolved from a contact's identities. */
export interface Target {
  /** Identity kind the target was derived from. */
  kind: string;
  /** Provider address (phone, BSUID, chat id). */
  address: string;
}

/** Reference to a message on the provider side. */
export interface MessageRef {
  externalId: string;
}

/** Reference to downloadable inbound media. */
export interface MediaRef {
  kind: MediaKind;
  /** Provider file/media id. */
  id: string;
  mimeType?: string;
  fileName?: string;
}

/** Channel-neutral interactive payload (buttons or list). */
export type InteractivePayload =
  | {
      kind: 'buttons';
      body: string;
      header?: string;
      footer?: string;
      buttons: { id: string; title: string }[];
    }
  | {
      kind: 'list';
      body: string;
      header?: string;
      footer?: string;
      buttonLabel: string;
      sections: {
        title?: string;
        rows: { id: string; title: string; description?: string }[];
      }[];
    };

export interface TemplateMessage {
  name: string;
  language: string;
  /** Provider-shaped component parameters, passed through untouched. */
  components?: unknown[];
  /**
   * Provider-specific send data the neutral shape cannot carry (WhatsApp:
   * `{ row, messageParams, params }` = the local template row plus send-time
   * values, needed for media headers and URL buttons). Opaque to the core.
   */
  provider?: unknown;
}

/** What the core asks a provider to send. `replyTo` quotes an earlier message. */
export type OutboundMessage = OutboundContentMessage & { replyTo?: MessageRef };

type OutboundContentMessage =
  | { type: 'text'; text: string }
  | {
      type: 'media';
      kind: MediaKind;
      url: string;
      caption?: string;
      fileName?: string;
    }
  | { type: 'template'; template: TemplateMessage }
  | { type: 'interactive'; interactive: InteractivePayload }
  | { type: 'reaction'; target: MessageRef; emoji: string | null };

/**
 * Optional per-call hints for `send`. `credentials` lets a caller that sends
 * many messages on the SAME connection (a broadcast) resolve them once and
 * hand them to every call, instead of one lookup + decrypt per message.
 * Scope it to one delivery run; never cache it globally.
 */
export interface SendOptions {
  credentials?: ConnectionCredentials;
}

export interface SendResult {
  /** Provider message id (wamid, Telegram message_id), used for status/idempotency. */
  externalId: string;
  /**
   * Set when the provider delivered to a different address than `target.address`
   * (WhatsApp phone-variant retry), so the core can persist the working one.
   */
  resolvedAddress?: string;
}

/** Content of an inbound message, normalized across channels. */
export type InboundContent =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: MediaKind; media: MediaRef; caption?: string }
  | { type: 'interactive_reply'; id: string; title: string }
  | {
      type: 'location';
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
      /** Ready-to-store text ("name - address - lat,lng"), as the inbox shows it. */
      text: string;
    }
  | {
      type: 'unsupported';
      description?: string;
      /**
       * How the current webhook persists this degenerate message, when it is
       * NOT as a text row carrying `description` (media without an id keeps
       * its media type and a null text; an interactive reply without an
       * option stays 'interactive'). Additive; absent = text + description.
       */
      stored?: { contentType: string; text: string | null };
    };

export type InboundEvent =
  | {
      kind: 'message';
      externalId: string;
      sender: IdentityCandidate[];
      at: Date;
      content: InboundContent;
      replyToExternalId?: string;
      senderName?: string;
      /**
       * Placeholder for `last_message_text` when the message has no text and
       * the provider's own type differs from the stored content type
       * (WhatsApp sticker -> "[sticker]", template button -> "[button]").
       */
      emptyPreview?: string;
      /**
       * Portfolio-level parent id of the sender (WhatsApp parent BSUID).
       * Only used to keep `contacts.wa_parent_user_id` filled until US-070
       * removes that column.
       */
      parentExternalId?: string;
    }
  | {
      kind: 'status';
      externalId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      /** Failure reason; only set when status is 'failed'. */
      error?: ChannelErrorInfo;
      /** When the provider reported the status (Meta `timestamp`), if it says. */
      at?: Date;
      /** Provider address of the recipient (Meta `recipient_id`), if it says. */
      recipient?: string;
    }
  | {
      kind: 'reaction';
      externalId: string;
      sender: IdentityCandidate[];
      /** null = reaction removed. */
      emoji: string | null;
      /** When the reaction was sent, if the provider says. */
      at?: Date;
    }
  | {
      kind: 'connection';
      state: 'connected' | 'degraded' | 'disconnected' | 'needs_action';
      reason?: string;
    };

export interface ConnectResult {
  ok: boolean;
  /** Human-readable reason when not ok, or a hint (e.g. non-HTTPS webhook URL). */
  message?: string;
  /** Values the user must copy elsewhere (e.g. webhook URL, verify token). */
  details?: Record<string, string>;
  /** Mapped failure when not ok, so the caller can persist it as `last_error`. */
  error?: ChannelErrorInfo;
}

/** Transient inputs to `connect`; never persisted by the provider. */
export interface ConnectOptions {
  /** WhatsApp two-step verification PIN (6 digits) for number registration. */
  pin?: string;
}

export interface Health {
  state: 'connected' | 'degraded' | 'disconnected' | 'needs_action';
  reason?: string;
  checkedAt: Date;
}

/** One input of the generic connection form (never carries a value). */
export interface DescriptorField {
  name: string;
  /** Where the value goes: `config` (non-secret) or `credentials` (secret). */
  target: 'config' | 'credentials';
  type: 'text' | 'secret' | 'select' | 'switch';
  required?: boolean;
  /** `select` only: the allowed values (labels come from i18n). */
  options?: string[];
  /** `text` and `secret`: a regular expression the value must match. */
  pattern?: string;
}

/**
 * What the UI needs to render the connect form. `panel: 'custom'` means the
 * provider has its own panel and `fields` may be empty.
 */
export interface ProviderDescriptor {
  panel?: 'form' | 'custom';
  fields: DescriptorField[];
}

export interface ChannelProvider {
  readonly type: ChannelType;
  /** Form descriptor for GET /api/channels/providers; absent = generic form, no fields. */
  readonly descriptor?: ProviderDescriptor;
  /**
   * Optional: the provider-side id of the connection (Telegram: bot id via
   * getMe) when it is not in the config. Called by POST /api/channels/connections
   * when `external_id` is not sent. Throws ChannelError (`auth` = bad credentials).
   */
  deriveExternalId?(
    config: Record<string, unknown>,
    credentials: Record<string, unknown>
  ): Promise<string>;
  /** Identity kinds this channel produces, e.g. ['whatsapp:phone', 'whatsapp:bsuid']. */
  readonly identityKinds: string[];
  readonly capabilities: Capabilities;

  /** Validates `connection.config` (non-secret settings). */
  readonly configSchema: Schema;
  /** Validates the credentials payload (secrets; never returned to clients). */
  readonly credentialsSchema: Schema;

  // lifecycle
  /** Registers with the provider (setWebhook, number registration). */
  connect(conn: Connection, opts?: ConnectOptions): Promise<ConnectResult>;
  disconnect(conn: Connection): Promise<void>;
  /** Live check, also used by the health cron. */
  health(conn: Connection): Promise<Health>;

  // inbound
  /** Finds the connection an incoming request belongs to (null = unknown). */
  resolveConnection(req: Request): Promise<Connection | null>;
  /** Authenticates the request (HMAC, secret token). */
  verify(req: Request, conn: Connection): Promise<boolean>;
  parse(req: Request, conn: Connection): Promise<InboundEvent[]>;
  downloadMedia?(conn: Connection, ref: MediaRef): Promise<Blob>;
  /**
   * Optional, best-effort: acknowledges an interaction the user made (Telegram
   * answerCallbackQuery clears the button-tap spinner). Called by the generic
   * webhook route after parse; failures are swallowed by the caller.
   */
  acknowledgeInteraction?(conn: Connection, event: InboundEvent): Promise<void>;

  // outbound
  /** Picks the address to deliver to from a contact's identities; null = unreachable here. */
  resolveTarget(identities: ContactIdentity[]): Target | null;
  send(
    conn: Connection,
    target: Target,
    msg: OutboundMessage,
    opts?: SendOptions
  ): Promise<SendResult>;
  react?(
    conn: Connection,
    target: Target,
    ref: MessageRef,
    emoji: string
  ): Promise<void>;
  /**
   * Shows "typing..." to the contact. `inboundExternalId` is the provider id of
   * the inbound message being answered (WhatsApp wamid); channels that need it
   * throw `invalid` when it is missing.
   */
  typing?(
    conn: Connection,
    target: Target,
    opts?: { inboundExternalId?: string }
  ): Promise<void>;
}
