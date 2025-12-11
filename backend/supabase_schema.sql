-- Supabase schema for Threads prototype

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  root_path text unique not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  summary_generated boolean not null default false
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  timestamp timestamptz not null,
  event_type text not null,
  data jsonb not null default '{}'::jsonb
);

create table if not exists memory_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  current_goal text,
  completed_work jsonb,
  open_issues jsonb,
  next_steps jsonb,
  decisions jsonb,
  summary_text text
);
