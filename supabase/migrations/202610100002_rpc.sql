-- The API surface grants no unrestricted client table mutations.
create function public.staff_context() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships;
begin
  select * into m from public.memberships where user_id=auth.uid() and active
    and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) order by org_id limit 1;
  if m.id is null then raise exception 'Staff membership required' using errcode='42501'; end if;
  return jsonb_build_object('organization_id',m.org_id,'organization_name',(select name from public.organizations where id=m.org_id),'role',m.role,'stores',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'location','','currency',s.currency) order by s.name) from public.stores s where s.org_id=m.org_id and s.active and private.can_read_store(s.org_id,s.id)),'[]'::jsonb));
end $$;
create function public.device_context() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d public.devices;
begin
  select * into d from public.devices where auth_user_id=auth.uid() and private.own_device(org_id,id);
  if d.id is null then raise exception 'Active paired device required' using errcode='42501'; end if;
  return jsonb_build_object('organization_id',d.org_id,'store_id',d.store_id,'device_id',d.id);
end $$;

create function public.create_pairing_code(p_store_id uuid,p_label text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.stores; v_code text;
begin
  select * into s from public.stores where id=p_store_id and active;
  if s.id is null or not private.can_manage_store(s.org_id,s.id) then raise exception 'Store management permission required' using errcode='42501'; end if;
  v_code:=upper(encode(extensions.gen_random_bytes(8),'hex'));
  insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at)
  values(s.org_id,s.id,extensions.digest(v_code,'sha256'),trim(p_label),auth.uid(),now()+interval '10 minutes');
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(s.org_id,auth.uid(),'device.pairing_created',s.id);
  return jsonb_build_object('pairing_code',v_code,'expires_at',now()+interval '10 minutes');
end $$;
create function public.pair_device(p_code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.device_pairing_codes; d public.devices;
begin
  if auth.uid() is null or not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Anonymous device authentication required' using errcode='42501'; end if;
  if length(trim(p_code))<>16 then raise exception 'Invalid or expired pairing code' using errcode='22023'; end if;
  select * into c from public.device_pairing_codes where code_hash=extensions.digest(upper(trim(p_code)),'sha256') for update;
  if c.id is null or c.used_at is not null or c.expires_at<=now() then raise exception 'Invalid or expired pairing code' using errcode='22023'; end if;
  if not exists(select 1 from public.stores where org_id=c.org_id and id=c.store_id and active) then raise exception 'Store unavailable' using errcode='42501'; end if;
  if exists(select 1 from public.memberships where user_id=auth.uid()) or exists(select 1 from public.devices where auth_user_id=auth.uid()) then
    raise exception 'Identity is already enrolled; sign out before pairing a new device' using errcode='42501';
  end if;
  insert into public.devices(org_id,store_id,auth_user_id,label) values(c.org_id,c.store_id,auth.uid(),c.label) returning * into d;
  update public.device_pairing_codes set used_at=now() where id=c.id;
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(c.org_id,c.created_by,'device.paired',d.id);
  return jsonb_build_object('device_id',d.id,'store_id',d.store_id,'organization_id',d.org_id);
end $$;

create function private.purge_session_details(p_org uuid,p_session uuid,p_status text) returns void language plpgsql security definer set search_path='' as $$
begin
  delete from public.analyses where org_id=p_org and session_id=p_session;
  delete from public.session_concerns where org_id=p_org and session_id=p_session;
  delete from public.session_excluded_ingredients where org_id=p_org and session_id=p_session;
  update public.kiosk_sessions set status=p_status,skin_type_id=null,skin_sensitive=null,answers_completed_at=null,finished_at=now() where org_id=p_org and id=p_session;
end $$;
create function public.revoke_device(p_device_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare d public.devices; s record;
begin
  select * into d from public.devices where id=p_device_id for update;
  if d.id is null or not private.can_manage_store(d.org_id,d.store_id) then raise exception 'Store management permission required' using errcode='42501'; end if;
  update public.devices set status='revoked' where id=d.id;
  for s in select id from public.kiosk_sessions where org_id=d.org_id and device_id=d.id and status='active' for update loop
    perform private.purge_session_details(d.org_id,s.id,'expired');
  end loop;
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(d.org_id,auth.uid(),'device.revoked',d.id);
end $$;
create function public.start_kiosk_session() returns uuid language plpgsql security definer set search_path='' as $$
declare d public.devices; s public.kiosk_sessions; v_questionnaire uuid; v_id uuid;
begin
  select * into d from public.devices where auth_user_id=auth.uid() and private.own_device(org_id,id) for update;
  if d.id is null then raise exception 'Active paired device required' using errcode='42501'; end if;
  select * into s from public.kiosk_sessions where device_id=d.id and status='active' for update;
  if s.id is not null and s.last_activity_at > now()-interval '15 minutes' then return s.id; end if;
  if s.id is not null then perform private.purge_session_details(s.org_id,s.id,'expired'); end if;
  select id into v_questionnaire from public.questionnaire_versions where active order by version desc limit 1;
  if v_questionnaire is null then raise exception 'Questionnaire is not configured' using errcode='55000'; end if;
  insert into public.kiosk_sessions(org_id,store_id,device_id,questionnaire_version_id) values(d.org_id,d.store_id,d.id,v_questionnaire) returning id into v_id;
  update public.devices set last_seen_at=now() where id=d.id;
  insert into public.store_daily_metrics(org_id,store_id,day,sessions_started) values(d.org_id,d.store_id,(now() at time zone 'UTC')::date,1)
    on conflict(org_id,store_id,day) do update set sessions_started=public.store_daily_metrics.sessions_started+1;
  return v_id;
end $$;
create function private.assert_device_session(p_session uuid) returns public.kiosk_sessions language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  select * into s from public.kiosk_sessions where id=p_session for update;
  if s.id is null or not private.own_session(s.org_id,s.id) then raise exception 'Active session permission required' using errcode='42501'; end if;
  return s;
end $$;
create function public.record_consent(p_session_id uuid,p_policy_version text,p_accepted boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
  s:=private.assert_device_session(p_session_id);
  if p_policy_version<>'2026-10-mvp' then raise exception 'Unsupported consent policy version' using errcode='22023'; end if;
  if p_accepted is null then raise exception 'Explicit consent choice required' using errcode='22023'; end if;
  if exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id) then
    if exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and policy_version=p_policy_version and accepted=p_accepted) then return; end if;
    raise exception 'Consent is immutable; finish and restart the session' using errcode='22023';
  end if;
  insert into public.consents(org_id,session_id,policy_version,accepted) values(s.org_id,s.id,p_policy_version,p_accepted);
  update public.kiosk_sessions set last_activity_at=now() where id=s.id;
  if not p_accepted then perform private.purge_session_details(s.org_id,s.id,'finished'); end if;
end $$;
create function public.save_answers(p_session_id uuid,p_skin_type text,p_concerns text[],p_excluded_ingredients text[] default '{}',p_sensitive boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_skin uuid; v_name text; v_ingredient uuid;
begin
  s:=private.assert_device_session(p_session_id);
  if not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted) then raise exception 'Consent required' using errcode='42501'; end if;
  if exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id) then raise exception 'Answers are locked after analysis' using errcode='22023'; end if;
  select id into v_skin from public.skin_types where slug=p_skin_type;
  if v_skin is null or cardinality(p_concerns) not between 1 and 4 or cardinality(p_excluded_ingredients)>30 or p_concerns is null or p_excluded_ingredients is null or p_sensitive is null then raise exception 'Invalid questionnaire answers' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_concerns) v where v is null or not exists(select 1 from public.concerns where slug=v)) then raise exception 'Unknown concern' using errcode='22023'; end if;
  delete from public.session_concerns where org_id=s.org_id and session_id=s.id;
  insert into public.session_concerns(org_id,session_id,concern_id) select s.org_id,s.id,id from public.concerns where slug=any(p_concerns);
  delete from public.session_excluded_ingredients where org_id=s.org_id and session_id=s.id;
  foreach v_name in array p_excluded_ingredients loop
    select id into v_ingredient from public.ingredients where lower(inci_name)=lower(trim(v_name));
    if v_ingredient is null then raise exception 'Unknown excluded ingredient' using errcode='22023'; end if;
    insert into public.session_excluded_ingredients values(s.org_id,s.id,v_ingredient) on conflict do nothing;
  end loop;
  update public.kiosk_sessions set skin_type_id=v_skin,skin_sensitive=p_sensitive,answers_completed_at=now(),last_activity_at=now() where id=s.id;
end $$;
create function public.finish_kiosk_session(p_session_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_analyzed boolean;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or not private.own_device(s.org_id,s.device_id) then raise exception 'Device session permission required' using errcode='42501'; end if;
  if s.status<>'active' then return; end if;
  select exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id) into v_analyzed;
  perform private.purge_session_details(s.org_id,s.id,'finished');
  if v_analyzed then
    insert into public.store_daily_metrics(org_id,store_id,day,sessions_completed) values(s.org_id,s.store_id,(now() at time zone 'UTC')::date,1)
      on conflict(org_id,store_id,day) do update set sessions_completed=public.store_daily_metrics.sessions_completed+1;
  end if;
end $$;

create function public.read_store_catalog(p_store_id uuid) returns table(
  id uuid,organization_id uuid,store_id uuid,product_id uuid,brand text,name text,category text,sku text,
  price_minor integer,currency text,stock integer,visible boolean,status text,ingredients text[],skin_types text[],formulation_complete boolean,unresolved_ingredients text[]
) language plpgsql stable security definer set search_path='' as $$
declare s public.stores; v_device boolean; v_owner boolean;
begin
  select * into s from public.stores where public.stores.id=p_store_id and active;
  v_device:=exists(select 1 from public.devices d where d.org_id=s.org_id and d.store_id=s.id and private.own_device(d.org_id,d.id));
  v_owner:=private.staff_role(s.org_id)='owner';
  if s.id is null or not (private.can_manage_store(s.org_id,s.id) or v_device) then raise exception 'Store catalog permission required' using errcode='42501'; end if;
  return query select v.id,v.org_id,s.id,p.id,b.name,p.name,c.name,v.sku,l.price_minor,l.currency,l.stock,l.visible,f.status,
    coalesce(array(select names.name from (
      select i.inci_name as name,fi.position from public.formulation_ingredients fi join public.ingredients i on i.id=fi.ingredient_id where fi.org_id=f.org_id and fi.formulation_version_id=f.id
      union all select ui.entered_name,ui.position from public.unresolved_formulation_ingredients ui where ui.org_id=f.org_id and ui.formulation_version_id=f.id
    ) names order by names.position),'{}'::text[]),
    coalesce(array(select st.slug from public.formulation_skin_types ft join public.skin_types st on st.id=ft.skin_type_id where ft.org_id=f.org_id and ft.formulation_version_id=f.id order by st.slug),'{}'::text[]),coalesce(f.complete,false) and not exists(select 1 from public.unresolved_formulation_ingredients ui where ui.org_id=f.org_id and ui.formulation_version_id=f.id),
    coalesce(array(select ui.entered_name from public.unresolved_formulation_ingredients ui where ui.org_id=f.org_id and ui.formulation_version_id=f.id order by ui.position),'{}'::text[])
  from public.store_listings l join public.product_variants v on v.org_id=l.org_id and v.id=l.variant_id
  join public.products p on p.org_id=v.org_id and p.id=v.product_id
  join public.brands b on b.org_id=p.org_id and b.id=p.brand_id join public.categories c on c.org_id=p.org_id and c.id=p.category_id
  left join lateral (
    select fv.* from public.formulation_versions fv where fv.org_id=p.org_id and fv.product_id=p.id and
      (v_owner or exists(select 1 from public.variant_formulations vf where vf.org_id=v.org_id and vf.variant_id=v.id and vf.formulation_version_id=fv.id))
    order by fv.version desc limit 1
  ) f on true
  where l.org_id=s.org_id and l.store_id=s.id and (not v_device or (v.active and l.visible and l.stock>0 and f.status='published' and f.complete)) order by p.name,v.sku;
end $$;
create function public.save_catalog_draft(p_store_id uuid,p_product jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.stores; v_brand uuid; v_category uuid; v_product uuid; v_variant uuid; v_form uuid; v_ing uuid; v_name text; v_version integer; v_pos integer:=0; v_skin text;
begin
  select * into s from public.stores where id=p_store_id and active;
  if s.id is null or private.staff_role(s.org_id) is distinct from 'owner' then raise exception 'Organization owner required for shared catalog changes' using errcode='42501'; end if;
  if jsonb_typeof(p_product) is distinct from 'object' or jsonb_typeof(p_product->'ingredients') is distinct from 'array' or jsonb_array_length(p_product->'ingredients') not between 1 and 150 or jsonb_typeof(p_product->'skin_types') is distinct from 'array' then raise exception 'Invalid product DTO' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.org_id::text,0));
  insert into public.brands(org_id,name) values(s.org_id,trim(p_product->>'brand')) on conflict(org_id,name) do update set name=excluded.name returning id into v_brand;
  insert into public.categories(org_id,name) values(s.org_id,trim(p_product->>'category')) on conflict(org_id,name) do update set name=excluded.name returning id into v_category;
  select id,product_id into v_variant,v_product from public.product_variants where org_id=s.org_id and sku=trim(p_product->>'sku') for update;
  if v_variant is null then
    insert into public.products(org_id,brand_id,category_id,name) values(s.org_id,v_brand,v_category,trim(p_product->>'name')) returning id into v_product;
    insert into public.product_variants(org_id,product_id,sku) values(s.org_id,v_product,trim(p_product->>'sku')) returning id into v_variant;
  elsif not exists(select 1 from public.products where org_id=s.org_id and id=v_product and name=trim(p_product->>'name') and brand_id=v_brand and category_id=v_category) then
    raise exception 'Published product identity cannot be silently changed; use a new SKU' using errcode='22023';
  end if;
  select id into v_form from public.formulation_versions where org_id=s.org_id and product_id=v_product and status='draft' order by version desc limit 1 for update;
  if v_form is null then
    select coalesce(max(version),0)+1 into v_version from public.formulation_versions where org_id=s.org_id and product_id=v_product;
    insert into public.formulation_versions(org_id,product_id,version,complete) values(s.org_id,v_product,v_version,coalesce((p_product->>'formulation_complete')::boolean,false)) returning id into v_form;
  else
    update public.formulation_versions set complete=coalesce((p_product->>'formulation_complete')::boolean,false) where id=v_form;
    delete from public.formulation_ingredients where org_id=s.org_id and formulation_version_id=v_form;
    delete from public.unresolved_formulation_ingredients where org_id=s.org_id and formulation_version_id=v_form;
    delete from public.formulation_skin_types where org_id=s.org_id and formulation_version_id=v_form;
  end if;
  for v_name in select jsonb_array_elements_text(p_product->'ingredients') loop
    select i.id into v_ing from public.ingredients i where lower(i.inci_name)=lower(trim(v_name));
    if v_ing is null then select ingredient_id into v_ing from public.ingredient_aliases where lower(alias)=lower(trim(v_name)); end if;
    v_pos:=v_pos+1;
    if v_ing is null then
      insert into public.unresolved_formulation_ingredients values(s.org_id,v_form,v_pos,trim(v_name));
    else
      insert into public.formulation_ingredients values(s.org_id,v_form,v_ing,v_pos);
    end if;
  end loop;
  for v_skin in select jsonb_array_elements_text(p_product->'skin_types') loop
    if not exists(select 1 from public.skin_types where slug=v_skin) then raise exception 'Unknown skin type' using errcode='22023'; end if;
    insert into public.formulation_skin_types select s.org_id,v_form,id from public.skin_types where slug=v_skin on conflict do nothing;
  end loop;
  insert into public.store_listings(org_id,store_id,variant_id,price_minor,currency,stock,visible)
    values(s.org_id,s.id,v_variant,(p_product->>'price_minor')::integer,s.currency,coalesce((p_product->>'stock')::integer,0),false)
    on conflict(org_id,store_id,variant_id) do update set price_minor=excluded.price_minor,stock=excluded.stock;
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(s.org_id,auth.uid(),'catalog.draft_saved',v_variant);
  return v_variant;
end $$;
create function public.publish_catalog_variant(p_variant_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare v public.product_variants; f public.formulation_versions;
begin
  select * into v from public.product_variants where id=p_variant_id for update;
  if v.id is null or private.staff_role(v.org_id) is distinct from 'owner' then raise exception 'Organization owner required' using errcode='42501'; end if;
  select * into f from public.formulation_versions where org_id=v.org_id and product_id=v.product_id order by version desc limit 1 for update;
  if f.id is null or not f.complete or not exists(select 1 from public.formulation_ingredients where org_id=f.org_id and formulation_version_id=f.id)
    or exists(select 1 from public.unresolved_formulation_ingredients where org_id=f.org_id and formulation_version_id=f.id) then raise exception 'Complete reviewed formulation with resolved INCI required' using errcode='22023'; end if;
  if f.status='draft' then update public.formulation_versions set status='published',published_at=now() where id=f.id; end if;
  insert into public.variant_formulations(org_id,variant_id,product_id,formulation_version_id) values(v.org_id,v.id,v.product_id,f.id)
    on conflict(org_id,variant_id) do update set formulation_version_id=excluded.formulation_version_id;
  -- Publishing the shared formulation never overrides store-specific visibility.
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(v.org_id,auth.uid(),'catalog.published',v.id);
end $$;
create function public.update_store_listing(p_store_id uuid,p_variant_id uuid,p_price_minor integer,p_stock integer,p_visible boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.stores;
begin
  select * into s from public.stores where id=p_store_id and active;
  if s.id is null or not private.can_manage_store(s.org_id,s.id) then raise exception 'Store management permission required' using errcode='42501'; end if;
  if p_visible and not exists(select 1 from public.variant_formulations vf join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id where vf.org_id=s.org_id and vf.variant_id=p_variant_id and f.status='published' and f.complete) then raise exception 'Published formulation required' using errcode='22023'; end if;
  insert into public.store_listings values(s.org_id,s.id,p_variant_id,p_price_minor,s.currency,p_stock,p_visible)
    on conflict(org_id,store_id,variant_id) do update set price_minor=excluded.price_minor,stock=excluded.stock,visible=excluded.visible;
  insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(s.org_id,auth.uid(),'store.listing_updated',p_variant_id);
end $$;
create function public.import_catalog_drafts(p_store_id uuid,p_products jsonb) returns uuid[] language plpgsql security definer set search_path='' as $$
declare x jsonb; v_ids uuid[]:='{}';
begin
  if p_products is null or jsonb_typeof(p_products)<>'array' or jsonb_array_length(p_products) not between 1 and 500 then raise exception 'Import requires 1 to 500 products' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_products) v group by trim(v->>'sku') having count(*)>1) then raise exception 'Duplicate SKU in import' using errcode='22023'; end if;
  for x in select jsonb_array_elements(p_products) loop v_ids:=array_append(v_ids,public.save_catalog_draft(p_store_id,x)); end loop;
  return v_ids;
end $$;
create function public.read_store_devices(p_store_id uuid) returns table(id uuid,label text,status text,paired_at timestamptz,last_seen_at timestamptz) language plpgsql stable security definer set search_path='' as $$
declare s public.stores;
begin
  select * into s from public.stores where public.stores.id=p_store_id;
  if s.id is null or not private.can_manage_store(s.org_id,s.id) then raise exception 'Store management permission required' using errcode='42501'; end if;
  return query select d.id,d.label,d.status,d.paired_at,d.last_seen_at from public.devices d where d.org_id=s.org_id and d.store_id=s.id order by d.paired_at desc;
end $$;
create function public.read_store_metrics(p_store_id uuid) returns table(day date,sessions_started integer,sessions_completed integer,sessions_analyzed integer) language plpgsql stable security definer set search_path='' as $$
declare s public.stores;
begin
  select * into s from public.stores where id=p_store_id;
  if s.id is null or not private.can_read_store(s.org_id,s.id) then raise exception 'Store reporting permission required' using errcode='42501'; end if;
  return query select m.day,m.sessions_started,m.sessions_completed,m.sessions_analyzed from public.store_daily_metrics m where m.org_id=s.org_id and m.store_id=s.id and m.day >= (now() at time zone 'UTC')::date-29 order by m.day;
end $$;

create function public.read_recommendation_policy() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_org uuid; p public.recommendation_policy_versions;
begin
  select org_id into v_org from public.devices where auth_user_id=auth.uid() and private.own_device(org_id,id);
  if v_org is null then select org_id into v_org from public.memberships where user_id=auth.uid() and private.staff_role(org_id) in ('owner','manager') order by org_id limit 1; end if;
  if v_org is null then raise exception 'Tenant permission required' using errcode='42501'; end if;
  select * into p from public.recommendation_policy_versions where org_id=v_org and status='published' order by version desc limit 1;
  if p.id is null then raise exception 'Recommendation policy unavailable' using errcode='55000'; end if;
  return jsonb_build_object('id',p.id,'version',p.version,'rules',coalesce((select jsonb_agg(jsonb_build_object('concern',c.slug,'ingredient',i.inci_name,'relevance',r.relevance) order by c.slug,i.inci_name) from public.concern_ingredient_rules r join public.concerns c on c.id=r.concern_id join public.ingredients i on i.id=r.ingredient_id where r.org_id=v_org and r.policy_version_id=p.id),'[]'::jsonb));
end $$;

-- Dedicated backend role only: mock response data normalized on write.
create function public.write_analysis_result(p_session_id uuid,p_request_id uuid,p_mode text,p_model_version text,p_quality_status text,p_observations jsonb) returns uuid language plpgsql security definer set search_path='' as $$
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
  insert into public.store_daily_metrics(org_id,store_id,day,sessions_analyzed) values(s.org_id,s.store_id,(now() at time zone 'UTC')::date,1)
    on conflict(org_id,store_id,day) do update set sessions_analyzed=public.store_daily_metrics.sessions_analyzed+1;
  return v_id;
end $$;
create function public.persist_recommendations(p_session_id uuid,p_analysis_id uuid,p_policy_version_id uuid,p_items jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions; v_run uuid; v_item uuid; v_variant uuid; v_form uuid; v_rank integer:=0; x jsonb; r jsonb; v_ing uuid; v_concern uuid; v_name text;
begin
  select * into s from public.kiosk_sessions where id=p_session_id for update;
  if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.id=s.device_id and d.status='active' and st.active) then raise exception 'Active session required' using errcode='42501'; end if;
  if not exists(select 1 from public.analyses where org_id=s.org_id and session_id=s.id and id=p_analysis_id and quality_status='demo') then raise exception 'Completed mock analysis required' using errcode='22023'; end if;
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
    insert into public.recommendation_items(org_id,run_id,variant_id,rank,score,reason) values(s.org_id,v_run,v_variant,v_rank,(x->>'score')::numeric,'Selected by approved ingredient matching; mock consultation.') returning id into v_item;
    for r in select jsonb_array_elements(x->'reasons') loop
      select id into v_concern from public.concerns where slug=r->>'concern';
      select id into v_ing from public.ingredients where inci_name=r->>'ingredient';
      if not exists(select 1 from public.concern_ingredient_rules where org_id=s.org_id and policy_version_id=p_policy_version_id and concern_id=v_concern and ingredient_id=v_ing and relevance=(r->>'relevance')::integer)
        or not exists(select 1 from public.formulation_ingredients where org_id=s.org_id and formulation_version_id=v_form and ingredient_id=v_ing)
        or not exists(select 1 from public.session_concerns where org_id=s.org_id and session_id=s.id and concern_id=v_concern)
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

create function public.read_kiosk_session(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.kiosk_sessions; a public.analyses; v_recs jsonb;
begin
  select * into s from public.kiosk_sessions where id=p_session_id;
  if s.id is null or not private.own_session(s.org_id,s.id) then raise exception 'Active session permission required' using errcode='42501'; end if;
  select * into a from public.analyses where org_id=s.org_id and session_id=s.id order by created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id',ri.variant_id,'rank',ri.rank,'score',ri.score,'matched_ingredients',array(select i.inci_name from public.recommendation_item_ingredients mi join public.ingredients i on i.id=mi.ingredient_id where mi.org_id=ri.org_id and mi.item_id=ri.id order by i.inci_name),'reasons',coalesce((select jsonb_agg(jsonb_build_object('concern',c.slug,'ingredient',i.inci_name,'relevance',r.relevance)) from public.recommendation_item_reasons r join public.concerns c on c.id=r.concern_id join public.ingredients i on i.id=r.ingredient_id where r.org_id=ri.org_id and r.item_id=ri.id),'[]'::jsonb)) order by ri.rank),'[]'::jsonb) into v_recs
    from public.recommendation_items ri join public.recommendation_runs rr on rr.org_id=ri.org_id and rr.id=ri.run_id where rr.org_id=s.org_id and rr.analysis_id=a.id;
  return jsonb_build_object('id',s.id,'status',s.status,'organization_id',s.org_id,'store_id',s.store_id,'device_id',s.device_id,'created_at',s.started_at,'consent',(select jsonb_build_object('accepted',accepted,'policy_version',policy_version) from public.consents where org_id=s.org_id and session_id=s.id),
    'answers',case when s.answers_completed_at is null then null else jsonb_build_object('skinType',(select slug from public.skin_types where id=s.skin_type_id),'sensitive',s.skin_sensitive,'concerns',array(select c.slug from public.session_concerns sc join public.concerns c on c.id=sc.concern_id where sc.org_id=s.org_id and sc.session_id=s.id order by c.slug),'excludedIngredients',array(select i.inci_name from public.session_excluded_ingredients e join public.ingredients i on i.id=e.ingredient_id where e.org_id=s.org_id and e.session_id=s.id order by i.inci_name)) end,
    'analysis',case when a.id is null then null else jsonb_build_object('id',a.id,'request_id',a.request_id,'mode',a.mode,'model_version',a.model_version,'quality_status',a.quality_status,'disclaimer','Demo results generated from your questionnaire, not from a photo or AI skin measurement. For cosmetic guidance only; not a medical diagnosis.','observations',coalesce((select jsonb_agg(jsonb_build_object('concern_id',c.slug,'score',o.score,'level',o.level)) from public.observations o join public.concerns c on c.id=o.concern_id where o.org_id=a.org_id and o.analysis_id=a.id),'[]'::jsonb)) end,'recommendations',case when exists(select 1 from public.recommendation_runs where org_id=s.org_id and analysis_id=a.id) then v_recs else null end);
end $$;

create function private.cleanup_expired_data() returns jsonb language plpgsql security definer set search_path='' as $$
declare s record; v_expired integer:=0; v_consents integer; v_audits integer;
begin
  for s in select org_id,id from public.kiosk_sessions where status='active' and last_activity_at<=now()-interval '15 minutes' for update skip locked loop
    perform private.purge_session_details(s.org_id,s.id,'expired'); v_expired:=v_expired+1;
  end loop;
  delete from public.consents where recorded_at<now()-interval '30 days'; get diagnostics v_consents=row_count;
  delete from public.kiosk_sessions where status<>'active' and finished_at<now()-interval '30 days';
  delete from public.audit_events where created_at<now()-interval '90 days'; get diagnostics v_audits=row_count;
  delete from public.device_pairing_codes where expires_at<now()-interval '1 day';
  return jsonb_build_object('expired_sessions',v_expired,'deleted_consents',v_consents,'deleted_audits',v_audits);
end $$;

revoke all on all functions in schema private from public;
revoke all on function public.staff_context(),public.device_context(),public.create_pairing_code(uuid,text),public.pair_device(text),public.revoke_device(uuid),public.start_kiosk_session(),public.record_consent(uuid,text,boolean),public.save_answers(uuid,text,text[],text[],boolean),public.finish_kiosk_session(uuid),public.read_store_catalog(uuid),public.save_catalog_draft(uuid,jsonb),public.publish_catalog_variant(uuid),public.update_store_listing(uuid,uuid,integer,integer,boolean),public.read_recommendation_policy(),public.read_kiosk_session(uuid),public.write_analysis_result(uuid,uuid,text,text,text,jsonb),public.persist_recommendations(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.staff_context(),public.device_context(),public.create_pairing_code(uuid,text),public.pair_device(text),public.revoke_device(uuid),public.start_kiosk_session(),public.record_consent(uuid,text,boolean),public.save_answers(uuid,text,text[],text[],boolean),public.finish_kiosk_session(uuid),public.read_store_catalog(uuid),public.save_catalog_draft(uuid,jsonb),public.publish_catalog_variant(uuid),public.update_store_listing(uuid,uuid,integer,integer,boolean),public.read_recommendation_policy(),public.read_kiosk_session(uuid) to authenticated;
grant usage on schema public to analysis_writer;
grant execute on function public.write_analysis_result(uuid,uuid,text,text,text,jsonb),public.persist_recommendations(uuid,uuid,uuid,jsonb) to analysis_writer;
revoke all on function public.import_catalog_drafts(uuid,jsonb),public.read_store_devices(uuid),public.read_store_metrics(uuid) from public,anon,authenticated;
grant execute on function public.import_catalog_drafts(uuid,jsonb),public.read_store_devices(uuid),public.read_store_metrics(uuid) to authenticated;
