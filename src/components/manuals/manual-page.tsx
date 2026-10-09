// ============================================================
// Page body shared by /developers/[slug] and /settings/manuals/[slug]:
// the manual plus its table of contents. One layout, one renderer.
// ============================================================

import type { Manual } from '@/lib/manuals/loader';

import { ManualToc } from './manual-toc';
import { ManualView } from './manual-view';

export function ManualPage({
  manual,
  tocLabel,
}: {
  manual: Manual;
  tocLabel: string;
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
      {/* Narrow screens: a collapsible contents list above the text. */}
      <details className="border-border bg-muted/40 rounded-lg border p-3 lg:hidden print:hidden">
        <summary className="text-foreground cursor-pointer text-sm font-medium">
          {tocLabel}
        </summary>
        <div className="mt-3">
          <ManualToc headings={manual.headings} label={tocLabel} />
        </div>
      </details>

      <ManualView manual={manual} />

      <aside className="hidden lg:sticky lg:top-6 lg:block lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto print:hidden">
        <ManualToc headings={manual.headings} label={tocLabel} />
      </aside>
    </div>
  );
}
