begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;

insert into auth.users(id,is_anonymous) values
 ('ee100000-0000-4000-8000-000000000001',true),
 ('ee100000-0000-4000-8000-000000000002',true),
 ('ee100000-0000-4000-8000-000000000003',false);
insert into public.organizations(id,name) values
 ('ee200000-0000-4000-8000-000000000001','Experimental fixture A'),
 ('ee200000-0000-4000-8000-000000000002','Experimental fixture B');
insert into public.stores(id,org_id,name) values
 ('ee300000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000001','A'),
 ('ee300000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000002','B');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('ee400000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000001','ee300000-0000-4000-8000-000000000001','ee100000-0000-4000-8000-000000000001','A'),
 ('ee400000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000002','ee300000-0000-4000-8000-000000000002','ee100000-0000-4000-8000-000000000002','B');
insert into public.memberships(org_id,user_id,role) values('ee200000-0000-4000-8000-000000000001','ee100000-0000-4000-8000-000000000003','owner');
create temporary table experimental_context(key text primary key,value text);
grant select,insert on experimental_context to authenticated,analysis_writer;
insert into experimental_context select 'visual',jsonb_build_object('model_version','synthetic-visual-1','heads',jsonb_agg(jsonb_build_object('key',k,'label',k,'predicted_code','A','probabilities',jsonb_build_array(jsonb_build_object('code','A','probability',0.75),jsonb_build_object('code','B','probability',0.25)))))::text from unnest(array['sensitivity','pigmentation','wrinkles','acne','pores','sagging','keratin','redness']) k;
insert into experimental_context values('ingredients','{"model_version":"synthetic-ingredients-1","candidates":[{"ingredient":"Glycerin","score":0.8},{"ingredient":"Unreviewed checkpoint label","score":0.2}],"input_coverage":["skin_type","skin_concerns"]}');

select ok(not has_function_privilege('authenticated','public.write_experimental_analysis(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE'),'Devices and staff cannot forge experimental analysis');
select ok(not has_function_privilege('anon','public.write_experimental_analysis(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE'),'Anonymous API cannot write experimental analysis');
select ok(not has_function_privilege('service_role','public.write_experimental_analysis(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE'),'Service API cannot call the restricted experimental writer');
select ok(has_function_privilege('analysis_writer','public.write_experimental_analysis(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE'),'Restricted writer can execute experimental RPC');
select ok(not has_table_privilege('analysis_writer','public.analysis_ingredient_candidates','SELECT'),'Writer has no direct output browsing privilege');
select is(private.resolve_reviewed_ingredient('  PANTHENOL  '),(select id from public.ingredients where inci_name='Panthenol'),'Candidate identity resolves reviewed names across case and whitespace');
select is(private.resolve_reviewed_ingredient('Provitamin B5'),(select id from public.ingredients where inci_name='Panthenol'),'Candidate identity accepts only an existing reviewed alias');
select is(private.resolve_reviewed_ingredient('Ceramides'),null::uuid,'A broad ingredient family cannot select a specific reviewed ceramide');
select is(private.resolve_reviewed_ingredient('Unknown checkpoint ingredient'),null::uuid,'Unknown checkpoint labels remain unresolved');
insert into public.ingredient_aliases(alias,ingredient_id) select 'Panthenol',id from public.ingredients where inci_name='Glycerin';
select is(private.resolve_reviewed_ingredient('Panthenol'),null::uuid,'Ambiguous reviewed names and aliases fail closed');
delete from public.ingredient_aliases where alias='Panthenol';
select ok(not has_function_privilege('authenticated','private.resolve_reviewed_ingredient(text)','EXECUTE'),'Client cannot invoke private candidate resolution');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ee100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
insert into experimental_context select 'session',public.start_kiosk_session()::text;
reset role;
set local role analysis_writer;
select throws_ok($$select public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),(select value::uuid from experimental_context where key='session'),'local-1','Experimental',null,(select value::jsonb from experimental_context where key='ingredients'))$$,'42501',null,'Consent and completed preferences are required before experimental inference');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ee100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select public.record_consent((select value::uuid from experimental_context where key='session'),'2026-10-experimental-v1',true);
select public.save_answers((select value::uuid from experimental_context where key='session'),'dry',array['dehydration'],'{}',false);
reset role;
set local role analysis_writer;
select throws_ok($$select public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),'ee500000-0000-4000-8000-000000000099','local-1','Experimental',null,(select value::jsonb from experimental_context where key='ingredients'))$$,'22023',null,'Experimental request is bound to its own session');
select throws_ok($$select public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),(select value::uuid from experimental_context where key='session'),'local-1','Experimental',null,'{"model_version":"linear","candidates":[],"input_coverage":[],"image":"forbidden"}')$$,'22023',null,'Unexpected image or metadata fields are rejected before normalized persistence');
select throws_ok($$select public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),(select value::uuid from experimental_context where key='session'),'local-1','Experimental',null,'{"model_version":"linear","candidates":[{"ingredient":"Glycerin","score":2}],"input_coverage":[]}')$$,'23514',null,'Candidate scores cannot escape the bounded probability range');
select throws_ok($$select public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),(select value::uuid from experimental_context where key='session'),'local-1','Experimental',jsonb_set((select value::jsonb from experimental_context where key='visual'),'{heads,0,probabilities,0,probability}','0.1'),(select value::jsonb from experimental_context where key='ingredients'))$$,'22023',null,'Categorical outputs must form a distribution and include the winning predicted code');
insert into experimental_context select 'analysis',public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),(select value::uuid from experimental_context where key='session'),'local-1','Experimental',(select value::jsonb from experimental_context where key='visual'),(select value::jsonb from experimental_context where key='ingredients'))::text;
select is(public.write_experimental_analysis((select value::uuid from experimental_context where key='session'),(select value::uuid from experimental_context where key='session'),'local-1','Experimental',null,(select value::jsonb from experimental_context where key='ingredients'))::text,(select value from experimental_context where key='analysis'),'Experimental retries do not duplicate results or metrics');
reset role;
select is((select count(*)::integer from public.analysis_visual_heads where analysis_id=(select value::uuid from experimental_context where key='analysis')),8,'All eight categorical heads persist as normalized rows');
select is((select count(*)::integer from public.analysis_visual_probabilities where analysis_id=(select value::uuid from experimental_context where key='analysis')),16,'Per-code relative outputs persist separately');
select is((select count(*)::integer from public.observations where analysis_id=(select value::uuid from experimental_context where key='analysis')),0,'No clinical observations or severity scores are invented');
select is((select count(*)::integer from public.ingredients where inci_name='Unreviewed checkpoint label'),0,'Unreviewed labels are never promoted into the catalog ingredient dictionary');
select throws_ok($$insert into public.analysis_input_coverage(org_id,analysis_id,feature) values('ee200000-0000-4000-8000-000000000002',(select value::uuid from experimental_context where key='analysis'),'forged')$$,'23503',null,'Composite foreign keys reject cross-tenant output linkage');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ee100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select is((select count(*)::integer from public.analysis_visual_heads),0,'Another tenant device cannot read categorical output rows');
select is((select count(*)::integer from public.analysis_ingredient_candidates),0,'Another tenant device cannot read ingredient candidates');
select set_config('request.jwt.claims','{"sub":"ee100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select is((select count(*)::integer from public.analysis_visual_heads),0,'Staff cannot browse individual photo outputs');
select is((select count(*)::integer from public.analysis_ingredient_candidates),0,'Staff cannot browse individual ingredient inference');
select set_config('request.jwt.claims','{"sub":"ee100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select is(public.read_kiosk_session((select value::uuid from experimental_context where key='session'))->'analysis'->>'mode','experimental','The paired kiosk reads an explicit experimental discriminator');
select is(jsonb_array_length(public.read_kiosk_session((select value::uuid from experimental_context where key='session'))->'analysis'->'visual'->'heads'),8,'Kiosk RPC reconstructs normalized categorical heads');
select is(jsonb_array_length(public.read_kiosk_session((select value::uuid from experimental_context where key='session'))->'analysis'->'ingredients'->'candidates'),2,'Kiosk RPC reconstructs candidates without product approval');
select public.finish_kiosk_session((select value::uuid from experimental_context where key='session'));
reset role;
select is((select count(*)::integer from public.analysis_model_outputs where analysis_id=(select value::uuid from experimental_context where key='analysis')),0,'Finish cascades model metadata removal');
select is((select count(*)::integer from public.analysis_visual_probabilities where analysis_id=(select value::uuid from experimental_context where key='analysis')),0,'Finish cascades every relative output removal');
select is((select count(*)::integer from public.analysis_ingredient_candidates where analysis_id=(select value::uuid from experimental_context where key='analysis')),0,'Finish cascades candidate removal');
select is((select count(*)::integer from public.analysis_input_coverage where analysis_id=(select value::uuid from experimental_context where key='analysis')),0,'Finish cascades input-coverage removal');
select * from finish();
rollback;
