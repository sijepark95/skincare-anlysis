begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;
insert into auth.users(id,is_anonymous) values
 ('ea100000-0000-4000-8000-000000000001',true),
 ('ea100000-0000-4000-8000-000000000002',true),
 ('ea100000-0000-4000-8000-000000000003',false),
 ('ea100000-0000-4000-8000-000000000004',false),
 ('ea100000-0000-4000-8000-000000000005',true);
insert into public.organizations(id,name) values('ea200000-0000-4000-8000-000000000002','Color tenant B');
insert into public.stores(id,org_id,name) values
 ('ea300000-0000-4000-8000-000000000002','ea200000-0000-4000-8000-000000000002','Other tenant'),
 ('ea300000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','Other same-tenant store');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('ea400000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ea100000-0000-4000-8000-000000000001','Color A'),
 ('ea400000-0000-4000-8000-000000000002','ea200000-0000-4000-8000-000000000002','ea300000-0000-4000-8000-000000000002','ea100000-0000-4000-8000-000000000002','Color B'),
 ('ea400000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','ea300000-0000-4000-8000-000000000003','ea100000-0000-4000-8000-000000000005','Other store');
insert into public.memberships(id,org_id,user_id,role) values
 ('ea500000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','ea100000-0000-4000-8000-000000000003','owner'),
 ('ea500000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','ea100000-0000-4000-8000-000000000004','manager');
insert into public.membership_stores(org_id,membership_id,store_id) values('11111111-1111-4111-8111-111111111111','ea500000-0000-4000-8000-000000000004','22222222-2222-4222-8222-222222222222');
create temporary table color_context(key text primary key,value text);
grant select,insert,update,delete on color_context to authenticated,analysis_writer;
insert into color_context values('shade','{"shadeName":"Soft Rose","hueFamily":"rose","undertone":"cool","intensity":"soft","finish":"satin","swatchHex":"#b77d93","reviewed":true}');
create function pg_temp.color_result(p_patch jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('request_id',(select value from color_context where key='request'),'mode','openai_color','model_version','gpt-4.1-mini-2025-04-14','prompt_version','personal-color-suggestion-v1','image_quality','usable','undertone','cool','chroma','soft','quality_flags','[]'::jsonb)||p_patch
$$;
create function pg_temp.write_color(p_patch jsonb default '{}'::jsonb) returns uuid language sql as $$
 select public.write_openai_color_analysis((select value::uuid from color_context where key='session'),(select value::uuid from color_context where key='request'),'gpt-4.1-mini-2025-04-14',pg_temp.color_result(p_patch))
$$;
create function pg_temp.new_color_session() returns uuid language plpgsql as $$
declare v_id uuid;
begin
 v_id:=public.start_kiosk_session();
 perform public.record_consent(v_id,'2026-10-openai-v1',true);
 perform public.save_answers(v_id,'dry',array['dehydration'],'{}',false);
 insert into color_context(key,value) values('session',v_id::text) on conflict(key) do update set value=excluded.value;
 insert into color_context(key,value) values('request',extensions.gen_random_uuid()::text) on conflict(key) do update set value=excluded.value;
 return v_id;
end $$;

select is((select count(*)::integer from pg_tables where schemaname='public' and tablename in ('variant_shade_versions','variant_shades','session_color_consents','session_color_attempts','session_color_analyses','session_color_quality_flags','session_color_preferences') and rowsecurity),7,'All seven normalized color tables enable RLS');
select ok(not has_function_privilege('authenticated','public.write_openai_color_analysis(uuid,uuid,text,jsonb)','EXECUTE'),'Guest cannot forge color output');
select ok(not has_function_privilege('service_role','public.write_openai_color_analysis(uuid,uuid,text,jsonb)','EXECUTE'),'Service API cannot write color observations');
select ok(has_function_privilege('analysis_writer','public.write_openai_color_analysis(uuid,uuid,text,jsonb)','EXECUTE'),'Dedicated writer has exact color output signature');
select ok(not has_function_privilege('analysis_writer','public.claim_kiosk_color_analysis(uuid)','EXECUTE'),'Writer cannot authorize its own color transmission');
select ok(not has_table_privilege('analysis_writer','public.session_color_analyses','SELECT,INSERT,UPDATE,DELETE'),'Writer has no direct color-table privilege');
select ok(not has_table_privilege('authenticated','public.variant_shade_versions','INSERT,UPDATE,DELETE'),'Staff cannot bypass reviewed shade RPC');
select ok(not has_function_privilege('analysis_writer','private.can_read_lip_shade(uuid,uuid,uuid)','EXECUTE'),'Writer cannot use the guest shade read helper');
select is((select count(*)::integer from public.ingredients where inci_name in ('Polyglyceryl-2 Triisostearate','Candelilla Cera','CI 45380','CI 15850','CI 73360','CI 77491','CI 77492','CI 77499','CI 45410','CI 42090','CI 15985','CI 19140','CI 45370')),13,'Bounded lip formulation identities are available');
select is((select i.inci_name from public.ingredient_aliases a join public.ingredients i on i.id=a.ingredient_id where a.alias='CI 77891'),'Titanium Dioxide','Color-index alias reuses existing titanium dioxide identity');
select is((select i.inci_name from public.ingredient_aliases a join public.ingredients i on i.id=a.ingredient_id where a.alias='Candelilla Cera (Euphorbia Cerifera (Candelilla) Wax)'),'Candelilla Cera','Official combined wax label resolves to one canonical identity');
select is((select count(*)::integer from public.concern_ingredient_rules r join public.ingredients i on i.id=r.ingredient_id where i.inci_name like 'CI %'),0,'Pigment registry identities do not create skincare efficacy rules');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
insert into color_context select 'variant',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Color fixture","name":"Registered lip color","category":"lip_color","sku":"COLOR-FIXTURE-1","ingredients":["Polyglyceryl-2 Triisostearate","Candelilla Cera (Euphorbia Cerifera (Candelilla) Wax)","CI 77891","CI 45380"],"skin_types":[],"formulation_complete":true,"price_minor":2000,"stock":3}')::text;
insert into color_context select 'unknown',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Color fixture","name":"Unknown lip formula","category":"lip_color","sku":"COLOR-FIXTURE-UNKNOWN","ingredients":["Unverified Lip Ingredient"],"skin_types":[],"formulation_complete":true,"price_minor":2000,"stock":3}')::text;
select throws_ok($$select public.publish_catalog_variant((select value::uuid from color_context where key='unknown'))$$,'22023',null,'Unknown lip ingredient still blocks complete formula publication');
insert into color_context select 'draft',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Color fixture","name":"Unreviewed lip color","category":"lip_color","sku":"COLOR-FIXTURE-DRAFT","ingredients":["Aqua","Glycerin"],"skin_types":[],"formulation_complete":false,"price_minor":2000,"stock":3}')::text;
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='draft'),(select value::jsonb from color_context where key='shade'))$$,'22023',null,'Shade cannot publish over incomplete draft formulation');
select public.publish_catalog_variant((select value::uuid from color_context where key='variant'));
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333332',(select value::jsonb from color_context where key='shade'))$$,'22023',null,'Skincare product cannot acquire lip shade metadata');
select throws_ok($$select public.publish_lip_shade('ea300000-0000-4000-8000-000000000002',(select value::uuid from color_context where key='variant'),(select value::jsonb from color_context where key='shade'))$$,'42501',null,'Owner cannot publish across tenant boundary');
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb||'{"reviewed":false}' from color_context where key='shade'))$$,'22023',null,'Shade review is an explicit true boolean');
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb||'{"hueFamily":"invented"}' from color_context where key='shade'))$$,'22023',null,'Unbounded hue metadata is rejected');
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb||'{"sourcePhoto":"private"}' from color_context where key='shade'))$$,'22023',null,'Extra shade fields cannot become persisted blobs');
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb||'{"shadeName":42}' from color_context where key='shade'))$$,'22023',null,'Shade labels must be bounded strings');
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb||'{"swatchHex":"url(javascript:bad)"}' from color_context where key='shade'))$$,'22023',null,'Swatches accept reviewed hex only');
insert into color_context select 'shade-v1',public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb from color_context where key='shade'))::text;
select is(public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')->0->>'swatchHex','#B77D93','Merchant display swatch is normalized uppercase');
insert into color_context select 'shade-v2',public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb||'{"shadeName":"Reviewed Rose"}' from color_context where key='shade'))::text;
select is(public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')->0->>'version','2','Publication moves current pointer to a new shade snapshot');
select is(public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')->0->>'versionId',(select value from color_context where key='shade-v2'),'Wire DTO uses exact current version identity');
select is((select count(*)::integer from public.variant_shade_versions where variant_id=(select value::uuid from color_context where key='variant')),2,'Authorized staff retains reviewed historical shade visibility');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000004","is_anonymous":false}',true);
select throws_ok($$select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),(select value::jsonb from color_context where key='shade'))$$,'42501',null,'Store manager cannot change shared shade metadata');
reset role;
select is((select count(*)::integer from public.variant_shade_versions where variant_id=(select value::uuid from color_context where key='variant')),2,'Prior published shade versions remain preserved');
select throws_ok($$update public.variant_shade_versions set shade_name='Rewrite' where id=(select value::uuid from color_context where key='shade-v1')$$,'23514',null,'Published shade fields cannot be edited');
select throws_ok($$delete from public.variant_shade_versions where id=(select value::uuid from color_context where key='shade-v1')$$,'23514',null,'Published historical shade cannot be deleted');
select throws_ok($$insert into public.variant_shades(org_id,variant_id,shade_version_id) values('11111111-1111-4111-8111-111111111111',(select value::uuid from color_context where key='draft'),(select value::uuid from color_context where key='shade-v1'))$$,'23503',null,'Shade pointer cannot cross variant ownership');
select throws_ok($$insert into public.variant_shade_versions(org_id,variant_id,version,shade_name,hue_family,undertone,intensity,finish,swatch_hex) values('ea200000-0000-4000-8000-000000000002',(select value::uuid from color_context where key='variant'),1,'Foreign','rose','cool','soft','satin','#FFFFFF')$$,'23503',null,'Composite FK rejects cross-tenant shade');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(jsonb_array_length(public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')),0,'Guest cannot see hidden store shade');
select is((select count(*)::integer from public.variant_shade_versions),0,'Direct guest RLS also hides unavailable shade versions');
select is((select count(*)::integer from public.variant_shades),0,'Direct guest RLS also hides unavailable current pointers');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.update_store_listing('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),2000,3,true);
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(jsonb_array_length(public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')),1,'Guest reads only actual published visible stocked lip shade');
select is((select count(*)::integer from public.variant_shade_versions),1,'Direct guest RLS exposes only the current eligible version, never history');
select is((select id::text from public.variant_shade_versions),(select value from color_context where key='shade-v2'),'Direct shade read and RPC select the same reviewed version');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.update_store_listing('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),2000,0,true);
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is((select count(*)::integer from public.variant_shade_versions),0,'Zero-stock shade cannot leak through direct version reads');
select is((select count(*)::integer from public.variant_shades),0,'Zero-stock shade cannot leak through direct pointer reads');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.update_store_listing('22222222-2222-4222-8222-222222222222',(select value::uuid from color_context where key='variant'),2000,3,true);
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000005","is_anonymous":true}',true);
select throws_ok($$select public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')$$,'42501',null,'Same-tenant device cannot read another store shade catalog');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select throws_ok($$select public.read_store_lip_shades('22222222-2222-4222-8222-222222222222')$$,'42501',null,'Foreign-tenant device cannot read shade catalog');
select is((select count(*)::integer from public.variant_shade_versions),0,'Foreign tenant RLS hides shade metadata');

select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
insert into color_context select 'session',public.start_kiosk_session()::text;
insert into color_context values('request',extensions.gen_random_uuid()::text);
select throws_ok($$select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',true)$$,'42501',null,'Main consent required before color consent');
select public.record_consent((select value::uuid from color_context where key='session'),'2026-10-openai-v1',true);
select throws_ok($$select public.record_color_consent((select value::uuid from color_context where key='session'),'old',true)$$,'22023',null,'Stale color notice fails closed');
select throws_ok($$select public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session'))$$,'42501',null,'Skin main consent never implies color photo consent');
select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',false);
select throws_ok($$select public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session'))$$,'42501',null,'Declined color photo choice cannot claim');
select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',true);
select throws_ok($$select public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session'))$$,'22023',null,'Color claim requires completed questionnaire');
select public.save_answers((select value::uuid from color_context where key='session'),'dry',array['dehydration'],'{}',false);
reset role;
set local role analysis_writer;
select throws_ok($$select pg_temp.write_color()$$,'42501',null,'Writer cannot complete an unclaimed photo request');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select throws_ok($$select public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session'))$$,'42501',null,'Foreign guest cannot claim another session color request');
select throws_ok($$select public.read_kiosk_color_session((select value::uuid from color_context where key='session'))$$,'42501',null,'Foreign guest cannot read color session');
select is((select count(*)::integer from public.session_color_consents),0,'Foreign tenant cannot read color consent rows');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session')),true,'First color claim authorizes one purpose-specific attempt');
select is(public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session')),false,'Color claim is durable across retries');
reset role;
set local role analysis_writer;
select throws_ok($$select public.write_openai_color_analysis((select value::uuid from color_context where key='session'),null,'gpt-4.1-mini-2025-04-14',pg_temp.color_result())$$,'22023',null,'Restricted color writer rejects missing opaque request identity');
select throws_ok($$select pg_temp.write_color('{"explanation":"unbounded"}')$$,'22023',null,'Provider prose is excluded from color storage');
select throws_ok($$select pg_temp.write_color('{"undertone":null}')$$,'22023',null,'Null category cannot enter color storage');
select throws_ok($$select pg_temp.write_color('{"undertone":"deep winter"}')$$,'22023',null,'Free-text seasonal classification is rejected');
select throws_ok($$select pg_temp.write_color('{"mode":"openai"}')$$,'22023',null,'Skin and color result purposes cannot be confused');
select throws_ok($$select pg_temp.write_color('{"prompt_version":"unreviewed"}')$$,'22023',null,'Prompt version remains pinned');
select throws_ok($$select pg_temp.write_color('{"quality_flags":["blur"]}')$$,'22023',null,'Usable color quality cannot carry limitations');
select throws_ok($$select pg_temp.write_color('{"image_quality":"limited","quality_flags":["low_light"]}')$$,'22023',null,'Limited image cannot assert confident undertone or chroma');
select throws_ok($$select pg_temp.write_color('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","quality_flags":[]}')$$,'22023',null,'Limited quality requires a specific limitation');
select throws_ok($$select pg_temp.write_color('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","quality_flags":["no_face"]}')$$,'22023',null,'No face requires unassessable quality');
select throws_ok($$select pg_temp.write_color('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","quality_flags":["blur","blur"]}')$$,'22023',null,'Duplicate flags are rejected before normalization');
select throws_ok($$select pg_temp.write_color('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","quality_flags":["identity"]}')$$,'22023',null,'Only reviewed color image flags are accepted');
insert into color_context select 'analysis',pg_temp.write_color()::text;
select is(pg_temp.write_color('{"undertone":"warm"}')::text,(select value from color_context where key='analysis'),'First completed result is immutable and reload-idempotent');
reset role;
select is((select count(*)::integer from public.session_color_analyses where session_id=(select value::uuid from color_context where key='session')),1,'Color analysis has one normalized header per session');
select is((select undertone from public.session_color_analyses where session_id=(select value::uuid from color_context where key='session')),'cool','Later valid response cannot rewrite saved undertone');
select isnt((select request_id::text from public.session_color_analyses where session_id=(select value::uuid from color_context where key='session')),(select value from color_context where key='session'),'Color provider request identity is opaque and separate from session identity');
select throws_ok($$insert into public.session_color_quality_flags(org_id,analysis_id,flag) values('ea200000-0000-4000-8000-000000000002',(select value::uuid from color_context where key='analysis'),'blur')$$,'23503',null,'Composite FK rejects cross-tenant color flags');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select is((select count(*)::integer from public.session_color_analyses),0,'Staff cannot browse guest color observations');
select is((select count(*)::integer from public.session_color_attempts),0,'Staff cannot browse guest color attempts');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'analysis',pg_temp.color_result(),'Reload reconstructs exact typed color analysis without a stored JSON blob');
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'preferences','null'::jsonb,'AI suggestion never automatically confirms guest palette');
select throws_ok($$select public.confirm_kiosk_color_preferences((select value::uuid from color_context where key='session'),'winter','matte')$$,'22023',null,'Only bounded palette IDs can be confirmed');
select public.confirm_kiosk_color_preferences((select value::uuid from color_context where key='session'),'warm_clear','gloss');
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'preferences','{"paletteId":"warm_clear","finish":"gloss"}'::jsonb,'Guest confirmation may differ from AI suggestion');
select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',false);
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'analysis','null'::jsonb,'Withdrawal immediately removes saved color observations');
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'preferences','null'::jsonb,'Withdrawal clears palette preferences');
select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',true);
select is(public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session')),false,'Reaccepting consent cannot retry an invalidated attempt');
reset role;
set local role analysis_writer;
select throws_ok($$select pg_temp.write_color()$$,'42501',null,'Reacceptance cannot resurrect a withdrawn in-flight response');
reset role;
set local role authenticated;
select public.finish_kiosk_session((select value::uuid from color_context where key='session'));
reset role;
select is((select count(*)::integer from public.session_color_attempts where session_id=(select value::uuid from color_context where key='session')),0,'Finish removes durable color attempt details');
select is((select count(*)::integer from public.session_color_consents where session_id=(select value::uuid from color_context where key='session')),0,'Finish removes color consent details');
set local role analysis_writer;
select throws_ok($$select pg_temp.write_color()$$,'42501',null,'Late result cannot restore finished color data');
reset role;
set local role authenticated;
select pg_temp.new_color_session();
select public.confirm_kiosk_color_preferences((select value::uuid from color_context where key='session'),'neutral_soft','any');
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'attempted','false'::jsonb,'Manual palette confirmation requires no external attempt');
select is(public.read_kiosk_color_session((select value::uuid from color_context where key='session'))->'consent','false'::jsonb,'Manual palette confirmation never implies external consent');
select pg_temp.new_color_session();
select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',true);
select public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session'));
reset role;
set local role analysis_writer;
select lives_ok($$select pg_temp.write_color('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","quality_flags":["low_light","blur"]}')$$,'Limited color result stores uncertainty and separate flag rows');
reset role;
select is((select count(*)::integer from public.session_color_quality_flags f join public.session_color_analyses a on a.org_id=f.org_id and a.id=f.analysis_id where a.session_id=(select value::uuid from color_context where key='session')),2,'Limitations are normalized unique flag rows');
update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=(select value::uuid from color_context where key='session');
set local role analysis_writer;
select throws_ok($$select pg_temp.write_color()$$,'42501',null,'Expired session rejects late color responses');
reset role;
select private.cleanup_expired_data();
select is((select count(*)::integer from public.session_color_analyses where session_id=(select value::uuid from color_context where key='session')),0,'Scheduled expiry purges color analysis');
select is((select count(*)::integer from public.session_color_quality_flags),0,'Scheduled expiry cascades color flags');
set local role authenticated;
select pg_temp.new_color_session();
select public.record_color_consent((select value::uuid from color_context where key='session'),'2026-10-personal-color-photo-v1',true);
select public.claim_kiosk_color_analysis((select value::uuid from color_context where key='session'));
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.revoke_device('ea400000-0000-4000-8000-000000000001');
reset role;
select is((select count(*)::integer from public.session_color_attempts where session_id=(select value::uuid from color_context where key='session')),0,'Revoking a device purges color claims');
set local role analysis_writer;
select throws_ok($$select pg_temp.write_color()$$,'42501',null,'Revoked device cannot receive a late result');
reset role;
select * from finish();
rollback;
