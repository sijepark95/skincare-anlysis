-- Separate transient beauty photo purpose, confirmed style preferences and opt-in saved guides.
-- No image, arbitrary provider prose, questionnaire snapshot or raw provider JSON is persisted.
create table public.session_beauty_consents (
  org_id uuid not null, session_id uuid not null,
  notice_version text not null check(notice_version='2026-10-beauty-photo-v1'),
  accepted boolean not null, recorded_at timestamptz not null default now(),
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_beauty_attempts (
  org_id uuid not null, session_id uuid not null,
  claimed_at timestamptz not null default now(), invalidated_at timestamptz,
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_beauty_analyses (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, session_id uuid not null,
  request_id uuid not null unique,
  model_version text not null check(model_version='gpt-4.1-mini-2025-04-14'),
  prompt_version text not null check(prompt_version='beauty-style-suggestion-v1'),
  image_quality text not null check(image_quality in ('usable','limited','not_assessable')),
  undertone text not null check(undertone in ('warm','cool','neutral','uncertain')),
  chroma text not null check(chroma in ('soft','clear','uncertain')),
  face_shape text not null check(face_shape in ('oval','round','square','oblong','heart','diamond','uncertain')),
  created_at timestamptz not null default now(),
  unique(org_id,id), unique(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade,
  check(image_quality='usable' or (undertone='uncertain' and chroma='uncertain' and face_shape='uncertain'))
);
create table public.session_beauty_quality_flags (
  org_id uuid not null, analysis_id uuid not null,
  flag text not null check(flag in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited')),
  primary key(org_id,analysis_id,flag),
  foreign key(org_id,analysis_id) references public.session_beauty_analyses(org_id,id) on delete cascade
);
create table public.session_beauty_preferences (
  org_id uuid not null, session_id uuid not null,
  palette_id text not null check(palette_id in ('warm_soft','warm_clear','cool_soft','cool_clear','neutral_soft','neutral_clear')),
  finish text not null check(finish in ('any','gloss','satin','matte')),
  face_shape text not null check(face_shape in ('oval','round','square','oblong','heart','diamond','unsure')),
  hair_length text not null check(hair_length in ('any','short','medium','long')),
  mood text not null check(mood in ('soft','fresh','defined')),
  confirmed_at timestamptz not null default now(),
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create function public.record_beauty_consent(p_session_id uuid,p_notice_version text,p_accepted boolean) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_notice_version is distinct from '2026-10-beauty-photo-v1' or p_accepted is null then raise exception 'Explicit supported beauty photo consent required' using errcode='22023'; end if;
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  insert into public.session_beauty_consents(org_id,session_id,notice_version,accepted) values(s.org_id,s.id,p_notice_version,p_accepted)
    on conflict(org_id,session_id) do update set accepted=excluded.accepted,recorded_at=now();
  if not p_accepted then
    update public.session_beauty_attempts set invalidated_at=coalesce(invalidated_at,now()) where org_id=s.org_id and session_id=s.id;
    delete from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
    delete from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id;
  end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create function public.record_beauty_exclusions(p_session_id uuid,p_excluded_ingredients text[]) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_name text; v_id uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  if p_excluded_ingredients is null or cardinality(p_excluded_ingredients)>20
    or exists(select 1 from unnest(p_excluded_ingredients) n where n is null or length(trim(n)) not between 1 and 160
      or not exists(select 1 from public.ingredients i where lower(i.inci_name)=lower(trim(n))))
    then raise exception 'At most twenty canonical excluded ingredients required' using errcode='22023'; end if;
  delete from public.session_excluded_ingredients where org_id=s.org_id and session_id=s.id;
  foreach v_name in array p_excluded_ingredients loop
    select id into v_id from public.ingredients where lower(inci_name)=lower(trim(v_name));
    insert into public.session_excluded_ingredients(org_id,session_id,ingredient_id) values(s.org_id,s.id,v_id) on conflict do nothing;
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create function public.confirm_kiosk_beauty_preferences(p_session_id uuid,p_preferences jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  if jsonb_typeof(p_preferences) is distinct from 'object' or octet_length(p_preferences::text)>1024
    or (select count(*) from jsonb_object_keys(p_preferences))<>5
    or exists(select 1 from jsonb_each(p_preferences) e where e.key not in ('paletteId','faceShape','hairLength','mood','finish') or jsonb_typeof(e.value)<>'string')
    or p_preferences->>'paletteId' not in ('warm_soft','warm_clear','cool_soft','cool_clear','neutral_soft','neutral_clear')
    or p_preferences->>'faceShape' not in ('oval','round','square','oblong','heart','diamond','unsure')
    or p_preferences->>'hairLength' not in ('any','short','medium','long')
    or p_preferences->>'mood' not in ('soft','fresh','defined')
    or p_preferences->>'finish' not in ('any','gloss','satin','matte')
    then raise exception 'Exact bounded confirmed beauty preferences required' using errcode='22023'; end if;
  insert into public.session_beauty_preferences(org_id,session_id,palette_id,face_shape,hair_length,mood,finish)
    values(s.org_id,s.id,p_preferences->>'paletteId',p_preferences->>'faceShape',p_preferences->>'hairLength',p_preferences->>'mood',p_preferences->>'finish')
    on conflict(org_id,session_id) do update set palette_id=excluded.palette_id,face_shape=excluded.face_shape,hair_length=excluded.hair_length,mood=excluded.mood,finish=excluded.finish,confirmed_at=now();
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create function public.read_kiosk_beauty_session(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; a public.session_beauty_analyses;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id)
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    then raise exception 'Active consented session permission required' using errcode='42501'; end if;
  select * into a from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
  return jsonb_build_object(
    'consent',exists(select 1 from public.session_beauty_consents where org_id=s.org_id and session_id=s.id and accepted),
    'attempted',exists(select 1 from public.session_beauty_attempts where org_id=s.org_id and session_id=s.id),
    'analysis',case when a.id is null then null else jsonb_build_object('request_id',a.request_id,'mode','openai_beauty','model_version',a.model_version,'prompt_version',a.prompt_version,'image_quality',a.image_quality,'undertone',a.undertone,'chroma',a.chroma,'face_shape',a.face_shape,'quality_flags',coalesce((select jsonb_agg(flag order by flag) from public.session_beauty_quality_flags where org_id=a.org_id and analysis_id=a.id),'[]'::jsonb)) end,
    'preferences',(select jsonb_build_object('paletteId',palette_id,'faceShape',face_shape,'hairLength',hair_length,'mood',mood,'finish',finish) from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id),
    'excludedIngredients',(select coalesce(jsonb_agg(i.inci_name order by i.inci_name),'[]'::jsonb) from public.session_excluded_ingredients e join public.ingredients i on i.id=e.ingredient_id where e.org_id=s.org_id and e.session_id=s.id));
end $$;

-- A separately opted-in capability stores confirmed style choices and original product
-- references only. There is no session, photo, provider observation or avoid-list here.
create table public.beauty_saved_guides (
  id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, store_id uuid not null,
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  notice_version text not null check(notice_version='2026-10-beauty-save-v1'),
  accepted_at timestamptz not null default now(), created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days', revoked_at timestamptz,
  palette_id text not null check(palette_id in ('warm_soft','warm_clear','cool_soft','cool_clear','neutral_soft','neutral_clear')),
  face_shape text not null check(face_shape in ('oval','round','square','oblong','heart','diamond','unsure')),
  hair_length text not null check(hair_length in ('any','short','medium','long')),
  mood text not null check(mood in ('soft','fresh','defined')),
  finish text not null check(finish in ('any','gloss','satin','matte')),
  unique(org_id,id), foreign key(org_id,store_id) references public.stores(org_id,id) on delete cascade,
  check(expires_at=created_at+interval '7 days')
);
create table public.beauty_saved_guide_products (
  org_id uuid not null, guide_id uuid not null, rank integer not null check(rank between 1 and 3),
  variant_id uuid not null, product_id uuid not null, formulation_version_id uuid not null, shade_version_id uuid not null,
  primary key(org_id,guide_id,rank), unique(org_id,guide_id,variant_id),
  foreign key(org_id,guide_id) references public.beauty_saved_guides(org_id,id) on delete cascade,
  foreign key(org_id,product_id,variant_id) references public.product_variants(org_id,product_id,id),
  foreign key(org_id,product_id,formulation_version_id) references public.formulation_versions(org_id,product_id,id),
  foreign key(org_id,variant_id,shade_version_id) references public.variant_shade_versions(org_id,variant_id,id)
);
-- This temporary link limits creation to one guide per active session. Purging it
-- never deletes the independent, explicitly saved guide; it contains no raw token.
create table public.session_beauty_saved_guides (
  org_id uuid not null, session_id uuid not null, guide_id uuid not null,
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade,
  foreign key(org_id,guide_id) references public.beauty_saved_guides(org_id,id) on delete cascade
);

do $$ declare t text; begin
  foreach t in array array['session_beauty_consents','session_beauty_attempts','session_beauty_analyses','session_beauty_quality_flags','session_beauty_preferences','beauty_saved_guides','beauty_saved_guide_products','session_beauty_saved_guides'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer,service_role',t);
  end loop;
  foreach t in array array['session_beauty_consents','session_beauty_attempts','session_beauty_analyses','session_beauty_preferences'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy beauty_device_read on public.%I for select to authenticated using(private.own_session(org_id,session_id))',t);
  end loop;
end $$;
grant select on public.session_beauty_quality_flags to authenticated;
create policy beauty_device_read on public.session_beauty_quality_flags for select to authenticated
  using(exists(select 1 from public.session_beauty_analyses a where a.org_id=session_beauty_quality_flags.org_id and a.id=session_beauty_quality_flags.analysis_id and private.own_session(a.org_id,a.session_id)));

create function public.create_kiosk_beauty_guide(p_session_id uuid,p_token_hash text,p_notice_version text,p_accepted boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; p public.session_beauty_preferences; g public.beauty_saved_guides; v_id uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if p_accepted is distinct from true or p_notice_version is distinct from '2026-10-beauty-save-v1'
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    then raise exception 'Explicit save consent and a SHA-256 capability hash required' using errcode='22023'; end if;
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  select * into p from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id;
  if p.session_id is null then raise exception 'Confirm beauty preferences before saving' using errcode='22023'; end if;
  select saved.* into g from public.session_beauty_saved_guides link join public.beauty_saved_guides saved on saved.org_id=link.org_id and saved.id=link.guide_id where link.org_id=s.org_id and link.session_id=s.id;
  if g.id is not null then
    if g.revoked_at is not null or g.expires_at<=now() then raise exception 'Saved guide unavailable' using errcode='42501'; end if;
    if g.token_hash is distinct from p_token_hash then raise exception 'This session already saved a guide' using errcode='22023'; end if;
    return jsonb_build_object('expiresAt',g.expires_at);
  end if;
  insert into public.beauty_saved_guides(org_id,store_id,token_hash,notice_version,palette_id,face_shape,hair_length,mood,finish)
    values(s.org_id,s.store_id,p_token_hash,p_notice_version,p.palette_id,p.face_shape,p.hair_length,p.mood,p.finish) returning id into v_id;
  insert into public.session_beauty_saved_guides(org_id,session_id,guide_id) values(s.org_id,s.id,v_id);
  insert into public.beauty_saved_guide_products(org_id,guide_id,rank,variant_id,product_id,formulation_version_id,shade_version_id)
    select s.org_id,v_id,row_number() over(order by q.score desc,q.sku),q.variant_id,q.product_id,q.formulation_version_id,q.shade_version_id from (
      select v.id variant_id,v.product_id,v.sku,f.id formulation_version_id,sv.id shade_version_id,
        (case when sv.undertone=split_part(p.palette_id,'_',1) then 2 else 1 end)+(case when sv.intensity=split_part(p.palette_id,'_',2) then 2 else 0 end) score
      from public.store_listings l join public.product_variants v on v.org_id=l.org_id and v.id=l.variant_id and v.active
      join public.products pr on pr.org_id=v.org_id and pr.id=v.product_id
      join public.categories c on c.org_id=pr.org_id and c.id=pr.category_id and c.name='lip_color'
      join public.variant_formulations vf on vf.org_id=v.org_id and vf.variant_id=v.id
      join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id and f.status='published' and f.complete
      join public.variant_shades vs on vs.org_id=v.org_id and vs.variant_id=v.id
      join public.variant_shade_versions sv on sv.org_id=vs.org_id and sv.variant_id=vs.variant_id and sv.id=vs.shade_version_id
      where l.org_id=s.org_id and l.store_id=s.store_id and l.visible and l.stock>0
        and (p.finish='any' or sv.finish=p.finish)
        and (split_part(p.palette_id,'_',1)='neutral' or sv.undertone='neutral' or sv.undertone=split_part(p.palette_id,'_',1))
        and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)
        and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)
        and not exists(select 1 from public.formulation_ingredients i join public.session_excluded_ingredients e on e.org_id=i.org_id and e.ingredient_id=i.ingredient_id where i.org_id=f.org_id and i.formulation_version_id=f.id and e.session_id=s.id)
      order by score desc,v.sku limit 3
    ) q;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  return jsonb_build_object('expiresAt',(select expires_at from public.beauty_saved_guides where id=v_id));
end $$;

create function public.read_beauty_saved_guide(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare g public.beauty_saved_guides; v_products jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  select saved.* into g from public.beauty_saved_guides saved join public.stores s on s.org_id=saved.org_id and s.id=saved.store_id and s.active
    where saved.token_hash=p_token_hash and saved.revoked_at is null and saved.expires_at>now();
  if g.id is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('variantId',v.id,'shadeVersionId',sv.id,'name',p.name,'brand',b.name,'priceMinor',l.price_minor,'currency',l.currency,'shadeName',sv.shade_name,'hueFamily',sv.hue_family,'undertone',sv.undertone,'intensity',sv.intensity,'finish',sv.finish,'swatchHex',sv.swatch_hex,
    'available',coalesce(v.active and l.visible and l.stock>0 and vf.formulation_version_id=items.formulation_version_id and vs.shade_version_id=items.shade_version_id and f.status='published' and f.complete,false)) order by items.rank),'[]'::jsonb) into v_products
  from public.beauty_saved_guide_products items
  join public.product_variants v on v.org_id=items.org_id and v.id=items.variant_id
  join public.products p on p.org_id=v.org_id and p.id=v.product_id
  join public.brands b on b.org_id=p.org_id and b.id=p.brand_id
  join public.formulation_versions f on f.org_id=items.org_id and f.id=items.formulation_version_id
  join public.variant_shade_versions sv on sv.org_id=items.org_id and sv.id=items.shade_version_id
  left join public.store_listings l on l.org_id=items.org_id and l.store_id=g.store_id and l.variant_id=items.variant_id
  left join public.variant_formulations vf on vf.org_id=items.org_id and vf.variant_id=items.variant_id
  left join public.variant_shades vs on vs.org_id=items.org_id and vs.variant_id=items.variant_id
  where items.org_id=g.org_id and items.guide_id=g.id;
  return jsonb_build_object('expiresAt',g.expires_at,'preferences',jsonb_build_object('paletteId',g.palette_id,'faceShape',g.face_shape,'hairLength',g.hair_length,'mood',g.mood,'finish',g.finish),'products',v_products);
end $$;
create function public.revoke_beauty_saved_guide(p_token_hash text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return; end if;
  update public.beauty_saved_guides set revoked_at=coalesce(revoked_at,now()) where token_hash=p_token_hash;
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
  delete from public.session_beauty_analyses where org_id=p_org and session_id=p_session;
  delete from public.session_beauty_consents where org_id=p_org and session_id=p_session;
  delete from public.session_beauty_attempts where org_id=p_org and session_id=p_session;
  delete from public.session_beauty_preferences where org_id=p_org and session_id=p_session;
  delete from public.session_beauty_saved_guides where org_id=p_org and session_id=p_session;
  delete from public.session_concerns where org_id=p_org and session_id=p_session;
  delete from public.session_excluded_ingredients where org_id=p_org and session_id=p_session;
  update public.kiosk_sessions set status=p_status,skin_type_id=null,skin_sensitive=null,answers_completed_at=null,finished_at=now() where org_id=p_org and id=p_session;
end $$;
create or replace function private.cleanup_expired_data() returns jsonb language plpgsql security definer set search_path='' as $$
declare s record; v_expired integer:=0; v_consents integer; v_audits integer; v_guides integer;
begin
  for s in select org_id,id from public.kiosk_sessions where status='active' and last_activity_at<=now()-interval '15 minutes' for update skip locked loop
    perform private.purge_session_details(s.org_id,s.id,'expired'); v_expired:=v_expired+1;
  end loop;
  delete from public.consents where recorded_at<now()-interval '30 days'; get diagnostics v_consents=row_count;
  delete from public.kiosk_sessions where status<>'active' and finished_at<now()-interval '30 days';
  delete from public.audit_events where created_at<now()-interval '90 days'; get diagnostics v_audits=row_count;
  delete from public.device_pairing_codes where expires_at<now()-interval '1 day';
  delete from public.beauty_saved_guides where expires_at<=now(); get diagnostics v_guides=row_count;
  return jsonb_build_object('expired_sessions',v_expired,'deleted_consents',v_consents,'deleted_audits',v_audits,'deleted_beauty_guides',v_guides);
end $$;


create function public.claim_kiosk_beauty_analysis(p_session_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_claimed uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.session_beauty_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-photo-v1')
    then raise exception 'Separate beauty photo consent required' using errcode='42501'; end if;
  if exists(select 1 from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id) then return false; end if;
  insert into public.session_beauty_attempts(org_id,session_id) values(s.org_id,s.id) on conflict(org_id,session_id) do nothing returning session_id into v_claimed;
  return v_claimed is not null;
end $$;

create function public.write_openai_beauty_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_result jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_id uuid; v_flags jsonb; v_flag text;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes'
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    or not exists(select 1 from public.session_beauty_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-photo-v1')
    or not exists(select 1 from public.session_beauty_attempts where org_id=s.org_id and session_id=s.id and invalidated_at is null)
    then raise exception 'Active consented beauty claim required' using errcode='42501'; end if;
  if p_request_id is null or p_model_version is distinct from 'gpt-4.1-mini-2025-04-14'
    or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>4096
    or (select count(*) from jsonb_object_keys(p_result))<>9
    or exists(select 1 from jsonb_object_keys(p_result) k where k not in ('request_id','mode','model_version','prompt_version','image_quality','undertone','chroma','face_shape','quality_flags'))
    or exists(select 1 from jsonb_each(p_result) e where e.key<>'quality_flags' and jsonb_typeof(e.value)<>'string')
    or p_result->>'request_id' is distinct from p_request_id::text or p_result->>'mode' is distinct from 'openai_beauty'
    or p_result->>'model_version' is distinct from p_model_version or p_result->>'prompt_version' is distinct from 'beauty-style-suggestion-v1'
    or p_result->>'image_quality' not in ('usable','limited','not_assessable')
    or p_result->>'undertone' not in ('warm','cool','neutral','uncertain') or p_result->>'chroma' not in ('soft','clear','uncertain')
    or p_result->>'face_shape' not in ('oval','round','square','oblong','heart','diamond','uncertain')
    or jsonb_typeof(p_result->'quality_flags') is distinct from 'array'
    then raise exception 'Invalid bounded beauty analysis contract' using errcode='22023'; end if;
  v_flags:=p_result->'quality_flags';
  if jsonb_array_length(v_flags)>8 or (select count(distinct value) from jsonb_array_elements(v_flags))<>jsonb_array_length(v_flags)
    or exists(select 1 from jsonb_array_elements(v_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited'))
    or (p_result->>'image_quality'='usable' and jsonb_array_length(v_flags)<>0)
    or (p_result->>'image_quality'<>'usable' and (jsonb_array_length(v_flags)=0 or p_result->>'undertone'<>'uncertain' or p_result->>'chroma'<>'uncertain' or p_result->>'face_shape'<>'uncertain'))
    or ((v_flags ? 'no_face' or v_flags ? 'multiple_faces') and p_result->>'image_quality'<>'not_assessable')
    then raise exception 'Beauty categories and quality flags disagree' using errcode='22023'; end if;
  select id into v_id from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
  if v_id is not null then return v_id; end if;
  insert into public.session_beauty_analyses(org_id,session_id,request_id,model_version,prompt_version,image_quality,undertone,chroma,face_shape)
    values(s.org_id,s.id,p_request_id,p_model_version,p_result->>'prompt_version',p_result->>'image_quality',p_result->>'undertone',p_result->>'chroma',p_result->>'face_shape') returning id into v_id;
  for v_flag in select jsonb_array_elements_text(v_flags) loop
    insert into public.session_beauty_quality_flags(org_id,analysis_id,flag) values(s.org_id,v_id,v_flag);
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  return v_id;
end $$;


revoke all on function public.record_beauty_consent(uuid,text,boolean),public.record_beauty_exclusions(uuid,text[]),public.claim_kiosk_beauty_analysis(uuid),public.write_openai_beauty_analysis(uuid,uuid,text,jsonb),public.confirm_kiosk_beauty_preferences(uuid,jsonb),public.read_kiosk_beauty_session(uuid),public.create_kiosk_beauty_guide(uuid,text,text,boolean),public.read_beauty_saved_guide(text),public.revoke_beauty_saved_guide(text) from public,anon,authenticated,analysis_writer,service_role;
grant execute on function public.record_beauty_consent(uuid,text,boolean),public.record_beauty_exclusions(uuid,text[]),public.claim_kiosk_beauty_analysis(uuid),public.confirm_kiosk_beauty_preferences(uuid,jsonb),public.read_kiosk_beauty_session(uuid),public.create_kiosk_beauty_guide(uuid,text,text,boolean) to authenticated;
grant execute on function public.read_beauty_saved_guide(text),public.revoke_beauty_saved_guide(text) to anon,authenticated;
grant execute on function public.write_openai_beauty_analysis(uuid,uuid,text,jsonb) to analysis_writer;
