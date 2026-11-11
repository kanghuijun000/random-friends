-- Roll back only the optional 20+ exclusion added by migration 005.
-- Keep the age/gender profile and server-side under-18 / 18+ separation from migration 004.
begin;
alter table public.rf_profiles drop column if exists exclude_20_plus;
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
  own_profile public.rf_profiles%rowtype;
  own_age integer;
begin
  perform pg_advisory_xact_lock(72819421);
  delete from public.rf_sessions where expires_at <= now();
  select * into own_queue from public.rf_queue where session_id = p_session_id for update;
  if not found then return; end if;
  select p.* into own_profile from public.rf_sessions s join public.rf_profiles p on p.device_id = s.device_id where s.id = p_session_id;
  if not found then return; end if;
  own_age := own_profile.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - own_profile.registered_year;
  select q.session_id into partner_id
  from public.rf_queue q
  join public.rf_sessions ps on ps.id = q.session_id
  join public.rf_profiles pp on pp.device_id = ps.device_id
  where q.session_id <> p_session_id
    and q.mode = own_queue.mode and q.scope = own_queue.scope
    and (own_queue.scope = 'world' or q.country_code = own_queue.country_code)
    and (own_queue.excluded_session_id is null or q.session_id <> own_queue.excluded_session_id)
    and (q.excluded_session_id is null or q.excluded_session_id <> p_session_id)
    and ((own_age < 18 and (pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year) < 18)
      or (own_age >= 18 and (pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year) >= 18))
    and (not own_profile.filter_active or (
      pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year between own_profile.min_age and own_profile.max_age
      and (own_profile.desired_gender = 'any' or own_profile.desired_gender = pp.gender)))
    and (not pp.filter_active or (own_age between pp.min_age and pp.max_age
      and (pp.desired_gender = 'any' or pp.desired_gender = own_profile.gender)))
  order by q.queued_at limit 1 for update of q;
  if partner_id is null then return; end if;
  delete from public.rf_queue where session_id in (p_session_id, partner_id);
  insert into public.rf_rooms(mode, participant_a, participant_b) values (own_queue.mode, p_session_id, partner_id) returning id into new_room_id;
  return query select new_room_id, partner_id;
end;
$;
revoke all on function public.rf_match_session(uuid) from public, anon, authenticated;
grant execute on function public.rf_match_session(uuid) to service_role;
commit;
