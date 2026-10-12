-- Match the bounded 180s image provider/210s BFF timeout. Session and whole-plan
-- deadlines still apply independently, and no retry or duplicate claim is added.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('public.kiosk_assert_preview_slot(uuid,uuid,integer)'::regprocedure);
 if position('interval ''75 seconds''' in definition)=0 then raise exception 'Unexpected individual preview guard; review migration';end if;
 execute replace(definition,'interval ''75 seconds''','interval ''210 seconds''');
end $$;
