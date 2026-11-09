-- Random Friends: isolated database foundation
-- Apply in the Supabase SQL Editor for the Color-balls project.
-- This migration creates ONLY rf_* objects. It does not alter cb_* tables.
-- Client roles receive no table access. A trusted server-side Edge Function
-- must be added before any matching or messaging is enabled.

begin;

create table if not exists public.rf_sessions (
  id uuid primary key,
  mode text not null check (mode in ('chat', 'call')),
  country_code text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

create table if not exists public.rf_queue (
  session_id uuid primary key references public.rf_sessions(id) on delete cascade,
  mode text not null check (mode in ('chat', 'call')),
  scope text not null check (scope in ('world', 'country')),
  country_code text,
  queued_at timestamptz not null default now(),
  constraint rf_queue_country_required
    check (scope <> 'country' or country_code is not null)
);

create index if not exists rf_queue_match_idx
  on public.rf_queue (mode, scope, country_code, queued_at);

create table if not exists public.rf_rooms (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('chat', 'call')),
  participant_a uuid not null references public.rf_sessions(id) on delete cascade,
  participant_b uuid not null references public.rf_sessions(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint rf_room_distinct_participants check (participant_a <> participant_b)
);

create index if not exists rf_rooms_participants_idx
  on public.rf_rooms (participant_a, participant_b, status);

create table if not exists public.rf_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rf_rooms(id) on delete cascade,
  sender_session_id uuid not null references public.rf_sessions(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists rf_messages_room_time_idx
  on public.rf_messages (room_id, created_at);

-- Defense in depth: even if schema defaults grant table privileges,
-- browser clients cannot read or mutate these records directly.
alter table public.rf_sessions enable row level security;
alter table public.rf_queue enable row level security;
alter table public.rf_rooms enable row level security;
alter table public.rf_messages enable row level security;

revoke all on table public.rf_sessions from anon, authenticated;
revoke all on table public.rf_queue from anon, authenticated;
revoke all on table public.rf_rooms from anon, authenticated;
revoke all on table public.rf_messages from anon, authenticated;

grant all on table public.rf_sessions to service_role;
grant all on table public.rf_queue to service_role;
grant all on table public.rf_rooms to service_role;
grant all on table public.rf_messages to service_role;
grant usage, select on sequence public.rf_messages_id_seq to service_role;

commit;
