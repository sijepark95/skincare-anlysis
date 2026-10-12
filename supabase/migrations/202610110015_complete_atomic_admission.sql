-- Serialize purpose/choice changes and terminal admission with the same session row
-- used by the restricted observation writer. The stable read guards stay nonlocking.
do $$
declare f record;v_args text;v_signature text;v_returns text;v_call text;
begin
 for f in select p.oid,p.proname,pg_get_function_identity_arguments(p.oid) identity_args,pg_get_function_arguments(p.oid) declaration_args,pg_get_function_result(p.oid) return_type,p.proargnames
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
 'kiosk_set_complete_photo_consent','kiosk_claim_complete_analysis','kiosk_set_complete_skin_profile','kiosk_set_complete_base_choice',
 'kiosk_set_complete_preview_consent','kiosk_create_preview_plan','kiosk_claim_preview_slot','kiosk_complete_preview_slot','confirm_complete_beauty_preferences','create_complete_beauty_guide') loop
 v_signature:=format('public.%I(%s)',f.proname,f.identity_args);
 execute format('alter function %s set schema private',v_signature);
 execute format('revoke all on function private.%I(%s) from public,anon,authenticated,analysis_writer,service_role',f.proname,f.identity_args);
 select string_agg(quote_ident(a),',' order by ord) into v_args from unnest(f.proargnames) with ordinality q(a,ord);
 v_call:=format('private.%I(%s)',f.proname,v_args);
 v_returns:=case when f.return_type='void' then 'perform '||v_call||'; return;' else 'return '||v_call||';' end;
 execute format('create function public.%I(%s) returns %s language plpgsql security definer set search_path='''' as $body$ begin perform private.assert_device_session(p_session_id); %s end $body$',f.proname,f.declaration_args,f.return_type,v_returns);
 execute format('revoke all on function public.%I(%s) from public,anon,authenticated,analysis_writer,service_role',f.proname,f.identity_args);
 execute format('grant execute on function public.%I(%s) to authenticated',f.proname,f.identity_args);
 end loop;
end $$;
-- Identical confirmation is a no-op so locale changes/retries cannot invalidate a plan.
create or replace function public.confirm_complete_beauty_preferences(p_session_id uuid,p_preferences jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;v_existing jsonb;
begin
 s:=private.assert_device_session(p_session_id);s:=private.assert_complete_session(p_session_id,false);
 select jsonb_build_object('paletteId',palette_id,'faceShape',face_shape,'hairLength',hair_length,'mood',mood,'finish',finish) into v_existing from public.session_beauty_preferences where org_id=s.org_id and session_id=s.id;
 if v_existing=p_preferences then return;end if;
 perform private.confirm_complete_beauty_preferences(p_session_id,p_preferences);
end $$;
-- Expired/stale completion must never mark a slot successful. This admission occurs
-- after generation and before bytes are returned; concurrent revocation waits on it.
create or replace function public.kiosk_complete_preview_slot(p_session_id uuid,p_plan_id uuid,p_slot integer,p_status text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.kiosk_sessions;v_updated integer;
begin
 s:=private.assert_device_session(p_session_id);s:=private.assert_complete_preview(p_session_id,p_plan_id);
 if p_status is null or p_status not in ('complete','failed') then raise exception 'Terminal preview status required' using errcode='22023';end if;
 perform public.kiosk_assert_preview_slot(p_session_id,p_plan_id,p_slot);
 update public.session_complete_preview_slots set status=p_status,finished_at=now() where org_id=s.org_id and plan_id=p_plan_id and slot=p_slot and status='running';
 get diagnostics v_updated=row_count;
 if v_updated<>1 then raise exception 'Preview slot changed' using errcode='42501';end if;
end $$;
