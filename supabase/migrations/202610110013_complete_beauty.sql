-- Integrated beauty purpose. This is additive: legacy photo writers retain their guards.
-- No individual Gender, photo, landmark, animal label, image prompt or generated image is stored.
create table private.beauty_release_settings(singleton boolean primary key default true check(singleton),teen_photo_enabled boolean not null default false);
insert into private.beauty_release_settings default values;
revoke all on private.beauty_release_settings from public,anon,authenticated,analysis_writer,service_role;
create table public.session_complete_guest_context (
 org_id uuid not null, session_id uuid not null, age_band text not null check(age_band in ('under13','13-15','16-17','18-24','25-34','35-44','45-54','55+')),
 locale text not null check(locale in ('en','ko','es')), analytics_consent boolean not null default false,
 primary key(org_id,session_id), foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade,
 check(not analytics_consent or age_band not in ('under13','13-15','16-17'))
);
create table public.session_complete_photo_consents (
 org_id uuid not null,session_id uuid not null,accepted boolean not null,notice_version text not null check(notice_version='2026-10-beauty-complete-photo-v1'), recorded_at timestamptz not null default now(),
 primary key(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_complete_analysis_attempts (
 org_id uuid not null,session_id uuid not null,request_id uuid not null unique default extensions.gen_random_uuid(),claimed_at timestamptz not null default now(),invalidated_at timestamptz,
 primary key(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_complete_skin_profiles (
 org_id uuid not null,session_id uuid not null,skin_type_id uuid references public.skin_types(id),
 primary key(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_complete_skin_concerns (
 org_id uuid not null,session_id uuid not null,concern_id uuid not null references public.concerns(id),
 primary key(org_id,session_id,concern_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_complete_base_choices (
 org_id uuid not null,session_id uuid not null,depth text not null check(depth in ('fair','light','medium','tan','deep','unknown')),
 undertone text not null check(undertone in ('warm','cool','neutral','unknown')),concealer_purpose text not null check(concealer_purpose in ('match','brighten')),
 confirmed_at timestamptz not null default now(),primary key(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_complete_preview_consents (
 org_id uuid not null,session_id uuid not null,accepted boolean not null,notice_version text not null check(notice_version='2026-10-beauty-preview-v1'),recorded_at timestamptz not null default now(),
 primary key(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
create table public.session_complete_preview_plans (
 id uuid primary key default extensions.gen_random_uuid(),org_id uuid not null,session_id uuid not null,preferences_confirmed_at timestamptz not null,
 deadline timestamptz not null default now()+interval '12 minutes',created_at timestamptz not null default now(),cancelled_at timestamptz,
 unique(org_id,id),unique(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade,
 check(deadline<=created_at+interval '12 minutes')
);
create table public.session_complete_preview_slots (
 org_id uuid not null,plan_id uuid not null,slot integer not null check(slot between 0 and 8),kind text not null check(kind in ('makeup','hair_style','hair_color')),
 status text not null default 'pending' check(status in ('pending','running','complete','failed','cancelled')),request_id uuid unique,claimed_at timestamptz,finished_at timestamptz,
 primary key(org_id,plan_id,slot),foreign key(org_id,plan_id) references public.session_complete_preview_plans(org_id,id) on delete cascade,
 check(kind=case when slot<3 then 'makeup' when slot<6 then 'hair_style' else 'hair_color' end),
 check((status='pending' and request_id is null and claimed_at is null) or status='cancelled' or (request_id is not null and claimed_at is not null))
);
create table public.store_weekly_beauty_demographics (
 org_id uuid not null,store_id uuid not null,week_start date not null,dimension text not null check(dimension in ('age','gender')),bucket text not null,
 completed_sessions integer not null default 0 check(completed_sessions>=0),primary key(org_id,store_id,week_start,dimension,bucket),
 foreign key(org_id,store_id) references public.stores(org_id,id),
 check((dimension='age' and bucket in ('18-24','25-34','35-44','45-54','55+')) or (dimension='gender' and bucket in ('woman','man','nonbinary','self_described','prefer_not_to_say'))),
 check(extract(isodow from week_start)=1)
);
do $$ declare t text; begin
 foreach t in array array['session_complete_guest_context','session_complete_photo_consents','session_complete_analysis_attempts','session_complete_skin_profiles','session_complete_skin_concerns','session_complete_base_choices','session_complete_preview_consents','session_complete_preview_plans','session_complete_preview_slots','store_weekly_beauty_demographics'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer,service_role',t);
 end loop;
end $$;

create function private.assert_complete_session(p_session_id uuid,p_photo boolean default false) returns public.kiosk_sessions
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;c public.session_complete_guest_context;
begin
 select * into s from public.kiosk_sessions where id=p_session_id;
 if s.id is null or not private.own_session(s.org_id,s.id) then raise exception 'Active session permission required' using errcode='42501'; end if;
 if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
 select * into c from public.session_complete_guest_context where org_id=s.org_id and session_id=s.id;
 if c.session_id is null or c.age_band='under13' then raise exception 'Eligible guest context required' using errcode='42501'; end if;
 if p_photo and (not exists(select 1 from public.session_complete_photo_consents where org_id=s.org_id and session_id=s.id and accepted)
  or (c.age_band in ('13-15','16-17') and not (select teen_photo_enabled from private.beauty_release_settings where singleton))) then raise exception 'Eligible separate complete photo purpose required' using errcode='42501'; end if;
 return s;
end $$;
create function public.kiosk_set_beauty_guest_context(p_session_id uuid,p_age_band text,p_locale text,p_analytics_consent boolean) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;c public.session_complete_guest_context;
begin
 s:=private.assert_device_session(p_session_id);
 if p_age_band is null or p_age_band not in ('under13','13-15','16-17','18-24','25-34','35-44','45-54','55+') or p_locale is null or p_locale not in ('en','ko','es') or p_analytics_consent is null or (p_age_band in ('under13','13-15','16-17') and p_analytics_consent) then raise exception 'Bounded guest context required' using errcode='22023'; end if;
 select * into c from public.session_complete_guest_context where org_id=s.org_id and session_id=s.id;
 if c.session_id is not null and c.age_band<>p_age_band and exists(select 1 from public.session_complete_analysis_attempts where org_id=s.org_id and session_id=s.id) then raise exception 'Age band cannot change after photo attempt' using errcode='22023'; end if;
 if exists(select 1 from public.session_beauty_attempts where org_id=s.org_id and session_id=s.id) or exists(select 1 from public.session_vision_attempts where org_id=s.org_id and session_id=s.id) or exists(select 1 from public.session_color_attempts where org_id=s.org_id and session_id=s.id) then raise exception 'Start a fresh integrated session' using errcode='22023'; end if;
 insert into public.session_complete_guest_context(org_id,session_id,age_band,locale,analytics_consent) values(s.org_id,s.id,p_age_band,p_locale,p_analytics_consent) on conflict(org_id,session_id) do update set age_band=excluded.age_band,locale=excluded.locale,analytics_consent=excluded.analytics_consent;
 update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;
create function private.reject_legacy_complete_attempt() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.session_complete_guest_context where org_id=new.org_id and session_id=new.session_id) then raise exception 'Use the single integrated photo purpose' using errcode='42501'; end if;
 return new;
end $$;
create trigger complete_guard before insert on public.session_beauty_attempts for each row execute function private.reject_legacy_complete_attempt();
create trigger complete_guard before insert on public.session_vision_attempts for each row execute function private.reject_legacy_complete_attempt();
create trigger complete_guard before insert on public.session_color_attempts for each row execute function private.reject_legacy_complete_attempt();
create trigger complete_guard before insert on public.session_beauty_makeup_attempts for each row execute function private.reject_legacy_complete_attempt();

create function public.kiosk_set_complete_photo_consent(p_session_id uuid,p_accepted boolean,p_notice_version text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_session(p_session_id,false);
 if p_notice_version is distinct from '2026-10-beauty-complete-photo-v1' or p_accepted is null then raise exception 'Explicit complete photo consent required' using errcode='22023'; end if;
 if p_accepted and exists(select 1 from public.session_complete_guest_context c where c.org_id=s.org_id and c.session_id=s.id and c.age_band in ('13-15','16-17')) and not (select teen_photo_enabled from private.beauty_release_settings where singleton) then raise exception 'Teen photo release not enabled' using errcode='42501'; end if;
 insert into public.session_complete_photo_consents(org_id,session_id,accepted,notice_version) values(s.org_id,s.id,p_accepted,p_notice_version) on conflict(org_id,session_id) do update set accepted=excluded.accepted,recorded_at=now();
 if not p_accepted then
  update public.session_complete_analysis_attempts set invalidated_at=coalesce(invalidated_at,now()) where org_id=s.org_id and session_id=s.id;
  update public.session_complete_preview_plans set cancelled_at=coalesce(cancelled_at,now()) where org_id=s.org_id and session_id=s.id;
  delete from public.session_complete_preview_consents where org_id=s.org_id and session_id=s.id;
  delete from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id;
  delete from public.analyses where org_id=s.org_id and session_id=s.id;
 end if;
 update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;
create function public.kiosk_claim_complete_analysis(p_session_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;v_id uuid;
begin
 s:=private.assert_complete_session(p_session_id,true);
 select * into s from public.kiosk_sessions where id=s.id for update;
 insert into public.session_complete_analysis_attempts(org_id,session_id) values(s.org_id,s.id) on conflict(org_id,session_id) do nothing returning request_id into v_id;
 if v_id is null then raise exception 'The photo attempt was already used' using errcode='23505'; end if;
 return v_id;
end $$;

create function public.write_openai_complete_analysis(p_session_id uuid,p_request_id uuid,p_beauty jsonb,p_skin jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;v_id uuid;v_key text;v_flag text;v_features jsonb;v_flags jsonb;v_beauty_flags jsonb;
begin
 select * into s from public.kiosk_sessions where id=p_session_id for update;
 if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes'
 or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
 or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
 or not exists(select 1 from public.session_complete_photo_consents where org_id=s.org_id and session_id=s.id and accepted)
 or not exists(select 1 from public.session_complete_analysis_attempts where org_id=s.org_id and session_id=s.id and request_id=p_request_id and invalidated_at is null)
 or not exists(select 1 from public.session_complete_guest_context c where c.org_id=s.org_id and c.session_id=s.id and c.age_band<>'under13' and (c.age_band not in ('13-15','16-17') or (select teen_photo_enabled from private.beauty_release_settings where singleton)))
 then raise exception 'Active integrated claim required' using errcode='42501'; end if;
 if jsonb_typeof(p_beauty) is distinct from 'object' or octet_length(p_beauty::text)>4096 or (select count(*) from jsonb_object_keys(p_beauty))<>12
 or exists(select 1 from jsonb_each(p_beauty) e where e.key not in ('request_id','mode','model_version','prompt_version','image_quality','undertone','chroma','face_shape','eye_shape','nose_shape','lip_fullness','quality_flags') or (e.key<>'quality_flags' and jsonb_typeof(e.value)<>'string'))
 or p_beauty->>'request_id' is distinct from p_request_id::text or p_beauty->>'mode' is distinct from 'openai_beauty' or p_beauty->>'model_version' is distinct from 'gpt-4.1-mini-2025-04-14' or p_beauty->>'prompt_version' is distinct from 'beauty-style-suggestion-v2'
 or p_beauty->>'image_quality' not in ('usable','limited','not_assessable') or p_beauty->>'undertone' not in ('warm','cool','neutral','uncertain') or p_beauty->>'chroma' not in ('soft','clear','uncertain') or p_beauty->>'face_shape' not in ('oval','round','square','oblong','heart','diamond','uncertain') or p_beauty->>'eye_shape' not in ('almond','round','hooded','monolid','uncertain') or p_beauty->>'nose_shape' not in ('slender','medium','broad','uncertain') or p_beauty->>'lip_fullness' not in ('fine','medium','full','uncertain') or jsonb_typeof(p_beauty->'quality_flags') is distinct from 'array'
 then raise exception 'Exact bounded beauty v2 required' using errcode='22023'; end if;
 v_beauty_flags:=p_beauty->'quality_flags';
 if jsonb_array_length(v_beauty_flags)>8 or (select count(distinct value) from jsonb_array_elements(v_beauty_flags))<>jsonb_array_length(v_beauty_flags)
 or exists(select 1 from jsonb_array_elements(v_beauty_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited'))
 or (p_beauty->>'image_quality'='usable' and jsonb_array_length(v_beauty_flags)<>0)
 or (p_beauty->>'image_quality'<>'usable' and (jsonb_array_length(v_beauty_flags)=0 or p_beauty->>'undertone'<>'uncertain' or p_beauty->>'chroma'<>'uncertain' or p_beauty->>'face_shape'<>'uncertain' or p_beauty->>'eye_shape'<>'uncertain' or p_beauty->>'nose_shape'<>'uncertain' or p_beauty->>'lip_fullness'<>'uncertain'))
 or ((v_beauty_flags ? 'no_face' or v_beauty_flags ? 'multiple_faces') and p_beauty->>'image_quality'<>'not_assessable') then raise exception 'Beauty quality disagrees' using errcode='22023'; end if;
 if jsonb_typeof(p_skin) is distinct from 'object' or octet_length(p_skin::text)>4096 or (select count(*) from jsonb_object_keys(p_skin))<>4
 or exists(select 1 from jsonb_object_keys(p_skin) k where k not in ('prompt_version','image_quality','quality_flags','observed_features'))
 or p_skin->>'prompt_version' is distinct from 'visible-appearance-eval-v1' or p_skin->>'image_quality' not in ('usable','limited','not_assessable') or jsonb_typeof(p_skin->'observed_features') is distinct from 'object' or jsonb_typeof(p_skin->'quality_flags') is distinct from 'array' then raise exception 'Exact skin appearance contract required' using errcode='22023'; end if;
 v_features:=p_skin->'observed_features';v_flags:=p_skin->'quality_flags';
 if (select count(*) from jsonb_object_keys(v_features))<>5 or exists(select 1 from jsonb_each(v_features) f where f.key not in ('visible_redness','visible_spots','visible_pores','visible_fine_lines','visible_flaking') or jsonb_typeof(f.value)<>'string' or f.value#>>'{}' not in ('visible','not_visible','uncertain','not_assessable'))
 or jsonb_array_length(v_flags)>9 or (select count(distinct value) from jsonb_array_elements(v_flags))<>jsonb_array_length(v_flags)
 or exists(select 1 from jsonb_array_elements(v_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','occlusion','makeup_or_filter','face_not_fully_visible','resolution_limited'))
 or (p_skin->>'image_quality'='usable' and jsonb_array_length(v_flags)<>0) or (p_skin->>'image_quality'<>'usable' and jsonb_array_length(v_flags)=0)
 or (p_skin->>'image_quality'='not_assessable' and exists(select 1 from jsonb_each_text(v_features) f where f.value<>'not_assessable'))
 or ((v_flags ? 'no_face' or v_flags ? 'multiple_faces') and p_skin->>'image_quality'<>'not_assessable') then raise exception 'Skin quality disagrees' using errcode='22023'; end if;
 if exists(select 1 from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id) then return; end if;
 insert into public.session_beauty_analyses(org_id,session_id,request_id,model_version,prompt_version,image_quality,undertone,chroma,face_shape,eye_shape,nose_shape,lip_fullness)
 values(s.org_id,s.id,p_request_id,'gpt-4.1-mini-2025-04-14','beauty-style-suggestion-v2',p_beauty->>'image_quality',p_beauty->>'undertone',p_beauty->>'chroma',p_beauty->>'face_shape',p_beauty->>'eye_shape',p_beauty->>'nose_shape',p_beauty->>'lip_fullness') returning id into v_id;
 for v_flag in select jsonb_array_elements_text(v_beauty_flags) loop insert into public.session_beauty_quality_flags values(s.org_id,v_id,v_flag); end loop;
 insert into public.analyses(org_id,session_id,request_id,mode,model_version,quality_status,disclaimer)
 values(s.org_id,s.id,p_request_id,'openai','gpt-4.1-mini-2025-04-14',p_skin->>'image_quality','AI observations describe visible cosmetic features in this photo, not a diagnosis or calibrated measurement. Lighting, makeup and camera quality can affect results. Photos are processed in memory by this app and are not saved or used for training. With your consent, a metadata-stripped photo is sent to OpenAI; provider retention may apply.') returning id into v_id;
 insert into public.analysis_vision_outputs values(s.org_id,v_id,'visible-appearance-eval-v1');
 for v_key in select jsonb_object_keys(v_features) loop insert into public.analysis_vision_features values(s.org_id,v_id,v_key,v_features->>v_key); end loop;
 for v_flag in select jsonb_array_elements_text(v_flags) loop insert into public.analysis_vision_quality_flags values(s.org_id,v_id,v_flag); end loop;
 update public.kiosk_sessions set last_activity_at=now() where id=s.id;
 perform private.count_session_analysis(s.org_id,s.id);
end $$;

create function public.kiosk_set_complete_skin_profile(p_session_id uuid,p_skin_type text,p_concerns text[],p_excluded_ingredients text[]) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_session(p_session_id,false);
 if p_skin_type is null or p_skin_type not in ('normal','dry','oily','combination','unsure') or p_concerns is null or cardinality(p_concerns)>4 or exists(select 1 from unnest(p_concerns) c where c is null or c not in ('dehydration','texture','uneven_tone','fine_lines')) then raise exception 'Bounded optional skin choices required' using errcode='22023'; end if;
 insert into public.session_complete_skin_profiles(org_id,session_id,skin_type_id) select s.org_id,s.id,id from public.skin_types where slug=p_skin_type on conflict(org_id,session_id) do update set skin_type_id=excluded.skin_type_id;
 delete from public.session_complete_skin_concerns where org_id=s.org_id and session_id=s.id;
 insert into public.session_complete_skin_concerns select s.org_id,s.id,id from public.concerns where slug=any(p_concerns);
 perform public.record_beauty_exclusions(s.id,p_excluded_ingredients);
end $$;
create function public.kiosk_set_complete_base_choice(p_session_id uuid,p_depth text,p_undertone text,p_concealer_purpose text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_session(p_session_id,false);
 if p_depth is null or p_depth not in ('fair','light','medium','tan','deep','unknown') or p_undertone is null or p_undertone not in ('warm','cool','neutral','unknown') or p_concealer_purpose is null or p_concealer_purpose not in ('match','brighten') then raise exception 'Bounded confirmed base choices required' using errcode='22023'; end if;
 insert into public.session_complete_base_choices(org_id,session_id,depth,undertone,concealer_purpose) values(s.org_id,s.id,p_depth,p_undertone,p_concealer_purpose) on conflict(org_id,session_id) do update set depth=excluded.depth,undertone=excluded.undertone,concealer_purpose=excluded.concealer_purpose,confirmed_at=now();
 update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;
create function private.complete_plan_json(p_org uuid,p_session uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'deadline',p.deadline,'cancelled',p.cancelled_at is not null,'slots',(select jsonb_agg(jsonb_build_object('slot',slot,'kind',kind,'status',status) order by slot) from public.session_complete_preview_slots where org_id=p.org_id and plan_id=p.id)) from public.session_complete_preview_plans p where p.org_id=p_org and p.session_id=p_session
$$;
create function public.kiosk_set_complete_preview_consent(p_session_id uuid,p_accepted boolean,p_notice_version text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_session(p_session_id,p_accepted);
 if p_accepted is null or p_notice_version is distinct from '2026-10-beauty-preview-v1' then raise exception 'Explicit nine preview consent required' using errcode='22023'; end if;
 insert into public.session_complete_preview_consents values(s.org_id,s.id,p_accepted,p_notice_version,now()) on conflict(org_id,session_id) do update set accepted=excluded.accepted,recorded_at=now();
 if not p_accepted then update public.session_complete_preview_plans set cancelled_at=coalesce(cancelled_at,now()) where org_id=s.org_id and session_id=s.id; update public.session_complete_preview_slots set status='cancelled',finished_at=now() where org_id=s.org_id and plan_id in(select id from public.session_complete_preview_plans where org_id=s.org_id and session_id=s.id) and status in ('pending','running'); end if;
end $$;
create function public.kiosk_create_preview_plan(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;p public.session_beauty_preferences;v_id uuid;
begin
 s:=private.assert_complete_session(p_session_id,true);select * into s from public.kiosk_sessions where id=s.id for update;
 select * into p from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id;
 if p.session_id is null or not exists(select 1 from public.session_beauty_analyses where org_id=s.org_id and session_id=s.id and image_quality='usable' and prompt_version='beauty-style-suggestion-v2') or not exists(select 1 from public.session_complete_preview_consents where org_id=s.org_id and session_id=s.id and accepted) then raise exception 'Usable confirmed photo and separate preview consent required' using errcode='42501'; end if;
 insert into public.session_complete_preview_plans(org_id,session_id,preferences_confirmed_at) values(s.org_id,s.id,p.confirmed_at) on conflict(org_id,session_id) do nothing returning id into v_id;
 if v_id is not null then insert into public.session_complete_preview_slots(org_id,plan_id,slot,kind) select s.org_id,v_id,n,case when n<3 then 'makeup' when n<6 then 'hair_style' else 'hair_color' end from generate_series(0,8) n; end if;
 return private.complete_plan_json(s.org_id,s.id);
end $$;
create function private.assert_complete_preview(p_session_id uuid,p_plan_id uuid) returns public.kiosk_sessions
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_session(p_session_id,true);
 if not exists(select 1 from public.session_complete_preview_consents where org_id=s.org_id and session_id=s.id and accepted)
 or not exists(select 1 from public.session_complete_preview_plans q join public.session_beauty_preferences p on p.org_id=q.org_id and p.session_id=q.session_id and p.confirmed_at=q.preferences_confirmed_at where q.org_id=s.org_id and q.session_id=s.id and q.id=p_plan_id and q.cancelled_at is null and q.deadline>now())
 then raise exception 'Current unexpired preview plan required' using errcode='42501'; end if;return s;
end $$;
create function public.kiosk_claim_preview_slot(p_session_id uuid,p_plan_id uuid,p_slot integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;v_id uuid;
begin
 s:=private.assert_complete_preview(p_session_id,p_plan_id);perform 1 from public.session_complete_preview_plans where id=p_plan_id for update;
 if exists(select 1 from public.session_complete_preview_slots where org_id=s.org_id and plan_id=p_plan_id and slot<p_slot and status not in ('complete','failed')) then raise exception 'Generate in slot order' using errcode='22023'; end if;
 update public.session_complete_preview_slots set status='running',request_id=extensions.gen_random_uuid(),claimed_at=now() where org_id=s.org_id and plan_id=p_plan_id and slot=p_slot and status='pending' returning request_id into v_id;
 if v_id is null then raise exception 'Preview attempt already used' using errcode='23505'; end if;
 update public.kiosk_sessions set last_activity_at=now() where id=s.id;return v_id;
end $$;
create function public.kiosk_assert_preview_slot(p_session_id uuid,p_plan_id uuid,p_slot integer) returns void
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_preview(p_session_id,p_plan_id);
 if not exists(select 1 from public.session_complete_preview_slots where org_id=s.org_id and plan_id=p_plan_id and slot=p_slot and status='running' and claimed_at>now()-interval '75 seconds') then raise exception 'Current individual preview attempt required' using errcode='42501'; end if;
end $$;
create function public.kiosk_complete_preview_slot(p_session_id uuid,p_plan_id uuid,p_slot integer,p_status text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_complete_preview(p_session_id,p_plan_id);
 if p_status is null or p_status not in ('complete','failed') then raise exception 'Terminal preview status required' using errcode='22023'; end if;
 perform public.kiosk_assert_preview_slot(p_session_id,p_plan_id,p_slot);
 update public.session_complete_preview_slots set status=p_status,finished_at=now() where org_id=s.org_id and plan_id=p_plan_id and slot=p_slot and status='running';
end $$;
create function public.kiosk_cancel_preview_plan(p_session_id uuid,p_plan_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 s:=private.assert_device_session(p_session_id);
 update public.session_complete_preview_plans set cancelled_at=coalesce(cancelled_at,now()) where org_id=s.org_id and session_id=s.id and id=p_plan_id;
 update public.session_complete_preview_slots set status='cancelled',finished_at=now() where org_id=s.org_id and plan_id=p_plan_id and status in ('pending','running');
end $$;

create function public.read_kiosk_beauty_complete(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions;v_vision jsonb;
begin
 select * into s from public.kiosk_sessions where id=p_session_id;
 if s.id is null or not private.own_session(s.org_id,s.id) then raise exception 'Active session permission required' using errcode='42501'; end if;
 select jsonb_build_object('prompt_version',o.prompt_version,'image_quality',a.quality_status,'quality_flags',(select coalesce(jsonb_agg(flag order by flag),'[]'::jsonb) from public.analysis_vision_quality_flags where org_id=a.org_id and analysis_id=a.id),'observed_features',(select jsonb_object_agg(feature,observed_value) from public.analysis_vision_features where org_id=a.org_id and analysis_id=a.id)) into v_vision from public.analyses a join public.analysis_vision_outputs o on o.org_id=a.org_id and o.analysis_id=a.id where a.org_id=s.org_id and a.session_id=s.id and a.mode='openai' order by a.created_at desc limit 1;
 return jsonb_build_object(
 'guest',(select jsonb_build_object('ageBand',age_band,'locale',locale,'analyticsConsent',analytics_consent) from public.session_complete_guest_context where org_id=s.org_id and session_id=s.id),
 'photoConsent',exists(select 1 from public.session_complete_photo_consents where org_id=s.org_id and session_id=s.id and accepted),
 'attempted',exists(select 1 from public.session_complete_analysis_attempts where org_id=s.org_id and session_id=s.id),
 'beauty',case when exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then public.read_kiosk_beauty_session(s.id) else jsonb_build_object('consent',false,'attempted',false,'analysis',null,'preferences',null,'excludedIngredients','[]'::jsonb) end,
 'skinVision',v_vision,
 'skinProfile',jsonb_build_object('skinType',coalesce((select st.slug from public.session_complete_skin_profiles p join public.skin_types st on st.id=p.skin_type_id where p.org_id=s.org_id and p.session_id=s.id),'unsure'),'concerns',(select coalesce(jsonb_agg(c.slug order by c.slug),'[]'::jsonb) from public.session_complete_skin_concerns p join public.concerns c on c.id=p.concern_id where p.org_id=s.org_id and p.session_id=s.id),'excludedIngredients',(select coalesce(jsonb_agg(i.inci_name order by i.inci_name),'[]'::jsonb) from public.session_excluded_ingredients e join public.ingredients i on i.id=e.ingredient_id where e.org_id=s.org_id and e.session_id=s.id)),
 'base',coalesce((select jsonb_build_object('depth',depth,'undertone',undertone,'concealerPurpose',concealer_purpose) from public.session_complete_base_choices where org_id=s.org_id and session_id=s.id),'{"depth":"unknown","undertone":"unknown","concealerPurpose":"match"}'::jsonb),
 'previewConsent',exists(select 1 from public.session_complete_preview_consents where org_id=s.org_id and session_id=s.id and accepted),
 'previewPlan',private.complete_plan_json(s.org_id,s.id));
end $$;

create function public.finish_kiosk_beauty_complete(p_session_id uuid,p_gender text default null) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;c public.session_complete_guest_context;v_week date;
begin
 select * into s from public.kiosk_sessions where id=p_session_id for update;
 if s.id is null or not private.own_device(s.org_id,s.device_id) then raise exception 'Device session permission required' using errcode='42501'; end if;
 if s.status<>'active' then return;end if;
 if p_gender is not null and p_gender not in ('woman','man','nonbinary','self_described','prefer_not_to_say') then raise exception 'Bounded optional Gender required' using errcode='22023'; end if;
 select * into c from public.session_complete_guest_context where org_id=s.org_id and session_id=s.id;
 if s.last_activity_at>now()-interval '15 minutes' and c.analytics_consent and c.age_band not in ('under13','13-15','16-17') and exists(select 1 from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id) then
  v_week:=date_trunc('week',now() at time zone 'UTC')::date;
  insert into public.store_weekly_beauty_demographics values(s.org_id,s.store_id,v_week,'age',c.age_band,1) on conflict(org_id,store_id,week_start,dimension,bucket) do update set completed_sessions=public.store_weekly_beauty_demographics.completed_sessions+1;
  if p_gender is not null then insert into public.store_weekly_beauty_demographics values(s.org_id,s.store_id,v_week,'gender',p_gender,1) on conflict(org_id,store_id,week_start,dimension,bucket) do update set completed_sessions=public.store_weekly_beauty_demographics.completed_sessions+1;end if;
 end if;
 perform public.finish_kiosk_session(s.id);
end $$;
create function public.read_staff_beauty_demographics(p_store_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.stores;v_end date;v_start date;v_age jsonb;v_gender jsonb;
begin
 select * into s from public.stores where id=p_store_id and active;
 if s.id is null or not private.can_read_store(s.org_id,s.id) then raise exception 'Store reporting permission required' using errcode='42501';end if;
 v_end:=date_trunc('week',now() at time zone 'UTC')::date;v_start:=v_end-28;
 select jsonb_build_object('suppressed',coalesce(bool_or(n between 1 and 9),false),'counts',case when coalesce(bool_or(n between 1 and 9),false) then '{}'::jsonb else coalesce(jsonb_object_agg(bucket,n),'{}'::jsonb) end) into v_age from(select bucket,sum(completed_sessions) n from public.store_weekly_beauty_demographics where org_id=s.org_id and store_id=s.id and week_start>=v_start and week_start<v_end and dimension='age' group by bucket) q;
 select jsonb_build_object('suppressed',coalesce(bool_or(n between 1 and 9),false),'counts',case when coalesce(bool_or(n between 1 and 9),false) then '{}'::jsonb else coalesce(jsonb_object_agg(bucket,n),'{}'::jsonb) end) into v_gender from(select bucket,sum(completed_sessions) n from public.store_weekly_beauty_demographics where org_id=s.org_id and store_id=s.id and week_start>=v_start and week_start<v_end and dimension='gender' group by bucket) q;
 return jsonb_build_object('periodStart',v_start,'periodEnd',v_end,'unit','completed_sessions','age',v_age,'gender',v_gender);
end $$;

-- Lifecycle cleanup remains centralized for Finish, revocation and the minute expiry job.
create or replace function private.purge_session_details(p_org uuid,p_session uuid,p_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
 delete from public.session_complete_preview_plans where org_id=p_org and session_id=p_session;
 delete from public.session_complete_preview_consents where org_id=p_org and session_id=p_session;
 delete from public.session_complete_photo_consents where org_id=p_org and session_id=p_session;
 delete from public.session_complete_analysis_attempts where org_id=p_org and session_id=p_session;
 delete from public.session_complete_guest_context where org_id=p_org and session_id=p_session;
 delete from public.session_complete_skin_profiles where org_id=p_org and session_id=p_session;
 delete from public.session_complete_skin_concerns where org_id=p_org and session_id=p_session;
 delete from public.session_complete_base_choices where org_id=p_org and session_id=p_session;
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

do $$ declare f record;begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('kiosk_set_beauty_guest_context','kiosk_set_complete_photo_consent','kiosk_claim_complete_analysis','kiosk_set_complete_skin_profile','kiosk_set_complete_base_choice','kiosk_set_complete_preview_consent','kiosk_create_preview_plan','kiosk_claim_preview_slot','kiosk_assert_preview_slot','kiosk_complete_preview_slot','kiosk_cancel_preview_plan','read_kiosk_beauty_complete','finish_kiosk_beauty_complete','read_staff_beauty_demographics') loop
 execute format('revoke all on function %s from public,anon,authenticated,analysis_writer,service_role',f.sig);execute format('grant execute on function %s to authenticated',f.sig);end loop;
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('assert_complete_session','reject_legacy_complete_attempt','complete_plan_json','assert_complete_preview') loop execute format('revoke all on function %s from public,anon,authenticated,analysis_writer,service_role',f.sig);end loop;
end $$;
revoke all on function public.write_openai_complete_analysis(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.write_openai_complete_analysis(uuid,uuid,jsonb,jsonb) to analysis_writer;
