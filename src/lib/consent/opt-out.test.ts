import { describe, expect, it } from 'vitest';

import { isOptOutText, loadOptOutConfirmation } from './opt-out';

describe('isOptOutText: true positives', () => {
  it.each([
    'parar',
    'PARAR',
    '  Parar  ',
    'PARAR!',
    '...parar.',
    'Parar 🛑',
    '🛑 PARAR',
    'pare',
    'STOP',
    'Stop.',
    'sair',
    'Sáir',
    'cancelar envio',
    'Cancelar  envio!',
    'cancelar mensagens',
    'não quero receber',
    'Nao quero receber.',
    'NÃO QUERO MAIS RECEBER',
    'descadastrar',
    'Unsubscribe',
    '수신거부',
  ])('%s', (text) => {
    expect(isOptOutText(text)).toBe(true);
  });
});

describe('isOptOutText: false positives', () => {
  it.each([
    'não quero parar de receber',
    'preciso parar o pedido',
    'quero cancelar o pedido 123',
    'cancelar',
    'Cancelar pedido',
    'stop calling me please',
    'posso sair mais cedo?',
    'quero receber as promoções',
    'parar, por favor, o pedido',
    'oi',
    '',
    '   ',
    '!!!',
  ])('%j', (text) => {
    expect(isOptOutText(text)).toBe(false);
  });

  it('null and undefined are not opt-outs', () => {
    expect(isOptOutText(null)).toBe(false);
    expect(isOptOutText(undefined)).toBe(false);
  });
});

describe('loadOptOutConfirmation', () => {
  it.each(['en', 'es', 'pt', 'ko'])('has a text for %s', async (locale) => {
    expect((await loadOptOutConfirmation(locale)).length).toBeGreaterThan(10);
  });

  it('falls back to English for an unknown locale', async () => {
    expect(await loadOptOutConfirmation('xx')).toBe(
      await loadOptOutConfirmation('en')
    );
  });
});
