// ============================================================
// Link rewriting for the manuals (pure, no I/O).
//
// A manual is written to be read on GitHub too, so it links with relative
// paths (`./openapi.yaml`, `./integracao-cardapio.md`). The renderer sends
// every `href` through here to get the real route, or `null` when the link
// must not be a link at all (the caller then shows plain text).
// ============================================================

import { MANUALS, type ManualMeta, type ManualVisibility } from './registry';

export const OPENAPI_HREF = '/developers/openapi.yaml';

export interface LinkContext {
  /** Visibility of the manual that contains the link. */
  visibility: ManualVisibility;
  /** Defaults to the real registry. */
  manuals?: readonly ManualMeta[];
}

const EXTERNAL = /^(https?:|mailto:)/i;

/**
 * - `#anchor`, `http(s):` and `mailto:` pass through unchanged.
 * - `./openapi.yaml` → the public YAML route.
 * - `./<file>.md` of a registered manual → its route. An 'admin' manual is
 *   reachable only from another 'admin' manual: a public manual must never
 *   link to the operator's, so that link is `null`.
 * - Anything else (unknown relative paths, root-absolute paths) is `null`.
 */
export function resolveManualHref(
  href: string,
  context: LinkContext
): string | null {
  if (href.startsWith('#') || EXTERNAL.test(href)) return href;

  const [target, ...rest] = href.split('#');
  const hash = rest.length ? `#${rest.join('#')}` : '';

  if (target === './openapi.yaml') return OPENAPI_HREF + hash;

  const file = target.startsWith('./') ? target.slice(2) : null;
  const manual = file
    ? (context.manuals ?? MANUALS).find((m) => m.file === file)
    : undefined;
  if (!manual) return null;

  if (manual.visibility === 'public')
    return `/developers/${manual.slug}${hash}`;
  return context.visibility === 'admin'
    ? `/settings/manuals/${manual.slug}${hash}`
    : null;
}
