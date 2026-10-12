begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;
insert into auth.users(id,is_anonymous) values
 ('ed100000-0000-4000-8000-000000000001',true),
 ('ed100000-0000-4000-8000-000000000002',true),
 ('ed100000-0000-4000-8000-000000000003',false),
 ('ed100000-0000-4000-8000-000000000004',true);
insert into public.organizations(id,name) values
 ('ed200000-0000-4000-8000-000000000001','Beauty feature A'),
 ('ed200000-0000-4000-8000-000000000002','Beauty feature B');
insert into public.stores(id,org_id,name) values
 ('ed300000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001','Beauty feature A'),
 ('ed300000-0000-4000-8000-000000000002','ed200000-0000-4000-8000-000000000002','Beauty feature B'),
 ('ed300000-0000-4000-8000-000000000004','ed200000-0000-4000-8000-000000000001','Beauty same tenant other store');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('ed400000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001','ed300000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000001','Beauty feature A'),
 ('ed400000-0000-4000-8000-000000000002','ed200000-0000-4000-8000-000000000002','ed300000-0000-4000-8000-000000000002','ed100000-0000-4000-8000-000000000002','Beauty feature B'),
 ('ed400000-0000-4000-8000-000000000004','ed200000-0000-4000-8000-000000000001','ed300000-0000-4000-8000-000000000004','ed100000-0000-4000-8000-000000000004','Other store feature');
insert into public.memberships(id,org_id,user_id,role) values
 ('ed500000-0000-4000-8000-000000000003','ed200000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000003','owner');
create temporary table feature_context(key text primary key,value text);
grant select,insert,update,delete on feature_context to authenticated,analysis_writer,anon;
insert into feature_context values('preferences','{"paletteId":"cool_soft","faceShape":"oval","hairLength":"any","mood":"fresh","finish":"any"}');
create function pg_temp.sid() returns uuid language sql as $$ select value::uuid from feature_context where key='session' $$;
create function pg_temp.result(p_patch jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('request_id',(select value from feature_context where key='request'),'mode','openai_beauty','model_version','gpt-4.1-mini-2025-04-14','prompt_version','beauty-style-suggestion-v2','image_quality','usable','undertone','cool','chroma','soft','face_shape','oval','eye_shape','almond','nose_shape','medium','lip_fullness','full','quality_flags','[]'::jsonb)||p_patch
$$;
create function pg_temp.write_result(p_result jsonb default pg_temp.result()) returns uuid language sql as $$
 select public.write_openai_beauty_analysis(pg_temp.sid(),(select value::uuid from feature_context where key='request'),'gpt-4.1-mini-2025-04-14',p_result)
$$;
create function pg_temp.confirm() returns void language sql as $$
 select public.confirm_kiosk_beauty_preferences(pg_temp.sid(),(select value::jsonb from feature_context where key='preferences'))
$$;
-- Fixture assembly only; assertions below exercise actual guest/writer roles.
create function pg_temp.new_session(p_ready boolean default false,p_patch jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer as $$
declare v_id uuid;
begin
 if pg_temp.sid() is not null and exists(select 1 from public.kiosk_sessions where id=pg_temp.sid() and status='active') then
   perform public.finish_kiosk_session(pg_temp.sid());
 end if;
 v_id:=public.start_kiosk_session();
 insert into feature_context(key,value) values('session',v_id::text),('request',extensions.gen_random_uuid()::text) on conflict(key) do update set value=excluded.value;
 perform public.record_consent(v_id,'2026-10-openai-v1',true);
 if p_ready then
   perform public.record_beauty_consent(v_id,'2026-10-beauty-photo-v1',true);
   perform public.claim_kiosk_beauty_analysis(v_id);
   perform pg_temp.write_result(pg_temp.result(p_patch));
   perform pg_temp.confirm();
 end if;
 return v_id;
end $$;

select is((select count(*)::integer from pg_tables where schemaname='public' and tablename in ('session_beauty_makeup_consents','session_beauty_makeup_attempts') and rowsecurity),2,'Both makeup purpose tables have RLS');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name in ('session_beauty_makeup_consents','session_beauty_makeup_attempts') and column_name not in ('org_id','session_id','notice_version','accepted','recorded_at','preferences_confirmed_at','claimed_at','invalidated_at')),0,'Makeup stores consent and claim metadata only, never photo, generated image or prose');
select ok(not has_table_privilege('anon','public.session_beauty_makeup_consents','SELECT,INSERT,UPDATE,DELETE'),'Unpaired anonymous API has no purpose-table privileges');
select ok(not has_table_privilege('analysis_writer','public.session_beauty_makeup_attempts','SELECT,INSERT,UPDATE,DELETE'),'Writer has no direct makeup table access');
select ok(not has_table_privilege('authenticated','public.session_beauty_makeup_attempts','INSERT,UPDATE,DELETE'),'Guest cannot reset or manufacture claims');
select ok(not has_table_privilege('service_role','public.session_beauty_makeup_attempts','SELECT,INSERT,UPDATE,DELETE'),'Service role has no makeup table privileges');
select ok(not has_function_privilege('analysis_writer','public.kiosk_claim_beauty_makeup(uuid)','EXECUTE'),'Restricted writer cannot authorize image generation');
select ok(not has_function_privilege('anon','public.kiosk_beauty_makeup_state(uuid)','EXECUTE'),'Unpaired API cannot read makeup purpose state');
select ok(not has_function_privilege('authenticated','private.assert_beauty_makeup_context(uuid,boolean)','EXECUTE'),'Private guard exposes no new guest privilege');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef and has_function_privilege('analysis_writer',p.oid,'EXECUTE')),9,'Only the nine explicitly provisioned narrow analysis writer signatures remain');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select pg_temp.new_session();
select is(public.kiosk_beauty_makeup_state(pg_temp.sid()),'{"consent":false,"attempted":false}'::jsonb,'New session has no implied makeup consent or claim');
select throws_ok($$select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1')$$,'42501',null,'Main consent does not imply separate beauty photo consent');
select public.record_beauty_consent(pg_temp.sid(),'2026-10-beauty-photo-v1',true);
select throws_ok($$select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-photo-v1')$$,'22023',null,'Photo notice cannot authorize makeup generation');
select throws_ok($$select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),null,'2026-10-beauty-makeup-v1')$$,'22023',null,'Null consent fails closed');
select lives_ok($$select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1')$$,'Explicit makeup consent can be recorded on camera step before analysis');
select is(public.kiosk_beauty_makeup_state(pg_temp.sid()),'{"consent":true,"attempted":false}'::jsonb,'Recording choice does not consume an external attempt');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Generation cannot begin without usable analysis and confirmed directions');
select public.claim_kiosk_beauty_analysis(pg_temp.sid());
set local role analysis_writer;
select throws_ok($$select pg_temp.write_result(pg_temp.result()-'eye_shape')$$,'22023',null,'v2 rejects missing eye category');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"eye_shape":null}')$$,'22023',null,'v2 rejects null eye category');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"eye_shape":"cat"}')$$,'22023',null,'Animal eye labels cannot enter analysis');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"nose_shape":"perfect"}')$$,'22023',null,'Value judgments cannot enter nose categories');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"lip_fullness":80}')$$,'22023',null,'Fabricated lip percentages cannot enter analysis');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"personality":"calm"}')$$,'22023',null,'Arbitrary feature or personality field is rejected');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"prompt_version":"beauty-style-suggestion-v1"}')$$,'22023',null,'Legacy protocol cannot contain v2 feature keys');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","face_shape":"uncertain","quality_flags":["blur"]}')$$,'22023',null,'Limited photo cannot assert eye/nose/lip categories');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"quality_flags":["blur"]}')$$,'22023',null,'Usable photo cannot contain limitation flags');
select throws_ok($$select pg_temp.write_result(pg_temp.result()||'{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","face_shape":"uncertain","eye_shape":"uncertain","nose_shape":"uncertain","lip_fullness":"uncertain","quality_flags":["no_face"]}')$$,'22023',null,'No face must remain not assessable');
select lives_ok($$select pg_temp.write_result()$$,'Restricted writer stores valid exact twelve-key v2 output');
set local role authenticated;
select is((select count(*)::integer from jsonb_object_keys(public.read_kiosk_beauty_session(pg_temp.sid())->'analysis')),12,'v2 read emits exact twelve-key protocol');
select is(public.read_kiosk_beauty_session(pg_temp.sid())->'analysis'->>'eye_shape','almond','Bounded visible eye category survives normalized round trip');
select is(public.read_kiosk_beauty_session(pg_temp.sid())->'analysis'->>'nose_shape','medium','Bounded nose styling category survives normalized round trip');
select is(public.read_kiosk_beauty_session(pg_temp.sid())->'analysis'->>'lip_fullness','full','Bounded lip styling category survives normalized round trip');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Usable photo still requires confirmed style directions');
select pg_temp.confirm();
select lives_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'Valid consented confirmed session claims makeup once');
select is(public.kiosk_beauty_makeup_state(pg_temp.sid()),'{"consent":true,"attempted":true}'::jsonb,'Claim is durable and purpose remains explicit');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Repeated image request cannot consume another paid attempt');
select lives_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'Late result guard accepts original active claim');

select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000002","is_anonymous":true}',true);
select is((select count(*)::integer from public.session_beauty_makeup_attempts),0,'Tenant RLS hides another guest claim');
select throws_ok($$select public.kiosk_beauty_makeup_state(pg_temp.sid())$$,'42501',null,'Foreign tenant cannot read makeup state');
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Foreign tenant cannot admit pending image');
select throws_ok($$select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),false,'2026-10-beauty-makeup-v1')$$,'42501',null,'Foreign tenant cannot change another purpose choice');
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000004","is_anonymous":true}',true);
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Another store in same tenant cannot admit pending image');
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select is((select count(*)::integer from public.session_beauty_makeup_consents),0,'Store owner cannot inspect individual purpose consent');
select throws_ok($$select public.kiosk_beauty_makeup_state(pg_temp.sid())$$,'42501',null,'Staff membership is not permission to access individual beauty report');
reset role;
select throws_ok($$insert into public.session_beauty_makeup_attempts(org_id,session_id,preferences_confirmed_at) values('ed200000-0000-4000-8000-000000000002',pg_temp.sid(),now())$$,'23503',null,'Composite foreign key prevents cross-tenant claim relationships');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),false,'2026-10-beauty-makeup-v1');
select is(public.kiosk_beauty_makeup_state(pg_temp.sid()),'{"consent":false,"attempted":true}'::jsonb,'Withdrawal retains consumed-attempt marker');
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Withdrawing generation blocks late image response');
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Reconsent cannot revive withdrawn generation');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Reconsent cannot reset durable paid attempt');

select pg_temp.new_session(true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select public.kiosk_claim_beauty_makeup(pg_temp.sid());
reset role;
update public.session_beauty_preferences set confirmed_at=confirmed_at+interval '1 second',mood='defined' where session_id=pg_temp.sid();
set local role authenticated;
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Changing confirmed style directions rejects a stale pending image');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Preference changes do not reset image generation claim');

select pg_temp.new_session(true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select public.kiosk_claim_beauty_makeup(pg_temp.sid());
select public.record_beauty_consent(pg_temp.sid(),'2026-10-beauty-photo-v1',false);
select is(public.kiosk_beauty_makeup_state(pg_temp.sid()),'{"consent":false,"attempted":true}'::jsonb,'Photo withdrawal clears dependent purpose consent but retains claim');
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Photo withdrawal denies late generation');
select public.record_beauty_consent(pg_temp.sid(),'2026-10-beauty-photo-v1',true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Photo reconsent cannot recover deleted analysis or image claim');

select pg_temp.new_session();
select public.record_beauty_consent(pg_temp.sid(),'2026-10-beauty-photo-v1',true);
select public.claim_kiosk_beauty_analysis(pg_temp.sid());
set local role analysis_writer;
select lives_ok($$select pg_temp.write_result((pg_temp.result()-'eye_shape'-'nose_shape'-'lip_fullness')||'{"prompt_version":"beauty-style-suggestion-v1"}')$$,'Legacy nine-key v1 write remains compatible');
set local role authenticated;
select is((select count(*)::integer from jsonb_object_keys(public.read_kiosk_beauty_session(pg_temp.sid())->'analysis')),9,'Legacy analysis read stays exact nine-key v1');
select ok(not (public.read_kiosk_beauty_session(pg_temp.sid())->'analysis' ? 'eye_shape'),'Legacy photo never invents new eye categories');
select pg_temp.confirm();
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Legacy analysis cannot authorize v2 image purpose');
reset role;
select is((select eye_shape||'/'||nose_shape||'/'||lip_fullness from public.session_beauty_analyses where session_id=pg_temp.sid()),'uncertain/uncertain/uncertain','Legacy normalized feature columns default to uncertain');
select throws_ok($$update public.session_beauty_analyses set eye_shape='almond' where session_id=pg_temp.sid()$$,'23514',null,'Even direct DB writes cannot invent v2 fields on legacy observation');
set local role authenticated;

select pg_temp.new_session(true,'{"image_quality":"limited","undertone":"uncertain","chroma":"uncertain","face_shape":"uncertain","eye_shape":"uncertain","nose_shape":"uncertain","lip_fullness":"uncertain","quality_flags":["blur"]}');
select is(public.read_kiosk_beauty_session(pg_temp.sid())->'analysis'->>'eye_shape','uncertain','Limited v2 output retains uncertain feature direction');
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select throws_ok($$select public.kiosk_claim_beauty_makeup(pg_temp.sid())$$,'42501',null,'Limited photo cannot authorize personalized generation');
reset role;
select throws_ok($$update public.session_beauty_analyses set lip_fullness='full' where session_id=pg_temp.sid()$$,'23514',null,'Normalized quality constraint blocks asserting lip category on limited photo');
set local role authenticated;

select pg_temp.new_session(true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select public.kiosk_claim_beauty_makeup(pg_temp.sid());
select public.finish_kiosk_session(pg_temp.sid());
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Finish denies pending image result');
reset role;
select is((select count(*)::integer from public.session_beauty_makeup_consents where session_id=pg_temp.sid()),0,'Finish purges transient makeup consent');
select is((select count(*)::integer from public.session_beauty_makeup_attempts where session_id=pg_temp.sid()),0,'Finish purges transient makeup claim');
set local role authenticated;

select pg_temp.new_session(true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select public.kiosk_claim_beauty_makeup(pg_temp.sid());
reset role;
update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=pg_temp.sid();
set local role authenticated;
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Expired session denies response before cleanup runs');
reset role;
select private.cleanup_expired_data();
select is((select count(*)::integer from public.session_beauty_makeup_attempts where session_id=pg_temp.sid()),0,'Minute cleanup purges expired makeup claim');
select is((select count(*)::integer from public.session_beauty_makeup_consents where session_id=pg_temp.sid()),0,'Minute cleanup purges expired makeup consent');
set local role authenticated;

select pg_temp.new_session(true);
select public.kiosk_set_beauty_makeup_consent(pg_temp.sid(),true,'2026-10-beauty-makeup-v1');
select public.kiosk_claim_beauty_makeup(pg_temp.sid());
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.revoke_device('ed400000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select throws_ok($$select public.kiosk_assert_beauty_makeup(pg_temp.sid())$$,'42501',null,'Device revocation denies pending image response');
reset role;
select is((select count(*)::integer from public.session_beauty_makeup_attempts where session_id=pg_temp.sid()),0,'Revocation purges transient makeup attempts');
select is((select count(*)::integer from public.session_beauty_makeup_consents where session_id=pg_temp.sid()),0,'Revocation purges transient makeup consents');

select * from finish();
rollback;
