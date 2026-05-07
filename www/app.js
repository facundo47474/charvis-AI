const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const MAX_CLIENT_FILE_BYTES = 12 * 1024 * 1024;
const MIC_RESUME_DELAY_MS = 1200;

// Configurar marked: soporte de tablas GFM y saltos de línea automáticos
marked.use({ breaks: true, gfm: true });

let ws = null;
let wsReady = false;
let autoSpeak = true;
let micListening = false;
let isCharvisHablando = false;
let chatMode = "normal";
let conversationCount = 1;
let audioOutputActive = false;
let micResumeAt = 0;

let pendingFile = null;
let pendingFileContent = null;

function conectar() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    wsReady = true;
    setConnection(true);
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
  text.textContent = online ? "Conectado" : "Reconectando";
}

function wsSendJSON(obj) {
  if (wsReady && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleEstado(valor) {
  const labels = {
    analizandoArchivo: "Leyendo archivo",
    pensando: "Pensando",
    razonando: "Razonando",
    hablando: "Hablando",
    transcribiendo: "Transcribiendo",
    escuchando: "Escuchando"
  };

  isCharvisHablando = valor === "hablando";
  if (valor === "hablando") iniciarSalidaVoz();
  if (["pensando", "razonando", "analizandoArchivo", "transcribiendo"].includes(valor)) {
    showThinking(labels[valor]);
  }
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("collapsed");
}

function toggleModelDropdown() {
  document.getElementById("model-dropdown")?.classList.toggle("hidden");
}

function selectModel(mode) {
  chatMode = mode === "razonamiento" ? "razonamiento" : "normal";
  const label = chatMode === "razonamiento" ? "Razonamiento" : "Normal";
  document.getElementById("model-name").textContent = chatMode === "razonamiento" ? "Modo razonamiento" : "Modo normal";
  document.getElementById("mode-current-label").textContent = label;
  document.getElementById("mode-current").setAttribute("aria-expanded", "false");
  document.getElementById("mode-menu").classList.add("hidden");
  document.getElementById("model-dropdown")?.classList.add("hidden");
  document.querySelectorAll(".dropdown-item, .mode-option").forEach((item) => {
    item.classList.toggle("active", item.dataset.mode === chatMode);
  });
}

function toggleModeMenu() {
  const menu = document.getElementById("mode-menu");
  const button = document.getElementById("mode-current");
  const nextOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !nextOpen);
  button.setAttribute("aria-expanded", String(nextOpen));
}

function toggleReasoning() {
  selectModel(chatMode === "razonamiento" ? "normal" : "razonamiento");
}

document.addEventListener("click", (event) => {
  const switcher = document.getElementById("mode-switcher");
  if (!switcher || switcher.contains(event.target)) return;
  document.getElementById("mode-menu")?.classList.add("hidden");
  document.getElementById("mode-current")?.setAttribute("aria-expanded", "false");
});

function toggleAutoSpeak() {
  autoSpeak = !autoSpeak;
  const btn = document.getElementById("btn-auto-speak");
  btn.classList.toggle("active", autoSpeak);
  btn.title = autoSpeak ? "Audio automatico activado" : "Audio automatico desactivado";
}

function removeWelcome() {
  document.getElementById("welcome-screen")?.remove();
}

function estaCercaDelFinal(chat) {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
}

function enfocarInicioMensaje(chat, div) {
  const offset = Math.max(div.offsetTop - 18, 0);
  chat.scrollTop = offset;
}

function crearBotonVoz(texto) {
  const button = document.createElement("button");
  button.className = "msg-action-btn";
  button.title = "Leer respuesta";
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  button.addEventListener("click", () => hablarTexto(texto));
  return button;
}

function limpiarTextoParaVoz(texto) {
  return String(texto || "").replace(/```chart[\s\S]*?```/gi, "").trim();
}

function extraerBloquesGraficos(texto) {
  const charts = [];
  const cleanText = String(texto || "").replace(/```chart\s*([\s\S]*?)```/gi, (_match, json) => {
    try {
      charts.push(JSON.parse(json));
    } catch (_) {}
    return "";
  }).trim();
  return { cleanText, charts };
}

function renderizarGrafico(chart) {
  const labels = Array.isArray(chart.labels) ? chart.labels : [];
  const values = Array.isArray(chart.values) ? chart.values.map(Number) : [];
  if (!labels.length || labels.length !== values.length || values.some((value) => Number.isNaN(value))) return null;

  const max = Math.max(...values.map(Math.abs), 1);
  const wrapper = document.createElement("div");
  wrapper.className = "chart-card";

  if (chart.title) {
    const title = document.createElement("div");
    title.className = "chart-title";
    title.textContent = chart.title;
    wrapper.appendChild(title);
  }

  const bars = document.createElement("div");
  bars.className = "chart-bars";
  values.forEach((value, index) => {
    const row = document.createElement("div");
    row.className = "chart-row";

    const label = document.createElement("span");
    label.className = "chart-label";
    label.textContent = labels[index];

    const track = document.createElement("div");
    track.className = "chart-track";

    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.width = `${Math.max(Math.abs(value) / max * 100, 3)}%`;

    const amount = document.createElement("span");
    amount.className = "chart-value";
    amount.textContent = `${value}${chart.unit || ""}`;

    track.appendChild(bar);
    row.append(label, track, amount);
    bars.appendChild(row);
  });

  wrapper.appendChild(bars);
  return wrapper;
}

function renderizarContenidoMensaje(container, texto) {
  const { cleanText, charts } = extraerBloquesGraficos(texto);
  const text = document.createElement("div");
  text.className = "msg-text";
  text.innerHTML = marked.parse(cleanText || texto || "");
  container.appendChild(text);

  charts.forEach((chart) => {
    const chartNode = renderizarGrafico(chart);
    if (chartNode) container.appendChild(chartNode);
  });
}

function agregarMensaje(rol, texto) {
  removeWelcome();
  const chat = document.getElementById("chat");
  const shouldStickToBottom = rol === "usuario" || estaCercaDelFinal(chat);
  const div = document.createElement("div");
  div.className = "message " + rol;

  const inner = document.createElement("div");
  inner.className = "message-inner";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = rol === "charvis" ? "C" : "U";

  const content = document.createElement("div");
  content.className = "msg-content";

  const sender = document.createElement("div");
  sender.className = "msg-sender";
  sender.textContent = rol === "charvis" ? "Charvis" : "Vos";

  content.appendChild(sender);
  renderizarContenidoMensaje(content, texto);
  if (rol === "charvis" && texto) {
    const actions = document.createElement("div");
    actions.className = "msg-action-bar";
    actions.appendChild(crearBotonVoz(limpiarTextoParaVoz(texto)));
    content.appendChild(actions);
  }

  inner.append(avatar, content);
  div.appendChild(inner);
  chat.appendChild(div);
  if (rol === "charvis") {
    enfocarInicioMensaje(chat, div);
  } else if (shouldStickToBottom) {
    chat.scrollTop = chat.scrollHeight;
  }
}

function agregarError(texto) {
  removeWelcome();
  const chat = document.getElementById("chat");
  const shouldStickToBottom = estaCercaDelFinal(chat);
  const div = document.createElement("div");
  div.className = "message error";
  div.textContent = texto || "Ocurrio un error.";
  chat.appendChild(div);
  if (shouldStickToBottom) chat.scrollTop = chat.scrollHeight;
}

function showThinking(label = "Pensando") {
  const existing = document.getElementById("thinking-msg");
  if (existing) {
    existing.querySelector(".thinking-label").textContent = label;
    return;
  }

  const chat = document.getElementById("chat");
  const div = document.createElement("div");
  div.className = "message charvis";
  div.id = "thinking-msg";
  div.innerHTML = `
    <div class="message-inner">
      <div class="msg-avatar">C</div>
      <div class="msg-content">
        <div class="msg-sender">Charvis</div>
        <div class="thinking-row">
          <span class="thinking-label">${label}</span>
          <span class="thinking-dots"><span></span><span></span><span></span></span>
        </div>
      </div>
    </div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function removeThinking() {
  document.getElementById("thinking-msg")?.remove();
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

function textoParaBurbuja(texto) {
  if (!pendingFile) return texto;
  const archivo = `Archivo: ${pendingFile.name}`;
  return texto ? `${texto}\n\n${archivo}` : archivo;
}

function enviarTexto() {
  const input = document.getElementById("text-input");
  const texto = input.value.trim();
  if (!texto && !pendingFile) return;

  const payload = { type: "texto", texto, modo: chatMode };
  if (pendingFile) {
    payload.archivo = {
      nombre: pendingFile.name,
      tipo: pendingFile.type,
      tamano: pendingFile.size,
      contenido: pendingFileContent
    };
  }

  agregarMensaje("usuario", textoParaBurbuja(texto));
  wsSendJSON(payload);

  input.value = "";
  input.style.height = "auto";
  removeFile();
  showThinking(chatMode === "razonamiento" ? "Razonando" : "Pensando");
}

function removeFile() {
  pendingFile = null;
  pendingFileContent = null;
  const preview = document.getElementById("file-preview");
  preview.classList.add("hidden");
  preview.querySelector(".file-thumb")?.remove();
  document.getElementById("file-input").value = "";
  document.getElementById("btn-send").classList.toggle("hidden", document.getElementById("text-input").value.trim() === "");
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mostrarArchivo(file, dataUrl) {
  const preview = document.getElementById("file-preview");
  preview.querySelector(".file-thumb")?.remove();
  document.getElementById("file-name").textContent = file.name;
  document.getElementById("file-meta").textContent = formatBytes(file.size);

  if (file.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "file-thumb";
    img.src = dataUrl;
    img.alt = "";
    preview.querySelector(".file-chip").prepend(img);
  }

  preview.classList.remove("hidden");
  document.getElementById("btn-send").classList.remove("hidden");
}

document.getElementById("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > MAX_CLIENT_FILE_BYTES) {
    agregarError(`El archivo supera el limite de ${MAX_CLIENT_FILE_BYTES / 1024 / 1024} MB.`);
    e.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingFile = file;
    pendingFileContent = ev.target.result;
    mostrarArchivo(file, pendingFileContent);
  };
  reader.onerror = () => agregarError("No pude leer el archivo seleccionado.");
  reader.readAsDataURL(file);
});

function insertSuggestion(texto) {
  const input = document.getElementById("text-input");
  input.value = texto;
  autoResize(input);
  input.focus();
}

function limpiar() {
  detenerAudioLocal();
  wsSendJSON({ type: "limpiar" });
}

function limpiarChatUI() {
  conversationCount += 1;
  removeFile();
  document.getElementById("chat").innerHTML = `
    <div id="welcome-screen">
      <div class="welcome-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4.3a3.2 3.2 0 0 0-3.2 3.2v.7a3.7 3.7 0 0 0 0 7.2v.8A3.2 3.2 0 0 0 9 19.5"/>
          <path d="M15 4.3a3.2 3.2 0 0 1 3.2 3.2v.7a3.7 3.7 0 0 1 0 7.2v.8a3.2 3.2 0 0 1-3.2 3.2"/>
          <path d="M9 7.5h6M8.8 12h6.4M9 16.5h6"/>
        </svg>
      </div>
      <p class="welcome-greeting">Hola</p>
      <h1 class="welcome-heading">En que puedo ayudarte?</h1>
      <div class="welcome-grid">
        <button class="suggestion-card" onclick="insertSuggestion('Analiza este documento y resumime los puntos clave')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>Analizar un documento</span>
        </button>
        <button class="suggestion-card" onclick="insertSuggestion('Mira esta foto y decime que informacion importante ves')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          <span>Leer una foto</span>
        </button>
      </div>
    </div>`;
  document.getElementById("sidebar-history").innerHTML = `<button class="history-item active">Conversacion ${conversationCount}</button>`;
}

function iniciarSalidaVoz() {
  audioOutputActive = true;
  micResumeAt = Date.now() + MIC_RESUME_DELAY_MS;
  detenerGrabacion(true);
  document.getElementById("btn-stop-voice")?.classList.remove("hidden");
}

function finalizarSalidaVoz() {
  audioOutputActive = false;
  isCharvisHablando = false;
  micResumeAt = Date.now() + MIC_RESUME_DELAY_MS;
  document.getElementById("btn-stop-voice")?.classList.add("hidden");
}

function puedeGrabarMicrofono() {
  return micListening && wsReady && !isCharvisHablando && !audioOutputActive && Date.now() >= micResumeAt;
}

function detenerAudioLocal() {
  if (currentAudio) currentAudio.pause();
  audioQueue.forEach((src) => URL.revokeObjectURL(src));
  audioQueue = [];
  playingAudio = false;
  streamDone = false;
  currentAudio = null;
  window.speechSynthesis.cancel();
  colaVoz.length = 0;
  hablando = false;
  finalizarSalidaVoz();
}

document.getElementById("sidebar-history").innerHTML = '<button class="history-item active">Conversacion 1</button>';
if (window.matchMedia("(max-width: 760px)").matches) {
  document.getElementById("sidebar").classList.add("collapsed");
}

// Audio logic
let audioQueue = [];
let playingAudio = false;
let streamDone = false;
let currentAudio = null;

function encolarMP3(base64) {
  if (!autoSpeak) {
    finalizarSalidaVoz();
    return;
  }
  iniciarSalidaVoz();
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
      finalizarSalidaVoz();
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
  currentAudio.play().catch(() => {
    playingAudio = false;
    currentAudio = null;
    playNext();
  });
}

const colaVoz = [];
let hablando = false;

function encolarVoz(texto) {
  if (!autoSpeak) {
    finalizarSalidaVoz();
    return;
  }
  iniciarSalidaVoz();
  colaVoz.push(texto);
  procesarColaVoz();
}

function procesarColaVoz() {
  if (hablando || colaVoz.length === 0) {
    if (!hablando && colaVoz.length === 0 && streamDone) {
      streamDone = false;
      finalizarSalidaVoz();
    }
    return;
  }
  hablando = true;
  const utter = new SpeechSynthesisUtterance(colaVoz.shift());
  utter.lang = "es-AR";
  utter.onend = () => { hablando = false; procesarColaVoz(); };
  utter.onerror = () => { hablando = false; procesarColaVoz(); };
  window.speechSynthesis.speak(utter);
}

function hablarTexto(texto) {
  iniciarSalidaVoz();
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(texto);
  utter.lang = "es-AR";
  utter.onend = finalizarSalidaVoz;
  utter.onerror = finalizarSalidaVoz;
  window.speechSynthesis.speak(utter);
}

// VAD
let analyser = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let discardRecording = false;

async function toggleMic() {
  const btn = document.getElementById("btn-mic");
  if (micListening) {
    micListening = false;
    detenerGrabacion(true);
    btn.classList.remove("mic-active");
    btn.title = "Activar microfono";
    return;
  }

  if (!mediaRecorder) await iniciarVAD();
  micListening = !!mediaRecorder;
  micResumeAt = Date.now() + 250;
  btn.classList.toggle("mic-active", micListening);
  btn.title = micListening ? "Microfono activo" : "Activar microfono";
}

async function iniciarVAD() {
  if (mediaRecorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    audioCtx.createMediaStreamSource(stream).connect(analyser);

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      if (discardRecording) {
        discardRecording = false;
        audioChunks = [];
        return;
      }
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      audioChunks = [];
      const buf = await blob.arrayBuffer();
      if (buf.byteLength > 2000) {
        if (wsReady) ws.send(buf);
        showThinking("Transcribiendo");
      }
    };

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    setInterval(() => {
      if (!puedeGrabarMicrofono()) {
        if (isRecording) detenerGrabacion(true);
        return;
      }
      analyser.getByteTimeDomainData(dataArray);
      const rms = Math.sqrt(dataArray.reduce((s, v) => s + (v - 128) ** 2, 0) / dataArray.length) / 128;

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
  } catch (err) {
    agregarError("No se pudo acceder al microfono.");
    console.error(err);
  }
}

function detenerGrabacion(descartar = false) {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  discardRecording = descartar;
  if (mediaRecorder.state === "recording") mediaRecorder.stop();
}
