require("dotenv").config();
const express    = require("express");
const { WebSocketServer } = require("ws");
const http       = require("http");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const crypto     = require("crypto");

const { recortarHistorial } = require("./historial");
const { esEco } = require("./eco");

if (!process.env.GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en .env");

const GROQ_KEY = process.env.GROQ_API_KEY;

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
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL  = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const APP_USER      = process.env.APP_USER || "admin";
const APP_PASSWORD  = process.env.APP_PASSWORD || "facu";
const MAX_EXTRACTED_CHARS = 60000;
const MAX_EXTRACTED_CHARS_REASONING = 24000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// Middleware de autenticación simple
const authMiddleware = (req, res, next) => {
  if (!APP_PASSWORD) return next(); // Si no hay password configurado, permitir acceso

  const authHeader = req.headers.authorization || "";
  const [type, credentials] = authHeader.split(" ");

  if (type === "Basic") {
    const [user, pass] = Buffer.from(credentials, "base64").toString().split(":");
    if (user === APP_USER && pass === APP_PASSWORD) {
      return next();
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Charvis Private"');
  res.status(401).send("Acceso restringido. Por favor, identifícate.");
};

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, "www")));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});
function instruccionesCharvis() {
  return (
    "Sos Charvis, un asistente de IA avanzado, preciso y sofisticado, inspirado en JARVIS de Iron Man. " +
    "Respondes con elegancia, inteligencia practica y una leve actitud britanica. " +
    "Usas espanol rioplatense. Se claro, util y directo. " +
    "Cuando recibas archivos o imagenes, razona sobre su contenido y responde exactamente lo que el usuario pida. " +
    "No inventes datos que no esten en el documento o foto. Si algo no se ve o no esta en el texto extraido, decilo. " +
    "Cuando un grafico ayude a explicar datos numericos, podes agregar al final un bloque ```chart con JSON valido: " +
    "{\"title\":\"Titulo\",\"labels\":[\"A\",\"B\"],\"values\":[10,20],\"unit\":\"%\"}. Usalo solo si suma claridad."
  );
}

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

function prepararMensajes(historial, modo) {
  if (modo !== "razonamiento") return historial;

  const sistemaBase = contenidoComoTexto(historial[0]?.content || instruccionesCharvis());
  const sistemaRazonamiento = sistemaBase + "\n\n" +
    "=== MODO RAZONAMIENTO PROFUNDO ACTIVADO ===\n" +
    "Reasoning: high\n\n" +
    "Antes de responder, aplica el siguiente proceso interno:\n" +
    "1. DESCOMPOSICION: Divide el problema en subproblemas concretos.\n" +
    "2. SUPUESTOS: Lista todos los supuestos implicitos. Cuestiona cada uno.\n" +
    "3. PERSPECTIVAS: Considera al menos dos enfoques distintos para resolverlo.\n" +
    "4. VALIDACION: Verifica tu razonamiento paso a paso. Detecta contradicciones.\n" +
    "5. SINTESIS: Construye la respuesta final solo con lo que puedas sostener.\n\n" +
    "Entrega UNICAMENTE la respuesta final: clara, precisa y fundamentada. " +
    "Sin mencionar el proceso interno. Sin frases introductorias vagas. " +
    "Si el problema involucra codigo, incluye el codigo completo y funcional. " +
    "Si involucra datos numericos, muestra los calculos. " +
    "Si hay incertidumbre real, indicala con precision.";

  const mensajes = [
    { role: "system", content: sistemaRazonamiento },
    ...historial.slice(1).map((m) => ({ ...m, content: contenidoComoTexto(m.content) }))
  ];

  return mensajes;
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
  return [{ role: "system", content: instruccionesCharvis() }];
}

wss.on("connection", (ws, req) => {
  // Doble verificación para el WebSocket
  if (APP_PASSWORD) {
    const authHeader = req.headers.authorization || "";
    const [type, credentials] = authHeader.split(" ");
    let authorized = false;

    if (type === "Basic") {
      const [user, pass] = Buffer.from(credentials, "base64").toString().split(":");
      if (user === APP_USER && pass === APP_PASSWORD) authorized = true;
    }

    if (!authorized) {
      ws.close(1008, "No autorizado");
      return;
    }
  }

  const historiales = new Map();
  const procesandoPorConversacion = new Set();
  let conversationIdActivo = "default";

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
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
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

    // Detector de complejidad
    const ultimoMensajeUsuario = historial.filter(m => m.role === "user").pop()?.content || "";
    const esComplejo = detectarComplejidad(ultimoMensajeUsuario) && modo === "razonamiento";

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

    } catch (error) {
      send({type: "error", texto: "Error en el proceso de razonamiento: " + error.message, conversationId});
    }
  }

  function detectarComplejidad(texto) {
    if (!texto || texto.split(/\s+/).length < 15) return false;
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
        throw new Error(`Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env`);
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
        throw new Error(`Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env`);
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
        throw new Error(`Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env`);
      }
      throw new Error(`Reviewer error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || respuesta;
  }

  async function ejecutarLLMDirecto(conversationId, historial, opciones = {}) {
    const modo = modoValido(opciones.modo);
    send({
      type: "estado",
      valor: modo === "razonamiento" ? "razonando" : "pensando",
      conversationId
    });

    const request = {
      model: modo === "razonamiento" ? REASONING_MODEL : CHAT_MODEL,
      messages: prepararMensajes(historial, modo),
      max_tokens: modo === "razonamiento" ? 7000 : 700,
      temperature: modo === "razonamiento" ? 0.45 : 0.65,
      stream: true,
    };

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(`Groq API Key inválida o expirada. Verifica tu GROQ_API_KEY en el archivo .env`);
      }
      throw new Error(`Groq error: ${response.status}`);
    }

    const stream = response.body;
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let respuestaCompleta = "";
    let bufferTexto = "";
    const CORTE = /[.!?]+\s*/;

    send({
      type: "estado",
      valor: "hablando",
      conversationId
    });

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

            if (CORTE.test(bufferTexto) && bufferTexto.length > 15) {
              const match = bufferTexto.match(CORTE);
              const idx = bufferTexto.indexOf(match[0]) + match[0].length;
              const frase = bufferTexto.slice(0, idx).trim();
              bufferTexto = bufferTexto.slice(idx);
              if (frase) {
                enviarFrase(frase).catch((err) => {
                  console.error("[TTS ERROR]", err);
                });
              }
            }
          } catch (e) {
            // Ignorar chunks malformados
          }
        }
      }
    }

    if (bufferTexto.trim()) {
      enviarFrase(bufferTexto.trim()).catch((err) => {
        console.error("[TTS ERROR]", err);
      });
    }

    send({
      type: "streamTerminado",
      conversationId
    });

    historial.push({ role: "assistant", content: respuestaCompleta });
    guardarHistorial(conversationId, historial);
    send({
      type: "mensaje",
      rol: "charvis",
      texto: respuestaCompleta,
      conversationId
    });
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
          if (msg.conversationId) {
            conversationIdActivo = obtenerConversationId(msg);
          }
          const conversationId = obtenerConversationId(msg);

          if (estaProcesando(conversationId)) return;
          iniciarProcesamiento(conversationId);
          try {
            const modo = modoValido(msg.modo);
            const textoUsuario = String(msg.texto || "").trim();
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
                content: [
                  {type: "text", text: contenidoUsuario}
                ]
              };

              msg.adjuntos.filter(a => a.tipo === 'imagen').forEach(img => {
                mensajeVision.content.push({
                  type: "image_url",
                  image_url: {url: img.dataUrl, detail: "auto"}
                });
              });

              // Reemplazar el último mensaje de usuario con el formato de visión
              historial.pop();
              historial.push(mensajeVision);
            }

            historial = recortarHistorial(historial);
            guardarHistorial(conversationId, historial);
            await procesarConLLM(conversationId, historial, { modo });
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