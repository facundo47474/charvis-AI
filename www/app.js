let conversationCount = 0;
let conversaciones = [];
let activeConversationId = null;
let renderizandoConversacion = false;
let modoRazonamientoActivo = false;
let ws = null;
let archivosAdjuntos = [];
let audioActivo = true;
let grabando = false;
let mediaRecorder = null;
let audioChunks = [];

// Auth state
let authToken = localStorage.getItem("charvis_token");
let currentUser = null;
let STORAGE_KEY = "charvis_conversaciones_v2"; // Se actualizará al loguear
let currentAudio = null;

/* ========================= */
/* INICIO */
/* ========================= */

document.addEventListener("DOMContentLoaded", async () => {
  await inicializarAuth();
  configurarTecladoMobile();
});

/* ========================= */
/* AUTHENTICATION */
/* ========================= */

async function inicializarAuth() {
  const loginScreen = document.getElementById("login-screen");
  const appContainer = document.getElementById("app");
  
  if (authToken) {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { "Authorization": `Bearer ${authToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        alCompletarLogin(data.user);
        return;
      } else {
        authToken = null;
        localStorage.removeItem("charvis_token");
      }
    } catch (e) {
      console.error("Error validando token:", e);
    }
  }

  // Si no hay token válido, mostrar login y cargar config
  loginScreen.style.display = "flex";
  appContainer.style.display = "none";
  
  // Iniciar efecto visual de partículas
  initAmbientCanvas();
  
  try {
    const confRes = await fetch("/api/auth/config");
    const config = await confRes.json();
    
    if (config.googleClientId) {
      const initGoogle = () => {
        if (window.google && window.google.accounts) {
          google.accounts.id.initialize({
            client_id: config.googleClientId,
            callback: handleGoogleLogin
          });
          google.accounts.id.renderButton(
            document.getElementById("google-btn-container"),
            { theme: "outline", size: "large", type: "standard", width: "100%", text: "continue_with" }
          );
        } else {
          setTimeout(initGoogle, 100);
        }
      };
      initGoogle();
    } else {
      document.getElementById("login-error").textContent = "Google Client ID no configurado en el servidor.";
    }
  } catch(e) {
    console.error("Error obteniendo config:", e);
  }
}

async function handleGoogleLogin(response) {
  try {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    authToken = data.token;
    localStorage.setItem("charvis_token", authToken);
    alCompletarLogin(data.user);
  } catch (err) {
    document.getElementById("login-error").textContent = err.message;
  }
}

function alCompletarLogin(user) {
  currentUser = user;
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "flex";
  
  const safeName = (user.email || user.name || "default").replace(/[^a-zA-Z0-9]/g, "_");
  STORAGE_KEY = `charvis_conversaciones_v2_${safeName}`;
  
  const avatar = document.getElementById("user-avatar");
  const nameLabel = document.getElementById("user-name");
  
  if (user.picture) {
    avatar.innerHTML = `<img src="${user.picture}" alt="Avatar" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
  } else {
    avatar.textContent = user.name.charAt(0).toUpperCase();
  }
  nameLabel.textContent = user.name;
  
  cargarConversaciones();
  iniciarConversaciones();
  conectarWebSocket();
  renderizarConversacion(obtenerConversacionActiva());
}

async function cerrarSesion() {
  if (authToken) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}` }
      });
    } catch (e) {}
  }
  authToken = null;
  currentUser = null;
  localStorage.removeItem("charvis_token");
  if (ws) {
    ws.close();
  }
  window.location.reload();
}

/* ========================= */
/* WEBSOCKET */
/* ========================= */

function conectarWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let urlStr = `${protocol}//${location.host}`;
  if (authToken) {
    urlStr += `?token=${authToken}`;
  }

  try {
    ws = new WebSocket(urlStr);

    ws.onopen = () => {
      actualizarEstadoConexion(true);
    };

    ws.onclose = () => {
      actualizarEstadoConexion(false);

      setTimeout(() => {
        conectarWebSocket();
      }, 2000);
    };

    ws.onerror = () => {
      actualizarEstadoConexion(false);
    };

    ws.onmessage = (event) => {
      manejarMensajeServidor(event.data);
    };
  } catch (error) {
    actualizarEstadoConexion(false);

    setTimeout(() => {
      conectarWebSocket();
    }, 2000);
  }
}

function actualizarEstadoConexion(conectado) {
  const status = document.getElementById("connection-status");

  if (!status) return;

  status.classList.toggle("offline", !conectado);

  const text = status.querySelector("span:last-child");

  if (text) {
    text.textContent = conectado ? "Conectado" : "Conectando";
  }
}

function manejarMensajeServidor(data) {
  let msg = null;

  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  const conversationId = msg.conversationId || activeConversationId;

  if (conversationId && conversationId !== activeConversationId) {
    guardarMensajeServidorEnConversacion(conversationId, msg);
    return;
  }

  if (msg.type === "mensaje" || msg.type === "respuesta") {
    const rol = normalizarRol(msg.rol || "charvis");
    agregarMensaje(rol, msg.texto || msg.content || "");
    return;
  }

  if (msg.type === "error") {
    agregarError(msg.texto || msg.mensaje || "Ocurrió un error.");
    return;
  }

  if (msg.type === "estado") {
    mostrarEstadoTemporal(msg.valor || "pensando");
    return;
  }

  if (msg.type === "reproducir" && msg.data && audioActivo) {
    try {
      const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      if (currentAudio) currentAudio.pause();
      currentAudio = new Audio(url);
      currentAudio.onended = () => URL.revokeObjectURL(url);
      currentAudio.play().catch(() => {});
    } catch (e) { /* ignorar */ }
    return;
  }

  if (msg.type === "hablar" && msg.texto && audioActivo) {
    const utt = new SpeechSynthesisUtterance(msg.texto);
    utt.lang = "es-AR";
    utt.rate = 1.05;
    speechSynthesis.speak(utt);
    return;
  }

  if (msg.type === "streamTerminado") {
    // El mensaje final ya llega como "mensaje", nada extra que hacer
    return;
  }
}

function guardarMensajeServidorEnConversacion(conversationId, msg) {
  const conversacion = conversaciones.find((conv) => conv.id === conversationId);

  if (!conversacion) return;

  if (msg.type === "mensaje" || msg.type === "respuesta") {
    conversacion.mensajes.push({
      tipo: "mensaje",
      rol: normalizarRol(msg.rol || "charvis"),
      texto: msg.texto || msg.content || ""
    });

    guardarConversaciones();
    actualizarSidebarConversaciones();
  }
}

/* enviarAlServidor movida a sección de envío con adjuntos */

/* ========================= */
/* CONVERSACIONES */
/* ========================= */

function crearConversacion(nombre = null) {
  conversationCount += 1;

  const conversacion = {
    id: `conv-${Date.now()}-${conversationCount}`,
    titulo: nombre || `Conversación ${conversationCount}`,
    mensajes: []
  };

  conversaciones.push(conversacion);

  guardarConversaciones();

  return conversacion;
}

function obtenerConversacionActiva() {
  return conversaciones.find((conv) => conv.id === activeConversationId) || null;
}

function iniciarConversaciones() {
  if (conversaciones.length > 0) {
    if (!activeConversationId || !obtenerConversacionActiva()) {
      activeConversationId = conversaciones[0].id;
    }

    actualizarSidebarConversaciones();
    actualizarTituloConversacion();
    return;
  }

  const primera = crearConversacion("Conversación 1");
  activeConversationId = primera.id;

  guardarConversaciones();
  actualizarSidebarConversaciones();
  actualizarTituloConversacion();
}

function nuevaConversacion() {
  const nueva = crearConversacion();

  activeConversationId = nueva.id;

  mostrarPantallaBienvenida();
  actualizarSidebarConversaciones();
  actualizarTituloConversacion();
  guardarConversaciones();

  /* El menú NO se cierra automáticamente */
}

function seleccionarConversacion(conversationId) {
  const conversacion = conversaciones.find((conv) => conv.id === conversationId);

  if (!conversacion) return;

  activeConversationId = conversacion.id;

  renderizarConversacion(conversacion);
  actualizarSidebarConversaciones();
  actualizarTituloConversacion();
  guardarConversaciones();

  /* El menú NO se cierra automáticamente */
}

function guardarMensajeEnConversacion(mensaje) {
  if (renderizandoConversacion) return;

  const conversacion = obtenerConversacionActiva();

  if (!conversacion) return;

  conversacion.mensajes.push(mensaje);

  if (
    mensaje.tipo === "mensaje" &&
    esRolUsuario(mensaje.rol) &&
    conversacion.titulo.startsWith("Conversación")
  ) {
    const titulo = String(mensaje.texto || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 36);

    if (titulo) {
      conversacion.titulo = titulo.length >= 36 ? `${titulo}...` : titulo;
    }
  }

  guardarConversaciones();
  actualizarSidebarConversaciones();
  actualizarTituloConversacion();
}

function actualizarSidebarConversaciones() {
  const sidebarHistory = document.getElementById("sidebar-history");

  if (!sidebarHistory) return;

  sidebarHistory.innerHTML = "";

  conversaciones.forEach((conversacion) => {
    const row = document.createElement("div");
    row.className = "history-row";

    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    item.classList.toggle("active", conversacion.id === activeConversationId);
    item.textContent = conversacion.titulo;
    item.onclick = () => seleccionarConversacion(conversacion.id);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-delete";
    del.title = "Borrar conversación";
    del.textContent = "✕";
    del.onclick = (e) => { e.stopPropagation(); borrarConversacion(conversacion.id); };

    row.appendChild(item);
    row.appendChild(del);
    sidebarHistory.appendChild(row);
  });
}

function renderizarConversacion(conversacion) {
  const chat = document.getElementById("chat");

  if (!chat) return;

  if (!conversacion || conversacion.mensajes.length === 0) {
    mostrarPantallaBienvenida();
    return;
  }

  chat.innerHTML = "";
  document.body.classList.remove("welcome-active");

  renderizandoConversacion = true;

  conversacion.mensajes.forEach((mensaje) => {
    if (mensaje.tipo === "error") {
      agregarError(mensaje.texto);
      return;
    }

    agregarMensaje(mensaje.rol, mensaje.texto);
  });

  renderizandoConversacion = false;

  chat.scrollTop = chat.scrollHeight;
}

function actualizarTituloConversacion() {
  const title = document.getElementById("active-conversation-title");
  const conversacion = obtenerConversacionActiva();

  if (title && conversacion) {
    title.textContent = conversacion.titulo;
  }
}

function guardarConversaciones() {
  const data = {
    conversationCount,
    activeConversationId,
    conversaciones
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function cargarConversaciones() {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) return;

  try {
    const data = JSON.parse(raw);

    conversationCount = Number(data.conversationCount || 0);
    activeConversationId = data.activeConversationId || null;
    conversaciones = Array.isArray(data.conversaciones) ? data.conversaciones : [];
  } catch {
    conversationCount = 0;
    activeConversationId = null;
    conversaciones = [];
  }
}

/* ========================= */
/* WELCOME */
/* ========================= */

function obtenerPantallaBienvenida() {
  return `
    <div id="welcome-screen" class="welcome-screen">
      <div class="plan-pill">
        <span>Charvis AI</span>
        <button type="button" onclick="accionProximamente('Actualizar plan')">
          Actualizar
        </button>
      </div>

      <div class="hero-brand">
        <div class="hero-mark">✦</div>
        <h1>Hola, ¿en qué puedo ayudarte?</h1>
      </div>

      <div class="hero-composer-card">
        <textarea
          id="hero-input"
          placeholder="Preguntale algo a Charvis..."
          rows="1"
          autocomplete="off"
          spellcheck="false"
          wrap="soft"
          oninput="sincronizarInputs(this.value); autoResizeTextarea(this)"
        ></textarea>

        <div class="hero-actions">
          <div class="hero-actions-left">
            <button
              type="button"
              class="icon-action"
              onclick="document.getElementById('file-input').click()"
              title="Adjuntar archivo"
            >
              +
            </button>

            <button
              type="button"
              class="tool-button"
              onclick="toggleModoRazonamiento()"
            >
              Herramientas
            </button>
          </div>

          <div class="hero-actions-right">
            <button
              type="button"
              class="mode-button"
              onclick="toggleModoRazonamiento()"
              id="mode-button"
            >
              Normal
            </button>

            <button
              type="button"
              class="voice-button"
              id="hero-voice-btn"
              onclick="toggleGrabacion()"
              title="Grabar voz"
            >
              🎙
            </button>

            <button
              type="button"
              class="send-mini-button"
              onclick="enviarDesdeHero()"
              title="Enviar mensaje"
              aria-label="Enviar mensaje"
            >
              ↑
            </button>
          </div>
        </div>
      </div>

      <div class="quick-actions">
        <button type="button" onclick="insertSuggestion('Ayudame a escribir código limpio y optimizado')">
          Código
        </button>

        <button type="button" onclick="insertSuggestion('Ayudame a escribir un texto profesional')">
          Escribir
        </button>

        <button type="button" onclick="insertSuggestion('Explicame este tema paso a paso')">
          Aprender
        </button>

        <button type="button" onclick="insertSuggestion('Organizá mis ideas y tareas pendientes')">
          Asuntos personales
        </button>

        <button type="button" onclick="toggleModoRazonamiento()">
          Razonamiento
        </button>
      </div>
    </div>
  `;
}

function mostrarPantallaBienvenida() {
  const chat = document.getElementById("chat");

  if (!chat) return;

  chat.innerHTML = obtenerPantallaBienvenida();
  document.body.classList.add("welcome-active");

  sincronizarBotonesModo();
}

function removeWelcome() {
  const welcome = document.getElementById("welcome-screen");

  if (welcome) {
    welcome.remove();
  }

  document.body.classList.remove("welcome-active");
}

/* ========================= */
/* MENSAJES */
/* ========================= */

function obtenerTextoActual() {
  const heroInput = document.getElementById("hero-input");
  const messageInput = document.getElementById("message-input");

  const heroValue = heroInput ? heroInput.value.trim() : "";
  const messageValue = messageInput ? messageInput.value.trim() : "";

  return heroValue || messageValue;
}

function limpiarInputs() {
  const heroInput = document.getElementById("hero-input");
  const messageInput = document.getElementById("message-input");

  if (heroInput) {
    heroInput.value = "";
    autoResizeTextarea(heroInput);
  }

  if (messageInput) {
    messageInput.value = "";
    autoResizeTextarea(messageInput);
  }
}

function enviarMensaje(event) {
  if (event) {
    event.preventDefault();
  }

  const texto = obtenerTextoActual();

  if (!texto) {
    mostrarAvisoTemporal("Escribí un mensaje antes de enviar.");
    return;
  }

  enviarTextoCharvis(texto);
}

function enviarDesdeHero() {
  const texto = obtenerTextoActual();

  if (!texto && archivosAdjuntos.length === 0) {
    mostrarAvisoTemporal("Escribí un mensaje o adjuntá archivos antes de enviar.");
    return;
  }

  enviarTextoCharvis(texto);
}

function handleFiles(files) {
  Array.from(files).forEach(file => {
    if (file.size > 10 * 1024 * 1024) { // 10MB límite
      mostrarAvisoTemporal(`El archivo ${file.name} es demasiado grande (máx. 10MB).`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const adjunto = {
        nombre: file.name,
        tipo: file.type.startsWith('image/') ? 'imagen' : 'texto',
        dataUrl: e.target.result,
        contenido: null,
        size: file.size
      };

      if (adjunto.tipo === 'texto') {
        // Para archivos de texto, extraer el contenido
        const text = e.target.result;
        adjunto.contenido = text.length > 50000 ? text.substring(0, 50000) + '...' : text;
      }

      archivosAdjuntos.push(adjunto);
      renderFilePreviews();
    };

    if (file.type.startsWith('image/')) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });
}

function renderFilePreviews() {
  const isWelcome = document.body.classList.contains("welcome-active");
  const composer = isWelcome ? document.querySelector('.hero-composer-card') : document.querySelector('.composer-shell');
  
  if (!composer) return;

  // Clean up existing previews in both places to avoid duplicates
  document.querySelectorAll('.file-previews').forEach(el => el.remove());

  if (archivosAdjuntos.length === 0) {
    return;
  }

  const previewsContainer = document.createElement('div');
  previewsContainer.className = 'file-previews';
  composer.insertBefore(previewsContainer, composer.firstChild);

  archivosAdjuntos.forEach((adjunto, index) => {
    const preview = document.createElement('div');
    preview.className = 'file-preview';

    const html = `
      ${adjunto.tipo === 'imagen' ? `<img src="${adjunto.dataUrl}" alt="${adjunto.nombre}">` : '<div style="width:32px;height:32px;background:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;">📄</div>'}
      <div class="file-info">
        <div class="file-name">${adjunto.nombre}</div>
        <div class="file-size">${formatFileSize(adjunto.size)}</div>
      </div>
      <button class="remove-file" onclick="removeFile(${index})" title="Remover archivo">×</button>
    `;

    preview.innerHTML = html;
    previewsContainer.appendChild(preview);
  });
}

function removeFile(index) {
  archivosAdjuntos.splice(index, 1);
  renderFilePreviews();

  if (archivosAdjuntos.length === 0) {
    const previewsContainer = document.querySelector('.file-previews');
    if (previewsContainer) {
      previewsContainer.remove();
    }
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function enviarTextoCharvis(texto) {
  if (!texto && archivosAdjuntos.length === 0) return;

  cerrarTodasLasVentanas();

  // Agregar mensaje del usuario con archivos adjuntos
  agregarMensaje("usuario", texto || "Analiza los archivos adjuntos", archivosAdjuntos);
  limpiarInputs();

  // Enviar al servidor con adjuntos
  enviarAlServidor(texto || "", archivosAdjuntos);

  // Limpiar archivos adjuntos después de enviar
  archivosAdjuntos = [];
  const previewsContainer = document.querySelector('.file-previews');
  if (previewsContainer) {
    previewsContainer.remove();
  }
}

function enviarAlServidor(texto, adjuntos = []) {
  const payload = {
    type: "texto",
    texto,
    mensaje: texto,
    conversationId: activeConversationId,
    modo: modoRazonamientoActivo ? "razonamiento" : "normal",
    adjuntos: adjuntos
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return;
  }

  agregarError("Charvis se está reconectando. Intentá nuevamente en unos segundos.");
}

function sincronizarInputs(valor) {
  const input = document.getElementById("message-input");

  if (input) {
    input.value = valor;
    autoResizeTextarea(input);
  }
}

function sincronizarHeroInput(valor) {
  const heroInput = document.getElementById("hero-input");

  if (heroInput) {
    heroInput.value = valor;
    autoResizeTextarea(heroInput);
  }
}

function insertSuggestion(texto) {
  cerrarTodasLasVentanas();

  const heroInput = document.getElementById("hero-input");
  const messageInput = document.getElementById("message-input");
  const welcome = document.getElementById("welcome-screen");

  if (welcome && heroInput) {
    heroInput.value = texto;
    autoResizeTextarea(heroInput);
    heroInput.focus();
  }

  if (messageInput) {
    messageInput.value = texto;
    autoResizeTextarea(messageInput);

    if (!welcome) {
      messageInput.focus();
    }
  }
}

let toastTimeout = null;

function accionProximamente(nombreFuncion) {
  cerrarTodasLasVentanas();
  mostrarAvisoTemporal(`${nombreFuncion} estará disponible próximamente.`);
}

function mostrarAvisoTemporal(texto) {
  let aviso = document.getElementById("charvis-toast");

  if (!aviso) {
    aviso = document.createElement("div");
    aviso.id = "charvis-toast";
    aviso.setAttribute("role", "status");
    aviso.setAttribute("aria-live", "polite");
    document.body.appendChild(aviso);
  }

  aviso.textContent = texto;
  aviso.classList.add("show");

  clearTimeout(toastTimeout);

  toastTimeout = setTimeout(() => {
    aviso.classList.remove("show");
  }, 1800);
}

function cerrarToast() {
  const aviso = document.getElementById("charvis-toast");

  if (aviso) {
    aviso.classList.remove("show");
  }

  clearTimeout(toastTimeout);
}

function toggleModoRazonamiento() {
  modoRazonamientoActivo = !modoRazonamientoActivo;

  sincronizarBotonesModo();

  mostrarAvisoTemporal(
    modoRazonamientoActivo
      ? "Modo razonamiento activado."
      : "Modo normal activado."
  );
}

function sincronizarBotonesModo() {
  const label = modoRazonamientoActivo ? "Razonamiento" : "Normal";

  const modeButton = document.getElementById("mode-button");
  const reasoningToggle = document.getElementById("reasoning-toggle");
  const activeModeLabel = document.getElementById("active-mode-label");

  if (modeButton) {
    modeButton.textContent = label;
    modeButton.classList.toggle("active", modoRazonamientoActivo);
  }

  if (reasoningToggle) {
    reasoningToggle.textContent = label;
    reasoningToggle.classList.toggle("active", modoRazonamientoActivo);
  }

  if (activeModeLabel) {
    activeModeLabel.textContent = modoRazonamientoActivo
      ? "Modo razonamiento"
      : "Modo normal";
  }
}

function cerrarTodasLasVentanas() {
  cerrarToast();

  const elementosAbiertos = document.querySelectorAll(
    ".open, .show, .active-popover, .active-modal"
  );

  elementosAbiertos.forEach((elemento) => {
    if (
      elemento.id === "sidebar" ||
      elemento.id === "mode-button" ||
      elemento.id === "reasoning-toggle"
    ) {
      return;
    }

    if (elemento.id === "sidebar-backdrop") {
      return;
    }

    elemento.classList.remove("open", "show", "active-popover", "active-modal");
  });
}

document.addEventListener("keydown", (event) => {
  const target = event.target;

  if (event.key === "Escape") {
    cerrarTodasLasVentanas();
    return;
  }

  if (!target) return;

  const esTextarea =
    target.id === "hero-input" ||
    target.id === "message-input";

  if (!esTextarea) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();

    if (target.id === "hero-input") {
      enviarDesdeHero();
    } else {
      enviarMensaje(event);
    }
  }
});

function agregarMensaje(rol, texto, adjuntos = []) {
  const chat = document.getElementById("chat");

  if (!chat) return;

  removeWelcome();

  const message = document.createElement("div");
  message.className = `message ${normalizarRol(rol)}`;

  const text = document.createElement("div");
  text.className = "msg-text";
  const rolNorm = normalizarRol(rol);
  if (rolNorm === "charvis") {
    text.innerHTML = markdownToHtml(texto || "");
  } else {
    text.textContent = texto || "";
  }

  message.appendChild(text);

  // Agregar previews de archivos adjuntos
  if (adjuntos && adjuntos.length > 0) {
    const attachmentsDiv = document.createElement("div");
    attachmentsDiv.className = "message-attachments";

    adjuntos.forEach(adjunto => {
      const attachment = document.createElement("div");
      attachment.className = "attachment";

      if (adjunto.tipo === 'imagen') {
        const img = document.createElement("img");
        img.src = adjunto.dataUrl;
        img.alt = adjunto.nombre;
        img.style.maxWidth = "200px";
        img.style.maxHeight = "200px";
        img.style.borderRadius = "8px";
        img.style.marginTop = "8px";
        attachment.appendChild(img);
      } else {
        const fileDiv = document.createElement("div");
        fileDiv.className = "file-attachment";
        fileDiv.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-top:8px;">
            <div style="width:24px;height:24px;background:var(--accent);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px;">📄</div>
            <div>
              <div style="font-weight:500;font-size:14px;">${adjunto.nombre}</div>
              <div style="font-size:12px;color:var(--muted);">${formatFileSize(adjunto.size)}</div>
            </div>
          </div>
        `;
        attachment.appendChild(fileDiv);
      }

      attachmentsDiv.appendChild(attachment);
    });

    message.appendChild(attachmentsDiv);
  }

  chat.appendChild(message);

  chat.scrollTop = chat.scrollHeight;

  guardarMensajeEnConversacion({
    tipo: "mensaje",
    rol: normalizarRol(rol),
    texto,
    adjuntos: adjuntos
  });
}

function agregarError(texto) {
  const chat = document.getElementById("chat");

  if (!chat) return;

  removeWelcome();

  const message = document.createElement("div");
  message.className = "message error";

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = texto || "Ocurrió un error.";

  message.appendChild(text);
  chat.appendChild(message);

  chat.scrollTop = chat.scrollHeight;

  guardarMensajeEnConversacion({
    tipo: "error",
    texto
  });
}

function normalizarRol(rol) {
  const r = String(rol || "").toLowerCase();

  if (r === "user" || r === "usuario") return "usuario";
  if (r === "assistant" || r === "asistente" || r === "charvis") return "charvis";

  return r || "charvis";
}

function esRolUsuario(rol) {
  const r = normalizarRol(rol);
  return r === "usuario" || r === "user";
}

/* ========================= */
/* INPUTS Y BOTONES */
/* ========================= */

function autoResizeTextarea(textarea) {
  if (!textarea) return;

  const isHero = textarea.id === "hero-input";
  const maxHeight = isHero ? 142 : 130;

  textarea.style.height = "auto";

  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

/* ========================= */
/* SIDEBAR */
/* ========================= */

function esMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function abrirSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");

  if (sidebar) {
    sidebar.classList.add("open");
  }

  if (backdrop && esMobile()) {
    backdrop.classList.add("show");
  }

  if (esMobile()) {
    document.body.classList.add("sidebar-open");
  }
}

function cerrarSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");

  if (sidebar) {
    sidebar.classList.remove("open");
  }

  if (backdrop) {
    backdrop.classList.remove("show");
  }

  document.body.classList.remove("sidebar-open");
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");

  if (!sidebar) return;

  if (sidebar.classList.contains("open")) {
    cerrarSidebar();
  } else {
    abrirSidebar();
  }
}

window.addEventListener("resize", () => {
  const backdrop = document.getElementById("sidebar-backdrop");

  if (!esMobile()) {
    if (backdrop) {
      backdrop.classList.remove("show");
    }

    document.body.classList.remove("sidebar-open");
  }
});

/* ========================= */
/* MOBILE KEYBOARD */
/* ========================= */

function configurarTecladoMobile() {
  if (!window.visualViewport) return;

  window.visualViewport.addEventListener("resize", () => {
    const composer = document.getElementById("composer");

    if (!composer || document.body.classList.contains("welcome-active")) return;

    const viewportHeight = window.visualViewport.height;
    const windowHeight = window.innerHeight;
    const keyboardHeight = windowHeight - viewportHeight;

    if (keyboardHeight > 120 && esMobile()) {
      composer.style.bottom = `${keyboardHeight + 8}px`;
    } else {
      composer.style.bottom = "";
    }
  });
}

/* ========================= */
/* COMPATIBILIDAD */
/* ========================= */

function limpiar() {
  const conversacion = obtenerConversacionActiva();
  if (!conversacion) return;
  conversacion.mensajes = [];
  mostrarPantallaBienvenida();
  guardarConversaciones();
  actualizarSidebarConversaciones();
}

/* ========================= */
/* BORRAR CONVERSACIÓN */
/* ========================= */

function borrarConversacion(conversationId) {
  const idx = conversaciones.findIndex(c => c.id === conversationId);
  if (idx === -1) return;

  conversaciones.splice(idx, 1);

  if (conversaciones.length === 0) {
    conversationCount = 0;
  }

  if (activeConversationId === conversationId) {
    if (conversaciones.length > 0) {
      activeConversationId = conversaciones[0].id;
      renderizarConversacion(obtenerConversacionActiva());
    } else {
      const nueva = crearConversacion("Conversación 1");
      activeConversationId = nueva.id;
      mostrarPantallaBienvenida();
    }
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "limpiar", conversationId }));
  }

  guardarConversaciones();
  actualizarSidebarConversaciones();
  actualizarTituloConversacion();
}

/* ========================= */
/* AUDIO TOGGLE */
/* ========================= */

function toggleAudio() {
  audioActivo = !audioActivo;
  const btn = document.getElementById("audio-toggle");
  if (btn) {
    btn.textContent = audioActivo ? "🔊" : "🔇";
    btn.title = audioActivo ? "Voz activada" : "Voz silenciada";
  }
  
  if (!audioActivo) {
    speechSynthesis.cancel();
    if (currentAudio) {
      currentAudio.pause();
    }
  }
  
  mostrarAvisoTemporal(audioActivo ? "Voz activada" : "Voz silenciada");
}

/* ========================= */
/* VOZ — GRABACIÓN */
/* ========================= */

async function toggleGrabacion() {
  if (grabando) {
    detenerGrabacion();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      if (blob.size < 1000) { mostrarAvisoTemporal("Audio muy corto, intentá de nuevo."); return; }
      const buffer = await blob.arrayBuffer();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
        mostrarEstadoTemporal("transcribiendo");
      } else {
        agregarError("Sin conexión al servidor.");
      }
    };

    mediaRecorder.start();
    grabando = true;
    actualizarBotonesVoz(true);
    mostrarAvisoTemporal("Grabando... tocá el micrófono para detener.");
  } catch (err) {
    mostrarAvisoTemporal("No se pudo acceder al micrófono: " + err.message);
  }
}

function detenerGrabacion() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  grabando = false;
  actualizarBotonesVoz(false);
}

function actualizarBotonesVoz(rec) {
  const btns = ["voice-btn", "hero-voice-btn"];
  btns.forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.textContent = rec ? "⏹" : "🎙";
    b.classList.toggle("recording", rec);
    b.title = rec ? "Detener grabación" : "Grabar voz";
  });
}

/* ========================= */
/* MARKDOWN BÁSICO */
/* ========================= */

function markdownToHtml(text) {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/^#{3} (.+)$/gm, "<h3>$1</h3>")
    .replace(/^#{2} (.+)$/gm, "<h2>$1</h2>")
    .replace(/^#{1} (.+)$/gm, "<h1>$1</h1>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
  if (!html.startsWith("<")) html = "<p>" + html + "</p>";
  return html;
}

/* ========================= */
/* ESTADO VISUAL */
/* ========================= */

function mostrarEstadoTemporal(valor) {
  const estados = {
    pensando: "💭 Pensando...",
    razonando: "🧠 Razonando...",
    hablando: "🔊 Respondiendo...",
    transcribiendo: "🎙 Transcribiendo voz...",
    entendiendo_problema: "🔍 Analizando el problema...",
    creando_plan: "📋 Creando plan...",
    ejecutando_plan: "⚙️ Ejecutando plan...",
    verificando_respuesta: "✅ Revisando respuesta...",
    finalizado: "✓ Listo",
    escuchando: "👂 Escuchando..."
  };
  const texto = estados[valor] || valor;
  mostrarAvisoTemporal(texto);
}

/* ========================= */
/* EFECTO VISUAL LOGIN (ORBES) */
/* ========================= */

function initAmbientCanvas() {
  const canvas = document.getElementById('ambient-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  let width = canvas.width = canvas.offsetWidth;
  let height = canvas.height = canvas.offsetHeight;
  
  let mouse = { x: width / 2, y: height / 2, moved: false };
  
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
    mouse.moved = true;
  });

  window.addEventListener('resize', () => {
    width = canvas.width = canvas.offsetWidth;
    height = canvas.height = canvas.offsetHeight;
  });

  const orbs = [];
  // Colores intensos y vibrantes tipo Gemini/Siri
  const colors = [
    '#4F46E5', // Indigo vibrante
    '#EC4899', // Rosa neón
    '#8B5CF6', // Púrpura eléctrico
    '#F59E0B', // Ámbar brillante
    '#06B6D4'  // Cyan intenso
  ];

  for (let i = 0; i < 6; i++) {
    orbs.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      radius: Math.random() * 400 + 300, // Orbes enormes para que se mezclen
      color: colors[i % colors.length],
      targetX: Math.random() * width,
      targetY: Math.random() * height,
      angle: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.02 + 0.01
    });
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    
    // Fondo base oscuro premium
    ctx.fillStyle = '#05050A';
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'screen'; // Fusión aditiva para que brillen juntos

    orbs.forEach((orb, i) => {
      // El orbe principal (índice 0) o índice 1 siguen al mouse más intensamente
      if ((i === 0 || i === 1) && mouse.moved) {
        orb.targetX = mouse.x + (i===1 ? 100 * Math.cos(orb.angle) : 0);
        orb.targetY = mouse.y + (i===1 ? 100 * Math.sin(orb.angle) : 0);
      } else {
        // Movimiento caótico y fluido
        orb.targetX += orb.vx;
        orb.targetY += orb.vy;
        
        if (orb.targetX < -orb.radius || orb.targetX > width + orb.radius) orb.vx *= -1;
        if (orb.targetY < -orb.radius || orb.targetY > height + orb.radius) orb.vy *= -1;
      }

      orb.angle += orb.speed;

      // Movimiento suave con un toque de seno/coseno para simular fluido
      orb.x += (orb.targetX - orb.x) * 0.03 + Math.sin(orb.angle) * 2;
      orb.y += (orb.targetY - orb.y) * 0.03 + Math.cos(orb.angle) * 2;

      // Dibuja el gradiente radial intenso
      const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, orb.radius);
      // Extraemos el RGB de los hex
      let hex = orb.color.replace('#','');
      let r = parseInt(hex.substring(0,2), 16);
      let g = parseInt(hex.substring(2,4), 16);
      let b = parseInt(hex.substring(4,6), 16);
      
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.8)`);
      grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.3)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.globalCompositeOperation = 'source-over'; // Restaurar
    requestAnimationFrame(render);
  }

  render();
}