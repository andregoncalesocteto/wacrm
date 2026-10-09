// ============================================================
// Guard tests for the published content (M3, M5 and the link checks).
//
// The OpenAPI file and the manuals are what an external team implements
// against. If they drift from the code, these tests fail the build.
// ============================================================

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import type { Link } from 'mdast';
import yaml from 'js-yaml';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';

import {
  JOURNEY_EVENT_NAMES,
  ORDER_EVENT_STATUSES,
  parseCartProperties,
  parseCommonFields,
  parseOrderStatusProperties,
  parsePurchaseProperties,
} from '@/lib/journeys/event-payload';

import { extractHeadings } from './markdown';
import { resolveManualHref } from './links';
import { MANUALS } from './registry';

const CONTENT = path.join(process.cwd(), 'content');
const read = (...parts: string[]) =>
  readFileSync(path.join(CONTENT, ...parts), 'utf8');

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = yaml.load(read('api', 'openapi.yaml')) as any;
const schemas = spec.components.schemas;
/** The second `allOf` member of an event schema holds its own fields. */
const own = (name: string) => schemas[name].allOf[1].properties;
const ok = (fn: () => unknown) => expect(fn).not.toThrow();
const bad = (fn: () => unknown) => expect(fn).toThrow();

describe('openapi.yaml parity with event-payload.ts (M3)', () => {
  it('lists exactly the event names the code accepts', () => {
    const documented = [
      ...own('ViewContentEvent').name.enum,
      ...own('CartEvent').name.enum,
      ...own('PurchaseEvent').name.enum,
      ...own('OrderStatusChangedEvent').name.enum,
    ];
    expect([...documented].sort()).toEqual([...JOURNEY_EVENT_NAMES].sort());
  });

  it('lists exactly the order statuses the code accepts', () => {
    const documented = own('OrderStatusChangedEvent').properties.properties
      .status.enum;
    expect([...documented].sort()).toEqual([...ORDER_EVENT_STATUSES].sort());
  });

  const item = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      quantity: 1,
      unit_price: 1,
    }));
  const cart = (items: unknown[]) => ({
    properties: { currency: 'BRL', cart: { value: 1, items } },
  });
  const purchase = (over: Record<string, unknown> = {}) => ({
    properties: {
      order_id: 'o1',
      currency: 'BRL',
      value: 1,
      items: item(1),
      ...over,
    },
  });
  const common = (over: Record<string, unknown> = {}) => ({
    event_id: 'e1',
    name: 'ViewContent',
    idtrack: 'trk',
    occurred_at: '2026-10-02T21:14:05Z',
    ...over,
  });

  it('documents the cart limits the parser enforces (1 to 200 items, quantity >= 1, prices >= 0)', () => {
    const items = schemas.Cart.properties.items;
    expect([items.minItems, items.maxItems]).toEqual([1, 200]);
    ok(() => parseCartProperties(cart(item(200))));
    bad(() => parseCartProperties(cart(item(201))));
    bad(() => parseCartProperties(cart([])));

    expect(schemas.CartItem.properties.quantity).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    bad(() =>
      parseCartProperties(cart([{ id: 'a', quantity: 0, unit_price: 1 }]))
    );
    bad(() =>
      parseCartProperties(cart([{ id: 'a', quantity: 1.5, unit_price: 1 }]))
    );

    expect(schemas.CartItem.properties.unit_price.minimum).toBe(0);
    expect(schemas.Cart.properties.value.minimum).toBe(0);
    bad(() =>
      parseCartProperties(cart([{ id: 'a', quantity: 1, unit_price: -1 }]))
    );
  });

  it('documents the Purchase items limits', () => {
    const items = own('PurchaseEvent').properties.properties.items;
    expect([items.minItems, items.maxItems]).toEqual([1, 200]);
    ok(() => parsePurchaseProperties(purchase({ items: item(200) })));
    bad(() => parsePurchaseProperties(purchase({ items: item(201) })));
    expect(own('PurchaseEvent').properties.properties.value.minimum).toBe(0);
    bad(() => parsePurchaseProperties(purchase({ value: -1 })));
  });

  it('documents the 200-character limits (event_id, order_id, store_key, customer.name)', () => {
    const base = schemas.EventBase.properties;
    expect(base.event_id.maxLength).toBe(200);
    expect(base.store_key.maxLength).toBe(200);
    expect(schemas.Customer.properties.name.maxLength).toBe(200);
    expect(own('PurchaseEvent').properties.properties.order_id.maxLength).toBe(
      200
    );
    expect(
      own('OrderStatusChangedEvent').properties.properties.order_id.maxLength
    ).toBe(200);

    ok(() => parseCommonFields(common({ event_id: 'x'.repeat(200) })));
    bad(() => parseCommonFields(common({ event_id: 'x'.repeat(201) })));
    ok(() => parseCommonFields(common({ store_key: 'x'.repeat(200) })));
    bad(() => parseCommonFields(common({ store_key: 'x'.repeat(201) })));
    ok(() =>
      parseCommonFields(common({ customer: { name: 'x'.repeat(200) } }))
    );
    bad(() =>
      parseCommonFields(common({ customer: { name: 'x'.repeat(201) } }))
    );
    ok(() => parsePurchaseProperties(purchase({ order_id: 'x'.repeat(200) })));
    bad(() => parsePurchaseProperties(purchase({ order_id: 'x'.repeat(201) })));
    bad(() =>
      parseOrderStatusProperties({
        properties: { order_id: 'x'.repeat(201), status: 'received' },
      })
    );
  });

  it('documents the same phone pattern the parser enforces', () => {
    const pattern = new RegExp(schemas.Customer.properties.phone.pattern);
    for (const phone of [
      '+5511999998888',
      '+14155550123',
      '5511999998888',
      '+0123456',
      '+55 11 99999 8888',
      '+123456',
      '+1234567890123456',
    ]) {
      const accepted = (() => {
        try {
          parseCommonFields(
            common({ store_key: '1/A/B', customer: { phone } })
          );
          return true;
        } catch {
          return false;
        }
      })();
      expect(pattern.test(phone), phone).toBe(accepted);
    }
  });

  it('documents the 3-letter currency the parser enforces', () => {
    const pattern = new RegExp(
      own('PurchaseEvent').properties.properties.currency.pattern
    );
    for (const currency of ['BRL', 'brl', 'BR', 'BRLL', 'B1L']) {
      const accepted = (() => {
        try {
          parsePurchaseProperties(purchase({ currency }));
          return true;
        } catch {
          return false;
        }
      })();
      expect(pattern.test(currency), currency).toBe(accepted);
    }
  });
});

describe('no secret in the published content (M5)', () => {
  const KEY = /wacrm_live_[A-Za-z0-9]{20,}/;

  function* files(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* files(full);
      else yield full;
    }
  }

  it('has no API-key-shaped value in any file under content/', () => {
    const all = [...files(CONTENT)];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const file of all) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(KEY);
    }
  });
});

describe('every manual in the registry', () => {
  const parser = unified().use(remarkParse).use(remarkGfm);

  it.each(MANUALS.map((m) => [m.slug, m] as const))(
    '%s has its file in content/manuals/pt/',
    (_slug, meta) => {
      expect(existsSync(path.join(CONTENT, 'manuals', 'pt', meta.file))).toBe(
        true
      );
    }
  );

  it.each(MANUALS.map((m) => [m.slug, m] as const))(
    '%s has only links that resolve',
    (_slug, meta) => {
      const markdown = read('manuals', 'pt', meta.file);
      const ids = new Set(extractHeadings(markdown).map((h) => h.id));
      const links: string[] = [];
      visit(parser.parse(markdown), 'link', (node: Link) => {
        links.push(node.url);
      });
      expect(links.length).toBeGreaterThan(0);
      for (const href of links) {
        const resolved = resolveManualHref(href, {
          visibility: meta.visibility,
        });
        expect(resolved, `${meta.slug}: ${href}`).not.toBeNull();
        if (href.startsWith('#')) {
          expect(ids.has(href.slice(1)), `${meta.slug}: ${href}`).toBe(true);
        }
      }
    }
  );
});
