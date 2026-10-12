-- Distinguish a new confirmed business account from revoked/existing staff
-- without exposing membership rows, tenant IDs or Auth record fields.
create function public.owner_setup_eligible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and (auth.jwt() -> 'is_anonymous') is not distinct from 'false'::jsonb
    and exists (
      select 1 from auth.users u
      where u.id = auth.uid()
        and u.is_anonymous = false
        and u.email_confirmed_at is not null
        and coalesce(u.email, '') <> ''
        and u.raw_app_meta_data ->> 'provider' = 'email'
        and coalesce(u.encrypted_password, '') <> ''
    )
    and not exists(select 1 from public.devices d where d.auth_user_id = auth.uid())
    and not exists(select 1 from public.memberships m where m.user_id = auth.uid());
$$;

revoke all on function public.owner_setup_eligible()
from public, anon, authenticated, service_role, analysis_writer;
grant execute on function public.owner_setup_eligible() to authenticated;
