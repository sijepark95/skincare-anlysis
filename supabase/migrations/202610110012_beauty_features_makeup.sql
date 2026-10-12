-- Add bounded visible styling categories without rewriting legacy v1 observations.
-- Makeup previews have a separate purpose/one-attempt claim; no pixels, generated
-- image, URL, prompt or provider response is ever stored in these relations.
alter table public.session_beauty_analyses
  drop constraint session_beauty_analyses_prompt_version_check,
  add constraint session_beauty_analyses_prompt_version_check
    check(prompt_version in ('beauty-style-suggestion-v1','beauty-style-suggestion-v2')),
  add column eye_shape text not null default 'uncertain'
    check(eye_shape in ('almond','round','hooded','monolid','uncertain')),
  add column nose_shape text not null default 'uncertain'
    check(nose_shape in ('slender','medium','broad','uncertain')),
  add column lip_fullness text not null default 'uncertain'
    check(lip_fullness in ('fine','medium','full','uncertain')),
  add constraint beauty_feature_quality_check
    check(image_quality='usable' or (eye_shape='uncertain' and nose_shape='uncertain' and lip_fullness='uncertain')),
  add constraint beauty_legacy_feature_check
    check(prompt_version='beauty-style-suggestion-v2' or (eye_shape='uncertain' and nose_shape='uncertain' and lip_fullness='uncertain'));

create or replace function public.write_openai_beauty_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_result jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_id uuid; v_flags jsonb; v_flag text; v_v2 boolean;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes'
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    or not exists(select 1 from public.session_beauty_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-photo-v1')
    or not exists(select 1 from public.session_beauty_attempts where org_id=s.org_id and session_id=s.id and invalidated_at is null)
    then raise exception 'Active consented beauty claim required' using errcode='42501'; end if;
  v_v2:=coalesce(p_result->>'prompt_version'='beauty-style-suggestion-v2',false);
  if p_request_id is null or p_model_version is distinct from 'gpt-4.1-mini-2025-04-14'
    or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>4096
    or (select count(*) from jsonb_object_keys(p_result))<>(case when v_v2 then 12 else 9 end)
    or exists(select 1 from jsonb_object_keys(p_result) k where k not in ('request_id','mode','model_version','prompt_version','image_quality','undertone','chroma','face_shape','quality_flags') and (not v_v2 or k not in ('eye_shape','nose_shape','lip_fullness')))
    or exists(select 1 from jsonb_each(p_result) e where e.key<>'quality_flags' and jsonb_typeof(e.value)<>'string')
    or p_result->>'request_id' is distinct from p_request_id::text or p_result->>'mode' is distinct from 'openai_beauty'
    or p_result->>'model_version' is distinct from p_model_version
    or p_result->>'prompt_version' not in ('beauty-style-suggestion-v1','beauty-style-suggestion-v2')
    or p_result->>'image_quality' not in ('usable','limited','not_assessable')
    or p_result->>'undertone' not in ('warm','cool','neutral','uncertain') or p_result->>'chroma' not in ('soft','clear','uncertain')
    or p_result->>'face_shape' not in ('oval','round','square','oblong','heart','diamond','uncertain')
    or (v_v2 and (p_result->>'eye_shape' not in ('almond','round','hooded','monolid','uncertain')
      or p_result->>'nose_shape' not in ('slender','medium','broad','uncertain')
      or p_result->>'lip_fullness' not in ('fine','medium','full','uncertain')))
    or jsonb_typeof(p_result->'quality_flags') is distinct from 'array'
    then raise exception 'Invalid bounded beauty analysis contract' using errcode='22023'; end if;
  v_flags:=p_result->'quality_flags';
  if jsonb_array_length(v_flags)>8 or (select count(distinct value) from jsonb_array_elements(v_flags))<>jsonb_array_length(v_flags)
    or exists(select 1 from jsonb_array_elements(v_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited'))
    or (p_result->>'image_quality'='usable' and jsonb_array_length(v_flags)<>0)
    or (p_result->>'image_quality'<>'usable' and (jsonb_array_length(v_flags)=0 or p_result->>'undertone'<>'uncertain' or p_result->>'chroma'<>'uncertain' or p_result->>'face_shape'<>'uncertain'
      or (v_v2 and (p_result->>'eye_shape'<>'uncertain' or p_result->>'nose_shape'<>'uncertain' or p_result->>'lip_fullness'<>'uncertain'))))
    or ((v_flags ? 'no_face' or v_flags ? 'multiple_faces') and p_result->>'image_quality'<>'not_assessable')
    then raise exception 'Beauty categories and quality flags disagree' using errcode='22023'; end if;
  select id into v_id from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
  if v_id is not null then return v_id; end if;
  insert into public.session_beauty_analyses(org_id,session_id,request_id,model_version,prompt_version,image_quality,undertone,chroma,face_shape,eye_shape,nose_shape,lip_fullness)
    values(s.org_id,s.id,p_request_id,p_model_version,p_result->>'prompt_version',p_result->>'image_quality',p_result->>'undertone',p_result->>'chroma',p_result->>'face_shape',
      case when v_v2 then p_result->>'eye_shape' else 'uncertain' end,
      case when v_v2 then p_result->>'nose_shape' else 'uncertain' end,
      case when v_v2 then p_result->>'lip_fullness' else 'uncertain' end) returning id into v_id;
  for v_flag in select jsonb_array_elements_text(v_flags) loop
    insert into public.session_beauty_quality_flags(org_id,analysis_id,flag) values(s.org_id,v_id,v_flag);
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  perform private.count_session_analysis(s.org_id,s.id);
  return v_id;
end $$;

create or replace function public.read_kiosk_beauty_session(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; a public.session_beauty_analyses; v_analysis jsonb;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id)
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    then raise exception 'Active consented session permission required' using errcode='42501'; end if;
  select * into a from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
  if a.id is not null then
    v_analysis:=jsonb_build_object('request_id',a.request_id,'mode','openai_beauty','model_version',a.model_version,'prompt_version',a.prompt_version,'image_quality',a.image_quality,'undertone',a.undertone,'chroma',a.chroma,'face_shape',a.face_shape,'quality_flags',coalesce((select jsonb_agg(flag order by flag) from public.session_beauty_quality_flags where org_id=a.org_id and analysis_id=a.id),'[]'::jsonb));
    if a.prompt_version='beauty-style-suggestion-v2' then
      v_analysis:=v_analysis||jsonb_build_object('eye_shape',a.eye_shape,'nose_shape',a.nose_shape,'lip_fullness',a.lip_fullness);
    end if;
  end if;
  return jsonb_build_object(
    'consent',exists(select 1 from public.session_beauty_consents where org_id=s.org_id and session_id=s.id and accepted),
    'attempted',exists(select 1 from public.session_beauty_attempts where org_id=s.org_id and session_id=s.id),
    'analysis',v_analysis,
    'preferences',(select jsonb_build_object('paletteId',palette_id,'faceShape',face_shape,'hairLength',hair_length,'mood',mood,'finish',finish) from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id),
    'excludedIngredients',(select coalesce(jsonb_agg(i.inci_name order by i.inci_name),'[]'::jsonb) from public.session_excluded_ingredients e join public.ingredients i on i.id=e.ingredient_id where e.org_id=s.org_id and e.session_id=s.id));
end $$;

create table public.session_beauty_makeup_consents (
  org_id uuid not null, session_id uuid not null,
  notice_version text not null check(notice_version='2026-10-beauty-makeup-v1'),
  accepted boolean not null, recorded_at timestamptz not null default now(),
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_beauty_makeup_attempts (
  org_id uuid not null, session_id uuid not null,
  preferences_confirmed_at timestamptz not null,
  claimed_at timestamptz not null default now(), invalidated_at timestamptz,
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
do $$ declare t text; begin
  foreach t in array array['session_beauty_makeup_consents','session_beauty_makeup_attempts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer,service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy beauty_makeup_device_read on public.%I for select to authenticated using(private.own_session(org_id,session_id))',t);
  end loop;
end $$;

-- Stable helper is safe in PostgREST read-only transactions and never claims or
-- extends a session. Only the paired guest can inspect this separate purpose.
create function private.assert_beauty_makeup_context(p_session_id uuid,p_require_analysis boolean) returns public.kiosk_sessions
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id)
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.session_beauty_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-photo-v1')
    or (p_require_analysis and (not exists(select 1 from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id and prompt_version='beauty-style-suggestion-v2' and image_quality='usable')
      or not exists(select 1 from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id)))
    then raise exception 'Active consented beauty purpose required' using errcode='42501'; end if;
  return s;
end $$;

create function public.kiosk_set_beauty_makeup_consent(p_session_id uuid,p_accepted boolean,p_notice_version text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_notice_version is distinct from '2026-10-beauty-makeup-v1' or p_accepted is null
    then raise exception 'Explicit supported makeup preview consent required' using errcode='22023'; end if;
  if p_accepted then s:=private.assert_beauty_makeup_context(p_session_id,false); end if;
  insert into public.session_beauty_makeup_consents(org_id,session_id,notice_version,accepted)
    values(s.org_id,s.id,p_notice_version,p_accepted)
    on conflict(org_id,session_id) do update set accepted=excluded.accepted,recorded_at=now();
  if not p_accepted then
    update public.session_beauty_makeup_attempts set invalidated_at=coalesce(invalidated_at,now()) where org_id=s.org_id and session_id=s.id;
  end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create function public.kiosk_claim_beauty_makeup(p_session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_claimed uuid;
begin
  s:=private.assert_device_session(p_session_id);
  s:=private.assert_beauty_makeup_context(p_session_id,true);
  if not exists(select 1 from public.session_beauty_makeup_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-makeup-v1')
    then raise exception 'Separate makeup preview consent required' using errcode='42501'; end if;
  insert into public.session_beauty_makeup_attempts(org_id,session_id,preferences_confirmed_at)
    select s.org_id,s.id,confirmed_at from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id
    on conflict(org_id,session_id) do nothing returning session_id into v_claimed;
  if v_claimed is null then raise exception 'Makeup preview attempt already claimed' using errcode='42501'; end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create function public.kiosk_assert_beauty_makeup(p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_beauty_makeup_context(p_session_id,true);
  if not exists(select 1 from public.session_beauty_makeup_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-makeup-v1')
    or not exists(select 1 from public.session_beauty_makeup_attempts a join public.session_beauty_preferences p on p.org_id=a.org_id and p.session_id=a.session_id and p.confirmed_at=a.preferences_confirmed_at
      where a.org_id=s.org_id and a.session_id=s.id and a.invalidated_at is null)
    then raise exception 'Current makeup preview claim required' using errcode='42501'; end if;
end $$;

create function public.kiosk_beauty_makeup_state(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id)
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    then raise exception 'Active consented session permission required' using errcode='42501'; end if;
  return jsonb_build_object(
    'consent',exists(select 1 from public.session_beauty_makeup_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-beauty-makeup-v1'),
    'attempted',exists(select 1 from public.session_beauty_makeup_attempts where org_id=s.org_id and session_id=s.id));
end $$;

-- Photo-purpose withdrawal invalidates both paid purposes. Re-consent cannot
-- reset either claim; the original photo attempt remains durably consumed.
create or replace function public.record_beauty_consent(p_session_id uuid,p_notice_version text,p_accepted boolean) returns void
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
    update public.session_beauty_makeup_attempts set invalidated_at=coalesce(invalidated_at,now()) where org_id=s.org_id and session_id=s.id;
    delete from public.session_beauty_makeup_consents where org_id=s.org_id and session_id=s.id;
    delete from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
    delete from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id;
  end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create or replace function private.purge_session_details(p_org uuid,p_session uuid,p_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
  delete from public.session_beauty_makeup_attempts where org_id=p_org and session_id=p_session;
  delete from public.session_beauty_makeup_consents where org_id=p_org and session_id=p_session;
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

revoke all on function private.assert_beauty_makeup_context(uuid,boolean) from public,anon,authenticated,analysis_writer,service_role;
revoke all on function public.kiosk_set_beauty_makeup_consent(uuid,boolean,text),public.kiosk_claim_beauty_makeup(uuid),public.kiosk_assert_beauty_makeup(uuid),public.kiosk_beauty_makeup_state(uuid) from public,anon,authenticated,analysis_writer,service_role;
grant execute on function public.kiosk_set_beauty_makeup_consent(uuid,boolean,text),public.kiosk_claim_beauty_makeup(uuid),public.kiosk_assert_beauty_makeup(uuid),public.kiosk_beauty_makeup_state(uuid) to authenticated;
