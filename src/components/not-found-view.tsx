// ============================================================
// The "not found" screen, in the app's own theme.
//
// Next's default 404 follows the OS `prefers-color-scheme` and ignores the
// app's `data-mode`, so in the (dark by default) app it was dark text on a
// dark background. This one only uses theme tokens, so it follows both modes.
// It is also what the operator manuals show to someone without the role (the
// refusal is a "soft 404": see ADR-004 of integration-docs).
//
// Presentational on purpose: the page passes already-translated strings and
// the action (a link) as children.
// ============================================================

import type { ReactNode } from 'react';

export function NotFoundView({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  /** The way out: usually a <NotFoundAction />. */
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p aria-hidden className="text-primary text-6xl font-bold tracking-tight">
        {'404'}
      </p>
      <h1 className="text-foreground text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-muted-foreground max-w-md text-sm">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
