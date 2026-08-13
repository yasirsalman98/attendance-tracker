-- Production migration for historical-class provenance and transactional creation.
-- It does not update or delete existing attendance data.

alter table public.training_sessions
  add column if not exists is_historical_entry boolean not null default false,
  add column if not exists historical_source_session_id uuid references public.training_sessions(id) on delete set null,
  add column if not exists historical_entry_reason text,
  add column if not exists historical_created_by uuid references auth.users(id) on delete set null;

alter table public.attendance_records
  add column if not exists is_historical_entry boolean not null default false;

-- Historical roster rows preserve selected student evidence from the source class.
alter table public.attendance_records alter column signature_path drop not null;
alter table public.attendance_records alter column signed_at drop not null;
alter table public.attendance_records alter column latitude drop not null;
alter table public.attendance_records alter column longitude drop not null;
alter table public.training_sessions alter column trainer_signature_path drop not null;

create index if not exists training_sessions_historical_source_idx
  on public.training_sessions (historical_source_session_id)
  where is_historical_entry;
create index if not exists attendance_records_historical_entry_idx
  on public.attendance_records (training_session_id)
  where is_historical_entry;

create table if not exists public.historical_class_audit (
  id uuid primary key default gen_random_uuid(),
  historical_session_id uuid not null unique references public.training_sessions(id) on delete cascade,
  source_session_id uuid references public.training_sessions(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  late_entry_reason text not null,
  selected_student_count integer not null check (selected_student_count > 0),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

alter table public.historical_class_audit enable row level security;
revoke all on public.historical_class_audit from public, anon, authenticated;
grant all on public.historical_class_audit to service_role;

create or replace function public.create_historical_class(
  p_source_session_id uuid,
  p_class jsonb,
  p_selected_attendance_ids uuid[],
  p_reason text,
  p_created_by uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_session_id uuid;
  v_session_id uuid;
  v_selected_count integer;
  v_inserted_count integer;
begin
  select historical_session_id into v_existing_session_id
  from public.historical_class_audit
  where idempotency_key = p_idempotency_key;
  if v_existing_session_id is not null then
    return v_existing_session_id;
  end if;

  if p_source_session_id is null or not exists (
    select 1 from public.training_sessions
    where id = p_source_session_id
      and attendance_archived_at is null
  ) then
    raise exception 'Invalid source session';
  end if;
  if cardinality(p_selected_attendance_ids) = 0 then
    raise exception 'At least one student is required';
  end if;
  if cardinality(p_selected_attendance_ids) <> (
    select count(distinct selected_id)
    from unnest(p_selected_attendance_ids) as selected_id
  ) then
    raise exception 'Duplicate selected student IDs';
  end if;

  select count(*) into v_selected_count
  from public.attendance_records
  where training_session_id = p_source_session_id
    and archived_at is null
    and id = any(p_selected_attendance_ids);
  if v_selected_count <> cardinality(p_selected_attendance_ids) then
    raise exception 'Selected students do not belong to source session';
  end if;

  insert into public.training_sessions (
    course_name, training_date, time_started, time_stopped, company_name,
    training_location, trainer_name, trainer_signature_path,
    course_outline, owner_user_id, is_historical_entry,
    historical_source_session_id, historical_entry_reason, historical_created_by
  ) values (
    p_class->>'course_name', (p_class->>'training_date')::date,
    (p_class->>'time_started')::timestamptz, (p_class->>'time_stopped')::timestamptz,
    p_class->>'company_name', p_class->>'training_location', p_class->>'trainer_name',
    p_class->>'trainer_signature_path', nullif(p_class->>'course_outline', ''), p_created_by, true,
    p_source_session_id, p_reason, p_created_by
  ) returning id into v_session_id;

  insert into public.attendance_records (
    student_name, student_email, company,
    training_session_id, signature_path, photo_path,
    latitude, longitude, location_accuracy, signed_at, is_suspicious,
    is_historical_entry
  )
  select
    source.student_name, source.student_email, source.company,
    v_session_id, source.signature_path, source.photo_path,
    null, null, null, source.signed_at, false,
    true
  from public.attendance_records as source
  where source.training_session_id = p_source_session_id
    and source.archived_at is null
    and source.id = any(p_selected_attendance_ids);
  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> v_selected_count then
    raise exception 'Historical roster insert count mismatch';
  end if;

  insert into public.historical_class_audit (
    historical_session_id, source_session_id, created_by, late_entry_reason,
    selected_student_count, idempotency_key
  ) values (
    v_session_id, p_source_session_id, p_created_by, p_reason,
    v_selected_count, p_idempotency_key
  );
  return v_session_id;
end;
$$;

revoke execute on function public.create_historical_class(uuid, jsonb, uuid[], text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_historical_class(uuid, jsonb, uuid[], text, uuid, text)
  to service_role;
