// ============================================================
// Table of contents of a manual: the h2 and h3 with the ids the renderer
// gives them. A plain component (the label is passed in) so a page can
// translate it and a test can render it. Hidden when printing.
// ============================================================

import type { Heading } from '@/lib/manuals/markdown';
import { cn } from '@/lib/utils';

export function ManualToc({
  headings,
  label,
}: {
  headings: Heading[];
  label: string;
}) {
  if (headings.length === 0) return null;
  return (
    <nav aria-label={label} className="text-sm print:hidden">
      <p className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-[0.09em] uppercase">
        {label}
      </p>
      <ul className="border-border space-y-1 border-l">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                'text-muted-foreground hover:text-foreground block py-0.5 transition-colors',
                h.depth === 3 ? 'pl-7 text-[13px]' : 'pl-3'
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
