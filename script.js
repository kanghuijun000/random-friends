const $ = (s) => document.querySelector(s);
const screens = ["home", "settings", "matching", "chat", "call"];
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
let lastCallRoomId = "";
let pollBusy = false;
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

const DEVICE_ID_KEY = "random-friends-device-id-v1";
const PROFILE_STORAGE_KEY = "random-friends-profile-v1";
const PROTECTION_STORAGE_KEY = "random-friends-protection-v1";
let protectionEnabled = localStorage.getItem(PROTECTION_STORAGE_KEY) !== "false";
const FILTER_STORAGE_KEY = "random-friends-match-filter-v2";
function makeDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
const deviceId = makeDeviceId();
function readProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    if (value && ["male", "female"].includes(value.gender) &&
        Number.isInteger(value.initialAge) && value.initialAge >= 13 && value.initialAge <= 99) return value;
  } catch (_) {}
  return null;
}
let userProfile = readProfile();
const profileModal = $("#profile-modal");
function showProfileSetup() {
  $("#profile-gender").value = "male";
  $("#profile-age").value = "";
  profileModal.hidden = false;
  document.body.style.overflow = "hidden";
  $("#start-btn").disabled = true;
}
function saveProfile() {
  const gender = $("#profile-gender").value;
  const initialAge = Number($("#profile-age").value);
  if (!["male", "female"].includes(gender) || !Number.isInteger(initialAge) || initialAge < 13 || initialAge > 99) {
    $("#profile-error").textContent = "나이는 13~99세 사이의 정수로 입력해 주세요.";
    return;
  }
  const now = new Date();
  userProfile = {
    ...userProfile,
    gender,
    initialAge,
    registeredYear: Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(now)),
    registeredAt: now.toISOString(),
  };
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(userProfile));
  profileModal.hidden = true;
  document.body.style.overflow = "";
  $("#start-btn").disabled = false;
  setHomeError("");
}
$("#save-profile").addEventListener("click", saveProfile);
if (!userProfile) showProfileSetup();

const defaultMatchFilter = { active: false, minAge: 13, maxAge: 99, gender: "any" };
function readMatchFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || "null");
    if (!saved) return { ...defaultMatchFilter };
    const minAge = Number.isInteger(saved.minAge) ? saved.minAge : 13;
    const maxAge = Number.isInteger(saved.maxAge) ? saved.maxAge : 99;
    return {
      active: saved.active === true,
      minAge,
      maxAge,
      gender: ["any", "male", "female"].includes(saved.gender) ? saved.gender : "any"
    };
  } catch (_) { return { ...defaultMatchFilter }; }
}
let matchFilter = readMatchFilter();
const filterModal = $("#filter-modal");
function populateFilterForm() {
  $("#filter-min-age").value = matchFilter.minAge;
  $("#filter-max-age").value = matchFilter.maxAge;
  $("#filter-gender").value = matchFilter.gender;
  $("#filter-error").textContent = "";
}
function openFilter() {
  if (!userProfile) { showProfileSetup(); return; }
  populateFilterForm();
  filterModal.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeFilter() {
  filterModal.hidden = true;
  document.body.style.overflow = "";
}
$("#open-filter").addEventListener("click", openFilter);
$("#close-filter").addEventListener("click", closeFilter);
filterModal.querySelector("[data-close-filter]").addEventListener("click", closeFilter);
$("#reset-filter").addEventListener("click", () => {
  matchFilter = { ...defaultMatchFilter };
  localStorage.removeItem(FILTER_STORAGE_KEY);
  populateFilterForm();
  closeFilter();
  setHomeError("필터가 초기화되었습니다. 모든 연령과 성별이 매칭 대상입니다.");
});
$("#apply-filter").addEventListener("click", () => {
  const minAge = Number($("#filter-min-age").value);
  const maxAge = Number($("#filter-max-age").value);
  const gender = $("#filter-gender").value;
  if (!Number.isInteger(minAge) || !Number.isInteger(maxAge) || minAge < 13 || maxAge > 99 || minAge > maxAge) {
    $("#filter-error").textContent = "연령은 13~99세로 입력하고, 최소 연령은 최대 연령보다 클 수 없습니다.";
    return;
  }
  matchFilter = { active: true, minAge, maxAge, gender };
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(matchFilter));
  closeFilter();
  setHomeError("필터가 저장되었습니다. 다음 매칭부터 서버에서 적용됩니다.");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !filterModal.hidden) closeFilter();
});
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

async function requestCallPermissions() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저에서는 카메라와 마이크를 사용할 수 없습니다. 최신 브라우저와 HTTPS 연결을 확인해 주세요.");
  }

  let audioStream = null;
  let videoStream = null;

  try {
    // 모바일 Chrome에서 권한 요청이 누락되지 않도록 각각 별도로 요청합니다.
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true
    });

    const audioTracks = audioStream.getAudioTracks();
    const videoTracks = videoStream.getVideoTracks();
    if (!audioTracks.length || !videoTracks.length) {
      throw new Error("카메라와 마이크 권한을 모두 허용해야 랜덤통화를 시작할 수 있습니다.");
    }

    // 마이크는 기본 켜짐으로 보존하고, 카메라는 권한만 확인한 뒤 기본 꺼짐으로 둡니다.
    videoTracks.forEach((track) => track.stop());
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    localStream = new MediaStream(audioTracks);
    audioTracks.forEach((track) => { track.enabled = true; });
    cameraOn = false;
    micOn = true;
    $("#local-video").srcObject = null;
    $("#local-video").hidden = true;
    $("#camera-state").textContent = "카메라 꺼짐";
    updateMicButton();
    updateCameraButton();
  } catch (error) {
    audioStream?.getTracks().forEach((track) => track.stop());
    videoStream?.getTracks().forEach((track) => track.stop());
    throw error;
  }
}
async function beginSearch() {
  if (busy) return;
  if (!userProfile) { showProfileSetup(); return; }
  if (!navigator.onLine) {
    setHomeError("인터넷 연결 실패: 인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
    return;
  }
  busy = true;

  // 랜덤통화는 매칭 서버에 접속하기 전에 두 권한을 모두 허용받아야 합니다.
  if (selectedMode === "call") {
    try {
      await requestCallPermissions();
    } catch (error) {
      stopLocalMedia();
      setHomeError(error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
        ? "카메라와 마이크 권한을 모두 허용해야 랜덤통화를 사용할 수 있습니다. 권한을 거부했다면 브라우저 사이트 설정에서 허용해 주세요."
        : "카메라와 마이크를 준비하지 못했습니다: " + error.message);
      busy = false;
      return;
    }
  }

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
    // Mic and camera remain usable while searching; only next-partner is locked.
    $("#mic-toggle").disabled = false;
    $("#camera-toggle").disabled = false;
    $("#next-call").disabled = true;
  }
  $("#matching-mode-label").textContent = selectedMode === "chat" ? "RANDOM CHAT" : "RANDOM CALL";
  $("#matching-description").textContent = "서버에 연결하고 상대를 찾고 있습니다.";
  setMatchingStatus("서버 연결 중");
  try {
    const scope = $('input[name="scope"]:checked').value;
    const data = await api("start", {
      mode: selectedMode,
      scope,
      countryCode: scope === "country" ? $("#country").value : null,
      deviceId,
      profile: userProfile,
      filter: matchFilter,
      exclude20Plus: protectionEnabled,
    });
    sessionToken = data.sessionToken;
    sessionId = data.sessionId;
    setMatchingStatus(data.status === "matched" ? "상대 찾음" : "매칭 대기 중");
    startPolling();
  } catch (error) {
    if (selectedMode === "call") stopLocalMedia();
    show("home");
    if (isNetworkFailure(error)) {
      setHomeError("인터넷 연결 실패: 네트워크가 끊겼거나 너무 느립니다. 연결을 확인한 뒤 다시 매칭해 주세요.");
    } else {
      setHomeError("서버 연결 실패: " + error.message + " (Edge Function 배포와 설정을 확인하세요.)");
    }
  } finally {
    busy = false;
  }
}


function openSettings() {
  if (!userProfile) { showProfileSetup(); return; }
  $("#settings-status").textContent = "";
  show("settings");
  loadSettingsProfile();
}
async function loadSettingsProfile() {
  const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
  const needsLegacyDate = !userProfile.registeredAt || !Number.isInteger(userProfile.registeredYear);
  if (!Number.isInteger(userProfile.registeredYear)) userProfile.registeredYear = currentYear;
  if (!userProfile.registeredAt) userProfile.registeredAt = new Date().toISOString();
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(userProfile));

  const renderProfile = () => {
    $("#settings-gender").textContent = userProfile.gender === "female" ? "여성" : "남성";
    $("#settings-age").textContent = (userProfile.initialAge + currentYear - userProfile.registeredYear) + "세";
    const joined = new Date(userProfile.registeredAt);
    $("#settings-joined").textContent = Number.isNaN(joined.getTime()) ? "확인 불가" :
      new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(joined);
  };
  renderProfile();

  // 과거 버전 사용자라면 서버에 이미 저장된 실제 가입일을 가져와 보정합니다.
  if (needsLegacyDate) {
    try {
      const data = await api("get-profile", { deviceId });
      if (data.profile?.createdAt) {
        userProfile.registeredAt = data.profile.createdAt;
        userProfile.registeredYear = currentYear - (data.profile.currentAge - userProfile.initialAge);
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(userProfile));
        renderProfile();
      }
    } catch (_) {
      // 첫 매칭 전 계정은 서버 프로필이 없으므로 로컬 가입일을 그대로 사용합니다.
    }
  }
}
$("#open-settings").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", () => show("home"));
$("#protection-toggle").checked = protectionEnabled;
$("#protection-toggle").addEventListener("change", () => {
  protectionEnabled = $("#protection-toggle").checked;
  localStorage.setItem(PROTECTION_STORAGE_KEY, String(protectionEnabled));
  $("#settings-status").textContent = "변경 사항을 저장했습니다.";
});

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
    lastCallRoomId = String(data.room.id);
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
        const failedRoomId = String(data.room.id);
        cleanupCall(true);
        callSetupRoom = failedRoomId;
        $("#next-call").disabled = false;
        setCallStatus("통화 초기화 실패: " + error.message + " · 다음 상대를 선택해 다시 시도할 수 있습니다.");
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
  // Preserve any mic/camera tracks the user enabled while waiting.
  cleanupCall(true);
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
  if (audioTrack) {
    audioTrack.enabled = micOn;
    await audioSender.replaceTrack(audioTrack);
  }
  const videoTrack = localStream?.getVideoTracks()[0] || null;
  if (videoTrack) {
    videoTrack.enabled = cameraOn;
    await videoSender.replaceTrack(videoTrack);
  }
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
  if (!sessionToken || busy || pollBusy) return;
  pollBusy = true;
  try {
    const lastRoomId = selectedMode === "chat" ? currentChatRoomId : lastCallRoomId;
    const pollExtra = lastRoomId ? { lastRoomId } : {};
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
    } else if (selectedMode === "call" && $("#call").classList.contains("active")) {
      if (data.partnerLeft && (currentRoomId || peerConnection)) {
        cleanupCall(true);
        $("#next-call").disabled = true;
        setCallStatus("상대방이 퇴장했습니다. 새로운 상대를 찾고 있습니다.");
      }
      $("#remote-state").textContent = "상대방을 찾고 있는 중...";
      $("#call-room-status").textContent = "상대 찾는 중";
    } else if ($("#matching").classList.contains("active")) {
      setMatchingStatus("매칭 대기 중");
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
  } finally {
    pollBusy = false;
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
  lastCallRoomId = "";
  stopLocalMedia();
  cleanupCall();
  if (selectedMode === "call") {
    $("#remote-video").srcObject = null;
    $("#remote-video").hidden = true;
    $("#remote-avatar").hidden = false;
    $("#remote-state").textContent = "상대방을 찾고 있는 중...";
    $("#call-room-status").textContent = "상대 찾는 중";
    $("#call-status").textContent = "새로운 상대를 찾고 있습니다.";
    $("#mic-toggle").disabled = false;
    $("#camera-toggle").disabled = false;
    $("#next-call").disabled = true;
  }
  chatPartnerAvailable = false;
  $("#message-input").disabled = true;
  $("#chat-form button").disabled = true;
  setChatNotice("새로운 상대를 찾고 있습니다.");
  $("#messages").replaceChildren();
  show(selectedMode === "call" ? "call" : "matching");
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
  lastCallRoomId = "";
  chatPartnerAvailable = false;
  lastChatNotice = "";
  setChatNotice("");
  $("#message-input").value = "";
  $("#message-input").disabled = true;
  $("#chat-form button").disabled = true;
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
function cleanupCall(preserveLocalMedia = false) {
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
  if (!preserveLocalMedia) stopLocalMedia();
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
$("#next-chat").addEventListener("click", nextMatch);
$("#next-call").addEventListener("click", nextMatch);
$("#end-waiting").addEventListener("click", endMatch);
$("#end-chat").addEventListener("click", endMatch);
$("#end-call").addEventListener("click", endMatch);
$("#chat-form").addEventListener("submit", sendMessage);
$("#mic-toggle").addEventListener("click", toggleMic);
$("#camera-toggle").addEventListener("click", toggleCamera);
updateMicButton();
updateCameraButton();
window.addEventListener("pagehide", () => {
  // Best-effort server cleanup prevents a closed tab from remaining in the queue.
  if (sessionToken) {
    fetch(RF_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": RF_PUBLISHABLE_KEY,
        "Authorization": "Bearer " + RF_PUBLISHABLE_KEY
      },
      body: JSON.stringify({ action: "end", sessionToken }),
      keepalive: true
    }).catch(() => {});
  }
  stopPolling();
  cleanupCall();
});


let deferredInstallPrompt = null;
const installButton = $("#install-app");
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    alert("현재 브라우저에서 바로 설치 창을 열 수 없습니다. Chrome 메뉴(⋮)에서 '앱 설치' 또는 '홈 화면에 추가'를 선택해 주세요. 이미 설치했거나 설치 조건을 아직 충족하지 않은 경우에도 이 안내가 표시됩니다.");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
});
if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true) {
  installButton.hidden = true;
}

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
// ==========================================
// [설정 1] 앱이 켜질 때 Supabase에서 체크박스 상태를 불러오는 함수
// ==========================================
async function loadExclude20PlusSetting(deviceId) {
  try {
    const { data, error } = await supabase
      .from('rf_profiles')
      .select('exclude_20_plus')
      .eq('device_id', deviceId)
      .single();

    if (error) {
      console.error('설정 불러오기 실패:', error.message);
      return;
    }

    // HTML에 있는 체크박스 요소 선택 (id가 'exclude20PlusCheckbox'라고 가정)
    const checkbox = document.getElementById('exclude20PlusCheckbox');
    if (checkbox && data) {
      checkbox.checked = data.exclude_20_plus;
    }
  } catch (err) {
    console.error('설정 로드 중 예외 발생:', err);
  }
}

// ==========================================
// [설정 2] 체크박스를 켜거나 껐을 때 Supabase DB를 업데이트하는 함수
// ==========================================
async function updateExclude20PlusSetting(deviceId, isChecked) {
  try {
    const { error } = await supabase
      .from('rf_profiles')
      .update({ 
        exclude_20_plus: isChecked,
        updated_at: new Date().toISOString()
      })
      .eq('device_id', deviceId);

    if (error) {
      console.error('설정 저장 실패:', error.message);
    } else {
      console.log('설정 저장 성공:', isChecked);
    }
  } catch (err) {
    console.error('설정 저장 중 예외 발생:', err);
  }
}

// ==========================================
// [설정 3] 체크박스 클릭 이벤트 자동 연결 (HTML과 연동)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // 사용자의 고유 디바이스 ID를 가져오는 방식에 맞게 수정하세요 (예: localStorage 등)
  const currentDeviceId = localStorage.getItem('device_id') || '내_디바이스_ID_값';

  // 1. 페이지가 켜지면 값 불러와서 체크박스에 반영
  loadExclude20PlusSetting(currentDeviceId);

  // 2. 체크박스 상태가 바뀔 때마다 DB에 즉시 업데이트
  const checkbox = document.getElementById('exclude20PlusCheckbox');
  if (checkbox) {
    checkbox.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      updateExclude20PlusSetting(currentDeviceId, isChecked);
    });
  }
});
