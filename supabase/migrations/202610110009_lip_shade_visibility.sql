-- Direct shade reads share the current guest catalog's publication/availability gate.
-- A definer helper avoids a cycle through the formulation/catalog RLS policies.
create function private.can_read_lip_shade(p_org uuid,p_variant uuid,p_version uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.store_listings l
    join public.stores s on s.org_id=l.org_id and s.id=l.store_id and s.active
    join public.product_variants v on v.org_id=l.org_id and v.id=l.variant_id
    join public.products p on p.org_id=v.org_id and p.id=v.product_id
    join public.categories c on c.org_id=p.org_id and c.id=p.category_id and c.name='lip_color'
    where l.org_id=p_org and l.variant_id=p_variant
      and (private.can_manage_store(l.org_id,l.store_id) or (
        v.active and l.visible and l.stock>0
        and exists(select 1 from public.devices d where d.org_id=l.org_id and d.store_id=l.store_id and private.own_device(d.org_id,d.id))
        and exists(select 1 from public.variant_shades vs where vs.org_id=l.org_id and vs.variant_id=v.id and (p_version is null or vs.shade_version_id=p_version))
        and exists(select 1 from public.variant_formulations vf
          join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id
          where vf.org_id=v.org_id and vf.variant_id=v.id and f.status='published' and f.complete
            and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)
            and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id))
      ))
  )
$$;
revoke all on function private.can_read_lip_shade(uuid,uuid,uuid) from public,anon,authenticated,analysis_writer,service_role;
grant execute on function private.can_read_lip_shade(uuid,uuid,uuid) to authenticated;
drop policy shade_store_read on public.variant_shades;
drop policy shade_store_read on public.variant_shade_versions;
create policy shade_store_read on public.variant_shades for select to authenticated
  using(private.can_read_lip_shade(org_id,variant_id,null));
create policy shade_store_read on public.variant_shade_versions for select to authenticated
  using(private.can_read_lip_shade(org_id,variant_id,id));

-- Bounded INCI identities only, checked against the official Dior Addict Lip Glow
-- ingredient declaration: https://www.dior.com/en_gb/beauty/products/dior-addict-lip-glow-C045700001.html
-- These names do not add efficacy rules, merchant formulas, shade claims or inventory.
insert into public.ingredients(inci_name) values
 ('Polyglyceryl-2 Triisostearate'),
 ('Helianthus Annuus (Sunflower) Seed Oil'),
 ('Hydrogenated Castor Oil Dimer Dilinoleate'),
 ('Phytosteryl/Octyldodecyl Lauroyl Glutamate'),
 ('Jojoba Esters'),
 ('Polyglyceryl-2 Isostearate/Dimer Dilinoleate Copolymer'),
 ('Candelilla Cera'),
 ('Behenyl Behenate'),
 ('Helianthus Annuus (Sunflower) Seed Wax'),
 ('Butyrospermum Parkii (Shea) Butter'),
 ('Oryza Sativa (Rice) Bran Wax'),
 ('Butyrospermum Parkii (Shea) Butter Unsaponifiables'),
 ('Diisostearyl Malate'),
 ('Prunus Avium (Sweet Cherry) Seed Oil'),
 ('Menthol'),
 ('Ethyl Vanillin'),
 ('Mentha Piperita (Peppermint) Oil'),
 ('Trimethylolpropane Triisostearate'),
 ('Vanillin'),
 ('Ascorbyl Palmitate'),
 ('Undaria Pinnatifida Extract'),
 ('Anethole'),
 ('Aluminum Hydroxide'),
 ('Beta-Caryophyllene'),
 ('Pinene'),
 ('Propyl Gallate'),
 ('CI 45380'),('CI 15850'),('CI 73360'),('CI 77491'),('CI 77492'),('CI 77499'),
 ('CI 45410'),('CI 42090'),('CI 15985'),('CI 19140'),('CI 45370')
on conflict do nothing;
insert into public.ingredient_aliases(alias,ingredient_id)
  select 'CI 77891',id from public.ingredients where inci_name='Titanium Dioxide'
on conflict do nothing;
insert into public.ingredient_aliases(alias,ingredient_id)
  select 'Candelilla Cera (Euphorbia Cerifera (Candelilla) Wax)',id from public.ingredients where inci_name='Candelilla Cera'
on conflict do nothing;

-- Keep provider request opaque and separate from the owned session identifier.
-- The trusted writer still requires a durable claim and exact echoed request ID.
create or replace function public.write_openai_color_analysis(p_session_id uuid,p_request_id uuid,p_model_version text,p_result jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_id uuid; v_flags jsonb; v_flag text;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or s.answers_completed_at is null
    or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1')
    or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
    or not exists(select 1 from public.session_color_consents where org_id=s.org_id and session_id=s.id and accepted and notice_version='2026-10-personal-color-photo-v1')
    or not exists(select 1 from public.session_color_attempts where org_id=s.org_id and session_id=s.id and invalidated_at is null)
    then raise exception 'Active consented color claim required' using errcode='42501'; end if;
  if p_request_id is null or p_model_version is distinct from 'gpt-4.1-mini-2025-04-14'
    or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>4096
    or (select count(*) from jsonb_object_keys(p_result))<>8
    or exists(select 1 from jsonb_object_keys(p_result) k where k not in ('request_id','mode','model_version','prompt_version','image_quality','undertone','chroma','quality_flags'))
    or exists(select 1 from jsonb_each(p_result) e where e.key<>'quality_flags' and jsonb_typeof(e.value)<>'string')
    or p_result->>'request_id' is distinct from p_request_id::text or p_result->>'mode' is distinct from 'openai_color'
    or p_result->>'model_version' is distinct from p_model_version or p_result->>'prompt_version' is distinct from 'personal-color-suggestion-v1'
    or p_result->>'image_quality' not in ('usable','limited','not_assessable')
    or p_result->>'undertone' not in ('warm','cool','neutral','uncertain') or p_result->>'chroma' not in ('soft','clear','uncertain')
    or jsonb_typeof(p_result->'quality_flags') is distinct from 'array'
    then raise exception 'Invalid bounded color analysis contract' using errcode='22023'; end if;
  v_flags:=p_result->'quality_flags';
  if jsonb_array_length(v_flags)>8 or (select count(distinct value) from jsonb_array_elements(v_flags))<>jsonb_array_length(v_flags)
    or exists(select 1 from jsonb_array_elements(v_flags) f where jsonb_typeof(f)<>'string' or f#>>'{}' not in ('no_face','multiple_faces','blur','low_light','uneven_lighting','makeup_or_filter','face_not_fully_visible','resolution_limited'))
    or (p_result->>'image_quality'='usable' and jsonb_array_length(v_flags)<>0)
    or (p_result->>'image_quality'<>'usable' and (jsonb_array_length(v_flags)=0 or p_result->>'undertone'<>'uncertain' or p_result->>'chroma'<>'uncertain'))
    or ((v_flags ? 'no_face' or v_flags ? 'multiple_faces') and p_result->>'image_quality'<>'not_assessable')
    then raise exception 'Color categories and quality flags disagree' using errcode='22023'; end if;
  select id into v_id from public.session_color_analyses where org_id=s.org_id and session_id=s.id;
  if v_id is not null then return v_id; end if;
  insert into public.session_color_analyses(org_id,session_id,request_id,model_version,prompt_version,image_quality,undertone,chroma)
    values(s.org_id,s.id,p_request_id,p_model_version,p_result->>'prompt_version',p_result->>'image_quality',p_result->>'undertone',p_result->>'chroma') returning id into v_id;
  for v_flag in select jsonb_array_elements_text(v_flags) loop
    insert into public.session_color_quality_flags(org_id,analysis_id,flag) values(s.org_id,v_id,v_flag);
  end loop;
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  return v_id;
end $$;

