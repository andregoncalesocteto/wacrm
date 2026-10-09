import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the rail's own logic is under test: translations are stubbed to their
// key and `useCan` is the knob for "is this user owner/admin".
const can = vi.hoisted(() => ({ editSettings: true }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/hooks/use-can', () => ({
  useCan: (action: string) =>
    action === 'edit-settings' ? can.editSettings : false,
}));

const { SettingsRail } = await import('./settings-rail');

const render = () =>
  renderToStaticMarkup(<SettingsRail active="overview" onSelect={() => {}} />);

afterEach(() => {
  can.editSettings = true;
});

describe('SettingsRail: Manuals link', () => {
  it('shows the link to /settings/manuals to an owner or admin', () => {
    can.editSettings = true;
    const html = render();
    expect(html).toContain('href="/settings/manuals"');
    expect(html).toContain('sections.manuals');
  });

  it('hides it from an agent or viewer, and keeps every real section', () => {
    can.editSettings = false;
    const html = render();
    expect(html).not.toContain('/settings/manuals');
    expect(html).not.toContain('sections.manuals');
    for (const section of ['overview', 'stores', 'channels', 'api']) {
      expect(html).toContain(`sections.${section}`);
    }
  });
});
