// GET /developers/openapi.yaml — the raw contract, so a developer can import
// it by URL in Insomnia, Postman or editor.swagger.io, and so the Swagger UI
// page can read it from the same origin.
//
// `force-static`: a GET handler is dynamic by default; this file never
// changes between deploys, so it is generated once at build time.
//
// CORS is open on this route ONLY: the file is public and read-only, and the
// online editor fetches it from the browser.

import { readOpenApi } from '@/lib/manuals/openapi';

export const dynamic = 'force-static';

export async function GET() {
  return new Response(await readOpenApi(), {
    headers: {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
