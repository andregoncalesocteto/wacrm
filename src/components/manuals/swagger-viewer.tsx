'use client';

// ============================================================
// The Swagger UI of the public API (ADR-002).
//
// Client Component because `next/dynamic` with `ssr: false` is not allowed in
// a Server Component. The library is bundled with the app (no CDN: the CSP is
// `default-src 'self'`) and only this route loads it.
//
// - `url` is the app's own copy of the contract, and the contract declares
//   `servers: - url: /`, so "Try it out" calls the same origin: no CORS and no
//   placeholder host to replace.
// - `persistAuthorization` is off: the key a developer pastes in Authorize is
//   NOT kept in localStorage.
// - Swagger UI has no dark theme, so it sits on a light panel.
// ============================================================

import dynamic from 'next/dynamic';

import 'swagger-ui-react/swagger-ui.css';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), {
  ssr: false,
  loading: () => <div className="h-40" aria-hidden />,
});

export function SwaggerViewer({ url }: { url: string }) {
  return (
    <div
      className="border-border overflow-hidden rounded-xl border bg-white text-neutral-900"
      style={{ colorScheme: 'light' }}
    >
      <SwaggerUI
        url={url}
        persistAuthorization={false}
        docExpansion="list"
        defaultModelsExpandDepth={-1}
      />
    </div>
  );
}
