// ============================================================
// Reads the manuals from disk. The ONLY module that does (ADR-001).
//
// Two entry points on purpose: `getPublicManual` can never return an 'admin'
// manual and `getAdminManual` can never return a 'public' one, so serving the
// wrong manual takes calling the wrong function, not forgetting an `if`.
// Public pages must import only this module, never account or session code.
// ============================================================

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { extractHeadings, substituteTokens, type Heading } from './markdown';
import { MANUALS, type ManualMeta, type ManualVisibility } from './registry';

export interface Manual {
  meta: ManualMeta;
  /** Markdown with `{URL_BASE}` already replaced. */
  markdown: string;
  headings: Heading[];
}

export interface LoaderOptions {
  /** Defaults to NEXT_PUBLIC_APP_LOCALE (then 'en'). */
  locale?: string;
  /** Defaults to <cwd>/content/manuals. */
  contentRoot?: string;
  /** Defaults to the real registry. */
  manuals?: readonly ManualMeta[];
}

/** Locale used when the deployment's locale has no manuals folder. */
const FALLBACK_LOCALE = 'pt';

function defaultContentRoot(): string {
  return path.join(process.cwd(), 'content', 'manuals');
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveLocaleDir(options: LoaderOptions): Promise<string> {
  const root = options.contentRoot ?? defaultContentRoot();
  const locale = options.locale ?? (process.env.NEXT_PUBLIC_APP_LOCALE || 'en');
  // `root` can be injected (tests), so Turbopack cannot scope these joins to a
  // folder and would trace the WHOLE project into the standalone output. The
  // ignore comments opt out on purpose: the files the admin pages read at
  // runtime are declared in next.config.ts (`outputFileTracingIncludes`), and
  // the public pages are rendered at build time.
  const wanted = path.join(/*turbopackIgnore: true*/ root, locale);
  return (await isDirectory(wanted))
    ? wanted
    : path.join(/*turbopackIgnore: true*/ root, FALLBACK_LOCALE);
}

/** Never returns empty content: a missing file is an error, not a blank page. */
async function loadManual(
  meta: ManualMeta,
  options: LoaderOptions
): Promise<Manual> {
  const file = path.join(
    /*turbopackIgnore: true*/ await resolveLocaleDir(options),
    meta.file
  );
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    console.error(`[manuals] cannot read manual '${meta.slug}'`);
    throw new Error(`Manual '${meta.slug}' has no file at ${file}`, {
      cause: err,
    });
  }
  const markdown = substituteTokens(raw);
  return { meta, markdown, headings: extractHeadings(markdown) };
}

function find(
  slug: string,
  visibility: ManualVisibility,
  options: LoaderOptions
): ManualMeta | undefined {
  return (options.manuals ?? MANUALS).find(
    (m) => m.slug === slug && m.visibility === visibility
  );
}

function list(
  visibility: ManualVisibility,
  options: LoaderOptions
): ManualMeta[] {
  return (options.manuals ?? MANUALS).filter(
    (m) => m.visibility === visibility
  );
}

/** `null` when the slug does not exist OR is not public. */
export async function getPublicManual(
  slug: string,
  options: LoaderOptions = {}
): Promise<Manual | null> {
  const meta = find(slug, 'public', options);
  return meta ? loadManual(meta, options) : null;
}

/** `null` when the slug does not exist OR is not an admin manual. */
export async function getAdminManual(
  slug: string,
  options: LoaderOptions = {}
): Promise<Manual | null> {
  const meta = find(slug, 'admin', options);
  return meta ? loadManual(meta, options) : null;
}

export function listPublicManuals(options: LoaderOptions = {}): ManualMeta[] {
  return list('public', options);
}

export function listAdminManuals(options: LoaderOptions = {}): ManualMeta[] {
  return list('admin', options);
}
