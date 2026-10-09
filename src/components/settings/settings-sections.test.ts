import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECTION,
  RAIL_GROUPS,
  RAIL_LINKS,
  SECTION_META,
  SETTINGS_SECTIONS,
  resolveSection,
} from './settings-sections';

describe('resolveSection', () => {
  it('maps the legacy whatsapp tab to channels', () => {
    expect(resolveSection('whatsapp')).toBe('channels');
  });

  it('accepts the new stores and channels ids', () => {
    expect(resolveSection('stores')).toBe('stores');
    expect(resolveSection('channels')).toBe('channels');
  });

  it('maps legacy tags/custom-fields to fields', () => {
    expect(resolveSection('tags')).toBe('fields');
    expect(resolveSection('custom-fields')).toBe('fields');
  });

  it('falls back to overview for unknown or empty values', () => {
    expect(resolveSection('nope')).toBe(DEFAULT_SECTION);
    expect(resolveSection('')).toBe('overview');
    expect(resolveSection(null)).toBe('overview');
  });
});

describe('sections metadata', () => {
  it('has no whatsapp section and puts stores/channels in the workspace group', () => {
    expect(SETTINGS_SECTIONS as readonly string[]).not.toContain('whatsapp');
    expect(SECTION_META.stores.group).toBe('workspace');
    expect(SECTION_META.channels.group).toBe('workspace');
    expect(RAIL_GROUPS.map((g) => g.group)).toContain('workspace');
  });
});

describe('rail links', () => {
  it('has the admin-only Manuals link in the workspace group', () => {
    expect(RAIL_LINKS).toHaveLength(1);
    expect(RAIL_LINKS[0]).toMatchObject({
      id: 'manuals',
      href: '/settings/manuals',
      group: 'workspace',
      adminOnly: true,
    });
  });

  it('keeps links out of the sections (no panel, not resolvable by ?tab=)', () => {
    expect(SETTINGS_SECTIONS as readonly string[]).not.toContain('manuals');
    expect(Object.keys(SECTION_META)).not.toContain('manuals');
    expect(resolveSection('manuals')).toBe(DEFAULT_SECTION);
  });
});
