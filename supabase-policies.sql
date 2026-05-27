-- Run this in the Supabase SQL Editor for this project.
-- It allows public student links to create sessions/read session details and
-- submit attendance, while attendance records remain instructor-only.

grant usage on schema public to anon, authenticated;
grant select, insert on table public.training_sessions to anon, authenticated;
revoke select, update, delete on table public.attendance_records from anon;
grant insert on table public.attendance_records to anon;
grant select, insert, update, delete on table public.attendance_records to authenticated;

alter table public.training_sessions enable row level security;
alter table public.attendance_records enable row level security;

drop policy if exists "Anyone can create training sessions"
on public.training_sessions;

create policy "Anyone can create training sessions"
on public.training_sessions
for insert
to anon, authenticated
with check (true);

drop policy if exists "Anyone can read training sessions"
on public.training_sessions;

create policy "Anyone can read training sessions"
on public.training_sessions
for select
to anon, authenticated
using (true);

drop policy if exists "Anyone can create attendance records"
on public.attendance_records;

create policy "Anyone can create attendance records"
on public.attendance_records
for insert
to anon, authenticated
with check (true);

drop policy if exists "Anyone can read attendance records"
on public.attendance_records;

drop policy if exists "Authenticated can read attendance records"
on public.attendance_records;

create policy "Authenticated can read attendance records"
on public.attendance_records
for select
to authenticated
using (true);

drop policy if exists "Authenticated can update attendance records"
on public.attendance_records;

create policy "Authenticated can update attendance records"
on public.attendance_records
for update
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated can delete attendance records"
on public.attendance_records;

create policy "Authenticated can delete attendance records"
on public.attendance_records
for delete
to authenticated
using (true);
