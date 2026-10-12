-- Shared immutable shade version + disjoint category details. Legacy lip IDs remain valid.
create table public.cosmetic_shade_versions (
 id uuid primary key default extensions.gen_random_uuid(),org_id uuid not null,variant_id uuid not null,version integer not null check(version>0),
 category text not null check(category in ('lip_color','blush','eye_color','foundation','concealer')),
 shade_name text not null check(length(trim(shade_name)) between 1 and 80),undertone text not null check(undertone in ('warm','cool','neutral')),
 finish text not null check(finish in ('gloss','satin','matte','shimmer','natural','radiant')),swatch_hex text not null check(swatch_hex ~ '^#[0-9A-F]{6}$'),reviewed_at timestamptz not null default now(),
 unique(org_id,id),unique(org_id,variant_id,id),unique(org_id,variant_id,version),unique(org_id,id,category),foreign key(org_id,variant_id) references public.product_variants(org_id,id)
);
create table public.cosmetic_color_details (
 org_id uuid not null,shade_version_id uuid not null,category text not null check(category in ('lip_color','blush','eye_color')),
 hue_family text not null check(hue_family in ('peach','coral','rose','berry','nude','red','mauve','brown','gold','taupe','silver','plum','neutral')),intensity text not null check(intensity in ('soft','clear')),
 primary key(org_id,shade_version_id),foreign key(org_id,shade_version_id,category) references public.cosmetic_shade_versions(org_id,id,category)
);
create table public.cosmetic_base_details (
 org_id uuid not null,shade_version_id uuid not null,category text not null check(category in ('foundation','concealer')),
 depth text not null check(depth in ('fair','light','medium','tan','deep')),coverage text not null check(coverage in ('sheer','medium','full')),
 primary key(org_id,shade_version_id),foreign key(org_id,shade_version_id,category) references public.cosmetic_shade_versions(org_id,id,category)
);
create table public.cosmetic_variant_shades (
 org_id uuid not null,variant_id uuid not null,shade_version_id uuid not null,primary key(org_id,variant_id),
 foreign key(org_id,variant_id) references public.product_variants(org_id,id),foreign key(org_id,variant_id,shade_version_id) references public.cosmetic_shade_versions(org_id,variant_id,id)
);
insert into public.cosmetic_shade_versions(id,org_id,variant_id,version,category,shade_name,undertone,finish,swatch_hex,reviewed_at)
 select id,org_id,variant_id,version,'lip_color',shade_name,undertone,finish,swatch_hex,reviewed_at from public.variant_shade_versions;
insert into public.cosmetic_color_details select org_id,id,'lip_color',hue_family,intensity from public.variant_shade_versions;
insert into public.cosmetic_variant_shades select org_id,variant_id,shade_version_id from public.variant_shades;
create trigger immutable_cosmetic_shade before update or delete on public.cosmetic_shade_versions for each row execute function private.guard_published_shade();
create trigger immutable_cosmetic_color before update or delete on public.cosmetic_color_details for each row execute function private.guard_published_shade();
create trigger immutable_cosmetic_base before update or delete on public.cosmetic_base_details for each row execute function private.guard_published_shade();
-- Legacy publication mirrors the SAME immutable version ID, preserving its API and saved references.
create function private.mirror_legacy_lip_shade() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='variant_shade_versions' then
  insert into public.cosmetic_shade_versions(id,org_id,variant_id,version,category,shade_name,undertone,finish,swatch_hex,reviewed_at) values(new.id,new.org_id,new.variant_id,new.version,'lip_color',new.shade_name,new.undertone,new.finish,new.swatch_hex,new.reviewed_at);
  insert into public.cosmetic_color_details values(new.org_id,new.id,'lip_color',new.hue_family,new.intensity);
 else
  insert into public.cosmetic_variant_shades values(new.org_id,new.variant_id,new.shade_version_id) on conflict(org_id,variant_id) do update set shade_version_id=excluded.shade_version_id;
 end if;return new;
end $$;
create trigger mirror_complete_lip after insert on public.variant_shade_versions for each row execute function private.mirror_legacy_lip_shade();
create trigger mirror_complete_lip after insert or update on public.variant_shades for each row execute function private.mirror_legacy_lip_shade();

create function public.publish_cosmetic_shade(p_store_id uuid,p_variant_id uuid,p_shade jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.stores;v public.product_variants;v_category text;v_id uuid;v_version integer;v_base boolean;
begin
 select * into s from public.stores where id=p_store_id and active;
 if s.id is null or private.staff_role(s.org_id) is distinct from 'owner' then raise exception 'Organization owner required' using errcode='42501';end if;
 select * into v from public.product_variants where id=p_variant_id and org_id=s.org_id and active for update;
 select c.name into v_category from public.products p join public.categories c on c.org_id=p.org_id and c.id=p.category_id where p.org_id=s.org_id and p.id=v.product_id;
 if v.id is null or v_category is null or v_category not in ('lip_color','blush','eye_color','foundation','concealer') or not exists(select 1 from public.store_listings where org_id=s.org_id and store_id=s.id and variant_id=v.id)
 or not exists(select 1 from public.variant_formulations vf join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id where vf.org_id=s.org_id and vf.variant_id=v.id and f.status='published' and f.complete and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id) and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)) then raise exception 'Complete published cosmetic product required' using errcode='22023';end if;
 v_base:=v_category in ('foundation','concealer');
 if jsonb_typeof(p_shade) is distinct from 'object' or octet_length(p_shade::text)>2048 or (select count(*) from jsonb_object_keys(p_shade))<>8
 or exists(select 1 from jsonb_each(p_shade) e where e.key not in ('category','shadeName','undertone','finish','swatchHex','reviewed',case when v_base then 'depth' else 'hueFamily' end,case when v_base then 'coverage' else 'intensity' end) or (e.key<>'reviewed' and jsonb_typeof(e.value)<>'string'))
 or p_shade->>'category' is distinct from v_category or p_shade->'reviewed' is distinct from 'true'::jsonb or length(trim(p_shade->>'shadeName')) not between 1 and 80 or (p_shade->>'shadeName') ~ '[<>[:cntrl:]]' or p_shade->>'undertone' not in ('warm','cool','neutral') or p_shade->>'finish' not in ('gloss','satin','matte','shimmer','natural','radiant') or p_shade->>'swatchHex' !~* '^#[0-9a-f]{6}$'
 or (v_base and (p_shade->>'depth' not in ('fair','light','medium','tan','deep') or p_shade->>'coverage' not in ('sheer','medium','full') or p_shade->>'finish' not in ('matte','satin','natural','radiant')))
 or (not v_base and (p_shade->>'hueFamily' not in ('peach','coral','rose','berry','nude','red','mauve','brown','gold','taupe','silver','plum','neutral') or p_shade->>'intensity' not in ('soft','clear'))) then raise exception 'Exact reviewed category metadata required' using errcode='22023';end if;
 if v_category='lip_color' then return public.publish_lip_shade(p_store_id,p_variant_id,p_shade-'category');end if;
 select coalesce(max(version),0)+1 into v_version from public.cosmetic_shade_versions where org_id=s.org_id and variant_id=v.id;
 insert into public.cosmetic_shade_versions(org_id,variant_id,version,category,shade_name,undertone,finish,swatch_hex) values(s.org_id,v.id,v_version,v_category,trim(p_shade->>'shadeName'),p_shade->>'undertone',p_shade->>'finish',upper(p_shade->>'swatchHex')) returning id into v_id;
 if v_base then insert into public.cosmetic_base_details values(s.org_id,v_id,v_category,p_shade->>'depth',p_shade->>'coverage');else insert into public.cosmetic_color_details values(s.org_id,v_id,v_category,p_shade->>'hueFamily',p_shade->>'intensity');end if;
 insert into public.cosmetic_variant_shades values(s.org_id,v.id,v_id) on conflict(org_id,variant_id) do update set shade_version_id=excluded.shade_version_id;
 insert into public.audit_events(org_id,actor_user_id,action,resource_id) values(s.org_id,auth.uid(),'catalog.cosmetic_shade_published',v.id);return v_id;
end $$;
create function public.read_store_cosmetic_shades(p_store_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.stores;v_device boolean;v_result jsonb;
begin
 select * into s from public.stores where id=p_store_id and active;
 v_device:=exists(select 1 from public.devices d where d.org_id=s.org_id and d.store_id=s.id and private.own_device(d.org_id,d.id));
 if s.id is null or not (private.can_manage_store(s.org_id,s.id) or v_device) then raise exception 'Store catalog permission required' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('variantId',v.id,'organizationId',sv.org_id,'versionId',sv.id,'version',sv.version,'category',sv.category,'shadeName',sv.shade_name,'undertone',sv.undertone,'finish',sv.finish,'swatchHex',sv.swatch_hex,'reviewed',true)||case when cb.shade_version_id is not null then jsonb_build_object('depth',cb.depth,'coverage',cb.coverage) else jsonb_build_object('hueFamily',cc.hue_family,'intensity',cc.intensity) end order by v.sku),'[]'::jsonb) into v_result
 from public.store_listings l join public.product_variants v on v.org_id=l.org_id and v.id=l.variant_id
 join public.products p on p.org_id=v.org_id and p.id=v.product_id join public.categories c on c.org_id=p.org_id and c.id=p.category_id
 join public.cosmetic_variant_shades vs on vs.org_id=v.org_id and vs.variant_id=v.id join public.cosmetic_shade_versions sv on sv.org_id=vs.org_id and sv.variant_id=vs.variant_id and sv.id=vs.shade_version_id and sv.category=c.name
 left join public.cosmetic_color_details cc on cc.org_id=sv.org_id and cc.shade_version_id=sv.id left join public.cosmetic_base_details cb on cb.org_id=sv.org_id and cb.shade_version_id=sv.id
 left join public.variant_formulations vf on vf.org_id=v.org_id and vf.variant_id=v.id left join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id
 where l.org_id=s.org_id and l.store_id=s.id and (cc.shade_version_id is not null or cb.shade_version_id is not null) and (not v_device or(v.active and l.visible and l.stock>0 and f.status='published' and f.complete and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id) and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id)));
 return v_result;
end $$;

create function public.confirm_complete_beauty_preferences(p_session_id uuid,p_preferences jsonb) returns void language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin s:=private.assert_complete_session(p_session_id,false);perform public.confirm_kiosk_beauty_preferences(s.id,p_preferences);end $$;
create function private.cancel_changed_complete_preview() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and to_jsonb(new)-'confirmed_at' is distinct from to_jsonb(old)-'confirmed_at' then
 update public.session_complete_preview_plans set cancelled_at=coalesce(cancelled_at,now()) where org_id=new.org_id and session_id=new.session_id;
 update public.session_complete_preview_slots set status='cancelled',finished_at=now() where org_id=new.org_id and plan_id in(select id from public.session_complete_preview_plans where org_id=new.org_id and session_id=new.session_id) and status in ('pending','running');end if;
 return new;
end $$;
create trigger complete_preference_change after update on public.session_beauty_preferences for each row execute function private.cancel_changed_complete_preview();
create trigger complete_base_change after update on public.session_complete_base_choices for each row execute function private.cancel_changed_complete_preview();

create function public.persist_complete_recommendations(p_session_id uuid,p_policy_version_id uuid,p_items jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;a public.analyses;v_run uuid;v_item uuid;v_variant uuid;v_form uuid;v_rank integer:=0;x jsonb;r jsonb;v_ing uuid;v_concern uuid;v_name text;
begin
 select * into s from public.kiosk_sessions where id=p_session_id for update;
 if s.id is null or s.status<>'active' or s.last_activity_at<=now()-interval '15 minutes' or not exists(select 1 from public.devices d join public.stores st on st.org_id=d.org_id and st.id=d.store_id where d.org_id=s.org_id and d.id=s.device_id and d.status='active' and st.active)
 or not exists(select 1 from public.consents where org_id=s.org_id and session_id=s.id and accepted and policy_version='2026-10-openai-v1') or not exists(select 1 from public.session_complete_guest_context where org_id=s.org_id and session_id=s.id and age_band<>'under13') then raise exception 'Active integrated session required' using errcode='42501';end if;
 select * into a from public.analyses where org_id=s.org_id and session_id=s.id and mode='openai' order by created_at desc limit 1;
 if a.id is null or not exists(select 1 from public.session_complete_analysis_attempts where org_id=s.org_id and session_id=s.id and request_id=a.request_id and invalidated_at is null) or not exists(select 1 from public.session_complete_photo_consents where org_id=s.org_id and session_id=s.id and accepted) then raise exception 'Current integrated analysis required' using errcode='42501';end if;
 if not exists(select 1 from public.recommendation_policy_versions where org_id=s.org_id and id=p_policy_version_id and status='published') or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>3 then raise exception 'Published tenant policy and bounded product list required' using errcode='22023';end if;
 delete from public.recommendation_runs where org_id=s.org_id and analysis_id=a.id;
 insert into public.recommendation_runs(org_id,session_id,analysis_id,policy_version_id) values(s.org_id,s.id,a.id,p_policy_version_id) returning id into v_run;
 for x in select jsonb_array_elements(p_items) loop
 v_variant:=(x->>'variant_id')::uuid;v_rank:=v_rank+1;
 select vf.formulation_version_id into v_form from public.store_listings l join public.product_variants pv on pv.org_id=l.org_id and pv.id=l.variant_id join public.products pr on pr.org_id=pv.org_id and pr.id=pv.product_id join public.categories cat on cat.org_id=pr.org_id and cat.id=pr.category_id join public.variant_formulations vf on vf.org_id=l.org_id and vf.variant_id=l.variant_id join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id
 where l.org_id=s.org_id and l.store_id=s.store_id and l.variant_id=v_variant and l.visible and l.stock>0 and pv.active and f.status='published' and f.complete and cat.name in ('cleanser','serum','moisturizer','sunscreen') and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id) and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id) for share of l,pv,vf,f;
 if v_form is null or exists(select 1 from public.formulation_ingredients fi join public.session_excluded_ingredients e on e.org_id=fi.org_id and e.ingredient_id=fi.ingredient_id where fi.org_id=s.org_id and fi.formulation_version_id=v_form and e.session_id=s.id) then raise exception 'Ineligible skincare product' using errcode='22023';end if;
 if jsonb_typeof(x->'reasons') is distinct from 'array' or jsonb_array_length(x->'reasons') not between 1 and 12 or jsonb_typeof(x->'matched_ingredients') is distinct from 'array' or jsonb_array_length(x->'matched_ingredients') not between 1 and 12 then raise exception 'Bounded ingredient reasons required' using errcode='22023';end if;
 insert into public.recommendation_items(org_id,run_id,variant_id,rank,score,reason) values(s.org_id,v_run,v_variant,v_rank,(x->>'score')::numeric,'Visible cosmetic goals and reviewed store ingredient policy; not efficacy or safety.') returning id into v_item;
 for r in select jsonb_array_elements(x->'reasons') loop
 select id into v_concern from public.concerns where slug=r->>'concern';select id into v_ing from public.ingredients where inci_name=r->>'ingredient';
 if not exists(select 1 from public.concern_ingredient_rules where org_id=s.org_id and policy_version_id=p_policy_version_id and concern_id=v_concern and ingredient_id=v_ing and relevance=(r->>'relevance')::integer) or not exists(select 1 from public.formulation_ingredients where org_id=s.org_id and formulation_version_id=v_form and ingredient_id=v_ing)
 or not(exists(select 1 from public.session_complete_skin_concerns where org_id=s.org_id and session_id=s.id and concern_id=v_concern) or exists(select 1 from public.analysis_vision_features vf join public.concerns vc on vc.id=v_concern where vf.org_id=s.org_id and vf.analysis_id=a.id and a.quality_status='usable' and vf.observed_value='visible' and ((vf.feature='visible_pores' and vc.slug='texture') or(vf.feature='visible_spots' and vc.slug='uneven_tone') or(vf.feature='visible_fine_lines' and vc.slug='fine_lines')))) then raise exception 'Reason must match current goal, policy and formulation' using errcode='22023';end if;
 insert into public.recommendation_item_reasons values(s.org_id,v_item,v_concern,v_ing,(r->>'relevance')::integer) on conflict do nothing;end loop;
 for v_name in select jsonb_array_elements_text(x->'matched_ingredients') loop select id into v_ing from public.ingredients where inci_name=v_name;if not exists(select 1 from public.recommendation_item_reasons where org_id=s.org_id and item_id=v_item and ingredient_id=v_ing) then raise exception 'Matched ingredient requires a validated reason' using errcode='22023';end if;insert into public.recommendation_item_ingredients values(s.org_id,v_item,v_ing) on conflict do nothing;end loop;
 end loop;return v_run;
end $$;

create table public.complete_beauty_saved_guides (
 id uuid primary key default extensions.gen_random_uuid(),org_id uuid not null,store_id uuid not null,token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),locale text not null check(locale in ('en','ko','es')),
 palette_id text not null check(palette_id in ('warm_soft','warm_clear','cool_soft','cool_clear','neutral_soft','neutral_clear')),face_shape text not null check(face_shape in ('oval','round','square','oblong','heart','diamond','unsure')),hair_length text not null check(hair_length in ('any','short','medium','long')),mood text not null check(mood in ('soft','fresh','defined')),finish text not null check(finish in ('any','gloss','satin','matte')),
 created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '7 days',revoked_at timestamptz,
 unique(org_id,id),foreign key(org_id,store_id) references public.stores(org_id,id),check(expires_at<=created_at+interval '7 days')
);
create table public.complete_beauty_saved_products (
 org_id uuid not null,guide_id uuid not null,rank integer not null check(rank between 1 and 18),variant_id uuid not null,product_id uuid not null,formulation_version_id uuid not null,shade_version_id uuid,
 primary key(org_id,guide_id,rank),unique(org_id,guide_id,variant_id),foreign key(org_id,guide_id) references public.complete_beauty_saved_guides(org_id,id) on delete cascade,
 foreign key(org_id,product_id,variant_id) references public.product_variants(org_id,product_id,id),foreign key(org_id,product_id,formulation_version_id) references public.formulation_versions(org_id,product_id,id),foreign key(org_id,variant_id,shade_version_id) references public.cosmetic_shade_versions(org_id,variant_id,id)
);
create table public.session_complete_saved_guides (
 org_id uuid not null,session_id uuid not null,guide_id uuid not null,primary key(org_id,session_id),foreign key(org_id,session_id) references public.kiosk_sessions(org_id,id) on delete cascade,foreign key(org_id,guide_id) references public.complete_beauty_saved_guides(org_id,id) on delete cascade
);
create function public.create_complete_beauty_guide(p_session_id uuid,p_token_hash text,p_notice_version text,p_variant_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;p public.session_beauty_preferences;b public.session_complete_base_choices;g public.complete_beauty_saved_guides;v_id uuid;v_variant uuid;v_product uuid;v_form uuid;v_shade uuid;v_category text;v_rank integer:=0;v_category_counts jsonb:='{}'::jsonb;sv public.cosmetic_shade_versions;cb public.cosmetic_base_details;cc public.cosmetic_color_details;v_target text;
begin
 s:=private.assert_complete_session(p_session_id,false);perform 1 from public.kiosk_sessions where id=s.id for update;
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_notice_version is distinct from '2026-10-complete-save-v1' or p_variant_ids is null or cardinality(p_variant_ids)>18 then raise exception 'Bounded opt-in save contract required' using errcode='22023';end if;
 select * into p from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id;select * into b from public.session_complete_base_choices where org_id=s.org_id and session_id=s.id;
 if p.session_id is null then raise exception 'Confirmed style required' using errcode='22023';end if;
 select saved.* into g from public.session_complete_saved_guides link join public.complete_beauty_saved_guides saved on saved.org_id=link.org_id and saved.id=link.guide_id where link.org_id=s.org_id and link.session_id=s.id;
 if g.id is not null then if g.token_hash<>p_token_hash or g.revoked_at is not null or g.expires_at<=now() then raise exception 'Saved guide unavailable' using errcode='42501';end if;return jsonb_build_object('expiresAt',g.expires_at);end if;
 insert into public.complete_beauty_saved_guides(org_id,store_id,token_hash,locale,palette_id,face_shape,hair_length,mood,finish) select s.org_id,s.store_id,p_token_hash,c.locale,p.palette_id,p.face_shape,p.hair_length,p.mood,p.finish from public.session_complete_guest_context c where c.org_id=s.org_id and c.session_id=s.id returning id into v_id;
 insert into public.session_complete_saved_guides values(s.org_id,s.id,v_id);
 foreach v_variant in array p_variant_ids loop
 v_form:=null;v_shade:=null;v_rank:=v_rank+1;
 select pv.product_id,vf.formulation_version_id,c.name into v_product,v_form,v_category from public.store_listings l join public.product_variants pv on pv.org_id=l.org_id and pv.id=l.variant_id join public.products pr on pr.org_id=pv.org_id and pr.id=pv.product_id join public.categories c on c.org_id=pr.org_id and c.id=pr.category_id join public.variant_formulations vf on vf.org_id=pv.org_id and vf.variant_id=pv.id join public.formulation_versions f on f.org_id=vf.org_id and f.id=vf.formulation_version_id where l.org_id=s.org_id and l.store_id=s.store_id and l.variant_id=v_variant and l.visible and l.stock>0 and pv.active and f.status='published' and f.complete and exists(select 1 from public.formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id) and not exists(select 1 from public.unresolved_formulation_ingredients i where i.org_id=f.org_id and i.formulation_version_id=f.id) for share of l,pv,vf,f;
 if v_form is null or exists(select 1 from public.formulation_ingredients i join public.session_excluded_ingredients e on e.org_id=i.org_id and e.ingredient_id=i.ingredient_id where i.org_id=s.org_id and i.formulation_version_id=v_form and e.session_id=s.id) then raise exception 'Ineligible saved product' using errcode='22023';end if;
 v_target:=case when v_category in ('cleanser','serum','moisturizer','sunscreen') then 'skincare' else v_category end;
 v_category_counts:=jsonb_set(v_category_counts,array[v_target],to_jsonb(coalesce((v_category_counts->>v_target)::integer,0)+1));
 if (v_category_counts->>v_target)::integer>3 then raise exception 'Maximum three products per recommendation category' using errcode='22023';end if;
 if v_category in ('cleanser','serum','moisturizer','sunscreen') then
 if not exists(select 1 from public.recommendation_items i join public.recommendation_runs r on r.org_id=i.org_id and r.id=i.run_id where r.org_id=s.org_id and r.session_id=s.id and i.variant_id=v_variant) then raise exception 'Skincare product must be a validated current recommendation' using errcode='22023';end if;
 else
 select vs.* into sv from public.cosmetic_variant_shades v join public.cosmetic_shade_versions vs on vs.org_id=v.org_id and vs.id=v.shade_version_id where v.org_id=s.org_id and v.variant_id=v_variant and vs.category=v_category;
 if sv.id is null then raise exception 'Reviewed saved shade required' using errcode='22023';end if;v_shade:=sv.id;
 if v_category in ('foundation','concealer') then
 select * into cb from public.cosmetic_base_details where org_id=s.org_id and shade_version_id=sv.id;
 v_target:=b.depth;
 if v_category='concealer' and b.concealer_purpose='brighten' then v_target:=case b.depth when 'deep' then 'tan' when 'tan' then 'medium' when 'medium' then 'light' when 'light' then 'fair' when 'fair' then 'fair' else 'unknown' end;end if;
 if cb.shade_version_id is null or b.session_id is null or b.depth='unknown' or b.undertone='unknown' or cb.depth<>v_target or sv.undertone not in (b.undertone,'neutral') then raise exception 'Saved base shade must match confirmed context' using errcode='22023';end if;
 else
 select * into cc from public.cosmetic_color_details where org_id=s.org_id and shade_version_id=sv.id;
 if cc.shade_version_id is null or (split_part(p.palette_id,'_',1)<>'neutral' and sv.undertone not in(split_part(p.palette_id,'_',1),'neutral')) or (v_category='lip_color' and p.finish<>'any' and sv.finish<>p.finish)
 or (split_part(p.palette_id,'_',1)='warm' and cc.hue_family not in ('peach','coral','nude','red','brown','gold','taupe','neutral')) or (split_part(p.palette_id,'_',1)='cool' and cc.hue_family not in ('rose','berry','mauve','red','nude','brown','taupe','silver','plum','neutral')) then raise exception 'Saved color shade must match confirmed palette' using errcode='22023';end if;
 end if;end if;
 insert into public.complete_beauty_saved_products values(s.org_id,v_id,v_rank,v_variant,v_product,v_form,v_shade);
 end loop;return jsonb_build_object('expiresAt',(select expires_at from public.complete_beauty_saved_guides where id=v_id));
end $$;
create function public.read_complete_beauty_guide(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare g public.complete_beauty_saved_guides;v_products jsonb;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return null;end if;
 select saved.* into g from public.complete_beauty_saved_guides saved join public.stores s on s.org_id=saved.org_id and s.id=saved.store_id and s.active where saved.token_hash=p_token_hash and saved.revoked_at is null and saved.expires_at>now();if g.id is null then return null;end if;
 select coalesce(jsonb_agg(jsonb_build_object('variantId',v.id,'category',c.name,'formulationVersionId',i.formulation_version_id,'shadeVersionId',i.shade_version_id,'name',p.name,'brand',b.name,'shadeName',sv.shade_name,'swatchHex',sv.swatch_hex,'priceMinor',l.price_minor,'currency',l.currency,'available',coalesce(v.active and l.visible and l.stock>0 and vf.formulation_version_id=i.formulation_version_id and (i.shade_version_id is null or cvs.shade_version_id=i.shade_version_id) and f.status='published' and f.complete,false)) order by i.rank),'[]'::jsonb) into v_products
 from public.complete_beauty_saved_products i join public.product_variants v on v.org_id=i.org_id and v.id=i.variant_id join public.products p on p.org_id=v.org_id and p.id=v.product_id join public.categories c on c.org_id=p.org_id and c.id=p.category_id join public.brands b on b.org_id=p.org_id and b.id=p.brand_id join public.formulation_versions f on f.org_id=i.org_id and f.id=i.formulation_version_id
 left join public.cosmetic_shade_versions sv on sv.org_id=i.org_id and sv.id=i.shade_version_id left join public.cosmetic_variant_shades cvs on cvs.org_id=i.org_id and cvs.variant_id=i.variant_id left join public.variant_formulations vf on vf.org_id=i.org_id and vf.variant_id=i.variant_id left join public.store_listings l on l.org_id=i.org_id and l.store_id=g.store_id and l.variant_id=i.variant_id where i.org_id=g.org_id and i.guide_id=g.id;
 return jsonb_build_object('version','beauty-complete-guide-v1','expiresAt',g.expires_at,'locale',g.locale,'preferences',jsonb_build_object('paletteId',g.palette_id,'faceShape',g.face_shape,'hairLength',g.hair_length,'mood',g.mood,'finish',g.finish),'products',v_products);
end $$;
create function public.revoke_complete_beauty_guide(p_token_hash text) returns void language plpgsql security definer set search_path='' as $$
begin if p_token_hash ~ '^[0-9a-f]{64}$' then delete from public.complete_beauty_saved_guides where token_hash=p_token_hash;end if;end $$;
create function private.cleanup_complete_guides() returns trigger language plpgsql security definer set search_path='' as $$
begin delete from public.session_complete_saved_guides where org_id=new.org_id and session_id=new.id;if new.status<>'active' then delete from public.complete_beauty_saved_guides where expires_at<=now() or revoked_at is not null;end if;return new;end $$;
create trigger complete_finish_save_link after update of status on public.kiosk_sessions for each row when(new.status<>'active') execute function private.cleanup_complete_guides();
-- Existing minute cleanup calls the legacy saved-guide delete; use a statement trigger
-- to purge the new seven-day capabilities in the same scheduled transaction.
create function private.cleanup_complete_expired_guides() returns trigger language plpgsql security definer set search_path='' as $$
begin delete from public.complete_beauty_saved_guides where expires_at<=now() or revoked_at is not null;return null;end $$;
create trigger complete_expiry_cleanup after delete on public.beauty_saved_guides for each statement execute function private.cleanup_complete_expired_guides();

do $$ declare t text;f record;begin
 foreach t in array array['cosmetic_shade_versions','cosmetic_color_details','cosmetic_base_details','cosmetic_variant_shades','complete_beauty_saved_guides','complete_beauty_saved_products','session_complete_saved_guides'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,analysis_writer,service_role',t);end loop;
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('publish_cosmetic_shade','read_store_cosmetic_shades','confirm_complete_beauty_preferences','create_complete_beauty_guide') loop execute format('revoke all on function %s from public,anon,authenticated,analysis_writer,service_role',f.sig);execute format('grant execute on function %s to authenticated',f.sig);end loop;
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('mirror_legacy_lip_shade','cancel_changed_complete_preview','cleanup_complete_guides','cleanup_complete_expired_guides') loop execute format('revoke all on function %s from public,anon,authenticated,analysis_writer,service_role',f.sig);end loop;
end $$;
revoke all on function public.persist_complete_recommendations(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_complete_recommendations(uuid,uuid,jsonb) to analysis_writer;
revoke all on function public.read_complete_beauty_guide(text),public.revoke_complete_beauty_guide(text) from public,analysis_writer,service_role;
grant execute on function public.read_complete_beauty_guide(text),public.revoke_complete_beauty_guide(text) to anon,authenticated;
