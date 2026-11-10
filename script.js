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
let currentChatRoomId = "";
let chatPartnerAvailable = false;
let lastChatNotice = "";

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RF_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": RF_PUBLISHABLE_KEY,
        "Authorization": "Bearer " + RF_PUBLISHABLE_KEY
      },
      body: JSON.stringify({ action, sessionToken, ...extra }),
      signal: controller.signal,
      cache: "no-store"
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || ("HTTP_" + response.status));
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("NETWORK_TIMEOUT");
      timeoutError.code = "NETWORK_TIMEOUT";
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      const networkError = new Error("NETWORK_UNAVAILABLE");
      networkError.code = "NETWORK_UNAVAILABLE";
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isNetworkFailure(error) {
  return error?.code === "NETWORK_TIMEOUT" ||
    error?.code === "NETWORK_UNAVAILABLE" ||
    error?.name === "AbortError" ||
    error instanceof TypeError;
}

let handlingNetworkFailure = false;
function returnHomeAfterNetworkFailure(message = "인터넷 연결 실패: 네트워크 상태를 확인한 뒤 다시 매칭해 주세요.") {
  if (handlingNetworkFailure) return;
  handlingNetworkFailure = true;

  // End the server session in the background when the connection still permits it.
  if (sessionToken) api("end").catch(() => {});
  stopPolling();
  cleanupCall();
  sessionToken = "";
  sessionId = "";
  currentChatRoomId = "";
  chatPartnerAvailable = false;
  busy = false;
  $("#message-input").value = "";
  $("#message-input").disabled = true;
  $("#chat-form button").disabled = true;
  show("home");
  setHomeError(message);
  handlingNetworkFailure = false;
}

window.addEventListener("offline", () => {
  if (screens.some((id) => id !== "home" && $("#" + id).classList.contains("active"))) {
    returnHomeAfterNetworkFailure("인터넷 연결이 끊어졌습니다. 연결을 확인한 뒤 다시 매칭해 주세요.");
  }
});

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
  if (!navigator.onLine) {
    setHomeError("인터넷 연결 실패: 인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
    return;
  }
  busy = true;
  currentChatRoomId = "";
  chatPartnerAvailable = false;
  lastChatNotice = "";
  setChatNotice("");
  setHomeError("");
  show(selectedMode === "call" ? "call" : "matching");
  if (selectedMode === "call") {
    $("#remote-video").srcObject = null;
    $("#remote-video").hidden = true;
    $("#remote-avatar").hidden = false;
    $("#remote-state").textContent = "상대방을 찾고 있는 중...";
    $("#call-room-status").textContent = "상대 찾는 중";
    $("#call-status").textContent = "새로운 상대를 찾고 있습니다.";
    $("#mic-toggle").disabled = true;
    $("#camera-toggle").disabled = true;
    $("#next-call").disabled = true;
  }
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
    if (isNetworkFailure(error)) {
      setHomeError("인터넷 연결 실패: 네트워크가 끊겼거나 너무 느립니다. 연결을 확인한 뒤 다시 매칭해 주세요.");
    } else {
      setHomeError(error.message === "ACCESS_DENIED"
        ? "테스트 코드가 올바르지 않습니다."
        : "서버 연결 실패: " + error.message + " (Edge Function 배포와 설정을 확인하세요.)");
    }
  } finally {
    busy = false;
  }
}

function setChatNotice(message) {
  const notice = $("#chat-status");
  notice.textContent = message;
  notice.hidden = !message;
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
    const nextRoomId = String(data.room.id);
    const changedRoom = Boolean(currentChatRoomId && currentChatRoomId !== nextRoomId);
    if (!$("#chat").classList.contains("active")) show("chat");
    if (changedRoom) {
      $("#messages").replaceChildren();
      setChatNotice("상대방이 퇴장했습니다. 새로운 상대방과 연결되었습니다.");
      lastChatNotice = "new:" + nextRoomId;
    } else if (data.partnerLeft && lastChatNotice !== "left:" + currentChatRoomId) {
      setChatNotice("상대방이 퇴장했습니다. 새로운 상대를 찾고 있습니다.");
      lastChatNotice = "left:" + currentChatRoomId;
    }
    currentChatRoomId = nextRoomId;
    chatPartnerAvailable = true;
    $("#message-input").disabled = false;
    $("#chat-form button").disabled = false;
    renderMessages(data.messages || []);
  } else if (data.room && data.room.mode === "call") {
    if (!$("#call").classList.contains("active")) show("call");
    $("#call-room-status").textContent = "상대 매칭됨";
    $("#remote-state").textContent = "상대방의 영상 연결 중...";
    $("#mic-toggle").disabled = false;
    $("#camera-toggle").disabled = false;
    $("#next-call").disabled = false;
    setupCall(data).catch((error) => {
      if (isNetworkFailure(error)) {
        returnHomeAfterNetworkFailure();
      } else {
        setCallStatus("통화 초기화 실패: " + error.message);
      }
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
  for (const track of audioOnly.getAudioTracks()) {
    track.enabled = micOn;
    localStream.addTrack(track);
    if (audioSender) await audioSender.replaceTrack(track);
  }
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
  $("#remote-avatar").hidden = false;
  $("#remote-state").textContent = "상대방의 영상 연결 중...";
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
    if (event.track.kind === "video") {
      $("#remote-video").hidden = false;
      $("#remote-avatar").hidden = true;
      $("#remote-video").play().catch(() => {});
    } else {
      $("#remote-state").textContent = "음성 연결됨 · 상대방 영상 대기 중";
    }
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
    if (isNetworkFailure(error)) {
      returnHomeAfterNetworkFailure();
    } else {
      setCallStatus("통화 신호 확인 실패: " + error.message);
    }
  } finally {
    signalBusy = false;
  }
}

async function pollMatch() {
  if (!sessionToken || busy) return;
  try {
    const pollExtra = selectedMode === "chat" && currentChatRoomId ? { lastRoomId: currentChatRoomId } : {};
    const data = await api("poll", pollExtra);
    if (data.status === "matched") {
      setMatchingStatus("상대와 연결됨");
      showMatched(data);
      if (data.room?.mode === "call") await pollSignals();
    } else if (data.partnerLeft && selectedMode === "chat") {
      chatPartnerAvailable = false;
      $("#message-input").disabled = true;
      $("#chat-form button").disabled = true;
      const noticeKey = "left:" + currentChatRoomId;
      if (lastChatNotice !== noticeKey) {
        setChatNotice("상대방이 퇴장했습니다. 새로운 상대를 찾고 있습니다.");
        lastChatNotice = noticeKey;
      }
    } else if ($("#matching").classList.contains("active")) {
      setMatchingStatus("매칭 대기 중");
    } else if (selectedMode === "call" && $("#call").classList.contains("active")) {
      $("#remote-state").textContent = "상대방을 찾고 있는 중...";
      $("#call-room-status").textContent = "상대 찾는 중";
    }
  } catch (error) {
    if (isNetworkFailure(error)) {
      returnHomeAfterNetworkFailure();
      return;
    }
    if (error.message === "INVALID_SESSION") {
      stopPolling();
      sessionToken = "";
      sessionId = "";
      cleanupCall();
      show("home");
      setHomeError("테스트 세션이 만료됐습니다. 다시 매칭해 주세요.");
    } else if ($("#matching").classList.contains("active")) {
      setMatchingStatus("서버 응답 오류. 잠시 후 다시 시도해 주세요.");
    }
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("#message-input");
  const message = input.value.trim();
  if (!message || !sessionToken) return;
  if (!chatPartnerAvailable) return;
  input.disabled = true;
  $("#chat-form button").disabled = true;
  try {
    await api("send", { message });
    input.value = "";
    await pollMatch();
  } catch (error) {
    if (isNetworkFailure(error)) {
      returnHomeAfterNetworkFailure();
    } else {
      alert("메시지를 보내지 못했습니다: " + error.message);
    }
  } finally {
    input.disabled = !chatPartnerAvailable;
    $("#chat-form button").disabled = !chatPartnerAvailable;
    if (chatPartnerAvailable) input.focus();
  }
}

async function nextMatch() {
  if (!sessionToken || busy) return;
  busy = true;
  stopLocalMedia();
  cleanupCall();
  chatPartnerAvailable = false;
  $("#message-input").disabled = true;
  $("#chat-form button").disabled = true;
  setChatNotice("새로운 상대를 찾고 있습니다.");
  $("#messages").replaceChildren();
  show("matching");
  $("#matching-mode-label").textContent = selectedMode === "chat" ? "RANDOM CHAT" : "RANDOM CALL";
  $("#matching-description").textContent = "다음 상대를 찾고 있습니다.";
  setMatchingStatus("매칭 대기 중");
  try {
    await api("next");
    startPolling();
  } catch (error) {
    if (isNetworkFailure(error)) {
      returnHomeAfterNetworkFailure();
    } else {
      alert("다음 상대를 찾지 못했습니다: " + error.message);
    }
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
  currentChatRoomId = "";
  chatPartnerAvailable = false;
  lastChatNotice = "";
  setChatNotice("");
  $("#message-input").value = "";
  $("#message-input").disabled = true;
  $("#chat-form button").disabled = true;
  $("#access-code").value = "";
  $("#call-room-status").textContent = "상대 매칭됨";
  $("#mic-toggle").disabled = false;
  $("#camera-toggle").disabled = false;
  $("#next-call").disabled = false;
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
  if ($("#remote-state")) $("#remote-state").textContent = "상대방을 찾고 있는 중...";
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
  let refreshingAfterUpdate = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshingAfterUpdate) return;
    refreshingAfterUpdate = true;
    window.location.reload();
  });

  const checkForAppUpdate = async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", {
        updateViaCache: "none"
      });
      await registration.update();
    } catch (_) {}
  };

  window.addEventListener("load", checkForAppUpdate, { once: true });

  const checkRegisteredUpdate = () => {
    if (document.visibilityState !== "visible") return;
    navigator.serviceWorker.getRegistration()
      .then((registration) => registration && registration.update())
      .catch(() => {});
  };

  window.addEventListener("focus", checkRegisteredUpdate);
  document.addEventListener("visibilitychange", checkRegisteredUpdate);
}
