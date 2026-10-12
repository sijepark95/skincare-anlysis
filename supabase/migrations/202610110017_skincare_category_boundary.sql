-- New cosmetic categories must not enter the preserved skincare persistence path.
-- Keep its existing session/policy/reason guards intact behind this category gate.
alter function public.persist_recommendations(uuid,uuid,uuid,jsonb) set schema private;
revoke all on function private.persist_recommendations(uuid,uuid,uuid,jsonb) from public,anon,authenticated,analysis_writer,service_role;
create function public.persist_recommendations(p_session_id uuid,p_analysis_id uuid,p_policy_version_id uuid,p_items jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
begin
 if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Bounded skincare items required' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_items) item join public.product_variants v on v.id=(item->>'variant_id')::uuid join public.products p on p.org_id=v.org_id and p.id=v.product_id join public.categories c on c.org_id=p.org_id and c.id=p.category_id where c.name not in ('cleanser','serum','moisturizer','sunscreen')) then raise exception 'Cosmetics cannot enter skincare recommendations' using errcode='22023';end if;
 return private.persist_recommendations(p_session_id,p_analysis_id,p_policy_version_id,p_items);
end $$;
revoke all on function public.persist_recommendations(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_recommendations(uuid,uuid,uuid,jsonb) to analysis_writer;
