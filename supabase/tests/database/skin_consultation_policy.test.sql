begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;
insert into auth.users(id,is_anonymous) values
 ('ec100000-0000-4000-8000-000000000001',true),
 ('ec100000-0000-4000-8000-000000000002',true),
 ('ec100000-0000-4000-8000-000000000003',true),
 ('ec100000-0000-4000-8000-000000000004',false);
insert into public.organizations(id,name) values('ec200000-0000-4000-8000-000000000002','Consultation tenant B');
insert into public.stores(id,org_id,name) values
 ('ec300000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002','Other tenant'),
 ('ec300000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','Same tenant second store');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('ec400000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ec100000-0000-4000-8000-000000000001','A'),
 ('ec400000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002','ec300000-0000-4000-8000-000000000002','ec100000-0000-4000-8000-000000000002','B'),
 ('ec400000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','ec300000-0000-4000-8000-000000000003','ec100000-0000-4000-8000-000000000003','A second store');
insert into public.memberships(org_id,user_id,role) values('11111111-1111-4111-8111-111111111111','ec100000-0000-4000-8000-000000000004','owner');
create temporary table consultation_policy_context(key text primary key,value text);
grant select,insert,update on consultation_policy_context to authenticated,analysis_writer;
select ok(not has_function_privilege('anon','public.read_kiosk_recommendation_policy(uuid)','EXECUTE'),'Unauthenticated callers cannot read a consultation policy');
select ok(not has_function_privilege('analysis_writer','public.read_kiosk_recommendation_policy(uuid)','EXECUTE'),'Writer receives no additional policy access');
select ok(not has_function_privilege('service_role','public.read_kiosk_recommendation_policy(uuid)','EXECUTE'),'Service API has no guest policy bypass');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
insert into consultation_policy_context select 'session',public.start_kiosk_session()::text;
insert into consultation_policy_context select 'original_policy',public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))->>'id';
select is(public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))->>'version','1','An unranked own session receives the current published policy');
select is(public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))->>'source','operator-configured','Policy source is explicit');
select public.record_consent((select value::uuid from consultation_policy_context where key='session'),'2026-10-mvp',true);
select public.save_answers((select value::uuid from consultation_policy_context where key='session'),'dry',array['dehydration'],'{}',false);
reset role;
set local role analysis_writer;
insert into consultation_policy_context select 'analysis',public.write_analysis_result((select value::uuid from consultation_policy_context where key='session'),(select value::uuid from consultation_policy_context where key='session'),'mock','mock-1.0','demo','[]')::text;
select lives_ok($$select public.persist_recommendations((select value::uuid from consultation_policy_context where key='session'),(select value::uuid from consultation_policy_context where key='analysis'),(select value::uuid from consultation_policy_context where key='original_policy'),'[]')$$,'Even an empty recommendation run owns its original policy');
reset role;
insert into public.recommendation_policy_versions(id,org_id,version,source) values('ec500000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111',2,'mock-onboarding-v1');
insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance)
 select '11111111-1111-4111-8111-111111111111','ec500000-0000-4000-8000-000000000002',c.id,i.id,1 from public.concerns c cross join public.ingredients i where c.slug='dehydration' and i.inci_name='Water';
update public.recommendation_policy_versions set status='published',published_at=now() where id='ec500000-0000-4000-8000-000000000002';
set local role authenticated;
select is(public.read_recommendation_policy()->>'version','2','New sessions see the newly published policy');
select is(public.read_recommendation_policy()->>'source','mock-onboarding-v1','Current policy discloses onboarding demo source');
select is(public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))->>'id',(select value from consultation_policy_context where key='original_policy'),'Existing results retain the original immutable policy ID');
select is(public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))->>'version','1','Existing result report does not drift to the latest version');
select is((select r->>'relevance' from jsonb_array_elements(public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))->'rules') r where r->>'concern'='dehydration' and r->>'ingredient'='Glycerin'),'3','Original exact ingredient relevance remains available for professional reasons');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select throws_ok($$select public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))$$,'42501',null,'Other tenants cannot read individual consultation policy references');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000003","is_anonymous":true}',true);
select throws_ok($$select public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))$$,'42501',null,'Same-tenant devices in another store cannot read the session');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000004","is_anonymous":false}',true);
select throws_ok($$select public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))$$,'42501',null,'Staff cannot read a guest-specific consultation report');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select public.finish_kiosk_session((select value::uuid from consultation_policy_context where key='session'));
select throws_ok($$select public.read_kiosk_recommendation_policy((select value::uuid from consultation_policy_context where key='session'))$$,'42501',null,'Finished sessions cannot read old report policy references');
reset role;
select is((select count(*)::integer from public.recommendation_runs where session_id=(select value::uuid from consultation_policy_context where key='session')),0,'Finish purges the transient policy reference with the recommendation run');
select * from finish();
rollback;
