/**
 * Utilidades para manejo de tokens y límites (Estimación)
 */

const MAX_INPUT_CHARS = 12000;
const MAX_CONTEXT_MESSAGES = 15;
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Estima tokens basados en longitud de caracteres (Regla simple 1 token ~ 4 caracteres)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Filtra el historial para enviar solo lo relevante y no exceder límites
 */
function buildModelContext(historial, maxMessages = MAX_CONTEXT_MESSAGES) {
  if (!historial || historial.length === 0) return [];
  
  // Siempre mantenemos el mensaje de sistema (índice 0)
  const systemMessage = historial[0];
  const others = historial.slice(1);
  
  // Tomamos los últimos N mensajes
  const recent = others.slice(-maxMessages);
  
  return [systemMessage, ...recent];
}

module.exports = {
  estimateTokens,
  buildModelContext,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS
};
