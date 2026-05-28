-- Run this in the Supabase SQL Editor for this project.
-- It allows public student links to create sessions/read session details and
-- submit attendance, while attendance records remain instructor-only.

grant usage on schema public to anon, authenticated;
grant select on table public.training_sessions to anon, authenticated;
grant insert, update, delete on table public.training_sessions to authenticated;
revoke select, update, delete on table public.attendance_records from anon;
grant insert on table public.attendance_records to anon;
grant select, insert, update, delete on table public.attendance_records to authenticated;
grant select, insert, update, delete on table public.training_sessions to service_role;
grant select, insert, update, delete on table public.attendance_records to service_role;

alter table public.training_sessions
add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists training_sessions_owner_user_id_idx
on public.training_sessions (owner_user_id);

update public.training_sessions
set owner_user_id = (
  select id from auth.users order by created_at asc limit 1
)
where owner_user_id is null
  and exists (select 1 from auth.users);

alter table public.training_sessions enable row level security;
alter table public.attendance_records enable row level security;

drop policy if exists "Anyone can create training sessions"
on public.training_sessions;

drop policy if exists "Authenticated can create own training sessions"
on public.training_sessions;

create policy "Authenticated can create own training sessions"
on public.training_sessions
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "Anyone can read training sessions"
on public.training_sessions;

create policy "Anyone can read training sessions"
on public.training_sessions
for select
to anon
using (true);

drop policy if exists "Authenticated can read own training sessions"
on public.training_sessions;

create policy "Authenticated can read own training sessions"
on public.training_sessions
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "Authenticated can update own training sessions"
on public.training_sessions;

create policy "Authenticated can update own training sessions"
on public.training_sessions
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "Authenticated can delete own training sessions"
on public.training_sessions;

create policy "Authenticated can delete own training sessions"
on public.training_sessions
for delete
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "Anyone can create attendance records"
on public.attendance_records;

create policy "Anyone can create attendance records"
on public.attendance_records
for insert
to anon, authenticated
with check (training_session_id is not null);

drop policy if exists "Anyone can read attendance records"
on public.attendance_records;

drop policy if exists "Authenticated can read attendance records"
on public.attendance_records;

create policy "Authenticated can read attendance records"
on public.attendance_records
for select
to authenticated
using (
  exists (
    select 1
    from public.training_sessions
    where training_sessions.id = attendance_records.training_session_id
      and training_sessions.owner_user_id = auth.uid()
  )
);

drop policy if exists "Authenticated can update attendance records"
on public.attendance_records;

create policy "Authenticated can update attendance records"
on public.attendance_records
for update
to authenticated
using (
  exists (
    select 1
    from public.training_sessions
    where training_sessions.id = attendance_records.training_session_id
      and training_sessions.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.training_sessions
    where training_sessions.id = attendance_records.training_session_id
      and training_sessions.owner_user_id = auth.uid()
  )
);

drop policy if exists "Authenticated can delete attendance records"
on public.attendance_records;

create policy "Authenticated can delete attendance records"
on public.attendance_records
for delete
to authenticated
using (
  exists (
    select 1
    from public.training_sessions
    where training_sessions.id = attendance_records.training_session_id
      and training_sessions.owner_user_id = auth.uid()
  )
);

-- Storage policies for signature uploads.
-- Instructor trainer signatures are stored under:
-- signatures/{auth.uid()}/trainer-signatures/{file}.png
-- Student attendance signatures remain under:
-- signatures/attendance/{file}.png
drop policy if exists "Authenticated can upload own trainer signatures"
on storage.objects;

create policy "Authenticated can upload own trainer signatures"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'signatures'
);

drop policy if exists "Students can upload attendance signatures"
on storage.objects;

drop policy if exists "Anon can upload attendance signatures"
on storage.objects;

create policy "Students can upload attendance signatures"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'signatures'
  and (storage.foldername(name))[1] = 'attendance'
);

drop policy if exists "Students can upload attendance photos"
on storage.objects;

create policy "Students can upload attendance photos"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'attendance-photos'
);

drop policy if exists "Authenticated can delete attendance signature files"
on storage.objects;

create policy "Authenticated can delete attendance signature files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'signatures'
);

drop policy if exists "Authenticated can delete attendance photo files"
on storage.objects;

create policy "Authenticated can delete attendance photo files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'attendance-photos'
);
