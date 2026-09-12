-- Normalize the old representation without invalidating equivalent pending reviews.
-- Keep an explicitly recorded year; otherwise retain the year from the old date.
create function public.playtrace_normalize_release_year(value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare year integer;
begin
  if nullif(value->>'release_year','') is null and coalesce(value->>'release_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    year := substring(value->>'release_date' from 1 for 4)::integer;
    if year between 1950 and 2200 then value := jsonb_set(value,'{release_year}',to_jsonb(year)); end if;
  end if;
  return value - 'release_date';
end;
$$;
update public.games set data=public.playtrace_normalize_release_year(data)
  where data ? 'release_date';
update public.ai_jobs set result=jsonb_set(result,'{game}',public.playtrace_normalize_release_year(result->'game'))
  where jsonb_typeof(result->'game')='object' and (result->'game') ? 'release_date';
update public.ai_jobs j set result=jsonb_set(result,'{update_fields}',(
  select jsonb_agg(field order by first_position) from (
    select case when value='release_date' then 'release_year' else value end as field, min(position) as first_position
    from jsonb_array_elements_text(j.result->'update_fields') with ordinality as fields(value,position)
    group by case when value='release_date' then 'release_year' else value end
  ) normalized
)) where (result->'update_fields') ? 'release_date';
drop function public.playtrace_normalize_release_year(jsonb);
