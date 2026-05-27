create extension if not exists pgcrypto;

create table if not exists public.quiz_templates (
  id uuid primary key default gen_random_uuid(),
  course_name text not null,
  quiz_title text not null,
  quiz_description text,
  instructor_name text,
  class_date date,
  passing_score numeric not null default 80,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_template_id uuid not null references public.quiz_templates(id) on delete cascade,
  question_text text not null,
  question_type text not null default 'single_choice',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint quiz_questions_question_type_check
    check (question_type in ('single_choice', 'multiple_choice'))
);

create table if not exists public.quiz_answer_choices (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  choice_text text not null,
  is_correct boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_template_id uuid not null references public.quiz_templates(id) on delete cascade,
  student_name text not null,
  student_email text not null,
  company text,
  score integer not null default 0,
  total_questions integer not null default 0,
  percentage numeric not null default 0,
  passed boolean not null default false,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.quiz_attempt_answers (
  id uuid primary key default gen_random_uuid(),
  quiz_attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  selected_choice_ids jsonb not null default '[]'::jsonb,
  is_correct boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists quiz_questions_template_id_sort_idx
  on public.quiz_questions (quiz_template_id, sort_order);

create index if not exists quiz_answer_choices_question_id_sort_idx
  on public.quiz_answer_choices (question_id, sort_order);

create index if not exists quiz_attempts_template_id_submitted_idx
  on public.quiz_attempts (quiz_template_id, submitted_at desc);

create index if not exists quiz_attempt_answers_attempt_id_idx
  on public.quiz_attempt_answers (quiz_attempt_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_quiz_templates_updated_at on public.quiz_templates;
create trigger set_quiz_templates_updated_at
before update on public.quiz_templates
for each row
execute function public.set_updated_at();

alter table public.quiz_templates enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_answer_choices enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.quiz_attempt_answers enable row level security;

grant usage on schema public to anon, authenticated;

revoke insert, update, delete on public.quiz_templates from anon;
revoke insert, update, delete on public.quiz_questions from anon;
revoke insert, update, delete on public.quiz_answer_choices from anon;
revoke select, update, delete on public.quiz_attempts from anon;
revoke select, update, delete on public.quiz_attempt_answers from anon;

grant select on public.quiz_templates to anon;
grant select on public.quiz_questions to anon;
grant select on public.quiz_answer_choices to anon;
grant insert on public.quiz_attempts to anon;
grant insert on public.quiz_attempt_answers to anon;

grant select, insert, update, delete on public.quiz_templates to authenticated;
grant select, insert, update, delete on public.quiz_questions to authenticated;
grant select, insert, update, delete on public.quiz_answer_choices to authenticated;
grant select, insert, update, delete on public.quiz_attempts to authenticated;
grant select, insert, update, delete on public.quiz_attempt_answers to authenticated;

grant select, insert, update, delete on public.quiz_templates to service_role;
grant select, insert, update, delete on public.quiz_questions to service_role;
grant select, insert, update, delete on public.quiz_answer_choices to service_role;
grant select, insert, update, delete on public.quiz_attempts to service_role;
grant select, insert, update, delete on public.quiz_attempt_answers to service_role;

drop policy if exists "Anon can manage quiz templates" on public.quiz_templates;
drop policy if exists "Anon can read active quiz templates" on public.quiz_templates;
create policy "Anon can read active quiz templates"
on public.quiz_templates
for select
to anon
using (is_active = true);

drop policy if exists "Anon can manage quiz questions" on public.quiz_questions;
drop policy if exists "Anon can read quiz questions" on public.quiz_questions;
create policy "Anon can read quiz questions"
on public.quiz_questions
for select
to anon
using (true);

drop policy if exists "Anon can manage quiz answer choices" on public.quiz_answer_choices;
drop policy if exists "Anon can read quiz answer choices" on public.quiz_answer_choices;
create policy "Anon can read quiz answer choices"
on public.quiz_answer_choices
for select
to anon
using (true);

drop policy if exists "Anon can manage quiz attempts" on public.quiz_attempts;
drop policy if exists "Anon can create quiz attempts" on public.quiz_attempts;
create policy "Anon can create quiz attempts"
on public.quiz_attempts
for insert
to anon
with check (true);

drop policy if exists "Anon can manage quiz attempt answers" on public.quiz_attempt_answers;
drop policy if exists "Anon can create quiz attempt answers" on public.quiz_attempt_answers;
create policy "Anon can create quiz attempt answers"
on public.quiz_attempt_answers
for insert
to anon
with check (true);

drop policy if exists "Authenticated can manage quiz templates" on public.quiz_templates;
create policy "Authenticated can manage quiz templates"
on public.quiz_templates
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated can manage quiz questions" on public.quiz_questions;
create policy "Authenticated can manage quiz questions"
on public.quiz_questions
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated can manage quiz answer choices" on public.quiz_answer_choices;
create policy "Authenticated can manage quiz answer choices"
on public.quiz_answer_choices
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated can manage quiz attempts" on public.quiz_attempts;
create policy "Authenticated can manage quiz attempts"
on public.quiz_attempts
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated can manage quiz attempt answers" on public.quiz_attempt_answers;
create policy "Authenticated can manage quiz attempt answers"
on public.quiz_attempt_answers
for all
to authenticated
using (true)
with check (true);
