-- Safe additive migration: connects published quizzes and quiz attempts
-- to the selected attendance session/class.
-- No existing quiz results or attendance records are deleted or rewritten.

alter table public.quiz_templates
add column if not exists training_session_id uuid references public.training_sessions(id) on delete set null;

alter table public.quiz_attempts
add column if not exists training_session_id uuid references public.training_sessions(id) on delete set null;

alter table public.quiz_attempts
add column if not exists attendance_record_id uuid references public.attendance_records(id) on delete set null;

alter table public.quiz_attempts
add column if not exists completed_at timestamptz;

create index if not exists quiz_templates_training_session_id_idx
  on public.quiz_templates (training_session_id);

create index if not exists quiz_attempts_training_session_id_idx
  on public.quiz_attempts (training_session_id);

create index if not exists quiz_attempts_attendance_record_id_idx
  on public.quiz_attempts (attendance_record_id);

select pg_notify('pgrst', 'reload schema');
