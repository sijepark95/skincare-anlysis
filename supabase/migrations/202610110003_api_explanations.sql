-- Optional external explanation is separate from permission for local inference.
-- Only final, locally validated text is retained, never an API request or raw response.
create table public.session_explanation_consents (
  org_id uuid not null, session_id uuid not null,
  notice_version text not null check(notice_version='2026-10-openai-explanation-v1'),
  accepted boolean not null, recorded_at timestamptz not null default now(),
  primary key(org_id,session_id),
  foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade
);
alter table public.recommendation_runs add constraint recommendation_runs_session_identity unique(org_id,session_id,id);
alter table public.recommendation_items add constraint recommendation_items_run_identity unique(org_id,run_id,id);
create table public.recommendation_explanation_runs (
  org_id uuid not null, session_id uuid not null, recommendation_run_id uuid not null,
  status text not null default 'pending' check(status in ('pending','generated','fallback')),
  summary text check(length(summary) between 1 and 600),
  model_version text check(length(model_version) between 1 and 120),
  prompt_version text check(prompt_version='retail-match-v1'),
  claimed_at timestamptz not null default now(), completed_at timestamptz,
  primary key(org_id,session_id), unique(org_id,recommendation_run_id),
  foreign key(org_id,session_id,recommendation_run_id) references public.recommendation_runs(org_id,session_id,id) on delete cascade,
  constraint explanation_completion_state check(
    (status='pending' and summary is null and model_version is null and prompt_version is null and completed_at is null)
    or (status='generated' and summary is not null and model_version is not null and prompt_version is not null and completed_at is not null)
    or (status='fallback' and summary is not null and model_version is null and prompt_version is not null and completed_at is not null))
);
create table public.recommendation_product_explanations (
  org_id uuid not null, recommendation_run_id uuid not null, recommendation_item_id uuid not null,
  explanation_text text not null check(length(explanation_text) between 1 and 600),
  primary key(org_id,recommendation_item_id),
  foreign key(org_id,recommendation_run_id) references public.recommendation_explanation_runs(org_id,recommendation_run_id) on delete cascade,
  foreign key(org_id,recommendation_run_id,recommendation_item_id) references public.recommendation_items(org_id,run_id,id) on delete cascade
);
do $$ declare t text; begin
  foreach t in array array['session_explanation_consents','recommendation_explanation_runs','recommendation_product_explanations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;
create policy explanation_consent_device_read on public.session_explanation_consents for select to authenticated using(private.own_session(org_id,session_id));
create policy explanation_run_device_read on public.recommendation_explanation_runs for select to authenticated using(private.own_session(org_id,session_id));
create policy product_explanation_device_read on public.recommendation_product_explanations for select to authenticated using(exists(select 1 from public.recommendation_explanation_runs r where r.org_id=recommendation_product_explanations.org_id and r.recommendation_run_id=recommendation_product_explanations.recommendation_run_id and private.own_session(r.org_id,r.session_id)));

create function public.record_explanation_consent(p_session_id uuid,p_notice_version text,p_accepted boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_notice_version is distinct from '2026-10-openai-explanation-v1' or p_accepted is null then raise exception 'Explicit supported explanation consent required' using errcode='22023'; end if;
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted) then raise exception 'Main consent required' using errcode='42501'; end if;
  if exists(select 1 from public.session_explanation_consents where org_id=s.org_id and session_id=s.id and notice_version=p_notice_version and accepted=p_accepted) then return; end if;
  if exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id) or exists(select 1 from public.recommendation_explanation_runs where org_id=s.org_id and session_id=s.id) then raise exception 'Explanation choice is locked after analysis' using errcode='22023'; end if;
  insert into public.session_explanation_consents(org_id,session_id,notice_version,accepted) values(s.org_id,s.id,p_notice_version,p_accepted)
    on conflict(org_id,session_id) do update set accepted=excluded.accepted,notice_version=excluded.notice_version,recorded_at=now();
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
end $$;
create function public.claim_kiosk_explanation(p_session_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_run uuid; v_claimed uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted)
    or not exists(select 1 from public.session_explanation_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-openai-explanation-v1')
    then raise exception 'Optional explanation consent required' using errcode='42501'; end if;
  select rr.id into v_run from public.recommendation_runs rr join public.analyses a on a.org_id=rr.org_id and a.id=rr.analysis_id and a.session_id=rr.session_id where rr.org_id=s.org_id and rr.session_id=s.id;
  if v_run is null then raise exception 'Final recommendations required' using errcode='22023'; end if;
  insert into public.recommendation_explanation_runs(org_id,session_id,recommendation_run_id) values(s.org_id,s.id,v_run) on conflict(org_id,session_id) do nothing returning session_id into v_claimed;
  return v_claimed is not null;
end $$;
revoke all on function public.record_explanation_consent(uuid,text,boolean),public.claim_kiosk_explanation(uuid) from public,anon,authenticated,analysis_writer,service_role;
grant execute on function public.record_explanation_consent(uuid,text,boolean),public.claim_kiosk_explanation(uuid) to authenticated;

create function public.complete_recommendation_explanation(p_session_id uuid,p_status text,p_summary text,p_products jsonb,p_model_version text,p_prompt_version text) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; r public.recommendation_explanation_runs; x jsonb; v_item uuid; v_rank integer:=0;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes'
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted)
    or not exists(select 1 from public.session_explanation_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-openai-explanation-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    then raise exception 'Active consented session required' using errcode='42501'; end if;
  select * into r from public.recommendation_explanation_runs where org_id=s.org_id and session_id=s.id for update;
  if r.session_id is null then raise exception 'Explanation must be claimed first' using errcode='22023'; end if;
  if r.status<>'pending' then return; end if;
  if p_status is null or p_status not in ('generated','fallback') or p_summary is null or length(p_summary) not between 1 and 600
    or p_prompt_version is distinct from 'retail-match-v1'
    or (p_status='generated' and (p_model_version is null or length(p_model_version) not between 1 and 120))
    or (p_status='fallback' and p_model_version is not null)
    or jsonb_typeof(p_products) is distinct from 'array' or jsonb_array_length(p_products)>3 or octet_length(p_products::text)>10000
    then raise exception 'Invalid explanation output' using errcode='22023'; end if;
  if jsonb_array_length(p_products)<>(select count(*) from public.recommendation_items where org_id=s.org_id and run_id=r.recommendation_run_id) then raise exception 'Explanation must cover final recommendations' using errcode='22023'; end if;
  for x in select jsonb_array_elements(p_products) loop
    v_rank:=v_rank+1;
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x->'productId') is distinct from 'string' or jsonb_typeof(x->'text') is distinct from 'string'
      or length(x->>'text') not between 1 and 600 or exists(select 1 from jsonb_object_keys(x) k where k not in ('productId','text'))
      then raise exception 'Invalid product explanation' using errcode='22023'; end if;
    select id into v_item from public.recommendation_items where org_id=s.org_id and run_id=r.recommendation_run_id and variant_id=(x->>'productId')::uuid and rank=v_rank;
    if v_item is null then raise exception 'Explanation product order must match final recommendations' using errcode='22023'; end if;
    insert into public.recommendation_product_explanations(org_id,recommendation_run_id,recommendation_item_id,explanation_text) values(s.org_id,r.recommendation_run_id,v_item,x->>'text');
  end loop;
  update public.recommendation_explanation_runs set status=p_status,summary=p_summary,model_version=p_model_version,prompt_version=p_prompt_version,completed_at=now() where org_id=s.org_id and session_id=s.id;
end $$;
revoke all on function public.complete_recommendation_explanation(uuid,text,text,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.complete_recommendation_explanation(uuid,text,text,jsonb,text,text) to analysis_writer;

-- Main consent metadata keeps its existing retention. This optional choice and text
-- are transient and are removed on finish, revoke and expiry with the analysis.
create or replace function private.purge_session_details(p_org uuid,p_session uuid,p_status text) returns void language plpgsql security definer set search_path='' as $$
begin
  delete from public.analyses where org_id=p_org and session_id=p_session;
  delete from public.session_explanation_consents where org_id=p_org and session_id=p_session;
  delete from public.session_concerns where org_id=p_org and session_id=p_session;
  delete from public.session_excluded_ingredients where org_id=p_org and session_id=p_session;
  update public.kiosk_sessions set status=p_status,skin_type_id=null,skin_sensitive=null,answers_completed_at=null,finished_at=now() where org_id=p_org and id=p_session;
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
  return v_result;
end $$;
