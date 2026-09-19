-- Keep archive ownership and game data intact; only replace authentication.
create table public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.archive_managers(id) on delete cascade,
  email text not null unique check(email = lower(trim(email)) and position('@' in email) > 1),
  google_subject text unique,
  auth_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table public.google_sessions (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references public.google_accounts(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index google_sessions_expiry on public.google_sessions(expires_at);
create table public.google_native_logins (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null check(secret_hash ~ '^[0-9a-f]{64}$'),
  client_name text not null check(client_name in ('desktop', 'cli')),
  account_id uuid references public.google_accounts(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create table public.google_oauth_flows (
  state_hash text primary key check(state_hash ~ '^[0-9a-f]{64}$'),
  verifier text not null,
  return_path text not null,
  native_id uuid references public.google_native_logins(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
alter table public.google_accounts enable row level security;
alter table public.google_sessions enable row level security;
alter table public.google_native_logins enable row level security;
alter table public.google_oauth_flows enable row level security;
revoke all on public.google_accounts, public.google_sessions, public.google_native_logins, public.google_oauth_flows from anon, authenticated;
grant all on public.google_accounts, public.google_sessions, public.google_native_logins, public.google_oauth_flows to service_role;

-- Called only after the Worker verifies a Google identity through Supabase Auth.
-- Binding the immutable subject on first login prevents a recycled email taking over.
create function public.bind_google_account(p_email text, p_subject text, p_user_id uuid)
returns setof public.google_accounts
language plpgsql security definer set search_path = '' as $$
declare account public.google_accounts;
begin
  if p_subject is null or length(p_subject) < 1 or p_user_id is null then return; end if;
  select * into account from public.google_accounts
    where email = lower(trim(p_email)) and revoked_at is null for update;
  if not found then return; end if;
  if account.google_subject is not null and account.google_subject <> p_subject then return; end if;
  if account.auth_user_id is not null and account.auth_user_id <> p_user_id then return; end if;
  update public.google_accounts set google_subject=p_subject, auth_user_id=p_user_id
    where id=account.id returning * into account;
  return next account;
end;
$$;
create function public.resolve_google_session(p_token_hash text)
returns table(manager_id uuid, email text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.manager_id, a.email, s.expires_at from public.google_sessions s
  join public.google_accounts a on a.id=s.account_id
  where s.token_hash=p_token_hash and s.expires_at>now() and a.revoked_at is null;
$$;
create function public.consume_google_flow(p_state_hash text)
returns setof public.google_oauth_flows
language sql security definer set search_path = '' as $$
  delete from public.google_oauth_flows where state_hash=p_state_hash and expires_at>now() returning *;
$$;
-- Issue and redeem once, in the same transaction, only to the initiating client.
create function public.claim_google_native_login(p_id uuid, p_secret_hash text, p_session_hash text)
returns table(email text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare pending public.google_native_logins; account public.google_accounts; expiry timestamptz;
begin
  select * into pending from public.google_native_logins
    where id=p_id and secret_hash=p_secret_hash and google_native_logins.expires_at>now()
    and account_id is not null for update;
  if not found then return; end if;
  select * into account from public.google_accounts where id=pending.account_id and revoked_at is null;
  if not found then return; end if;
  expiry=now()+interval '7 days';
  insert into public.google_sessions(token_hash,account_id,expires_at) values(p_session_hash,account.id,expiry);
  delete from public.google_native_logins where id=pending.id;
  return query select account.email,expiry;
end;
$$;
revoke all on function public.bind_google_account(text,text,uuid), public.resolve_google_session(text), public.consume_google_flow(text), public.claim_google_native_login(uuid,text,text) from public,anon,authenticated;
grant execute on function public.bind_google_account(text,text,uuid), public.resolve_google_session(text), public.consume_google_flow(text), public.claim_google_native_login(uuid,text,text) to service_role;

-- Retire invite authentication at the database boundary as well as HTTP.
update public.management_invites set revoked_at=coalesce(revoked_at,now());
delete from public.management_sessions;
create or replace function public.redeem_management_invite(p_code_hash text,p_session_hash text)
returns table(manager_id uuid,expires_at timestamptz)
language sql security definer set search_path = '' as $$ select null::uuid,null::timestamptz where false; $$;
create or replace function public.resolve_management_session(p_token_hash text)
returns table(manager_id uuid,expires_at timestamptz)
language sql stable security definer set search_path = '' as $$ select null::uuid,null::timestamptz where false; $$;
