-- A photo-free guest may explicitly choose cosmetic goals. Saving those eligible
-- products must not manufacture an analysis row, questionnaire or provider claim.
create function private.complete_skincare_eligible(p_org uuid,p_session uuid,p_variant uuid,p_form uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
 select 1 from public.concern_ingredient_rules r
 join public.recommendation_policy_versions p on p.org_id=r.org_id and p.id=r.policy_version_id and p.status='published'
 join public.formulation_ingredients f on f.org_id=r.org_id and f.ingredient_id=r.ingredient_id and f.formulation_version_id=p_form
 join public.concerns c on c.id=r.concern_id
 where r.org_id=p_org and p.id=coalesce((select rr.policy_version_id from public.recommendation_runs rr join public.recommendation_policy_versions pv on pv.org_id=rr.org_id and pv.id=rr.policy_version_id and pv.status='published' where rr.org_id=p_org and rr.session_id=p_session order by rr.created_at desc,rr.id limit 1),(select id from public.recommendation_policy_versions where org_id=p_org and status='published' order by version desc limit 1))
 and exists(select 1 from public.variant_formulations vf where vf.org_id=p_org and vf.variant_id=p_variant and vf.formulation_version_id=p_form)
 and (exists(select 1 from public.session_complete_skin_concerns sc where sc.org_id=p_org and sc.session_id=p_session and sc.concern_id=c.id)
 or exists(select 1 from public.analyses a join public.analysis_vision_features v on v.org_id=a.org_id and v.analysis_id=a.id
 join public.session_complete_analysis_attempts attempt on attempt.org_id=a.org_id and attempt.session_id=a.session_id and attempt.request_id=a.request_id and attempt.invalidated_at is null
 join public.session_complete_photo_consents consent on consent.org_id=a.org_id and consent.session_id=a.session_id and consent.accepted
 where a.org_id=p_org and a.session_id=p_session and a.mode='openai' and a.quality_status='usable' and v.observed_value='visible'
 and ((v.feature='visible_pores' and c.slug='texture') or(v.feature='visible_spots' and c.slug='uneven_tone') or(v.feature='visible_fine_lines' and c.slug='fine_lines')))))
$$;
revoke all on function private.complete_skincare_eligible(uuid,uuid,uuid,uuid) from public,anon,authenticated,analysis_writer,service_role;
-- Keep the exact current capability procedure and all tenant/stock/formula/shade
-- checks. Replace only its integrated skincare admission with independent current
-- goal + reviewed policy + formula validation, including the photo-free path.
do $$ declare definition text;old_guard text;new_guard text;
begin
 definition:=pg_get_functiondef('private.create_complete_beauty_guide(uuid,text,text,uuid[])'::regprocedure);
 old_guard:='not exists(select 1 from public.recommendation_items i join public.recommendation_runs r on r.org_id=i.org_id and r.id=i.run_id where r.org_id=s.org_id and r.session_id=s.id and i.variant_id=v_variant)';
 new_guard:='not private.complete_skincare_eligible(s.org_id,s.id,v_variant,v_form)';
 if position(old_guard in definition)=0 then raise exception 'Unexpected complete capability procedure; review migration' using errcode='55000';end if;
 execute replace(definition,old_guard,new_guard);
end $$;
