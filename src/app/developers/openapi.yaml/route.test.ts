import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /developers/openapi.yaml', () => {
  it('serves content/api/openapi.yaml as application/yaml with open CORS', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/yaml; charset=utf-8'
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const file = readFileSync(
      path.join(process.cwd(), 'content', 'api', 'openapi.yaml'),
      'utf8'
    );
    expect(await res.text()).toBe(file);
  });

  it('is generated at build time (force-static)', async () => {
    const mod = await import('./route');
    expect(mod.dynamic).toBe('force-static');
  });
});
