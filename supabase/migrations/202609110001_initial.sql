-- Run once in your Supabase SQL editor, or apply with the Supabase CLI.
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create table public.games (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null check (jsonb_typeof(data) = 'object' and length(data->>'title') > 0),
  is_published boolean not null default true,
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.themes (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null check (jsonb_typeof(data) = 'object' and length(data->>'title') > 0),
  is_published boolean not null default true,
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.games enable row level security;
alter table public.themes enable row level security;
revoke all on public.games, public.themes from anon, authenticated;
grant select on public.games, public.themes to anon, authenticated;
grant insert, update on public.games, public.themes to authenticated;
create policy games_public_read on public.games for select to anon, authenticated using (is_published and deleted_at is null);
create policy games_admin_read on public.games for select to authenticated using (public.is_admin());
create policy games_admin_insert on public.games for insert to authenticated with check (public.is_admin());
create policy games_admin_update on public.games for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy themes_public_read on public.themes for select to anon, authenticated using (is_published and deleted_at is null);
create policy themes_admin_read on public.themes for select to authenticated using (public.is_admin());
create policy themes_admin_insert on public.themes for insert to authenticated with check (public.is_admin());
create policy themes_admin_update on public.themes for update to authenticated using (public.is_admin()) with check (public.is_admin());

create table public.agent_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.agent_devices enable row level security;
revoke all on public.agent_devices from anon, authenticated;

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  kind text not null check (kind in ('game', 'theme')),
  prompt text not null check (length(prompt) between 2 and 4000),
  status text not null default 'queued' check (status in ('queued','running','needs_input','ready','saved','failed','cancelled')),
  progress text not null default '等待电脑领取任务',
  result jsonb,
  error text,
  attempts integer not null default 0,
  device_id uuid references public.agent_devices(id),
  lease_token uuid,
  lease_until timestamptz,
  saved_entity_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, request_id)
);
create index ai_jobs_pending on public.ai_jobs(owner_id, created_at) where status in ('queued','running');
alter table public.ai_jobs enable row level security;
revoke all on public.ai_jobs from anon, authenticated;
grant select on public.ai_jobs to authenticated;
create policy jobs_owner_read on public.ai_jobs for select to authenticated using (owner_id = auth.uid() and public.is_admin());

create table public.ai_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.ai_jobs(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);
alter table public.ai_job_events enable row level security;
revoke all on public.ai_job_events from anon, authenticated;
grant select on public.ai_job_events to authenticated;
create policy events_owner_read on public.ai_job_events for select to authenticated using (
  exists (select 1 from public.ai_jobs where id=job_id and owner_id=auth.uid()) and public.is_admin()
);

-- Durable task claiming. A lease prevents two devices from running the same job.
create or replace function public.claim_ai_job(p_device_id uuid) returns setof public.ai_jobs
language plpgsql security definer set search_path = '' as $$
declare chosen public.ai_jobs; owner uuid;
begin
  select owner_id into owner from public.agent_devices where id=p_device_id and revoked_at is null;
  if owner is null or not exists(select 1 from public.admin_users where user_id=owner) then return; end if;
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
revoke all on function public.claim_ai_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_job(uuid) to service_role;

-- Saving a finished draft and marking its job happens in the same transaction.
create or replace function public.save_ai_draft(p_job_id uuid, p_data jsonb, p_published boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare job public.ai_jobs; entity uuid;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select * into job from public.ai_jobs where id=p_job_id and owner_id=auth.uid() for update;
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
revoke all on function public.save_ai_draft(uuid,jsonb,boolean) from public, anon;
grant execute on function public.save_ai_draft(uuid,jsonb,boolean) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('game-images','game-images',false,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
create policy images_admin_insert on storage.objects for insert to authenticated with check (bucket_id='game-images' and public.is_admin());
create policy images_admin_update on storage.objects for update to authenticated using (bucket_id='game-images' and public.is_admin()) with check (bucket_id='game-images' and public.is_admin());
create policy images_admin_delete on storage.objects for delete to authenticated using (bucket_id='game-images' and public.is_admin());

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ai_jobs') then
    alter publication supabase_realtime add table public.ai_jobs;
  end if;
end $$;
