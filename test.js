const SUPABASE_URL = "https://nbvfxlaeattbqsablsrd.supabase.co";
const SUPABASE_KEY = "sb_publishable_UVRwP4xzxz7p7aK9nKZOFw_y39XLVlr";
const $ = (selector) => document.querySelector(selector);

function clientCard(index) {
  const number = index + 1;
  const gender = index % 2 === 0 ? "male" : "female";
  return `
    <section class="client" data-client="${number}">
      <div class="client-head"><b>가상 이용자 ${number}</b><span class="muted">ID: client-${number}</span></div>
      <div class="grid">
        <label class="field"><span>매칭 방식</span><select data-field="mode"><option value="chat">랜덤채팅</option><option value="call">랜덤통화</option></select></label>
        <label class="field"><span>매칭 범위</span><select data-field="scope"><option value="country">국가 선택</option><option value="world">전 세계</option></select></label>
        <label class="field"><span>선택한 국가</span><select data-field="countryCode"><option value="KR">대한민국</option><option value="JP">일본</option><option value="US">미국</option><option value="GB">영국</option><option value="CA">캐나다</option><option value="DE">독일</option></select></label>
        <label class="field"><span>실제 접속 국가 (가상)</span><select data-field="actualCountryCode"><option value="KR">대한민국</option><option value="JP">일본</option><option value="US">미국</option><option value="GB">영국</option><option value="CA">캐나다</option><option value="DE">독일</option></select></label>
        <label class="field"><span>현재 나이</span><input data-field="age" type="number" min="13" max="99" value="16" inputmode="numeric"></label>
        <label class="field"><span>성별</span><select data-field="gender"><option value="male" ${gender === "male" ? "selected" : ""}>남성</option><option value="female" ${gender === "female" ? "selected" : ""}>여성</option></select></label>
        <label class="field"><span>상대 성별 필터</span><select data-field="desiredGender"><option value="any">무관</option><option value="male">남성</option><option value="female">여성</option></select></label>
        <label class="field"><span>필터 최소 나이</span><input data-field="minAge" type="number" min="13" max="99" value="13"></label>
        <label class="field"><span>필터 최대 나이</span><input data-field="maxAge" type="number" min="13" max="99" value="99"></label>
      </div>
      <div class="checks">
        <label class="check"><input data-field="filterActive" type="checkbox"> 나이·성별 필터 적용</label>
        <label class="check"><input data-field="exclude20Plus" type="checkbox"> 20세 이상 제외</label>
      </div>
    </section>`;
}

function generateClients() {
  const count = Number($("#client-count").value);
  $("#clients").innerHTML = Array.from({ length: count }, (_, i) => clientCard(i)).join("");
  $("#results").replaceChildren();
}

function readClients() {
  return [...document.querySelectorAll("[data-client]")].map((card, index) => {
    const get = (field) => card.querySelector(`[data-field="${field}"]`);
    const scope = get("scope").value;
    return {
      id: `client-${index + 1}`,
      mode: get("mode").value,
      scope,
      countryCode: scope === "country" ? get("countryCode").value : null,
      actualCountryCode: get("actualCountryCode").value,
      age: Number(get("age").value),
      gender: get("gender").value,
      filterActive: get("filterActive").checked,
      minAge: Number(get("minAge").value),
      maxAge: Number(get("maxAge").value),
      desiredGender: get("desiredGender").value,
      exclude20Plus: get("exclude20Plus").checked
    };
  });
}

function addResultCard(parent, className, title, detail) {
  const card = document.createElement("div");
  card.className = `result-card ${className || ""}`;
  const strong = document.createElement("b");
  strong.textContent = title;
  const text = document.createElement("div");
  text.textContent = detail;
  card.append(strong, text);
  parent.append(card);
}

async function runSimulation() {
  const button = $("#run");
  const results = $("#results");
  const clients = readClients();
  button.disabled = true;
  button.textContent = "검사 중...";
  results.replaceChildren();

  try {
    const waiting = [];
    const pairs = [];
    const checks = [];

    // Use the SQL pair-check function created by migration 010.
    // Matching itself is simulated locally; no live queue or room is touched.
    async function checkPair(own, partner) {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rf_test_pair_check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({ p_own: own, p_partner: partner })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || data.details || data.hint || data.error || `HTTP ${response.status}`);
      }
      return data;
    }

    // Greedy queue simulation: each client joins in order and can be paired once.
    for (const joiningClient of clients) {
      let matchedIndex = -1;

      for (let i = 0; i < waiting.length; i++) {
        const waitingClient = waiting[i];
        if (joiningClient.mode !== waitingClient.mode) {
          checks.push({
            joiningClient: joiningClient.id,
            waitingClient: waitingClient.id,
            eligible: false,
            reasons: ["매칭 방식이 다름"]
          });
          continue;
        }

        const result = await checkPair(joiningClient, waitingClient);
        checks.push({
          joiningClient: joiningClient.id,
          waitingClient: waitingClient.id,
          eligible: !!result.eligible,
          reasons: Array.isArray(result.reasons) ? result.reasons : []
        });

        if (result.eligible) {
          matchedIndex = i;
          pairs.push({
            clientA: waitingClient.id,
            clientB: joiningClient.id,
            mode: joiningClient.mode,
            scope: joiningClient.scope,
            countryCode: joiningClient.countryCode
          });
          break;
        }
      }

      if (matchedIndex >= 0) waiting.splice(matchedIndex, 1);
      else waiting.push(joiningClient);
    }

    const heading = document.createElement("h2");
    heading.textContent = `검사 결과 · ${clients.length}명`;
    results.append(heading);

    if (pairs.length) {
      const pairHeading = document.createElement("h2");
      pairHeading.textContent = "매칭 성공";
      results.append(pairHeading);
      pairs.forEach((pair) => {
        addResultCard(results, "ok", `${pair.clientA} ↔ ${pair.clientB}`,
          `${pair.mode === "chat" ? "랜덤채팅" : "랜덤통화"} · ${pair.scope === "world" ? "전 세계" : pair.countryCode}`);
      });
    } else {
      addResultCard(results, "wait", "매칭된 이용자가 없습니다.", "아래 조건 검사 결과에서 매칭이 막힌 이유를 확인하세요.");
    }

    const waitingHeading = document.createElement("h2");
    waitingHeading.textContent = `대기 상태 · ${waiting.length}명`;
    results.append(waitingHeading);
    if (waiting.length) {
      addResultCard(results, "wait", waiting.map(client => client.id).join(", "), "조건에 맞는 대상을 찾지 못해 대기열에 남는 상황입니다.");
    } else {
      addResultCard(results, "ok", "대기 중인 이용자가 없습니다.", "입력한 이용자들이 모두 매칭됐습니다.");
    }

    const checksHeading = document.createElement("h2");
    checksHeading.textContent = "조건별 검사 기록";
    results.append(checksHeading);
    if (!checks.length) {
      addResultCard(results, "", "검사할 대기 상대가 없었습니다.", "가상 이용자 수와 입력값을 확인하세요.");
    } else {
      checks.forEach((check) => {
        const detail = check.eligible ? "모든 조건 통과" : check.reasons.join(" · ");
        addResultCard(results, check.eligible ? "ok" : "wait",
          `${check.joiningClient} → 대기 중인 ${check.waitingClient}: ${check.eligible ? "가능" : "불가"}`, detail);
      });
    }

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "국가·연령·성별 필터 판정은 Supabase의 rf_test_pair_check SQL 함수를 사용합니다. 가상 대기열과 매칭 순서는 테스트 페이지 안에서만 계산합니다.";
    results.append(note);
  } catch (error) {
    addResultCard(results, "bad", "시뮬레이션 실행 실패", error.message || "알 수 없는 오류");
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "마이그레이션 010의 rf_test_pair_check(jsonb, jsonb) 함수가 적용됐는지, Supabase API의 함수 스키마 캐시가 갱신됐는지 확인하세요.";
    results.append(hint);
  } finally {
    button.disabled = false;
    button.textContent = "매칭 시뮬레이션 실행";
  }
}
$("#generate").addEventListener("click", generateClients);
$("#run").addEventListener("click", runSimulation);
generateClients();
