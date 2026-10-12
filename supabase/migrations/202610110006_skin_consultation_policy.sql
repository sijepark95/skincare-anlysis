-- A consultation report must explain the exact published policy that produced
-- its recommendations, even after a new tenant policy is published.
-- Existing normalized recommendation_runs already own this immutable reference.
create function public.read_kiosk_recommendation_policy(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; p public.recommendation_policy_versions;
begin
  s:=private.assert_device_session(p_session_id);
  select pv.* into p
    from public.recommendation_runs r
    join public.recommendation_policy_versions pv on pv.org_id=r.org_id and pv.id=r.policy_version_id
    where r.org_id=s.org_id and r.session_id=s.id and pv.status='published'
    order by r.created_at desc,r.id limit 1;
  if p.id is null then
    select * into p from public.recommendation_policy_versions
      where org_id=s.org_id and status='published' order by version desc limit 1;
  end if;
  if p.id is null then raise exception 'Recommendation policy unavailable' using errcode='55000'; end if;
  return jsonb_build_object('id',p.id,'version',p.version,'source',p.source,'rules',coalesce((
    select jsonb_agg(jsonb_build_object('concern',c.slug,'ingredient',i.inci_name,'relevance',r.relevance) order by c.slug,i.inci_name)
    from public.concern_ingredient_rules r
    join public.concerns c on c.id=r.concern_id
    join public.ingredients i on i.id=r.ingredient_id
    where r.org_id=s.org_id and r.policy_version_id=p.id
  ),'[]'::jsonb));
end $$;
revoke all on function public.read_kiosk_recommendation_policy(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_kiosk_recommendation_policy(uuid) to authenticated;

-- Preserve the current-policy endpoint while exposing the existing policy source
-- so onboarding demonstration rules are disclosed honestly by the result screen.
create or replace function public.read_recommendation_policy() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_org uuid; p public.recommendation_policy_versions;
begin
  select org_id into v_org from public.devices where auth_user_id=auth.uid() and private.own_device(org_id,id);
  if v_org is null then select org_id into v_org from public.memberships where user_id=auth.uid() and private.staff_role(org_id) in ('owner','manager') order by org_id limit 1; end if;
  if v_org is null then raise exception 'Tenant permission required' using errcode='42501'; end if;
  select * into p from public.recommendation_policy_versions where org_id=v_org and status='published' order by version desc limit 1;
  if p.id is null then raise exception 'Recommendation policy unavailable' using errcode='55000'; end if;
  return jsonb_build_object('id',p.id,'version',p.version,'source',p.source,'rules',coalesce((select jsonb_agg(jsonb_build_object('concern',c.slug,'ingredient',i.inci_name,'relevance',r.relevance) order by c.slug,i.inci_name) from public.concern_ingredient_rules r join public.concerns c on c.id=r.concern_id join public.ingredients i on i.id=r.ingredient_id where r.org_id=v_org and r.policy_version_id=p.id),'[]'::jsonb));
end $$;
