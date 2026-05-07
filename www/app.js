let conversationCount = 0;
let conversaciones = [];
let activeConversationId = null;
let renderizandoConversacion = false;
let modoRazonamientoActivo = false;
let ws = null;
let archivosAdjuntos = [];

const STORAGE_KEY = "charvis_conversaciones_v2";

/* ========================= */
/* INICIO */
/* ========================= */

document.addEventListener("DOMContentLoaded", () => {
  cargarConversaciones();
  iniciarConversaciones();
  conectarWebSocket();
  renderizarConversacion(obtenerConversacionActiva());
  configurarTecladoMobile();
});

/* ========================= */
/* WEBSOCKET */
/* ========================= */

function conectarWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}`;

  try {
    ws = new WebSocket(url);

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
    agregarError(msg.texto || "Ocurrió un error.");
    return;
  }

  if (msg.type === "estado") {
    mostrarEstadoTemporal(msg.valor || "pensando");
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

function enviarAlServidor(texto) {
  const payload = {
    type: "texto",
    texto,
    mensaje: texto,
    conversationId: activeConversationId,
    modo: modoRazonamientoActivo ? "razonamiento" : "normal"
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return;
  }

  agregarError("Charvis se está reconectando. Intentá nuevamente en unos segundos.");
}

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
    const item = document.createElement("button");

    item.type = "button";
    item.className = "history-item";
    item.classList.toggle("active", conversacion.id === activeConversationId);
    item.textContent = conversacion.titulo;
    item.onclick = () => seleccionarConversacion(conversacion.id);

    sidebarHistory.appendChild(item);
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
              onclick="accionProximamente('Adjuntar archivo')"
              title="Adjuntar archivo"
            >
              +
            </button>

            <button
              type="button"
              class="tool-button"
              onclick="accionProximamente('Herramientas')"
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
              onclick="accionProximamente('Voz')"
              title="Voz"
            >
              ◌
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
  const composer = document.querySelector('.composer-shell');
  let previewsContainer = composer.querySelector('.file-previews');

  if (!previewsContainer) {
    previewsContainer = document.createElement('div');
    previewsContainer.className = 'file-previews';
    composer.insertBefore(previewsContainer, composer.firstChild);
  }

  previewsContainer.innerHTML = '';

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
  text.textContent = texto || "";

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