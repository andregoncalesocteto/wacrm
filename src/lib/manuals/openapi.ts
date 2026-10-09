// Reads the public API contract (content/api/openapi.yaml). Like loader.ts,
// this is one of the only modules that touches the disk for the docs.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function openApiPath(): string {
  return path.join(process.cwd(), 'content', 'api', 'openapi.yaml');
}

export async function readOpenApi(): Promise<string> {
  return readFile(openApiPath(), 'utf8');
}
