-- ============================================================
-- 063_store_key_and_notification_connection
--
-- direct-order-events, ticket #17. A store gets three optional fields that
-- together form its STORE KEY `CODE/STORE ACRONYM/BUSINESS ACRONYM`
-- (e.g. `89/RPA/BLC`), and an optional default WhatsApp connection for
-- notices. Idempotent, forward only. RLS on `stores` is unchanged (column
-- additions inherit the table policies).
--
-- * The key exists only when all three parts are filled. It is unique per
--   account, case-insensitively: `store_key_normalized` (generated, lower
--   case) carries a partial unique index. Existing stores have no key.
-- * The application trims and validates; the CHECKs are the last line of
--   defence (no '/', no blank, max 40, already trimmed).
-- * `notification_connection_id` is validated by the application (same
--   store, same account, WhatsApp); the FK only guarantees it exists and
--   clears it when the connection is deleted.
-- ============================================================

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS store_code TEXT,
  ADD COLUMN IF NOT EXISTS store_acronym TEXT,
  ADD COLUMN IF NOT EXISTS business_acronym TEXT,
  ADD COLUMN IF NOT EXISTS notification_connection_id UUID
    REFERENCES public.channel_connections(id) ON DELETE SET NULL;

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['store_code', 'store_acronym', 'business_acronym']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.stores'::regclass
        AND conname = 'stores_' || col || '_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.stores ADD CONSTRAINT %I CHECK (%I IS NULL OR (%I = btrim(%I) AND %I <> '''' AND char_length(%I) <= 40 AND position(''/'' in %I) = 0))',
        'stores_' || col || '_check', col, col, col, col, col, col
      );
    END IF;
  END LOOP;
END
$$;

-- Generated: lower-cased key, NULL unless the three parts are all present.
-- Added separately so re-running the file does not fail on the column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stores'
      AND column_name = 'store_key_normalized'
  ) THEN
    ALTER TABLE public.stores
      ADD COLUMN store_key_normalized TEXT GENERATED ALWAYS AS (
        CASE
          WHEN store_code IS NOT NULL
            AND store_acronym IS NOT NULL
            AND business_acronym IS NOT NULL
          THEN lower(store_code || '/' || store_acronym || '/' || business_acronym)
        END
      ) STORED;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS stores_account_store_key_uniq
  ON public.stores (account_id, store_key_normalized)
  WHERE store_key_normalized IS NOT NULL;

COMMENT ON COLUMN public.stores.store_key_normalized IS
  'Lower-cased CODE/STORE ACRONYM/BUSINESS ACRONYM; NULL unless all three parts are set. Unique per account.';
COMMENT ON COLUMN public.stores.notification_connection_id IS
  'Default WhatsApp connection for notices when the store has several; NULL = none chosen.';
