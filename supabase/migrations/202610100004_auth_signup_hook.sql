-- Keep the email provider available for administrator-created staff logins while
-- refusing public permanent-account creation. Anonymous identities are devices;
-- application RLS still requires a valid, active, single-use pairing.
create function public.senmiva_before_user_created(event jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    -- JSON equality deliberately accepts only the server's boolean true.
    -- Text "true", null, omitted values and user_metadata cannot authorize signup.
    when event -> 'user' -> 'is_anonymous' = 'true'::jsonb then '{}'::jsonb
    else pg_catalog.jsonb_build_object(
      'error', pg_catalog.jsonb_build_object(
        'http_code', 403,
        'message', 'Staff accounts are created by an administrator.'
      )
    )
  end;
$$;

revoke all on function public.senmiva_before_user_created(jsonb)
from public, anon, authenticated, service_role;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.senmiva_before_user_created(jsonb)
to supabase_auth_admin;
