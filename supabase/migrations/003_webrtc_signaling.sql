-- Random Friends: WebRTC signaling records for private call testing.
-- Apply this migration in the Supabase SQL Editor.
-- This adds only rf_* objects and does not alter Color-balls cb_* tables.

begin;

create table if not exists public.rf_signals (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rf_rooms(id) on delete cascade,
  sender_session_id uuid not null references public.rf_sessions(id) on delete cascade,
  kind text not null check (kind in ('offer', 'answer', 'ice-candidate')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists rf_signals_room_id_idx
  on public.rf_signals (room_id, id);

alter table public.rf_signals enable row level security;
revoke all on table public.rf_signals from anon, authenticated;
grant all on table public.rf_signals to service_role;
grant usage, select on sequence public.rf_signals_id_seq to service_role;

commit;
