-- One-time cleanup: keep only classes where course_name is exactly "Task"
-- after trimming spaces and ignoring letter case.
--
-- This removes:
-- - attendance records for deleted classes
-- - deleted classes from public.training_sessions
-- - signature storage object rows for deleted classes
-- - attendance photo storage object rows for deleted classes
--
-- Run the preview SELECT first. If it looks right, run the DELETE block.

-- PREVIEW: classes that will be deleted.
select
  id,
  course_name,
  training_date,
  trainer_name,
  owner_user_id,
  trainer_signature_path
from public.training_sessions
where lower(trim(coalesce(course_name, ''))) <> 'task'
order by training_date desc, created_at desc;

-- PREVIEW: classes that will be kept.
select
  id,
  course_name,
  training_date,
  trainer_name,
  owner_user_id,
  trainer_signature_path
from public.training_sessions
where lower(trim(coalesce(course_name, ''))) = 'task'
order by training_date desc, created_at desc;

-- DELETE BLOCK.
begin;

create temporary table cleanup_deleted_sessions on commit drop as
select
  id,
  trainer_signature_path
from public.training_sessions
where lower(trim(coalesce(course_name, ''))) <> 'task';

create temporary table cleanup_deleted_attendance on commit drop as
select
  id,
  signature_path,
  photo_path
from public.attendance_records
where training_session_id in (
  select id from cleanup_deleted_sessions
);

delete from storage.objects
where bucket_id = 'signatures'
  and name in (
    select trainer_signature_path
    from cleanup_deleted_sessions
    where trainer_signature_path is not null
    union
    select signature_path
    from cleanup_deleted_attendance
    where signature_path is not null
  );

delete from storage.objects
where bucket_id = 'attendance-photos'
  and name in (
    select photo_path
    from cleanup_deleted_attendance
    where photo_path is not null
  );

delete from public.attendance_records
where id in (
  select id from cleanup_deleted_attendance
);

delete from public.training_sessions
where id in (
  select id from cleanup_deleted_sessions
);

commit;

select pg_notify('pgrst', 'reload schema');

-- VERIFY: only Task classes should remain.
select
  id,
  course_name,
  training_date,
  trainer_name,
  owner_user_id
from public.training_sessions
order by training_date desc, created_at desc;
