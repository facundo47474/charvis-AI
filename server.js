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

if (!process.env.GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en .env");

const groq          = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_ID      = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const PORT          = process.env.PORT || 3000;
const CHAT_MODEL    = process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile";
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL  = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

const MAX_HISTORIAL = 40;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 60000;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "www")));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

function normalizar(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function esEco(transcripcion, ultimoAsistente) {
  const t = normalizar(transcripcion);
  const a = normalizar(ultimoAsistente);
  if (t.length < 2 || a.length < 4) return false;
  if (a.includes(t) && t.length >= 3) return true;
  const palabras = t.split(" ").filter(w => w.length > 1);
  if (palabras.length === 0) return false;
  const enA = palabras.filter(w => a.includes(w)).length;
  if (palabras.length <= 5 && enA === palabras.length) return true;
  if (palabras.length > 5  && enA / palabras.length >= 0.52) return true;
  return false;
}

function recortarHistorial(historial) {
  if (historial.length > MAX_HISTORIAL + 1) {
    const system = historial[0];
    historial = [system, ...historial.slice(-(MAX_HISTORIAL))];
  }
  return historial;
}

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

function recortarTextoExtraido(texto) {
  const limpio = String(texto || "").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (limpio.length <= MAX_EXTRACTED_CHARS) return limpio;
  return limpio.slice(0, MAX_EXTRACTED_CHARS) + "\n\n[Texto recortado por seguridad: el archivo es mas largo.]";
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
    max_completion_tokens: 900,
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

async function analizarArchivo(archivo, pregunta) {
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

  const texto = recortarTextoExtraido(await extraerTextoDocumento(buffer, tipo, ext));
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

  const instrucciones = contenidoComoTexto(historial[0]?.content || instruccionesCharvis()) +
    " Modo razonamiento activo: piensa con mas cuidado antes de responder, valida supuestos y entrega solo la respuesta final. " +
    "No muestres razonamiento interno ni cadenas de pensamiento.";

  const mensajes = historial.slice(1).map((m) => ({ ...m, content: contenidoComoTexto(m.content) }));
  const ultimoUsuario = [...mensajes].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "user");

  if (ultimoUsuario) {
    mensajes[ultimoUsuario.i] = {
      ...mensajes[ultimoUsuario.i],
      content: `${instrucciones}\n\n${mensajes[ultimoUsuario.i].content}`
    };
  } else {
    mensajes.push({ role: "user", content: instrucciones });
  }

  return mensajes;
}

function elevenLabsTTS(text) {
  return new Promise((resolve, reject) => {
    if (!ELEVENLABS_KEY) { reject(new Error("Sin clave ElevenLabs")); return; }
    const body = JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.50,
        similarity_boost: 0.85,
        style: 0.20,
        use_speaker_boost: true
      }
    });
    const options = {
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${VOICE_ID}`,
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
        let e = "";
        res.on("data", d => e += d);
        res.on("end", () => reject(new Error(`ElevenLabs ${res.statusCode}: ${e}`)));
        return;
      }
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function crearHistorial() {
  return [{ role: "system", content: instruccionesCharvis() }];
}

wss.on("connection", (ws) => {
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
      max_completion_tokens: modo === "razonamiento" ? 900 : 420,
      temperature: modo === "razonamiento" ? 0.45 : 0.65,
      stream: true,
    };

    if (modo === "razonamiento") {
      request.reasoning_effort = "medium";
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
      const tmpFile = path.join(__dirname, `tmp_${Date.now()}.webm`);
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
              contenidoUsuario += await analizarArchivo(msg.archivo, textoUsuario);
              contenidoUsuario += "\n\n";
            }

            contenidoUsuario += textoUsuario || "Analiza el archivo adjunto y dame una respuesta util.";
            historial.push({ role: "user", content: contenidoUsuario });
            historial = recortarHistorial(historial);
            await procesarConLLM(historial, { modo });
          } catch (err) {
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
