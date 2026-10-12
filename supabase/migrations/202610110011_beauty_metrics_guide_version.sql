-- Session aggregates count a completed analysis once across supported purposes.
-- This operational marker contains no appearance, style or individual report data.
alter table public.kiosk_sessions add column analysis_metric_counted boolean not null default false;
update public.kiosk_sessions s set analysis_metric_counted=true
  where exists(select 1 from public.analyses a where a.org_id=s.org_id and a.session_id=s.id);

create function private.count_session_analysis(p_org uuid,p_session uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  update public.kiosk_sessions set analysis_metric_counted=true
    where org_id=p_org and id=p_session and not analysis_metric_counted returning * into s;
  if s.id is not null then
    insert into public.store_daily_metrics(org_id,store_id,day,sessions_analyzed)
      values(s.org_id,s.store_id,(now() at time zone 'UTC')::date,1)
      on conflict(org_id,store_id,day) do update set sessions_analyzed=public.store_daily_metrics.sessions_analyzed+1;
  end if;
end $$;
revoke all on function private.count_session_analysis(uuid,uuid) from public,anon,authenticated,analysis_writer,service_role;
-- Already-saved beauty results had no aggregate increment before this migration.
do $$ declare s record; begin
  for s in select distinct org_id,session_id from public.session_beauty_analyses loop
    perform private.count_session_analysis(s.org_id,s.session_id);
  end loop;
end $$;

create or replace function public.finish_kiosk_session(p_session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_completed boolean;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or not private.own_device(s.org_id,s.device_id) then raise exception 'Device session permission required' using errcode='42501'; end if;
  if s.status<>'active' then return; end if;
  if s.last_activity_at<=now()-interval '15 minutes' then
    perform private.purge_session_details(s.org_id,s.id,'expired');
    return;
  end if;
  v_completed:=exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id)
    or exists(select 1 from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id);
  perform private.purge_session_details(s.org_id,s.id,'finished');
  if v_completed then
    insert into public.store_daily_metrics(org_id,store_id,day,sessions_completed)
      values(s.org_id,s.store_id,(now() at time zone 'UTC')::date,1)
      on conflict(org_id,store_id,day) do update set sessions_completed=public.store_daily_metrics.sessions_completed+1;
  end if;
end $$;

-- The deterministic editorial guide is versioned independently of its preferences.
-- Future guide definitions must dispatch on this pin rather than rewriting old links.
alter table public.beauty_saved_guides add column guide_version text not null default 'beauty-style-guide-v1'
  check(guide_version='beauty-style-guide-v1');

create or replace function public.write_analysis_result(p_session_id uuid,p_request_id uuid,p_mode text,p_model_version text,p_quality_status text,p_observations jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_id uuid; v_existing public.analyses; o jsonb; v_concern uuid;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or s.answers_completed_at is null or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted)
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.id=s.device_id and d.status='active' and st.active)
    then raise exception 'Active consented completed session required' using errcode='42501'; end if;
  select * into v_existing from public.analyses where request_id=p_request_id;
  if v_existing.id is not null then
    if v_existing.session_id<>s.id then raise exception 'Request belongs to another session' using errcode='42501'; end if;
    return v_existing.id;
  end if;
  if p_mode is distinct from 'mock' then raise exception 'Only visibly labeled mock analysis is enabled in this release' using errcode='22023'; end if;
  if jsonb_typeof(p_observations)<>'array' or jsonb_array_length(p_observations)>16 or p_observations is null then raise exception 'Invalid observations' using errcode='22023'; end if;
  if p_quality_status is distinct from 'demo' then raise exception 'Mock analysis must have demo quality status' using errcode='22023'; end if;
  insert into public.analyses(org_id,session_id,request_id,mode,model_version,quality_status) values(s.org_id,s.id,p_request_id,p_mode,p_model_version,p_quality_status) returning id into v_id;
  for o in select jsonb_array_elements(p_observations) loop
    select id into v_concern from public.concerns where slug=o->>'concern_id';
    if v_concern is null then raise exception 'Unknown observation concern' using errcode='22023'; end if;
    insert into public.observations values(s.org_id,v_id,v_concern,o->>'level',(o->>'score')::numeric);
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  perform private.count_session_analysis(s.org_id,s.id);
  return v_id;
end $$;

create or replace function public.write_experimental_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_disclaimer text,p_visual jsonb,p_ingredients jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_id uuid; v_existing public.analyses; h jsonb; p jsonb; c jsonb; f text; v_sum double precision; v_pred double precision;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or s.answers_completed_at is null
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-experimental-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    then raise exception 'Active consented completed session required' using errcode='42501'; end if;
  if p_request_id is distinct from p_session_id then raise exception 'Request must identify this session' using errcode='22023'; end if;
  select * into v_existing from public.analyses where request_id=p_request_id;
  if v_existing.id is not null then
    if v_existing.org_id<>s.org_id or v_existing.session_id<>s.id or v_existing.mode<>'experimental' then raise exception 'Request already has another analysis' using errcode='42501'; end if;
    return v_existing.id;
  end if;
  if p_model_version is null or length(p_model_version) not between 1 and 120 or p_disclaimer is null or length(p_disclaimer) not between 1 and 1000
    or jsonb_typeof(p_ingredients) is distinct from 'object' or octet_length(p_ingredients::text)>65536
    or jsonb_typeof(p_ingredients->'model_version') is distinct from 'string' or length(p_ingredients->>'model_version') not between 1 and 120
    or jsonb_typeof(p_ingredients->'candidates') is distinct from 'array' or jsonb_array_length(p_ingredients->'candidates')>128
    or jsonb_typeof(p_ingredients->'input_coverage') is distinct from 'array' or jsonb_array_length(p_ingredients->'input_coverage')>20
    or exists(select 1 from jsonb_object_keys(p_ingredients) k where k not in ('model_version','candidates','input_coverage'))
    then raise exception 'Invalid experimental output' using errcode='22023'; end if;
  if p_visual is not null and p_visual<>'null'::jsonb and (
    jsonb_typeof(p_visual) is distinct from 'object' or octet_length(p_visual::text)>16384
    or jsonb_typeof(p_visual->'model_version') is distinct from 'string' or length(p_visual->>'model_version') not between 1 and 120
    or jsonb_typeof(p_visual->'heads') is distinct from 'array' or jsonb_array_length(p_visual->'heads')<>8
    or exists(select 1 from jsonb_object_keys(p_visual) k where k not in ('model_version','heads')))
    then raise exception 'Invalid visual output' using errcode='22023'; end if;
  insert into public.analyses(org_id,session_id,request_id,mode,model_version,quality_status,disclaimer)
    values(s.org_id,s.id,p_request_id,'experimental',p_model_version,'experimental',p_disclaimer) returning id into v_id;
  insert into public.analysis_model_outputs values(s.org_id,v_id,'ingredients',p_ingredients->>'model_version');
  for c in select jsonb_array_elements(p_ingredients->'candidates') loop
    if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'ingredient') is distinct from 'string'
      or jsonb_typeof(c->'score') is distinct from 'number' or exists(select 1 from jsonb_object_keys(c) k where k not in ('ingredient','score'))
      then raise exception 'Invalid ingredient candidate' using errcode='22023'; end if;
    insert into public.analysis_ingredient_candidates(org_id,analysis_id,ingredient_name,score) values(s.org_id,v_id,c->>'ingredient',(c->>'score')::double precision);
  end loop;
  for c in select jsonb_array_elements(p_ingredients->'input_coverage') loop
    if jsonb_typeof(c) is distinct from 'string' then raise exception 'Invalid coverage' using errcode='22023'; end if;
    f:=c#>>'{}';
    insert into public.analysis_input_coverage(org_id,analysis_id,feature) values(s.org_id,v_id,f);
  end loop;
  if p_visual is not null and p_visual<>'null'::jsonb then
    insert into public.analysis_model_outputs values(s.org_id,v_id,'visual',p_visual->>'model_version');
    for h in select jsonb_array_elements(p_visual->'heads') loop
      if jsonb_typeof(h) is distinct from 'object' or jsonb_typeof(h->'key') is distinct from 'string' or jsonb_typeof(h->'label') is distinct from 'string'
        or jsonb_typeof(h->'predicted_code') is distinct from 'string' or jsonb_typeof(h->'probabilities') is distinct from 'array'
        or jsonb_array_length(h->'probabilities') not between 2 and 16
        or exists(select 1 from jsonb_object_keys(h) k where k not in ('key','label','predicted_code','probabilities'))
        then raise exception 'Invalid visual head' using errcode='22023'; end if;
      insert into public.analysis_visual_heads(org_id,analysis_id,head_key,label,predicted_code) values(s.org_id,v_id,h->>'key',h->>'label',h->>'predicted_code');
      for p in select jsonb_array_elements(h->'probabilities') loop
        if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'code') is distinct from 'string' or jsonb_typeof(p->'probability') is distinct from 'number'
          or exists(select 1 from jsonb_object_keys(p) k where k not in ('code','probability'))
          then raise exception 'Invalid code output' using errcode='22023'; end if;
        insert into public.analysis_visual_probabilities values(s.org_id,v_id,h->>'key',p->>'code',(p->>'probability')::double precision);
      end loop;
      select sum(probability),max(probability) filter(where code=h->>'predicted_code') into v_sum,v_pred from public.analysis_visual_probabilities where org_id=s.org_id and analysis_id=v_id and head_key=h->>'key';
      if abs(v_sum-1)>0.00001 or v_pred is null or exists(select 1 from public.analysis_visual_probabilities where org_id=s.org_id and analysis_id=v_id and head_key=h->>'key' and probability>v_pred)
        then raise exception 'Invalid categorical distribution' using errcode='22023'; end if;
    end loop;
  end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  perform private.count_session_analysis(s.org_id,s.id);
  return v_id;
end $$;

create or replace function public.write_openai_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_quality_status text,p_disclaimer text,p_vision jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; a public.analyses; v_id uuid; v_key text; v_flag jsonb; v_features jsonb; v_flags jsonb;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or s.answers_completed_at is null
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    then raise exception 'Active current consented completed session required' using errcode='42501'; end if;
  if p_request_id is distinct from p_session_id or p_model_version is distinct from 'gpt-4.1-mini-2025-04-14'
    or p_disclaimer is distinct from 'AI observations describe visible cosmetic features in this photo, not a diagnosis or calibrated measurement. Lighting, makeup and camera quality can affect results. Photos are processed in memory by this app and are not saved or used for training. With your consent, a metadata-stripped photo is sent to OpenAI; provider retention may apply.'
    or p_quality_status is null or p_quality_status not in ('usable','limited','not_assessable','not_provided')
    then raise exception 'Unsupported photo result contract' using errcode='22023'; end if;
  if p_quality_status='not_provided' then
    if p_vision is not null and p_vision<>'null'::jsonb
      then raise exception 'Photo-free result cannot contain observations' using errcode='22023'; end if;
  else
    if not exists(select 1 from public.session_vision_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-openai-photo-v1')
      or not exists(select 1 from public.session_vision_attempts where org_id=s.org_id and session_id=s.id and invalidated_at is null)
      then raise exception 'Current consent and preexisting external attempt required' using errcode='42501'; end if;
    if jsonb_typeof(p_vision) is distinct from 'object' or octet_length(p_vision::text)>4096
      or (select count(*) from jsonb_object_keys(p_vision))<>4
      or exists(select 1 from jsonb_object_keys(p_vision) k where k not in ('prompt_version','image_quality','quality_flags','observed_features'))
      or jsonb_typeof(p_vision->'prompt_version') is distinct from 'string' or jsonb_typeof(p_vision->'image_quality') is distinct from 'string'
      or p_vision->>'prompt_version' is distinct from 'visible-appearance-eval-v1'
      or p_vision->>'image_quality' is distinct from p_quality_status
      or jsonb_typeof(p_vision->'observed_features') is distinct from 'object'
      or jsonb_typeof(p_vision->'quality_flags') is distinct from 'array'
      then raise exception 'Invalid bounded photo observations' using errcode='22023'; end if;
    v_features:=p_vision->'observed_features'; v_flags:=p_vision->'quality_flags';
    if (select count(*) from jsonb_object_keys(v_features))<>5
      or exists(select 1 from jsonb_object_keys(v_features) k where k not in ('visible_redness','visible_spots','visible_pores','visible_fine_lines','visible_flaking'))
      or exists(select 1 from jsonb_each(v_features) f where jsonb_typeof(f.value)<>'string' or f.value#>>'{}' not in ('visible','not_visible','uncertain','not_assessable'))
      or jsonb_array_length(v_flags)>9 or (select count(distinct value) from jsonb_array_elements(v_flags))<>jsonb_array_length(v_flags)
      or exists(select 1 from jsonb_array_elements(v_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','occlusion','makeup_or_filter','face_not_fully_visible','resolution_limited'))
      or (p_quality_status='usable' and jsonb_array_length(v_flags)<>0)
      or (p_quality_status='usable' and exists(select 1 from jsonb_each_text(v_features) f where f.value='not_assessable'))
      or (p_quality_status<>'usable' and jsonb_array_length(v_flags)=0)
      or (p_quality_status='not_assessable' and exists(select 1 from jsonb_each_text(v_features) f where f.value<>'not_assessable'))
      or ((v_flags ? 'no_face' or v_flags ? 'multiple_faces') and p_quality_status<>'not_assessable')
      then raise exception 'Photo categories and quality flags disagree' using errcode='22023'; end if;
  end if;
  select * into a from public.analyses where request_id=p_request_id;
  if a.id is not null then
    if a.org_id<>s.org_id or a.session_id<>s.id or a.mode<>'openai' then raise exception 'Request already has another analysis' using errcode='42501'; end if;
    return a.id;
  end if;
  insert into public.analyses(org_id,session_id,request_id,mode,model_version,quality_status,disclaimer)
    values(s.org_id,s.id,p_request_id,'openai',p_model_version,p_quality_status,p_disclaimer) returning id into v_id;
  if p_quality_status<>'not_provided' then
    insert into public.analysis_vision_outputs(org_id,analysis_id,prompt_version) values(s.org_id,v_id,p_vision->>'prompt_version');
    for v_key in select jsonb_object_keys(v_features) loop
      insert into public.analysis_vision_features(org_id,analysis_id,feature,observed_value) values(s.org_id,v_id,v_key,v_features->>v_key);
    end loop;
    for v_flag in select jsonb_array_elements(v_flags) loop
      insert into public.analysis_vision_quality_flags(org_id,analysis_id,flag) values(s.org_id,v_id,v_flag#>>'{}');
    end loop;
  end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  perform private.count_session_analysis(s.org_id,s.id);
  return v_id;
end $$;

create or replace function public.write_openai_beauty_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_result jsonb) returns uuid
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
  perform private.count_session_analysis(s.org_id,s.id);
  return v_id;
end $$;

create or replace function public.read_beauty_saved_guide(p_token_hash text) returns jsonb
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
  return jsonb_build_object('guideVersion',g.guide_version,'expiresAt',g.expires_at,'preferences',jsonb_build_object('paletteId',g.palette_id,'faceShape',g.face_shape,'hairLength',g.hair_length,'mood',g.mood,'finish',g.finish),'products',v_products);
end $$;
