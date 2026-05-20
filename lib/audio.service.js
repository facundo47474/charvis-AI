const https = require("https");

module.exports = function createAudioService(config) {
  const { ELEVENLABS_KEY, VOICE_ID } = config;

  function elevenLabsTTS(text) {
    return new Promise((resolve, reject) => {
      if (!ELEVENLABS_KEY) { reject(new Error("Sin clave ElevenLabs")); return; }
      const payload = JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.7 }
      });
      const options = {
        hostname: "api.elevenlabs.io",
        path: `/v1/text-to-speech/${VOICE_ID}/stream`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_KEY,
          "Accept": "audio/mpeg"
        }
      };
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          res.on("data", d => console.error("ElevenLabs Error:", d.toString()));
          reject(new Error(`ElevenLabs falló con status ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", e => reject(new Error(`ElevenLabs Error de Red: ${e.message}`)));
      req.write(payload);
      req.end();
    });
  }

  return { elevenLabsTTS };
};
