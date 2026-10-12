-- Business owners may register a confirmed email/password identity. This never
-- gives customers accounts or derives tenancy/roles from writable user metadata.
create or replace function public.senmiva_before_user_created(event jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when event -> 'user' -> 'is_anonymous' = 'true'::jsonb then '{}'::jsonb
    when event -> 'user' -> 'is_anonymous' = 'false'::jsonb
      and event -> 'user' -> 'app_metadata' ->> 'provider' = 'email'
      and pg_catalog.jsonb_typeof(event -> 'user' -> 'email') = 'string'
      and pg_catalog.length(event -> 'user' ->> 'email') between 3 and 320
      and event -> 'user' ->> 'email' ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      then '{}'::jsonb
    else pg_catalog.jsonb_build_object('error', pg_catalog.jsonb_build_object(
      'http_code', 403, 'message', 'Use email and password to create a business account.'
    ))
  end;
$$;

revoke all on function public.senmiva_before_user_created(jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.senmiva_before_user_created(jsonb) to supabase_auth_admin;

-- Published mock rules have durable provenance; existing operator-configured
-- policies keep their original meaning. No image or customer data is introduced.
alter table public.recommendation_policy_versions
  add column source text not null default 'operator-configured'
  check (source in ('operator-configured', 'mock-onboarding-v1'));

create function public.create_owner_workspace(p_organization_name text, p_store_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_organization_name text := pg_catalog.btrim(p_organization_name);
  v_store_name text := pg_catalog.btrim(p_store_name);
  v_user auth.users;
  v_membership public.memberships;
  v_store public.stores;
  v_organization_id uuid;
  v_policy_id uuid;
  v_rule_count integer;
begin
  if v_uid is null or auth.jwt() -> 'is_anonymous' is distinct from 'false'::jsonb then
    raise exception 'Confirmed business email account required' using errcode = '42501';
  end if;
  if v_organization_name is null or pg_catalog.length(v_organization_name) not between 1 and 120
    or v_store_name is null or pg_catalog.length(v_store_name) not between 1 and 120
    or v_organization_name ~ '[[:cntrl:]]' or v_store_name ~ '[[:cntrl:]]' then
    raise exception 'Organization and store names must contain 1 to 120 characters' using errcode = '22023';
  end if;

  -- Every attempt for this verified identity is serialized, including retries.
  -- Locking the Auth row also prevents concurrent membership FK enrollment from
  -- racing this first-workspace decision. No browser supplies a user/tenant ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('senmiva-owner-onboarding:' || v_uid::text, 0));
  select * into v_user from auth.users where id = v_uid for update;
  if v_user.id is null or v_user.is_anonymous is distinct from false
    or v_user.email_confirmed_at is null or coalesce(v_user.email, '') = ''
    or v_user.raw_app_meta_data ->> 'provider' is distinct from 'email'
    or coalesce(v_user.encrypted_password, '') = '' then
    raise exception 'Confirmed business email account required' using errcode = '42501';
  end if;
  if exists(select 1 from public.devices where auth_user_id = v_uid) then
    raise exception 'Device identities cannot create a business workspace' using errcode = '42501';
  end if;

  select * into v_membership from public.memberships where user_id = v_uid order by org_id limit 1;
  if v_membership.id is not null then
    if not v_membership.active or v_membership.role <> 'owner'
      or (select count(*) from public.memberships where user_id = v_uid) <> 1 then
      raise exception 'An existing staff membership cannot create another workspace' using errcode = '42501';
    end if;
    select * into v_store from public.stores where org_id = v_membership.org_id order by created_at, id limit 1;
    if v_store.id is null or not v_store.active
      or v_store.currency <> 'USD'
      or v_store.name <> v_store_name
      or (select name from public.organizations where id = v_membership.org_id) <> v_organization_name then
      raise exception 'This account already belongs to a different workspace' using errcode = '23505';
    end if;
    return public.staff_context();
  end if;

  insert into public.organizations(name) values(v_organization_name) returning id into v_organization_id;
  insert into public.stores(org_id, name, currency) values(v_organization_id, v_store_name, 'USD') returning * into v_store;
  insert into public.memberships(org_id, user_id, role) values(v_organization_id, v_uid, 'owner');
  insert into public.recommendation_policy_versions(org_id, version, source)
    values(v_organization_id, 1, 'mock-onboarding-v1') returning id into v_policy_id;

  -- Frozen manually curated demonstration relevance, never a trained model or
  -- medical efficacy claim. Populate normalized rules before immutable publish.
  insert into public.concern_ingredient_rules(org_id, policy_version_id, concern_id, ingredient_id, relevance)
  select v_organization_id, v_policy_id, c.id, i.id, r.relevance
  from (values
    ('dehydration', 'Glycerin', 3),
    ('dehydration', 'Sodium Hyaluronate', 3),
    ('dehydration', 'Hyaluronic Acid', 3),
    ('dehydration', 'Panthenol', 2),
    ('dehydration', 'Ceramide NP', 2),
    ('dehydration', 'Squalane', 2),
    ('dehydration', 'Betaine', 2),
    ('texture', 'Gluconolactone', 3),
    ('texture', 'Lactic Acid', 3),
    ('texture', 'Salicylic Acid', 3),
    ('texture', 'Niacinamide', 2),
    ('uneven_tone', 'Niacinamide', 3),
    ('uneven_tone', 'Ascorbyl Glucoside', 3),
    ('uneven_tone', 'Ascorbic Acid', 3),
    ('uneven_tone', 'Lactic Acid', 1),
    ('fine_lines', 'Palmitoyl Tripeptide-1', 3),
    ('fine_lines', 'Niacinamide', 2),
    ('fine_lines', 'Sodium Hyaluronate', 2),
    ('fine_lines', 'Hyaluronic Acid', 2)
  ) as r(concern, ingredient, relevance)
  join public.concerns c on c.slug = r.concern
  join public.ingredients i on i.inci_name = r.ingredient;
  get diagnostics v_rule_count = row_count;
  if v_rule_count <> 19 then
    raise exception 'Mock policy reference data is incomplete' using errcode = '23514';
  end if;
  update public.recommendation_policy_versions set status = 'published', published_at = now()
    where org_id = v_organization_id and id = v_policy_id;
  insert into public.audit_events(org_id, actor_user_id, action, resource_id)
    values(v_organization_id, v_uid, 'workspace.created_mock_policy', v_organization_id);
  return public.staff_context();
end;
$$;

revoke all on function public.create_owner_workspace(text, text)
from public, anon, authenticated, service_role, analysis_writer;
grant execute on function public.create_owner_workspace(text, text) to authenticated;
