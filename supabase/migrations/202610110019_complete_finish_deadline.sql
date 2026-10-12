-- A recently active integrated session cannot count as completed after its
-- absolute expiry while waiting for the next cleanup tick.
alter function public.finish_kiosk_beauty_complete(uuid,text) set schema private;
revoke all on function private.finish_kiosk_beauty_complete(uuid,text) from public,anon,authenticated,analysis_writer,service_role;
create function public.finish_kiosk_beauty_complete(p_session_id uuid,p_gender text default null) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;
begin
 select * into s from public.kiosk_sessions where id=p_session_id for update;
 if s.id is null or not private.own_device(s.org_id,s.device_id) then raise exception 'Device session permission required' using errcode='42501';end if;
 if s.status<>'active' then return;end if;
 if s.started_at<=now()-interval '15 minutes' and exists(select 1 from public.session_complete_guest_context where org_id=s.org_id and session_id=s.id) then
  perform private.purge_session_details(s.org_id,s.id,'expired');return;
 end if;
 perform private.finish_kiosk_beauty_complete(s.id,p_gender);
end $$;
revoke all on function public.finish_kiosk_beauty_complete(uuid,text) from public,anon,analysis_writer,service_role;
grant execute on function public.finish_kiosk_beauty_complete(uuid,text) to authenticated;
