-- Separates individual-student attendance archives from whole-class archives.
-- This migration is non-destructive: it adds metadata, indexes, queue/audit
-- tables, backfills existing archive intent, and exposes service-role RPCs.

alter table public.attendance_records
  add column if not exists archive_type text;

alter table public.attendance_records
  drop constraint if exists attendance_records_archive_type_check;

alter table public.attendance_records
  add constraint attendance_records_archive_type_check
  check (archive_type is null or archive_type in ('student', 'class'));

alter table public.training_sessions
  add column if not exists attendance_archive_type text,
  add column if not exists attendance_archived_at timestamptz,
  add column if not exists attendance_archived_by uuid,
  add column if not exists attendance_archive_delete_after timestamptz;

alter table public.training_sessions
  drop constraint if exists training_sessions_attendance_archive_type_check;

alter table public.training_sessions
  add constraint training_sessions_attendance_archive_type_check
  check (
    attendance_archive_type is null
    or attendance_archive_type = 'class'
  );

-- Preserve legacy student archives. In particular, deleted_student is never
-- inferred to mean a whole-class archive merely because the UI grouped it.
update public.attendance_records
set archive_type = case
  when archive_source = 'archived_class' then 'class'
  when archive_source = 'deleted_student' then 'student'
  else archive_type
end
where archived_at is not null
  and archive_type is null
  and archive_source in ('archived_class', 'deleted_student');

-- A legacy archived_class source is positive evidence that Archive Class was
-- selected. Backfill the session-level class deadline from those rows.
with legacy_class_archives as (
  select
    training_session_id,
    min(archived_at) as archived_at,
    max(archive_delete_after) as archive_delete_after,
    (array_agg(archived_by order by archived_at desc)
      filter (where archived_by is not null))[1] as archived_by
  from public.attendance_records
  where training_session_id is not null
    and archived_at is not null
    and archive_source = 'archived_class'
  group by training_session_id
)
update public.training_sessions as session
set
  attendance_archive_type = 'class',
  attendance_archived_at = legacy.archived_at,
  attendance_archived_by = legacy.archived_by,
  attendance_archive_delete_after = legacy.archive_delete_after
from legacy_class_archives as legacy
where session.id = legacy.training_session_id
  and session.attendance_archive_type is null;

create index if not exists attendance_records_archive_type_deadline_idx
  on public.attendance_records (archive_type, archive_delete_after)
  where archived_at is not null;

create index if not exists training_sessions_attendance_archive_deadline_idx
  on public.training_sessions (
    attendance_archive_type,
    attendance_archive_delete_after
  )
  where attendance_archived_at is not null;

create table if not exists public.attendance_archive_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  archive_type text not null check (archive_type in ('student', 'class')),
  target_id uuid not null,
  delete_after timestamptz not null,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'retry', 'completed', 'skipped', 'partial_failed')
  ),
  attempts integer not null default 0,
  run_id uuid,
  locked_at timestamptz,
  storage_plan jsonb not null default '[]'::jsonb,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (archive_type, target_id)
);

create index if not exists attendance_archive_cleanup_queue_work_idx
  on public.attendance_archive_cleanup_queue (status, delete_after, locked_at);

create table if not exists public.attendance_archive_cleanup_audit (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  queue_id uuid,
  archive_type text not null check (archive_type in ('student', 'class')),
  target_id uuid not null,
  outcome text not null check (
    outcome in ('dry_run', 'success', 'skipped', 'partial_failed', 'retried')
  ),
  database_counts jsonb not null default '{}'::jsonb,
  storage_counts jsonb not null default '{}'::jsonb,
  error_code text,
  occurred_at timestamptz not null default now()
);

alter table public.attendance_archive_cleanup_queue enable row level security;
alter table public.attendance_archive_cleanup_audit enable row level security;
revoke all on public.attendance_archive_cleanup_queue from public, anon, authenticated;
revoke all on public.attendance_archive_cleanup_audit from public, anon, authenticated;
grant all on public.attendance_archive_cleanup_queue to service_role;
grant all on public.attendance_archive_cleanup_audit to service_role;
grant usage, select on sequence public.attendance_archive_cleanup_audit_id_seq to service_role;

create or replace function public.archive_attendance_class(
  p_session_id uuid,
  p_archived_by uuid
)
returns table (archived_count bigint, archived_at timestamptz, delete_after timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_archived_at timestamptz := now();
  v_delete_after timestamptz := v_archived_at + interval '30 days';
  v_count bigint;
begin
  update public.training_sessions
  set
    attendance_archive_type = 'class',
    attendance_archived_at = v_archived_at,
    attendance_archived_by = p_archived_by,
    attendance_archive_delete_after = v_delete_after
  where id = p_session_id
    and attendance_archived_at is null;

  if not found then
    raise exception 'Training session is missing or already archived';
  end if;

  update public.attendance_records
  set
    archived_at = v_archived_at,
    archived_by = p_archived_by,
    archive_delete_after = v_delete_after,
    archive_source = 'archived_class',
    archive_type = 'class'
  where training_session_id = p_session_id;

  get diagnostics v_count = row_count;
  return query select v_count, v_archived_at, v_delete_after;
end;
$$;

create or replace function public.restore_attendance_class(p_session_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
begin
  update public.training_sessions
  set
    attendance_archive_type = null,
    attendance_archived_at = null,
    attendance_archived_by = null,
    attendance_archive_delete_after = null
  where id = p_session_id
    and attendance_archive_type = 'class'
    and attendance_archived_at is not null;

  if not found then
    return 0;
  end if;

  update public.attendance_records
  set
    archived_at = null,
    archived_by = null,
    archive_delete_after = null,
    archive_source = null,
    archive_type = null
  where training_session_id = p_session_id
    and archive_type = 'class'
    and archived_at is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.restore_attendance_student(p_record_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.attendance_records
  set
    archived_at = null,
    archived_by = null,
    archive_delete_after = null,
    archive_source = null,
    archive_type = null
  where id = p_record_id
    and archived_at is not null
    and (
      archive_type = 'student'
      or (archive_type is null and archive_source = 'deleted_student')
    );
  return found;
end;
$$;

revoke execute on function public.archive_attendance_class(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.restore_attendance_class(uuid) from public, anon, authenticated;
revoke execute on function public.restore_attendance_student(uuid) from public, anon, authenticated;
grant execute on function public.archive_attendance_class(uuid, uuid) to service_role;
grant execute on function public.restore_attendance_class(uuid) to service_role;
grant execute on function public.restore_attendance_student(uuid) to service_role;

create or replace function public.get_attendance_student_archives(
  p_owner_ids uuid[] default null,
  p_offset integer default 0,
  p_limit integer default 10
)
returns table (summary jsonb, total_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    jsonb_build_object(
      'id', record.id,
      'student_name', record.student_name,
      'training_session_id', record.training_session_id,
      'class_name', session.course_name,
      'archived_at', record.archived_at,
      'archive_delete_after', record.archive_delete_after,
      'archive_type', 'student'
    ),
    count(*) over ()::bigint
  from public.attendance_records as record
  left join public.training_sessions as session
    on session.id = record.training_session_id
  where record.archived_at is not null
    and (
      record.archive_type = 'student'
      or (record.archive_type is null and record.archive_source = 'deleted_student')
    )
    and (p_owner_ids is null or session.owner_user_id = any(p_owner_ids))
  order by record.archived_at desc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.get_attendance_class_archives(
  p_owner_ids uuid[] default null,
  p_offset integer default 0,
  p_limit integer default 10
)
returns table (summary jsonb, student_count bigint, total_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
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
      'archive_type', 'class',
      'archived_at', session.attendance_archived_at,
      'archive_delete_after', session.attendance_archive_delete_after
    ),
    count(distinct record.id)::bigint,
    count(*) over ()::bigint
  from public.training_sessions as session
  left join public.attendance_records as record
    on record.training_session_id = session.id
    and record.archive_type = 'class'
  where session.attendance_archive_type = 'class'
    and session.attendance_archived_at is not null
    and (p_owner_ids is null or session.owner_user_id = any(p_owner_ids))
  group by session.id
  order by session.attendance_archived_at desc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 100);
$$;

revoke execute on function public.get_attendance_student_archives(uuid[], integer, integer) from public, anon, authenticated;
revoke execute on function public.get_attendance_class_archives(uuid[], integer, integer) from public, anon, authenticated;
grant execute on function public.get_attendance_student_archives(uuid[], integer, integer) to service_role;
grant execute on function public.get_attendance_class_archives(uuid[], integer, integer) to service_role;
