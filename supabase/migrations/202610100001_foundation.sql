-- Senmiva foundation. Customer images are never stored in this database.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke create on schema public from public,anon,authenticated;
revoke all on schema private from public;
grant usage on schema private to authenticated;

do $$ begin
  if not exists (select from pg_roles where rolname = 'analysis_writer') then
    create role analysis_writer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now()
);
create table public.stores (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null references public.organizations(id),
  name text not null check (length(name) between 1 and 120), currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default true, created_at timestamptz not null default now(), unique (org_id,id)
);
create table public.memberships (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','manager','viewer')), active boolean not null default true,
  unique(org_id,id), unique(org_id,user_id)
);
create table public.membership_stores (
  org_id uuid not null, membership_id uuid not null, store_id uuid not null,
  primary key(org_id,membership_id,store_id),
  foreign key(org_id,membership_id) references public.memberships(org_id,id) on delete cascade,
  foreign key(org_id,store_id) references public.stores(org_id,id) on delete cascade
);
create table public.devices (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, store_id uuid not null,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  label text not null check(length(label) between 1 and 80), status text not null default 'active' check(status in ('active','revoked')),
  paired_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  unique(org_id,id), unique(org_id,store_id,id), foreign key(org_id,store_id) references public.stores(org_id,id)
);
create table public.device_pairing_codes (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, store_id uuid not null,
  code_hash bytea not null unique, label text not null check(length(label) between 1 and 80),
  created_by uuid not null references auth.users(id), expires_at timestamptz not null, used_at timestamptz,
  foreign key(org_id,store_id) references public.stores(org_id,id)
);

create table public.brands (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null references public.organizations(id),
  name text not null check(length(name) between 1 and 120), unique(org_id,id), unique(org_id,name)
);
create table public.categories (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null references public.organizations(id),
  name text not null check(length(name) between 1 and 80), unique(org_id,id), unique(org_id,name)
);
create table public.products (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null references public.organizations(id),
  brand_id uuid not null, category_id uuid not null, name text not null check(length(name) between 1 and 160),
  created_at timestamptz not null default now(), unique(org_id,id),
  foreign key(org_id,brand_id) references public.brands(org_id,id),
  foreign key(org_id,category_id) references public.categories(org_id,id)
);
create table public.product_variants (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, product_id uuid not null,
  sku text not null check(length(sku) between 1 and 80), active boolean not null default true,
  unique(org_id,id), unique(org_id,product_id,id), unique(org_id,sku),
  foreign key(org_id,product_id) references public.products(org_id,id)
);
create table public.ingredients (
  id uuid primary key default extensions.gen_random_uuid(), inci_name text not null unique check(length(inci_name) between 1 and 160)
);
create unique index ingredients_casefold on public.ingredients(lower(inci_name));
create table public.ingredient_aliases (
  alias text primary key check(length(alias) between 1 and 160), ingredient_id uuid not null references public.ingredients(id)
);
create unique index ingredient_alias_casefold on public.ingredient_aliases(lower(alias));
create table public.skin_types (
  id uuid primary key default extensions.gen_random_uuid(), slug text not null unique, label text not null
);
create table public.concerns (
  id uuid primary key default extensions.gen_random_uuid(), slug text not null unique, label text not null
);
create table public.formulation_versions (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, product_id uuid not null,
  version integer not null check(version > 0), status text not null default 'draft' check(status in ('draft','published')),
  complete boolean not null default false, created_at timestamptz not null default now(), published_at timestamptz,
  unique(org_id,id), unique(org_id,product_id,id), unique(org_id,product_id,version),
  foreign key(org_id,product_id) references public.products(org_id,id),
  check((status = 'draft' and published_at is null) or (status = 'published' and published_at is not null and complete))
);
create table public.formulation_ingredients (
  org_id uuid not null, formulation_version_id uuid not null, ingredient_id uuid not null references public.ingredients(id),
  position integer not null check(position > 0), primary key(org_id,formulation_version_id,ingredient_id),
  unique(org_id,formulation_version_id,position),
  foreign key(org_id,formulation_version_id) references public.formulation_versions(org_id,id) on delete cascade
);
create table public.unresolved_formulation_ingredients (
  org_id uuid not null, formulation_version_id uuid not null,
  position integer not null check(position > 0), entered_name text not null check(length(trim(entered_name)) between 1 and 160),
  primary key(org_id,formulation_version_id,position),
  foreign key(org_id,formulation_version_id) references public.formulation_versions(org_id,id) on delete cascade
);
create table public.formulation_skin_types (
  org_id uuid not null, formulation_version_id uuid not null, skin_type_id uuid not null references public.skin_types(id),
  primary key(org_id,formulation_version_id,skin_type_id),
  foreign key(org_id,formulation_version_id) references public.formulation_versions(org_id,id) on delete cascade
);
create table public.variant_formulations (
  org_id uuid not null, variant_id uuid not null, product_id uuid not null, formulation_version_id uuid not null,
  primary key(org_id,variant_id),
  foreign key(org_id,product_id,variant_id) references public.product_variants(org_id,product_id,id),
  foreign key(org_id,product_id,formulation_version_id) references public.formulation_versions(org_id,product_id,id)
);
create table public.store_listings (
  org_id uuid not null, store_id uuid not null, variant_id uuid not null,
  price_minor integer not null check(price_minor >= 0), currency text not null check(currency ~ '^[A-Z]{3}$'),
  stock integer not null default 0 check(stock >= 0), visible boolean not null default false,
  primary key(org_id,store_id,variant_id), foreign key(org_id,store_id) references public.stores(org_id,id),
  foreign key(org_id,variant_id) references public.product_variants(org_id,id)
);
create table public.recommendation_policy_versions (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null references public.organizations(id),
  version integer not null check(version > 0), status text not null default 'draft' check(status in ('draft','published')),
  published_at timestamptz, unique(org_id,id), unique(org_id,version),
  check((status='draft' and published_at is null) or (status='published' and published_at is not null))
);
create table public.concern_ingredient_rules (
  org_id uuid not null, policy_version_id uuid not null, concern_id uuid not null references public.concerns(id),
  ingredient_id uuid not null references public.ingredients(id), relevance integer not null check(relevance between 1 and 3),
  primary key(org_id,policy_version_id,concern_id,ingredient_id),
  foreign key(org_id,policy_version_id) references public.recommendation_policy_versions(org_id,id) on delete cascade
);

create table public.questionnaire_versions (
  id uuid primary key default extensions.gen_random_uuid(), version text not null unique, active boolean not null default true
);
create table public.kiosk_sessions (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, store_id uuid not null, device_id uuid not null,
  questionnaire_version_id uuid not null references public.questionnaire_versions(id),
  status text not null default 'active' check(status in ('active','finished','expired')),
  skin_type_id uuid references public.skin_types(id), skin_sensitive boolean, answers_completed_at timestamptz,
  started_at timestamptz not null default now(), last_activity_at timestamptz not null default now(), finished_at timestamptz,
  unique(org_id,id), foreign key(org_id,store_id,device_id) references public.devices(org_id,store_id,id)
);
create unique index one_active_session_per_device on public.kiosk_sessions(device_id) where status='active';
create table public.consents (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, session_id uuid not null,
  policy_version text not null check(length(policy_version) between 1 and 60), accepted boolean not null,
  recorded_at timestamptz not null default now(), unique(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_concerns (
  org_id uuid not null, session_id uuid not null, concern_id uuid not null references public.concerns(id),
  primary key(org_id,session_id,concern_id), foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_excluded_ingredients (
  org_id uuid not null, session_id uuid not null, ingredient_id uuid not null references public.ingredients(id),
  primary key(org_id,session_id,ingredient_id), foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.analyses (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, session_id uuid not null,
  request_id uuid not null unique, mode text not null check(mode in ('mock','model')),
  model_version text not null check(length(model_version) between 1 and 120),
  quality_status text not null check(quality_status in ('demo','accepted','retake','unavailable')),
  created_at timestamptz not null default now(), unique(org_id,id), unique(org_id,session_id,id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.observations (
  org_id uuid not null, analysis_id uuid not null, concern_id uuid not null references public.concerns(id),
  level text not null check(level in ('low','moderate','high')), score numeric(4,3) not null check(score between 0 and 1),
  primary key(org_id,analysis_id,concern_id), foreign key(org_id,analysis_id) references public.analyses(org_id,id) on delete cascade
);
create table public.recommendation_runs (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, session_id uuid not null,
  analysis_id uuid not null, policy_version_id uuid not null, created_at timestamptz not null default now(),
  unique(org_id,id), unique(org_id,analysis_id),
  foreign key(org_id,session_id,analysis_id) references public.analyses(org_id,session_id,id) on delete cascade,
  foreign key(org_id,policy_version_id) references public.recommendation_policy_versions(org_id,id)
);
create table public.recommendation_items (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, run_id uuid not null, variant_id uuid not null,
  rank integer not null check(rank between 1 and 3), score numeric(10,3) not null check(score >= 0),
  reason text not null check(length(reason) between 1 and 400), unique(org_id,id), unique(org_id,run_id,rank), unique(org_id,run_id,variant_id),
  foreign key(org_id,run_id) references public.recommendation_runs(org_id,id) on delete cascade,
  foreign key(org_id,variant_id) references public.product_variants(org_id,id)
);
create table public.recommendation_item_ingredients (
  org_id uuid not null, item_id uuid not null, ingredient_id uuid not null references public.ingredients(id),
  primary key(org_id,item_id,ingredient_id), foreign key(org_id,item_id) references public.recommendation_items(org_id,id) on delete cascade
);
create table public.recommendation_item_reasons (
  org_id uuid not null, item_id uuid not null, concern_id uuid not null references public.concerns(id),
  ingredient_id uuid not null references public.ingredients(id), relevance integer not null check(relevance between 1 and 3),
  primary key(org_id,item_id,concern_id,ingredient_id), foreign key(org_id,item_id) references public.recommendation_items(org_id,id) on delete cascade
);
create table public.audit_events (
  id bigint generated always as identity primary key, org_id uuid not null references public.organizations(id),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check(length(action) between 1 and 80), resource_id uuid, created_at timestamptz not null default now()
);
create table public.store_daily_metrics (
  org_id uuid not null, store_id uuid not null, day date not null,
  sessions_started integer not null default 0 check(sessions_started >= 0),
  sessions_completed integer not null default 0 check(sessions_completed >= 0),
  sessions_analyzed integer not null default 0 check(sessions_analyzed >= 0),
  primary key(org_id,store_id,day), foreign key(org_id,store_id) references public.stores(org_id,id)
);

-- All authorization helpers use database membership, never a client organization claim.
create function private.staff_role(p_org uuid) returns text language sql stable security definer set search_path='' as $$
  select m.role from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.active
    and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
$$;
create function private.can_manage_store(p_org uuid,p_store uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.active
    and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) and
    (m.role='owner' or (m.role='manager' and exists(select 1 from public.membership_stores ms where ms.org_id=m.org_id and ms.membership_id=m.id and ms.store_id=p_store))))
$$;
create function private.can_read_store(p_org uuid,p_store uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.active
    and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) and
    (m.role='owner' or exists(select 1 from public.membership_stores ms where ms.org_id=m.org_id and ms.membership_id=m.id and ms.store_id=p_store)))
$$;
create function private.own_device(p_org uuid,p_device uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.devices d join public.stores s on s.org_id=d.org_id and s.id=d.store_id
    where d.id=p_device and d.org_id=p_org and d.auth_user_id=auth.uid() and d.status='active' and s.active
    and coalesce((auth.jwt()->>'is_anonymous')::boolean,false))
$$;
create function private.own_session(p_org uuid,p_session uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.kiosk_sessions s where s.org_id=p_org and s.id=p_session and s.status='active'
    and s.last_activity_at > now()-interval '15 minutes' and private.own_device(s.org_id,s.device_id))
$$;
revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

-- Published snapshots are immutable, including their normalized child rows.
create function private.guard_published() returns trigger language plpgsql set search_path='' as $$
begin
  if old.status='published' then raise exception 'Published version is immutable' using errcode='23514'; end if;
  if tg_table_name='formulation_versions' and tg_op='UPDATE' and new.status='published' then
    if exists(select 1 from public.unresolved_formulation_ingredients where org_id=new.org_id and formulation_version_id=new.id)
      or not exists(select 1 from public.formulation_ingredients where org_id=new.org_id and formulation_version_id=new.id) then
      raise exception 'Published formulations require fully resolved canonical INCI' using errcode='23514';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger immutable_formulation before update or delete on public.formulation_versions for each row execute function private.guard_published();
create trigger immutable_policy before update or delete on public.recommendation_policy_versions for each row execute function private.guard_published();
create function private.guard_version_child() returns trigger language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_id uuid; v_status text;
begin
  if tg_op='DELETE' then v_org:=old.org_id; else v_org:=new.org_id; end if;
  if tg_table_name='concern_ingredient_rules' then
    if tg_op='DELETE' then v_id:=old.policy_version_id; else v_id:=new.policy_version_id; end if;
    select status into v_status from public.recommendation_policy_versions where org_id=v_org and id=v_id for update;
  else
    if tg_op='DELETE' then v_id:=old.formulation_version_id; else v_id:=new.formulation_version_id; end if;
    select status into v_status from public.formulation_versions where org_id=v_org and id=v_id for update;
  end if;
  if v_status='published' then raise exception 'Published version children are immutable' using errcode='23514'; end if;
  if tg_op='UPDATE' and to_jsonb(old)->>'formulation_version_id' is distinct from to_jsonb(new)->>'formulation_version_id' then
    raise exception 'Version assignment is immutable' using errcode='23514';
  end if;
  if tg_op='UPDATE' and tg_table_name='concern_ingredient_rules' and to_jsonb(old)->>'policy_version_id' is distinct from to_jsonb(new)->>'policy_version_id' then
    raise exception 'Version assignment is immutable' using errcode='23514';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger guard_formulation_ingredients before insert or update or delete on public.formulation_ingredients for each row execute function private.guard_version_child();
create trigger guard_unresolved_ingredients before insert or update or delete on public.unresolved_formulation_ingredients for each row execute function private.guard_version_child();
create trigger guard_formulation_types before insert or update or delete on public.formulation_skin_types for each row execute function private.guard_version_child();
create trigger guard_policy_rules before insert or update or delete on public.concern_ingredient_rules for each row execute function private.guard_version_child();

-- Default-deny: no client writes are granted. RPCs below make explicit assertions.
do $$ declare t text; begin
  foreach t in array array['organizations','stores','memberships','membership_stores','devices','device_pairing_codes','brands','categories','products','product_variants','ingredients','ingredient_aliases','skin_types','concerns','formulation_versions','formulation_ingredients','unresolved_formulation_ingredients','formulation_skin_types','variant_formulations','store_listings','recommendation_policy_versions','concern_ingredient_rules','questionnaire_versions','kiosk_sessions','consents','session_concerns','session_excluded_ingredients','analyses','observations','recommendation_runs','recommendation_items','recommendation_item_ingredients','recommendation_item_reasons','audit_events','store_daily_metrics'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
  end loop;
end $$;
revoke all on all sequences in schema public from anon,authenticated;
grant select on public.ingredients,public.ingredient_aliases,public.skin_types,public.concerns,public.questionnaire_versions to authenticated;
create policy reference_read on public.ingredients for select to authenticated using(true);
create policy reference_read on public.ingredient_aliases for select to authenticated using(true);
create policy reference_read on public.skin_types for select to authenticated using(true);
create policy reference_read on public.concerns for select to authenticated using(true);
create policy reference_read on public.questionnaire_versions for select to authenticated using(active);
grant select on public.organizations,public.stores,public.memberships,public.membership_stores,public.devices,public.brands,public.categories,public.products,public.product_variants,public.formulation_versions,public.formulation_ingredients,public.unresolved_formulation_ingredients,public.formulation_skin_types,public.variant_formulations,public.store_listings,public.recommendation_policy_versions,public.concern_ingredient_rules,public.kiosk_sessions,public.consents,public.session_concerns,public.session_excluded_ingredients,public.analyses,public.observations,public.recommendation_runs,public.recommendation_items,public.recommendation_item_ingredients,public.recommendation_item_reasons,public.audit_events,public.store_daily_metrics to authenticated;
create policy organization_read on public.organizations for select to authenticated using(private.staff_role(id) is not null);
create policy store_read on public.stores for select to authenticated using(private.can_read_store(org_id,id) or exists(select 1 from public.devices d where d.org_id=stores.org_id and d.store_id=stores.id and private.own_device(d.org_id,d.id)));
create policy membership_read on public.memberships for select to authenticated using(user_id=auth.uid() or private.staff_role(org_id)='owner');
create policy membership_stores_read on public.membership_stores for select to authenticated using(private.staff_role(org_id)='owner' or exists(select 1 from public.memberships m where m.org_id=membership_stores.org_id and m.id=membership_stores.membership_id and m.user_id=auth.uid()));
create policy device_read on public.devices for select to authenticated using(private.can_manage_store(org_id,store_id) or private.own_device(org_id,id));
do $$ declare t text; begin
  foreach t in array array['brands','categories','products','product_variants','formulation_versions','formulation_ingredients','unresolved_formulation_ingredients','formulation_skin_types','variant_formulations','recommendation_policy_versions','concern_ingredient_rules'] loop
    execute format('create policy catalog_staff_read on public.%I for select to authenticated using(private.staff_role(org_id) in (''owner'',''manager''))',t);
  end loop;
end $$;
create policy listing_read on public.store_listings for select to authenticated using(private.can_manage_store(org_id,store_id));
create policy session_device_read on public.kiosk_sessions for select to authenticated using(private.own_session(org_id,id));
do $$ declare t text; begin
  foreach t in array array['consents','session_concerns','session_excluded_ingredients','analyses','recommendation_runs'] loop
    execute format('create policy session_device_read on public.%I for select to authenticated using(private.own_session(org_id,session_id))',t);
  end loop;
end $$;
create policy observation_device_read on public.observations for select to authenticated using(exists(select 1 from public.analyses a where a.org_id=observations.org_id and a.id=observations.analysis_id and private.own_session(a.org_id,a.session_id)));
create policy recommendation_device_read on public.recommendation_items for select to authenticated using(exists(select 1 from public.recommendation_runs r where r.org_id=recommendation_items.org_id and r.id=recommendation_items.run_id and private.own_session(r.org_id,r.session_id)));
create policy recommendation_ingredient_device_read on public.recommendation_item_ingredients for select to authenticated using(exists(select 1 from public.recommendation_items i join public.recommendation_runs r on r.org_id=i.org_id and r.id=i.run_id where i.org_id=recommendation_item_ingredients.org_id and i.id=recommendation_item_ingredients.item_id and private.own_session(r.org_id,r.session_id)));
create policy recommendation_reason_device_read on public.recommendation_item_reasons for select to authenticated using(exists(select 1 from public.recommendation_items i join public.recommendation_runs r on r.org_id=i.org_id and r.id=i.run_id where i.org_id=recommendation_item_reasons.org_id and i.id=recommendation_item_reasons.item_id and private.own_session(r.org_id,r.session_id)));
create policy audit_owner_read on public.audit_events for select to authenticated using(private.staff_role(org_id)='owner');
create policy metric_staff_read on public.store_daily_metrics for select to authenticated using(private.can_read_store(org_id,store_id));

-- Index foreign keys used for tenant filtering and privacy cleanup.
create index stores_org on public.stores(org_id);
create index memberships_user on public.memberships(user_id,org_id) where active;
create index devices_store on public.devices(org_id,store_id);
create index sessions_cleanup on public.kiosk_sessions(last_activity_at) where status='active';
create index consent_retention on public.consents(recorded_at);
create index audit_retention on public.audit_events(created_at);
create index analyses_session on public.analyses(org_id,session_id);
create index pairing_expiry on public.device_pairing_codes(expires_at);

-- Revoke implicit function execution added by PostgreSQL defaults.
revoke all on all functions in schema private from public;
grant execute on function private.staff_role(uuid),private.can_manage_store(uuid,uuid),private.can_read_store(uuid,uuid),private.own_device(uuid,uuid),private.own_session(uuid,uuid) to authenticated;
