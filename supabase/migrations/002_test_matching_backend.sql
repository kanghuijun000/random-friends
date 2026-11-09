-- Random Friends: server-only matching support.
-- Apply AFTER 001_random_friends.sql.
-- All client access remains revoked; only the Edge Function service role uses these objects.

begin;

alter table public.rf_sessions
  add column if not exists scope text not null default 'world'
    check (scope in ('world', 'country'));

alter table public.rf_sessions
  add column if not exists token_hash text unique;

alter table public.rf_queue
  add column if not exists excluded_session_id uuid
    references public.rf_sessions(id) on delete set null;

create or replace function public.rf_match_session(p_session_id uuid)
returns table(room_id uuid, partner_session_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  own_queue public.rf_queue%rowtype;
  partner_id uuid;
  new_room_id uuid;
begin
  -- Serialize matching transactions so a session cannot enter two rooms.
  perform pg_advisory_xact_lock(72819421);

  delete from public.rf_sessions where expires_at <= now();

  select * into own_queue
  from public.rf_queue
  where session_id = p_session_id
  for update;

  if not found then
    return;
  end if;

  select q.session_id into partner_id
  from public.rf_queue q
  where q.session_id <> p_session_id
    and q.mode = own_queue.mode
    and q.scope = own_queue.scope
    and (
      own_queue.scope = 'world'
      or q.country_code = own_queue.country_code
    )
    and (own_queue.excluded_session_id is null
         or q.session_id <> own_queue.excluded_session_id)
    and (q.excluded_session_id is null
         or q.excluded_session_id <> p_session_id)
  order by q.queued_at
  limit 1
  for update;

  if partner_id is null then
    return;
  end if;

  delete from public.rf_queue
  where session_id in (p_session_id, partner_id);

  insert into public.rf_rooms(mode, participant_a, participant_b)
  values (own_queue.mode, p_session_id, partner_id)
  returning id into new_room_id;

  return query select new_room_id, partner_id;
end;
$$;

revoke all on function public.rf_match_session(uuid) from public, anon, authenticated;
grant execute on function public.rf_match_session(uuid) to service_role;

commit;
