import { describe, it, expect } from "vitest";
import {
  deriveScopeOptions,
  matchesContactFilters,
  matchesConversationScope,
  normalizeConversation,
  NO_SCOPE_FILTERS,
} from "./conversations";
import type { Conversation, ConversationConnection } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

const conn = (
  id: string,
  storeId: string,
  channelType = 'whatsapp_cloud'
): ConversationConnection => ({
  id,
  channel_type: channelType,
  display_name: `Conn ${id}`,
  status: 'connected',
  disabled_at: null,
  store_id: storeId,
  store: { id: storeId, name: `Store ${storeId}` },
});

describe('normalizeConversation connection embed', () => {
  const base = {
    id: 'c1',
    user_id: 'u1',
    contact_id: 'ct1',
    status: 'open' as const,
    unread_count: 0,
    created_at: '',
    updated_at: '',
  };

  it('keeps the embedded connection and its store', () => {
    const n = normalizeConversation({
      ...base,
      contact: null,
      connection: conn('k1', 's1'),
    });
    expect(n.connection?.store?.name).toBe('Store s1');
    expect(n.connection?.channel_type).toBe('whatsapp_cloud');
  });

  it('is tolerant of a missing embed (stays undefined)', () => {
    expect(normalizeConversation(base).connection).toBeUndefined();
    const withContact = normalizeConversation({
      ...base,
      contact: {
        id: 'ct1',
        user_id: 'u1',
        account_id: 'a1',
        phone: '1',
        created_at: '',
        updated_at: '',
        contact_tags: [],
      },
    });
    expect(withContact.connection).toBeUndefined();
    expect(withContact.contact?.tags).toEqual([]);
  });

  it('maps a null connection to null and unwraps array embeds', () => {
    expect(
      normalizeConversation({ ...base, connection: null }).connection
    ).toBeNull();
    const arr = normalizeConversation({
      ...base,
      connection: [
        { ...conn('k1', 's1'), store: [{ id: 's1', name: 'A' }] },
      ] as unknown as ConversationConnection,
    });
    expect(arr.connection?.id).toBe('k1');
    expect(arr.connection?.store).toEqual({ id: 's1', name: 'A' });
  });

  it('normalizes connection when the contact is also present', () => {
    const n = normalizeConversation({
      ...base,
      connection: conn('k1', 's1'),
      contact: {
        id: 'ct1',
        user_id: 'u1',
        account_id: 'a1',
        phone: '1',
        created_at: '',
        updated_at: '',
        contact_tags: [{ tags: tag('t1') }],
      },
    });
    expect(n.connection?.id).toBe('k1');
    expect(n.contact?.tags).toEqual([tag('t1')]);
  });
});

describe('matchesConversationScope', () => {
  const conv = (c?: ConversationConnection | null) => ({
    ...makeConversation(null),
    connection: c,
  });
  const f = (o: Partial<typeof NO_SCOPE_FILTERS>) => ({
    ...NO_SCOPE_FILTERS,
    ...o,
  });

  it('matches everything with no dimension set', () => {
    expect(
      matchesConversationScope(conv(conn('k1', 's1')), NO_SCOPE_FILTERS)
    ).toBe(true);
    expect(matchesConversationScope(conv(undefined), NO_SCOPE_FILTERS)).toBe(
      true
    );
    expect(matchesConversationScope(conv(null), NO_SCOPE_FILTERS)).toBe(true);
  });

  it('filters by store', () => {
    const c = conv(conn('k1', 's1'));
    expect(matchesConversationScope(c, f({ storeId: 's1' }))).toBe(true);
    expect(matchesConversationScope(c, f({ storeId: 's2' }))).toBe(false);
  });

  it('filters by connection (falls back to connection_id)', () => {
    const c = conv(conn('k1', 's1'));
    expect(matchesConversationScope(c, f({ connectionId: 'k1' }))).toBe(true);
    expect(matchesConversationScope(c, f({ connectionId: 'k2' }))).toBe(false);
    const bare = { ...conv(undefined), connection_id: 'k9' };
    expect(matchesConversationScope(bare, f({ connectionId: 'k9' }))).toBe(
      true
    );
  });

  it('filters by channel', () => {
    const c = conv(conn('k1', 's1', 'telegram'));
    expect(matchesConversationScope(c, f({ channelType: 'telegram' }))).toBe(
      true
    );
    expect(
      matchesConversationScope(c, f({ channelType: 'whatsapp_cloud' }))
    ).toBe(false);
  });

  it('combines dimensions with AND and excludes rows without a connection', () => {
    const c = conv(conn('k1', 's1', 'telegram'));
    expect(
      matchesConversationScope(c, {
        storeId: 's1',
        connectionId: 'k1',
        channelType: 'telegram',
      })
    ).toBe(true);
    expect(
      matchesConversationScope(c, {
        storeId: 's1',
        connectionId: 'k1',
        channelType: 'whatsapp_cloud',
      })
    ).toBe(false);
    expect(
      matchesConversationScope(conv(undefined), f({ storeId: 's1' }))
    ).toBe(false);
  });
});

describe('deriveScopeOptions', () => {
  it('lists distinct stores, connections and channels, sorted', () => {
    const mk = (c?: ConversationConnection | null) => ({
      ...makeConversation(null),
      connection: c,
    });
    const o = deriveScopeOptions([
      mk(conn('k2', 's2', 'telegram')),
      mk(conn('k1', 's1')),
      mk(conn('k1', 's1')),
      mk(null),
      mk(undefined),
    ]);
    expect(o.stores.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(o.connections.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(o.channelTypes).toEqual(['telegram', 'whatsapp_cloud']);
  });

  it('is empty without connections', () => {
    expect(deriveScopeOptions([])).toEqual({
      stores: [],
      connections: [],
      channelTypes: [],
    });
  });
});
