const dotenv = require("dotenv");
dotenv.config();

const GROQ_KEY = process.env.GROQ_API_KEY;

if (!GROQ_KEY) {
  console.error("No GROQ_API_KEY found in .env");
  process.exit(1);
}

async function check() {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      console.error(`HTTP Error: ${response.status}`);
      const body = await response.text();
      console.error(body);
      process.exit(1);
    }

    const data = await response.json();
    console.log("Modelos disponibles:");
    const qwenModels = data.data.filter(m => m.id.toLowerCase().includes("qwen") || m.id.toLowerCase().includes("qwq") || m.id.toLowerCase().includes("llama-3.3"));
    console.log(JSON.stringify(qwenModels, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

check();
