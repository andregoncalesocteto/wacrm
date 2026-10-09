// ============================================================
// Pure Markdown helpers for the manuals (no I/O).
//
// `extractHeadings` runs the SAME unified pipeline the renderer uses
// (remark-parse → remark-gfm → remark-rehype → rehype-slug), so the ids in
// the table of contents are, by construction, the ids of the rendered
// headings: titles with backticks and repeated titles included.
// ============================================================

import type { Element, Root } from 'hast';
import { toString } from 'hast-util-to-string';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export interface Heading {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** Shown when NEXT_PUBLIC_SITE_URL is not set. */
export const FALLBACK_SITE_URL = 'https://SEU-CRM.exemplo.com';

const URL_BASE_TOKEN = '{URL_BASE}';

/**
 * Replaces `{URL_BASE}` with the deployment URL (no trailing slash). It is the
 * only token substituted: `{{menu_link}}`, `{{order_id}}` and the other `{{…}}`
 * are product text and stay untouched.
 */
export function substituteTokens(markdown: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || FALLBACK_SITE_URL).replace(
    /\/+$/,
    ''
  );
  return markdown.split(URL_BASE_TOKEN).join(base);
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSlug);

/** The `h2` and `h3` of a manual, with the id the renderer gives them. */
export function extractHeadings(markdown: string): Heading[] {
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  const headings: Heading[] = [];
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'h2' && node.tagName !== 'h3') return;
    const id = node.properties?.id;
    if (typeof id !== 'string') return;
    headings.push({
      id,
      text: toString(node),
      depth: node.tagName === 'h2' ? 2 : 3,
    });
  });
  return headings;
}
