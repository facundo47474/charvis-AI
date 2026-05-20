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
let totalUsageGlobal = -1;

// Auth state
let authToken = localStorage.getItem("charvis_token");
let currentUser = null;
let STORAGE_KEY = "charvis_conversaciones_v2"; // Se actualizará al loguear
let currentAudio = null;
let currentAssistantMessageId = null; // Para streaming
let isGenerating = false;
let isStreamingActive = false; // Previene que el typing indicator reaparezca durante streaming
const MAX_INPUT_CHARS = 12000;


/* ========================= */
/* INICIO */
/* ========================= */

document.addEventListener("DOMContentLoaded", async () => {
  if (window.location.protocol === "file:" || (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1" && !window.location.hostname.includes("ngrok") && !window.location.hostname.includes("render"))) {
    // permitimos en produccion o localhost
  } else if (window.location.port !== "3000" && window.location.port !== "") {
    alert("¡ESTÁS EN LA URL INCORRECTA!\nPara ver los cambios, debes cerrar esta pestaña y entrar a: http://localhost:3000\nEl servidor de Node no funciona a través de Live Server ni doble clic.");
  }

  await inicializarAuth();
  configurarTecladoMobile();
  
  // Desbloquear AudioContext en la primera interacción para evitar bloqueo del navegador
  document.body.addEventListener("click", unlockAudioContext, { once: true });
  document.body.addEventListener("keydown", unlockAudioContext, { once: true });
});

let audioUnlocked = false;
function unlockAudioContext() {
  if (audioUnlocked) return;
  // Play silent speech
  const msg = new SpeechSynthesisUtterance('');
  msg.volume = 0;
  window.speechSynthesis.speak(msg);
  
  // Play silent audio object
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  ctx.resume();
  
  audioUnlocked = true;
  console.log("AudioContext unlocked");
}

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

  // Si no hay token válido, mostrar login
  loginScreen.classList.remove("fade-out");
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

          const btnContainer = document.getElementById("google-btn-container");
          // 1. Calculamos el ancho exacto disponible para igualar ambos botones
          // (Google tiene un límite máximo duro de 400px en su iframe)
          let targetWidth = btnContainer.parentElement.clientWidth;
          if (targetWidth > 400) targetWidth = 400;
          if (targetWidth < 200) targetWidth = 280; // Fallback seguro

          // 2. Renderizamos el botón de Google con ancho en píxeles absolutos
          google.accounts.id.renderButton(
            btnContainer,
            { theme: "outline", size: "large", type: "standard", width: targetWidth, text: "continue_with" }
          );

          // 3. Forzamos el botón de invitado a medir EXACTAMENTE lo mismo
          const guestBtn = document.getElementById("guest-login-btn");
          if (guestBtn) {
            guestBtn.style.maxWidth = targetWidth + "px";
            guestBtn.style.width = "100%";
            guestBtn.style.margin = "0 auto";
            guestBtn.style.display = "block";
          }
        } else {
          setTimeout(initGoogle, 100);
        }
      };
      initGoogle();
    } else {
      document.getElementById("login-error").textContent = "Google Client ID no configurado en el servidor.";
    }
  } catch (e) {
    console.error("Error obteniendo config:", e);
    document.getElementById("login-error").textContent = "Error de conexión: Verifica que el servidor (node server.js) esté corriendo y no estés abriendo el archivo como HTML estático. Detalle: " + e.message;
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

async function handleGuestLogin() {
  const guestUser = {
    name: "Invitado",
    email: "guest@charvis.ai",
    picture: null,
    isGuest: true
  };
  alCompletarLogin(guestUser);
}

function alCompletarLogin(user) {
  currentUser = user;
  
  // Transición suave del login a la app
  const loginScreen = document.getElementById("login-screen");
  const appContainer = document.getElementById("app");
  
  loginScreen.classList.add("fade-out");
  setTimeout(() => {
    loginScreen.style.display = "none";
    appContainer.style.opacity = "0";
    appContainer.style.display = "flex";
    
    // Fade in app
    requestAnimationFrame(() => {
      appContainer.style.transition = "opacity 0.5s ease";
      appContainer.style.opacity = "1";
    });
  }, 400);

  const safeName = (user.email || user.name || "default").replace(/[^a-zA-Z0-9]/g, "_");
  STORAGE_KEY = `charvis_conversaciones_v2_${safeName}`;

  const avatar = document.getElementById("user-avatar");
  const nameLabel = document.getElementById("user-name");

  if (user.picture) {
    avatar.innerHTML = `
      <img src="${user.picture}" alt="Avatar" class="user-avatar" id="userAvatar" referrerpolicy="no-referrer" onerror="handleAvatarError(this)">
      <div class="avatar-fallback" style="display:none;">${user.name.charAt(0).toUpperCase()}</div>
    `;
  } else {
    avatar.innerHTML = `
      <div class="avatar-fallback" style="display:flex;">${user.name.charAt(0).toUpperCase()}</div>
    `;
  }
  nameLabel.textContent = user.name;

  cargarConversaciones();
  iniciarConversaciones();
  conectarWebSocket();
  if (user.isGuest) {
    mostrarAvisoTemporal("Modo invitado: 100 usos disponibles. Registrate para obtener 300.");
  }
  renderizarConversacion(obtenerConversacionActiva());
  // Cargar uso real desde el servidor
  cargarUsageDesdeServidor();
}

async function cerrarSesion() {
  if (authToken && currentUser && !currentUser.isGuest) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}` }
      });
    } catch (e) { }
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
  } else if (currentUser && currentUser.isGuest) {
    urlStr += `?token=guest`;
  }

  try {
    ws = new WebSocket(urlStr);

    ws.onopen = () => {
      actualizarEstadoConexion(true);
    };

    ws.onclose = () => {
      actualizarEstadoConexion(false);
      
      // Recuperar estado congelado si el socket se cierra de golpe
      if (isGenerating) {
        setGeneratingState(false);
        ocultarTypingIndicator();
        mostrarAvisoTemporal("Conexión perdida. Esperando reconexión...");
      }

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

function actualizarEstadoConexion(conectado, credits = null) {
  const status = document.getElementById("connection-status");
  if (!status) return;

  status.classList.toggle("offline", !conectado);
  const text = status.querySelector("span:last-child");

  if (credits !== null) {
    status.classList.add("credits-pill");
    status.innerHTML = `<span class="credit-icon">🪙</span> <span>${credits} Créditos</span>`;
    return;
  }

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

  // Actualizar créditos si vienen en el mensaje
  if (msg.credits !== undefined) {
    actualizarEstadoConexion(true, msg.credits);
  }

  const conversationId = msg.conversationId || activeConversationId;

  if (conversationId && conversationId !== activeConversationId) {
    guardarMensajeServidorEnConversacion(conversationId, msg);
    return;
  }

  if (msg.type === "mensaje" || msg.type === "respuesta") {
    setGeneratingState(false);
    isStreamingActive = false;
    ocultarTypingIndicator();
    if (currentAssistantMessageId) {
      const messageEl = document.getElementById(currentAssistantMessageId);
      if (messageEl) {
        const textEl = messageEl.querySelector(".msg-text");

        let finalTexto = msg.texto || msg.content;
        if (finalTexto === undefined || finalTexto === null) {
          finalTexto = textEl.getAttribute("data-raw") || "";
        }

        textEl.setAttribute("data-raw", finalTexto);
        textEl.innerHTML = markdownToHtml(finalTexto);
        renderizarMatematicas(textEl);

        // Guardar el mensaje final del asistente en memoria
        guardarMensajeEnConversacion({
          tipo: "mensaje",
          rol: "charvis",
          texto: finalTexto
        });

        currentAssistantMessageId = null;
        return;
      }
    }
    const rol = normalizarRol(msg.rol || "charvis");
    const texto = msg.texto || msg.content || "";
    if (texto) {
      agregarMensaje(rol, texto);
      guardarMensajeEnConversacion({
        tipo: "mensaje",
        rol: rol,
        texto: texto
      });
    }
    return;
  }

  if (msg.type === "error") {
    setGeneratingState(false);
    ocultarTypingIndicator();
    agregarError(msg.texto || msg.mensaje || "Ocurrió un error.");
    return;
  }

  if (msg.type === "delta") {
    manejarDeltaStreaming(msg.texto || "");
    return;
  }

  if (msg.type === "estado") {
    const estadosPensando = ["pensando", "razonando", "entendiendo_problema", "creando_plan", "ejecutando_plan", "verificando_respuesta", "pensando_multi_modelo", "sintetizando"];
    // Solo mostrar typing indicator si el streaming no ha comenzado aún
    if (estadosPensando.includes(msg.valor) && !isStreamingActive) {
      mostrarTypingIndicator();
    } else if (msg.valor === "escribiendo") {
      ocultarTypingIndicator();
    }
    if (msg.valor === "escribiendo" || msg.valor === "razonando") {
      setGeneratingState(true);
    }
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
      currentAudio.play().catch(() => { });
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
    setGeneratingState(false);
    isStreamingActive = false;
    ocultarTypingIndicator();
    // Finalizar el mensaje en streaming guardándolo en memoria
    if (currentAssistantMessageId) {
      const messageEl = document.getElementById(currentAssistantMessageId);
      if (messageEl) {
        const textEl = messageEl.querySelector(".msg-text");
        const finalTexto = textEl ? (textEl.getAttribute("data-raw") || "") : "";
        if (finalTexto) {
          textEl.innerHTML = markdownToHtml(finalTexto);
          renderizarMatematicas(textEl);
          guardarMensajeEnConversacion({
            tipo: "mensaje",
            rol: "charvis",
            texto: finalTexto
          });
        }
      }
      currentAssistantMessageId = null;
    }
    return;
  }

  // Actualizar barra de uso en tiempo real desde el servidor
  if (msg.type === "usage_update") {
    actualizarLimitesUso(msg.usage, msg.limit);
    return;
  }
}

function manejarDeltaStreaming(texto) {
  // Marcar streaming activo y ocultar typing indicator al primer delta
  if (!isStreamingActive) {
    isStreamingActive = true;
    ocultarTypingIndicator();
  }

  if (!currentAssistantMessageId) {
    agregarMensaje("charvis", "", [], true);
  }

  const messageEl = document.getElementById(currentAssistantMessageId);
  if (!messageEl) return;

  const textEl = messageEl.querySelector(".msg-text");
  if (!textEl) return;

  // Acumular texto
  const currentText = textEl.getAttribute("data-raw") || "";
  const newText = currentText + texto;
  textEl.setAttribute("data-raw", newText);
  textEl.innerHTML = markdownToHtml(newText);
  renderizarMatematicas(textEl);

  // Auto scroll
  const chat = document.getElementById("chat");
  chat.scrollTop = chat.scrollHeight;
}

/* --- Fase 3.3: Typing Indicator --- */
function mostrarTypingIndicator() {
  const chat = document.getElementById("chat");
  if (!chat) return;

  // Si ya existe, no hacemos nada para evitar parpadeos y saltos en la interfaz
  if (document.getElementById("charvis-typing-indicator")) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.id = "charvis-typing-indicator";
  wrapper.className = "message charvis";
  wrapper.style.cssText = "animation: msgFadeUp 0.3s ease both;";

  // Avatar
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.innerHTML = '<img src="/assets/istockphoto-1366401566-1024x1024.jpg" class="charvis-logo" alt="Charvis">';
  wrapper.appendChild(avatar);

  // Typing bubble
  const content = document.createElement("div");
  content.className = "msg-content";
  content.innerHTML = `
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
  wrapper.appendChild(content);

  chat.appendChild(wrapper);
  requestAnimationFrame(() => {
    wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
  });
}

function ocultarTypingIndicator() {
  const els = document.querySelectorAll("#charvis-typing-indicator");
  els.forEach(el => {
    el.removeAttribute("id");
    el.style.opacity = "0";
    el.style.transform = "translateY(4px)";
    el.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    setTimeout(() => el.remove(), 220);
  });
}

function setGeneratingState(generating) {
  isGenerating = generating;
  actualizarBotonesEnvio();
}

function actualizarBotonesEnvio() {
  const btns = document.querySelectorAll(".send-btn");
  btns.forEach(btn => {
    if (isGenerating) {
      btn.innerHTML = "■";
      btn.classList.add("stop-btn");
      btn.onclick = (e) => { e.preventDefault(); abortGeneration(); };
      btn.title = "Detener generación";
    } else {
      btn.innerHTML = "↑";
      btn.classList.remove("stop-btn");
      btn.onclick = (e) => { e.preventDefault(); const isHero = btn.closest('.prompt-box')?.id === 'hero-input-container'; isHero ? enviarDesdeHero() : enviarMensaje(); };
      btn.title = "Enviar mensaje";
    }
  });
}

function abortGeneration() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "abort", conversationId: activeConversationId }));
  }
  setGeneratingState(false);
  mostrarAvisoTemporal("Generación cancelada.");
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

function generarNombreSiguiente() {
  const numeros = conversaciones
    .map(c => {
      const match = c.titulo.match(/^Conversación (\d+)$/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter(n => n !== null)
    .sort((a, b) => a - b);

  let proximo = 1;
  for (let n of numeros) {
    if (n === proximo) {
      proximo++;
    } else if (n > proximo) {
      break;
    }
  }
  return `Conversación ${proximo}`;
}

function crearConversacion(nombre = null) {
  const titulo = nombre || generarNombreSiguiente();

  const conversacion = {
    id: `conv-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    titulo: titulo,
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

  const mensajeGuardar = { ...mensaje };
  if (mensajeGuardar.adjuntos && Array.isArray(mensajeGuardar.adjuntos)) {
    mensajeGuardar.adjuntos = mensajeGuardar.adjuntos.map(adj => {
      const { contenido, dataUrl, ...resto } = adj;
      return resto;
    });
  }

  conversacion.mensajes.push(mensajeGuardar);

  // LÍMITE DE MEMORIA: Conservar solo los últimos 40 mensajes para no saturar ni la memoria ni los tokens
  const MAX_MENSAJES = 40;
  if (conversacion.mensajes.length > MAX_MENSAJES) {
    conversacion.mensajes.splice(0, conversacion.mensajes.length - MAX_MENSAJES);
  }

  if (
    mensajeGuardar.tipo === "mensaje" &&
    esRolUsuario(mensajeGuardar.rol)
  ) {
    if (totalUsageGlobal === -1) {
      totalUsageGlobal = 0;
      conversaciones.forEach(c => {
        totalUsageGlobal += c.mensajes.filter(m => esRolUsuario(m.rol)).length;
      });
    }
    totalUsageGlobal++;
  }

  if (
    mensajeGuardar.tipo === "mensaje" &&
    esRolUsuario(mensajeGuardar.rol) &&
    conversacion.titulo.startsWith("Conversación")
  ) {
    const titulo = String(mensajeGuardar.texto || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 36);

    if (titulo) {
      conversacion.titulo = titulo.length >= 36 ? `${titulo}...` : titulo;
    }
  }

  try {
    guardarConversaciones();
  } catch (e) {
    console.error("Error guardando en localStorage:", e);
    conversacion.mensajes.pop();
  }

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
    item.className = "conversation";
    if (conversacion.id === activeConversationId) item.classList.add("active");
    item.onclick = () => seleccionarConversacion(conversacion.id);

    const dot = document.createElement("span");
    dot.className = "conversation-dot";
    item.appendChild(dot);

    const textNode = document.createTextNode(" " + conversacion.titulo);
    item.appendChild(textNode);

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

  actualizarLimitesUso();
}

async function cargarUsageDesdeServidor() {
  try {
    const headers = authToken ? { "Authorization": `Bearer ${authToken}` } : {};
    const res = await fetch("/api/usage", { headers });
    if (!res.ok) return;
    const data = await res.json();
    // data: { usage, limit }
    totalUsageGlobal = data.usage;
    actualizarLimitesUso(data.usage, data.limit);
  } catch (e) {
    console.warn("[Usage] No se pudo cargar el uso desde el servidor:", e.message);
  }
}

function actualizarLimitesUso(usage, limit) {
  const isGuest = currentUser && currentUser.isGuest;

  // Si no se pasan parámetros del servidor, usar local (fallback)
  if (usage === undefined) {
    const maxLimit = isGuest ? 100 : 300;
    if (totalUsageGlobal === -1) {
      totalUsageGlobal = 0;
      conversaciones.forEach(c => {
        totalUsageGlobal += c.mensajes.filter(m => esRolUsuario(m.rol)).length;
      });
    }
    usage = totalUsageGlobal;
    limit = maxLimit;
  } else {
    totalUsageGlobal = usage;
  }

  const barFill = document.getElementById("usage-bar-fill");
  const countText = document.getElementById("usage-count-text");

  if (!barFill || !countText) return;

  const percentage = Math.min((usage / limit) * 100, 100);
  countText.textContent = `${usage} / ${limit}`;

  setTimeout(() => {
    barFill.style.width = `${percentage}%`;
    if (percentage > 90) {
      barFill.style.background = "linear-gradient(90deg, #ff7a3d 0%, #ff3333 100%)";
    } else {
      barFill.style.background = "linear-gradient(90deg, #2ee6a6 0%, #ff7a3d 50%, #cf5fff 100%)";
    }
  }, 100);
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
    conversaciones,
    totalUsage: totalUsageGlobal
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // QuotaExceededError: localStorage lleno (~5MB)
    if (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014) {
      console.warn("⚠️ localStorage lleno. Podando conversaciones antiguas...");
      podarConversacionesAntiguas();
      try {
        const dataPodada = {
          conversationCount,
          activeConversationId,
          conversaciones,
          totalUsage: totalUsageGlobal
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dataPodada));
      } catch (e2) {
        console.error("❌ No se pudo guardar ni después de podar:", e2);
        mostrarAvisoTemporal("⚠️ Almacenamiento lleno. Borrá conversaciones antiguas para liberar espacio.");
      }
    } else {
      console.error("Error guardando en localStorage:", e);
    }
  }
}

function podarConversacionesAntiguas() {
  // 1. Recortar mensajes en todas las conversaciones
  conversaciones.forEach(c => {
    if (c.mensajes.length > 15) {
      c.mensajes = c.mensajes.slice(-15);
    }
  });

  // 2. Si aún hay más de 5 conversaciones, eliminar las más antiguas (excepto la activa)
  if (conversaciones.length > 5) {
    const activa = conversaciones.find(c => c.id === activeConversationId);
    const otras = conversaciones.filter(c => c.id !== activeConversationId);
    const recientes = otras.slice(-4);
    conversaciones = activa ? [activa, ...recientes] : recientes;
    mostrarAvisoTemporal("Se eliminaron conversaciones antiguas para liberar espacio.");
  }
}

function cargarConversaciones() {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) return;

  try {
    const data = JSON.parse(raw);

    conversationCount = Number(data.conversationCount || 0);
    activeConversationId = data.activeConversationId || null;
    conversaciones = Array.isArray(data.conversaciones) ? data.conversaciones : [];

    totalUsageGlobal = data.totalUsage !== undefined ? Number(data.totalUsage) : -1;

    if (totalUsageGlobal === -1) {
      totalUsageGlobal = 0;
      conversaciones.forEach(c => {
        totalUsageGlobal += c.mensajes.filter(m => esRolUsuario(m.rol)).length;
      });
      guardarConversaciones();
    }
  } catch {
    conversationCount = 0;
    activeConversationId = null;
    conversaciones = [];
    totalUsageGlobal = 0;
  }
}

/* ========================= */
/* WELCOME */
/* ========================= */

function obtenerPantallaBienvenida() {
  const userName = currentUser ? currentUser.name.split(' ')[0] : '';
  const title = userName ? `Hola, ${userName}` : "Hola, ¿en qué puedo ayudarte?";

  return `
    <div class="upgrade-pill">
      <span>Charvis AI</span>
      <button type="button" onclick="accionProximamente('Actualizar plan')">Actualizar</button>
    </div>

    <h1>
      <span>✦</span>
      ${title}
    </h1>

    <div class="prompt-box">
      <textarea
        id="hero-input"
        placeholder="Pregúntale algo a Charvis..."
        rows="1"
        autocomplete="off"
        spellcheck="false"
        wrap="soft"
        oninput="sincronizarInputs(this.value); autoResizeTextarea(this)"
      ></textarea>

      <div class="prompt-actions">
        <div class="prompt-actions-left">
          <button type="button" class="round-btn" onclick="document.getElementById('file-input').click()" title="Adjuntar archivo">+</button>
        </div>

        <div class="prompt-actions-right">
          <div class="mode-selector-container">
            <button type="button" class="mode-btn" id="hero-mode-button" onclick="toggleModeDropdown(true)">
              ✨ Normal ▾
            </button>
            <div class="mode-dropdown" id="hero-mode-dropdown">
              <button type="button" onclick="setMode('normal')" class="mode-option active" id="hero-opt-normal">✨ Normal</button>
              <button type="button" onclick="setMode('razonamiento')" class="mode-option" id="hero-opt-razonamiento">🧠 Razonamiento</button>
              <button type="button" onclick="setMode('pro')" class="mode-option" id="hero-opt-pro">🚀 Charvis Pro <span class="badge">Swarm</span></button>
            </div>
          </div>

          <button type="button" class="round-btn small voice-btn" id="hero-voice-btn" onclick="toggleGrabacion()" title="Grabar voz">
            🎙
          </button>

          <button type="button" class="send-btn" onclick="enviarDesdeHero()" title="Enviar mensaje">
            ↑
          </button>
        </div>
      </div>
    </div>

    <div class="suggestions">
      <button type="button" id="ctx-codigo" onclick="selectContext('codigo', 'Ayúdame a escribir código limpio y optimizado')">Código</button>
      <button type="button" id="ctx-escribir" onclick="selectContext('escribir', 'Ayúdame a redactar un texto profesional')">Escribir</button>
      <button type="button" id="ctx-aprender" onclick="selectContext('aprender', 'Explícame este tema paso a paso')">Aprender</button>
      <button type="button" id="ctx-personal" onclick="selectContext('personal', 'Organiza mis ideas y tareas pendientes')">Asuntos personales</button>
    </div>
  `;
}

let activeContext = null;

function selectContext(contextId, suggestion) {
  // Toggle visual state
  const buttons = document.querySelectorAll('.suggestions button');
  buttons.forEach(btn => btn.classList.remove('active'));

  if (activeContext === contextId) {
    activeContext = null;
    mostrarAvisoTemporal("Contexto desactivado.");
  } else {
    activeContext = contextId;
    const activeBtn = document.getElementById(`ctx-${contextId}`);
    if (activeBtn) activeBtn.classList.add('active');

    // Also insert suggestion if provided
    if (suggestion) {
      insertSuggestion(suggestion);
    }
    mostrarAvisoTemporal(`Contexto: ${contextId.charAt(0).toUpperCase() + contextId.slice(1)} activado.`);
  }
}

function mostrarPantallaBienvenida() {
  const chat = document.getElementById("chat");

  if (!chat) return;

  chat.innerHTML = obtenerPantallaBienvenida();
  chat.classList.add("is-welcome");
  document.body.classList.add("welcome-active");

  sincronizarBotonesModo();
}

function removeWelcome() {
  const chat = document.getElementById("chat");
  if (chat && chat.classList.contains("is-welcome")) {
    chat.innerHTML = "";
    chat.classList.remove("is-welcome");
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
  if (isGenerating) {
    abortGeneration();
    return;
  }

  const texto = obtenerTextoActual();

  if (!texto && archivosAdjuntos.length === 0) {
    mostrarAvisoTemporal("Escribí un mensaje o adjuntá archivos antes de enviar.");
    return;
  }

  if (texto.length > MAX_INPUT_CHARS) {
    mostrarAvisoTemporal("Tu mensaje es demasiado largo. Por favor, reducilo.");
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
      const dataB64 = e.target.result;
      const adjunto = {
        nombre: file.name,
        tipo: file.type || 'application/octet-stream',
        dataUrl: file.type.startsWith('image/') ? dataB64 : null, // Solo imágenes necesitan dataUrl visual
        contenido: dataB64, // El backend decodifica Base64 de forma nativa a un buffer intacto
        size: file.size
      };

      archivosAdjuntos.push(adjunto);
      renderFilePreviews();
    };

    // SIEMPRE leemos como DataURL (Base64). Si se usa readAsText en un PDF o Word,
    // se corrompe el binario transformándolo en caracteres  inválidos.
    reader.readAsDataURL(file);
  });
}

function renderFilePreviews() {
  const isWelcome = document.body.classList.contains("welcome-active");
  const composer = isWelcome ? document.querySelector('.is-welcome .prompt-box') : document.querySelector('.composer .prompt-box');

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

    const esImagenAdjunto = String(adjunto.tipo || "").startsWith("image/");
    const html = `
      ${esImagenAdjunto ? `<img src="${adjunto.dataUrl}" alt="${adjunto.nombre}">` : '<div style="width:32px;height:32px;background:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;">📄</div>'}
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

  const maxLimit = 300;
  if (totalUsageGlobal >= maxLimit) {
    mostrarAvisoTemporal("Alcanzaste el límite de 300 mensajes gratuitos. Actualiza a Pro para continuar.");
    return;
  }

  cerrarTodasLasVentanas();

  // Agregar mensaje del usuario con archivos adjuntos al DOM
  agregarMensaje("usuario", texto || "Analiza los archivos adjuntos", archivosAdjuntos);

  // GUARDAR en memoria local
  guardarMensajeEnConversacion({
    tipo: "mensaje",
    rol: "usuario",
    texto: texto || "Analiza los archivos adjuntos",
    adjuntos: archivosAdjuntos
  });

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
  if (!activeConversationId) {
    mostrarAvisoTemporal("Error: No hay conversación activa.");
    return;
  }

  const conversacionActiva = obtenerConversacionActiva();
  const historialPrevio = conversacionActiva ? conversacionActiva.mensajes.map(m => ({
    role: m.rol === "usuario" ? "user" : "assistant",
    content: m.texto,
    adjuntos: m.adjuntos || []
  })) : [];

  // Como agregarMensaje() ya insertó el texto actual del usuario en app.js,
  // lo removemos del final para que el servidor lo procese correctamente con los adjuntos
  if (historialPrevio.length > 0 && historialPrevio[historialPrevio.length - 1].role === "user") {
    historialPrevio.pop();
  }

  const payload = {
    type: "texto",
    texto,
    mensaje: texto,
    conversationId: activeConversationId,
    modo: currentMode,
    contexto: activeContext,
    adjuntos: adjuntos,
    historialPrevio: historialPrevio,
    isGuest: currentUser?.isGuest || false,
    userId: currentUser?.email || "anon",
    audioActivo: audioActivo
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      setGeneratingState(true);
    } catch (e) {
      agregarError("Error al enviar mensaje: " + e.message);
      setGeneratingState(false);
    }
    return;
  }

  if (currentUser && currentUser.isGuest) {
    mostrarAvisoTemporal("El modo invitado no puede enviar mensajes al servidor real.");
    setGeneratingState(false);
    setTimeout(() => {
      agregarMensaje("charvis", "¡Hola! Como invitado, puedo mostrarte la interfaz, pero para hablar conmigo necesitas iniciar sesión con Google.");
    }, 1000);
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

let currentMode = "normal";

function toggleModeDropdown(isHero = false) {
  const dropdownId = isHero ? "hero-mode-dropdown" : "mode-dropdown";
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;

  // Close any other open dropdowns
  document.querySelectorAll('.mode-dropdown').forEach(d => {
    if (d.id !== dropdownId) d.classList.remove('show');
  });

  dropdown.classList.toggle('show');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.mode-selector-container')) {
    document.querySelectorAll('.mode-dropdown').forEach(d => d.classList.remove('show'));
  }
});

function toggleModoRazonamiento() {
  setMode(currentMode === "normal" ? "razonamiento" : "normal");
}

function setMode(mode) {
  // Bloquear modos avanzados para invitados
  if (currentUser && currentUser.isGuest && mode !== "normal") {
    mostrarAvisoTemporal("Los modos avanzados solo están disponibles para usuarios registrados.");
    return;
  }

  currentMode = mode;
  modoRazonamientoActivo = (mode === "razonamiento" || mode === "pro"); // Keep backwards compatibility

  // Hide dropdowns
  document.querySelectorAll('.mode-dropdown').forEach(d => d.classList.remove('show'));

  sincronizarBotonesModo();

  let msg = "Modo normal activado.";
  if (mode === "razonamiento") msg = "Modo razonamiento activado.";
  if (mode === "pro") msg = "Modo Charvis Pro (Enjambre Qwen) activado.";

  mostrarAvisoTemporal(msg);
}

function sincronizarBotonesModo() {
  let label = "✨ Normal ▾";
  let activeText = "Modo normal";

  if (currentMode === "razonamiento") {
    label = "🧠 Razonamiento ▾";
    activeText = "Modo razonamiento";
  } else if (currentMode === "pro") {
    label = "🚀 Charvis Pro ▾";
    activeText = "Modo pro";
  }

  const modeButton = document.getElementById("mode-button");
  const heroModeButton = document.getElementById("hero-mode-button");
  const reasoningToggle = document.getElementById("reasoning-toggle");
  const heroReasoningToggle = document.getElementById("hero-reasoning-toggle");
  const activeModeLabel = document.getElementById("active-mode-label");
  const ctxBtn = document.getElementById("ctx-razonamiento");

  if (modeButton) {
    modeButton.innerHTML = label;
    modeButton.classList.toggle("active", currentMode !== "normal");
  }
  if (heroModeButton) {
    heroModeButton.innerHTML = label;
    heroModeButton.classList.toggle("active", currentMode !== "normal");
  }

  // Support for legacy toggle buttons
  if (reasoningToggle) reasoningToggle.classList.toggle("active", currentMode !== "normal");
  if (heroReasoningToggle) heroReasoningToggle.classList.toggle("active", currentMode !== "normal");
  if (ctxBtn) ctxBtn.classList.toggle("active", currentMode !== "normal");

  // Update dropdown options active state
  document.querySelectorAll('.mode-option').forEach(opt => opt.classList.remove('active'));
  const activeIds = [`opt-${currentMode}`, `hero-opt-${currentMode}`];
  activeIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  });

  if (activeModeLabel) {
    activeModeLabel.textContent = activeText;
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

function agregarMensaje(rol, texto, adjuntos = [], isStreaming = false) {
  const chat = document.getElementById("chat");
  if (!chat) return;

  removeWelcome();

  const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rolNorm = normalizarRol(rol);

  if (isStreaming && rolNorm === "charvis") {
    currentAssistantMessageId = msgId;
  }

  const message = document.createElement("div");
  message.className = `message ${rolNorm}`;
  message.id = msgId;
  if (isStreaming) message.classList.add("streaming");

  // Avatar
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (rolNorm === "charvis") {
    avatar.innerHTML = '<img src="/assets/istockphoto-1366401566-1024x1024.jpg" class="charvis-logo" alt="Charvis">';
  } else {
    if (currentUser && currentUser.picture) {
      avatar.innerHTML = `<img src="${currentUser.picture}" class="charvis-logo" alt="User Avatar" referrerpolicy="no-referrer">`;
    } else {
      avatar.innerHTML = currentUser && currentUser.name ? currentUser.name.charAt(0).toUpperCase() : "U";
    }
  }
  message.appendChild(avatar);

  // Content wrapper
  const contentWrapper = document.createElement("div");
  contentWrapper.className = "msg-content";

  const text = document.createElement("div");
  text.className = "msg-text";
  text.setAttribute("data-raw", texto || "");

  if (rolNorm === "charvis") {
    text.innerHTML = markdownToHtml(texto || "");
    renderizarMatematicas(text);
  } else {
    text.textContent = texto || "";
  }

  contentWrapper.appendChild(text);

  // Fase 3.4 — Timestamp sutil bajo cada mensaje
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const now = new Date();
  meta.textContent = now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  contentWrapper.appendChild(meta);

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

    contentWrapper.appendChild(attachmentsDiv);
  }

  message.appendChild(contentWrapper);

  chat.appendChild(message);

  // Fase 6.2 — Scroll suave al último mensaje
  requestAnimationFrame(() => {
    message.scrollIntoView({ behavior: "smooth", block: "end" });
  });


}

function agregarError(texto) {
  const chat = document.getElementById("chat");
  if (!chat) return;

  removeWelcome();
  setGeneratingState(false);

  const message = document.createElement("div");
  message.className = "message error";

  // Avatar
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.innerHTML = "⚠️";
  message.appendChild(avatar);

  // Content wrapper
  const contentWrapper = document.createElement("div");
  contentWrapper.className = "msg-content";

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = texto || "Ocurrió un error.";

  const retryBtn = document.createElement("button");
  retryBtn.className = "retry-btn";
  retryBtn.innerHTML = "<span>↻</span> Reintentar";
  retryBtn.onclick = retryLastMessage;

  contentWrapper.appendChild(text);
  contentWrapper.appendChild(retryBtn);
  message.appendChild(contentWrapper);
  chat.appendChild(message);

  chat.scrollTop = chat.scrollHeight;

  guardarMensajeEnConversacion({
    tipo: "error",
    texto
  });
}

function retryLastMessage() {
  const conversacion = obtenerConversacionActiva();
  if (!conversacion || conversacion.mensajes.length === 0) return;

  // Buscar el último mensaje del usuario
  const ultimoUsuario = [...conversacion.mensajes].reverse().find(m => {
    const rol = normalizarRol(m.rol);
    return rol === "usuario";
  });

  if (ultimoUsuario) {
    mostrarAvisoTemporal("Reintentando...");
    // Reconstruir adjuntos si existen (sin dataUrl para no duplicar)
    const adjuntos = (ultimoUsuario.adjuntos || []).map(adj => {
      const { contenido, dataUrl, ...rest } = adj;
      return rest;
    });
    enviarAlServidor(ultimoUsuario.texto, adjuntos);
  } else {
    mostrarAvisoTemporal("No hay mensajes previos para reintentar.");
  }
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
    sidebar.classList.remove("closed");
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
    sidebar.classList.add("closed");
  }

  if (backdrop) {
    backdrop.classList.remove("show");
  }

  document.body.classList.remove("sidebar-open");
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");

  if (!sidebar) return;

  if (esMobile()) {
    if (sidebar.classList.contains("open")) {
      cerrarSidebar();
    } else {
      abrirSidebar();
    }
  } else {
    // Desktop: toggle "closed" class
    if (sidebar.classList.contains("closed")) {
      abrirSidebar();
    } else {
      cerrarSidebar();
    }
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
    btn.classList.toggle("muted", !audioActivo);
    const icon = btn.querySelector('.audio-icon');
    if (icon) icon.textContent = audioActivo ? "🔊" : "🔇";
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

    // Soporte para diferentes formatos de audio según el navegador
    let mimeType = "audio/webm";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "audio/mp4";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "audio/webm;codecs=opus";
      }
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: mimeType });
      if (blob.size < 1000) { mostrarAvisoTemporal("Audio muy corto, intentá de nuevo."); return; }
      const buffer = await blob.arrayBuffer();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
        mostrarAvisoTemporal("Transcribiendo...");
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
    .replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, function (_, code) {
      return '<div class="code-container"><button type="button" class="copy-code-btn" onclick="copyCode(this)">Copiar</button><pre><code>' + code.trim() + '</code></pre></div>';
    })
    .replace(/(?::::think\n|&lt;think&gt;\n?)([\s\S]*?)\n?(?::::|&lt;\/think&gt;)/g, function (_, content) { return "<details class=\"charvis-thought-process\"><summary>🧠 Proceso de Razonamiento (Charvis AI)</summary><div class=\"thought-content\">" + content.trim() + "</div></details>"; })
    .replace(/`([^`]+)`/g, function (_, code) { return "<code>" + code + "</code>"; })
    .replace(/\*\*([\s\S]+?)\*\*/g, function (_, text) { return "<strong>" + text + "</strong>"; })
    .replace(/\*([^*]+)\*/g, function (_, text) { return "<em>" + text + "</em>"; })
    .replace(/^#{3} (.+)$/gm, function (_, text) { return "<h3>" + text.trim() + "</h3>"; })
    .replace(/^#{2} (.+)$/gm, function (_, text) { return "<h2>" + text.trim() + "</h2>"; })
    .replace(/^#{1} (.+)$/gm, function (_, text) { return "<h1>" + text.trim() + "</h1>"; })
    .replace(/^[-*] (.+)$/gm, function (_, text) { return "<li>" + text.trim() + "</li>"; })
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/&lt;(\/?(?:strong|b|em|i|br|p|ul|li|h[1-6]))\s*&gt;/gi, "<$1>");
  if (!html.startsWith("<")) html = "<p>" + html + "</p>";
  return html;
}

function renderizarMatematicas(elemento) {
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(elemento, {
        delimiters: [
          {left: "$$", right: "$$", display: true},
          {left: "$", right: "$", display: false},
          {left: "\\(", right: "\\)", display: false},
          {left: "\\[", right: "\\]", display: true}
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn("KaTeX error:", e);
    }
  }
}

/* ========================= */
/* ESTADO VISUAL */
/* ========================= */

function mostrarEstadoTemporal(valor) {
  const estados = {
    pensando: "💭 Pensando...",
    razonando: "🧠 Razonando...",
    escribiendo: "✍️ Escribiendo...",
    hablando: "🔊 Respondiendo...",
    transcribiendo: "🎙 Transcribiendo voz...",
    entendiendo_problema: "🔍 Analizando el problema...",
    creando_plan: "📋 Creando plan...",
    ejecutando_plan: "⚙️ Ejecutando plan...",
    verificando_respuesta: "✅ Revisando respuesta...",
    finalizado: "✓ Listo",
    escuchando: "👂 Escuchando...",
    pensando_multi_modelo: "🧠 Pensando con múltiples modelos...",
    sintetizando: "🔀 Sintetizando respuestas..."
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
  if (!ctx) {
    console.warn('No se pudo obtener contexto 2D del canvas');
    return;
  }

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

  if (width === 0 || height === 0) {
    // If the canvas is hidden or layout is not ready, retry after a small delay
    setTimeout(initAmbientCanvas, 500);
    return;
  }

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
        orb.targetX = mouse.x + (i === 1 ? 100 * Math.cos(orb.angle) : 0);
        orb.targetY = mouse.y + (i === 1 ? 100 * Math.sin(orb.angle) : 0);
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
      let hex = orb.color.replace('#', '');
      let r = parseInt(hex.substring(0, 2), 16);
      let g = parseInt(hex.substring(2, 4), 16);
      let b = parseInt(hex.substring(4, 6), 16);

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

// Ocultar botones obsoletos que estn en el HTML esttico
const stylePatch = document.createElement('style');
stylePatch.textContent = '.tool-btn, #reasoning-toggle, #hero-reasoning-toggle { display: none !important; }';
document.head.appendChild(stylePatch);

window.copyCode = function (btn) {
  const preEl = btn.nextElementSibling;
  if (!preEl) return;
  const text = preEl.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "¡Copiado!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copiar";
      btn.classList.remove("copied");
    }, 2000);
  }).catch(err => {
    console.error("Error al copiar: ", err);
  });
};

/* ========================= */
/* FASE 4.1 — TOPBAR BLUR AL SCROLLEAR */
/* ========================= */
(function initTopbarScroll() {
  const chat = document.getElementById("chat");
  const topbar = document.getElementById("topbar");
  if (!chat || !topbar) return;

  chat.addEventListener("scroll", () => {
    if (chat.scrollTop > 10) {
      topbar.classList.add("scrolled");
    } else {
      topbar.classList.remove("scrolled");
    }
  }, { passive: true });
})();
