begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;

insert into auth.users(id,is_anonymous) values
 ('ec100000-0000-4000-8000-000000000001',true),
 ('ec100000-0000-4000-8000-000000000002',true),
 ('ec100000-0000-4000-8000-000000000003',false);
insert into public.organizations(id,name) values('ec200000-0000-4000-8000-000000000002','Explanation tenant B');
insert into public.stores(id,org_id,name) values('ec300000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002','B');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('ec400000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ec100000-0000-4000-8000-000000000001','A'),
 ('ec400000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002','ec300000-0000-4000-8000-000000000002','ec100000-0000-4000-8000-000000000002','B');
insert into public.memberships(org_id,user_id,role) values('11111111-1111-4111-8111-111111111111','ec100000-0000-4000-8000-000000000003','owner');
create temporary table explanation_context(key text primary key,value text);
grant select,insert,update on explanation_context to authenticated,analysis_writer;
insert into explanation_context values('products','[{"productId":"33333333-3333-4333-8333-333333333332","text":"Registered Glycerin matches a reviewed store rule for your selected hydration goal."},{"productId":"33333333-3333-4333-8333-333333333331","text":"A reviewed ingredient match."}]');

select ok(not has_function_privilege('authenticated','public.complete_recommendation_explanation(uuid,text,text,jsonb,text,text)','EXECUTE'),'Devices and staff cannot forge completed explanations');
select ok(not has_function_privilege('anon','public.complete_recommendation_explanation(uuid,text,text,jsonb,text,text)','EXECUTE'),'Unauthenticated clients cannot complete explanations');
select ok(not has_function_privilege('service_role','public.complete_recommendation_explanation(uuid,text,text,jsonb,text,text)','EXECUTE'),'Service API cannot execute restricted explanation completion');
select ok(has_function_privilege('analysis_writer','public.complete_recommendation_explanation(uuid,text,text,jsonb,text,text)','EXECUTE'),'Restricted writer has the exact completion RPC');
select ok(not has_table_privilege('analysis_writer','public.recommendation_explanation_runs','SELECT,INSERT,UPDATE,DELETE'),'Writer cannot directly browse or mutate explanation rows');
select ok(not has_function_privilege('analysis_writer','public.claim_kiosk_explanation(uuid)','EXECUTE'),'Writer cannot claim a customer session');
select is((select count(*)::integer from pg_tables where schemaname='public' and tablename in ('session_explanation_consents','recommendation_explanation_runs','recommendation_product_explanations') and rowsecurity),3,'All normalized explanation tables enable RLS');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
insert into explanation_context select 'session',public.start_kiosk_session()::text;
select throws_ok($$select public.record_explanation_consent((select value::uuid from explanation_context where key='session'),'2026-10-openai-explanation-v1',true)$$,'42501',null,'Optional external processing cannot bypass main consent');
select public.record_consent((select value::uuid from explanation_context where key='session'),'2026-10-mvp',true);
select throws_ok($$select public.record_explanation_consent((select value::uuid from explanation_context where key='session'),'old-notice',true)$$,'22023',null,'Only the current external-processing notice is supported');
select throws_ok($$select public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session'))$$,'42501',null,'Main consent alone never authorizes external explanation');
select public.record_explanation_consent((select value::uuid from explanation_context where key='session'),'2026-10-openai-explanation-v1',false);
select throws_ok($$select public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session'))$$,'42501',null,'Declining optional processing never claims an external request');
select public.record_explanation_consent((select value::uuid from explanation_context where key='session'),'2026-10-openai-explanation-v1',true);
select throws_ok($$select public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session'))$$,'22023',null,'Only finalized recommendations can be explained');
select public.save_answers((select value::uuid from explanation_context where key='session'),'dry',array['dehydration'],'{}',false);
reset role;
set local role analysis_writer;
insert into explanation_context select 'analysis',public.write_analysis_result((select value::uuid from explanation_context where key='session'),(select value::uuid from explanation_context where key='session'),'mock','synthetic','demo','[]')::text;
insert into explanation_context select 'run',public.persist_recommendations((select value::uuid from explanation_context where key='session'),(select value::uuid from explanation_context where key='analysis'),'a2786824-b258-5924-82b6-2d71465eb668','[{"variant_id":"33333333-3333-4333-8333-333333333332","score":3,"matched_ingredients":["Glycerin"],"reasons":[{"concern":"dehydration","ingredient":"Glycerin","relevance":3}]},{"variant_id":"33333333-3333-4333-8333-333333333331","score":2,"matched_ingredients":["Glycerin"],"reasons":[{"concern":"dehydration","ingredient":"Glycerin","relevance":3}]}]')::text;
select throws_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated','Reviewed matches',(select value::jsonb from explanation_context where key='products'),'synthetic-model','retail-match-v1')$$,'22023',null,'Writer cannot complete an unclaimed request');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select throws_ok($$select public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session'))$$,'42501',null,'Another tenant device cannot claim the request');
select is((select count(*)::integer from public.session_explanation_consents),0,'Another tenant cannot read optional consent');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select lives_ok($$select public.record_explanation_consent((select value::uuid from explanation_context where key='session'),'2026-10-openai-explanation-v1',true)$$,'Identical consent retries remain idempotent after analysis');
select throws_ok($$select public.record_explanation_consent((select value::uuid from explanation_context where key='session'),'2026-10-openai-explanation-v1',false)$$,'22023',null,'Optional choice is locked after analysis');
select is(public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session')),true,'First claim authorizes exactly one API attempt');
select is(public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session')),false,'Pending request is durable and never reclaims on reload');
select is(public.read_kiosk_session((select value::uuid from explanation_context where key='session'))->'explanation','null'::jsonb,'Pending output is not represented as completed text');
select is(public.read_kiosk_session((select value::uuid from explanation_context where key='session'))->'explanation_consent'->>'notice_version','2026-10-openai-explanation-v1','Kiosk reload retains the separate notice version');
reset role;
select throws_ok($$insert into public.recommendation_explanation_runs(org_id,session_id,recommendation_run_id) values('ec200000-0000-4000-8000-000000000002',(select value::uuid from explanation_context where key='session'),(select value::uuid from explanation_context where key='run'))$$,'23503',null,'Composite foreign key prevents cross-tenant session/run linkage');
select throws_ok($$insert into public.recommendation_product_explanations(org_id,recommendation_run_id,recommendation_item_id,explanation_text) select 'ec200000-0000-4000-8000-000000000002',(select value::uuid from explanation_context where key='run'),id,'Forged' from public.recommendation_items where run_id=(select value::uuid from explanation_context where key='run') limit 1$$,'23503',null,'Composite foreign keys prevent cross-tenant product explanation linkage');
set local role analysis_writer;
select throws_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated','Reviewed matches','[]','synthetic-model','retail-match-v1')$$,'22023',null,'Completion must cover every final product');
select throws_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated','Reviewed matches',jsonb_build_array((select value::jsonb->1 from explanation_context where key='products'),(select value::jsonb->0 from explanation_context where key='products')),'synthetic-model','retail-match-v1')$$,'22023',null,'LLM cannot reorder the final ranked products');
select throws_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated',repeat('x',601),(select value::jsonb from explanation_context where key='products'),'synthetic-model','retail-match-v1')$$,'22023',null,'Saved summary is strictly bounded');
select throws_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'fallback','Reviewed matches',(select value::jsonb from explanation_context where key='products'),'synthetic-model','retail-match-v1')$$,'22023',null,'Fallback cannot claim generated model provenance');
select lives_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated','Reviewed matches',(select value::jsonb from explanation_context where key='products'),'synthetic-model','retail-match-v1')$$,'Validated bounded matching text persists');
select lives_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated','Attempted replacement',(select value::jsonb from explanation_context where key='products'),'other-model','retail-match-v1')$$,'Completion retry is an immutable no-op');
reset role;
select is((select count(*)::integer from public.recommendation_product_explanations where recommendation_run_id=(select value::uuid from explanation_context where key='run')),2,'Product explanations are normalized separate rows');
select is((select summary from public.recommendation_explanation_runs where session_id=(select value::uuid from explanation_context where key='session')),'Reviewed matches','Stored output cannot be replaced after completion');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select is((select count(*)::integer from public.recommendation_explanation_runs),0,'Another tenant cannot read customer explanation runs');
select is((select count(*)::integer from public.recommendation_product_explanations),0,'Another tenant cannot read product explanation text');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select is((select count(*)::integer from public.recommendation_explanation_runs),0,'Staff cannot browse individual customer explanation runs');
select is((select count(*)::integer from public.session_explanation_consents),0,'Staff cannot browse optional customer consent');
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(public.read_kiosk_session((select value::uuid from explanation_context where key='session'))->'explanation'->>'status','generated','Paired kiosk receives generated status');
select is(public.read_kiosk_session((select value::uuid from explanation_context where key='session'))->'explanation'->'products'->0->>'productId','33333333-3333-4333-8333-333333333332','Kiosk reads explanations in final recommendation order');
select is(public.claim_kiosk_explanation((select value::uuid from explanation_context where key='session')),false,'Completed session never generates another API attempt');
select public.finish_kiosk_session((select value::uuid from explanation_context where key='session'));
reset role;
select is((select count(*)::integer from public.recommendation_explanation_runs where session_id=(select value::uuid from explanation_context where key='session')),0,'Finish deletes explanation claims and summary');
select is((select count(*)::integer from public.recommendation_product_explanations where recommendation_run_id=(select value::uuid from explanation_context where key='run')),0,'Finish cascades all product text removal');
select is((select count(*)::integer from public.session_explanation_consents where session_id=(select value::uuid from explanation_context where key='session')),0,'Optional consent follows transient-session removal');
set local role analysis_writer;
select throws_ok($$select public.complete_recommendation_explanation((select value::uuid from explanation_context where key='session'),'generated','Late result',(select value::jsonb from explanation_context where key='products'),'synthetic-model','retail-match-v1')$$,'42501',null,'A late response cannot recreate finished customer data');
reset role;
-- Exercise both other privacy exits with populated new child rows. These are
-- database fixtures only; no signup, email or external API is invoked.
create function pg_temp.explanation_cleanup_fixture() returns uuid language plpgsql as $$
declare v_session uuid; v_analysis uuid; v_run uuid; v_item uuid;
begin
  insert into public.kiosk_sessions(org_id,store_id,device_id,questionnaire_version_id)
    select '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ec400000-0000-4000-8000-000000000001',id from public.questionnaire_versions where active limit 1 returning id into v_session;
  insert into public.session_explanation_consents(org_id,session_id,notice_version,accepted) values('11111111-1111-4111-8111-111111111111',v_session,'2026-10-openai-explanation-v1',true);
  insert into public.analyses(org_id,session_id,request_id,mode,model_version,quality_status) values('11111111-1111-4111-8111-111111111111',v_session,v_session,'mock','synthetic-cleanup','demo') returning id into v_analysis;
  insert into public.recommendation_runs(org_id,session_id,analysis_id,policy_version_id) values('11111111-1111-4111-8111-111111111111',v_session,v_analysis,'a2786824-b258-5924-82b6-2d71465eb668') returning id into v_run;
  insert into public.recommendation_items(org_id,run_id,variant_id,rank,score,reason) values('11111111-1111-4111-8111-111111111111',v_run,'33333333-3333-4333-8333-333333333332',1,1,'Synthetic cleanup fixture') returning id into v_item;
  insert into public.recommendation_explanation_runs(org_id,session_id,recommendation_run_id,status,summary,model_version,prompt_version,completed_at) values('11111111-1111-4111-8111-111111111111',v_session,v_run,'generated','Reviewed match','synthetic','retail-match-v1',now());
  insert into public.recommendation_product_explanations(org_id,recommendation_run_id,recommendation_item_id,explanation_text) values('11111111-1111-4111-8111-111111111111',v_run,v_item,'Reviewed match');
  return v_session;
end $$;
insert into explanation_context select 'expired',pg_temp.explanation_cleanup_fixture()::text;
update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=(select value::uuid from explanation_context where key='expired');
select private.cleanup_expired_data();
select is((select count(*)::integer from public.recommendation_explanation_runs where session_id=(select value::uuid from explanation_context where key='expired')),0,'Scheduled expiry removes explanation summary and claim');
select is((select count(*)::integer from public.session_explanation_consents where session_id=(select value::uuid from explanation_context where key='expired')),0,'Scheduled expiry removes optional consent');
select is((select count(*)::integer from public.recommendation_product_explanations where org_id='11111111-1111-4111-8111-111111111111'),0,'Scheduled expiry cascades normalized product text removal');
insert into explanation_context select 'revoked',pg_temp.explanation_cleanup_fixture()::text;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.revoke_device('ec400000-0000-4000-8000-000000000001');
reset role;
select is((select count(*)::integer from public.recommendation_explanation_runs where session_id=(select value::uuid from explanation_context where key='revoked')),0,'Device revocation removes explanation summary and claim');
select is((select count(*)::integer from public.session_explanation_consents where session_id=(select value::uuid from explanation_context where key='revoked')),0,'Device revocation removes optional consent');
select is((select count(*)::integer from public.recommendation_product_explanations where org_id='11111111-1111-4111-8111-111111111111'),0,'Device revocation cascades product text removal');
select * from finish();
rollback;
