begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Transaction-scoped synthetic Auth records. No real passwords/accounts remain.
insert into auth.users(id, email, encrypted_password, is_anonymous, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
 ('a5000000-0000-4000-8000-000000000001', 'new-owner@example.invalid', 'test-verifier', false, now(), '{"provider":"email"}', '{"role":"owner","organization_id":"11111111-1111-4111-8111-111111111111"}'),
 ('a5000000-0000-4000-8000-000000000002', 'unconfirmed@example.invalid', 'test-verifier', false, null, '{"provider":"email"}', '{"email_confirmed":true,"role":"owner"}'),
 ('a5000000-0000-4000-8000-000000000003', 'device@example.invalid', 'test-verifier', true, now(), '{"provider":"email"}', '{"is_anonymous":false,"role":"owner"}'),
 ('a5000000-0000-4000-8000-000000000004', 'inactive@example.invalid', 'test-verifier', false, now(), '{"provider":"email"}', '{}'),
 ('a5000000-0000-4000-8000-000000000005', 'manager@example.invalid', 'test-verifier', false, now(), '{"provider":"email"}', '{}'),
 ('a5000000-0000-4000-8000-000000000006', 'oauth@example.invalid', 'test-verifier', false, now(), '{"provider":"google"}', '{"provider":"email"}'),
 ('a5000000-0000-4000-8000-000000000007', 'passwordless@example.invalid', '', false, now(), '{"provider":"email"}', '{}'),
 ('a5000000-0000-4000-8000-000000000008', 'enrolled-device@example.invalid', 'test-verifier', false, now(), '{"provider":"email"}', '{}');
insert into public.organizations(id, name) values ('a5100000-0000-4000-8000-000000000001', 'Existing onboarding fixture');
insert into public.stores(id, org_id, name) values ('a5200000-0000-4000-8000-000000000001', 'a5100000-0000-4000-8000-000000000001', 'Existing store');
insert into public.devices(org_id,store_id,auth_user_id,label) values ('a5100000-0000-4000-8000-000000000001','a5200000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000008','Identity boundary fixture');
insert into public.memberships(org_id, user_id, role, active) values
 ('a5100000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', 'owner', false),
 ('a5100000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000005', 'manager', true);
create temporary table onboarding_context(value jsonb);
grant select, insert on onboarding_context to authenticated;

select ok(has_function_privilege('authenticated', 'public.create_owner_workspace(text,text)', 'EXECUTE'), 'Authenticated accounts can request verified owner onboarding');
select ok(not has_function_privilege('anon', 'public.create_owner_workspace(text,text)', 'EXECUTE'), 'Unauthenticated clients cannot create workspaces');
select ok(not has_function_privilege('service_role', 'public.create_owner_workspace(text,text)', 'EXECUTE'), 'Browser onboarding does not need a service key');
select ok(not has_function_privilege('analysis_writer', 'public.create_owner_workspace(text,text)', 'EXECUTE'), 'Analysis writer cannot create workspaces');
select ok(has_function_privilege('authenticated', 'public.owner_setup_eligible()', 'EXECUTE'), 'Authenticated accounts can read their own setup eligibility');
select ok(not has_function_privilege('anon', 'public.owner_setup_eligible()', 'EXECUTE'), 'Unauthenticated clients cannot inspect owner setup eligibility');
select ok(not has_function_privilege('service_role', 'public.owner_setup_eligible()', 'EXECUTE'), 'Service API role cannot inspect setup eligibility');
select ok(not has_function_privilege('analysis_writer', 'public.owner_setup_eligible()', 'EXECUTE'), 'Analysis writer cannot inspect setup eligibility');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":false,"email":"owner@example.invalid","app_metadata":{"provider":"email"}}}'), '{}'::jsonb, 'Auth hook allows server-declared email business signup');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":false,"email":"owner@example.invalid","app_metadata":{"provider":"google"},"user_metadata":{"provider":"email","role":"owner"}}}')->'error'->>'http_code', '403', 'Writable metadata cannot authorize a different signup provider');
select is(public.senmiva_before_user_created('{"user":{"is_anonymous":false,"email":"owner@example.invalid","user_metadata":{"app_metadata":{"provider":"email"}}}}')->'error'->>'http_code', '403', 'Nested writable metadata cannot impersonate server app metadata');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000002","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Unconfirmed account is not eligible despite confirmation metadata');
select throws_ok($$select public.create_owner_workspace('Unauthorized business', 'Store')$$, '42501', null, 'Unconfirmed email cannot create a workspace despite metadata');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000003","is_anonymous":true}', true);
select is(public.owner_setup_eligible(), false, 'Anonymous JWT is not eligible for owner setup');
select throws_ok($$select public.create_owner_workspace('Device business', 'Store')$$, '42501', null, 'Anonymous device JWT cannot become an owner');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000003","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Auth record also prevents anonymous identity setup eligibility');
select throws_ok($$select public.create_owner_workspace('Device business', 'Store')$$, '42501', null, 'Auth user record also prevents anonymous-to-owner escalation');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000004","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Inactive membership cannot be mistaken for a new owner');
select throws_ok($$select public.create_owner_workspace('Another business', 'Store')$$, '42501', null, 'Inactive membership cannot bypass revoked staff access');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000005","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Existing manager is not eligible to create another workspace');
select throws_ok($$select public.create_owner_workspace('Another business', 'Store')$$, '42501', null, 'Existing manager cannot self-elevate into a new organization');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000006","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Unsupported provider cannot obtain setup eligibility');
select throws_ok($$select public.create_owner_workspace('OAuth business', 'Store')$$, '42501', null, 'Unsupported provider cannot obtain owner onboarding');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000007","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Passwordless identity is not eligible for password account setup');
select throws_ok($$select public.create_owner_workspace('Passwordless business', 'Store')$$, '42501', null, 'Email/password onboarding requires an actual password identity');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000008","is_anonymous":false}', true);
select is(public.owner_setup_eligible(), false, 'Existing device enrollment prevents owner setup even for a permanent Auth record');
select throws_ok($$select public.create_owner_workspace('Enrolled device business', 'Store')$$, '42501', null, 'Device enrollment cannot be repurposed as an owner identity');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000001"}', true);
select is(public.owner_setup_eligible(), false, 'Missing signed anonymous claim returns false rather than null or eligible');

select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000001","is_anonymous":false,"user_metadata":{"role":"owner","organization_id":"11111111-1111-4111-8111-111111111111"}}', true);
select is(public.owner_setup_eligible(), true, 'New confirmed email/password identity is eligible without metadata authority');
select throws_ok($$select public.create_owner_workspace(' ', 'Store')$$, '22023', null, 'Blank names do not provision partial records');
select throws_ok($$select public.create_owner_workspace(repeat('x',121), 'Store')$$, '22023', null, 'Oversized names do not provision partial records');
insert into onboarding_context select public.create_owner_workspace('  New owner business  ', '  First store  ');
select is(public.owner_setup_eligible(), false, 'Existing owner is no longer eligible after atomic workspace creation');
select is((select value->>'organization_name' from onboarding_context), 'New owner business', 'Verified owner creates a trimmed business workspace');
select is((select value->>'role' from onboarding_context), 'owner', 'Owner role is assigned inside the narrow RPC');
select is((select value->'stores'->0->>'currency' from onboarding_context), 'USD', 'First store uses the supported USD currency');
select is((select value->'stores'->0->>'location' from onboarding_context), '', 'Workspace response preserves staff-context contract');
select isnt((select value->>'organization_id' from onboarding_context), '11111111-1111-4111-8111-111111111111', 'Metadata cannot select an existing tenant');
select is((select count(*)::integer from public.organizations), 1, 'New owner reads only the new tenant through RLS');
select is((select count(*)::integer from public.memberships), 1, 'New owner has one normalized verified membership');
select is((select count(*)::integer from public.stores), 1, 'Exactly one normalized first store is created');
select is((select count(*)::integer from public.products), 0, 'Business signup does not insert fictional store products');
select is((select count(*)::integer from public.concern_ingredient_rules), 19, 'New business has the frozen 19-rule mock policy');
select is((select source from public.recommendation_policy_versions), 'mock-onboarding-v1', 'Policy provenance explicitly identifies mock onboarding');
select is((select status from public.recommendation_policy_versions), 'published', 'Mock policy is atomically published');
select is(public.create_owner_workspace('New owner business', 'First store'), (select value from onboarding_context), 'Identical retry returns the original workspace');
select is((select count(*)::integer from public.memberships), 1, 'Retry cannot create duplicate owner memberships');
select throws_ok($$select public.create_owner_workspace('Different business', 'First store')$$, '23505', null, 'Existing owner cannot create a second business by changing names');
select throws_ok($$insert into public.organizations(name) values('Direct bypass')$$, '42501', null, 'Owner cannot bypass onboarding with direct organization writes');
select throws_ok($$select public.read_store_catalog('a5200000-0000-4000-8000-000000000001')$$, '42501', null, 'New owner cannot browse another tenant store');
reset role;
select throws_ok($$update public.recommendation_policy_versions set source='operator-configured' where org_id=(select (value->>'organization_id')::uuid from onboarding_context)$$, '23514', null, 'Published mock provenance is immutable');
select throws_ok($$delete from public.concern_ingredient_rules where org_id=(select (value->>'organization_id')::uuid from onboarding_context)$$, '23514', null, 'Published mock policy rules are immutable');
select is((select count(*)::integer from public.organizations where name in ('Unauthorized business','Device business','Another business','OAuth business','Passwordless business')), 0, 'Rejected onboarding leaves no partial tenant records');

select * from finish();
rollback;
