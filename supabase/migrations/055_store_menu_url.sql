-- ============================================================
-- 055_store_menu_url
--
-- order-journey-recovery, ticket #2. Each store has its own Digital menu
-- (an external ordering site on a different domain per store). NULL means
-- the store has no menu. The application validates the value; the CHECK is
-- the last line of defence: https only. Idempotent. RLS on `stores` is
-- unchanged (a column addition inherits the table policies).
-- ============================================================

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS menu_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stores'::regclass
      AND conname = 'stores_menu_url_https_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_menu_url_https_check
      CHECK (menu_url IS NULL OR menu_url ~* '^https://[^[:space:]]+$');
  END IF;
END
$$;

COMMENT ON COLUMN public.stores.menu_url IS
  'Digital menu address for this store (https URL); NULL = store has no menu.';
