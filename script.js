const $ = (s) => document.querySelector(s);
const screens = ["home", "matching", "chat", "call"];
const RF_FUNCTION_URL = "https://nbvfxlaeattbqsablsrd.supabase.co/functions/v1/random-friends";
const RF_PUBLISHABLE_KEY = "sb_publishable_UVRwP4xzxz7p7aK9nKZOFw_y39XLVlr";

let selectedMode = "chat";
let sessionToken = "";
let sessionId = "";
let pollTimer = null;
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let audioSender = null;
let videoSender = null;
let cameraOn = false;
let micOn = true;
let currentRoomId = "";
let lastSignalId = 0;
let signalBusy = false;
let callSetupRoom = "";
let offerStarted = false;
let pendingCandidates = [];
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
  pollTimer = setInterval(pollMatch, 1200);
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
    setupCall(data).catch((error) => {
      setCallStatus("통화 초기화 실패: " + error.message);
    });
  }
}

function setCallStatus(message) {
  $("#call-status").textContent = message;
}
function updateMicButton() {
  $("#mic-toggle").setAttribute("aria-pressed", String(micOn));
  $("#mic-toggle small").textContent = micOn ? "마이크 켜짐" : "마이크 꺼짐";
}
function updateCameraButton() {
  $("#camera-toggle").setAttribute("aria-pressed", String(cameraOn));
  $("#camera-toggle small").textContent = cameraOn ? "카메라 끄기" : "카메라 켜기";
}
async function ensureAudio() {
  if (localStream && localStream.getAudioTracks().length) {
    localStream.getAudioTracks().forEach((track) => track.enabled = micOn);
    return;
  }
  const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  if (!localStream) localStream = new MediaStream();
  audioOnly.getAudioTracks().forEach((track) => {
    track.enabled = micOn;
    localStream.addTrack(track);
    if (audioSender) await audioSender.replaceTrack(track);
  });
}
async function setupCall(data) {
  const roomId = data.room.id;
  if (callSetupRoom === roomId) return;
  cleanupCall();
  callSetupRoom = roomId;
  currentRoomId = roomId;
  lastSignalId = 0;
  pendingCandidates = [];
  offerStarted = false;
  remoteStream = new MediaStream();
  $("#remote-video").srcObject = remoteStream;
  setCallStatus("마이크 권한 확인 중…");
  try {
    await ensureAudio();
    micOn = true;
    updateMicButton();
  } catch (_) {
    micOn = false;
    updateMicButton();
    setCallStatus("마이크 권한이 없어 음성이 꺼져 있습니다. 마이크 버튼으로 다시 켜세요.");
  }

  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  const audioTransceiver = peerConnection.addTransceiver("audio", { direction: "sendrecv" });
  const videoTransceiver = peerConnection.addTransceiver("video", { direction: "sendrecv" });
  audioSender = audioTransceiver.sender;
  videoSender = videoTransceiver.sender;
  const audioTrack = localStream?.getAudioTracks()[0] || null;
  if (audioTrack) await audioSender.replaceTrack(audioTrack);
  peerConnection.ontrack = (event) => {
    if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    $("#remote-video").hidden = false;
    $("#remote-avatar").hidden = true;
    $("#remote-video").play().catch(() => {});
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && currentRoomId === roomId) {
      api("signal-send", { kind: "ice-candidate", payload: event.candidate.toJSON() })
        .catch(() => setCallStatus("연결 신호 전송 실패. 네트워크를 확인해 주세요."));
    }
  };
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    if (state === "connected") setCallStatus("통화 연결됨");
    else if (state === "connecting") setCallStatus("통화 연결 중…");
    else if (state === "failed") setCallStatus("직접 연결 실패. 이 네트워크에서는 통화가 불가능할 수 있습니다.");
    else if (state === "disconnected") setCallStatus("연결이 일시적으로 끊겼습니다.");
  };

  if (sessionId < data.partnerId) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await api("signal-send", { kind: "offer", payload: peerConnection.localDescription.toJSON() });
    offerStarted = true;
    setCallStatus("상대의 응답을 기다리는 중…");
  } else {
    setCallStatus("상대가 통화를 연결하고 있습니다…");
  }
  await pollSignals();
}
async function pollSignals() {
  if (!currentRoomId || !peerConnection || signalBusy) return;
  signalBusy = true;
  try {
    const data = await api("signal-poll", { afterId: lastSignalId });
    for (const signal of (data.signals || [])) {
      lastSignalId = Math.max(lastSignalId, Number(signal.id) || 0);
      if (!peerConnection || !currentRoomId) break;
      if (signal.kind === "offer") {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await api("signal-send", { kind: "answer", payload: peerConnection.localDescription.toJSON() });
        for (const candidate of pendingCandidates) await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        pendingCandidates = [];
      } else if (signal.kind === "answer" && peerConnection.signalingState === "have-local-offer") {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
        for (const candidate of pendingCandidates) await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        pendingCandidates = [];
      } else if (signal.kind === "ice-candidate") {
        if (peerConnection.remoteDescription) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(signal.payload));
        } else {
          pendingCandidates.push(signal.payload);
        }
      }
    }
  } catch (error) {
    setCallStatus("통화 신호 확인 실패: " + error.message);
  } finally {
    signalBusy = false;
  }
}

async function pollMatch() {
  if (!sessionToken || busy) return;
  try {
    const data = await api("poll");
    if (data.status === "matched") {
      setMatchingStatus("상대와 연결됨");
      showMatched(data);
      if (data.room?.mode === "call") await pollSignals();
    } else if ($("#matching").classList.contains("active")) {
      setMatchingStatus("매칭 대기 중");
    }
  } catch (error) {
    stopPolling();
    if (error.message === "INVALID_SESSION") {
      sessionToken = "";
      sessionId = "";
      cleanupCall();
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
  cleanupCall();
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
  cleanupCall();
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
function stopLocalMedia() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  cameraOn = false;
  micOn = true;
  $("#local-video").srcObject = null;
  $("#local-video").hidden = true;
  $("#camera-state").textContent = "카메라 꺼짐";
  updateMicButton();
  updateCameraButton();
}
function cleanupCall() {
  currentRoomId = "";
  callSetupRoom = "";
  pendingCandidates = [];
  offerStarted = false;
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
  }
  peerConnection = null;
  audioSender = null;
  videoSender = null;
  if (remoteStream) remoteStream.getTracks().forEach((track) => track.stop());
  remoteStream = null;
  $("#remote-video").srcObject = null;
  $("#remote-video").hidden = true;
  $("#remote-avatar").hidden = false;
  stopLocalMedia();
}
async function toggleMic() {
  micOn = !micOn;
  try {
    if (micOn) await ensureAudio();
    if (localStream) localStream.getAudioTracks().forEach((track) => track.enabled = micOn);
    updateMicButton();
    setCallStatus(micOn ? "마이크 켜짐" : "마이크 꺼짐");
  } catch (_) {
    micOn = false;
    updateMicButton();
    setCallStatus("마이크 권한을 허용해야 음성을 보낼 수 있습니다.");
  }
}
async function toggleCamera() {
  if (cameraOn) {
    const tracks = localStream?.getVideoTracks() || [];
    for (const track of tracks) {
      if (videoSender) await videoSender.replaceTrack(null);
      track.stop();
      localStream.removeTrack(track);
    }
    cameraOn = false;
    $("#local-video").srcObject = null;
    $("#local-video").hidden = true;
    $("#camera-state").textContent = "카메라 꺼짐";
    updateCameraButton();
    return;
  }
  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (!localStream) localStream = new MediaStream();
    for (const track of videoStream.getVideoTracks()) {
      localStream.addTrack(track);
      if (videoSender) await videoSender.replaceTrack(track);
    }
    $("#local-video").srcObject = videoStream;
    $("#local-video").hidden = false;
    $("#camera-state").textContent = "카메라 켜짐";
    cameraOn = true;
    updateCameraButton();
  } catch (_) {
    alert("카메라를 사용할 수 없습니다. 브라우저 권한과 HTTPS 연결을 확인해 주세요.");
  }
}

$("#start-btn").addEventListener("click", beginSearch);
$("#cancel-search").addEventListener("click", endMatch);
$("#end-waiting").addEventListener("click", endMatch);
$("#next-chat").addEventListener("click", nextMatch);
$("#next-call").addEventListener("click", nextMatch);
$("#end-chat").addEventListener("click", endMatch);
$("#end-call").addEventListener("click", endMatch);
$("#chat-form").addEventListener("submit", sendMessage);
$("#mic-toggle").addEventListener("click", toggleMic);
$("#camera-toggle").addEventListener("click", toggleCamera);
updateMicButton();
updateCameraButton();
window.addEventListener("pagehide", () => {
  stopPolling();
  cleanupCall();
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
