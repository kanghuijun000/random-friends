-- Random Friends: isolated, read-only matching rules simulator.
-- This adds ONLY two pure functions. It does not read or write live rf_* tables.
-- It does not change the production matching function rf_match_session.

begin;

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
begin
  if p_own->>'mode' <> p_partner->>'mode' then
    reasons := reasons || jsonb_build_array('매칭 방식이 다름');
  end if;
  if p_own->>'scope' <> p_partner->>'scope' then
    reasons := reasons || jsonb_build_array('매칭 범위가 다름');
  elsif p_own->>'scope' = 'country'
    and coalesce(p_own->>'countryCode', '') <> coalesce(p_partner->>'countryCode', '') then
    reasons := reasons || jsonb_build_array('선택한 국가가 다름');
  end if;
  if (own_age < 18) <> (partner_age < 18) then
    reasons := reasons || jsonb_build_array('연령대 보호 조건이 서로 맞지 않음');
  end if;
  if coalesce((p_own->>'exclude20Plus')::boolean, false) and partner_age >= 20 then
    reasons := reasons || jsonb_build_array('내 20세 이상 제외 설정에 걸림');
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

create or replace function public.rf_simulate_matching(p_clients jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  client_count integer;
  i integer;
  q integer;
  queue_indices integer[] := array[]::integer[];
  partner_index integer;
  own_client jsonb;
  queued_client jsonb;
  pair_check jsonb;
  pairs jsonb := '[]'::jsonb;
  waiting jsonb := '[]'::jsonb;
  checks jsonb := '[]'::jsonb;
  seen_ids text[] := array[]::text[];
  client_id text;
  client_age integer;
  min_age integer;
  max_age integer;
  client_mode text;
  client_scope text;
  client_gender text;
  desired_gender text;
  country_code text;
begin
  if p_clients is null or jsonb_typeof(p_clients) <> 'array' then
    raise exception '입력 데이터가 배열이 아닙니다.';
  end if;

  client_count := jsonb_array_length(p_clients);
  if client_count < 2 or client_count > 10 then
    raise exception '가상 이용자는 2명부터 10명까지 설정할 수 있습니다.';
  end if;

  for i in 0..client_count - 1 loop
    own_client := p_clients->i;
    if jsonb_typeof(own_client) <> 'object' then
      raise exception '가상 이용자 데이터 형식이 올바르지 않습니다.';
    end if;

    client_id := coalesce(own_client->>'id', '');
    client_mode := coalesce(own_client->>'mode', '');
    client_scope := coalesce(own_client->>'scope', '');
    client_gender := coalesce(own_client->>'gender', '');
    country_code := coalesce(own_client->>'countryCode', '');
    if client_id = '' or length(client_id) > 32 or client_id = any(seen_ids) then
      raise exception '가상 이용자 ID가 비어 있거나 중복되었습니다.';
    end if;
    seen_ids := array_append(seen_ids, client_id);

    if client_mode not in ('chat', 'call') then
      raise exception '%: 매칭 방식이 올바르지 않습니다.', client_id;
    end if;
    if client_scope not in ('world', 'country') then
      raise exception '%: 매칭 범위가 올바르지 않습니다.', client_id;
    end if;
    if client_scope = 'country' and country_code !~ '^[A-Z]{2}$' then
      raise exception '%: 국가 코드는 영문 대문자 2자리여야 합니다.', client_id;
    end if;
    if client_gender not in ('male', 'female') then
      raise exception '%: 성별 값이 올바르지 않습니다.', client_id;
    end if;
    if coalesce(own_client->>'age', '') !~ '^[0-9]{1,2}$' then
      raise exception '%: 나이를 숫자로 입력해 주세요.', client_id;
    end if;
    client_age := (own_client->>'age')::integer;
    if client_age < 13 or client_age > 99 then
      raise exception '%: 나이는 13~99세 범위여야 합니다.', client_id;
    end if;

    min_age := coalesce((own_client->>'minAge')::integer, 13);
    max_age := coalesce((own_client->>'maxAge')::integer, 99);
    desired_gender := coalesce(own_client->>'desiredGender', 'any');
    if min_age < 13 or max_age > 99 or min_age > max_age then
      raise exception '%: 필터 연령 범위가 올바르지 않습니다.', client_id;
    end if;
    if desired_gender not in ('any', 'male', 'female') then
      raise exception '%: 필터 성별 값이 올바르지 않습니다.', client_id;
    end if;
  end loop;

  -- Each new virtual client attempts to match the oldest still-waiting client,
  -- mirroring the direction and filter checks in migration 007.
  for i in 1..client_count loop
    own_client := p_clients->(i - 1);
    partner_index := null;

    if coalesce(array_length(queue_indices, 1), 0) > 0 then
      for q in 1..array_length(queue_indices, 1) loop
        queued_client := p_clients->(queue_indices[q] - 1);
        pair_check := public.rf_test_pair_check(own_client, queued_client);

        checks := checks || jsonb_build_array(jsonb_build_object(
          'waitingClient', queued_client->>'id',
          'joiningClient', own_client->>'id',
          'eligible', (pair_check->>'eligible')::boolean,
          'reasons', pair_check->'reasons'
        ));

        if (pair_check->>'eligible')::boolean then
          partner_index := queue_indices[q];
          exit;
        end if;
      end loop;
    end if;

    if partner_index is not null then
      queued_client := p_clients->(partner_index - 1);
      pairs := pairs || jsonb_build_array(jsonb_build_object(
        'clientA', queued_client->>'id',
        'clientB', own_client->>'id',
        'mode', own_client->>'mode',
        'scope', own_client->>'scope',
        'countryCode', own_client->>'countryCode'
      ));
      queue_indices := array_remove(queue_indices, partner_index);
    else
      queue_indices := array_append(queue_indices, i);
    end if;
  end loop;

  if coalesce(array_length(queue_indices, 1), 0) > 0 then
    for q in 1..array_length(queue_indices, 1) loop
      queued_client := p_clients->(queue_indices[q] - 1);
      waiting := waiting || jsonb_build_array(queued_client->>'id');
    end loop;
  end if;

  return jsonb_build_object(
    'totalClients', client_count,
    'matchedCount', jsonb_array_length(pairs) * 2,
    'pairs', pairs,
    'waiting', waiting,
    'checks', checks,
    'simulationOnly', true,
    'note', '실제 rf_queue, rf_sessions, rf_rooms 및 운영 매칭 함수는 변경하거나 호출하지 않았습니다.'
  );
end;
$$;

revoke all on function public.rf_test_pair_check(jsonb, jsonb) from public;
revoke all on function public.rf_simulate_matching(jsonb) from public;
grant execute on function public.rf_test_pair_check(jsonb, jsonb) to anon, authenticated;
grant execute on function public.rf_simulate_matching(jsonb) to anon, authenticated;

commit;
