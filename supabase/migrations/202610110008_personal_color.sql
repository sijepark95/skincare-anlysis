-- Merchant-reviewed shade snapshots and separately consented transient color suggestions.
-- No images, raw provider JSON, generated prose or customer profiles are persisted.
create table public.variant_shade_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null,
  variant_id uuid not null,
  version integer not null check(version > 0),
  shade_name text not null check(length(trim(shade_name)) between 1 and 80),
  hue_family text not null check(hue_family in ('peach','coral','rose','berry','nude','red','mauve')),
  undertone text not null check(undertone in ('warm','cool','neutral')),
  intensity text not null check(intensity in ('soft','clear')),
  finish text not null check(finish in ('gloss','satin','matte')),
  swatch_hex text not null check(swatch_hex ~ '^#[0-9A-F]{6}$'),
  reviewed_at timestamptz not null default now(),
  unique(org_id,id), unique(org_id,variant_id,id), unique(org_id,variant_id,version),
  foreign key(org_id,variant_id) references public.product_variants(org_id,id)
);
create table public.variant_shades (
  org_id uuid not null, variant_id uuid not null, shade_version_id uuid not null,
  primary key(org_id,variant_id),
  foreign key(org_id,variant_id) references public.product_variants(org_id,id),
  foreign key(org_id,variant_id,shade_version_id) references public.variant_shade_versions(org_id,variant_id,id)
);
create function private.guard_published_shade() returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Published shade version is immutable' using errcode='23514';
end $$;
create trigger immutable_shade before update or delete on public.variant_shade_versions
  for each row execute function private.guard_published_shade();
revoke all on function private.guard_published_shade() from public,anon,authenticated,analysis_writer,service_role;

create table public.session_color_consents (
  org_id uuid not null, session_id uuid not null,
  notice_version text not null check(notice_version='2026-10-personal-color-photo-v1'),
  accepted boolean not null, recorded_at timestamptz not null default now(),
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_color_attempts (
  org_id uuid not null, session_id uuid not null,
  claimed_at timestamptz not null default now(), invalidated_at timestamptz,
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_color_analyses (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, session_id uuid not null,
  request_id uuid not null unique,
  model_version text not null check(model_version='gpt-4.1-mini-2025-04-14'),
  prompt_version text not null check(prompt_version='personal-color-suggestion-v1'),
  image_quality text not null check(image_quality in ('usable','limited','not_assessable')),
  undertone text not null check(undertone in ('warm','cool','neutral','uncertain')),
  chroma text not null check(chroma in ('soft','clear','uncertain')),
  created_at timestamptz not null default now(),
  unique(org_id,id), unique(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade,
  check(image_quality='usable' or (undertone='uncertain' and chroma='uncertain'))
);
create table public.session_color_quality_flags (
  org_id uuid not null, analysis_id uuid not null,
  flag text not null check(flag in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited')),
  primary key(org_id,analysis_id,flag),
  foreign key(org_id,analysis_id) references public.session_color_analyses(org_id,id) on delete cascade
);
create table public.session_color_preferences (
  org_id uuid not null, session_id uuid not null,
  palette_id text not null check(palette_id in ('warm_soft','warm_clear','cool_soft','cool_clear','neutral_soft','neutral_clear')),
  finish text not null check(finish in ('any','gloss','satin','matte')),
  confirmed_at timestamptz not null default now(),
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
do $$ declare t text; begin
  foreach t in array array['variant_shade_versions','variant_shades','session_color_consents','session_color_attempts','session_color_analyses','session_color_quality_flags','session_color_preferences'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
  foreach t in array array['variant_shade_versions','variant_shades'] loop
    execute format('create policy shade_store_read on public.%I for select to authenticated using(exists(select 1 from public.store_listings l where l.org_id=%I.org_id and l.variant_id=%I.variant_id and (private.can_manage_store(l.org_id,l.store_id) or exists(select 1 from public.devices d where d.org_id=l.org_id and d.store_id=l.store_id and private.own_device(d.org_id,d.id)))))',t,t,t);
  end loop;
  foreach t in array array['session_color_consents','session_color_attempts','session_color_analyses','session_color_preferences'] loop
    execute format('create policy color_device_read on public.%I for select to authenticated using(private.own_session(org_id,session_id))',t);
  end loop;
end $$;
create policy color_device_read on public.session_color_quality_flags for select to authenticated
  using(exists(select 1 from public.session_color_analyses a where a.org_id=session_color_quality_flags.org_id and a.id=session_color_quality_flags.analysis_id and private.own_session(a.org_id,a.session_id)));

create function public.publish_lip_shade(p_store_id uuid,p_variant_id uuid,p_shade jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.stores; v public.product_variants; v_id uuid; v_version integer;
begin
  select * into s from public.stores where id=p_store_id and active;
  if s.id is null or private.staff_role(s.org_id) is distinct from 'owner' then raise exception 'Organization owner required for shade publication' using errcode='42501'; end if;
  select * into v from public.product_variants where id=p_variant_id and org_id=s.org_id for update;
  if v.id is null or not v.active
    or not exists(select 1 from public.products p join public.categories c on c.org_id=p.org_id and c.id=p.category_id where p.org_id=v.org_id and p.id=v.product_id and c.name='lip_color')
    or not exists(select 1 from public.store_listings where org_id=s.org_id and store_id=s.id and variant_id=v.id)
    or not exists(select 1 from public.variant_formulations vf join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id where vf.org_id=v.org_id and vf.variant_id=v.id and f.status='published' and f.complete
      and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)
      and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id))
    then raise exception 'Published complete lip-color variant and store listing required' using errcode='22023'; end if;
  if jsonb_typeof(p_shade) is distinct from 'object' or octet_length(p_shade::text)>2048
    or (select count(*) from jsonb_object_keys(p_shade))<>7
    or exists(select 1 from jsonb_object_keys(p_shade) k where k not in ('shadeName','hueFamily','undertone','intensity','finish','swatchHex','reviewed'))
    or exists(select 1 from jsonb_each(p_shade) e where e.key<>'reviewed' and jsonb_typeof(e.value)<>'string')
    or p_shade->'reviewed' is distinct from 'true'::jsonb
    or length(trim(p_shade->>'shadeName')) not between 1 and 80
    or p_shade->>'hueFamily' not in ('peach','coral','rose','berry','nude','red','mauve')
    or p_shade->>'undertone' not in ('warm','cool','neutral')
    or p_shade->>'intensity' not in ('soft','clear')
    or p_shade->>'finish' not in ('gloss','satin','matte')
    or (p_shade->>'swatchHex') !~* '^#[0-9a-f]{6}$'
    then raise exception 'Exact reviewed shade metadata required' using errcode='22023'; end if;
  select coalesce(max(version),0)+1 into v_version from public.variant_shade_versions where org_id=s.org_id and variant_id=v.id;
  insert into public.variant_shade_versions(org_id,variant_id,version,shade_name,hue_family,undertone,intensity,finish,swatch_hex)
    values(s.org_id,v.id,v_version,trim(p_shade->>'shadeName'),p_shade->>'hueFamily',p_shade->>'undertone',p_shade->>'intensity',p_shade->>'finish',upper(p_shade->>'swatchHex')) returning id into v_id;
  insert into public.variant_shades(org_id,variant_id,shade_version_id) values(s.org_id,v.id,v_id)
    on conflict(org_id,variant_id) do update set shade_version_id=excluded.shade_version_id;
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(s.org_id,auth.uid(),'catalog.shade_published',v.id);
  return v_id;
end $$;

create function public.read_store_lip_shades(p_store_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.stores; v_device boolean; v_result jsonb;
begin
  select * into s from public.stores where id=p_store_id and active;
  v_device:=exists(select 1 from public.devices d where d.org_id=s.org_id and d.store_id=s.id and private.own_device(d.org_id,d.id));
  if s.id is null or not (private.can_manage_store(s.org_id,s.id) or v_device) then raise exception 'Store catalog permission required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',sv.id,'variantId',v.id,'organizationId',sv.org_id,'versionId',sv.id,'version',sv.version,'shadeName',sv.shade_name,'hueFamily',sv.hue_family,'undertone',sv.undertone,'intensity',sv.intensity,'finish',sv.finish,'swatchHex',sv.swatch_hex,'reviewed',true) order by v.sku),'[]'::jsonb) into v_result
  from public.store_listings l join public.product_variants v on v.org_id=l.org_id and v.id=l.variant_id
  join public.products p on p.org_id=v.org_id and p.id=v.product_id join public.categories c on c.org_id=p.org_id and c.id=p.category_id and c.name='lip_color'
  join public.variant_shades vs on vs.org_id=v.org_id and vs.variant_id=v.id
  join public.variant_shade_versions sv on sv.org_id=vs.org_id and sv.variant_id=vs.variant_id and sv.id=vs.shade_version_id
  left join public.variant_formulations vf on vf.org_id=v.org_id and vf.variant_id=v.id
  left join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id
  where l.org_id=s.org_id and l.store_id=s.id and (not v_device or (v.active and l.visible and l.stock>0 and f.status='published' and f.complete
    and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)
    and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)));
  return v_result;
end $$;

create function public.record_color_consent(p_session_id uuid,p_notice_version text,p_accepted boolean) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_notice_version is distinct from '2026-10-personal-color-photo-v1' or p_accepted is null then raise exception 'Explicit supported color photo consent required' using errcode='22023'; end if;
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  insert into public.session_color_consents(org_id,session_id,notice_version,accepted) values(s.org_id,s.id,p_notice_version,p_accepted)
    on conflict(org_id,session_id) do update set accepted=excluded.accepted,recorded_at=now();
  if not p_accepted then
    update public.session_color_attempts set invalidated_at=coalesce(invalidated_at,now()) where org_id=s.org_id and session_id=s.id;
    delete from public.session_color_analyses where org_id=s.org_id and session_id=s.id;
    delete from public.session_color_preferences where org_id=s.org_id and session_id=s.id;
  end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;
create function public.claim_kiosk_color_analysis(p_session_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_claimed uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.session_color_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-personal-color-photo-v1')
    then raise exception 'Separate color photo consent required' using errcode='42501'; end if;
  if s.answers_completed_at is null then raise exception 'Completed preferences required' using errcode='22023'; end if;
  if exists(select 1 from public.session_color_analyses where org_id=s.org_id and session_id=s.id) then return false; end if;
  insert into public.session_color_attempts(org_id,session_id) values(s.org_id,s.id) on conflict(org_id,session_id) do nothing returning session_id into v_claimed;
  return v_claimed is not null;
end $$;

create function public.write_openai_color_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_result jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_id uuid; v_flags jsonb; v_flag text;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or s.answers_completed_at is null
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    or not exists(select 1 from public.session_color_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-personal-color-photo-v1')
    or not exists(select 1 from public.session_color_attempts where org_id=s.org_id and session_id=s.id and invalidated_at is null)
    then raise exception 'Active consented color claim required' using errcode='42501'; end if;
  if p_request_id is distinct from p_session_id or p_model_version is distinct from 'gpt-4.1-mini-2025-04-14'
    or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>4096
    or (select count(*) from jsonb_object_keys(p_result))<>8
    or exists(select 1 from jsonb_object_keys(p_result) k where k not in ('request_id','mode','model_version','prompt_version','image_quality','undertone','chroma','quality_flags'))
    or exists(select 1 from jsonb_each(p_result) e where e.key<>'quality_flags' and jsonb_typeof(e.value)<>'string')
    or p_result->>'request_id' is distinct from p_request_id::text or p_result->>'mode' is distinct from 'openai_color'
    or p_result->>'model_version' is distinct from p_model_version or p_result->>'prompt_version' is distinct from 'personal-color-suggestion-v1'
    or p_result->>'image_quality' not in ('usable','limited','not_assessable')
    or p_result->>'undertone' not in ('warm','cool','neutral','uncertain') or p_result->>'chroma' not in ('soft','clear','uncertain')
    or jsonb_typeof(p_result->'quality_flags') is distinct from 'array'
    then raise exception 'Invalid bounded color analysis contract' using errcode='22023'; end if;
  v_flags:=p_result->'quality_flags';
  if jsonb_array_length(v_flags)>8 or (select count(distinct value) from jsonb_array_elements(v_flags))<>jsonb_array_length(v_flags)
    or exists(select 1 from jsonb_array_elements(v_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited'))
    or (p_result->>'image_quality'='usable' and jsonb_array_length(v_flags)<>0)
    or (p_result->>'image_quality'<>'usable' and (jsonb_array_length(v_flags)=0 or p_result->>'undertone'<>'uncertain' or p_result->>'chroma'<>'uncertain'))
    or ((v_flags ? 'no_face' or v_flags ? 'multiple_faces') and p_result->>'image_quality'<>'not_assessable')
    then raise exception 'Color categories and quality flags disagree' using errcode='22023'; end if;
  select id into v_id from public.session_color_analyses where org_id=s.org_id and session_id=s.id;
  if v_id is not null then return v_id; end if;
  insert into public.session_color_analyses(org_id,session_id,request_id,model_version,prompt_version,image_quality,undertone,chroma)
    values(s.org_id,s.id,p_request_id,p_model_version,p_result->>'prompt_version',p_result->>'image_quality',p_result->>'undertone',p_result->>'chroma') returning id into v_id;
  for v_flag in select jsonb_array_elements_text(v_flags) loop
    insert into public.session_color_quality_flags(org_id,analysis_id,flag) values(s.org_id,v_id,v_flag);
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  return v_id;
end $$;

create function public.confirm_kiosk_color_preferences(p_session_id uuid,p_palette text,p_finish text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  if p_palette is null or p_palette not in ('warm_soft','warm_clear','cool_soft','cool_clear','neutral_soft','neutral_clear') or p_finish is null or p_finish not in ('any','gloss','satin','matte') then raise exception 'Explicit palette and finish required' using errcode='22023'; end if;
  insert into public.session_color_preferences(org_id,session_id,palette_id,finish) values(s.org_id,s.id,p_palette,p_finish)
    on conflict(org_id,session_id) do update set palette_id=excluded.palette_id,finish=excluded.finish,confirmed_at=now();
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;
create function public.read_kiosk_color_session(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; a public.session_color_analyses;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id) then raise exception 'Active session permission required' using errcode='42501'; end if;
  select * into a from public.session_color_analyses where org_id=s.org_id and session_id=s.id;
  return jsonb_build_object(
    'consent',exists(select 1 from public.session_color_consents where org_id=s.org_id and session_id=s.id and accepted),
    'attempted',exists(select 1 from public.session_color_attempts where org_id=s.org_id and session_id=s.id),
    'analysis',case when a.id is null then null else jsonb_build_object('request_id',a.request_id,'mode','openai_color','model_version',a.model_version,'prompt_version',a.prompt_version,'image_quality',a.image_quality,'undertone',a.undertone,'chroma',a.chroma,'quality_flags',coalesce((select jsonb_agg(flag order by flag) from public.session_color_quality_flags where org_id=a.org_id and analysis_id=a.id),'[]'::jsonb)) end,
    'preferences',(select jsonb_build_object('paletteId',palette_id,'finish',finish) from public.session_color_preferences where org_id=s.org_id and session_id=s.id));
end $$;

create or replace function private.purge_session_details(p_org uuid,p_session uuid,p_status text) returns void language plpgsql security definer set search_path='' as $$
begin
  delete from public.analyses where org_id=p_org and session_id=p_session;
  delete from public.session_explanation_consents where org_id=p_org and session_id=p_session;
  delete from public.session_vision_consents where org_id=p_org and session_id=p_session;
  delete from public.session_vision_attempts where org_id=p_org and session_id=p_session;
  delete from public.session_color_analyses where org_id=p_org and session_id=p_session;
  delete from public.session_color_consents where org_id=p_org and session_id=p_session;
  delete from public.session_color_attempts where org_id=p_org and session_id=p_session;
  delete from public.session_color_preferences where org_id=p_org and session_id=p_session;
  delete from public.session_concerns where org_id=p_org and session_id=p_session;
  delete from public.session_excluded_ingredients where org_id=p_org and session_id=p_session;
  update public.kiosk_sessions set status=p_status,skin_type_id=null,skin_sensitive=null,answers_completed_at=null,finished_at=now() where org_id=p_org and id=p_session;
end $$;

revoke all on function public.publish_lip_shade(uuid,uuid,jsonb),public.read_store_lip_shades(uuid),public.record_color_consent(uuid,text,boolean),public.claim_kiosk_color_analysis(uuid),public.confirm_kiosk_color_preferences(uuid,text,text),public.read_kiosk_color_session(uuid),public.write_openai_color_analysis(uuid,uuid,text,jsonb) from public,anon,authenticated,analysis_writer,service_role;
grant execute on function public.publish_lip_shade(uuid,uuid,jsonb),public.read_store_lip_shades(uuid),public.record_color_consent(uuid,text,boolean),public.claim_kiosk_color_analysis(uuid),public.confirm_kiosk_color_preferences(uuid,text,text),public.read_kiosk_color_session(uuid) to authenticated;
grant execute on function public.write_openai_color_analysis(uuid,uuid,text,jsonb) to analysis_writer;
