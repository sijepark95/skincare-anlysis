begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Supabase's postgres role is CREATEROLE, not superuser. PostgreSQL 17 grants
-- a newly created capability's creator ADMIN but not SET. This test-only grant
-- lets the harness exercise that role and rolls back with every fixture below.
grant analysis_writer to postgres with set true;
-- pgTAP helpers live in extensions; runtime writers do not need this access.
grant usage on schema extensions to analysis_writer;

-- Test identities only. No credentials are seeded into a real application.
insert into auth.users(id,email,is_anonymous) values
 ('a1000000-0000-4000-8000-000000000001','owner-a@example.invalid',false),
 ('a1000000-0000-4000-8000-000000000002','manager-a@example.invalid',false),
 ('a1000000-0000-4000-8000-000000000003','viewer-a@example.invalid',false),
 ('a1000000-0000-4000-8000-000000000004',null,true),
 ('a1000000-0000-4000-8000-000000000005',null,true),
 ('a1000000-0000-4000-8000-000000000006',null,true);
insert into public.organizations(id,name) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Tenant B');
insert into public.stores(id,org_id,name) values
 ('22222222-2222-4222-8222-222222222223','11111111-1111-4111-8111-111111111111','Second store'),
 ('b2000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Tenant B store');
insert into public.memberships(id,org_id,user_id,role) values
 ('a2000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','a1000000-0000-4000-8000-000000000001','owner'),
 ('a2000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','a1000000-0000-4000-8000-000000000002','manager'),
 ('a2000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','a1000000-0000-4000-8000-000000000003','viewer');
insert into public.membership_stores values
 ('11111111-1111-4111-8111-111111111111','a2000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222'),
 ('11111111-1111-4111-8111-111111111111','a2000000-0000-4000-8000-000000000003','22222222-2222-4222-8222-222222222222');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('d1000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','a1000000-0000-4000-8000-000000000004','Fixture A'),
 ('d1000000-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000005','Fixture B');
create temporary table test_context(key text primary key,value text);
grant select,insert,update on test_context to authenticated,analysis_writer;

select is((select count(*)::integer from pg_tables where schemaname='public' and not rowsecurity),0,'Every application table enables RLS');
select ok(not has_function_privilege('authenticated','public.write_analysis_result(uuid,uuid,text,text,text,jsonb)','EXECUTE'),'Client cannot call trusted analysis writer');
select ok(not has_function_privilege('anon','public.start_kiosk_session()','EXECUTE'),'Unauthenticated client cannot start a session');
select ok(not has_table_privilege('analysis_writer','public.products','SELECT'),'Writer cannot browse the tenant catalog');
select ok(not has_function_privilege('authenticated','private.cleanup_expired_data()','EXECUTE'),'Clients cannot invoke maintenance');
select ok(has_function_privilege('supabase_auth_admin','public.senmiva_before_user_created(jsonb)','EXECUTE'),'Auth service can invoke before-user-created hook');
select ok(not has_function_privilege('anon','public.senmiva_before_user_created(jsonb)','EXECUTE'),'Unauthenticated clients cannot invoke Auth hook');
select ok(not has_function_privilege('authenticated','public.senmiva_before_user_created(jsonb)','EXECUTE'),'Authenticated clients cannot invoke Auth hook');
select ok(not has_function_privilege('service_role','public.senmiva_before_user_created(jsonb)','EXECUTE'),'Service API role cannot invoke Auth hook directly');
select ok(not (select prosecdef from pg_proc where oid='public.senmiva_before_user_created(jsonb)'::regprocedure),'Auth hook executes without owner privilege escalation');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":true}}'), '{}'::jsonb,'Auth hook allows a server-declared anonymous device');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":false}}')->'error'->>'http_code','403','Auth hook requires a server-declared email provider for business signup');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":"true"}}')->'error'->>'http_code','403','Auth hook rejects a string pretending to be true');
select is(public.senmiva_before_user_created('{"user":{"user_metadata":{"is_anonymous":true}}}')->'error'->>'http_code','403','User metadata cannot spoof anonymous signup');
select is(public.senmiva_before_user_created('{}')->'error'->>'http_code','403','Auth hook fails closed for missing anonymous claim');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":null}}')->'error'->>'http_code','403','Auth hook fails closed for JSON null');
select is(public.senmiva_before_user_created(null)->'error'->>'http_code','403','Auth hook fails closed for SQL null');
select throws_ok($$insert into public.store_listings values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b2000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333331',100,'USD',1,true)$$,'23503',null,'Composite tenant FK blocks cross-organization product listing');
select throws_ok($$update public.formulation_versions set complete=false where org_id='11111111-1111-4111-8111-111111111111'$$,'23514',null,'Published formulation cannot be edited');
select throws_ok($$delete from public.formulation_ingredients where org_id='11111111-1111-4111-8111-111111111111'$$,'23514',null,'Published INCI list cannot be edited');
select throws_ok($$update public.recommendation_policy_versions set version=2 where org_id='11111111-1111-4111-8111-111111111111'$$,'23514',null,'Published recommendation policy cannot be edited');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select is((select count(*)::integer from public.organizations),1,'Owner reads only own organization');
select is((select count(*)::integer from public.stores),2,'Owner reads all own organization stores');
select is(public.staff_context()->>'role','owner','Staff context resolves verified membership');
select throws_ok($$select public.read_store_catalog('b2000000-0000-4000-8000-000000000001')$$,'42501',null,'Owner cannot read another tenant through RPC');
select throws_ok($$select public.device_context()$$,'42501',null,'Staff identity cannot become a kiosk device');
insert into test_context select 'pair_code',public.create_pairing_code('22222222-2222-4222-8222-222222222222','Paired fixture')->>'pairing_code';
select is(length((select value from test_context where key='pair_code')),16,'Pairing uses a short-lived random 64-bit code');
select throws_ok($$insert into public.devices(org_id,store_id,auth_user_id,label) values('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','a1000000-0000-4000-8000-000000000006','Bypass')$$,'42501',null,'Owner cannot bypass pairing with a direct table write');

select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","is_anonymous":false}',true);
select is(jsonb_array_length(public.staff_context()->'stores'),1,'Manager context contains assigned store only');
select lives_ok($$select public.update_store_listing('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333331',2200,10,true)$$,'Manager updates assigned-store listing');
select throws_ok($$select public.update_store_listing('22222222-2222-4222-8222-222222222223','33333333-3333-4333-8333-333333333331',2200,10,true)$$,'42501',null,'Manager cannot update an unassigned store');
select throws_ok($$select public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{}')$$,'42501',null,'Manager cannot edit organization-wide catalog');

select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select lives_ok($$select * from public.read_store_metrics('22222222-2222-4222-8222-222222222222')$$,'Viewer may read aggregate reports');
select throws_ok($$select public.read_store_catalog('22222222-2222-4222-8222-222222222222')$$,'42501',null,'Viewer cannot browse individual product management');

select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000006","is_anonymous":true}',true);
select throws_ok($$select public.start_kiosk_session()$$,'42501',null,'Unpaired anonymous identity cannot start a session');
select lives_ok($$select public.pair_device((select value from test_context where key='pair_code'))$$,'Anonymous device consumes pairing code');
select throws_ok($$select public.pair_device((select value from test_context where key='pair_code'))$$,'22023',null,'Pairing code cannot be reused');
select is(public.device_context()->>'store_id','22222222-2222-4222-8222-222222222222','Paired device is bound to issuing store');
select throws_ok($$select public.staff_context()$$,'42501',null,'Device identity cannot become staff');

select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000004","is_anonymous":true}',true);
insert into test_context select 'session',public.start_kiosk_session()::text;
select is(public.start_kiosk_session()::text,(select value from test_context where key='session'),'Session start is idempotent while device has an active session');
select throws_ok($$select public.save_answers((select value::uuid from test_context where key='session'),'dry',array['dehydration'])$$,'42501',null,'Questionnaire cannot be saved before consent');
select lives_ok($$select public.record_consent((select value::uuid from test_context where key='session'),'2026-10-mvp',true)$$,'Explicit current-policy consent is recorded');
select throws_ok($$select public.record_consent((select value::uuid from test_context where key='session'),'2026-10-mvp',false)$$,'22023',null,'Recorded consent cannot silently change');
select lives_ok($$select public.save_answers((select value::uuid from test_context where key='session'),'dry',array['dehydration'],'{}',true)$$,'Normalized questionnaire answers are saved');
select ok(public.read_kiosk_session((select value::uuid from test_context where key='session'))->'recommendations'='null'::jsonb,'No run is distinct from an empty recommendation result');
select throws_ok($$select public.write_analysis_result((select value::uuid from test_context where key='session'),'ee000000-0000-4000-8000-000000000001','mock','mock-v1','demo','[]')$$,'42501',null,'Device cannot forge trusted analysis');

select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000005","is_anonymous":true}',true);
select is((select count(*)::integer from public.kiosk_sessions),0,'Another tenant device cannot read session rows');
select throws_ok($$select public.read_kiosk_session((select value::uuid from test_context where key='session'))$$,'42501',null,'Another tenant device cannot read session through RPC');

reset role;
set local role analysis_writer;
insert into test_context select 'analysis',public.write_analysis_result((select value::uuid from test_context where key='session'),'ee000000-0000-4000-8000-000000000001','mock','mock-v1','demo','[{"concern_id":"dehydration","level":"moderate","score":0.5}]')::text;
select is(public.write_analysis_result((select value::uuid from test_context where key='session'),'ee000000-0000-4000-8000-000000000001','mock','mock-v1','demo','[]')::text,(select value from test_context where key='analysis'),'Trusted analysis request is idempotent');
select throws_ok($$update public.kiosk_sessions set skin_sensitive=false$$,'42501',null,'Writer role cannot mutate arbitrary session fields');
select throws_ok($$select public.write_analysis_result((select value::uuid from test_context where key='session'),'ee000000-0000-4000-8000-000000000002','model','unapproved-v1','demo','[]')$$,'22023',null,'Real model mode remains disabled');
select lives_ok($$select public.persist_recommendations((select value::uuid from test_context where key='session'),(select value::uuid from test_context where key='analysis'),'a2786824-b258-5924-82b6-2d71465eb668','[{"variant_id":"33333333-3333-4333-8333-333333333332","score":3,"matched_ingredients":["Glycerin"],"reasons":[{"concern":"dehydration","ingredient":"Glycerin","relevance":3}]}]')$$,'Trusted writer persists eligible store product and validated ingredient reason');
reset role;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000004","is_anonymous":true}',true);
select is(public.read_kiosk_session((select value::uuid from test_context where key='session'))->'analysis'->>'quality_status','demo','Session read preserves explicit mock quality');
select is(public.read_kiosk_session((select value::uuid from test_context where key='session'))->'analysis'->>'disclaimer','Demo results generated from your questionnaire, not from a photo or AI skin measurement. For cosmetic guidance only; not a medical diagnosis.','Result disclaimer excludes photo and AI skin measurement');
select is(jsonb_array_length(public.read_kiosk_session((select value::uuid from test_context where key='session'))->'recommendations'),1,'Device reads its own persisted recommendation');
select lives_ok($$select public.finish_kiosk_session((select value::uuid from test_context where key='session'))$$,'Finish succeeds');
select lives_ok($$select public.finish_kiosk_session((select value::uuid from test_context where key='session'))$$,'Finish retry is idempotent');
select throws_ok($$select public.read_kiosk_session((select value::uuid from test_context where key='session'))$$,'42501',null,'Finished session cannot be read');
insert into test_context select 'cancelled_session',public.start_kiosk_session()::text;
select lives_ok($$select public.record_consent((select value::uuid from test_context where key='cancelled_session'),'2026-10-mvp',true)$$,'Consent is recorded before cancellation');
select lives_ok($$select public.save_answers((select value::uuid from test_context where key='cancelled_session'),'dry',array['dehydration'])$$,'Preferences are recorded before cancellation');
select lives_ok($$select public.finish_kiosk_session((select value::uuid from test_context where key='cancelled_session'))$$,'Cancellation finishes an unanalyzed session');
reset role;
select is((select sessions_completed from public.store_daily_metrics where store_id='22222222-2222-4222-8222-222222222222'),1,'Only the analyzed consultation counts as completed');
select is((select count(*)::integer from public.analyses where session_id=(select value::uuid from test_context where key='session')),0,'Finish deletes analysis and cascading recommendation detail');
select is((select count(*)::integer from public.session_concerns where session_id=(select value::uuid from test_context where key='session')),0,'Finish deletes questionnaire concerns');
select ok((select skin_type_id is null and skin_sensitive is null from public.kiosk_sessions where id=(select value::uuid from test_context where key='session')),'Finish clears sensitive scalar answers');
select is((select count(*)::integer from public.consents where session_id=(select value::uuid from test_context where key='session')),1,'Minimal consent proof remains during retention window');
select is((select sessions_analyzed from public.store_daily_metrics where store_id='22222222-2222-4222-8222-222222222222'),1,'Analysis retries do not inflate aggregate count');

-- Failed batch must roll back earlier valid rows, not partially import them.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select throws_ok($$select public.import_catalog_drafts('22222222-2222-4222-8222-222222222222','[{"sku":"ROLLBACK-VALID","brand":"TEST","name":"Valid draft","category":"serum","price_minor":100,"stock":1,"ingredients":["Aqua"],"skin_types":["dry"],"formulation_complete":true},{"sku":"ROLLBACK-BAD","brand":"TEST","name":"Invalid skin type","category":"serum","price_minor":100,"stock":1,"ingredients":["Aqua"],"skin_types":["unsupported"],"formulation_complete":true}]')$$,'22023',null,'Invalid batch raises one error');
select is((select count(*)::integer from public.product_variants where sku like 'ROLLBACK-%'),0,'Failed batch is atomic');
insert into test_context select 'unresolved_variant',public.save_catalog_draft('22222222-2222-4222-8222-222222222222','{"sku":"UNRESOLVED-DRAFT","brand":"TEST","name":"Needs review","category":"serum","price_minor":100,"stock":1,"ingredients":["Aqua","UNKNOWN-INCI"],"skin_types":["dry"],"formulation_complete":true}')::text;
select is((select cardinality(unresolved_ingredients) from public.read_store_catalog('22222222-2222-4222-8222-222222222222') where sku='UNRESOLVED-DRAFT'),1,'Unknown INCI remains visible in draft review');
select ok(not (select formulation_complete from public.read_store_catalog('22222222-2222-4222-8222-222222222222') where sku='UNRESOLVED-DRAFT'),'Unknown INCI prevents effective completeness');
select throws_ok($$select public.publish_catalog_variant((select value::uuid from test_context where key='unresolved_variant'))$$,'22023',null,'Unknown INCI cannot be published');
select lives_ok($$select public.revoke_device('d1000000-0000-4000-8000-000000000001')$$,'Owner revokes paired device');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000004","is_anonymous":true}',true);
select throws_ok($$select public.device_context()$$,'42501',null,'Revoked device loses permission immediately');
reset role;

select * from finish();
rollback;
