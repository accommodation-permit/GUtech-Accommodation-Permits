-- Schema for the permit portal's Supabase storage.
-- Run this once in the Supabase SQL editor, before the first deploy.
--
-- The whole application state lives in a single row (id = 1) holding two JSON
-- columns. This is what makes the data independent from the Render service.

create table if not exists app_state (
  id         integer primary key,
  records    jsonb not null default '[]'::jsonb,
  students   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Optional: keep a short history of changes.
-- create table if not exists app_state_history (
--   id         bigserial primary key,
--   snapshot   jsonb not null,
--   created_at timestamptz not null default now()
-- );

-- The app connects with the service-role key, which bypasses RLS.
-- If you enable RLS, allow the service role explicitly:
-- alter table app_state enable row level security;

-- Seed the row so the first request does not have to create it.
insert into app_state (id, records, students)
values (1, '[]'::jsonb, '[]'::jsonb)
on conflict (id) do nothing;
