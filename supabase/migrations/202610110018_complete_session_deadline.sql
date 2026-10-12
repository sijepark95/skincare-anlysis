-- The integrated photo session has an absolute 15-minute ceiling in addition to
-- the preserved inactivity policy. A plan ends at the earlier session/12min limit.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('private.assert_complete_session(uuid,boolean)'::regprocedure);
 if position('s.id is null or not private.own_session(s.org_id,s.id)' in definition)=0 then raise exception 'Unexpected complete guard; review migration';end if;
 execute replace(definition,'s.id is null or not private.own_session(s.org_id,s.id)','s.id is null or s.started_at<=now()-interval ''15 minutes'' or not private.own_session(s.org_id,s.id)');
 definition:=pg_get_functiondef('public.read_kiosk_beauty_complete(uuid)'::regprocedure);
 if position('s.id is null or not private.own_session(s.org_id,s.id)' in definition)=0 then raise exception 'Unexpected complete read; review migration';end if;
 execute replace(definition,'s.id is null or not private.own_session(s.org_id,s.id)','s.id is null or s.started_at<=now()-interval ''15 minutes'' or not private.own_session(s.org_id,s.id)');
end $$;
create function private.bound_complete_preview_deadline() returns trigger language plpgsql security definer set search_path='' as $$
declare v_expiry timestamptz;
begin select started_at+interval '15 minutes' into v_expiry from public.kiosk_sessions where org_id=new.org_id and id=new.session_id;
 new.deadline:=least(new.deadline,v_expiry);
 if new.deadline<=now() then raise exception 'Session expired' using errcode='42501';end if;return new;end $$;
create trigger complete_plan_deadline before insert on public.session_complete_preview_plans for each row execute function private.bound_complete_preview_deadline();
create function private.assert_complete_write_deadline() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.session_complete_guest_context c join public.kiosk_sessions s on s.org_id=c.org_id and s.id=c.session_id where c.org_id=new.org_id and c.session_id=new.session_id and s.started_at<=now()-interval '15 minutes') then raise exception 'Integrated session expired before result admission' using errcode='42501';end if;return new;
end $$;
create trigger complete_write_deadline before insert on public.analyses for each row execute function private.assert_complete_write_deadline();
create trigger complete_write_deadline before insert on public.session_beauty_analyses for each row execute function private.assert_complete_write_deadline();
alter function private.cleanup_expired_data() rename to cleanup_expired_data_legacy;
create function private.cleanup_expired_data() returns void language plpgsql security definer set search_path='' as $$
declare s record;
begin
 for s in select ks.org_id,ks.id from public.kiosk_sessions ks join public.session_complete_guest_context c on c.org_id=ks.org_id and c.session_id=ks.id where ks.status='active' and ks.started_at<=now()-interval '15 minutes' for update of ks loop
 perform private.purge_session_details(s.org_id,s.id,'expired');end loop;
 perform private.cleanup_expired_data_legacy();
end $$;
revoke all on function private.bound_complete_preview_deadline(),private.assert_complete_write_deadline(),private.cleanup_expired_data_legacy(),private.cleanup_expired_data() from public,anon,authenticated,analysis_writer,service_role;
