-- Refine the just-introduced vision protocol without rewriting applied history.
-- An explicit photo-free completion can supersede an in-flight request; results remain immutable.
-- Only usable visible pores/spots/fine-lines can add bounded cosmetic discovery goals.
alter table public.session_vision_attempts add column if not exists invalidated_at timestamptz;

create or replace function public.record_vision_consent(p_session_id uuid,p_notice_version text,p_accepted boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_notice_version is distinct from '2026-10-openai-photo-v1' or p_accepted is null then raise exception 'Explicit supported photo consent required' using errcode='22023'; end if;
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') then raise exception 'Current main consent required' using errcode='42501'; end if;
  if exists(select 1 from public.session_vision_consents where org_id=s.org_id and session_id=s.id and notice_version=p_notice_version and accepted=p_accepted) then return; end if;
  if exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id) then raise exception 'Finish and clear this session to withdraw completed photo results' using errcode='22023'; end if;
  -- A pending choice can be withdrawn. The durable attempt is deliberately retained.
  insert into public.session_vision_consents(org_id,session_id,notice_version,accepted) values(s.org_id,s.id,p_notice_version,p_accepted)
    on conflict(org_id,session_id) do update set accepted=excluded.accepted,notice_version=excluded.notice_version,recorded_at=now();
  if not p_accepted then update public.session_vision_attempts set invalidated_at=coalesce(invalidated_at,now()) where org_id=s.org_id and session_id=s.id; end if;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;

create or replace function public.claim_kiosk_vision_analysis(p_session_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_claimed uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.session_vision_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-openai-photo-v1')
    then raise exception 'Separate photo consent required' using errcode='42501'; end if;
  if s.answers_completed_at is null then raise exception 'Completed preferences required' using errcode='22023'; end if;
  if exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id) then return false; end if;
  insert into public.session_vision_attempts(org_id,session_id) values(s.org_id,s.id) on conflict(org_id,session_id) do nothing returning session_id into v_claimed;
  return v_claimed is not null;
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
  insert into public.store_daily_metrics(org_id,store_id,day,sessions_analyzed) values(s.org_id,s.store_id,(now() at time zone 'UTC')::date,1)
    on conflict(org_id,store_id,day) do update set sessions_analyzed=public.store_daily_metrics.sessions_analyzed+1;
  return v_id;
end $$;

create or replace function private.purge_session_details(p_org uuid,p_session uuid,p_status text) returns void language plpgsql security definer set search_path='' as $$
begin
  delete from public.analyses where org_id=p_org and session_id=p_session;
  delete from public.session_explanation_consents where org_id=p_org and session_id=p_session;
  delete from public.session_vision_consents where org_id=p_org and session_id=p_session;
  delete from public.session_vision_attempts where org_id=p_org and session_id=p_session;
  delete from public.session_concerns where org_id=p_org and session_id=p_session;
  delete from public.session_excluded_ingredients where org_id=p_org and session_id=p_session;
  update public.kiosk_sessions set status=p_status,skin_type_id=null,skin_sensitive=null,answers_completed_at=null,finished_at=now() where org_id=p_org and id=p_session;
end $$;

create or replace function public.record_consent(p_session_id uuid,p_policy_version text,p_accepted boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_policy_version is null or p_policy_version not in ('2026-10-mvp','2026-10-experimental-v1','2026-10-openai-v1') then raise exception 'Unsupported consent policy version' using errcode='22023'; end if;
  if p_accepted is null then raise exception 'Explicit consent choice required' using errcode='22023'; end if;
  if exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id) then
    if exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and policy_version=p_policy_version and accepted=p_accepted) then return; end if;
    raise exception 'Consent is immutable; finish and restart the session' using errcode='22023';
  end if;
  insert into public.consents(org_id,session_id,policy_version,accepted) values(s.org_id,s.id,p_policy_version,p_accepted);
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  if not p_accepted then perform private.purge_session_details(s.org_id,s.id,'finished'); end if;
end $$;

create or replace function public.read_kiosk_session(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; a public.analyses; v_recs jsonb; v_result jsonb; v_visual jsonb; v_ingredients jsonb;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id) then raise exception 'Active session permission required' using errcode='42501'; end if;
  select * into a from public.analyses where org_id=s.org_id and session_id=s.id order by created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id',ri.variant_id,'rank',ri.rank,'score',ri.score,'matched_ingredients',array(select i.inci_name from public.recommendation_item_ingredients mi join public.ingredients i on i.id=mi.ingredient_id where mi.org_id=ri.org_id and mi.item_id=ri.id order by i.inci_name),'reasons',coalesce((select jsonb_agg(jsonb_build_object('concern',c.slug,'ingredient',i.inci_name,'relevance',r.relevance)) from public.recommendation_item_reasons r join public.concerns c on c.id=r.concern_id join public.ingredients i on i.id=r.ingredient_id where r.org_id=ri.org_id and r.item_id=ri.id),'[]'::jsonb)) order by ri.rank),'[]'::jsonb) into v_recs
    from public.recommendation_items ri join public.recommendation_runs rr on rr.org_id=ri.org_id and rr.id=ri.run_id where rr.org_id=s.org_id and rr.analysis_id=a.id;
  v_result:=jsonb_build_object('id',s.id,'status',s.status,'organization_id',s.org_id,'store_id',s.store_id,'device_id',s.device_id,'created_at',s.started_at,'consent',(select jsonb_build_object('accepted',accepted,'policy_version',policy_version) from public.consents where org_id=s.org_id and session_id=s.id),
    'answers',case when s.answers_completed_at is null then null else jsonb_build_object('skinType',(select slug from public.skin_types where id=s.skin_type_id),'sensitive',s.skin_sensitive,'concerns',array(select c.slug from public.session_concerns sc join public.concerns c on c.id=sc.concern_id where sc.org_id=s.org_id and sc.session_id=s.id order by c.slug),'excludedIngredients',array(select i.inci_name from public.session_excluded_ingredients e join public.ingredients i on i.id=e.ingredient_id where e.org_id=s.org_id and e.session_id=s.id order by i.inci_name)) end,
    'analysis',case when a.id is null then null else jsonb_build_object('id',a.id,'request_id',a.request_id,'mode',a.mode,'model_version',a.model_version,'quality_status',a.quality_status,'disclaimer','Demo results generated from your questionnaire, not from a photo or AI skin measurement. For cosmetic guidance only; not a medical diagnosis.','observations',coalesce((select jsonb_agg(jsonb_build_object('concern_id',c.slug,'score',o.score,'level',o.level)) from public.observations o join public.concerns c on c.id=o.concern_id where o.org_id=a.org_id and o.analysis_id=a.id),'[]'::jsonb)) end,'recommendations',case when exists(select 1 from public.recommendation_runs where org_id=s.org_id and analysis_id=a.id) then v_recs else null end);
  if a.mode='experimental' then
    select jsonb_build_object('model_version',mo.model_version,'heads',coalesce((select jsonb_agg(jsonb_build_object('key',h.head_key,'label',h.label,'predicted_code',h.predicted_code,'probabilities',(select jsonb_agg(jsonb_build_object('code',p.code,'probability',p.probability) order by p.code) from public.analysis_visual_probabilities p where p.org_id=h.org_id and p.analysis_id=h.analysis_id and p.head_key=h.head_key)) order by h.head_key) from public.analysis_visual_heads h where h.org_id=mo.org_id and h.analysis_id=mo.analysis_id),'[]'::jsonb)) into v_visual from public.analysis_model_outputs mo where mo.org_id=s.org_id and mo.analysis_id=a.id and mo.kind='visual';
    select jsonb_build_object('model_version',mo.model_version,'candidates',coalesce((select jsonb_agg(jsonb_build_object('ingredient',c.ingredient_name,'score',c.score) order by c.score desc,c.ingredient_name) from public.analysis_ingredient_candidates c where c.org_id=mo.org_id and c.analysis_id=mo.analysis_id),'[]'::jsonb),'input_coverage',array(select feature from public.analysis_input_coverage c where c.org_id=mo.org_id and c.analysis_id=mo.analysis_id order by feature)) into v_ingredients from public.analysis_model_outputs mo where mo.org_id=s.org_id and mo.analysis_id=a.id and mo.kind='ingredients';
    v_result:=jsonb_set(v_result,'{analysis}',jsonb_build_object('id',a.id,'request_id',a.request_id,'mode',a.mode,'model_version',a.model_version,'quality_status',a.quality_status,'observations','[]'::jsonb,'disclaimer',a.disclaimer,'visual',v_visual,'ingredients',v_ingredients));
  end if;
  v_result:=v_result || jsonb_build_object(
    'explanation_consent',(select jsonb_build_object('accepted',accepted,'notice_version',notice_version) from public.session_explanation_consents where org_id=s.org_id and session_id=s.id),
    'explanation',(select jsonb_build_object('status',r.status,'summary',r.summary,'modelVersion',r.model_version,'promptVersion',r.prompt_version,
      'products',coalesce((select jsonb_agg(jsonb_build_object('productId',ri.variant_id,'text',pe.explanation_text) order by ri.rank) from public.recommendation_product_explanations pe join public.recommendation_items ri on ri.org_id=pe.org_id and ri.run_id=pe.recommendation_run_id and ri.id=pe.recommendation_item_id where pe.org_id=r.org_id and pe.recommendation_run_id=r.recommendation_run_id),'[]'::jsonb))
      from public.recommendation_explanation_runs r where r.org_id=s.org_id and r.session_id=s.id and r.status<>'pending'));
  if a.mode='openai' then
    select jsonb_build_object('prompt_version',v.prompt_version,'image_quality',a.quality_status,
      'quality_flags',array(select flag from public.analysis_vision_quality_flags f where f.org_id=v.org_id and f.analysis_id=v.analysis_id order by flag),
      'observed_features',(select jsonb_object_agg(feature,observed_value) from public.analysis_vision_features f where f.org_id=v.org_id and f.analysis_id=v.analysis_id))
      into v_visual from public.analysis_vision_outputs v where v.org_id=s.org_id and v.analysis_id=a.id;
    v_result:=jsonb_set(v_result,'{analysis}',jsonb_build_object('id',a.id,'request_id',a.request_id,'mode',a.mode,'model_version',a.model_version,'quality_status',a.quality_status,'observations','[]'::jsonb,'disclaimer',a.disclaimer,'vision',v_visual));
  end if;
  v_result:=v_result || jsonb_build_object('vision_consent',(select jsonb_build_object('accepted',accepted,'notice_version',notice_version) from public.session_vision_consents where org_id=s.org_id and session_id=s.id));
  return v_result;
end $$;

create or replace function public.persist_recommendations(p_session_id uuid,p_analysis_id uuid,p_policy_version_id uuid,p_items jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_run uuid; v_item uuid; v_variant uuid; v_form uuid; v_rank integer:=0; x jsonb; r jsonb; v_ing uuid; v_concern uuid; v_name text;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.id=s.device_id and d.status='active' and st.active) then raise exception 'Active session required' using errcode='42501'; end if;
  if not exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id and id=p_analysis_id and ((mode='mock' and quality_status='demo') or (mode='experimental' and quality_status='experimental') or (mode='openai' and quality_status in ('usable','limited','not_assessable','not_provided')))) then raise exception 'Completed supported analysis required' using errcode='22023'; end if;
  if not exists(select 1 from public.recommendation_policy_versions where org_id=s.org_id and id=p_policy_version_id and status='published') then raise exception 'Published tenant policy required' using errcode='22023'; end if;
  select id into v_run from public.recommendation_runs where org_id=s.org_id and analysis_id=p_analysis_id;
  if v_run is not null then return v_run; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>3 then raise exception 'Maximum three recommendations' using errcode='22023'; end if;
  insert into public.recommendation_runs(org_id,session_id,analysis_id,policy_version_id) values(s.org_id,s.id,p_analysis_id,p_policy_version_id) returning id into v_run;
  for x in select jsonb_array_elements(p_items) loop
    v_variant:=(x->>'variant_id')::uuid; v_rank:=v_rank+1;
    select vf.formulation_version_id into v_form from public.store_listings l join public.product_variants pv on pv.org_id=l.org_id and pv.id=l.variant_id join public.variant_formulations vf on vf.org_id=l.org_id and vf.variant_id=l.variant_id join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id
      where l.org_id=s.org_id and l.store_id=s.store_id and l.variant_id=v_variant and l.visible and l.stock>0 and pv.active and f.status='published' and f.complete for share of l,pv,vf,f;
    if v_form is null or exists(select 1 from public.formulation_ingredients fi join public.session_excluded_ingredients e on e.org_id=fi.org_id and e.ingredient_id=fi.ingredient_id where fi.org_id=s.org_id and fi.formulation_version_id=v_form and e.session_id=s.id) then raise exception 'Ineligible store product' using errcode='22023'; end if;
    if jsonb_typeof(x->'reasons') is distinct from 'array' or jsonb_array_length(x->'reasons') not between 1 and 12 or jsonb_typeof(x->'matched_ingredients') is distinct from 'array' or jsonb_array_length(x->'matched_ingredients') not between 1 and 12 then raise exception 'Valid ingredient match reasons required' using errcode='22023'; end if;
    insert into public.recommendation_items(org_id,run_id,variant_id,rank,score,reason) values(s.org_id,v_run,v_variant,v_rank,(x->>'score')::numeric,case when exists(select 1 from public.analyses where org_id=s.org_id and id=p_analysis_id and mode='experimental') then 'Experimental ingredient candidate ranking within approved policy; not clinical efficacy.' when exists(select 1 from public.analyses where org_id=s.org_id and id=p_analysis_id and mode='openai') then 'Selected preferences and approved ingredient matching; photo observations do not establish efficacy.' else 'Selected by approved ingredient matching; mock consultation.' end) returning id into v_item;
    for r in select jsonb_array_elements(x->'reasons') loop
      select id into v_concern from public.concerns where slug=r->>'concern';
      select id into v_ing from public.ingredients where inci_name=r->>'ingredient';
      if not exists(select 1 from public.concern_ingredient_rules where org_id=s.org_id and policy_version_id=p_policy_version_id and concern_id=v_concern and ingredient_id=v_ing and relevance=(r->>'relevance')::integer)
        or not exists(select 1 from public.formulation_ingredients where org_id=s.org_id and formulation_version_id=v_form and ingredient_id=v_ing)
        or not (exists(select 1 from public.session_concerns where org_id=s.org_id and session_id=s.id and concern_id=v_concern)
          or exists(select 1 from public.analyses va join public.analysis_vision_features vf on vf.org_id=va.org_id and vf.analysis_id=va.id
            join public.concerns vc on vc.id=v_concern
            where va.org_id=s.org_id and va.id=p_analysis_id and va.mode='openai' and va.quality_status='usable' and vf.observed_value='visible'
              and ((vf.feature='visible_pores' and vc.slug='texture') or (vf.feature='visible_spots' and vc.slug='uneven_tone') or (vf.feature='visible_fine_lines' and vc.slug='fine_lines'))))
        or (exists(select 1 from public.analyses where org_id=s.org_id and id=p_analysis_id and mode='experimental') and not exists(select 1 from public.analysis_ingredient_candidates ac where ac.org_id=s.org_id and ac.analysis_id=p_analysis_id and private.resolve_reviewed_ingredient(ac.ingredient_name)=v_ing and ac.score>0))
        then raise exception 'Reason must match session concern, published policy and formulation' using errcode='22023'; end if;
      insert into public.recommendation_item_reasons values(s.org_id,v_item,v_concern,v_ing,(r->>'relevance')::integer) on conflict do nothing;
    end loop;
    for v_name in select jsonb_array_elements_text(x->'matched_ingredients') loop
      select id into v_ing from public.ingredients where inci_name=v_name;
      if not exists(select 1 from public.recommendation_item_reasons where org_id=s.org_id and item_id=v_item and ingredient_id=v_ing) then raise exception 'Matched ingredient requires validated reason' using errcode='22023'; end if;
      insert into public.recommendation_item_ingredients values(s.org_id,v_item,v_ing) on conflict do nothing;
    end loop;
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  return v_run;
end $$;
