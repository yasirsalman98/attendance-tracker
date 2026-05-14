-- Run this in the Supabase SQL Editor for this project.
-- It allows the public anon key used by the frontend to create training sessions.

grant usage on schema public to anon, authenticated;
grant select, insert on table public.training_sessions to anon, authenticated;

alter table public.training_sessions enable row level security;

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
