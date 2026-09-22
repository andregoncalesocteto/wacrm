import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECTION,
  RAIL_GROUPS,
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
