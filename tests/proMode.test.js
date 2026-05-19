"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");

// Interceptamos http.createServer para poder cerrar el servidor al final del test
const originalCreateServer = http.createServer;
let serverInstance;

http.createServer = function(...args) {
  serverInstance = originalCreateServer.apply(this, args);
  return serverInstance;
};

// Configuramos entorno
process.env.PORT = "3009";
process.env.GROQ_API_KEY = "gsk_mock_key_for_testing";

// Mock de fetch global
const fetchCalls = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });

  if (url === "https://api.groq.com/openai/v1/models") {
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [] })
    };
  }

  if (url === "https://api.groq.com/openai/v1/chat/completions") {
    const body = JSON.parse(options.body);
    
    // Simular Workers de Swarm y Crítico (ambos usan qwen/qwen3-32b)
    if (body.model === "qwen/qwen3-32b") {
      const systemPrompt = body.messages[0].content;

      // Crítico
      if (systemPrompt.includes("Verificá y mejorá")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: "Respuesta final del Crítico: ¡Hola che! Esta es la respuesta final de Charvis Pro, pulida y completa."
              }
            }]
          })
        };
      }

      // Worker
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: `[Pensamiento Worker con temp ${body.temperature}] Proceso de razonamiento del worker.\nRespuesta: Respuesta propuesta con temp ${body.temperature}`
            }
          }]
        })
      };
    }
    
    // Simular Juez (gpt-oss-120b)
    if (body.model === "openai/gpt-oss-120b") {
      const systemPrompt = body.messages[0].content;
      
      if (systemPrompt.includes("Juez y Sintetizador")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
          choices: [{
            message: {
              content: "Respuesta sintetizada por el Juez basada en los 2 workers."
            }
          }]
        })
        };
      }
    }
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "Mock fallback" } }] })
  };
};

describe("Modo Charvis Pro (Pipeline de Enjambre + Crítico)", () => {
  before(async () => {
    // Requerimos server.js para que inicie la escucha
    require("../server.js");
    // Damos un breve delay para que el servidor levante por completo
    await new Promise(resolve => setTimeout(resolve, 1500));
  });

  after(async () => {
    // Restauramos fetch y cerramos el servidor
    globalThis.fetch = originalFetch;
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
  });

  it("Debería ejecutar correctamente el pipeline Pro (Workers -> Juez -> Crítico) con los estados adecuados", async () => {
    const client = new WebSocket("ws://localhost:3009?token=guest");
    const estadosRecibidos = [];
    let respuestaFinal = null;

    await new Promise((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "texto",
          texto: "¿Cómo hago una torta frita perfecta?",
          modo: "pro",
          conversationId: "test-pro-conv"
        }));
      });

      client.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === "estado") {
          estadosRecibidos.push(msg.valor);
        }

        if (msg.type === "mensaje") {
          respuestaFinal = msg.texto;
          client.close();
        }
      });

      client.on("close", () => {
        try {
          // 1. Verificar estados del WebSocket
          assert.ok(estadosRecibidos.includes("pensando_multi_modelo"), "Debería pasar por pensando_multi_modelo");
          assert.ok(estadosRecibidos.includes("sintetizando"), "Debería pasar por sintetizando");
          assert.ok(estadosRecibidos.includes("verificando_respuesta"), "Debería pasar por verificando_respuesta");
          assert.ok(estadosRecibidos.includes("finalizado"), "Debería terminar con finalizado");

          // 2. Verificar la respuesta final
          assert.ok(respuestaFinal.includes("Charvis Pro"), "La respuesta debería venir del crítico");
          assert.ok(respuestaFinal.includes("¡Hola che!"), "Debería incluir la respuesta final formateada");

          // 3. Verificar llamadas a Groq (fetch)
          // Filtrar solo Workers (excluir Crítico que también usa qwen pero con prompt diferente)
          const workerCalls = fetchCalls.filter(c => {
            if (!c.url.includes("chat/completions")) return false;
            const body = JSON.parse(c.options.body);
            if (body.model !== "qwen/qwen3-32b") return false;
            return body.messages[0].content.includes("chain of thought");
          });
          assert.equal(workerCalls.length, 2, "Debería llamar a exactamente 2 workers de Swarm");

          // Verificar temperaturas y prompts de workers
          const temps = workerCalls.map(c => JSON.parse(c.options.body).temperature).sort();
          assert.deepEqual(temps, [0.3, 0.8], "Debería usar temperaturas 0.3 y 0.8");
          
          const workerSystemPrompt = JSON.parse(workerCalls[0].options.body).messages[0].content;
          assert.ok(workerSystemPrompt.includes("chain of thought") && workerSystemPrompt.includes("pasos de razonamiento"), "El prompt del worker debería requerir Chain of Thought");

          const judgeCalls = fetchCalls.filter(c => {
            if (!c.url.includes("chat/completions")) return false;
            const body = JSON.parse(c.options.body);
            return body.model === "openai/gpt-oss-120b" && body.messages[0].content.includes("Juez y Sintetizador");
          });
          assert.equal(judgeCalls.length, 1, "Debería llamar al Juez exactamente una vez");

          const criticCalls = fetchCalls.filter(c => {
            if (!c.url.includes("chat/completions")) return false;
            const body = JSON.parse(c.options.body);
            return body.model === "qwen/qwen3-32b" && body.messages[0].content.includes("Verificá y mejorá");
          });
          assert.equal(criticCalls.length, 1, "Debería llamar al Crítico exactamente una vez");

          const criticBody = JSON.parse(criticCalls[0].options.body);
          assert.equal(criticBody.temperature, 0.2, "El crítico debería usar temperatura baja (0.2) para rigor");

          resolve();
        } catch (err) {
          reject(err);
        }
      });

      client.on("error", (err) => {
        reject(err);
      });
    });
  });
});
