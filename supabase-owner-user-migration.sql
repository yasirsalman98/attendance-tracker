-- Run this once in the Supabase SQL Editor before deploying the multi-email access changes.
-- It adds the owner columns used by the app and refreshes Supabase's API schema cache.

alter table public.quiz_templates
add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists quiz_templates_owner_user_id_idx
  on public.quiz_templates (owner_user_id);

update public.quiz_templates
set owner_user_id = (
  select id from auth.users where lower(email) = 'excourse7233@gmail.com' limit 1
)
where owner_user_id is null
  and exists (
    select 1 from auth.users where lower(email) = 'excourse7233@gmail.com'
  );

alter table public.training_sessions
add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists training_sessions_owner_user_id_idx
  on public.training_sessions (owner_user_id);

update public.training_sessions
set owner_user_id = (
  select id from auth.users where lower(email) = 'excourse7233@gmail.com' limit 1
)
where owner_user_id is null
  and exists (
    select 1 from auth.users where lower(email) = 'excourse7233@gmail.com'
  );

select pg_notify('pgrst', 'reload schema');
