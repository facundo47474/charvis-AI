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
  if (palabras.length > 5 && enA / palabras.length >= 0.52) return true;
  return false;
}

module.exports = { esEco, normalizar };