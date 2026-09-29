import { IDTRACK_PARAM, MENU_LINK_VARIABLE } from './constants';

const VARIABLE_RE = new RegExp(
  `\\{\\{\\s*${MENU_LINK_VARIABLE}\\s*\\}\\}`,
  'g'
);

/** True when a message text uses the `{{menu_link}}` variable. */
export function hasMenuLinkVariable(text: string): boolean {
  return new RegExp(VARIABLE_RE.source).test(text);
}

/** Expand every `{{menu_link}}` in `text` with `url`. */
export function replaceMenuLinkVariable(text: string, url: string): string {
  return text.replace(VARIABLE_RE, () => url);
}

/**
 * The store's menu address with `idtrack=<token>` appended. Every other query
 * parameter (and the fragment) is preserved; an `idtrack` already present on
 * the stored address is replaced, never duplicated.
 */
export function buildMenuUrl(menuUrl: string, token: string): string {
  const url = new URL(menuUrl);
  url.searchParams.set(IDTRACK_PARAM, token);
  return url.toString();
}
