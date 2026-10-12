-- Explicit experimental serving: opaque visual codes and silver-label ingredient scores.
-- Images never enter the database. Every output cascades with transient analysis cleanup.
alter table public.analyses drop constraint analyses_mode_check;
alter table public.analyses add constraint analyses_mode_check check(mode in ('mock','model','experimental'));
alter table public.analyses drop constraint analyses_quality_status_check;
alter table public.analyses add constraint analyses_quality_status_check check(quality_status in ('demo','accepted','retake','unavailable','experimental'));
alter table public.analyses add constraint analysis_experimental_mode check((mode='experimental')=(quality_status='experimental'));
alter table public.analyses add column disclaimer text check(disclaimer is null or length(disclaimer) between 1 and 1000);

create table public.analysis_model_outputs (
  org_id uuid not null, analysis_id uuid not null,
  kind text not null check(kind in ('visual','ingredients')),
  model_version text not null check(length(model_version) between 1 and 120),
  primary key(org_id,analysis_id,kind),
  foreign key(org_id,analysis_id) references public.analyses(org_id,id) on delete cascade
);
create table public.analysis_visual_heads (
  org_id uuid not null, analysis_id uuid not null, kind text not null default 'visual' check(kind='visual'),
  head_key text not null check(head_key in ('sensitivity','pigmentation','wrinkles','acne','pores','sagging','keratin','redness')),
  label text not null check(length(label) between 1 and 80),
  predicted_code text not null check(predicted_code ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  primary key(org_id,analysis_id,head_key),
  foreign key(org_id,analysis_id,kind) references public.analysis_model_outputs(org_id,analysis_id,kind) on delete cascade
);
create table public.analysis_visual_probabilities (
  org_id uuid not null, analysis_id uuid not null, head_key text not null,
  code text not null check(code ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  probability double precision not null check(probability between 0 and 1),
  primary key(org_id,analysis_id,head_key,code),
  foreign key(org_id,analysis_id,head_key) references public.analysis_visual_heads(org_id,analysis_id,head_key) on delete cascade
);
create table public.analysis_ingredient_candidates (
  org_id uuid not null, analysis_id uuid not null, kind text not null default 'ingredients' check(kind='ingredients'),
  -- Checkpoint labels are not automatically promoted into the reviewed catalog dictionary.
  ingredient_name text not null check(length(trim(ingredient_name)) between 1 and 160),
  score double precision not null check(score between 0 and 1),
  primary key(org_id,analysis_id,ingredient_name),
  foreign key(org_id,analysis_id,kind) references public.analysis_model_outputs(org_id,analysis_id,kind) on delete cascade
);
create table public.analysis_input_coverage (
  org_id uuid not null, analysis_id uuid not null, kind text not null default 'ingredients' check(kind='ingredients'),
  feature text not null check(length(feature) between 1 and 120),
  primary key(org_id,analysis_id,feature),
  foreign key(org_id,analysis_id,kind) references public.analysis_model_outputs(org_id,analysis_id,kind) on delete cascade
);

do $$ declare t text; begin
  foreach t in array array['analysis_model_outputs','analysis_visual_heads','analysis_visual_probabilities','analysis_ingredient_candidates','analysis_input_coverage'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy experimental_device_read on public.%I for select to authenticated using(exists(select 1 from public.analyses a where a.org_id=%I.org_id and a.id=%I.analysis_id and private.own_session(a.org_id,a.session_id)))',t,t,t);
  end loop;
end $$;

create function public.write_experimental_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_disclaimer text,p_visual jsonb,p_ingredients jsonb) returns uuid language plpgsql security definer set search_path='' as $$
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
  insert into public.store_daily_metrics(org_id,store_id,day,sessions_analyzed) values(s.org_id,s.store_id,(now() at time zone 'UTC')::date,1)
    on conflict(org_id,store_id,day) do update set sessions_analyzed=public.store_daily_metrics.sessions_analyzed+1;
  return v_id;
end $$;
revoke all on function public.write_experimental_analysis(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.write_experimental_analysis(uuid,uuid,text,text,jsonb,jsonb) to analysis_writer;

create or replace function public.persist_recommendations(p_session_id uuid,p_analysis_id uuid,p_policy_version_id uuid,p_items jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_run uuid; v_item uuid; v_variant uuid; v_form uuid; v_rank integer:=0; x jsonb; r jsonb; v_ing uuid; v_concern uuid; v_name text;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.id=s.device_id and d.status='active' and st.active) then raise exception 'Active session required' using errcode='42501'; end if;
  if not exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id and id=p_analysis_id and ((mode='mock' and quality_status='demo') or (mode='experimental' and quality_status='experimental'))) then raise exception 'Completed supported analysis required' using errcode='22023'; end if;
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
    insert into public.recommendation_items(org_id,run_id,variant_id,rank,score,reason) values(s.org_id,v_run,v_variant,v_rank,(x->>'score')::numeric,case when exists(select 1 from public.analyses where org_id=s.org_id and id=p_analysis_id and mode='experimental') then 'Experimental ingredient candidate ranking within approved policy; not clinical efficacy.' else 'Selected by approved ingredient matching; mock consultation.' end) returning id into v_item;
    for r in select jsonb_array_elements(x->'reasons') loop
      select id into v_concern from public.concerns where slug=r->>'concern';
      select id into v_ing from public.ingredients where inci_name=r->>'ingredient';
      if not exists(select 1 from public.concern_ingredient_rules where org_id=s.org_id and policy_version_id=p_policy_version_id and concern_id=v_concern and ingredient_id=v_ing and relevance=(r->>'relevance')::integer)
        or not exists(select 1 from public.formulation_ingredients where org_id=s.org_id and formulation_version_id=v_form and ingredient_id=v_ing)
        or not exists(select 1 from public.session_concerns where org_id=s.org_id and session_id=s.id and concern_id=v_concern)
        or (exists(select 1 from public.analyses where org_id=s.org_id and id=p_analysis_id and mode='experimental') and not exists(select 1 from public.analysis_ingredient_candidates ac join public.ingredients ai on ai.inci_name=ac.ingredient_name where ac.org_id=s.org_id and ac.analysis_id=p_analysis_id and ai.id=v_ing and ac.score>0))
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
  return v_result;
end $$;


create or replace function public.record_consent(p_session_id uuid,p_policy_version text,p_accepted boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_policy_version is null or p_policy_version not in ('2026-10-mvp','2026-10-experimental-v1') then raise exception 'Unsupported consent policy version' using errcode='22023'; end if;
  if p_accepted is null then raise exception 'Explicit consent choice required' using errcode='22023'; end if;
  if exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id) then
    if exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and policy_version=p_policy_version and accepted=p_accepted) then return; end if;
    raise exception 'Consent is immutable; finish and restart the session' using errcode='22023';
  end if;
  insert into public.consents(org_id,session_id,policy_version,accepted) values(s.org_id,s.id,p_policy_version,p_accepted);
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  if not p_accepted then perform private.purge_session_details(s.org_id,s.id,'finished'); end if;
end $$;
