const $ = (s) => document.querySelector(s);
const screens = ["home", "matching", "chat", "call"];
const RF_FUNCTION_URL = "https://nbvfxlaeattbqsablsrd.supabase.co/functions/v1/random-friends";
const RF_PUBLISHABLE_KEY = "sb_publishable_UVRwP4xzxz7p7aK9nKZOFw_y39XLVlr";

let selectedMode = "chat";
let sessionToken = "";
let sessionId = "";
let pollTimer = null;
let localStream = null;
let cameraOn = false;
let busy = false;

function show(name) {
  screens.forEach((id) => $("#" + id).classList.toggle("active", id === name));
  window.scrollTo(0, 0);
}
function setHomeError(message = "") { $("#home-error").textContent = message; }
function setMatchingStatus(message) { $("#matching-status").textContent = message; }
function modeChanged() {
  selectedMode = $('input[name="mode"]:checked').value;
  document.querySelectorAll(".mode-card").forEach((card) =>
    card.classList.toggle("selected", card.querySelector("input").checked)
  );
}
document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", modeChanged));
document.querySelectorAll('input[name="scope"]').forEach((el) => el.addEventListener("change", () => {
  $("#country-wrap").hidden = $('input[name="scope"]:checked').value !== "country";
}));

async function api(action, extra = {}) {
  const response = await fetch(RF_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": RF_PUBLISHABLE_KEY,
      "Authorization": "Bearer " + RF_PUBLISHABLE_KEY
    },
    body: JSON.stringify({ action, sessionToken, ...extra })
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || ("HTTP_" + response.status));
  return data;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollMatch, 1500);
  pollMatch();
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function beginSearch() {
  if (busy) return;
  const accessCode = $("#access-code").value.trim();
  if (!accessCode) {
    setHomeError("테스트 참여 코드를 입력해야 합니다.");
    return;
  }
  busy = true;
  setHomeError("");
  show("matching");
  $("#matching-mode-label").textContent = selectedMode === "chat" ? "RANDOM CHAT" : "RANDOM CALL";
  $("#matching-description").textContent = "서버에 연결하고 상대를 찾고 있습니다.";
  setMatchingStatus("서버 연결 중");
  try {
    const scope = $('input[name="scope"]:checked').value;
    const data = await api("start", {
      accessCode,
      mode: selectedMode,
      scope,
      countryCode: scope === "country" ? $("#country").value : null
    });
    sessionToken = data.sessionToken;
    sessionId = data.sessionId;
    setMatchingStatus(data.status === "matched" ? "상대 찾음" : "매칭 대기 중");
    startPolling();
  } catch (error) {
    show("home");
    setHomeError(error.message === "ACCESS_DENIED"
      ? "테스트 코드가 올바르지 않습니다."
      : "서버 연결 실패: " + error.message + " (Edge Function 배포와 설정을 확인하세요.)");
  } finally {
    busy = false;
  }
}

function renderMessages(messages) {
  const box = $("#messages");
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
  box.replaceChildren();
  if (!messages || messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "✦";
    const title = document.createElement("b");
    title.textContent = "대화를 시작해 보세요";
    const desc = document.createElement("p");
    desc.textContent = "메시지는 현재 대화방에만 표시됩니다.";
    empty.append(icon, title, desc);
    box.append(empty);
    return;
  }
  for (const message of messages) {
    const row = document.createElement("div");
    row.className = "message-row " + (message.sender_session_id === sessionId ? "mine" : "theirs");
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.body;
    row.append(bubble);
    box.append(row);
  }
  if (wasNearBottom) box.scrollTop = box.scrollHeight;
}

function showMatched(data) {
  if (data.room && data.room.mode === "chat") {
    if (!$("#chat").classList.contains("active")) show("chat");
    $("#message-input").disabled = false;
    $("#chat-form button").disabled = false;
    renderMessages(data.messages || []);
  } else if (data.room && data.room.mode === "call") {
    if (!$("#call").classList.contains("active")) show("call");
  }
}

async function pollMatch() {
  if (!sessionToken || busy) return;
  try {
    const data = await api("poll");
    if (data.status === "matched") {
      setMatchingStatus("상대와 연결됨");
      showMatched(data);
    } else if ($("#matching").classList.contains("active")) {
      setMatchingStatus("매칭 대기 중");
    }
  } catch (error) {
    stopPolling();
    if (error.message === "INVALID_SESSION") {
      sessionToken = "";
      sessionId = "";
      show("home");
      setHomeError("테스트 세션이 만료됐습니다. 다시 매칭해 주세요.");
    } else {
      setMatchingStatus("연결이 불안정합니다. 잠시 후 다시 시도해 주세요.");
    }
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("#message-input");
  const message = input.value.trim();
  if (!message || !sessionToken) return;
  input.disabled = true;
  $("#chat-form button").disabled = true;
  try {
    await api("send", { message });
    input.value = "";
    await pollMatch();
  } catch (error) {
    alert("메시지를 보내지 못했습니다: " + error.message);
  } finally {
    input.disabled = false;
    $("#chat-form button").disabled = false;
    input.focus();
  }
}

async function nextMatch() {
  if (!sessionToken || busy) return;
  busy = true;
  stopLocalMedia();
  $("#messages").replaceChildren();
  show("matching");
  $("#matching-mode-label").textContent = selectedMode === "chat" ? "RANDOM CHAT" : "RANDOM CALL";
  $("#matching-description").textContent = "다음 상대를 찾고 있습니다.";
  setMatchingStatus("매칭 대기 중");
  try {
    await api("next");
    startPolling();
  } catch (error) {
    alert("다음 상대를 찾지 못했습니다: " + error.message);
  } finally {
    busy = false;
  }
}

async function endMatch() {
  stopPolling();
  stopLocalMedia();
  if (sessionToken) {
    try { await api("end"); } catch (_) {}
  }
  sessionToken = "";
  sessionId = "";
  $("#message-input").value = "";
  $("#message-input").disabled = true;
  $("#chat-form button").disabled = true;
  $("#access-code").value = "";
  show("home");
}

async function toggleCamera() {
  if (cameraOn) {
    stopLocalMedia();
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    $("#local-video").srcObject = localStream;
    $("#local-video").hidden = false;
    $("#camera-state").textContent = "내 기기 미리보기";
    cameraOn = true;
    $("#camera-toggle").setAttribute("aria-pressed", "true");
    $("#camera-toggle small").textContent = "미리보기 끄기";
  } catch (_) {
    alert("카메라를 사용할 수 없습니다. 브라우저 권한과 HTTPS 연결을 확인해 주세요.");
  }
}
function stopLocalMedia() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  cameraOn = false;
  $("#local-video").srcObject = null;
  $("#local-video").hidden = true;
  $("#camera-state").textContent = "카메라 꺼짐";
  $("#camera-toggle").setAttribute("aria-pressed", "false");
  $("#camera-toggle small").textContent = "카메라 미리보기";
}

$("#start-btn").addEventListener("click", beginSearch);
$("#cancel-search").addEventListener("click", endMatch);
$("#end-waiting").addEventListener("click", endMatch);
$("#next-chat").addEventListener("click", nextMatch);
$("#next-call").addEventListener("click", nextMatch);
$("#end-chat").addEventListener("click", endMatch);
$("#end-call").addEventListener("click", endMatch);
$("#chat-form").addEventListener("submit", sendMessage);
$("#camera-toggle").addEventListener("click", toggleCamera);
window.addEventListener("pagehide", () => {
  stopPolling();
  stopLocalMedia();
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
