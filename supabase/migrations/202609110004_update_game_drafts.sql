-- Link an AI update to a persistent game identity and the version that was reviewed.
-- Restrict hard deletion so removing a target can never turn an update into an insert.
alter table public.ai_jobs
  add column target_game_id uuid references public.games(id),
  add column target_version integer,
  add constraint ai_job_target_version check (
    (target_game_id is null and target_version is null) or
    (target_game_id is not null and target_version is not null and target_version > 0 and kind = 'game')
  );

create or replace function public.save_ai_draft(p_manager_id uuid,p_job_id uuid,p_data jsonb,p_published boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare job public.ai_jobs; entity uuid;
begin
  if not exists(select 1 from public.archive_managers where id=p_manager_id) then raise exception 'not authorized'; end if;
  select * into job from public.ai_jobs where id=p_job_id and owner_id=p_manager_id for update;
  if not found then raise exception 'job not found'; end if;
  if job.status='saved' then return job.saved_entity_id; end if;
  if job.status<>'ready' then raise exception 'draft is not ready'; end if;
  if job.kind='game' then
    if job.target_game_id is not null then
      update public.games set data=p_data, is_published=p_published, version=version+1, updated_at=now()
        where id=job.target_game_id and version=job.target_version and deleted_at is null
        returning id into entity;
      if not found then raise exception using errcode='40001', message='game changed or removed'; end if;
    else
      insert into public.games(data,is_published) values(p_data,p_published) returning id into entity;
    end if;
  else
    insert into public.themes(data,is_published) values(p_data,p_published) returning id into entity;
  end if;
  update public.ai_jobs set status='saved', progress=case when target_game_id is null then '已保存' else '原游戏已更新' end,
    saved_entity_id=entity, updated_at=now() where id=p_job_id;
  return entity;
end;
$$;
revoke all on function public.save_ai_draft(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_ai_draft(uuid,uuid,jsonb,boolean) to service_role;
