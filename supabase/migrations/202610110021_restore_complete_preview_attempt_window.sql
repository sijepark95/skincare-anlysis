-- The integrated provider is bounded at60s and its HTTP adapter at75s.
-- Restore the integrated claim ceiling; legacy180s makeup uses another contract.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('public.kiosk_assert_preview_slot(uuid,uuid,integer)'::regprocedure);
 if position('interval ''210 seconds''' in definition)=0 then raise exception 'Unexpected individual preview guard; review migration';end if;
 execute replace(definition,'interval ''210 seconds''','interval ''75 seconds''');
end $$;
