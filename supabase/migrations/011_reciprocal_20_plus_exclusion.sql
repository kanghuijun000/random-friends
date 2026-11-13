-- Random Friends: make the 20+ exclusion reciprocal.
-- Apply after migration 010. This only tightens matching eligibility.

begin;

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
  partner_age integer;
begin
  perform pg_advisory_xact_lock(72819421);
  delete from public.rf_sessions where expires_at <= now();

  select * into own_queue
  from public.rf_queue
  where session_id = p_session_id
  for update;
  if not found or own_queue.actual_country_code is null then return; end if;

  select p.* into own_profile
  from public.rf_sessions s
  join public.rf_profiles p on p.device_id = s.device_id
  where s.id = p_session_id;
  if not found then return; end if;

  own_age := own_profile.initial_age
    + extract(year from (now() at time zone 'Asia/Seoul'))::integer
    - own_profile.registered_year;

  select q.session_id into partner_id
  from public.rf_queue q
  join public.rf_sessions ps on ps.id = q.session_id
  join public.rf_profiles pp on pp.device_id = ps.device_id
  where q.session_id <> p_session_id
    and q.mode = own_queue.mode
    and q.actual_country_code is not null
    and (own_queue.scope = 'world' or own_queue.country_code = q.actual_country_code)
    and (q.scope = 'world' or q.country_code = own_queue.actual_country_code)
    and (own_queue.excluded_session_id is null or q.session_id <> own_queue.excluded_session_id)
    and (q.excluded_session_id is null or q.excluded_session_id <> p_session_id)
    and (
      (own_age < 18 and (pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year) < 18)
      or
      (own_age >= 18 and (pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year) >= 18)
    )
    and (not own_profile.exclude_20_plus or
      (pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year) < 20)
    -- Reciprocal check: the waiting user may also have excluded 20+ users.
    and (not pp.exclude_20_plus or own_age < 20)
    and (not own_profile.filter_active or (
      pp.initial_age + extract(year from (now() at time zone 'Asia/Seoul'))::integer - pp.registered_year
        between own_profile.min_age and own_profile.max_age
      and (own_profile.desired_gender = 'any' or own_profile.desired_gender = pp.gender)
    ))
    and (not pp.filter_active or (
      own_age between pp.min_age and pp.max_age
      and (pp.desired_gender = 'any' or pp.desired_gender = own_profile.gender)
    ))
  order by q.queued_at
  limit 1
  for update of q;

  if partner_id is null then return; end if;

  delete from public.rf_queue where session_id in (p_session_id, partner_id);
  insert into public.rf_rooms(mode, participant_a, participant_b)
  values (own_queue.mode, p_session_id, partner_id)
  returning id into new_room_id;

  return query select new_room_id, partner_id;
end;
$$;

revoke all on function public.rf_match_session(uuid) from public, anon, authenticated;
grant execute on function public.rf_match_session(uuid) to service_role;

create or replace function public.rf_test_pair_check(p_own jsonb, p_partner jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  reasons jsonb := '[]'::jsonb;
  own_age integer := (p_own->>'age')::integer;
  partner_age integer := (p_partner->>'age')::integer;
  own_filter boolean := coalesce((p_own->>'filterActive')::boolean, false);
  partner_filter boolean := coalesce((p_partner->>'filterActive')::boolean, false);
  own_exclude_20_plus boolean := coalesce((p_own->>'exclude20Plus')::boolean, false);
  partner_exclude_20_plus boolean := coalesce((p_partner->>'exclude20Plus')::boolean, false);
  own_scope text := p_own->>'scope';
  partner_scope text := p_partner->>'scope';
  own_actual text := upper(coalesce(p_own->>'actualCountryCode', ''));
  partner_actual text := upper(coalesce(p_partner->>'actualCountryCode', ''));
begin
  if p_own->>'mode' <> p_partner->>'mode' then
    reasons := reasons || jsonb_build_array('매칭 방식이 다름');
  end if;

  if own_actual !~ '^[A-Z]{2}$' or partner_actual !~ '^[A-Z]{2}$' then
    reasons := reasons || jsonb_build_array('실제 접속 국가를 확인할 수 없음');
  else
    if own_scope <> 'world' and coalesce(p_own->>'countryCode', '') <> partner_actual then
      reasons := reasons || jsonb_build_array('내가 선택한 국가와 상대의 실제 접속 국가가 다름');
    end if;
    if partner_scope <> 'world' and coalesce(p_partner->>'countryCode', '') <> own_actual then
      reasons := reasons || jsonb_build_array('상대가 선택한 국가와 내 실제 접속 국가가 다름');
    end if;
  end if;

  if (own_age < 18) <> (partner_age < 18) then
    reasons := reasons || jsonb_build_array('연령대 보호 조건이 서로 맞지 않음');
  end if;

  if own_exclude_20_plus and partner_age >= 20 then
    reasons := reasons || jsonb_build_array('내 20세 이상 제외 설정에 걸림');
  end if;
  if partner_exclude_20_plus and own_age >= 20 then
    reasons := reasons || jsonb_build_array('상대의 20세 이상 제외 설정에 걸림');
  end if;

  if own_filter and (
    partner_age < (p_own->>'minAge')::integer
    or partner_age > (p_own->>'maxAge')::integer
    or (p_own->>'desiredGender') not in ('any', p_partner->>'gender')
  ) then
    reasons := reasons || jsonb_build_array('내 필터가 상대를 허용하지 않음');
  end if;
  if partner_filter and (
    own_age < (p_partner->>'minAge')::integer
    or own_age > (p_partner->>'maxAge')::integer
    or (p_partner->>'desiredGender') not in ('any', p_own->>'gender')
  ) then
    reasons := reasons || jsonb_build_array('상대 필터가 나를 허용하지 않음');
  end if;

  return jsonb_build_object(
    'eligible', jsonb_array_length(reasons) = 0,
    'reasons', reasons
  );
end;
$$;

revoke all on function public.rf_test_pair_check(jsonb, jsonb) from public;
grant execute on function public.rf_test_pair_check(jsonb, jsonb) to anon, authenticated;

commit;
