-- Apply after deploying the direct Google Worker. Preserve account IDs, subject
-- bindings and existing Playtrace sessions; remove the dependency on auth.users.
drop function public.bind_google_account(text,text,uuid);
alter table public.google_accounts drop column auth_user_id;
-- Pending requests from the retired provider cannot be resumed on the direct flow.
delete from public.google_oauth_flows where nonce is null or redirect_uri is null;
alter table public.google_oauth_flows alter column nonce set not null;
alter table public.google_oauth_flows alter column redirect_uri set not null;
