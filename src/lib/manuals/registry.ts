// ============================================================
// Registry of the manuals served by the app (ADR-001).
//
// Visibility is declared HERE, per manual, never inferred from the folder:
//   - 'public' → /developers/<slug>, no login (the external menu team reads it)
//   - 'admin'  → /settings/manuals/<slug>, owner/admin only
//
// The body of each manual is a Markdown file in
// `content/manuals/<locale>/<file>`. To add a manual: add the file and one
// entry here. Nothing else changes.
// ============================================================

export type ManualVisibility = 'public' | 'admin';

export interface ManualMeta {
  /** URL segment. Unique, and never one of RESERVED_SLUGS. */
  slug: string;
  /** Content, not UI text: written in Portuguese like the manual itself. */
  title: string;
  description: string;
  visibility: ManualVisibility;
  /** File name inside content/manuals/<locale>/. */
  file: string;
}

/** Routes that live beside `/developers/[slug]` and must not be shadowed. */
export const RESERVED_SLUGS: readonly string[] = ['api-reference'];

/**
 * Throws when a registry would break a route or leak a manual: a reserved or
 * duplicated slug. Runs when this module loads, so a bad entry fails the
 * build, not a request.
 */
export function validateRegistry(manuals: readonly ManualMeta[]): void {
  const seen = new Set<string>();
  for (const manual of manuals) {
    if (RESERVED_SLUGS.includes(manual.slug)) {
      throw new Error(`Manual slug '${manual.slug}' is reserved`);
    }
    if (seen.has(manual.slug)) {
      throw new Error(`Manual slug '${manual.slug}' is duplicated`);
    }
    seen.add(manual.slug);
  }
}

export const MANUALS: readonly ManualMeta[] = [
  {
    slug: 'integracao-cardapio',
    title: 'Integração do cardápio digital',
    description:
      'Contrato de eventos, consentimento, erros e reenvio, para o time que mantém o cardápio.',
    visibility: 'public',
    file: 'integracao-cardapio.md',
  },
  {
    slug: 'configuracao-jornada-pedido',
    title: 'Configuração da jornada de pedido',
    description:
      'Lojas, link do cardápio, chave de API, automações e agendador, para quem administra o CRM.',
    visibility: 'admin',
    file: 'configuracao-jornada-pedido.md',
  },
];

validateRegistry(MANUALS);
