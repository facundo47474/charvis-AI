require("dotenv").config();
const express    = require("express");
const { WebSocketServer } = require("ws");
const http       = require("http");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const Groq       = require("groq-sdk");
const pdfParse   = require("pdf-parse");
const mammoth    = require("mammoth");
const crypto     = require("crypto");

const { recortarHistorial } = require("./historial");
const { esEco } = require("./eco");

if (!process.env.GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en .env");
if (process.env.GROQ_API_KEY.includes("xxxxxxxx")) {
  console.warn("⚠️ ALERTA: Estás usando la API Key de ejemplo en el archivo .env.");
  console.warn("Por favor, reemplázala por tu llave real de https://console.groq.com/keys");
}

const groq          = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_ID      = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const PORT          = process.env.PORT || 3000;
const CHAT_MODEL    = process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile";
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "deepseek-r1-distill-llama-70b";
const VISION_MODEL  = process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";
const APP_USER      = process.env.APP_USER || "admin";
const APP_PASSWORD  = process.env.APP_PASSWORD || "facu";
const MAX_EXTRACTED_CHARS = 60000;
const MAX_EXTRACTED_CHARS_REASONING = 12000; // ~3000 tokens, deja margen
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

  const completion = await groq.chat.completions.create({
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
  });

  return completion.choices[0]?.message?.content?.trim() || "No se pudo obtener una descripcion visual.";
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

  const limite = modo === "razonamiento" ? 6000 : MAX_EXTRACTED_CHARS;
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

  let historial   = crearHistorial();
  let procesando  = false;

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

  async function procesarConLLM(historial, opciones = {}) {
    const modo = modoValido(opciones.modo);
    send({ type: "estado", valor: modo === "razonamiento" ? "razonando" : "pensando" });

    const request = {
      model: modo === "razonamiento" ? REASONING_MODEL : CHAT_MODEL,
      messages: prepararMensajes(historial, modo),
      max_completion_tokens: modo === "razonamiento" ? 5000 : 420,
      temperature: modo === "razonamiento" ? 0.6 : 0.65,
      stream: true,
    };

    if (modo === "razonamiento") {
      request.reasoning_effort = "high";
      request.include_reasoning = false;
    }

    const stream = await groq.chat.completions.create(request);

    let respuestaCompleta = "";
    let bufferTexto = "";
    const CORTE = /[.!?]+\s*/;
    send({ type: "estado", valor: "hablando" });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || "";
      if (!token) continue;
      respuestaCompleta += token;
      bufferTexto += token;
      if (CORTE.test(bufferTexto) && bufferTexto.length > 15) {
        const match = bufferTexto.match(CORTE);
        const idx   = bufferTexto.indexOf(match[0]) + match[0].length;
        const frase = bufferTexto.slice(0, idx).trim();
        bufferTexto = bufferTexto.slice(idx);
        if (frase) await enviarFrase(frase);
      }
    }
    if (bufferTexto.trim()) await enviarFrase(bufferTexto.trim());
    send({ type: "streamTerminado" });
    historial.push({ role: "assistant", content: respuestaCompleta });
    send({ type: "mensaje", rol: "charvis", texto: respuestaCompleta });
  }

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      if (procesando) return;
      procesando = true;
      const tmpFile = path.join(__dirname, `tmp_${crypto.randomUUID()}.webm`);
      try {
        send({ type: "estado", valor: "transcribiendo" });
        fs.writeFileSync(tmpFile, data);
        const tr = await groq.audio.transcriptions.create({
          file: fs.createReadStream(tmpFile),
          model: "whisper-large-v3",
          language: "es"
        });
        const texto = tr.text.trim();
        if (!texto || texto.length < 2) {
          send({ type: "estado", valor: "escuchando" });
          return;
        }
        const ultimoAsistente = [...historial].reverse().find(m => m.role === "assistant")?.content || "";
        if (esEco(texto, ultimoAsistente)) {
          send({ type: "estado", valor: "escuchando" });
          return;
        }
        send({ type: "mensaje", rol: "usuario", texto });
        historial.push({ role: "user", content: texto });
        historial = recortarHistorial(historial);
        await procesarConLLM(historial);
      } catch (err) {
        console.error("[GROQ ERROR]", err);
        if (err.status === 401) {
          send({ type: "error", mensaje: "Error de autenticación: Tu GROQ_API_KEY es inválida o expiró." });
          return;
        }
        send({ type: "error", mensaje: err.message });
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        procesando = false;
      }
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "limpiar") {
          historial = crearHistorial();
          procesando = false;
          send({ type: "limpiar" });
          return;
        }
        if (msg.type === "texto") {
          if (procesando) return;
          procesando = true;
          try {
            const modo = modoValido(msg.modo);
            const textoUsuario = String(msg.texto || "").trim();
            let contenidoUsuario = "";

            if (msg.archivo) {
              send({ type: "estado", valor: "analizandoArchivo" });
              contenidoUsuario += await analizarArchivo(msg.archivo, textoUsuario, modo);
              contenidoUsuario += "\n\n";
            }

            contenidoUsuario += textoUsuario || "Analiza el archivo adjunto y dame una respuesta util.";
            historial.push({ role: "user", content: contenidoUsuario });
            historial = recortarHistorial(historial);
            await procesarConLLM(historial, { modo });
          } catch (err) {
            console.error("[GROQ ERROR]", err);
            if (err.status === 401) {
              send({ type: "error", mensaje: "Error de autenticación: Tu GROQ_API_KEY es inválida." });
              return;
            }
            send({ type: "error", mensaje: err.message });
          } finally {
            procesando = false;
          }
          return;
        }
      } catch (_) {}
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 CHARVIS ONLINE`);
  console.log(`🌍 Puerto: ${PORT}`);
  console.log(`🔧 Modo: ${process.env.NODE_ENV || 'development'}\n`);
});