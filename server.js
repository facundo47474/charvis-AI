// --- Cargar variables de entorno ---
const envResult = require("dotenv").config();
if (envResult.error) {
  console.warn("⚠️  Advertencia: No se pudo cargar el archivo .env:", envResult.error.message);
} else {
  console.log("✅ Archivo .env cargado correctamente");
}

const express    = require("express");
const { WebSocketServer } = require("ws");
const http       = require("http");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const crypto     = require("crypto");
const Groq       = require("groq-sdk");

const { buildSystemPrompt } = require("./lib/ai/prompts");
const { getUserCredits, hasEnoughCredits, consumeCredits } = require("./lib/credits");
const { estimateTokens, buildModelContext, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS } = require("./lib/ai/tokens");

const { recortarHistorial } = require("./historial");
const { esEco } = require("./eco");
const pdfParse   = require("pdf-parse");
const mammoth    = require("mammoth");

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
const VOICE_ID      = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const PORT          = process.env.PORT || 3000;
const CHAT_MODEL    = process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile";
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "deepseek-r1-distill-llama-70b";
const VISION_MODEL  = process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";
const APP_USER      = process.env.APP_USER || "admin";
const APP_PASSWORD  = process.env.APP_PASSWORD || "facu";
const MAX_EXTRACTED_CHARS = 60000;
const MAX_EXTRACTED_CHARS_REASONING = 24000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

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

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// Archivos estáticos sin auth (la SPA maneja su propio estado de login)
app.use(express.static(path.join(__dirname, "www")));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// --- Auth endpoints ---
app.get("/api/auth/config", (_req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    hasPassword: !!APP_PASSWORD
  });
});

app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "Sin credencial" });
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: "Google OAuth no configurado" });
  try {
    const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!gRes.ok) throw new Error("Token de Google inválido");
    const payload = await gRes.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error("Client ID no coincide");
    const token = generarToken();
    sessions.set(token, {
      email: payload.email, name: payload.name, picture: payload.picture,
      provider: "google", createdAt: Date.now()
    });
    res.json({ token, user: { email: payload.email, name: payload.name, picture: payload.picture } });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!APP_PASSWORD) return res.status(400).json({ error: "Login con contraseña no configurado" });
  if (username === APP_USER && password === APP_PASSWORD) {
    const token = generarToken();
    sessions.set(token, {
      email: null, name: username, picture: null,
      provider: "password", createdAt: Date.now()
    });
    return res.json({ token, user: { name: username, picture: null } });
  }
  res.status(401).json({ error: "Usuario o contraseña incorrectos" });
});

app.get("/api/auth/me", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const session = verificarSesion(token);
  if (!session) return res.status(401).json({ error: "No autenticado" });
  res.json({ user: { name: session.name, email: session.email, picture: session.picture } });
});

app.post("/api/auth/logout", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  sessions.delete(token);
  res.json({ ok: true });
});


function modoValido(modo) {
  return modo === "razonamiento" ? "razonamiento" : "normal";
}

function normalizarNombreArchivo(nombre) {
  return path.basename(String(nombre || "archivo")).replace(/[^\w.\- ()]/g, "_").slice(0, 140);
}

function extensionArchivo(nombre) {
  return path.extname(String(nombre || "")).toLowerCase();
}

function extraerMimeDataUrl(contenido) {
  const match = String(contenido || "").match(/^data:([^;,]+)[^,]*,/i);
  return match ? match[1].toLowerCase() : "";
}

function bufferDesdeContenido(contenido) {
  const texto = String(contenido || "");
  if (texto.startsWith("data:")) {
    const comma = texto.indexOf(",");
    if (comma === -1) throw new Error("Archivo adjunto invalido.");
    const meta = texto.slice(0, comma).toLowerCase();
    const data = texto.slice(comma + 1);
    if (meta.includes(";base64")) return Buffer.from(data, "base64");
    return Buffer.from(decodeURIComponent(data), "utf8");
  }
  return Buffer.from(texto, "utf8");
}

function recortarTextoExtraido(texto, limite = MAX_EXTRACTED_CHARS) {
  const limpio = String(texto || "").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (limpio.length <= limite) return limpio;
  return limpio.slice(0, limite) + "\n\n[Texto recortado por seguridad: el archivo es mas largo.]";
}

function esImagen(tipo, ext) {
  return String(tipo || "").startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
}

function esPdf(tipo, ext) {
  return tipo === "application/pdf" || ext === ".pdf";
}

function esDocx(tipo, ext) {
  return tipo === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === ".docx";
}

function esTextoPlano(tipo, ext) {
  const extensionesTexto = new Set([
    ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx",
    ".py", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".yaml", ".yml", ".log"
  ]);
  return String(tipo || "").startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript", "application/x-javascript"].includes(tipo) ||
    extensionesTexto.has(ext);
}

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
  if (esPdf(tipo, ext)) {
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  if (esDocx(tipo, ext)) {
    const data = await mammoth.extractRawText({ buffer });
    return data.value || "";
  }

  if (esTextoPlano(tipo, ext)) {
    return buffer.toString("utf8");
  }

  throw new Error("Formato no soportado todavia. Usa imagenes, PDF, DOCX, TXT, Markdown, JSON, CSV o archivos de codigo.");
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
    return (
      `[Imagen analizada: ${nombre}]\n` +
      `Tipo: ${tipo || ext || "imagen"}\n` +
      `Tamano aproximado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n\n` +
      `${observaciones}`
    );
  }

  const limite = modo === "razonamiento"
    ? MAX_EXTRACTED_CHARS_REASONING
    : MAX_EXTRACTED_CHARS;
  const texto = recortarTextoExtraido(await extraerTextoDocumento(buffer, tipo, ext), limite);
  if (!texto) throw new Error(`No pude extraer texto legible de "${nombre}".`);

  return (
    `[Documento analizado: ${nombre}]\n` +
    `Tipo: ${tipo || ext || "documento"}\n` +
    `Tamano aproximado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n\n` +
    "Contenido extraido:\n" +
    "```\n" + texto + "\n```"
  );
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

  // Aseguramos que el contenido sea texto plano para el modelo
  return mensajes.map((m) => ({ 
    ...m, 
    content: contenidoComoTexto(m.content) 
  }));
}

function elevenLabsTTS(text) {
  return new Promise((resolve, reject) => {
    if (!ELEVENLABS_KEY) { reject(new Error("Sin clave ElevenLabs")); return; }
    const body = JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.50, similarity_boost: 0.85, style: 0.20, use_speaker_boost: true },
      optimize_streaming_latency: 3  // 0-4, mayor = menor latencia
    });
    const options = {
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${VOICE_ID}/stream`,  // <-- /stream
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_KEY,
        "Accept": "audio/mpeg"
      }
    };
    const chunks = [];
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let e = ""; res.on("data", d => e += d);
        res.on("end", () => reject(new Error(`ElevenLabs ${res.statusCode}: ${e}`)));
        return;
      }
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function crearHistorial() {
  return [];
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

  const historiales = new Map();
  const procesandoPorConversacion = new Set();
  let conversationIdActivo = "default";

  function obtenerUserInfo() {
    return {
      userId: session ? session.email : (token === "guest" ? "guest" : "anon"),
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

    // Detector de complejidad
    let ultimoMensajeUsuario = historial.filter(m => m.role === "user").pop()?.content || "";
    const tieneImagenes = historial.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url"));

    if (Array.isArray(ultimoMensajeUsuario)) {
      const textObj = ultimoMensajeUsuario.find(item => item.type === 'text');
      ultimoMensajeUsuario = textObj ? textObj.text : "";
    }
    const esComplejo = !tieneImagenes && detectarComplejidad(ultimoMensajeUsuario) && modo === "razonamiento";

    if (!esComplejo) {
      // Flujo normal directo
      return await ejecutarLLMDirecto(conversationId, historial, opciones);
    }

    // PIPELINE DE RAZONAMIENTO
    try {
      // 1. PLANNER
      send({type: "estado", valor: "entendiendo_problema", conversationId});
      const plan = await llamadaPlanner(ultimoMensajeUsuario);

      send({type: "estado", valor: "creando_plan", conversationId});

      // 2. EXECUTOR
      send({type: "estado", valor: "ejecutando_plan", conversationId});
      const respuestaPreliminar = await llamadaExecutor(ultimoMensajeUsuario, plan);

      // 3. REVIEWER
      send({type: "estado", valor: "verificando_respuesta", conversationId});
      const respuestaFinal = await llamadaReviewer(respuestaPreliminar, ultimoMensajeUsuario);

      // 4. ENVIAR AL USUARIO
      send({type: "estado", valor: "finalizado", conversationId});
      send({type: "mensaje", rol: "charvis", texto: respuestaFinal, conversationId});

      // Guardar en historial
      historial.push({role: "assistant", content: respuestaFinal});
      guardarHistorial(conversationId, historial);

      // Descontar créditos
      consumeCredits(opciones.userId || "anon", 1, opciones.isGuest);

    } catch (error) {
      send({type: "error", texto: "Error en el proceso de razonamiento: " + error.message, conversationId});
    }
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

  async function llamadaPlanner(mensajeUsuario) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: REASONING_MODEL,
        messages: [
          {role: "system", content: "Eres un planificador experto. Analiza la tarea del usuario y genera un plan de máximo 5 pasos concretos numerados. Sé técnico y breve. NO respondas la pregunta todavía, solo el plan."},
          {role: "user", content: mensajeUsuario}
        ],
        max_tokens: 1500,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env.");
      }
      if (response.status === 413) {
        throw new Error("El archivo adjunto o el texto es demasiado largo para procesar. Por favor, intenta con un archivo más pequeño o un fragmento más corto.");
      }
      if (response.status === 429) {
        throw new Error("La red está muy ocupada o excediste el límite de peticiones. Por favor, espera un momento e intenta de nuevo.");
      }
      throw new Error(`Planner error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "1. Analizar solicitud\n2. Proporcionar respuesta detallada";
  }

  async function llamadaExecutor(mensajeUsuario, plan) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: REASONING_MODEL,
        messages: [
          {role: "system", content: "Eres un ejecutor experto. Sigue estrictamente el plan proporcionado paso a paso. Razona en voz alta antes de cada paso (chain of thought). Genera la mejor respuesta posible en español."},
          {role: "user", content: mensajeUsuario + "\n\nPLAN A SEGUIR:\n" + plan}
        ],
        max_tokens: 4000,
        temperature: 0.4
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env.");
      }
      if (response.status === 413) {
        throw new Error("El archivo adjunto o el texto es demasiado largo para procesar. Por favor, intenta con un archivo más pequeño o un fragmento más corto.");
      }
      if (response.status === 429) {
        throw new Error("La red está muy ocupada o excediste el límite de peticiones. Por favor, espera un momento e intenta de nuevo.");
      }
      throw new Error(`Executor error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async function llamadaReviewer(respuesta, preguntaOriginal) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: REASONING_MODEL,
        messages: [
          {role: "system", content: "Eres un revisor crítico senior. Revisa la siguiente respuesta buscando errores lógicos, omisiones, mejores prácticas faltantes, o si no respondió exactamente lo pedido. Si está perfecta, devuélvela tal cual. Si tiene errores, corrígela y devuelve solo la versión corregida. NO agregues metacommentarios del tipo 'como revisor'."},
          {role: "user", content: `PREGUNTA ORIGINAL:\n${preguntaOriginal}\n\nRESPUESTA A REVISAR:\n${respuesta}\n\nDevuelve la respuesta corregida y mejorada.`}
        ],
        max_tokens: 4000,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env.");
      }
      if (response.status === 413) {
        throw new Error("El archivo adjunto o el texto es demasiado largo para procesar. Por favor, intenta con un archivo más pequeño o un fragmento más corto.");
      }
      if (response.status === 429) {
        throw new Error("La red está muy ocupada o excediste el límite de peticiones. Por favor, espera un momento e intenta de nuevo.");
      }
      throw new Error(`Reviewer error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || respuesta;
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
                  enviarFrase(frase).catch(() => {});
                }
              }
            } catch (e) {}
          }
        }
      }

      // Enviar resto de audio si quedó algo
      const audioFinal = opciones.audioActivo !== false && !!ELEVENLABS_KEY;
      if (audioFinal && bufferTexto.trim()) {
        enviarFrase(bufferTexto.trim()).catch(() => {});
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
        send({ type: "error", mensaje: err.message, conversationId });
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

              msg.adjuntos.forEach(adj => {
                if (adj.tipo === 'texto' && adj.contenido) {
                  partesAdjuntos.push(`--- Archivo: ${adj.nombre} ---\n${adj.contenido}\n--- Fin archivo ---`);
                }
              });

              if (partesAdjuntos.length > 0) {
                contenidoUsuario += `\n\n[Archivos adjuntos:]\n\n${partesAdjuntos.join('\n\n')}`;
              }
            }

            let historial = obtenerHistorial(conversationId);
            historial.push({ role: "user", content: contenidoUsuario });

            // Para imágenes, usar formato de visión de OpenAI
            const tieneImagenes = msg.adjuntos?.some(a => a.tipo === 'imagen');

            if (tieneImagenes) {
              const mensajeVision = {
                role: "user",
                content: [{ type: "text", text: contenidoUsuario }]
              };

              msg.adjuntos.filter(a => a.tipo === 'imagen').forEach(img => {
                mensajeVision.content.push({
                  type: "image_url",
                  image_url: { url: img.dataUrl, detail: "auto" }
                });
              });

              historial.pop();
              historial.push(mensajeVision);
            }

            historial = recortarHistorial(historial);
            guardarHistorial(conversationId, historial);
            
            await procesarConLLM(conversationId, historial, { 
              modo, 
              contexto: msg.contexto,
              userId,
              isGuest
            });
          } catch (err) {
            console.error("[OPENAI ERROR]", err);
            if (err.message.includes("401")) {
              send({ type: "error", mensaje: "Error de autenticación: Tu OPENAI_API_KEY es inválida.", conversationId });
              return;
            }
            send({ type: "error", mensaje: err.message, conversationId });
          } finally {
            finalizarProcesamiento(conversationId);
          }
          return;
        }
      } catch (_) {}
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

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`\n🚀 CHARVIS ONLINE`);
  console.log(`🌍 Puerto: ${PORT}`);
  console.log(`🔧 Modo: ${process.env.NODE_ENV || 'development'}`);

  // Verificar clave de OpenAI al iniciar
  await verificarClaveGroq();

  console.log(`\n✅ Servidor listo y funcionando!\n`);
});