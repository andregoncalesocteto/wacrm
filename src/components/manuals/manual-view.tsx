// ============================================================
// Renders one manual (Server Component, no client JS).
//
// Shared by /developers/[slug] and /settings/manuals/[slug]. Markdown is
// turned into React elements by react-markdown: raw HTML in the file is
// ignored, and nothing goes through dangerouslySetInnerHTML.
//
// The heading ids come from rehype-slug, the same pipeline `extractHeadings`
// (lib/manuals/markdown.ts) uses for the table of contents, so the two agree.
// ============================================================

import Markdown, { type Components } from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';

import { resolveManualHref } from '@/lib/manuals/links';
import type { Manual } from '@/lib/manuals/loader';
import { cn } from '@/lib/utils';

const EXTERNAL = /^https?:/i;

/** react-markdown passes the hast `node` to every component; DOM elements must not get it. */
function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, 'node'> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

function buildComponents(visibility: Manual['meta']['visibility']): Components {
  return {
    a({ href, children }) {
      const resolved = href ? resolveManualHref(href, { visibility }) : null;
      // An unresolvable link (for example a public manual pointing at an admin
      // one) is shown as plain text, never as a dead or leaking link.
      if (!resolved) return <>{children}</>;
      const external = EXTERNAL.test(resolved);
      return (
        <a
          href={resolved}
          {...(external
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : {})}
          className="text-primary font-medium underline-offset-4 hover:underline"
        >
          {children}
        </a>
      );
    },
    h1: (props) => (
      <h1
        className="text-foreground mb-4 text-3xl font-bold tracking-tight"
        {...withoutNode(props)}
      />
    ),
    h2: (props) => (
      <h2
        className="border-border text-foreground mt-10 mb-3 scroll-mt-6 border-b pb-2 text-2xl font-semibold tracking-tight"
        {...withoutNode(props)}
      />
    ),
    h3: (props) => (
      <h3
        className="text-foreground mt-6 mb-2 scroll-mt-6 text-lg font-semibold"
        {...withoutNode(props)}
      />
    ),
    p: (props) => (
      <p
        className="text-foreground/90 my-3 leading-7"
        {...withoutNode(props)}
      />
    ),
    ul: (props) => (
      <ul className="my-3 list-disc space-y-1 pl-6" {...withoutNode(props)} />
    ),
    ol: (props) => (
      <ol
        className="my-3 list-decimal space-y-1 pl-6"
        {...withoutNode(props)}
      />
    ),
    li: (props) => (
      <li className="text-foreground/90 leading-7" {...withoutNode(props)} />
    ),
    blockquote: (props) => (
      <blockquote
        className="border-primary bg-primary-soft text-foreground/90 my-4 rounded-r-lg border-l-4 px-4 py-2"
        {...withoutNode(props)}
      />
    ),
    hr: (props) => (
      <hr className="border-border my-8" {...withoutNode(props)} />
    ),
    table: (props) => (
      <div className="border-border my-4 overflow-x-auto rounded-lg border">
        <table
          className="w-full border-collapse text-left text-sm"
          {...withoutNode(props)}
        />
      </div>
    ),
    th: (props) => (
      <th
        className="border-border bg-muted text-foreground border-b px-3 py-2 font-semibold whitespace-nowrap"
        {...withoutNode(props)}
      />
    ),
    td: (props) => (
      <td
        className="border-border text-foreground/90 border-b px-3 py-2 align-top"
        {...withoutNode(props)}
      />
    ),
    pre: (props) => {
      const { className, ...rest } = withoutNode(props);
      return (
        <pre
          className={cn(
            'border-border bg-muted text-foreground my-4 overflow-x-auto rounded-lg border p-4 font-mono text-[0.8125rem] leading-6',
            '[&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit',
            className
          )}
          {...rest}
        />
      );
    },
    code: (props) => {
      const { className, ...rest } = withoutNode(props);
      return (
        <code
          className={cn(
            'bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-[0.85em]',
            className
          )}
          {...rest}
        />
      );
    },
  };
}

export function ManualView({ manual }: { manual: Manual }) {
  return (
    <article className="max-w-3xl min-w-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={buildComponents(manual.meta.visibility)}
      >
        {manual.markdown}
      </Markdown>
    </article>
  );
}
