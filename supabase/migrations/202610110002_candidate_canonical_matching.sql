-- Checkpoint INCI labels may use another case or a reviewed alias. Resolve their
-- identity without changing the preserved model label or approving new names.
create function private.resolve_reviewed_ingredient(p_name text) returns uuid language sql stable security definer set search_path='' as $$
  select case when count(distinct ingredient_id)=1 then min(ingredient_id::text)::uuid else null end
  from (
    select id as ingredient_id from public.ingredients
      where lower(regexp_replace(trim(inci_name),'[[:space:]]+',' ','g'))=lower(regexp_replace(trim(p_name),'[[:space:]]+',' ','g'))
    union all
    select ingredient_id from public.ingredient_aliases
      where lower(regexp_replace(trim(alias),'[[:space:]]+',' ','g'))=lower(regexp_replace(trim(p_name),'[[:space:]]+',' ','g'))
  ) matches
$$;
revoke all on function private.resolve_reviewed_ingredient(text) from public,anon,authenticated,service_role,analysis_writer;

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


