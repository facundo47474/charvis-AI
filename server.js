require("dotenv").config();
const express    = require("express");
const { WebSocketServer } = require("ws");
const http       = require("http");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const Groq       = require("groq-sdk");

if (!process.env.GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en .env");

const groq          = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_ID      = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const PORT          = process.env.PORT || 3000;

const MAX_HISTORIAL = 40;

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
  return [{
    role: "system",
    content:
      "Sos Charvis, un asistente de IA avanzado, preciso y sofisticado, inspirado en JARVIS de Iron Man. " +
      "Respondés con elegancia, inteligencia y una leve actitud británica. " +
      "Usás español rioplatense. Sin listas ni markdown. Máximo 3 oraciones por respuesta. " +
      "Cuando te envíen un archivo, analizalo a fondo y dá una respuesta útil sobre su contenido."
  }];
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

  async function procesarConLLM(historial) {
    send({ type: "estado", valor: "pensando" });
    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: historial,
      max_tokens: 300,
      stream: true,
    });

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
            let contenidoUsuario = "";
            if (msg.archivo) {
              const { nombre, tipo, contenido } = msg.archivo;
              if (tipo && tipo.startsWith("image/")) {
                contenidoUsuario += `[El usuario adjuntó una imagen: "${nombre}"]\n\n`;
              } else {
                contenidoUsuario += `[Archivo adjunto: "${nombre}"]\n\`\`\`\n${contenido}\n\`\`\`\n\n`;
              }
            }
            if (msg.texto) contenidoUsuario += msg.texto;
            historial.push({ role: "user", content: contenidoUsuario });
            historial = recortarHistorial(historial);
            await procesarConLLM(historial);
          } finally {
            procesando = false;
          }
        }
      } catch (_) {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`CHARVIS corriendo en http://localhost:${PORT}`);
});
