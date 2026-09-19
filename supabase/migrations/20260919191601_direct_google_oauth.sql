-- Additive rollout: the previous Worker can still finish existing logins.
alter table public.google_oauth_flows add column nonce text;
alter table public.google_oauth_flows add column redirect_uri text;

-- Worker supplies only a signature-verified Google subject and email.
-- service_role already owns the required privileges; no privilege escalation needed.
create function public.bind_google_account(p_email text, p_subject text)
returns setof public.google_accounts
language plpgsql security invoker set search_path = '' as $$
declare account public.google_accounts;
begin
  if p_subject is null or length(p_subject) < 1 or length(p_subject) > 255 then return; end if;
  select * into account from public.google_accounts
    where email = lower(trim(p_email)) and revoked_at is null for update;
  if not found then return; end if;
  if account.google_subject is not null and account.google_subject <> p_subject then return; end if;
  update public.google_accounts set google_subject=p_subject
    where id=account.id returning * into account;
  return next account;
end;
$$;
revoke all on function public.bind_google_account(text,text) from public,anon,authenticated;
grant execute on function public.bind_google_account(text,text) to service_role;
