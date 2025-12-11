-- Supabase schema for Threads prototype

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  root_path text unique not null,
  name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  started_at timestamptz not null,
  ended_at timestamptz,
  summary_generated boolean default false
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  timestamp timestamptz not null,
  event_type text not null,
  data jsonb not null
);

create table if not exists memory_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  session_id uuid references sessions(id),
  created_at timestamptz default now(),
  current_goal text,
  completed_work jsonb,
  open_issues jsonb,
  next_steps jsonb,
  decisions jsonb,
  summary_text text
);
