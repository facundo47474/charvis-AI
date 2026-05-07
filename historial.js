const MAX_HISTORIAL = 40;

function recortarHistorial(historial) {
  if (historial.length > MAX_HISTORIAL + 1) {
    const system = historial[0];
    return [system, ...historial.slice(-MAX_HISTORIAL)];
  }
  return historial;
}

module.exports = { recortarHistorial, MAX_HISTORIAL };