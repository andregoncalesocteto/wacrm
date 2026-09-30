import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import pt from '../../../messages/pt.json';
import {
  buildJourneyPreset,
  installJourneyPreset,
  loadJourneyPresetCatalog,
  summarizeJourneyPreset,
  type JourneyPresetCatalog,
} from './journey-preset';
import type { TemplateStepSeed } from './templates';
import { ORDER_TRIGGER_STATUSES } from './trigger-meta';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './validate';

type Row = Record<string, unknown>;

const CATALOGS: Record<string, JourneyPresetCatalog> = {
  en: en.Automations.journeyPreset,
  pt: pt.Automations.journeyPreset,
  es: es.Automations.journeyPreset,
  ko: ko.Automations.journeyPreset,
};

/** Minimal service-role stand-in: insert (row or rows), select/like, delete. */
function fakeDb(tables: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = {
    automations: [],
    automation_steps: [],
    ...tables,
  };
  let seq = 0;
  const client = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'delete' | 'update' = 'select';
      let payload: Row[] = [];
      let error: { code?: string; message: string } | null = null;
      const q = {
        select: () => q,
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          return q;
        },
        like(col: string, pattern: string) {
          const prefix = pattern.replace(/%$/, '');
          filters.push((r) => String(r[col] ?? '').startsWith(prefix));
          return q;
        },
        insert(rows: Row | Row[]) {
          op = 'insert';
          payload = Array.isArray(rows) ? rows : [rows];
          return q;
        },
        delete() {
          op = 'delete';
          return q;
        },
        update(patch: Row) {
          op = 'update';
          payload = [patch];
          return q;
        },
        single: () => q,
        then(resolve: (v: unknown) => unknown) {
          const rows = (db[table] ??= []);
          let data: Row[] = [];
          if (op === 'insert') {
            for (const p of payload) {
              const clash =
                table === 'automations' &&
                p.preset_key &&
                rows.some(
                  (r) =>
                    r.account_id === p.account_id &&
                    r.preset_key === p.preset_key
                );
              if (clash) {
                error = { code: '23505', message: 'duplicate key' };
                break;
              }
              const row = { id: `${table}-${++seq}`, ...p };
              rows.push(row);
              data.push(row);
            }
          } else if (op === 'update') {
            for (const r of rows.filter((x) => filters.every((f) => f(x)))) {
              Object.assign(r, payload[0]);
            }
          } else if (op === 'delete') {
            db[table] = rows.filter((r) => !filters.every((f) => f(r)));
          } else {
            data = rows.filter((r) => filters.every((f) => f(r)));
          }
          return Promise.resolve({
            data: op === 'select' ? data : (data[0] ?? null),
            error,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  return { db, client: client as unknown as SupabaseClient };
}

const args = (catalog = CATALOGS.en) => ({
  accountId: 'acct-1',
  userId: 'user-1',
  catalog,
});

/** Seeds are flat with parent_index; the validators want the nested tree. */
function toTree(seeds: TemplateStepSeed[]) {
  type Node = {
    step_type: string;
    step_config: Record<string, unknown>;
    branches: { yes: Node[]; no: Node[] };
  };
  const nodes: Node[] = seeds.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config as Record<string, unknown>,
    branches: { yes: [], no: [] },
  }));
  const roots: Node[] = [];
  seeds.forEach((s, i) => {
    if (s.parent_index == null) roots.push(nodes[i]);
    else nodes[s.parent_index].branches[s.branch ?? 'yes'].push(nodes[i]);
  });
  return roots;
}

describe('buildJourneyPreset', () => {
  it.each(Object.keys(CATALOGS))(
    'defines every automation with a text in %s',
    (locale) => {
      const preset = buildJourneyPreset(CATALOGS[locale]);
      // resumption + abandoned cart + thank-you + one per order status
      expect(preset).toHaveLength(3 + ORDER_TRIGGER_STATUSES.length);
      expect(new Set(preset.map((p) => p.preset_key)).size).toBe(preset.length);
      for (const p of preset) {
        expect(p.name.length).toBeGreaterThan(0);
        const texts = p.steps
          .filter((s) => s.step_type === 'send_message')
          .map((s) => (s.step_config as { text: string }).text);
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  );

  it('passes the activation validators, so the operator can turn each one on', () => {
    for (const p of buildJourneyPreset(CATALOGS.en)) {
      expect(
        validateTriggerForActivation(p.trigger_type as never, p.trigger_config)
      ).toEqual([]);
      expect(validateStepsForActivation(toTree(p.steps))).toEqual([]);
    }
  });

  it('never puts {{menu_link}} in a menu_link_sent automation (it would fire itself)', () => {
    for (const catalog of Object.values(CATALOGS)) {
      const resumption = buildJourneyPreset(catalog).find(
        (p) => p.trigger_type === 'menu_link_sent'
      )!;
      expect(JSON.stringify(resumption.steps)).not.toContain('menu_link');
    }
  });

  it('builds the Resumption chain of #9 as data (10 min, checks, R1, +20 min, checks, R2)', () => {
    const p = buildJourneyPreset(CATALOGS.en).find((x) =>
      x.preset_key.endsWith('resumption')
    )!;
    expect(p.trigger_type).toBe('menu_link_sent');
    const [root] = toTree(p.steps);
    expect(root).toMatchObject({
      step_type: 'wait',
      step_config: { amount: 10, unit: 'minutes' },
    });
    const roots = toTree(p.steps);
    expect(roots.map((n) => n.step_type)).toEqual(['wait', 'condition']);
    const replied = roots[1].branches.yes[0].branches.yes[0];
    expect(replied.step_config).toEqual({
      subject: 'customer_replied_since',
      operand: 'link_sent',
    });
    expect(replied.branches.yes).toEqual([]);
    expect(replied.branches.no.map((n) => n.step_type)).toEqual([
      'send_message',
      'wait',
      'condition',
    ]);
    expect(replied.branches.no[1].step_config).toEqual({
      amount: 20,
      unit: 'minutes',
    });
    const second =
      replied.branches.no[2].branches.yes[0].branches.yes[0].branches.no[0];
    expect(second.step_config).toEqual({ text: CATALOGS.en.texts.resumption2 });
  });

  it('builds the abandoned cart chain of #10 with the one-shot flag', () => {
    const p = buildJourneyPreset(CATALOGS.en).find((x) =>
      x.preset_key.endsWith('abandoned_cart')
    )!;
    expect(p.trigger_type).toBe('journey_event');
    expect(p.trigger_config).toEqual({
      event_names: ['AddToCart', 'InitiateCheckout'],
    });
    const send = p.steps.at(-1)!;
    expect(send.step_config).toEqual({
      text: CATALOGS.en.texts.abandonedCart,
      mark_journey_flag: 'abandoned_cart_sent',
      consent_purpose: 'marketing',
    });
    expect(
      p.steps.map((s) => (s.step_config as { subject?: string }).subject)
    ).toEqual([
      undefined,
      'conversation_unattended',
      'journey_open',
      'customer_replied_since',
      'journey_flag',
      undefined,
    ]);
  });

  it('has a thank-you for Purchase and one automation per order status', () => {
    const preset = buildJourneyPreset(CATALOGS.en);
    expect(
      preset.find((p) => p.preset_key.endsWith('thank_you'))!.trigger_config
    ).toEqual({ event_names: ['Purchase'] });
    const statuses = preset
      .filter((p) => p.trigger_type === 'order_status_changed')
      .map((p) => (p.trigger_config as { statuses: string[] }).statuses);
    expect(statuses).toEqual(ORDER_TRIGGER_STATUSES.map((s) => [s]));
  });
});

describe('loadJourneyPresetCatalog', () => {
  it.each(['en', 'pt', 'es', 'ko'])('loads the %s texts', async (locale) => {
    expect(await loadJourneyPresetCatalog(locale)).toEqual(CATALOGS[locale]);
  });

  it('falls back to English for an unknown locale', async () => {
    expect(await loadJourneyPresetCatalog('xx')).toEqual(CATALOGS.en);
  });

  it('uses the default texts in the deployment language, not English', () => {
    expect(CATALOGS.pt.texts.thankYou).not.toBe(CATALOGS.en.texts.thankYou);
    expect(CATALOGS.ko.texts.thankYou).not.toBe(CATALOGS.en.texts.thankYou);
    expect(CATALOGS.es.texts.thankYou).not.toBe(CATALOGS.en.texts.thankYou);
  });
});

describe('installJourneyPreset consent purposes', () => {
  const sends = (db: Record<string, Row[]>, key: string) => {
    const id = db.automations.find((a) => a.preset_key === key)!.id;
    return db.automation_steps.filter(
      (s) => s.automation_id === id && s.step_type === 'send_message'
    );
  };
  const purposeOf = (s: Row) =>
    (s.step_config as { consent_purpose?: string }).consent_purpose;

  it('the thank-you and every status notice use notifications; the abandoned cart declares marketing; resumptions declare nothing', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    for (const key of [
      'order_journey.thank_you',
      ...ORDER_TRIGGER_STATUSES.map((s) => `order_journey.status_${s}`),
    ]) {
      expect(sends(db, key).map(purposeOf)).toEqual(['notifications']);
    }
    expect(sends(db, 'order_journey.abandoned_cart').map(purposeOf)).toEqual(['marketing']);
    expect(sends(db, 'order_journey.resumption').map(purposeOf).every((p) => p === undefined)).toBe(true);
  });

  it('backfills an abandoned cart installed before with an explicit marketing', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    const cart = sends(db, 'order_journey.abandoned_cart')[0];
    cart.step_config = { text: 'Editado', mark_journey_flag: 'abandoned_cart_sent' };
    const again = await installJourneyPreset(client, args());
    expect(again.backfilled).toContain('order_journey.abandoned_cart');
    expect(cart.step_config).toEqual({
      text: 'Editado',
      mark_journey_flag: 'abandoned_cart_sent',
      consent_purpose: 'marketing',
    });
  });

  it('backfills ONLY consent_purpose on automations installed before it, keeping edits', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    const thanks = sends(db, 'order_journey.thank_you')[0];
    // As installed by the previous version, then edited by the operator.
    thanks.step_config = {
      text: 'Texto editado',
      fallback_template: { name: 'meu_template', language: 'pt_BR' },
    };
    const again = await installJourneyPreset(client, args());

    expect(again.created).toEqual([]);
    expect(again.backfilled).toContain('order_journey.thank_you');
    expect(thanks.step_config).toEqual({
      text: 'Texto editado',
      fallback_template: { name: 'meu_template', language: 'pt_BR' },
      consent_purpose: 'notifications',
    });
    // Nothing left to backfill on a third run.
    expect((await installJourneyPreset(client, args())).backfilled).toEqual([]);
  });

  it('never overwrites a purpose the operator already chose', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    const step = sends(db, 'order_journey.status_preparing')[0];
    step.step_config = { ...(step.step_config as Row), consent_purpose: 'marketing' };
    const again = await installJourneyPreset(client, args());
    expect(again.backfilled).not.toContain('order_journey.status_preparing');
    expect(purposeOf(step)).toBe('marketing');
  });
});

describe('installJourneyPreset', () => {
  it('creates every automation inactive, with its steps as a tree', async () => {
    const { db, client } = fakeDb();
    const result = await installJourneyPreset(client, args());

    expect(result.created).toHaveLength(3 + ORDER_TRIGGER_STATUSES.length);
    expect(result.existing).toEqual([]);
    expect(db.automations).toHaveLength(result.created.length);
    for (const a of db.automations) {
      expect(a).toMatchObject({
        account_id: 'acct-1',
        user_id: 'user-1',
        is_active: false,
      });
      expect(String(a.preset_key)).toMatch(/^order_journey\./);
    }

    const resumption = db.automations.find(
      (a) => a.preset_key === 'order_journey.resumption'
    )!;
    const steps = db.automation_steps.filter(
      (s) => s.automation_id === resumption.id
    );
    expect(steps).toHaveLength(10);
    const byId = new Map(steps.map((s) => [s.id, s]));
    const root = steps.filter((s) => s.parent_step_id === null);
    expect(root.map((s) => [s.step_type, s.position])).toEqual([
      ['wait', 0],
      ['condition', 1],
    ]);
    for (const s of steps.filter((x) => x.parent_step_id !== null)) {
      expect(byId.has(s.parent_step_id)).toBe(true);
      expect(['yes', 'no']).toContain(s.branch);
    }
    const r1 = steps.find(
      (s) =>
        (s.step_config as { text?: string }).text ===
        CATALOGS.en.texts.resumption1
    )!;
    const scope = steps.filter(
      (s) => s.parent_step_id === r1.parent_step_id && s.branch === 'no'
    );
    expect(scope.map((s) => [s.step_type, s.position])).toEqual([
      ['send_message', 0],
      ['wait', 1],
      ['condition', 2],
    ]);
  });

  it('is idempotent: installing twice does not duplicate', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    const automations = db.automations.length;
    const steps = db.automation_steps.length;

    const again = await installJourneyPreset(client, args());

    expect(again.created).toEqual([]);
    expect(again.existing).toHaveLength(automations);
    expect(db.automations).toHaveLength(automations);
    expect(db.automation_steps).toHaveLength(steps);
  });

  it('recognises an edited preset automation by its key, not its name', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    const thanks = db.automations.find(
      (a) => a.preset_key === 'order_journey.thank_you'
    )!;
    thanks.name = 'Meu agradecimento';
    thanks.is_active = true;

    const again = await installJourneyPreset(client, args());

    expect(again.created).toEqual([]);
    expect(
      db.automations.filter((a) => a.name === 'Meu agradecimento')
    ).toHaveLength(1);
    expect(thanks.is_active).toBe(true);
  });

  it('recreates only what the operator deleted', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    db.automations = db.automations.filter(
      (a) => a.preset_key !== 'order_journey.status_delivered'
    );

    const again = await installJourneyPreset(client, args());

    expect(again.created).toEqual(['order_journey.status_delivered']);
  });

  it('keeps accounts apart', async () => {
    const { db, client } = fakeDb();
    await installJourneyPreset(client, args());
    const other = await installJourneyPreset(client, {
      ...args(),
      accountId: 'acct-2',
    });

    expect(other.created).toHaveLength(3 + ORDER_TRIGGER_STATUSES.length);
    expect(db.automations).toHaveLength(
      2 * (3 + ORDER_TRIGGER_STATUSES.length)
    );
  });

  it('treats a unique violation from a concurrent install as already existing', async () => {
    const { db, client } = fakeDb();
    // The other request inserts between our read and our insert.
    const real = client.from.bind(client);
    let raced = false;
    (client as unknown as { from: (t: string) => unknown }).from = (
      table: string
    ) => {
      const q = real(table) as { insert: (r: Row) => unknown };
      if (table === 'automations' && !raced) {
        const insert = q.insert.bind(q);
        q.insert = (row: Row) => {
          if (!raced) {
            raced = true;
            db.automations.push({
              id: 'other',
              account_id: 'acct-1',
              preset_key: row.preset_key,
            });
          }
          return insert(row);
        };
      }
      return q;
    };

    const result = await installJourneyPreset(client, args());

    expect(result.existing).toEqual(['order_journey.resumption']);
    expect(result.created).toHaveLength(3 + ORDER_TRIGGER_STATUSES.length - 1);
  });
});

describe('summarizeJourneyPreset', () => {
  const automations = [
    { id: 'a1', name: 'One', is_active: true },
    { id: 'a2', name: 'Two', is_active: false },
  ];

  it('lists stores without a menu URL, steps without a fallback template and inactive ones', () => {
    const status = summarizeJourneyPreset({
      automations,
      total: 10,
      steps: [
        {
          automation_id: 'a1',
          step_type: 'send_message',
          step_config: { text: 'x' },
        },
        {
          automation_id: 'a1',
          step_type: 'send_message',
          step_config: { text: 'y' },
        },
        {
          automation_id: 'a2',
          step_type: 'send_message',
          step_config: { text: 'z', fallback_template: { name: 'tpl' } },
        },
        { automation_id: 'a2', step_type: 'wait', step_config: {} },
      ],
      stores: [
        { id: 's1', name: 'Centro', menu_url: 'https://menu.example/centro' },
        { id: 's2', name: 'Norte', menu_url: null },
        { id: 's3', name: 'Sul', menu_url: '  ' },
      ],
    });

    expect(status.installed).toBe(2);
    expect(status.total).toBe(10);
    expect(status.inactive).toEqual([{ id: 'a2', name: 'Two' }]);
    expect(status.storesWithoutMenuUrl.map((s) => s.name)).toEqual([
      'Norte',
      'Sul',
    ]);
    expect(status.missingFallbackTemplate).toEqual([
      { id: 'a1', name: 'One', steps: 2 },
    ]);
  });

  it('reports nothing missing when everything is configured', () => {
    const status = summarizeJourneyPreset({
      automations: [{ id: 'a1', name: 'One', is_active: true }],
      total: 1,
      steps: [
        {
          automation_id: 'a1',
          step_type: 'send_message',
          step_config: {
            text: 'x',
            fallback_template: { name: 'tpl', language: 'pt_BR' },
          },
        },
      ],
      stores: [{ id: 's1', name: 'Centro', menu_url: 'https://m.example' }],
    });

    expect(status.inactive).toEqual([]);
    expect(status.storesWithoutMenuUrl).toEqual([]);
    expect(status.missingFallbackTemplate).toEqual([]);
  });
});
