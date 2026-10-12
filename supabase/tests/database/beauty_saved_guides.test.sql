begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;
insert into auth.users(id,is_anonymous) values
 ('eb100000-0000-4000-8000-000000000001',true),
 ('eb100000-0000-4000-8000-000000000002',true),
 ('eb100000-0000-4000-8000-000000000003',false),
 ('eb100000-0000-4000-8000-000000000004',false),
 ('eb100000-0000-4000-8000-000000000005',true);
insert into public.organizations(id,name) values('eb200000-0000-4000-8000-000000000002','Beauty tenant B');
insert into public.stores(id,org_id,name) values
 ('eb300000-0000-4000-8000-000000000002','eb200000-0000-4000-8000-000000000002','Other tenant'),
 ('eb300000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','Other same-tenant store');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('eb400000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','eb100000-0000-4000-8000-000000000001','Beauty A'),
 ('eb400000-0000-4000-8000-000000000002','eb200000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000002','eb100000-0000-4000-8000-000000000002','Beauty B'),
 ('eb400000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','eb300000-0000-4000-8000-000000000003','eb100000-0000-4000-8000-000000000005','Other store');
insert into public.memberships(id,org_id,user_id,role) values
 ('eb500000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','eb100000-0000-4000-8000-000000000003','owner'),
 ('eb500000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','eb100000-0000-4000-8000-000000000004','manager');
insert into public.membership_stores(org_id,membership_id,store_id) values('11111111-1111-4111-8111-111111111111','eb500000-0000-4000-8000-000000000004','22222222-2222-4222-8222-222222222222');
create temporary table beauty_context(key text primary key,value text);
grant select,insert,update,delete on beauty_context to authenticated,analysis_writer,anon;
insert into beauty_context values
 ('preferences','{"paletteId":"cool_soft","faceShape":"oval","hairLength":"medium","mood":"fresh","finish":"satin"}'),
 ('shade','{"shadeName":"Beauty fixture rose","hueFamily":"rose","undertone":"cool","intensity":"soft","finish":"satin","swatchHex":"#b77d93","reviewed":true}'),
 ('hash',repeat('a1',32));
create function pg_temp.beauty_result(p_patch jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('request_id',(select value from beauty_context where key='request'),'mode','openai_beauty','model_version','gpt-4.1-mini-2025-04-14','prompt_version','beauty-style-suggestion-v1','image_quality','usable','undertone','cool','chroma','soft','face_shape','oval','quality_flags','[]'::jsonb)||p_patch
$$;
create function pg_temp.write_beauty(p_patch jsonb default '{}'::jsonb) returns uuid language sql as $$
 select public.write_openai_beauty_analysis((select value::uuid from beauty_context where key='session'),(select value::uuid from beauty_context where key='request'),'gpt-4.1-mini-2025-04-14',pg_temp.beauty_result(p_patch))
$$;
create function pg_temp.new_beauty_session() returns uuid language plpgsql as $$
declare v_id uuid;
begin
 v_id:=public.start_kiosk_session();
 perform public.record_consent(v_id,'2026-10-openai-v1',true);
 insert into beauty_context(key,value) values('session',v_id::text),('request',extensions.gen_random_uuid()::text) on conflict(key) do update set value=excluded.value;
 return v_id;
end $$;
create function pg_temp.save_guide(p_hash text default null) returns jsonb language sql as $$
 select public.create_kiosk_beauty_guide((select value::uuid from beauty_context where key='session'),coalesce(p_hash,(select value from beauty_context where key='hash')),'2026-10-beauty-save-v1',true)
$$;
create function pg_temp.read_guide() returns jsonb language sql as $$
 select public.read_beauty_saved_guide((select value from beauty_context where key='hash'))
$$;

select is((select count(*)::integer from pg_tables where schemaname='public' and tablename in ('session_beauty_consents','session_beauty_attempts','session_beauty_analyses','session_beauty_quality_flags','session_beauty_preferences','beauty_saved_guides','beauty_saved_guide_products','session_beauty_saved_guides') and rowsecurity),8,'All eight normalized beauty and transfer tables enable RLS');
select ok(has_function_privilege('analysis_writer','public.write_openai_beauty_analysis(uuid,uuid,text,jsonb)','EXECUTE'),'Restricted writer has exact beauty signature');
select ok(not has_function_privilege('authenticated','public.write_openai_beauty_analysis(uuid,uuid,text,jsonb)','EXECUTE'),'Guest cannot forge beauty observations');
select ok(not has_function_privilege('service_role','public.write_openai_beauty_analysis(uuid,uuid,text,jsonb)','EXECUTE'),'Service API cannot forge beauty observations');
select ok(not has_function_privilege('analysis_writer','public.claim_kiosk_beauty_analysis(uuid)','EXECUTE'),'Writer cannot authorize its own photo attempt');
select ok(not has_table_privilege('analysis_writer','public.session_beauty_analyses','SELECT,INSERT,UPDATE,DELETE'),'Writer has no direct beauty-table privilege');
select ok(not has_table_privilege('anon','public.beauty_saved_guides','SELECT'),'Public share reader has no direct saved-table read');
select ok(not has_table_privilege('authenticated','public.beauty_saved_guides','SELECT,INSERT,UPDATE,DELETE'),'Staff and guests have no direct saved-table access');
select ok(has_function_privilege('anon','public.read_beauty_saved_guide(text)','EXECUTE'),'Public capability can read only through bounded RPC');
select ok(not has_function_privilege('anon','public.create_kiosk_beauty_guide(uuid,text,text,boolean)','EXECUTE'),'Anonymous API role cannot manufacture saved results');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name in ('beauty_saved_guides','beauty_saved_guide_products') and column_name in ('session_id','request_id','photo','image','analysis','answers','excluded_ingredients','token')),0,'Saved guide contains no source session, photo, raw analysis, questionnaire or raw token');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
insert into beauty_context select 'variant',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Beauty fixture","name":"Registered beauty lip","category":"lip_color","sku":"BEAUTY-ELIGIBLE","ingredients":["Polyglyceryl-2 Triisostearate","CI 77891","CI 45380"],"skin_types":[],"formulation_complete":true,"price_minor":2400,"stock":3}')::text;
insert into beauty_context select 'excluded',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Beauty fixture","name":"Excluded beauty lip","category":"lip_color","sku":"BEAUTY-EXCLUDED","ingredients":["Aqua","Menthol"],"skin_types":[],"formulation_complete":true,"price_minor":2400,"stock":3}')::text;
insert into beauty_context select 'hidden',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Beauty fixture","name":"Hidden beauty lip","category":"lip_color","sku":"BEAUTY-HIDDEN","ingredients":["Aqua"],"skin_types":[],"formulation_complete":true,"price_minor":2400,"stock":3}')::text;
insert into beauty_context select 'zero',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"brand":"Beauty fixture","name":"Zero stock beauty lip","category":"lip_color","sku":"BEAUTY-ZERO","ingredients":["Aqua"],"skin_types":[],"formulation_complete":true,"price_minor":2400,"stock":0}')::text;
insert into beauty_context select 'otherstore',public.save_catalog_draft('eb300000-0000-4000-8000-000000000003','{"brand":"Beauty fixture","name":"Other store beauty lip","category":"lip_color","sku":"BEAUTY-OTHER-STORE","ingredients":["Aqua"],"skin_types":[],"formulation_complete":true,"price_minor":2400,"stock":3}')::text;
select public.publish_catalog_variant(value::uuid) from beauty_context where key in ('variant','excluded','hidden','zero','otherstore');
select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',value::uuid,(select value::jsonb from beauty_context where key='shade')) from beauty_context where key in ('variant','excluded','hidden','zero');
select public.publish_lip_shade('eb300000-0000-4000-8000-000000000003',(select value::uuid from beauty_context where key='otherstore'),(select value::jsonb from beauty_context where key='shade'));
select public.update_store_listing('22222222-2222-4222-8222-222222222222',value::uuid,2400,case when key='zero' then 0 else 3 end,key<>'hidden') from beauty_context where key in ('variant','excluded','hidden','zero');
select public.update_store_listing('eb300000-0000-4000-8000-000000000003',(select value::uuid from beauty_context where key='otherstore'),2400,3,true);
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
insert into beauty_context select 'session',public.start_kiosk_session()::text;
insert into beauty_context values('request',extensions.gen_random_uuid()::text);
select throws_ok($$select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-beauty-photo-v1',true)$$,'42501',null,'Main consent required before beauty photo consent');
select throws_ok($$select public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))$$,'42501',null,'Main consent required to read beauty session');
select throws_ok($$select public.confirm_kiosk_beauty_preferences((select value::uuid from beauty_context where key='session'),(select value::jsonb from beauty_context where key='preferences'))$$,'42501',null,'Manual beauty preferences still require main consent');
select public.record_consent((select value::uuid from beauty_context where key='session'),'2026-10-openai-v1',true);
select throws_ok($$select pg_temp.save_guide()$$,'22023',null,'Save requires confirmed preferences');
select throws_ok($$select public.record_beauty_exclusions((select value::uuid from beauty_context where key='session'),array['not a canonical ingredient'])$$,'22023',null,'Unknown avoid-list identities fail closed');
select throws_ok($$select public.record_beauty_exclusions((select value::uuid from beauty_context where key='session'),array_fill('Menthol'::text,array[21]))$$,'22023',null,'Avoid list has a database-enforced limit');
select public.record_beauty_exclusions((select value::uuid from beauty_context where key='session'),array['menthol','Menthol']);
select is(public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))->'excludedIngredients','["Menthol"]'::jsonb,'Avoid list is canonical, normalized and deduplicated');
select throws_ok($$select public.confirm_kiosk_beauty_preferences((select value::uuid from beauty_context where key='session'),(select value::jsonb||'{"faceShape":"diagnosis"}' from beauty_context where key='preferences'))$$,'22023',null,'Face shape choices are bounded style preferences');
select throws_ok($$select public.confirm_kiosk_beauty_preferences((select value::uuid from beauty_context where key='session'),(select value::jsonb||'{"notes":"private"}' from beauty_context where key='preferences'))$$,'22023',null,'Arbitrary preference prose cannot persist');
select throws_ok($$select public.confirm_kiosk_beauty_preferences((select value::uuid from beauty_context where key='session'),(select value::jsonb||'{"mood":null}' from beauty_context where key='preferences'))$$,'22023',null,'Null preference value fails closed');
select public.confirm_kiosk_beauty_preferences((select value::uuid from beauty_context where key='session'),(select value::jsonb from beauty_context where key='preferences'));
select is(public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))->'preferences',(select value::jsonb from beauty_context where key='preferences'),'Manual style confirmation works before any skin questionnaire or photo');
select is(public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))->>'attempted','false','Manual style confirmation creates no provider attempt');
select throws_ok($$select public.create_kiosk_beauty_guide((select value::uuid from beauty_context where key='session'),repeat('a1',32),'old',true)$$,'22023',null,'Saved guide requires current save notice');
select throws_ok($$select public.create_kiosk_beauty_guide((select value::uuid from beauty_context where key='session'),repeat('a1',32),'2026-10-beauty-save-v1',false)$$,'22023',null,'Saved guide requires separate explicit opt-in');
select throws_ok($$select pg_temp.save_guide('short')$$,'22023',null,'Only SHA-256 capability hashes may persist');
insert into beauty_context select 'saved',pg_temp.save_guide()::text;
select is(pg_temp.save_guide(),(select value::jsonb from beauty_context where key='saved'),'Same capability retry is idempotent without extending expiration');
select throws_ok($$select pg_temp.save_guide(repeat('b2',32))$$,'22023',null,'An active session cannot issue multiple capability tokens');
select is(jsonb_array_length(pg_temp.read_guide()->'products'),1,'Server-owned guide selection enforces stock, visibility, store and excluded ingredients');
select is(pg_temp.read_guide()->'products'->0->>'variantId',(select value from beauty_context where key='variant'),'Saved product reference is the actual eligible registered variant');
select is(pg_temp.read_guide()->'products'->0->>'available','true','Saved product starts available only with reviewed complete formula/shade');
select is(pg_temp.read_guide()->'preferences',(select value::jsonb from beauty_context where key='preferences'),'Saved guide contains only guest-confirmed style choices');
select is(public.read_beauty_saved_guide(repeat('f9',32)),null::jsonb,'Unknown capability gives no result');
select is(public.read_beauty_saved_guide('malformed'),null::jsonb,'Malformed public capability gives no result');
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select throws_ok($$select public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))$$,'42501',null,'Foreign device cannot read beauty state');
select throws_ok($$select public.record_beauty_exclusions((select value::uuid from beauty_context where key='session'),'{}')$$,'42501',null,'Foreign device cannot edit exclusions');
select throws_ok($$select pg_temp.save_guide()$$,'42501',null,'Foreign device cannot save another guest guide');
select is((select count(*)::integer from public.session_beauty_preferences),0,'Tenant RLS hides personal style choices');
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select throws_ok($$select public.claim_kiosk_beauty_analysis((select value::uuid from beauty_context where key='session'))$$,'42501',null,'Main consent never implies external beauty-photo consent');
select throws_ok($$select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-personal-color-photo-v1',true)$$,'22023',null,'Other purpose notice cannot authorize beauty photo');
select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-beauty-photo-v1',true);
select is(public.claim_kiosk_beauty_analysis((select value::uuid from beauty_context where key='session')),true,'Primary beauty claim requires no skin questionnaire or skin analysis');
select is(public.claim_kiosk_beauty_analysis((select value::uuid from beauty_context where key='session')),false,'Durable beauty claim allows one attempt');
reset role;
select is((select answers_completed_at from public.kiosk_sessions where id=(select value::uuid from beauty_context where key='session')),null::timestamptz,'Beauty did not fabricate skin answers');
set local role analysis_writer;
select throws_ok($$select pg_temp.write_beauty('{"face_shape":"medical"}')$$,'22023',null,'Provider face shape is bounded');
select throws_ok($$select pg_temp.write_beauty('{"face_shape":null}')$$,'22023',null,'Provider face shape must be a string');
select throws_ok($$select pg_temp.write_beauty('{"explanation":"free prose"}')$$,'22023',null,'Provider narrative cannot persist');
select throws_ok($$select pg_temp.write_beauty('{"mode":"openai_color"}')$$,'22023',null,'Color result cannot be substituted for beauty purpose');
select throws_ok($$select pg_temp.write_beauty('{"request_id":"eb000000-0000-4000-8000-000000000000"}')$$,'22023',null,'Writer requires exact echoed opaque request identity');
select throws_ok($$select pg_temp.write_beauty('{"quality_flags":["blur"]}')$$,'22023',null,'Usable beauty analysis cannot carry limitation flags');
select throws_ok($$select pg_temp.write_beauty('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","quality_flags":["blur"]}')$$,'22023',null,'Limited beauty photo must also leave face shape uncertain');
select throws_ok($$select pg_temp.write_beauty('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","face_shape":"uncertain","quality_flags":["no_face"]}')$$,'22023',null,'No face requires not-assessable quality');
select throws_ok($$select pg_temp.write_beauty('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","face_shape":"uncertain","quality_flags":["blur","blur"]}')$$,'22023',null,'Duplicate quality flags are rejected');
insert into beauty_context select 'analysis',pg_temp.write_beauty()::text;
select is(pg_temp.write_beauty('{"face_shape":"round"}')::text,(select value from beauty_context where key='analysis'),'First completed beauty result is immutable');
reset role;
select isnt((select request_id::text from public.session_beauty_analyses where session_id=(select value::uuid from beauty_context where key='session')),(select value from beauty_context where key='session'),'Provider request UUID is separate from session identity');
select throws_ok($$insert into public.session_beauty_quality_flags(org_id,analysis_id,flag) values('eb200000-0000-4000-8000-000000000002',(select value::uuid from beauty_context where key='analysis'),'blur')$$,'23503',null,'Composite FK prevents foreign-tenant quality flags');
select throws_ok($$insert into public.session_beauty_saved_guides(org_id,session_id,guide_id) select 'eb200000-0000-4000-8000-000000000002',(select value::uuid from beauty_context where key='session'),id from public.beauty_saved_guides where token_hash=repeat('a1',32)$$,'23503',null,'Composite FK prevents cross-tenant saved-guide session links');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select is((select count(*)::integer from public.session_beauty_analyses),0,'Staff cannot browse individual beauty observations');
select is((select count(*)::integer from public.session_beauty_preferences),0,'Staff cannot browse confirmed personal style');
select public.update_store_listing('22222222-2222-4222-8222-222222222222',(select value::uuid from beauty_context where key='variant'),2400,0,true);
reset role;
set local role anon;
select is(pg_temp.read_guide()->'products'->0->>'available','false','Public saved guide reflects current stock removal');
select is(jsonb_array_length(pg_temp.read_guide()->'products'),1,'Unavailable saved product is not silently replaced by another catalog product');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.update_store_listing('22222222-2222-4222-8222-222222222222',(select value::uuid from beauty_context where key='variant'),2400,3,true);
select public.publish_lip_shade('22222222-2222-4222-8222-222222222222',(select value::uuid from beauty_context where key='variant'),(select value::jsonb||'{"shadeName":"Revised shade"}' from beauty_context where key='shade'));
select is(pg_temp.read_guide()->'products'->0->>'available','false','Changed shade publication cannot replace original saved metadata');
select is(pg_temp.read_guide()->'products'->0->>'shadeName','Beauty fixture rose','Saved guide retains its reviewed shade version');
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))->'analysis',pg_temp.beauty_result(),'Reload reconstructs exact typed beauty analysis');
select public.confirm_kiosk_beauty_preferences((select value::uuid from beauty_context where key='session'),(select value::jsonb||'{"paletteId":"warm_clear","faceShape":"unsure","hairLength":"long","mood":"soft","finish":"any"}' from beauty_context where key='preferences'));
select is(pg_temp.read_guide()->'preferences',(select value::jsonb from beauty_context where key='preferences'),'Saved confirmed style is immutable after kiosk edits');
select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-beauty-photo-v1',false);
select is(public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))->'analysis','null'::jsonb,'Photo withdrawal clears beauty observations');
select is(public.read_kiosk_beauty_session((select value::uuid from beauty_context where key='session'))->'preferences','null'::jsonb,'Photo withdrawal clears transient confirmed choices');
select ok(pg_temp.read_guide() is not null,'Separately opted-in saved guide remains independent of photo withdrawal');
select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-beauty-photo-v1',true);
select is(public.claim_kiosk_beauty_analysis((select value::uuid from beauty_context where key='session')),false,'Withdrawal permanently invalidates the existing attempt');
reset role;
set local role analysis_writer;
select throws_ok($$select pg_temp.write_beauty()$$,'42501',null,'Late beauty response cannot restore withdrawn observations');
reset role;
set local role authenticated;
select public.finish_kiosk_session((select value::uuid from beauty_context where key='session'));
reset role;
select is((select count(*)::integer from public.session_beauty_attempts where session_id=(select value::uuid from beauty_context where key='session')),0,'Finish purges beauty attempt details');
select is((select count(*)::integer from public.session_beauty_analyses where session_id=(select value::uuid from beauty_context where key='session')),0,'Finish purges beauty observations');
select is((select count(*)::integer from public.session_beauty_saved_guides where session_id=(select value::uuid from beauty_context where key='session')),0,'Finish removes the temporary source link');
set local role anon;
select ok(pg_temp.read_guide() is not null,'Seven-day saved guide survives kiosk finish without session dependency');
select public.revoke_beauty_saved_guide(repeat('f9',32));
select ok(pg_temp.read_guide() is not null,'An unrelated capability cannot revoke this saved result');
select public.revoke_beauty_saved_guide((select value from beauty_context where key='hash'));
select is(pg_temp.read_guide(),null::jsonb,'Capability holder can revoke saved result');
select lives_ok($$select public.revoke_beauty_saved_guide((select value from beauty_context where key='hash'))$$,'Repeated capability revocation is idempotent');
reset role;
select is((select count(*)::integer from public.beauty_saved_guides where token_hash=repeat('a1',32) and revoked_at is not null),1,'Revoked capability remains a tombstone until expiry');
update public.beauty_saved_guides set created_at=now()-interval '8 days',expires_at=now()-interval '1 day' where token_hash=repeat('a1',32);
select private.cleanup_expired_data();
select is((select count(*)::integer from public.beauty_saved_guides where token_hash=repeat('a1',32)),0,'Minute cleanup purges expired saved result');
select is((select count(*)::integer from public.beauty_saved_guide_products),0,'Expired saved product references cascade away');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select pg_temp.new_beauty_session();
select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-beauty-photo-v1',true);
select public.claim_kiosk_beauty_analysis((select value::uuid from beauty_context where key='session'));
reset role;
set local role analysis_writer;
select lives_ok($$select pg_temp.write_beauty('{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","face_shape":"uncertain","quality_flags":["blur","low_light"]}')$$,'Limited primary beauty result persists only uncertain style observations');
reset role;
select is((select count(*)::integer from public.session_beauty_quality_flags where analysis_id in (select id from public.session_beauty_analyses where session_id=(select value::uuid from beauty_context where key='session'))),2,'Quality limitations use normalized typed child rows');
update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=(select value::uuid from beauty_context where key='session');
set local role analysis_writer;
select throws_ok($$select pg_temp.write_beauty()$$,'42501',null,'Expired session cannot accept late beauty output');
reset role;
select private.cleanup_expired_data();
select is((select count(*)::integer from public.session_beauty_quality_flags where org_id='11111111-1111-4111-8111-111111111111'),0,'Session expiry cascades beauty quality flags');
set local role authenticated;
select pg_temp.new_beauty_session();
select public.record_beauty_consent((select value::uuid from beauty_context where key='session'),'2026-10-beauty-photo-v1',true);
select public.claim_kiosk_beauty_analysis((select value::uuid from beauty_context where key='session'));
select set_config('request.jwt.claims','{"sub":"eb100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.revoke_device('eb400000-0000-4000-8000-000000000001');
reset role;
select is((select count(*)::integer from public.session_beauty_attempts where session_id=(select value::uuid from beauty_context where key='session')),0,'Device revocation purges beauty attempt');
set local role analysis_writer;
select throws_ok($$select pg_temp.write_beauty()$$,'42501',null,'Revoked device cannot accept late beauty result');
reset role;
select * from finish();
rollback;
