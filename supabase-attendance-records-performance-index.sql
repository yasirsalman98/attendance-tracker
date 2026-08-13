-- Supports the Admin Attendance Records class counts and per-class lazy loads.
-- This migration only adds an index; it does not alter or delete attendance data.
create index if not exists attendance_records_session_archive_signed_idx
  on public.attendance_records (training_session_id, archived_at, signed_at desc);

-- attendance_records.training_session_id is the foreign key to
-- training_sessions.id. Returns one row per class with only class metadata and
-- an aggregate student count. Student rows, photos, signatures, and quiz data
-- are intentionally not part of this function's result.
create or replace function public.get_attendance_session_summaries(
  p_owner_ids uuid[] default null,
  p_archived boolean default false,
  p_offset integer default 0,
  p_limit integer default 10
)
returns table (
  summary jsonb,
  student_count bigint,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with grouped as (
    select
      jsonb_build_object(
        'id', session.id,
        'course_name', session.course_name,
        'training_date', session.training_date,
        'trainer_name', session.trainer_name,
        'company_name', session.company_name,
        'training_location', session.training_location,
        'time_started', session.time_started,
        'time_stopped', session.time_stopped,
        'course_outline', session.course_outline,
        'trainer_signature_path', session.trainer_signature_path,
        'owner_user_id', session.owner_user_id,
        'created_at', session.created_at,
        'expires_at', session.expires_at,
        'archive_status', case when p_archived then 'archived' else 'active' end
      ) as summary,
      session.created_at as sort_created_at,
      count(distinct record.id)::bigint as student_count
    from public.training_sessions as session
    inner join public.attendance_records as record
      on record.training_session_id = session.id
      and (
        (p_archived and record.archived_at is not null)
        or (not p_archived and record.archived_at is null)
      )
    where p_owner_ids is null or session.owner_user_id = any(p_owner_ids)
    group by session.id
  )
  select
    grouped.summary,
    grouped.student_count,
    count(*) over ()::bigint as total_count
  from grouped
  order by grouped.sort_created_at desc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 100);
$$;

revoke execute on function public.get_attendance_session_summaries(
  uuid[], boolean, integer, integer
) from public, anon, authenticated;

grant execute on function public.get_attendance_session_summaries(
  uuid[], boolean, integer, integer
) to service_role;
