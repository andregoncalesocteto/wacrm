-- ============================================================
-- 048_filter_contacts_identity_search.sql — identity-aware contact search
--
-- Extends `filter_contacts_by_tags` (025) in two ways, keeping the
-- signature and the return shape:
--
--   1. The search term also matches any `contact_identities` row of the
--      contact (handle or external_id, ILIKE) — a Telegram contact has no
--      phone/email to match, so `@maria` / a chat id must find it (a leading
--      `@` is ignored for the identity match; handles are stored without it).
--   2. An empty (or NULL) `p_tag_ids` means "no tag filter". Before, it
--      matched nothing. The Contacts page now uses this function for every
--      search, so the identity match runs server-side (EXISTS subquery, no
--      capped id pre-lookup and no oversized IN clause).
--
-- Security is unchanged: SECURITY INVOKER, so RLS on contacts,
-- contact_tags and contact_identities scopes the result to the caller's
-- account.
--
-- Idempotent — CREATE OR REPLACE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE (
        COALESCE(cardinality(p_tag_ids), 0) = 0
        OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids)
        )
      )
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
        OR EXISTS (
          SELECT 1 FROM contact_identities ci
          WHERE ci.contact_id = c.id
            AND (
              ci.handle ILIKE '%' || NULLIF(ltrim(p_search, '@'), '') || '%'
              OR ci.external_id ILIKE '%' || NULLIF(ltrim(p_search, '@'), '') || '%'
            )
        )
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) TO authenticated;
