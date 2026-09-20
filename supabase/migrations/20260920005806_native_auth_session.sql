-- App uses an OS-owned authentication session; legacy CLI/browser flows stay compatible.
alter table public.google_native_logins
  add column return_to_app boolean not null default false,
  add column completion_hash text check(completion_hash is null or completion_hash ~ '^[0-9a-f]{64}$'),
  add constraint native_app_client check(not return_to_app or client_name='desktop');
-- A redirected one-time completion proof replaces the human code comparison.
-- Possession of the initiation secret alone must not redeem an App login.
drop function public.claim_google_native_login(uuid,text,text);
create function public.claim_google_native_login(p_id uuid, p_secret_hash text, p_session_hash text, p_completion_hash text default null)
returns table(email text, expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare pending public.google_native_logins; account public.google_accounts; expiry timestamptz;
begin
  select * into pending from public.google_native_logins
    where id=p_id and secret_hash=p_secret_hash and google_native_logins.expires_at>now()
    and account_id is not null
    and (not return_to_app or (completion_hash is not null and completion_hash=p_completion_hash)) for update;
  if not found then return; end if;
  select * into account from public.google_accounts where id=pending.account_id and revoked_at is null;
  if not found then return; end if;
  expiry=now()+interval '7 days';
  insert into public.google_sessions(token_hash,account_id,expires_at) values(p_session_hash,account.id,expiry);
  delete from public.google_native_logins where id=pending.id;
  return query select account.email,expiry;
end;
$$;
revoke all on function public.claim_google_native_login(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.claim_google_native_login(uuid,text,text,text) to service_role;
