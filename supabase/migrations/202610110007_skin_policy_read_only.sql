-- PostgREST executes STABLE read RPCs in a read-only transaction. Authorization
-- must therefore use the existing nonlocking own_session guard, not a write guard.
-- Keep migration 006 immutable; no data or privileges change in this repair.
create or replace function public.read_kiosk_recommendation_policy(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; p public.recommendation_policy_versions;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id) then
    raise exception 'Active session permission required' using errcode='42501';
  end if;
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
