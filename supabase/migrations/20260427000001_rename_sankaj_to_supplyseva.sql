-- 20260427000001_rename_sankaj_to_supplyseva.sql
--
-- Rebranding: "Sankaj" → "Supply Seva"
-- 1. Rename admin login emails (e.g. admin@sankaj.com → admin@supplyseva.com)
--    in both auth.users and public.users so logins continue to work.
-- 2. Update any business records that reference the old self-vendor name
--    so the Silo export filter (which excludes "Supply Seva") continues to
--    work correctly.

BEGIN;

-- ── 1. Auth user email rename (only if a Sankaj-domain account exists) ──
-- auth.users
UPDATE auth.users
   SET email                 = REPLACE(email, '@sankaj.com', '@supplyseva.com'),
       raw_user_meta_data    = COALESCE(raw_user_meta_data, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'previous_email', email,
                                      'rebranded_at', NOW()
                                    ),
       updated_at            = NOW()
 WHERE email ILIKE '%@sankaj.com';

-- auth.identities — keep identity_data.email in sync so Supabase Auth resolves
-- the correct provider record on next login.
UPDATE auth.identities
   SET identity_data = jsonb_set(
                          identity_data,
                          '{email}',
                          to_jsonb(REPLACE(identity_data->>'email', '@sankaj.com', '@supplyseva.com'))
                        ),
       updated_at = NOW()
 WHERE provider = 'email'
   AND identity_data->>'email' ILIKE '%@sankaj.com';

-- public.users mirror table (if it tracks the email)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
  ) THEN
    EXECUTE $sql$
      UPDATE public.users
         SET email      = REPLACE(email, '@sankaj.com', '@supplyseva.com'),
             updated_at = NOW()
       WHERE email ILIKE '%@sankaj.com';
    $sql$;
  END IF;
END$$;

-- ── 2. Business data rename ──
UPDATE public.invoices
   SET vendor_name = 'Supply Seva'
 WHERE vendor_name = 'Sankaj';

UPDATE public.invoices
   SET bill_to_name = 'Supply Seva'
 WHERE bill_to_name = 'Sankaj';

UPDATE public.orders
   SET customer_name = 'Supply Seva'
 WHERE customer_name = 'Sankaj';

COMMIT;
