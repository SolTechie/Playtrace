-- Managers are archive identities, independent of Supabase Auth accounts.
create table public.archive_managers (
  id uuid primary key default gen_random_uuid(),
  name text not null default '档案管理员',
  created_at timestamptz not null default now()
);
insert into public.archive_managers(id) select user_id from public.admin_users;
insert into public.archive_managers(name) select '档案管理员' where not exists(select 1 from public.archive_managers);
alter table public.archive_managers enable row level security;
revoke all on public.archive_managers from anon, authenticated;
grant all on public.archive_managers to service_role;

alter table public.agent_devices drop constraint agent_devices_owner_id_fkey;
alter table public.agent_devices add foreign key(owner_id) references public.archive_managers(id) on delete cascade;
alter table public.ai_jobs drop constraint ai_jobs_owner_id_fkey;
alter table public.ai_jobs add foreign key(owner_id) references public.archive_managers(id) on delete cascade;

create table public.management_invites (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.archive_managers(id) on delete cascade,
  label text not null,
  code_hash text not null unique check(code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create table public.management_sessions (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  invite_id uuid not null references public.management_invites(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index management_sessions_expiry on public.management_sessions(expires_at);
create table public.invite_attempts (
  client_hash text primary key,
  window_started_at timestamptz not null,
  attempts integer not null
);
create index invite_attempts_expiry on public.invite_attempts(window_started_at);
alter table public.management_invites enable row level security;
alter table public.management_sessions enable row level security;
alter table public.invite_attempts enable row level security;
revoke all on public.management_invites,public.management_sessions,public.invite_attempts from anon,authenticated;
grant all on public.management_invites,public.management_sessions,public.invite_attempts to service_role;

-- Atomic across Worker instances; 10 attempts per client in each 15-minute window.
create function public.consume_invite_attempt(p_client_hash text)
returns table(allowed boolean,retry_after integer)
language plpgsql security definer set search_path = '' as $$
declare attempt public.invite_attempts;
begin
  delete from public.invite_attempts where window_started_at < now()-interval '1 day';
  insert into public.invite_attempts(client_hash,window_started_at,attempts) values(p_client_hash,now(),1)
  on conflict(client_hash) do update set
    window_started_at=case when invite_attempts.window_started_at <= now()-interval '15 minutes' then now() else invite_attempts.window_started_at end,
    attempts=case when invite_attempts.window_started_at <= now()-interval '15 minutes' then 1 else least(invite_attempts.attempts+1,100000) end
  returning * into attempt;
  return query select attempt.attempts<=10,greatest(1,ceil(extract(epoch from (attempt.window_started_at+interval '15 minutes'-now())))::integer);
end;
$$;

create function public.redeem_management_invite(p_code_hash text,p_session_hash text)
returns table(manager_id uuid,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare invitation public.management_invites; expiry timestamptz;
begin
  select * into invitation from public.management_invites where code_hash=p_code_hash
    and revoked_at is null and (management_invites.expires_at is null or management_invites.expires_at>now()) for update;
  if not found then return; end if;
  expiry=least(now()+interval '7 days',coalesce(invitation.expires_at,now()+interval '7 days'));
  delete from public.management_sessions where management_sessions.expires_at<now()-interval '1 day';
  insert into public.management_sessions(token_hash,invite_id,expires_at) values(p_session_hash,invitation.id,expiry);
  return query select invitation.manager_id,expiry;
end;
$$;

create function public.resolve_management_session(p_token_hash text)
returns table(manager_id uuid,expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.manager_id,s.expires_at from public.management_sessions s join public.management_invites i on i.id=s.invite_id
  where s.token_hash=p_token_hash and s.expires_at>now() and i.revoked_at is null and (i.expires_at is null or i.expires_at>now());
$$;
revoke all on function public.consume_invite_attempt(text),public.redeem_management_invite(text,text),public.resolve_management_session(text) from public,anon,authenticated;
grant execute on function public.consume_invite_attempt(text),public.redeem_management_invite(text,text),public.resolve_management_session(text) to service_role;

-- All privileged access now passes through the Worker's checked session.
drop policy games_admin_read on public.games;
drop policy games_admin_insert on public.games;
drop policy games_admin_update on public.games;
drop policy themes_admin_read on public.themes;
drop policy themes_admin_insert on public.themes;
drop policy themes_admin_update on public.themes;
revoke insert,update on public.games,public.themes from authenticated;
drop policy jobs_owner_read on public.ai_jobs;
drop policy events_owner_read on public.ai_job_events;
revoke all on public.ai_jobs,public.ai_job_events from authenticated;
drop policy images_admin_insert on storage.objects;
drop policy images_admin_update on storage.objects;
drop policy images_admin_delete on storage.objects;
drop function public.save_ai_draft(uuid,jsonb,boolean);
drop function public.is_admin();
drop table public.admin_users;

create or replace function public.claim_ai_job(p_device_id uuid) returns setof public.ai_jobs
language plpgsql security definer set search_path = '' as $$
declare chosen public.ai_jobs; owner uuid;
begin
  select owner_id into owner from public.agent_devices where id=p_device_id and revoked_at is null;
  if owner is null or not exists(select 1 from public.archive_managers where id=owner) then return; end if;
  update public.ai_jobs set status='failed', error='任务多次中断，请检查电脑连接后重试', progress='任务已中断', updated_at=now()
    where owner_id=owner and status='running' and lease_until<now() and attempts>=3;
  select * into chosen from public.ai_jobs
    where owner_id=owner and (status='queued' or (status='running' and lease_until<now() and attempts<3))
    order by created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.ai_jobs set status='running', progress='已连接电脑，正在启动 AI', device_id=p_device_id,
    attempts=attempts+1, lease_token=gen_random_uuid(), lease_until=now()+interval '2 minutes', updated_at=now()
    where id=chosen.id returning * into chosen;
  return next chosen;
end;
$$;

create function public.save_ai_draft(p_manager_id uuid,p_job_id uuid,p_data jsonb,p_published boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare job public.ai_jobs; entity uuid;
begin
  if not exists(select 1 from public.archive_managers where id=p_manager_id) then raise exception 'not authorized'; end if;
  select * into job from public.ai_jobs where id=p_job_id and owner_id=p_manager_id for update;
  if not found then raise exception 'job not found'; end if;
  if job.status='saved' then return job.saved_entity_id; end if;
  if job.status<>'ready' then raise exception 'draft is not ready'; end if;
  if job.kind='game' then
    insert into public.games(data,is_published) values(p_data,p_published) returning id into entity;
  else
    insert into public.themes(data,is_published) values(p_data,p_published) returning id into entity;
  end if;
  update public.ai_jobs set status='saved', progress='已保存', saved_entity_id=entity, updated_at=now() where id=p_job_id;
  return entity;
end;
$$;
revoke all on function public.save_ai_draft(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_ai_draft(uuid,uuid,jsonb,boolean) to service_role;
-- Explicit privileges also cover projects with restrictive default grants.
grant all on public.games,public.themes,public.agent_devices,public.ai_jobs,public.ai_job_events to service_role;
grant usage,select on sequence public.ai_job_events_id_seq to service_role;
