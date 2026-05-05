/* ═══════════════════════════════════════════════════════════════
   CHARVIS — Frontend (ChatGPT / Claude style)
   ═══════════════════════════════════════════════════════════════ */

const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
let ws = null;
let wsReady = false;

function conectar() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    wsReady = true;
    setConnection(true);
    iniciarVAD();
  };

  ws.onclose = () => {
    wsReady = false;
    setConnection(false);
    setTimeout(conectar, 3000);
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }

    switch (msg.type) {
      case "estado":
        handleEstado(msg.valor);
        break;
      case "mensaje":
        removeThinking();
        agregarMensaje(msg.rol, msg.texto);
        break;
      case "error":
        removeThinking();
        agregarError(msg.mensaje);
        break;
      case "limpiar":
        limpiarChatUI();
        break;
      case "reproducir":
        encolarMP3(msg.data);
        break;
      case "hablar":
        encolarVoz(msg.texto);
        break;
      case "streamTerminado":
        streamDone = true;
        playNext();
        procesarColaVoz();
        break;
    }
  };
}
conectar();

function setConnection(online) {
  const dot = document.getElementById("conn-dot");
  const text = document.getElementById("conn-text");
  dot.className = online ? "online" : "offline";
  text.textContent = online ? "Conectado" : "Reconectando...";
}

function wsSendJSON(obj) {
  if (wsReady && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

let autoSpeak = true;
let micListening = false;
let isCharvisHablando = false;

function handleEstado(valor) {
  isCharvisHablando = (valor === "hablando");
  if (valor === "pensando") showThinking();
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("collapsed");
}

function toggleModelDropdown() {
  document.getElementById("model-dropdown").classList.toggle("hidden");
}

function toggleAutoSpeak() {
  autoSpeak = !autoSpeak;
  const btn = document.getElementById("btn-auto-speak");
  btn.classList.toggle("active", autoSpeak);
}

function removeWelcome() {
  const w = document.getElementById("welcome-screen");
  if (w) w.remove();
}

function agregarMensaje(rol, texto) {
  removeWelcome();
  const chat = document.getElementById("chat");
  const div = document.createElement("div");
  div.className = "message " + rol;

  div.innerHTML = `
    <div class="message-inner">
      <div class="msg-avatar">${rol === 'charvis' ? 'C' : 'U'}</div>
      <div class="msg-content">
        <div class="msg-sender">${rol === 'charvis' ? 'Charvis' : 'Vos'}</div>
        <div class="msg-text">${texto}</div>
        ${rol === 'charvis' ? `
        <div class="msg-action-bar">
          <button class="msg-action-btn" onclick="hablarTexto('${texto.replace(/'/g, "\\'")}', this)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          </button>
        </div>` : ''}
      </div>
    </div>`;

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function showThinking() {
  if (document.getElementById("thinking-msg")) return;
  const chat = document.getElementById("chat");
  const div = document.createElement("div");
  div.className = "message charvis";
  div.id = "thinking-msg";
  div.innerHTML = `
    <div class="message-inner">
      <div class="msg-avatar">C</div>
      <div class="msg-content">
        <div class="msg-sender">Charvis</div>
        <div class="thinking-dots"><span></span><span></span><span></span></div>
      </div>
    </div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function removeThinking() {
  const el = document.getElementById("thinking-msg");
  if (el) el.remove();
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
  document.getElementById("btn-send").classList.toggle("hidden", el.value.trim() === "" && !pendingFile);
}

function handleKeyDown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enviarTexto();
  }
}

let pendingFile = null;
let pendingFileContent = null;

function enviarTexto() {
  const input = document.getElementById("text-input");
  const texto = input.value.trim();
  if (!texto && !pendingFile) return;

  const payload = { type: "texto", texto };
  if (pendingFile) {
    payload.archivo = { nombre: pendingFile.name, tipo: pendingFile.type, contenido: pendingFileContent };
  }

  agregarMensaje("usuario", texto);
  wsSendJSON(payload);

  input.value = "";
  input.style.height = "auto";
  removeFile();
  showThinking();
}

function removeFile() {
  pendingFile = null;
  pendingFileContent = null;
  document.getElementById("file-preview").classList.add("hidden");
  document.getElementById("btn-send").classList.add("hidden");
}

document.getElementById("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingFileContent = ev.target.result;
    document.getElementById("file-name").textContent = file.name;
    document.getElementById("file-preview").classList.remove("hidden");
    document.getElementById("btn-send").classList.remove("hidden");
  };
  if (file.type.startsWith("image/")) reader.readAsDataURL(file);
  else reader.readAsText(file);
});

// Audio logic
let audioQueue = [];
let playingAudio = false;
let streamDone = false;
let currentAudio = null;

function encolarMP3(base64) {
  if (!autoSpeak) return;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  audioQueue.push(URL.createObjectURL(blob));
  playNext();
}

function playNext() {
  if (playingAudio || audioQueue.length === 0) {
    if (!playingAudio && audioQueue.length === 0 && streamDone) {
      streamDone = false;
      isCharvisHablando = false;
    }
    return;
  }
  playingAudio = true;
  const src = audioQueue.shift();
  currentAudio = new Audio(src);
  currentAudio.onended = () => {
    URL.revokeObjectURL(src);
    playingAudio = false;
    currentAudio = null;
    playNext();
  };
  currentAudio.play();
}

const colaVoz = [];
let hablando = false;

function encolarVoz(texto) {
  if (!autoSpeak) return;
  colaVoz.push(texto);
  procesarColaVoz();
}

function procesarColaVoz() {
  if (hablando || colaVoz.length === 0) return;
  hablando = true;
  const utter = new SpeechSynthesisUtterance(colaVoz.shift());
  utter.lang = "es-AR";
  utter.onend = () => { hablando = false; procesarColaVoz(); };
  window.speechSynthesis.speak(utter);
}

function hablarTexto(texto, btn) {
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(texto);
  utter.lang = "es-AR";
  window.speechSynthesis.speak(utter);
}

// VAD
let analyser = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

function toggleMic() {
  micListening = !micListening;
  document.getElementById("btn-mic").classList.toggle("mic-active", micListening);
}

async function iniciarVAD() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    audioCtx.createMediaStreamSource(stream).connect(analyser);

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      audioChunks = [];
      const buf = await blob.arrayBuffer();
      if (buf.byteLength > 2000) {
        if (wsReady) ws.send(buf);
        showThinking();
      }
    };

    micListening = true;
    document.getElementById("btn-mic").classList.add("mic-active");

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    setInterval(() => {
      if (!micListening || !wsReady) return;
      analyser.getByteTimeDomainData(dataArray);
      const rms = Math.sqrt(dataArray.reduce((s, v) => s + (v - 128) ** 2, 0) / dataArray.length) / 128;
      
      if (isCharvisHablando && rms > 0.04) {
        window.speechSynthesis.cancel();
        if (currentAudio) currentAudio.pause();
        isCharvisHablando = false;
      }

      if (!isCharvisHablando) {
        if (rms > 0.022 && !isRecording) {
          isRecording = true;
          mediaRecorder.start();
        } else if (rms < 0.022 && isRecording) {
          isRecording = false;
          mediaRecorder.stop();
        }
      }
    }, 100);
  } catch (err) { console.error(err); }
}
