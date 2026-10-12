begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant analysis_writer to postgres with set true;
grant usage on schema extensions to analysis_writer;
insert into auth.users(id,is_anonymous) values
 ('ec100000-0000-4000-8000-000000000001',true),
 ('ec100000-0000-4000-8000-000000000002',true),
 ('ec100000-0000-4000-8000-000000000003',false),
 ('ec100000-0000-4000-8000-000000000004',false),
 ('ec100000-0000-4000-8000-000000000005',true);
insert into public.organizations(id,name) values('ec200000-0000-4000-8000-000000000001','Beauty metrics A');
insert into public.stores(id,org_id,name) values('ec300000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000001','Beauty metrics A');
insert into public.organizations(id,name) values('ec200000-0000-4000-8000-000000000002','Beauty tenant B');
insert into public.stores(id,org_id,name) values
 ('ec300000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002','Other tenant'),
 ('ec300000-0000-4000-8000-000000000003','ec200000-0000-4000-8000-000000000001','Other same-tenant store');
insert into public.devices(id,org_id,store_id,auth_user_id,label) values
 ('ec400000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000001','ec300000-0000-4000-8000-000000000001','ec100000-0000-4000-8000-000000000001','Beauty A'),
 ('ec400000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002','ec300000-0000-4000-8000-000000000002','ec100000-0000-4000-8000-000000000002','Beauty B'),
 ('ec400000-0000-4000-8000-000000000005','ec200000-0000-4000-8000-000000000001','ec300000-0000-4000-8000-000000000003','ec100000-0000-4000-8000-000000000005','Other store');
insert into public.memberships(id,org_id,user_id,role) values
 ('ec500000-0000-4000-8000-000000000003','ec200000-0000-4000-8000-000000000001','ec100000-0000-4000-8000-000000000003','owner'),
 ('ec500000-0000-4000-8000-000000000004','ec200000-0000-4000-8000-000000000001','ec100000-0000-4000-8000-000000000004','manager');
insert into public.membership_stores(org_id,membership_id,store_id) values('ec200000-0000-4000-8000-000000000001','ec500000-0000-4000-8000-000000000004','ec300000-0000-4000-8000-000000000001');
create temporary table metrics_context(key text primary key,value text);
grant select,insert,update,delete on metrics_context to authenticated,analysis_writer;
insert into metrics_context values('preferences','{"paletteId":"cool_soft","faceShape":"oval","hairLength":"medium","mood":"fresh","finish":"satin"}');
create function pg_temp.metric(p_name text) returns integer language sql security definer as $$
 select coalesce((select case p_name when 'started' then sessions_started when 'analyzed' then sessions_analyzed when 'completed' then sessions_completed end
  from public.store_daily_metrics where org_id='ec200000-0000-4000-8000-000000000001' and store_id='ec300000-0000-4000-8000-000000000001' and day=(now() at time zone 'UTC')::date),0)
$$;
create function pg_temp.new_session() returns uuid language plpgsql as $$
declare v_id uuid;
begin
 v_id:=public.start_kiosk_session();
 perform public.record_consent(v_id,'2026-10-openai-v1',true);
 insert into metrics_context(key,value) values('session',v_id::text),('request',extensions.gen_random_uuid()::text) on conflict(key) do update set value=excluded.value;
 return v_id;
end $$;
create function pg_temp.confirm() returns void language sql as $$
 select public.confirm_kiosk_beauty_preferences((select value::uuid from metrics_context where key='session'),(select value::jsonb from metrics_context where key='preferences'))
$$;
create function pg_temp.claim() returns boolean language plpgsql as $$
begin
 perform public.record_beauty_consent((select value::uuid from metrics_context where key='session'),'2026-10-beauty-photo-v1',true);
 return public.claim_kiosk_beauty_analysis((select value::uuid from metrics_context where key='session'));
end $$;
create function pg_temp.write_beauty() returns uuid language sql as $$
 select public.write_openai_beauty_analysis((select value::uuid from metrics_context where key='session'),(select value::uuid from metrics_context where key='request'),'gpt-4.1-mini-2025-04-14',jsonb_build_object('request_id',(select value from metrics_context where key='request'),'mode','openai_beauty','model_version','gpt-4.1-mini-2025-04-14','prompt_version','beauty-style-suggestion-v1','image_quality','usable','undertone','cool','chroma','soft','face_shape','oval','quality_flags','[]'::jsonb))
$$;
create function pg_temp.finish_session() returns void language sql as $$
 select public.finish_kiosk_session((select value::uuid from metrics_context where key='session'))
$$;

select ok(not has_function_privilege('authenticated','private.count_session_analysis(uuid,uuid)','EXECUTE'),'Guests cannot inflate analysis metrics through the private helper');
select ok(not has_function_privilege('analysis_writer','private.count_session_analysis(uuid,uuid)','EXECUTE'),'Writer keeps only its exact seven public signatures');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000001","is_anonymous":true}',true);
select pg_temp.new_session();
select is(pg_temp.metric('started'),1,'Primary beauty start counts once');
select pg_temp.claim();
select is(pg_temp.metric('analyzed'),0,'An attempt without a completed output is not an analyzed session');
reset role;
set local role analysis_writer;
select pg_temp.write_beauty();
select is(pg_temp.metric('analyzed'),1,'First primary beauty result counts one analyzed session');
select pg_temp.write_beauty();
select is(pg_temp.metric('analyzed'),1,'Beauty writer retry does not inflate analyzed count');
select is(pg_temp.metric('completed'),0,'An output alone is not a confirmed beauty completion');
reset role;
set local role authenticated;
select pg_temp.confirm();
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),1,'Photo-based confirmed book counts one completion');
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),1,'Repeated finish does not inflate completion');
select pg_temp.new_session();
select pg_temp.confirm();
select public.confirm_kiosk_beauty_preferences((select value::uuid from metrics_context where key='session'),(select value::jsonb||'{"mood":"defined"}' from metrics_context where key='preferences'));
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),2,'Manual confirmed book counts completion without any photo');
select is(pg_temp.metric('analyzed'),1,'Manual book does not pretend an AI analysis occurred');
select pg_temp.new_session();
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),2,'Unconfirmed abandonment is not a completed book');
select pg_temp.new_session();
select pg_temp.claim();
reset role;
set local role analysis_writer;
select pg_temp.write_beauty();
reset role;
set local role authenticated;
select pg_temp.finish_session();
select is(pg_temp.metric('analyzed'),2,'A second actual beauty output counts a second analyzed session');
select is(pg_temp.metric('completed'),2,'Unconfirmed photo session does not count as completed');
select pg_temp.new_session();
select pg_temp.confirm();
reset role;
update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=(select value::uuid from metrics_context where key='session');
set local role authenticated;
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),2,'Finishing after the idle deadline does not count an expired book');
reset role;
select is((select status from public.kiosk_sessions where id=(select value::uuid from metrics_context where key='session')),'expired','Late finish uses the expiry purge path');
set local role authenticated;
select pg_temp.new_session();
select pg_temp.confirm();
select pg_temp.claim();
reset role;
set local role analysis_writer;
select pg_temp.write_beauty();
reset role;
update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=(select value::uuid from metrics_context where key='session');
select private.cleanup_expired_data();
select is(pg_temp.metric('analyzed'),3,'Expiry preserves the aggregate of an actually completed analysis');
select is(pg_temp.metric('completed'),2,'Scheduled expiry never manufactures a guest completion');
select is((select count(*)::integer from public.session_beauty_analyses where session_id=(select value::uuid from metrics_context where key='session')),0,'Expired individual observations are purged while aggregate remains');
set local role authenticated;
select pg_temp.new_session();
select pg_temp.claim();
reset role;
set local role analysis_writer;
select pg_temp.write_beauty();
reset role;
set local role authenticated;
select pg_temp.confirm();
select public.record_beauty_consent((select value::uuid from metrics_context where key='session'),'2026-10-beauty-photo-v1',false);
select pg_temp.finish_session();
select is(pg_temp.metric('analyzed'),4,'Withdrawal does not erase an anonymous aggregate of a prior actual output');
select is(pg_temp.metric('completed'),2,'Withdrawn confirmed choices cannot count as a completed book');
select pg_temp.new_session();
select pg_temp.claim();
reset role;
set local role analysis_writer;
select pg_temp.write_beauty();
reset role;
set local role authenticated;
select public.save_answers((select value::uuid from metrics_context where key='session'),'dry',array['dehydration'],'{}',false);
reset role;
set local role analysis_writer;
select public.write_analysis_result((select value::uuid from metrics_context where key='session'),extensions.gen_random_uuid(),'mock','metrics-fixture','demo','[]');
select is(pg_temp.metric('analyzed'),5,'Beauty followed by supported skin output counts one session across purposes');
reset role;
set local role authenticated;
select pg_temp.confirm();
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),3,'Mixed skin and beauty finish counts once');
select pg_temp.new_session();
select public.save_answers((select value::uuid from metrics_context where key='session'),'dry',array['dehydration'],'{}',false);
reset role;
set local role analysis_writer;
select public.write_analysis_result((select value::uuid from metrics_context where key='session'),extensions.gen_random_uuid(),'mock','metrics-fixture','demo','[]');
reset role;
set local role authenticated;
select pg_temp.claim();
reset role;
set local role analysis_writer;
select pg_temp.write_beauty();
select is(pg_temp.metric('analyzed'),6,'Skin followed by beauty also counts one analyzed session');
reset role;
set local role authenticated;
select pg_temp.confirm();
select pg_temp.finish_session();
select is(pg_temp.metric('completed'),4,'Reverse-order mixed finish is still one completion');
select pg_temp.new_session();
select pg_temp.confirm();
insert into metrics_context select 'save',public.create_kiosk_beauty_guide((select value::uuid from metrics_context where key='session'),repeat('c3',32),'2026-10-beauty-save-v1',true)::text;
select is(public.read_beauty_saved_guide(repeat('c3',32))->>'guideVersion','beauty-style-guide-v1','Saved guide carries an explicit immutable editorial version');
reset role;
select throws_ok($$update public.beauty_saved_guides set guide_version='unsupported-v2' where token_hash=repeat('c3',32)$$,'23514',null,'Unsupported saved guide definitions cannot silently reinterpret existing links');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec100000-0000-4000-8000-000000000003","is_anonymous":false}',true);
select public.revoke_device('ec400000-0000-4000-8000-000000000001');
select is(pg_temp.metric('completed'),4,'Device revocation is not a guest completion');
select is(pg_temp.metric('analyzed'),6,'Revocation does not create an extra analyzed session');
reset role;
select is((select count(*)::integer from public.session_beauty_preferences where session_id=(select value::uuid from metrics_context where key='session')),0,'Revocation purges individual choices');
select ok(public.read_beauty_saved_guide(repeat('c3',32)) is not null,'Separately saved guide version survives source device revocation');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name='store_daily_metrics'),6,'Management metrics remain counters only, without beauty observations or preferences');
select * from finish();
rollback;
