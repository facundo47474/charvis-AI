function normalizar(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function esEco(transcripcion, ultimoAsistente) {
  const t = normalizar(transcripcion);
  const a = normalizar(ultimoAsistente);
  
  // Guardas mínimas de seguridad
  if (t.length < 2 || a.length < 4) return false;
  
  // Coincidencia exacta (siempre es eco)
  if (t === a) return true;
  
  const palabras = t.split(" ").filter(w => w.length > 1);
  if (palabras.length === 0) return false;
  
  // Respuestas humanas súper cortas o monosílabas legítimas (ej: "sí", "no", "pan", "hola", "gracias")
  // NUNCA deben descartarse como eco a menos que sea una coincidencia exacta de toda la respuesta.
  if (t.length < 12 || palabras.length < 3) return false;
  
  // Si la transcripción es un substring exacto y contiguo de la respuesta del asistente,
  // solo es eco si es una frase lo suficientemente larga (evita falsos positivos en frases cortas).
  if (a.includes(t) && t.length >= 18) return true;
  
  // Contar palabras repetidas en el asistente
  const enA = palabras.filter(w => a.includes(w)).length;
  const ratioCoincidencia = enA / palabras.length;
  
  // Para frases medianas (3 a 5 palabras), exigimos coincidencia absoluta (100%) y una longitud prudente.
  if (palabras.length <= 5) {
    if (enA === palabras.length && t.length >= 15) return true;
    return false;
  }
  
  // Para frases largas (> 5 palabras), exigimos un umbral alto y seguro de coincidencia (>= 0.75).
  // Esto evita falsos positivos cuando el usuario repite algunas palabras del contexto de la conversación.
  if (ratioCoincidencia >= 0.75) return true;
  
  return false;
}

module.exports = { esEco, normalizar };