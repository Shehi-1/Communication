const authScreen = document.querySelector("#auth-screen");
const chatScreen = document.querySelector("#chat-screen");
const authForm = document.querySelector("#auth-form");
const authStatus = document.querySelector("#auth-status");
const usernameField = document.querySelector("#username-field");
const usernameInput = document.querySelector("#auth-username");
const identifierField = document.querySelector("#identifier-field");
const phoneInput = document.querySelector("#auth-phone");
const passwordInput = document.querySelector("#auth-password");
const authSubmit = document.querySelector("#auth-submit");
const passwordHint = document.querySelector("#password-hint");
const registrationAvatarField = document.querySelector("#registration-avatar-field");
const registrationAvatarInput = document.querySelector("#registration-avatar");
const workspace = document.querySelector(".workspace");
const messagesElement = document.querySelector("#messages");
const messageStatus = document.querySelector("#message-status");
const attachmentPreview = document.querySelector("#attachment-preview");
const uploadProgress = document.querySelector("#upload-progress");
const callDialog = document.querySelector("#call-dialog");
const callDialogStatus = document.querySelector("#call-dialog-status");
const callDialogError = document.querySelector("#call-dialog-error");
const callHistory = document.querySelector("#call-history");
const callHistoryList = document.querySelector("#call-history-list");
const callVideoStage = document.querySelector("#call-video-stage");
const remoteCallVideo = document.querySelector("#remote-call-video");
const localCallVideo = document.querySelector("#local-call-video");
const remoteCallAudio = document.querySelector("#remote-call-audio");
const contactDialog = document.querySelector("#contact-dialog");
const statusFeed = document.querySelector("#status-feed");
const statusFeedState = document.querySelector("#status-feed-state");
const statusCreateDialog = document.querySelector("#status-create-dialog");
const statusCreateForm = document.querySelector("#status-create-form");
const statusPhotoInput = document.querySelector("#status-photo");
const statusPhotoPreview = document.querySelector("#status-photo-preview");
const statusUploadProgress = document.querySelector("#status-upload-progress");
const statusViewerDialog = document.querySelector("#status-viewer-dialog");

let authMode = "login";
let settingsCodeSent = false;
let csrfToken = "";
let currentUser = null;
let activeConversation = null;
let lastRenderedMessageId = 0;
let conversationRefreshRunning = false;
let messageRefreshRunning = false;
let pendingMedia = null;
let recordingContext = null;
let recordingSource = null;
let recordingProcessor = null;
let recordingStream = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let recordingTimer = null;
let cancelRecording = false;
let readReceiptObserver = null;
let readReceiptTimer = null;
let readMarkedIds = new Set();
let readPendingIds = new Set();
let lastStatusSignature = "";
let currentCall = null;
let peerConnection = null;
let localMediaStream = null;
let remoteMediaStream = null;
let remoteOfferPayload = null;
let pendingIceCandidates = [];
let callEventCursor = 0;
let callPollRunning = false;
let callDurationTimer = null;
let callConnectionTimer = null;
let cameraFacingMode = "user";
let cameraEnabled = true;
let callStartedAt = 0;
let statusRefreshRunning = false;
let statusPreviewUrl = "";
let activeViewedStatus = null;

async function request(path, { method = "GET", body, formData, authenticated = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: formData || (body === undefined ? undefined : JSON.stringify(body))
  });
  if (response.status === 204) return null;
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `The server returned a non-JSON response (HTTP ${response.status}). Refresh the page and try again.`
    );
  }
  if (!response.ok) {
    if (response.status === 401 && authenticated) showSignedOut();
    throw new Error(data.error || "The request could not be completed.");
  }
  return data;
}

function uploadRequest(path, formData, progressElement, statusElement) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    if (progressElement) {
      progressElement.hidden = false;
      progressElement.value = 0;
    }
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      if (progressElement) progressElement.value = percent;
      if (statusElement) setStatus(statusElement, `Uploading… ${percent}%`);
    });
    xhr.addEventListener("load", () => {
      let data;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        reject(new Error("The server returned an invalid response."));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 401) showSignedOut();
        reject(new Error(data?.error || "The upload could not be completed."));
        return;
      }
      resolve(data);
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed. Check your connection and try again.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    xhr.send(formData);
  });
}

function setStatus(element, message, type = "") {
  element.textContent = message;
  element.className = `${element.className.replace(/\s(error|success)/g, "")} ${type}`.trim();
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  usernameField.hidden = !registering;
  usernameInput.required = registering;
  identifierField.hidden = registering;
  phoneInput.required = !registering;
  registrationAvatarField.hidden = !registering;
  registrationAvatarInput.required = registering;
  passwordInput.autocomplete = registering ? "new-password" : "current-password";
  passwordHint.hidden = !registering;
  authSubmit.textContent = registering ? "Create account" : "Sign in";
  document.querySelectorAll(".mode-button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  setStatus(authStatus, "");
}

function validateImageFile(file, maxBytes = 5 * 1024 * 1024) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!file || !allowedTypes.includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size > maxBytes) throw new Error("Images must be no larger than 5 MB.");
}

function showImagePreview(file, imageElement, previewElement = null) {
  try {
    validateImageFile(file);
    imageElement.src = URL.createObjectURL(file);
    imageElement.hidden = false;
    if (previewElement) previewElement.hidden = false;
    return true;
  } catch (error) {
    setStatus(authMode === "register" ? authStatus : document.querySelector("#profile-status"), error.message, "error");
    return false;
  }
}

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.mode));
});

registrationAvatarInput.addEventListener("change", () => {
  const file = registrationAvatarInput.files[0];
  if (file) showImagePreview(file, document.querySelector("#registration-avatar-preview"));
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(authStatus, authMode === "register" ? "Creating your account…" : "Signing in…");
  authSubmit.disabled = true;
  try {
    let data;
    if (authMode === "register") {
      const avatar = registrationAvatarInput.files[0];
      validateImageFile(avatar);
      const formData = new FormData();
      formData.append("username", usernameInput.value.trim());
      formData.append("password", passwordInput.value);
      formData.append("avatar", avatar);
      data = await request("/register/start", { method: "POST", formData });
      currentUser = data.user;
      csrfToken = data.csrfToken;
      passwordInput.value = "";
      registrationAvatarInput.value = "";
      await showSignedIn();
    } else {
      data = await request("/login", {
        method: "POST",
        body: { identifier: phoneInput.value.trim(), password: passwordInput.value }
      });
      csrfToken = data.csrfToken;
      currentUser = data.user;
      passwordInput.value = "";
      await showSignedIn();
    }
  } catch (error) {
    setStatus(authStatus, error.message, "error");
  } finally {
    authSubmit.disabled = false;
  }
});

async function showSignedIn() {
  authScreen.hidden = true;
  chatScreen.hidden = false;
  document.querySelector("#current-username").textContent = currentUser.username;
  renderAvatar(document.querySelector("#current-avatar"), currentUser, true);
  try {
    const settings = await request("/settings", { authenticated: true });
    applyTheme(settings.settings.theme);
  } catch (error) {
    setStatus(document.querySelector("#global-status"), error.message, "error");
  }
  try {
    await refreshConversations();
  } catch (error) {
    setStatus(document.querySelector("#global-status"), error.message, "error");
  }
  try {
    await refreshStatuses();
  } catch (error) {
    setStatus(statusFeedState, `Could not load statuses: ${error.message}`, "error");
  }
  callEventCursor = 0;
  await pollCalls(true);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function showSignedOut() {
  if (recordingContext) stopVoiceRecording(true);
  stopCallMedia();
  currentCall = null;
  callDialog.close();
  currentUser = null;
  activeConversation = null;
  callEventCursor = 0;
  csrfToken = "";
  lastRenderedMessageId = 0;
  workspace.classList.remove("chat-open");
  document.querySelector("#active-chat").hidden = true;
  messagesElement.replaceChildren();
  renderConnections([]);
  renderConversations([]);
  document.querySelector("#search-results").replaceChildren();
  document.querySelector("#user-search").value = "";
  setStatus(document.querySelector("#search-status"), "");
  document.querySelector("#current-username").textContent = "";
  document.querySelector("#current-avatar").replaceChildren();
  phoneInput.value = "";
  passwordInput.value = "";
  usernameInput.value = "";
  registrationAvatarInput.value = "";
  if (profileDialog.open) profileDialog.close();
  readReceiptObserver?.disconnect();
  readMarkedIds.clear();
  readPendingIds.clear();
  lastStatusSignature = "";
  activeViewedStatus = null;
  statusFeed.replaceChildren();
  setStatus(statusFeedState, "");
  if (statusCreateDialog.open) statusCreateDialog.close();
  if (statusViewerDialog.open) statusViewerDialog.close();
  setStatus(document.querySelector("#global-status"), "");
  clearPendingMedia();
  return request("/session").then((data) => {
    csrfToken = data.csrfToken;
    chatScreen.hidden = true;
    authScreen.hidden = false;
    setStatus(authStatus, "Your session ended. Please sign in again.", "error");
  }).catch((error) => {
    chatScreen.hidden = true;
    authScreen.hidden = false;
    setStatus(authStatus, `${error.message} Refresh the page to try again.`, "error");
  });
}

function callIsActive(call = currentCall) {
  return call && ["ringing", "connecting", "connected"].includes(call.status);
}

function isTerminalCallStatus(status) {
  return ["declined", "missed", "ended", "connection_error"].includes(status);
}

function openCallDialog() {
  if (!callDialog.open) callDialog.showModal();
}

function setCallDialogState(status, call = currentCall, error = "") {
  const otherUser = call?.otherUser || activeConversation;
  const actualCallType = call?.callType || currentCall?.callType || "voice";
  const callType = actualCallType === "video" ? "Video call" : "Voice call";
  const incoming = call?.recipient?.id === currentUser?.id && status === "ringing";
  document.querySelector("#call-dialog-title").textContent = incoming
    ? `${call.caller.username} is calling`
    : `${otherUser?.username || "Friend"} · ${callType}`;
  const labels = {
    ringing: incoming ? `Incoming ${actualCallType} call` : "Calling… waiting for them to answer.",
    connecting: "The call was answered. Connecting audio and video…",
    connected: "Connected",
    declined: "Call declined.",
    missed: "Call missed. You can try again.",
    ended: "Call ended.",
    connection_error: "Call connection error."
  };
  callDialogStatus.textContent = labels[status] || status;
  callDialogError.textContent = error;
  callDialogError.hidden = !error;
  callVideoStage.hidden = call?.callType !== "video";
  document.querySelector("#call-video-placeholder").hidden =
    Boolean(remoteCallVideo.srcObject?.getVideoTracks?.().length);
  document.querySelector("#answer-call-button").hidden = !incoming;
  document.querySelector("#answer-call-button").disabled = incoming && !remoteOfferPayload;
  if (incoming && !remoteOfferPayload) {
    callDialogStatus.textContent = `Incoming ${actualCallType} call · waiting for connection…`;
  }
  document.querySelector("#decline-call-button").hidden = !incoming;
  document.querySelector("#mute-call-button").hidden = status !== "connected" || !localMediaStream;
  const hasCamera = Boolean(localMediaStream?.getVideoTracks().length);
  document.querySelector("#camera-call-button").hidden =
    status !== "connected" || call?.callType !== "video" || !hasCamera;
  document.querySelector("#switch-camera-button").hidden =
    status !== "connected" || call?.callType !== "video" || !hasCamera;
  document.querySelector("#end-call-button").hidden = !callIsActive(call);
  document.querySelector("#call-dismiss-button").hidden = !isTerminalCallStatus(status);
  document.querySelector("#call-duration").hidden = status !== "connected";
  document.querySelector("#mute-call-button").textContent =
    localMediaStream?.getAudioTracks().some((track) => track.enabled)
      ? "Mute microphone"
      : "Unmute microphone";
  document.querySelector("#camera-call-button").textContent =
    cameraEnabled ? "Turn camera off" : "Turn camera on";
  if (status === "connected") startCallDurationTimer(call);
  else stopCallDurationTimer();
  if (call) openCallDialog();
}

function startCallDurationTimer(call) {
  if (!callDurationTimer) {
    callStartedAt = Date.parse(call.connectedAt) || Date.now();
    const update = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
      const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const seconds = String(elapsed % 60).padStart(2, "0");
      document.querySelector("#call-duration").textContent = `${minutes}:${seconds}`;
    };
    update();
    callDurationTimer = window.setInterval(update, 1000);
  }
}

function stopCallDurationTimer() {
  if (callDurationTimer) window.clearInterval(callDurationTimer);
  callDurationTimer = null;
}

function stopCallMedia() {
  if (callConnectionTimer) window.clearTimeout(callConnectionTimer);
  callConnectionTimer = null;
  stopCallDurationTimer();
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  }
  peerConnection = null;
  localMediaStream?.getTracks().forEach((track) => track.stop());
  localMediaStream = null;
  remoteMediaStream = null;
  remoteOfferPayload = null;
  pendingIceCandidates = [];
  cameraEnabled = true;
  localCallVideo.srcObject = null;
  remoteCallVideo.srcObject = null;
  remoteCallAudio.srcObject = null;
}

function mediaPermissionMessage(error, callType) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return `Allow ${callType === "video" ? "camera and microphone" : "microphone"} access in your browser to continue.`;
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return `No ${callType === "video" ? "camera or microphone" : "microphone"} was found. Check your device and try again.`;
  }
  if (error?.name === "NotReadableError") {
    return "Your microphone or camera is already in use by another app.";
  }
  return "Could not access your microphone or camera. Check browser permissions and try again.";
}

async function requestCallMedia(callType) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Calling requires a secure connection (HTTPS or localhost) and a supported browser.");
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === "video" ? { facingMode: { ideal: cameraFacingMode } } : false
    });
    localMediaStream = stream;
    localCallVideo.srcObject = stream;
    return stream;
  } catch (error) {
    throw new Error(mediaPermissionMessage(error, callType));
  }
}

function setupPeerConnection(call) {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  if (localMediaStream) {
    localMediaStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localMediaStream);
    });
  }
  peerConnection.ontrack = (event) => {
    if (!remoteMediaStream) remoteMediaStream = new MediaStream();
    if (!remoteMediaStream.getTracks().some((track) => track.id === event.track.id)) {
      remoteMediaStream.addTrack(event.track);
    }
    const stream = event.streams[0] || remoteMediaStream;
    if (call.callType === "video") {
      remoteCallVideo.srcObject = stream;
      document.querySelector("#call-video-placeholder").hidden =
        stream.getVideoTracks().length > 0;
    } else {
      remoteCallAudio.srcObject = stream;
      remoteCallAudio.play().catch(() => {
        callDialogError.textContent = "Audio playback was blocked. Allow playback in your browser and retry.";
        callDialogError.hidden = false;
      });
    }
  };
  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || !currentCall || !callIsActive()) return;
    request(`/calls/${currentCall.id}/signals`, {
      method: "POST",
      body: { kind: "ice", payload: event.candidate.toJSON() },
      authenticated: true
    }).catch((error) => failCall(error.message));
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection?.connectionState === "connected" &&
        currentCall?.status !== "connected" && callIsActive()) {
      request(`/calls/${currentCall.id}/connected`, {
        method: "POST",
        authenticated: true
      }).then((data) => {
        currentCall = data.call;
        setCallDialogState("connected", currentCall);
      }).catch((error) => failCall(error.message));
    }
    if (peerConnection?.connectionState === "connected" && callConnectionTimer) {
      window.clearTimeout(callConnectionTimer);
      callConnectionTimer = null;
    }
    if (peerConnection?.connectionState === "disconnected" && !callConnectionTimer) {
      callConnectionTimer = window.setTimeout(() => {
        if (peerConnection?.connectionState === "disconnected") {
          failCall("The call connection was lost. Check your internet connection.");
        }
      }, 8000);
    }
    if (peerConnection?.connectionState === "failed") {
      failCall("The network could not establish a private call connection. Check your connection and try again.");
    }
  };
  callVideoStage.hidden = call.callType !== "video";
  const hasRemoteVideo = Boolean(remoteCallVideo.srcObject?.getVideoTracks?.().some((t) => t.enabled));
  document.querySelector("#call-video-placeholder").hidden = hasRemoteVideo;
}

async function flushIceCandidates() {
  if (!peerConnection?.remoteDescription) return;
  const queued = pendingIceCandidates;
  pendingIceCandidates = [];
  for (const candidate of queued) {
    await peerConnection.addIceCandidate(candidate);
  }
}

async function receiveCallSignal(event) {
  if (!currentCall || event.callId !== currentCall.id) return;
  try {
    if (event.kind === "offer" && currentCall.recipient.id === currentUser.id) {
      remoteOfferPayload = event.payload;
      setCallDialogState("ringing", currentCall);
    } else if (event.kind === "answer" && peerConnection) {
      await peerConnection.setRemoteDescription(event.payload);
      await flushIceCandidates();
    } else if (event.kind === "ice") {
      if (peerConnection?.remoteDescription) {
        await peerConnection.addIceCandidate(event.payload);
      } else {
        pendingIceCandidates.push(event.payload);
      }
    }
  } catch (error) {
    failCall(`Could not establish the call: ${error.message}`);
  }
}

async function handleCallEvent(event) {
  if (event.kind !== "state") {
    await receiveCallSignal(event);
    return;
  }
  const status = event.payload.status;
  if (currentCall && currentCall.id !== event.callId && callIsActive()) return;
  currentCall = { ...event.call, status };
  if (status === "connected") {
    setCallDialogState(status);
  } else if (status === "connecting") {
    setCallDialogState(status);
  } else if (status === "ringing") {
    setCallDialogState(status);
  } else if (isTerminalCallStatus(status)) {
    stopCallMedia();
    setCallDialogState(status, currentCall);
    if (activeConversation?.id === currentCall.otherUser.id) {
      refreshCallHistory(activeConversation.id).catch((error) => {
        setStatus(messageStatus, error.message, "error");
      });
    }
  }
}

async function pollCalls(initial = false) {
  if (!currentUser || callPollRunning) return;
  callPollRunning = true;
  try {
    const data = await request(`/calls/updates?after=${callEventCursor}`, {
      authenticated: true
    });
    if (initial) {
      callEventCursor = data.latestEventId;
      if (data.activeCall) {
        currentCall = data.activeCall;
        if (currentCall.status === "connected" || currentCall.status === "connecting" ||
            currentCall.caller.id === currentUser.id) {
          await request(`/calls/${currentCall.id}/end`, {
            method: "POST",
            body: { connectionError: true },
            authenticated: true
          });
          currentCall.status = "connection_error";
          setCallDialogState("connection_error", currentCall, "The page was refreshed during this call.");
          refreshCallHistory(currentCall.otherUser.id).catch(() => {});
        } else {
          for (const signal of data.activeSignals) {
            if (signal.callId !== currentCall.id) continue;
            if (signal.kind === "offer") remoteOfferPayload = signal.payload;
            if (signal.kind === "ice") pendingIceCandidates.push(signal.payload);
          }
          setCallDialogState(currentCall.status);
        }
      }
      return;
    }
    for (const event of data.events) {
      callEventCursor = Math.max(callEventCursor, event.id);
      if (!currentCall || currentCall.id === event.callId || !callIsActive()) {
        if (event.kind === "state") currentCall = currentCall?.id === event.callId ? currentCall : event.call;
        await handleCallEvent(event);
      }
    }
    if (data.activeCall && (!currentCall || !callIsActive())) {
      currentCall = data.activeCall;
      setCallDialogState(currentCall.status);
    }
  } catch (error) {
    if (error.message !== "Please sign in to continue.") {
      setStatus(document.querySelector("#global-status"), error.message, "error");
    }
  } finally {
    callPollRunning = false;
  }
}

async function refreshCallHistory(userId) {
  const data = await request(`/conversations/${userId}/calls`, { authenticated: true });
  callHistoryList.replaceChildren(...data.calls.map((call) => {
    const item = document.createElement("li");
    if (call.status === "missed") item.classList.add("missed");
    const label = call.status === "missed"
      ? "Missed"
      : call.status === "declined"
        ? "Declined"
        : call.status === "connection_error"
          ? "Connection error"
          : call.status === "ended" && call.durationSeconds > 0
            ? "Completed"
            : "Ended";
    const type = call.callType === "video" ? "video" : "voice";
    const duration = call.durationSeconds > 0
      ? ` · ${Math.floor(call.durationSeconds / 60)}:${String(call.durationSeconds % 60).padStart(2, "0")}`
      : "";
    item.textContent = `${call.otherUser.username} · ${label} ${type} · ${new Date(call.createdAt).toLocaleString()}${duration}`;
    return item;
  }));
  callHistory.hidden = data.calls.length === 0;
}

async function startCall(callType) {
  if (!activeConversation || callIsActive()) return;
  const buttons = [
    document.querySelector("#voice-call-button"),
    document.querySelector("#video-call-button")
  ];
  buttons.forEach((button) => { button.disabled = true; });
  callDialogError.hidden = true;
  callDialogStatus.textContent = `Requesting ${callType === "video" ? "camera and microphone" : "microphone"} access…`;
  if (!callDialog.open) callDialog.showModal();
  try {
    await requestCallMedia(callType);
    const data = await request("/calls", {
      method: "POST",
      body: { recipientId: activeConversation.id, callType },
      authenticated: true
    });
    currentCall = data.call;
    if (currentCall.status === "missed") {
      stopCallMedia();
      setCallDialogState("missed", currentCall);
      await refreshCallHistory(activeConversation.id);
      return;
    }
    setCallDialogState("ringing", currentCall);
    setupPeerConnection(currentCall);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await request(`/calls/${currentCall.id}/signals`, {
      method: "POST",
      body: { kind: "offer", payload: peerConnection.localDescription.toJSON() },
      authenticated: true
    });
    await refreshCallHistory(activeConversation.id);
  } catch (error) {
    if (currentCall && callIsActive()) await failCall(error.message);
    else {
      stopCallMedia();
      setCallDialogState("connection_error", null, error.message);
    }
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function answerCall() {
  if (!currentCall || currentCall.recipient.id !== currentUser.id) return;
  const call = currentCall;
  const answerButton = document.querySelector("#answer-call-button");
  answerButton.disabled = true;
  callDialogStatus.textContent = "Connecting…";
  callDialogError.hidden = true;
  try {
    await requestCallMedia(call.callType);
    setupPeerConnection(call);
    if (!remoteOfferPayload) throw new Error("The caller's connection offer was not received. Please ask them to try again.");
    await peerConnection.setRemoteDescription(remoteOfferPayload);
    await flushIceCandidates();
    const data = await request(`/calls/${call.id}/answer`, {
      method: "POST",
      authenticated: true
    });
    currentCall = data.call;
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await request(`/calls/${call.id}/signals`, {
      method: "POST",
      body: { kind: "answer", payload: peerConnection.localDescription.toJSON() },
      authenticated: true
    });
    setCallDialogState("connecting", currentCall);
  } catch (error) {
    await failCall(error.message);
  } finally {
    answerButton.disabled = false;
  }
}

async function declineCall() {
  if (!currentCall) return;
  try {
    await request(`/calls/${currentCall.id}/decline`, {
      method: "POST",
      authenticated: true
    });
    currentCall.status = "declined";
    setCallDialogState("declined", currentCall);
    await refreshCallHistory(currentCall.otherUser.id);
  } catch (error) {
    setCallDialogState("connection_error", currentCall, error.message);
  }
}

async function finishCall(connectionError = false, message = "") {
  if (!currentCall) {
    setCallDialogState("connection_error", null, message);
    return;
  }
  const call = currentCall;
  if (callIsActive(call)) {
    try {
      await request(`/calls/${call.id}/end`, {
        method: "POST",
        body: { connectionError },
        authenticated: true
      });
    } catch (error) {
      message = message || error.message;
      connectionError = true;
    }
  }
  currentCall.status = connectionError ? "connection_error" : "ended";
  stopCallMedia();
  setCallDialogState(currentCall.status, currentCall, message);
  await refreshCallHistory(currentCall.otherUser.id).catch((error) => {
    setStatus(document.querySelector("#global-status"), error.message, "error");
  });
}

function failCall(message) {
  return finishCall(true, message);
}

function showContactProfile() {
  if (!activeConversation) return;
  document.querySelector("#contact-profile-name").textContent = activeConversation.username;
  renderAvatar(document.querySelector("#contact-profile-avatar"), activeConversation);
  contactDialog.showModal();
}

document.querySelector("#close-chat-button")?.addEventListener("click", closeActiveConversation);
document.querySelector("#chat-profile-button").addEventListener("click", showContactProfile);
document.querySelector("#contact-profile-close").addEventListener("click", () => contactDialog.close());
document.querySelector("#voice-call-button").addEventListener("click", () => startCall("voice"));
document.querySelector("#video-call-button").addEventListener("click", () => startCall("video"));
document.querySelector("#profile-voice-call-button").addEventListener("click", () => {
  contactDialog.close();
  startCall("voice");
});
document.querySelector("#profile-video-call-button").addEventListener("click", () => {
  contactDialog.close();
  startCall("video");
});
document.querySelector("#answer-call-button").addEventListener("click", answerCall);
document.querySelector("#decline-call-button").addEventListener("click", declineCall);
document.querySelector("#end-call-button").addEventListener("click", () => finishCall());
document.querySelector("#call-dismiss-button").addEventListener("click", () => callDialog.close());
callDialog.addEventListener("cancel", (event) => {
  if (callIsActive()) event.preventDefault();
});
document.querySelector("#mute-call-button").addEventListener("click", () => {
  if (!localMediaStream) return;
  const shouldEnable = !localMediaStream.getAudioTracks().some((track) => track.enabled);
  localMediaStream.getAudioTracks().forEach((track) => { track.enabled = shouldEnable; });
  document.querySelector("#mute-call-button").textContent =
    shouldEnable ? "Mute microphone" : "Unmute microphone";
});
document.querySelector("#camera-call-button").addEventListener("click", () => {
  const track = localMediaStream?.getVideoTracks()[0];
  if (!track) return;
  cameraEnabled = !cameraEnabled;
  track.enabled = cameraEnabled;
  document.querySelector("#camera-call-button").textContent =
    cameraEnabled ? "Turn camera off" : "Turn camera on";
});
document.querySelector("#switch-camera-button").addEventListener("click", async () => {
  const oldTrack = localMediaStream?.getVideoTracks()[0];
  if (!oldTrack || !peerConnection) return;
  const nextFacing = cameraFacingMode === "user" ? "environment" : "user";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: nextFacing } }
    });
    const newTrack = stream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find((item) => item.track?.kind === "video");
    if (!sender || !newTrack) throw new Error("Could not switch cameras on this device.");
    await sender.replaceTrack(newTrack);
    localMediaStream.removeTrack(oldTrack);
    localMediaStream.addTrack(newTrack);
    oldTrack.stop();
    newTrack.enabled = cameraEnabled;
    localCallVideo.srcObject = localMediaStream;
    setCallDialogState("connected", currentCall);
    cameraFacingMode = nextFacing;
  } catch (error) {
    callDialogError.textContent = error.name === "Error"
      ? error.message
      : mediaPermissionMessage(error, "video");
    callDialogError.hidden = false;
  }
});

function renderAvatar(container, user, large = false) {
  container.replaceChildren();
  container.className = large ? "avatar avatar-large" : "avatar";
  if (user.avatarUrl) {
    const image = document.createElement("img");
    image.className = "avatar";
    image.src = user.avatarUrl;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    container.append(image);
  } else {
    container.textContent = user.username.charAt(0).toUpperCase();
  }
}

function statusTimeAgo(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusTimeRemaining(value) {
  const minutes = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 60_000));
  if (!minutes) return "Expires soon";
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Expires in ${hours}h`;
  return `Expires in ${Math.ceil(hours / 24)}d`;
}

function renderStatusFeed(statuses) {
  statusFeed.replaceChildren();
  for (const status of statuses) {
    const isOwner = Boolean(
      status.isOwner ||
      (status.user && currentUser && (
        Number(status.user.id) === Number(currentUser.id) ||
        status.user.username === currentUser.username
      ))
    );
    const item = document.createElement("div");
    item.className = "status-card";
    item.setAttribute("role", "listitem");

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "status-card-open";
    openButton.setAttribute(
      "aria-label",
      `${isOwner ? "Your" : `${status.user.username}'s`} status, posted ${statusTimeAgo(status.createdAt)}`
    );
    const avatarRing = document.createElement("span");
    avatarRing.className = "status-card-avatar";
    const avatar = document.createElement("span");
    renderAvatar(avatar, status.user);
    avatarRing.append(avatar);
    const name = document.createElement("span");
    name.className = "status-card-name";
    name.textContent = isOwner ? "Your status" : status.user.username;
    const detail = document.createElement("span");
    detail.className = "status-card-detail";
    detail.textContent = isOwner
      ? `${status.viewerCount || 0} views`
      : statusTimeAgo(status.createdAt);
    openButton.append(avatarRing, name, detail);
    openButton.addEventListener("click", () => openStatus(status.id));

    item.append(openButton);

    if (isOwner) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "status-card-delete";
      deleteBtn.setAttribute("aria-label", "Delete this status");
      deleteBtn.title = "Delete status";
      deleteBtn.textContent = "🗑";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Are you sure you want to delete this status?")) return;
        deleteBtn.disabled = true;
        try {
          await request(`/statuses/${status.id}`, { method: "DELETE", authenticated: true });
          await refreshStatuses();
        } catch (err) {
          alert(`Could not delete status: ${err.message}`);
          deleteBtn.disabled = false;
        }
      });
      item.append(deleteBtn);
    }

    statusFeed.append(item);
  }
  setStatus(
    statusFeedState,
    statuses.length ? "" : "No active statuses yet. Share a photo or note with your connections."
  );
}

async function refreshStatuses() {
  if (!currentUser || statusRefreshRunning) return;
  statusRefreshRunning = true;
  try {
    const data = await request("/statuses", { authenticated: true });
    renderStatusFeed(data.statuses);
  } finally {
    statusRefreshRunning = false;
  }
}

function renderStatusViewers(viewers) {
  const list = document.querySelector("#status-viewer-list");
  list.replaceChildren();
  for (const viewer of viewers) {
    const item = document.createElement("li");
    const avatar = document.createElement("span");
    renderAvatar(avatar, viewer);
    const name = document.createElement("strong");
    name.textContent = viewer.username;
    const time = document.createElement("span");
    time.textContent = new Date(viewer.viewedAt).toLocaleString();
    item.append(avatar, name, time);
    list.append(item);
  }
  document.querySelector("#status-viewer-empty").hidden = viewers.length > 0;
  document.querySelector("#status-viewer-list-heading").textContent =
    `Viewed by ${viewers.length}`;
}

async function openStatus(statusId) {
  statusViewerDialog.showModal();
  activeViewedStatus = null;
  setStatus(document.querySelector("#status-viewer-message"), "Loading status…");
  document.querySelector("#status-viewer-title").textContent = "";
  document.querySelector("#status-viewer-time").textContent = "";
  document.querySelector("#status-viewer-image").hidden = true;
  document.querySelector("#status-viewer-image").removeAttribute("src");
  document.querySelector("#status-viewer-body").textContent = "";
  document.querySelector("#status-viewer-expires").textContent = "";
  document.querySelector("#status-viewer-list-section").hidden = true;
  document.querySelector("#status-delete-button").hidden = true;
  try {
    const data = await request(`/statuses/${statusId}`, { authenticated: true });
    const status = data.status;
    activeViewedStatus = status;
    document.querySelector("#status-viewer-title").textContent = status.user.username;
    renderAvatar(document.querySelector("#status-viewer-avatar"), status.user);
    document.querySelector("#status-viewer-time").textContent =
      `Posted ${new Date(status.createdAt).toLocaleString()}`;
    const image = document.querySelector("#status-viewer-image");
    if (status.mediaUrl) {
      image.src = status.mediaUrl;
      image.hidden = false;
    }
    document.querySelector("#status-viewer-body").textContent = status.body;
    document.querySelector("#status-viewer-expires").textContent =
      `${statusTimeRemaining(status.expiresAt)} · statuses disappear after 24 hours`;
    const isOwner = Boolean(
      status.isOwner ||
      (status.user && currentUser && (
        Number(status.user.id) === Number(currentUser.id) ||
        status.user.username === currentUser.username
      ))
    );
    if (isOwner) {
      renderStatusViewers(status.viewers || []);
      document.querySelector("#status-viewer-list-section").hidden = false;
      document.querySelector("#status-delete-button").hidden = false;
    }
    setStatus(document.querySelector("#status-viewer-message"), "");
    refreshStatuses().catch((error) => {
      setStatus(statusFeedState, `Could not refresh statuses: ${error.message}`, "error");
    });
  } catch (error) {
    setStatus(document.querySelector("#status-viewer-message"), error.message, "error");
  }
}

document.querySelector("#add-status-button").addEventListener("click", () => {
  statusCreateForm.reset();
  statusPhotoPreview.hidden = true;
  statusPhotoPreview.removeAttribute("src");
  if (statusPreviewUrl) URL.revokeObjectURL(statusPreviewUrl);
  statusPreviewUrl = "";
  statusUploadProgress.hidden = true;
  setStatus(document.querySelector("#status-create-message"), "");
  statusCreateDialog.showModal();
});

function closeStatusCreateDialog() {
  statusCreateDialog.close();
  statusCreateForm.reset();
  statusPhotoPreview.hidden = true;
  statusPhotoPreview.removeAttribute("src");
  if (statusPreviewUrl) URL.revokeObjectURL(statusPreviewUrl);
  statusPreviewUrl = "";
  statusUploadProgress.hidden = true;
}

document.querySelector("#status-create-close").addEventListener("click", closeStatusCreateDialog);
document.querySelector("#status-create-cancel").addEventListener("click", closeStatusCreateDialog);
statusPhotoInput.addEventListener("change", () => {
  const file = statusPhotoInput.files[0];
  if (!file) return;
  try {
    validateImageFile(file);
    if (statusPreviewUrl) URL.revokeObjectURL(statusPreviewUrl);
    statusPreviewUrl = URL.createObjectURL(file);
    statusPhotoPreview.src = statusPreviewUrl;
    statusPhotoPreview.hidden = false;
    setStatus(document.querySelector("#status-create-message"), "");
  } catch (error) {
    statusPhotoInput.value = "";
    statusPhotoPreview.hidden = true;
    setStatus(document.querySelector("#status-create-message"), error.message, "error");
  }
});

statusCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = document.querySelector("#status-text").value.trim();
  const file = statusPhotoInput.files[0];
  if (!body && !file) {
    setStatus(document.querySelector("#status-create-message"), "Write a status or choose a photo.", "error");
    return;
  }
  const submit = document.querySelector("#status-create-submit");
  submit.disabled = true;
  setStatus(document.querySelector("#status-create-message"), "Posting status…");
  try {
    let data;
    if (file) {
      validateImageFile(file);
      const formData = new FormData();
      formData.append("body", body);
      formData.append("media", file);
      data = await uploadRequest(
        "/statuses",
        formData,
        statusUploadProgress,
        document.querySelector("#status-create-message")
      );
    } else {
      data = await request("/statuses", {
        method: "POST",
        body: { body },
        authenticated: true
      });
    }
    closeStatusCreateDialog();
    await refreshStatuses();
    await openStatus(data.status.id);
  } catch (error) {
    setStatus(document.querySelector("#status-create-message"), error.message, "error");
  } finally {
    submit.disabled = false;
    statusUploadProgress.hidden = true;
  }
});

document.querySelector("#status-viewer-close").addEventListener("click", () => {
  statusViewerDialog.close();
  activeViewedStatus = null;
});
statusViewerDialog.addEventListener("close", () => {
  activeViewedStatus = null;
});

document.querySelector("#status-delete-button").addEventListener("click", async (event) => {
  if (!activeViewedStatus) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request(`/statuses/${activeViewedStatus.id}`, {
      method: "DELETE",
      authenticated: true
    });
    statusViewerDialog.close();
    activeViewedStatus = null;
    await refreshStatuses();
  } catch (error) {
    setStatus(document.querySelector("#status-viewer-message"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#signout-button").addEventListener("click", async () => {
  const button = document.querySelector("#signout-button");
  button.disabled = true;
  try {
    await request("/logout", { method: "POST", authenticated: true });
    await showSignedOut();
    setStatus(authStatus, "You have signed out.", "success");
  } catch (error) {
    setStatus(document.querySelector("#global-status"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

const profileDialog = document.querySelector("#profile-dialog");
const profileForm = document.querySelector("#profile-form");
const profileAvatarInput = document.querySelector("#profile-avatar-input");
const profileAvatarPreview = document.querySelector("#profile-avatar-preview");

document.querySelector("#profile-button").addEventListener("click", async () => {
  setStatus(document.querySelector("#profile-status"), "");
  profileAvatarInput.value = "";
  document.querySelector("#profile-upload-progress").hidden = true;
  profileDialog.showModal();
  try {
    const data = await request("/settings", { authenticated: true });
    document.querySelector("#settings-username").value = data.settings.username;
    document.querySelector("#settings-phone").value = "";
    document.querySelector("#verified-phone").textContent = data.settings.phoneNumber
      ? `Verified: ${data.settings.phoneNumber}`
      : "No verified phone number.";
    document.querySelector("#settings-theme").value = data.settings.theme;
    document.querySelector("#settings-read-receipts").checked = data.settings.readReceipts;
    profileAvatarPreview.src = currentUser.avatarUrl || "";
    document.querySelector("#phone-current-password").value = "";
    document.querySelector("#settings-code").value = "";
    document.querySelector("#settings-code-field").hidden = true;
    document.querySelector("#settings-resend").hidden = true;
    document.querySelector("#phone-save").textContent = "Send code";
    settingsCodeSent = false;
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
  }
});

document.querySelector("#profile-cancel").addEventListener("click", () => profileDialog.close());
profileAvatarInput.addEventListener("change", () => {
  const file = profileAvatarInput.files[0];
  if (!file) return;
  try {
    validateImageFile(file);
    profileAvatarPreview.src = URL.createObjectURL(file);
    setStatus(document.querySelector("#profile-status"), "");
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = profileAvatarInput.files[0];
  const saveButton = document.querySelector("#profile-save");
  try {
    saveButton.disabled = true;
    const username = document.querySelector("#settings-username").value.trim();
    if (username !== currentUser.username) {
      const data = await request("/settings/profile", {
        method: "PATCH",
        body: { username },
        authenticated: true
      });
      currentUser = data.user;
    }
    if (file) {
      validateImageFile(file);
      const formData = new FormData();
      formData.append("avatar", file);
      const data = await uploadRequest(
        "/profile/avatar",
        formData,
        document.querySelector("#profile-upload-progress"),
        document.querySelector("#profile-status")
      );
      currentUser = data.user;
    }
    document.querySelector("#current-username").textContent = currentUser.username;
    renderAvatar(document.querySelector("#current-avatar"), currentUser, true);
    if (currentUser.avatarUrl) profileAvatarPreview.src = currentUser.avatarUrl;
    profileAvatarInput.value = "";
    document.querySelector("#settings-username").value = currentUser.username;
    await refreshConversations();
    setStatus(document.querySelector("#profile-status"), "Profile saved.", "success");
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
  } finally {
    saveButton.disabled = false;
    document.querySelector("#profile-upload-progress").hidden = true;
  }
});

document.querySelector("#phone-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const phone = document.querySelector("#settings-phone").value.trim();
  const currentPassword = document.querySelector("#phone-current-password").value;
  const submitButton = document.querySelector("#phone-save");
  submitButton.disabled = true;
  try {
    if (!settingsCodeSent) {
      await request("/settings/phone/start", {
        method: "POST",
        body: { phone, currentPassword },
        authenticated: true
      });
      settingsCodeSent = true;
      document.querySelector("#settings-code-field").hidden = false;
      document.querySelector("#settings-resend").hidden = false;
      submitButton.textContent = "Verify number";
      setStatus(document.querySelector("#profile-status"), "Verification code sent.", "success");
    } else {
      const verificationCode = document.querySelector("#settings-code").value.trim();
      const data = await request("/settings/phone/verify", {
        method: "POST",
        body: { phone, currentPassword, verificationCode },
        authenticated: true
      });
      document.querySelector("#verified-phone").textContent = `Verified: ${data.phoneNumber}`;
      document.querySelector("#settings-phone").value = "";
      document.querySelector("#settings-code").value = "";
      document.querySelector("#phone-current-password").value = "";
      document.querySelector("#settings-code-field").hidden = true;
      document.querySelector("#settings-resend").hidden = true;
      settingsCodeSent = false;
      submitButton.textContent = "Send code";
      setStatus(document.querySelector("#profile-status"), "Phone number updated.", "success");
    }
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#settings-resend").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request("/settings/phone/start", {
      method: "POST",
      body: {
        phone: document.querySelector("#settings-phone").value.trim(),
        currentPassword: document.querySelector("#phone-current-password").value
      },
      authenticated: true
    });
    setStatus(document.querySelector("#profile-status"), "A new code was sent.", "success");
    window.setTimeout(() => { button.disabled = false; }, 60_000);
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
    button.disabled = false;
  }
});

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await request("/settings/password", {
      method: "POST",
      body: {
        currentPassword: document.querySelector("#password-current").value,
        newPassword: document.querySelector("#password-new").value
      },
      authenticated: true
    });
    document.querySelector("#password-current").value = "";
    document.querySelector("#password-new").value = "";
    setStatus(document.querySelector("#profile-status"), "Password updated.", "success");
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#preferences-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const preferences = {
      theme: document.querySelector("#settings-theme").value,
      readReceipts: document.querySelector("#settings-read-receipts").checked
    };
    await request("/settings/preferences", {
      method: "PATCH",
      body: preferences,
      authenticated: true
    });
    applyTheme(preferences.theme);
    readMarkedIds.clear();
    setStatus(document.querySelector("#profile-status"), "Preferences saved.", "success");
    if (activeConversation) await refreshMessages(true);
  } catch (error) {
    setStatus(document.querySelector("#profile-status"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = document.querySelector("#user-search").value.trim();
  const list = document.querySelector("#search-results");
  list.replaceChildren();
  setStatus(document.querySelector("#search-status"), "Searching…");
  try {
    const data = await request(`/users?username=${encodeURIComponent(query)}`, { authenticated: true });
    if (data.users.length === 0) {
      setStatus(document.querySelector("#search-status"), "No matching usernames found.");
      return;
    }
    setStatus(document.querySelector("#search-status"), `${data.users.length} result${data.users.length === 1 ? "" : "s"}.`);
    data.users.forEach((user) => list.append(createUserRow(user)));
  } catch (error) {
    setStatus(document.querySelector("#search-status"), error.message, "error");
  }
});

function createUserRow(user) {
  const item = document.createElement("li");
  const row = document.createElement("div");
  row.className = "person-row";
  row.append(createAvatar(user));
  const name = document.createElement("span");
  name.textContent = user.username;
  row.append(name);

  if (user.status === "accepted") {
    row.append(makeAction("Chat", () => openConversation(user)));
  } else if (user.status === "pending" && user.direction === "incoming") {
    row.append(makeAction("Accept", async () => {
      await request(`/connections/${user.id}/accept`, { method: "POST", authenticated: true });
      await refreshConversations();
      await searchAgain();
    }));
  } else if (user.status === "pending") {
    row.append(makeAction("Sent", () => {}, true));
  } else {
    row.append(makeAction("Connect", async () => {
      await request(`/connections/${user.id}`, { method: "POST", authenticated: true });
      setStatus(document.querySelector("#search-status"), `Request sent to ${user.username}.`, "success");
      await refreshConversations();
      await searchAgain();
    }));
  }
  item.append(row);
  return item;
}

function makeAction(label, action, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button row-action";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      setStatus(document.querySelector("#search-status"), error.message, "error");
      button.disabled = false;
    }
  });
  return button;
}

async function searchAgain() {
  const query = document.querySelector("#user-search").value.trim();
  if (query.length < 2) return;
  const data = await request(`/users?username=${encodeURIComponent(query)}`, { authenticated: true });
  const list = document.querySelector("#search-results");
  list.replaceChildren(...data.users.map(createUserRow));
}

async function refreshConversations() {
  if (conversationRefreshRunning || !currentUser) return;
  conversationRefreshRunning = true;
  try {
    const [connectionsData, conversationData] = await Promise.all([
      request("/connections", { authenticated: true }),
      request("/conversations", { authenticated: true })
    ]);
    renderConnections(connectionsData.connections);
    renderConversations(conversationData.conversations);
    if (activeConversation) {
      const latest = conversationData.conversations.find((user) => user.id === activeConversation.id);
      if (!latest) {
        activeConversation = null;
        document.querySelector("#active-chat").hidden = true;
      } else {
        activeConversation = latest;
        document.querySelector("#chat-title").textContent = latest.username;
        renderAvatar(document.querySelector("#chat-avatar"), latest);
      }
    }
  } finally {
    conversationRefreshRunning = false;
  }
}

function renderConnections(connections) {
  const incoming = connections.filter((item) => item.status === "pending" && item.direction === "incoming");
  const outgoing = connections.filter((item) => item.status === "pending" && item.direction === "outgoing");
  const list = document.querySelector("#requests-list");
  list.replaceChildren();
  [...incoming, ...outgoing].forEach((user) => {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "person-row";
    if (user.avatarUrl) row.append(createAvatar(user));
    const name = document.createElement("span");
    name.textContent = user.username;
    row.append(name);
    if (user.direction === "incoming") {
      row.append(makeAction("Accept", async () => {
        await request(`/connections/${user.id}/accept`, { method: "POST", authenticated: true });
        await refreshConversations();
      }));
    } else {
      row.append(makeAction("Sent", () => {}, true));
    }
    item.append(row);
    list.append(item);
  });
  document.querySelector("#request-count").textContent = String(incoming.length);
  document.querySelector("#requests-empty").hidden = connections.some((item) => item.status === "pending");
}

function renderConversations(conversations) {
  const list = document.querySelector("#conversations-list");
  list.replaceChildren();
  conversations.forEach((user) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-row${activeConversation?.id === user.id ? " selected" : ""}`;
    button.addEventListener("click", () => openConversation(user));
    
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = user.username.charAt(0).toUpperCase();
    
    const copy = document.createElement("div");
    copy.className = "conversation-copy";
    
    const topRow = document.createElement("div");
    topRow.className = "conversation-top-row";
    
    const name = document.createElement("span");
    name.className = "conversation-name";
    name.textContent = user.username;
    
    const time = document.createElement("span");
    time.className = "conversation-time";
    if (user.lastMessageAt) {
      const d = new Date(user.lastMessageAt);
      const isToday = new Date().toDateString() === d.toDateString();
      time.textContent = isToday
        ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    topRow.append(name, time);

    const bottomRow = document.createElement("div");
    bottomRow.className = "conversation-bottom-row";

    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = user.lastMessage || "Tap to chat";
    bottomRow.append(preview);

    copy.append(topRow, bottomRow);
    button.append(avatar, copy);
    item.append(button);
    list.append(item);
  });
  document.querySelector("#conversations-empty").hidden = conversations.length > 0;
}

function createAvatar(user) {
  if (user.avatarUrl) {
    const image = document.createElement("img");
    image.className = "avatar";
    image.src = user.avatarUrl;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = "avatar";
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = user.username.charAt(0).toUpperCase();
  return fallback;
}

function closeActiveConversation() {
  activeConversation = null;
  lastRenderedMessageId = 0;
  lastStatusSignature = "";
  if (readReceiptTimer) window.clearTimeout(readReceiptTimer);
  readReceiptTimer = null;
  readReceiptObserver?.disconnect();
  readMarkedIds.clear();
  readPendingIds.clear();
  workspace.classList.remove("chat-open");
  document.querySelector("#active-chat").hidden = true;
  messagesElement.replaceChildren();
  setStatus(messageStatus, "");
  refreshConversations().catch(() => {});
}

async function openConversation(user) {
  if (contactDialog.open) contactDialog.close();
  activeConversation = user;
  lastRenderedMessageId = 0;
  lastStatusSignature = "";
  if (readReceiptTimer) window.clearTimeout(readReceiptTimer);
  readReceiptTimer = null;
  readReceiptObserver?.disconnect();
  readMarkedIds.clear();
  readPendingIds.clear();
  workspace.classList.add("chat-open");
  document.querySelector("#active-chat").hidden = false;
  document.querySelector("#chat-title").textContent = user.username;
  renderAvatar(document.querySelector("#chat-avatar"), user);
  setStatus(messageStatus, "Loading messages…");
  try {
    await refreshConversations();
    await refreshMessages(true);
    await refreshCallHistory(user.id);
  } catch (error) {
    setStatus(messageStatus, error.message, "error");
  }
}

async function refreshMessages(force = false) {
  if (!activeConversation || messageRefreshRunning) return;
  const conversationId = activeConversation.id;
  messageRefreshRunning = true;
  try {
    const data = await request(`/conversations/${conversationId}/messages`, { authenticated: true });
    if (activeConversation?.id !== conversationId) return;
    const newestId = data.messages.at(-1)?.id || 0;
    const statusSignature = data.messages.map((message) => `${message.id}:${message.deliveryStatus || ""}`).join("|");
    if (force || newestId !== lastRenderedMessageId || statusSignature !== lastStatusSignature) {
      renderMessages(data.messages);
      lastRenderedMessageId = newestId;
      lastStatusSignature = statusSignature;
    }
    setStatus(messageStatus, data.messages.length ? "" : "Say hello to start the conversation.");
  } finally {
    messageRefreshRunning = false;
  }
}

function renderMessages(messages) {
  readReceiptObserver?.disconnect();
  messagesElement.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "messages-empty";
    empty.textContent = "No messages yet. Send the first one.";
    messagesElement.append(empty);
    return;
  }
  messages.forEach((message) => {
    const wrapper = document.createElement("article");
    wrapper.className = `message${message.senderId === currentUser.id ? " mine" : ""}`;
    wrapper.dataset.messageId = String(message.id);
    if (message.body) {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      bubble.textContent = message.body;
      wrapper.append(bubble);
    }
    if (message.mediaType === "image" && message.mediaUrl) {
      const media = document.createElement("div");
      media.className = "message-media";
      const image = document.createElement("img");
      image.className = "message-image";
      image.src = message.mediaUrl;
      image.alt = "Picture shared in this conversation";
      image.loading = "lazy";
      media.append(image);
      wrapper.append(media);
    } else if (message.mediaType === "voice" && message.mediaUrl) {
      const media = document.createElement("div");
      media.className = "message-media";
      const audio = document.createElement("audio");
      audio.className = "message-audio";
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = message.mediaUrl;
      const duration = document.createElement("span");
      duration.className = "message-duration";
      duration.textContent = formatDuration(message.mediaDuration);
      media.append(audio, duration);
      wrapper.append(media);
    }
    const metadata = document.createElement("div");
    metadata.className = "message-meta";
    const time = document.createElement("time");
    time.className = "message-time";
    const date = new Date(message.createdAt);
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    metadata.append(time);
    if (message.senderId === currentUser.id) {
      const status = document.createElement("span");
      status.className = `delivery-status status-${message.deliveryStatus || "sent"}`;
      const statusText = {
        sent: "✓ Sent",
        delivered: "✓✓ Delivered",
        read: "✓✓ Read"
      }[message.deliveryStatus] || "✓ Sent";
      status.textContent = statusText;
      status.setAttribute("aria-label", `Message ${statusText.toLowerCase()}`);
      metadata.append(status);
    }
    wrapper.append(metadata);
    messagesElement.append(wrapper);
  });
  messagesElement.scrollTop = messagesElement.scrollHeight;
  observeIncomingMessages();
}

function observeIncomingMessages() {
  if (!("IntersectionObserver" in window) || !activeConversation) return;
  readReceiptObserver = new IntersectionObserver((entries) => {
    if (document.visibilityState !== "visible") return;
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
      const messageId = Number(entry.target.dataset.messageId);
      if (!Number.isSafeInteger(messageId) || readMarkedIds.has(messageId)) continue;
      readPendingIds.add(messageId);
      readReceiptObserver.unobserve(entry.target);
    }
    if (readPendingIds.size && !readReceiptTimer) {
      readReceiptTimer = window.setTimeout(flushReadReceipts, 250);
    }
  }, { root: messagesElement, threshold: [0.5] });
  messagesElement.querySelectorAll(".message:not(.mine)").forEach((message) => {
    if (!readMarkedIds.has(Number(message.dataset.messageId))) {
      readReceiptObserver.observe(message);
    }
  });
}

async function flushReadReceipts() {
  readReceiptTimer = null;
  if (!activeConversation || document.visibilityState !== "visible" || !readPendingIds.size) return;
  const conversationId = activeConversation.id;
  const messageIds = [...readPendingIds];
  readPendingIds.clear();
  try {
    await request(`/conversations/${conversationId}/read`, {
      method: "POST",
      body: { messageIds },
      authenticated: true
    });
    if (activeConversation?.id === conversationId) {
      messageIds.forEach((id) => readMarkedIds.add(id));
    }
  } catch (error) {
    if (activeConversation?.id === conversationId) {
      messageIds.forEach((id) => readPendingIds.add(id));
      setStatus(messageStatus, error.message, "error");
      window.setTimeout(() => {
        if (activeConversation?.id === conversationId) flushReadReceipts();
      }, 2000);
    }
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clearPendingMedia() {
  if (pendingMedia?.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
  pendingMedia = null;
  document.querySelector("#image-input").value = "";
  document.querySelector("#attachment-image-preview").removeAttribute("src");
  document.querySelector("#attachment-image-preview").hidden = true;
  const audioPreview = document.querySelector("#attachment-audio-preview");
  audioPreview.pause();
  audioPreview.removeAttribute("src");
  audioPreview.load();
  audioPreview.hidden = true;
  document.querySelector("#attachment-name").textContent = "";
  attachmentPreview.hidden = true;
}

function setPendingMedia(file, type, duration = null) {
  clearPendingMedia();
  const previewUrl = URL.createObjectURL(file);
  pendingMedia = { file, type, duration, previewUrl };
  attachmentPreview.hidden = false;
  if (type === "image") {
    const preview = document.querySelector("#attachment-image-preview");
    preview.src = previewUrl;
    preview.hidden = false;
    document.querySelector("#attachment-name").textContent = file.name;
  } else {
    const preview = document.querySelector("#attachment-audio-preview");
    preview.src = previewUrl;
    preview.hidden = false;
    document.querySelector("#attachment-name").textContent = `Voice note · ${formatDuration(duration)}`;
  }
}

document.querySelector("#image-input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    validateImageFile(file);
    setPendingMedia(file, "image");
    setStatus(messageStatus, "Picture ready to send.");
  } catch (error) {
    event.target.value = "";
    setStatus(messageStatus, error.message, "error");
  }
});

document.querySelector("#cancel-attachment").addEventListener("click", () => {
  clearPendingMedia();
  setStatus(messageStatus, "");
});

document.querySelectorAll(".emoji-grid button").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector("#message-input");
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(button.textContent, start, end, "end");
    input.focus();
    document.querySelector("#emoji-picker").open = false;
  });
});

function finishRecordingControls() {
  document.querySelector("#record-button").hidden = false;
  document.querySelector("#record-button").classList.remove("recording");
  document.querySelector("#stop-recording-button").hidden = true;
  document.querySelector("#cancel-recording-button").hidden = true;
}

async function startVoiceRecording() {
  if (pendingMedia) {
    setStatus(messageStatus, "Send or cancel the current attachment before recording.", "error");
    return;
  }
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextConstructor) {
    setStatus(messageStatus, "Voice recording is not supported in this browser. Use HTTPS or localhost and try a current browser.", "error");
    return;
  }

  setStatus(messageStatus, "Requesting microphone permission…");
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      recordingContext = new AudioContextConstructor({ sampleRate: 16000 });
    } catch {
      recordingContext = new AudioContextConstructor();
    }
    await recordingContext.resume();
    recordingSource = recordingContext.createMediaStreamSource(recordingStream);
    recordingProcessor = recordingContext.createScriptProcessor(4096, 1, 1);
    recordingChunks = [];
    cancelRecording = false;
    recordingStartedAt = Date.now();
    recordingProcessor.addEventListener("audioprocess", (event) => {
      recordingChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      event.outputBuffer.getChannelData(0).fill(0);
    });
    recordingSource.connect(recordingProcessor);
    recordingProcessor.connect(recordingContext.destination);
    document.querySelector("#record-button").hidden = true;
    document.querySelector("#record-button").classList.add("recording");
    document.querySelector("#stop-recording-button").hidden = false;
    document.querySelector("#cancel-recording-button").hidden = false;
    const updateRecordingStatus = () => {
      const elapsed = (Date.now() - recordingStartedAt) / 1000;
      setStatus(messageStatus, `Recording… ${formatDuration(elapsed)} / 2:00`);
      if (elapsed >= 120) stopVoiceRecording(false);
    };
    updateRecordingStatus();
    recordingTimer = setInterval(updateRecordingStatus, 1000);
  } catch (error) {
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    await recordingContext?.close();
    recordingContext = null;
    const message = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
      ? "Microphone permission was denied. Allow microphone access in your browser settings to record."
      : error.name === "NotFoundError"
        ? "No microphone was found."
        : error.message || "Could not start recording.";
    setStatus(messageStatus, message, "error");
  }
}

function makeWavFile(chunks, sampleRate) {
  const totalSamples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(totalSamples);
  let offset = 0;
  chunks.forEach((chunk) => {
    samples.set(chunk, offset);
    offset += chunk.length;
  });
  const targetRate = 16000;
  const ratio = sampleRate / targetRate;
  const outputLength = Math.floor(samples.length / ratio);
  const dataLength = outputLength * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (position, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(position + index, text.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let sample = start; sample < end; sample += 1) total += samples[sample];
    const value = Math.max(-1, Math.min(1, total / Math.max(1, end - start)));
    view.setInt16(44 + index * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new File([buffer], "voice-note.wav", { type: "audio/wav" });
}

async function stopVoiceRecording(discard) {
  if (!recordingContext) return;
  cancelRecording = discard;
  clearInterval(recordingTimer);
  const sampleRate = recordingContext.sampleRate;
  const chunks = recordingChunks;
  recordingChunks = [];
  recordingProcessor?.disconnect();
  recordingSource?.disconnect();
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
  const context = recordingContext;
  recordingContext = null;
  recordingProcessor = null;
  recordingSource = null;
  await context.close();
  finishRecordingControls();
  if (cancelRecording) {
    cancelRecording = false;
    setStatus(messageStatus, "Recording cancelled.");
    return;
  }
  try {
    const file = makeWavFile(chunks, sampleRate);
    if (file.size <= 44) {
      setStatus(messageStatus, "No audio was recorded. Please try again.", "error");
      return;
    }
    const duration = (file.size - 44) / 32000;
    setPendingMedia(file, "voice", duration);
    setStatus(messageStatus, "Voice note ready to send.");
  } catch (error) {
    setStatus(messageStatus, error.message || "Could not prepare the voice note.", "error");
  }
}

document.querySelector("#record-button").addEventListener("click", startVoiceRecording);
document.querySelector("#stop-recording-button").addEventListener("click", () => {
  stopVoiceRecording(false);
});
document.querySelector("#cancel-recording-button").addEventListener("click", () => {
  stopVoiceRecording(true);
});

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeConversation) return;
  const input = document.querySelector("#message-input");
  const body = input.value.trim();
  if (!body && !pendingMedia) return;
  const sendButton = document.querySelector("#send-button");
  sendButton.disabled = true;
  setStatus(messageStatus, "Sending…");
  try {
    if (pendingMedia) {
      const formData = new FormData();
      formData.append("body", body);
      formData.append("mediaType", pendingMedia.type);
      formData.append("media", pendingMedia.file);
      if (pendingMedia.type === "voice") formData.append("duration", String(pendingMedia.duration));
      await uploadRequest(
        `/conversations/${activeConversation.id}/messages`,
        formData,
        uploadProgress,
        messageStatus
      );
      clearPendingMedia();
      uploadProgress.hidden = true;
    } else {
      await request(`/conversations/${activeConversation.id}/messages`, {
        method: "POST",
        body: { body },
        authenticated: true
      });
    }
    input.value = "";
    await refreshMessages(true);
    await refreshConversations();
  } catch (error) {
    setStatus(messageStatus, error.message, "error");
  } finally {
    sendButton.disabled = false;
    uploadProgress.hidden = true;
    input.focus();
  }
});

async function initialize() {
  try {
    const data = await request("/session");
    csrfToken = data.csrfToken;
    if (data.user) {
      currentUser = data.user;
      await showSignedIn();
    } else {
      setAuthMode("login");
    }
  } catch (error) {
    setStatus(authStatus, `${error.message} Refresh the page to try again.`, "error");
  }
}

setInterval(() => {
  if (!currentUser) return;
  pollCalls().catch((error) => {
    setStatus(document.querySelector("#global-status"), error.message, "error");
  });
}, 1200);
setInterval(() => {
  if (!currentUser) return;
  refreshConversations().catch((error) => {
    setStatus(document.querySelector("#global-status"), error.message, "error");
  });
}, 5000);
setInterval(() => {
  if (!currentUser) return;
  refreshStatuses().catch((error) => {
    setStatus(statusFeedState, `Could not refresh statuses: ${error.message}`, "error");
  });
}, 15000);
setInterval(() => {
  if (!currentUser || !activeConversation) return;
  refreshMessages().catch((error) => setStatus(messageStatus, error.message, "error"));
}, 2000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser) {
    refreshStatuses().catch((error) => {
      setStatus(statusFeedState, `Could not refresh statuses: ${error.message}`, "error");
    });
    if (activeConversation) {
      refreshMessages(true).catch((error) => setStatus(messageStatus, error.message, "error"));
    }
  }
});

initialize();
