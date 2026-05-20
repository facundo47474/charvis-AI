// --- Cargar variables de entorno ---
// Solo cargar .env en desarrollo local. En producción (Render, Railway, etc.) las variables se
// configuran directamente en el dashboard y no existe el archivo .env en disco.
if (process.env.NODE_ENV !== "production") {
  const envResult = require("dotenv").config();
  if (envResult.error) {
    console.warn("⚠️  .env no encontrado (normal en producción):", envResult.error.code);
  } else {
    console.log("✅ Archivo .env cargado correctamente");
  }
}

const express = require("express");
const { WebSocketServer } = require("ws");
const { Worker } = require("worker_threads");
const http = require("http");
const path = require("path");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");
const Groq = require("groq-sdk");

const { buildSystemPrompt } = require("./lib/ai/prompts");
const { getUserCredits, hasEnoughCredits, consumeCredits } = require("./lib/credits");
const { estimateTokens, buildModelContext, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS } = require("./lib/ai/tokens");

const { recortarHistorial } = require("./historial");
const { esEco } = require("./eco");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const {
  modoValido,
  normalizarNombreArchivo,
  extensionArchivo,
  extraerMimeDataUrl,
  bufferDesdeContenido,
  recortarTextoExtraido,
  esImagen,
  esPdf,
  esDocx,
  esTextoPlano,
  MAX_FILE_BYTES,
  MAX_EXTRACTED_CHARS
} = require("./utils");

// --- Abort Controllers para cancelar generación ---
const abortControllers = new Map();

// --- Validación de Variables de Entorno ---
const GROQ_KEY = process.env.GROQ_API_KEY;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();

if (!GROQ_KEY) {
  console.error("❌ ERROR: La variable GROQ_API_KEY no está configurada.");
}
if (!GOOGLE_CLIENT_ID) {
  console.warn("⚠️  ADVERTENCIA: GOOGLE_CLIENT_ID no está configurado. El login de Google no funcionará.");
} else {
  console.log("✅ Google Client ID detectado:", GOOGLE_CLIENT_ID.substring(0, 10) + "...");
}

const groq = GROQ_KEY ? new Groq({ apiKey: GROQ_KEY }) : null;

// Verificar que la clave de Groq sea válida al iniciar
async function verificarClaveGroq() {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error("\n❌ ERROR: La GROQ_API_KEY no es válida.");
        console.error("💡 Soluciones:");
        console.error("   1. Ve a https://console.groq.com/keys");
        console.error("   2. Crea una nueva API key o verifica una existente");
        console.error("   3. Actualiza GROQ_API_KEY en el archivo .env");
        console.error("\n🚫 El servidor no puede continuar sin una clave válida.\n");
        process.exit(1);
      } else {
        console.warn(`⚠️  Advertencia: No se pudo verificar la clave de Groq (${response.status})`);
      }
    } else {
      console.log("✅ GROQ_API_KEY verificada correctamente");
    }
  } catch (error) {
    console.warn("⚠️  No se pudo verificar la clave de Groq:", error.message);
  }
}

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const { elevenLabsTTS } = require("./lib/audio.service")({ ELEVENLABS_KEY, VOICE_ID });
const PORT = process.env.PORT || 3000;
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile";
// gpt-oss-120b has an 8k TPM hard limit on free tier — only used for Swarm Judge (controlled input)
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "openai/gpt-oss-120b";
// All 3 reasoning pipeline stages use the versatile model (high rate limit, handles large docs)
const PLANNER_MODEL = process.env.GROQ_PLANNER_MODEL || "llama-3.3-70b-versatile";
const EXECUTOR_MODEL = process.env.GROQ_EXECUTOR_MODEL || "llama-3.3-70b-versatile";
const REVIEWER_MODEL = process.env.GROQ_REVIEWER_MODEL || "llama-3.3-70b-versatile";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const SWARM_WORKER_MODEL = process.env.GROQ_SWARM_MODEL || "llama-3.3-70b-versatile";
const APP_USER = process.env.APP_USER || "admin";
const APP_PASSWORD = process.env.APP_PASSWORD || "facu";
const MAX_EXTRACTED_CHARS_REASONING = 30000;
const MAX_INPUT_CHARS_PLANNER = 10000;  // ~2500 tokens
const MAX_INPUT_CHARS_EXECUTOR = 24000;  // ~6000 tokens — safe for versatile model
const MAX_INPUT_CHARS_REVIEWER = 10000;  // ~2500 tokens

// --- Sesiones en memoria ---
const sessions = new Map();
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 días

function generarToken() { return crypto.randomUUID(); }

function verificarSesion(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_DURATION) { sessions.delete(token); return null; }
  return s;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Archivos estáticos sin auth (la SPA maneja su propio estado de login)
app.use(express.static(path.join(__dirname, "www")));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

const authController = require("./lib/controllers/auth.controller");
app.use("/api/auth", authController(sessions, { GOOGLE_CLIENT_ID, APP_PASSWORD, APP_USER }, { generarToken, verificarSesion }));


async function analizarImagenConVision({ nombre, tipo, contenido }, pregunta) {
  const dataUrl = String(contenido || "").startsWith("data:")
    ? contenido
    : `data:${tipo || "image/png"};base64,${bufferDesdeContenido(contenido).toString("base64")}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + GROQ_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analiza esta imagen para Charvis. Extrae objetos, escena, texto visible, datos utiles y cualquier detalle relevante. " +
              `Nombre del archivo: ${nombre}. Pedido del usuario: ${pregunta || "Analiza la imagen."}`
          },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0.2,
      max_tokens: 900,
      stream: false
    })
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(`Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env`);
    }
    throw new Error(`Vision error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "No se pudo obtener una descripcion visual.";
}

async function extraerTextoDocumento(buffer, tipo, ext) {
  // Texto plano: operación ligera, se procesa en el hilo principal
  if (esTextoPlano(tipo, ext)) {
    return buffer.toString("utf8");
  }

  // PDF y DOCX: operaciones pesadas de CPU → Worker Thread para no bloquear el Event Loop
  let method;
  if (esPdf(tipo, ext)) method = "pdf";
  else if (esDocx(tipo, ext)) method = "docx";
  else throw new Error("Formato no soportado todavia. Usa imagenes, PDF, DOCX, TXT, Markdown, JSON, CSV o archivos de codigo.");

  return new Promise((resolve, reject) => {
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const worker = new Worker(path.join(__dirname, "lib", "fileWorker.js"), {
      workerData: { method, bufferData: ab },
      transferList: [ab]
    });

    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Tiempo agotado procesando el archivo (>30s). Probá con un archivo más liviano."));
    }, 30000);

    worker.on("message", (msg) => {
      clearTimeout(timeout);
      if (msg.ok) resolve(msg.text);
      else reject(new Error(msg.error || "Error interno procesando archivo."));
    });

    worker.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error("Error en el worker de archivos: " + err.message));
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Worker de archivos terminó inesperadamente (código ${code})`));
      }
    });
  });
}

async function analizarArchivo(archivo, pregunta, modo = "normal") {
  const nombre = normalizarNombreArchivo(archivo?.nombre);
  const ext = extensionArchivo(nombre);
  const tipo = String(archivo?.tipo || extraerMimeDataUrl(archivo?.contenido) || "").toLowerCase();
  const buffer = bufferDesdeContenido(archivo?.contenido);

  if (!buffer.length) throw new Error("El archivo adjunto esta vacio.");
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`El archivo "${nombre}" supera el limite de ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`);
  }

  if (esImagen(tipo, ext)) {
    const observaciones = await analizarImagenConVision({ nombre, tipo, contenido: archivo.contenido }, pregunta);
    const resultado = (
      `[Imagen analizada: ${nombre}]\n` +
      `Tipo: ${tipo || ext || "imagen"}\n` +
      `Tamano aproximado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n\n` +
      `${observaciones}`
    );
    guardarTextoEnCache(archivo.nombre, archivo.size || buffer.length, resultado);
    return resultado;
  }

  const limite = modo === "razonamiento"
    ? MAX_EXTRACTED_CHARS_REASONING
    : MAX_EXTRACTED_CHARS;
  const texto = recortarTextoExtraido(await extraerTextoDocumento(buffer, tipo, ext), limite);
  if (!texto) throw new Error(`No pude extraer texto legible de "${nombre}".`);

  const resultado = (
    `[Documento analizado: ${nombre}]\n` +
    `Tipo: ${tipo || ext || "documento"}\n` +
    `Tamano aproximado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n\n` +
    "Contenido extraido:\n" +
    "```\n" + texto + "\n```"
  );
  guardarTextoEnCache(archivo.nombre, archivo.size || buffer.length, resultado);
  return resultado;
}
function contenidoComoTexto(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || "").filter(Boolean).join("\n");
  }
  return String(content || "");
}

function prepararMensajes(historial, modo, selectedContext) {
  const systemPrompt = buildSystemPrompt(selectedContext, modo);

  // Reemplazamos el primer mensaje (sistema) o lo agregamos si no existe
  const mensajes = [...historial];
  if (mensajes.length > 0 && mensajes[0].role === "system") {
    mensajes[0] = { role: "system", content: systemPrompt };
  } else {
    mensajes.unshift({ role: "system", content: systemPrompt });
  }

  // Preservamos el contenido si es un array con imágenes, de lo contrario lo forzamos a texto
  return mensajes.map((m) => {
    if (Array.isArray(m.content) && m.content.some(c => c.type === "image_url")) {
      return m; // Mantener la estructura multimodal intacta
    }
    return {
      ...m,
      content: contenidoComoTexto(m.content)
    };
  });
}



function crearHistorial() {
  return [{ role: "system", content: "" }];
}

const historialesGlobales = new Map();
const historialesLastAccess = new Map();

const cacheDir = path.join(__dirname, ".cache");
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// --- Limpieza periódica de caché en disco ---
const MAX_CACHE_AGE = 24 * 60 * 60 * 1000; // 24 horas
const MAX_CACHE_SIZE = 100 * 1024 * 1024;  // 100 MB total

function limpiarCacheDisco() {
  try {
    const files = fs.readdirSync(cacheDir);
    const now = Date.now();
    let totalSize = 0;
    const fileStats = files.map(f => {
      const filePath = path.join(cacheDir, f);
      try {
        const stat = fs.statSync(filePath);
        totalSize += stat.size;
        return { path: filePath, size: stat.size, mtime: stat.mtimeMs };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.mtime - b.mtime);

    let eliminados = 0;
    for (const file of fileStats) {
      if (now - file.mtime > MAX_CACHE_AGE || totalSize > MAX_CACHE_SIZE) {
        try {
          fs.unlinkSync(file.path);
          totalSize -= file.size;
          eliminados++;
        } catch {}
      }
    }
    if (eliminados > 0) {
      console.log(`🧹 Caché: ${eliminados} archivo(s) eliminados. Tamaño restante: ${Math.round(totalSize / 1024 / 1024)}MB`);
    }
  } catch (err) {
    console.error("⚠️ Error limpiando caché de disco:", err.message);
  }
}

function guardarTextoEnCache(nombre, size, texto) {
  try {
    const sanitizedNombre = path.basename(String(nombre || "archivo")).replace(/[^\w.\- ()]/g, "_");
    const filename = `${sanitizedNombre}-${size || 0}.txt`;
    const filePath = path.join(cacheDir, filename);
    fs.writeFileSync(filePath, String(texto || ""), "utf8");
  } catch (err) {
    console.error("⚠️ Error escribiendo en caché de archivos:", err.message);
  }
}

function obtenerTextoDeCache(nombre, size) {
  try {
    const sanitizedNombre = path.basename(String(nombre || "archivo")).replace(/[^\w.\- ()]/g, "_");
    const filename = `${sanitizedNombre}-${size || 0}.txt`;
    const filePath = path.join(cacheDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch (err) {
    console.error("⚠️ Error leyendo de caché de archivos:", err.message);
  }
  return null;
}

wss.on("connection", (ws, req) => {
  // Verificar token de sesión del WebSocket
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token") || "";
  let session = null;
  if (token) {
    session = verificarSesion(token);
    if (!session && token !== "guest") {
      ws.close(1008, "No autorizado");
      return;
    }
  }

  const historiales = historialesGlobales;
  const procesandoPorConversacion = new Set();
  let conversationIdActivo = "default";

  // --- Rate Limiter por conexión WebSocket ---
  const RATE_LIMIT_WINDOW = 10000; // 10 segundos
  const RATE_LIMIT_MAX = 8;        // máx 8 mensajes por ventana
  let msgTimestamps = [];

  function checkRateLimit() {
    const now = Date.now();
    msgTimestamps = msgTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (msgTimestamps.length >= RATE_LIMIT_MAX) return false;
    msgTimestamps.push(now);
    return true;
  }

  function obtenerUserInfo() {
    return {
      userId: session ? (session.email || session.name) : (token === "guest" ? "guest" : "anon"),
      isGuest: token === "guest" || (session && session.isGuest)
    };
  }

  function obtenerConversationId(msg = {}) {
    return String(msg.conversationId || "default").slice(0, 120);
  }

  function obtenerHistorial(conversationId) {
    if (!historiales.has(conversationId)) {
      historiales.set(conversationId, crearHistorial());
    }
    historialesLastAccess.set(conversationId, Date.now());
    return historiales.get(conversationId);
  }

  function guardarHistorial(conversationId, historial) {
    historiales.set(conversationId, recortarHistorial(historial));
  }

  function estaProcesando(conversationId) {
    return procesandoPorConversacion.has(conversationId);
  }

  function iniciarProcesamiento(conversationId) {
    procesandoPorConversacion.add(conversationId);
  }

  function finalizarProcesamiento(conversationId) {
    procesandoPorConversacion.delete(conversationId);
  }

  function send(obj) {
    if (ws.readyState === ws.OPEN) {
      // Si el mensaje es una respuesta final o un error, adjuntamos créditos actualizados
      if (obj.type === "mensaje" || obj.type === "streamTerminado" || obj.type === "error") {
        const { userId, isGuest } = obtenerUserInfo();
        obj.credits = getUserCredits(userId, isGuest);
      }
      ws.send(JSON.stringify(obj));
    }
  }

  async function enviarFrase(frase) {
    if (ELEVENLABS_KEY) {
      try {
        const mp3 = await elevenLabsTTS(frase);
        send({ type: "reproducir", data: mp3.toString("base64") });
      } catch (e) {
        send({ type: "hablar", texto: frase });
      }
    } else {
      send({ type: "hablar", texto: frase });
    }
  }

  async function procesarConLLM(conversationId, historial, opciones = {}) {
    const modo = modoValido(opciones.modo);
    const contexto = opciones.contexto || null;

    if (modo === "pro") {
      return await ejecutarSwarmDirecto(conversationId, historial, opciones);
    }

    // Detector de complejidad
    let ultimoMensajeUsuario = historial.filter(m => m.role === "user").pop()?.content || "";
    const tieneImagenes = historial.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url"));

    if (Array.isArray(ultimoMensajeUsuario)) {
      const textObj = ultimoMensajeUsuario.find(item => item.type === 'text');
      ultimoMensajeUsuario = textObj ? textObj.text : "";
    }

    // Si el usuario seleccionó "razonamiento" explícitamente, SIEMPRE ejecuta el pipeline de razonamiento
    // excepto si es una imagen pura (las imágenes siempre van directo al modelo de visión)
    const esComplejo = !tieneImagenes && modo === "razonamiento";

    if (!esComplejo) {
      // Flujo normal directo
      return await ejecutarLLMDirecto(conversationId, historial, opciones);
    }

    // PIPELINE DE RAZONAMIENTO
    const controller = new AbortController();
    abortControllers.set(conversationId, controller);

    try {
      // Construir el string de contexto histórico para los agentes
      const historyExceptLast = historial.slice(0, -1).filter(m => m.role !== "system");
      let mensajeConContexto = ultimoMensajeUsuario;
      if (historyExceptLast.length > 0) {
        const historyText = historyExceptLast.map(m => `${m.role === 'user' ? 'Usuario' : 'Charvis'}: ${typeof m.content === 'string' ? m.content : '[Adjunto]'}`).join('\n\n');
        mensajeConContexto = `--- CONTEXTO PREVIO DE LA CHARLA ---\n${historyText}\n\n--- NUEVO MENSAJE A RESPONDER ---\n${ultimoMensajeUsuario}`;
      }

      // 1. PLANNER
      send({ type: "estado", valor: "entendiendo_problema", conversationId });
      const plan = await llamadaPlanner(mensajeConContexto, controller.signal);

      send({ type: "estado", valor: "creando_plan", conversationId });

      // 2. EXECUTOR
      send({ type: "estado", valor: "ejecutando_plan", conversationId });
      const respuestaPreliminar = await llamadaExecutor(mensajeConContexto, plan, controller.signal);

      // 3. REVIEWER
      send({ type: "estado", valor: "verificando_respuesta", conversationId });
      const respuestaFinal = await llamadaReviewer(respuestaPreliminar, ultimoMensajeUsuario, controller.signal);

      // Ensamblar la respuesta con el bloque visible de pensamiento
      const respuestaCompleta = `:::think
**Plan Trazado:**
${plan}

**Ejecución Lógica:**
${respuestaPreliminar}
:::

${respuestaFinal}`;

      // 4. ENVIAR AL USUARIO
      send({ type: "estado", valor: "finalizado", conversationId });
      send({ type: "mensaje", rol: "charvis", texto: respuestaCompleta, conversationId });

      // Guardar en historial
      historial.push({ role: "assistant", content: respuestaCompleta });
      guardarHistorial(conversationId, historial);

      // Descontar créditos
      consumeCredits(opciones.userId || "anon", 1, opciones.isGuest);

    } catch (error) {
      if (error.name === 'AbortError') {
        send({ type: "error", mensaje: "Generación detenida por el usuario.", conversationId, code: "CANCELLED" });
      } else {
        send({ type: "error", mensaje: "Error en el proceso de razonamiento: " + error.message, conversationId });
      }
    } finally {
      abortControllers.delete(conversationId);
    }
  }

  // --- SWARM / ENJAMBRE PIPELINE ---
  async function ejecutarSwarmDirecto(conversationId, historial, opciones = {}) {
    let ultimoMensajeUsuario = historial.filter(m => m.role === "user").pop()?.content || "";
    if (Array.isArray(ultimoMensajeUsuario)) {
      const textObj = ultimoMensajeUsuario.find(item => item.type === 'text');
      ultimoMensajeUsuario = textObj ? textObj.text : "";
    }

    const historyExceptLast = historial.slice(0, -1).filter(m => m.role !== "system");
    let mensajeConContexto = ultimoMensajeUsuario;
    if (historyExceptLast.length > 0) {
      const historyText = historyExceptLast.map(m => `${m.role === 'user' ? 'Usuario' : 'Charvis'}: ${typeof m.content === 'string' ? m.content : '[Adjunto]'}`).join('\n\n');
      mensajeConContexto = `--- CONTEXTO PREVIO DE LA CHARLA ---\n${historyText}\n\n--- NUEVO MENSAJE A RESPONDER ---\n${ultimoMensajeUsuario}`;
    }

    const controller = new AbortController();
    abortControllers.set(conversationId, controller);

    try {
      send({ type: "estado", valor: "pensando_multi_modelo", conversationId });

      // Truncar para no exceder los límites de tokens de entrada (TPM)
      const inputTruncado = truncarParaRazonamiento(mensajeConContexto, 5000);

      // Fase 1: Enjambre Qwen en Secuencia con espaciado (2 workers para no exceder 6000 TPM)
      const respuestasEnjambre = [];
      for (const temp of [0.3, 0.8]) {
        if (respuestasEnjambre.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        const resp = await llamadaSwarmWorker(inputTruncado, temp, controller.signal);
        respuestasEnjambre.push(resp);
      }

      // Fase 2: Síntesis con el Modelo Juez
      send({ type: "estado", valor: "sintetizando", conversationId });

      const respuestaSintesis = await llamadaSwarmJudge(ultimoMensajeUsuario, respuestasEnjambre, controller.signal);

      // Fase 3: Verificación y Crítica (con fallback graceful si falla por cuota/rate limit)
      let respuestaFinal = respuestaSintesis;
      try {
        send({ type: "estado", valor: "verificando_respuesta", conversationId });
        respuestaFinal = await llamadaSwarmCritic(respuestaSintesis, ultimoMensajeUsuario, controller.signal);
      } catch (criticError) {
        console.warn("⚠️ Crítico no disponible, usando respuesta del Juez:", criticError.message);
        // La respuesta del Juez ya es de alta calidad — se usa directamente
      }

      send({ type: "estado", valor: "finalizado", conversationId });
      send({ type: "mensaje", rol: "charvis", texto: respuestaFinal, conversationId });

      // Guardar en historial
      historial.push({ role: "assistant", content: respuestaFinal });
      guardarHistorial(conversationId, historial);

      // Consumir créditos (el modo PRO cuesta más)
      consumeCredits(opciones.userId || "anon", 4, opciones.isGuest);

    } catch (error) {
      if (error.name === 'AbortError') {
        send({ type: "error", mensaje: "Generación detenida por el usuario.", conversationId, code: "CANCELLED" });
      } else {
        console.error("Swarm Error:", error);
        send({ type: "error", texto: "Error en Charvis Pro (Swarm): " + error.message, conversationId });
      }
    } finally {
      abortControllers.delete(conversationId);
    }
  }

  async function llamadaSwarmWorker(mensajeUsuario, temperature, signal) {
    const systemPrompt = "Eres un experto analista. Analiza la petición paso a paso (chain of thought) razonando de forma profunda y detallada antes de dar tu respuesta. Es imperativo que muestres tus pasos de razonamiento, seguidos de la mejor respuesta directa y precisa posible. TU IDIOMA OBLIGATORIO ES EL ESPAÑOL. NO RESPONDAS EN INGLÉS BAJO NINGÚN CONCEPTO.";

    const response = await fetchConReintentos("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: SWARM_WORKER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: mensajeUsuario }
        ],
        max_tokens: 1200,
        temperature: temperature
      }),
      signal
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(`Fallo en un Worker del Enjambre (${response.status}): ${errBody?.error?.message || response.statusText || "Error desconocido"}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
  }

  async function llamadaSwarmJudge(mensajeUsuario, respuestas, signal) {
    const systemPrompt = "Eres Charvis Pro, un Juez y Sintetizador experto. Acabas de recibir respuestas de 2 modelos de IA subordinados para la misma petición del usuario. " +
      "Tu tarea es analizar ambas respuestas, extraer la información correcta, filtrar cualquier error o alucinación, y redactar una única respuesta final definitiva, brillante y cohesionada. " +
      "NUNCA menciones que usaste modelos o que eres un juez evaluando respuestas. Da la respuesta definitiva como si fuera tuya directamente. " +
      "REGLA DE ORO: TU RESPUESTA FINAL DEBE ESTAR ESTRICTAMENTE EN ESPAÑOL RIOPLATENSE (voseo). PROHIBIDO USAR INGLÉS.";

    // Truncar cada respuesta del Worker a ~1500 chars para respetar el límite de 8000 TPM del Juez
    const MAX_WORKER_CHARS = 1500;
    const r1 = respuestas[0].slice(0, MAX_WORKER_CHARS);
    const r2 = respuestas[1].slice(0, MAX_WORKER_CHARS);

    const promptJuez = `PREGUNTA DEL USUARIO:
${mensajeUsuario.slice(0, 1000)}

--- RESPUESTA MODELO 1 ---
${r1}

--- RESPUESTA MODELO 2 ---
${r2}

Sintetiza la mejor respuesta definitiva ahora:`;

    const response = await fetchConReintentos("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: REASONING_MODEL, // Juez poderoso
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptJuez }
        ],
        max_tokens: 2000,
        temperature: 0.3
      }),
      signal
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(`Fallo en el Juez Sintetizador (${response.status}): ${errBody?.error?.message || response.statusText || "Error desconocido"}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
  }

  async function llamadaSwarmCritic(respuestaSintetizada, mensajeUsuario, signal) {
    const systemPrompt = "Verificá y mejorá esta respuesta. Buscá errores u omisiones. Reescribila perfecta. TU IDIOMA OBLIGATORIO ES EL ESPAÑOL RIOPLATENSE (voseo). Respondé SOLO con la versión final. PROHIBIDO USAR INGLÉS.";

    // Truncar agresivamente para caber en 6000 TPM de Qwen
    const respuestaTruncada = respuestaSintetizada.slice(0, 1800);
    const preguntaTruncada = mensajeUsuario.slice(0, 500);

    const promptCritico = `Pregunta: ${preguntaTruncada}\n\nRespuesta a mejorar:\n${respuestaTruncada}\n\nVersión final:`;

    // Esperar para no competir con los Workers por la ventana de TPM de Qwen
    await new Promise(resolve => setTimeout(resolve, 2000));

    const response = await fetchConReintentos("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: SWARM_WORKER_MODEL, // Usa Qwen (cuota diaria separada de llama-3.3)
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptCritico }
        ],
        max_tokens: 1200,
        temperature: 0.2
      }),
      signal
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(`Fallo en el Crítico de Calidad (${response.status}): ${errBody?.error?.message || response.statusText || "Error desconocido"}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
  }

  function detectarComplejidad(textoInput) {
    let texto = textoInput;
    if (Array.isArray(textoInput)) {
      const textObj = textoInput.find(item => item.type === 'text');
      texto = textObj ? textObj.text : "";
    }
    if (!texto || typeof texto !== "string" || texto.split(/\s+/).length < 15) return false;
    const clave = /analiza|corrige todo|compara|razona|paso a paso|proyecto|refactoriza|debug|investiga|sumariza|documento|archivo|optimiza|explica completo|revisa todo/i;
    return clave.test(texto);
  }

  // Truncate text safely to avoid Unicode surrogate splitting and 413 errors
  function truncarParaRazonamiento(texto, limite = MAX_INPUT_CHARS_PLANNER) {
    if (!texto || texto.length <= limite) return texto;
    const mitad = Math.floor(limite / 2);
    let inicio = texto.slice(0, mitad);
    let fin = texto.slice(-mitad);

    // Prevent cutting a UTF-16 high surrogate in half
    if (inicio.length > 0 && inicio.charCodeAt(inicio.length - 1) >= 0xD800 && inicio.charCodeAt(inicio.length - 1) <= 0xDBFF) {
      inicio = inicio.slice(0, -1);
    }
    if (fin.length > 0 && fin.charCodeAt(0) >= 0xDC00 && fin.charCodeAt(0) <= 0xDFFF) {
      fin = fin.slice(1);
    }

    return inicio + `\n\n[...texto truncado para el análisis, ${Math.round((texto.length - limite) / 1000)}k caracteres omitidos...]\n\n` + fin;
  }

  /**
   * Wrapper de fetch con reintentos automáticos y backoff exponencial para errores 429.
   * maxReintentos: número de veces que reintenta antes de rendirse.
   * delayBase: milisegundos de espera en el primer reintento (se duplica en cada intento).
   */
  async function fetchConReintentos(url, opciones, maxReintentos = 3, delayBase = 2000) {
    for (let intento = 0; intento <= maxReintentos; intento++) {
      const response = await fetch(url, opciones);

      if (response.status !== 429) return response; // Éxito o error no recuperable

      if (intento === maxReintentos) return response; // Sin más reintentos, devolver igual

      // Calcular tiempo de espera con jitter (factor aleatorio pequeño) para evitar tormenta de retries
      const espera = delayBase * Math.pow(2, intento) + Math.random() * 500;
      console.warn(`[Retry ${intento + 1}/${maxReintentos}] Rate limit 429. Esperando ${Math.round(espera)}ms...`);
      await new Promise(resolve => setTimeout(resolve, espera));
    }
  }

  async function llamadaPlanner(mensajeUsuario, signal) {
    const inputTruncado = truncarParaRazonamiento(mensajeUsuario);
    const response = await fetchConReintentos("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: PLANNER_MODEL,  // Fast model — high rate limit quota
        messages: [
          { role: "system", content: "Eres un planificador experto. Analiza la tarea del usuario y genera un plan de máximo 5 pasos concretos numerados. Sé técnico y breve. NO respondas la pregunta todavía, solo el plan. REDACTA EL PLAN EN ESPAÑOL." },
          { role: "user", content: inputTruncado }
        ],
        max_tokens: 1500,
        temperature: 0.3
      }),
      signal
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error("Groq API Key inválida o expirada.");
      if (response.status === 429) throw new Error("Límite de peticiones alcanzado. Esperá un momento e intentá de nuevo.");
      throw new Error(`Planner error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "1. Analizar solicitud\n2. Proporcionar respuesta detallada";
  }

  async function llamadaExecutor(mensajeUsuario, plan, signal) {
    // Truncate both the user message AND the plan to stay within context window
    const inputTruncado = truncarParaRazonamiento(mensajeUsuario, MAX_INPUT_CHARS_EXECUTOR);
    const planTruncado = plan.slice(0, 3000);
    const response = await fetchConReintentos("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: EXECUTOR_MODEL,  // versatile model — handles large docs without TPM cap issues
        messages: [
          { role: "system", content: "Eres un ejecutor experto. Sigue estrictamente el plan proporcionado paso a paso. Razona en voz alta antes de cada paso (chain of thought). REGLA ABSOLUTA: DEBES RESPONDER SIEMPRE Y EXCLUSIVAMENTE EN ESPAÑOL." },
          { role: "user", content: inputTruncado + "\n\nPLAN A SEGUIR:\n" + planTruncado }
        ],
        max_tokens: 4096,
        temperature: 0.4
      }),
      signal
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error("Groq API Key inválida o expirada.");
      if (response.status === 429) throw new Error("Rate limit persistente. Intentá nuevamente en un minuto.");
      const errBody = await response.json().catch(() => ({}));
      throw new Error(`Executor error ${response.status}: ${errBody?.error?.message || ''}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async function llamadaReviewer(respuesta, preguntaOriginal, signal) {
    const preguntaTruncada = truncarParaRazonamiento(preguntaOriginal, MAX_INPUT_CHARS_REVIEWER);
    const respuestaTruncada = truncarParaRazonamiento(respuesta, MAX_INPUT_CHARS_REVIEWER);
    const response = await fetchConReintentos("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: REVIEWER_MODEL,  // Fast model — high rate limit quota
        messages: [
          { role: "system", content: "Eres un revisor experto. El texto a revisar es la salida en bruto de un asistente que razonó paso a paso. Tu tarea es extraer ÚNICAMENTE la respuesta final útil para el usuario, eliminando todo el proceso de pensamiento o menciones a 'pasos'. Corrige cualquier error y devuelve SOLO la respuesta final directa, concisa y natural. REGLA INQUEBRANTABLE: TU RESPUESTA DEBE ESTAR 100% EN ESPAÑOL. NO agregues metacomentarios ni palabras en inglés." },
          { role: "user", content: `PREGUNTA ORIGINAL:\n${preguntaTruncada}\n\nRESPUESTA EN BRUTO A REVISAR:\n${respuestaTruncada}\n\nExtrae y mejora solo la respuesta final.` }
        ],
        max_tokens: 4096,
        temperature: 0.3,
        presence_penalty: 0.1
      }),
      signal
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error("Groq API Key inválida o expirada.");
      if (response.status === 429 || response.status === 413) return respuesta;
      throw new Error(`Reviewer error: ${response.status}`);
    }
    const data = await response.json();
    const revision = data.choices?.[0]?.message?.content || respuesta;

    // Fallback if the model hallucinates garbage symbols due to Unicode/context issues
    if (revision.includes("__") || revision.trim() === "") {
      console.warn("⚠️ Reviewer generated garbage tokens. Falling back to Executor response.");
      return respuesta;
    }

    return revision;
  }

  async function ejecutarLLMDirecto(conversationId, historial, opciones = {}) {
    const modo = modoValido(opciones.modo);
    const selectedContext = opciones.contexto || null;

    send({
      type: "estado",
      valor: modo === "razonamiento" ? "razonando" : "pensando",
      conversationId
    });

    const tieneImagenes = historial.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url"));
    const modelToUse = tieneImagenes ? VISION_MODEL : (modo === "razonamiento" ? REASONING_MODEL : CHAT_MODEL);

    // --- Preparar contexto optimizado ---
    const contextoLimitado = buildModelContext(historial);
    const mensajesModel = prepararMensajes(contextoLimitado, modo, selectedContext);

    // --- Configurar AbortController ---
    const controller = new AbortController();
    abortControllers.set(conversationId, controller);

    try {
      const request = {
        model: modelToUse,
        messages: mensajesModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: modo === "razonamiento" ? 0.4 : 0.7,
        stream: true,
      };

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + GROQ_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 401) throw new Error("API Key inválida.");
        if (response.status === 429) throw new Error("Límite de velocidad excedido (Rate limit).");
        throw new Error(errorData.error?.message || `Error Groq: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let respuestaCompleta = "";
      let bufferTexto = "";
      const CORTE = /[.!?]+\s*/;

      send({ type: "estado", valor: "escribiendo", conversationId });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices[0]?.delta?.content || "";
              if (!token) continue;

              respuestaCompleta += token;
              bufferTexto += token;

              // Streaming al frontend (letra por letra o chunk)
              send({
                type: "delta",
                texto: token,
                conversationId
              });

              // TTS (opcional, por frases)
              const audioHabilitado = opciones.audioActivo !== false && !!ELEVENLABS_KEY;
              if (audioHabilitado && CORTE.test(bufferTexto) && bufferTexto.length > 25) {
                const match = bufferTexto.match(CORTE);
                const idx = bufferTexto.indexOf(match[0]) + match[0].length;
                const frase = bufferTexto.slice(0, idx).trim();
                bufferTexto = bufferTexto.slice(idx);
                if (frase) {
                  enviarFrase(frase).catch(() => { });
                }
              }
            } catch (e) { }
          }
        }
      }

      // Enviar resto de audio si quedó algo
      const audioFinal = opciones.audioActivo !== false && !!ELEVENLABS_KEY;
      if (audioFinal && bufferTexto.trim()) {
        enviarFrase(bufferTexto.trim()).catch(() => { });
      }

      send({ type: "streamTerminado", conversationId });

      // Guardar en historial
      historial.push({ role: "assistant", content: respuestaCompleta });
      guardarHistorial(conversationId, historial);

      // Descontar créditos (1 por mensaje en beta)
      const userId = opciones.userId || "anon";
      consumeCredits(userId, 1, opciones.isGuest);

    } catch (err) {
      if (err.name === 'AbortError') {
        send({ type: "error", mensaje: "Generación detenida por el usuario.", conversationId, code: "CANCELLED" });
      } else {
        console.error("[GROQ ERROR]", err);
        send({ type: "error", mensaje: err.message || "Error en la generación.", conversationId });
      }
    } finally {
      abortControllers.delete(conversationId);
    }
  }

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      const conversationId = conversationIdActivo;
      if (estaProcesando(conversationId)) return;

      const { userId, isGuest } = obtenerUserInfo();
      if (!hasEnoughCredits(userId, 1, isGuest)) {
        send({ type: "error", mensaje: "Créditos insuficientes. Por favor, actualizá tu plan para continuar.", conversationId, code: "OUT_OF_CREDITS" });
        return;
      }

      // Validar tamaño del archivo de audio (max 25MB)
      const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
      if (data.length > MAX_AUDIO_SIZE) {
        send({ type: "error", mensaje: "El archivo de audio es demasiado grande (máximo 25MB).", conversationId });
        return;
      }

      iniciarProcesamiento(conversationId);
      const tmpFile = path.join(__dirname, `tmp_${crypto.randomUUID()}.webm`);
      try {
        send({ type: "estado", valor: "transcribiendo", conversationId });
        fs.writeFileSync(tmpFile, data);
        const tr = await groq.audio.transcriptions.create({
          file: fs.createReadStream(tmpFile),
          model: "whisper-large-v3",
          language: "es"
        });
        const texto = tr.text.trim();
        if (!texto || texto.length < 2) {
          send({ type: "estado", valor: "escuchando", conversationId });
          return;
        }
        let historial = obtenerHistorial(conversationId);
        const ultimoAsistente = [...historial].reverse().find(m => m.role === "assistant")?.content || "";
        if (esEco(texto, ultimoAsistente)) {
          send({ type: "estado", valor: "escuchando", conversationId });
          return;
        }
        send({ type: "mensaje", rol: "usuario", texto, conversationId });
        historial.push({ role: "user", content: texto });
        historial = recortarHistorial(historial);
        guardarHistorial(conversationId, historial);
        const modoDetectado = /modo razonamiento|razona profundo|razonamiento profundo/i.test(texto)
          ? "razonamiento"
          : "normal";
        await procesarConLLM(conversationId, historial, { modo: modoDetectado });
      } catch (err) {
        console.error("[GROQ ERROR]", err);
        if (err.status === 401) {
          send({ type: "error", mensaje: "Error de autenticación: Tu GROQ_API_KEY es inválida o expiró.", conversationId });
          return;
        }
        send({ type: "error", mensaje: err.message || "Error al procesar audio.", conversationId });
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        finalizarProcesamiento(conversationId);
      }
    } else {
      try {
        const msg = JSON.parse(data.toString());

        // --- MANEJO DE ABORTO ---
        if (msg.type === "abort") {
          const conversationId = obtenerConversationId(msg);
          if (abortControllers.has(conversationId)) {
            abortControllers.get(conversationId).abort();
            finalizarProcesamiento(conversationId);
          }
          return;
        }

        if (msg.type === "limpiar") {
          const conversationId = obtenerConversationId(msg);

          historiales.set(conversationId, crearHistorial());
          historialesLastAccess.delete(conversationId);
          finalizarProcesamiento(conversationId);

          send({
            type: "limpiar",
            conversationId
          });
          return;
        }
        if (msg.type === "texto") {
          const conversationId = obtenerConversationId(msg);
          if (msg.conversationId) conversationIdActivo = conversationId;

          // Rate limit: prevenir spam de mensajes
          if (!checkRateLimit()) {
            send({ type: "error", mensaje: "Estás enviando mensajes demasiado rápido. Esperá unos segundos.", conversationId });
            return;
          }

          if (estaProcesando(conversationId)) return;

          // --- VALIDACIONES DE BETA ---
          const { userId, isGuest } = obtenerUserInfo();
          const textoUsuario = String(msg.texto || "").trim();

          // 1. Validar longitud
          if (textoUsuario.length > MAX_INPUT_CHARS) {
            send({ type: "error", mensaje: "Tu mensaje es demasiado largo. Por favor, reducilo e intentá nuevamente.", conversationId });
            return;
          }

          // 2. Verificar créditos
          if (!hasEnoughCredits(userId, 1, isGuest)) {
            send({ type: "error", mensaje: "Créditos insuficientes. Por favor, actualizá tu plan para continuar.", conversationId, code: "OUT_OF_CREDITS" });
            return;
          }

          iniciarProcesamiento(conversationId);

          try {
            const modo = modoValido(msg.modo);
            let contenidoUsuario = textoUsuario || "Analiza los archivos adjuntos y dame una respuesta útil.";

            // Procesar adjuntos
            if (msg.adjuntos && Array.isArray(msg.adjuntos) && msg.adjuntos.length > 0) {
              const partesAdjuntos = [];

              for (const adj of msg.adjuntos) {
                try {
                  const extract = await analizarArchivo(adj, textoUsuario, modo);
                  partesAdjuntos.push(extract);
                } catch (errorAnalisis) {
                  console.warn(`Error procesando archivo ${adj.nombre || "adjunto"}:`, errorAnalisis.message);
                  partesAdjuntos.push(`--- Archivo: ${adj.nombre || "adjunto"} ---\n[Error al procesar: ${errorAnalisis.message}]\n--- Fin archivo ---`);
                }
              }

              if (partesAdjuntos.length > 0) {
                contenidoUsuario += `\n\n[Archivos adjuntos:]\n\n${partesAdjuntos.join('\n\n')}`;
              }
            }

            let historial = obtenerHistorial(conversationId);

            // Reconstruir el historial si el servidor lo perdió (ej: por reinicio o reconexión)
            if (msg.historialPrevio && Array.isArray(msg.historialPrevio)) {
              if (msg.historialPrevio.length > historial.length) {
                historial = msg.historialPrevio;

                // Reinyectar archivos adjuntos desde el caché del servidor si es necesario
                for (const mensaje of historial) {
                  if (mensaje.role === "user" && mensaje.adjuntos && Array.isArray(mensaje.adjuntos) && mensaje.adjuntos.length > 0) {
                    if (!String(mensaje.content || "").includes("[Archivos adjuntos:]")) {
                      const bloquesCached = [];
                      for (const adj of mensaje.adjuntos) {
                        const size = adj.size || adj.length || 0;
                        const cachedText = obtenerTextoDeCache(adj.nombre, size);
                        if (cachedText) {
                          bloquesCached.push(cachedText);
                        }
                      }
                      if (bloquesCached.length > 0) {
                        mensaje.content = String(mensaje.content || "") + `\n\n[Archivos adjuntos:]\n\n${bloquesCached.join('\n\n')}`;
                      }
                    }
                  }
                  // Eliminar la propiedad 'adjuntos' que no es parte del esquema de la API de Groq
                  delete mensaje.adjuntos;
                }

                if (historial.length === 0 || historial[0].role !== "system") {
                  historial.unshift({ role: "system", content: "" });
                }
              }
            }

            historial.push({ role: "user", content: contenidoUsuario });

            historial = recortarHistorial(historial);
            guardarHistorial(conversationId, historial);

            await procesarConLLM(conversationId, historial, {
              modo,
              contexto: msg.contexto,
              userId,
              isGuest
            });
          } catch (err) {
            console.error("[GROQ ERROR]", err);
            if (err.message.includes("401")) {
              send({ type: "error", mensaje: "Error de autenticación: Tu GROQ_API_KEY es inválida.", conversationId });
              return;
            }
            send({ type: "error", mensaje: err.message || "Error al procesar tu solicitud.", conversationId });
          } finally {
            finalizarProcesamiento(conversationId);
          }
          return;
        }
      } catch (_) { }
    }
  });
});

// Manejo de errores del servidor
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n❌ ERROR: El puerto ${PORT} ya está en uso.`);
    console.error("💡 Soluciones:");
    console.error(`   1. Ejecutar: netstat -ano | findstr :${PORT}`);
    console.error("   2. Encontrar el PID y ejecutar: taskkill /PID <PID> /F");
    console.error("   3. O ejecutar: Get-NetTCPConnection -LocalPort 3000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }");
    console.error("   4. Luego ejecutar: npm run dev");
    process.exit(1);
  }

  console.error("❌ Error del servidor:", error);
  process.exit(1);
});

// --- Intervalos de limpieza de memoria y disco ---
const CLEANUP_INTERVAL = 5 * 60 * 1000;      // cada 5 minutos
const MAX_HISTORIAL_IDLE = 30 * 60 * 1000;   // 30 min sin acceso → liberar

setInterval(() => {
  const now = Date.now();
  let liberados = 0;

  // 1. Limpiar historiales inactivos de la RAM
  for (const [id, lastAccess] of historialesLastAccess) {
    if (now - lastAccess > MAX_HISTORIAL_IDLE) {
      historialesGlobales.delete(id);
      historialesLastAccess.delete(id);
      liberados++;
    }
  }

  // 2. Limpiar sesiones expiradas proactivamente
  let sesionesLimpiadas = 0;
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_DURATION) {
      sessions.delete(token);
      sesionesLimpiadas++;
    }
  }

  if (liberados > 0 || sesionesLimpiadas > 0) {
    console.log(`🧹 Limpieza: ${liberados} historiales, ${sesionesLimpiadas} sesiones liberadas. RAM: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  }
}, CLEANUP_INTERVAL);

// Limpieza de caché de disco al iniciar y cada hora
limpiarCacheDisco();
setInterval(limpiarCacheDisco, 60 * 60 * 1000);

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`\n🚀 CHARVIS ONLINE`);
  console.log(`🌍 Puerto: ${PORT}`);
  console.log(`🔧 Modo: ${process.env.NODE_ENV || 'development'}`);

  // Verificar clave de Groq al iniciar
  await verificarClaveGroq();

  console.log(`\n✅ Servidor listo y funcionando!\n`);
});

// Force restart