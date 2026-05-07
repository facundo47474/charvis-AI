"use strict";
/**
 * utils.js — Funciones utilitarias puras extraídas de server.js
 * Exportarlas permite testearlas de forma aislada sin iniciar el servidor.
 *
 * Para usarlas en server.js reemplazá las definiciones locales por:
 *   const { modoValido, normalizarNombreArchivo, ... } = require("./utils");
 */

const path = require("path");

const MAX_FILE_BYTES     = 12 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 60_000;

// ─── Modo ────────────────────────────────────────────────────────────────────

function modoValido(modo) {
  return modo === "razonamiento" ? "razonamiento" : "normal";
}

// ─── Archivos ─────────────────────────────────────────────────────────────────

function normalizarNombreArchivo(nombre) {
  return path.basename(String(nombre || "archivo"))
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 140);
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
  const limpio = String(texto || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (limpio.length <= MAX_EXTRACTED_CHARS) return limpio;
  return (
    limpio.slice(0, MAX_EXTRACTED_CHARS) +
    "\n\n[Texto recortado por seguridad: el archivo es mas largo.]"
  );
}

// ─── Detección de tipo ────────────────────────────────────────────────────────

function esImagen(tipo, ext) {
  return (
    String(tipo || "").startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
  );
}

function esPdf(tipo, ext) {
  return tipo === "application/pdf" || ext === ".pdf";
}

function esDocx(tipo, ext) {
  return (
    tipo ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  );
}

function esTextoPlano(tipo, ext) {
  const extensionesTexto = new Set([
    ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm",
    ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".java",
    ".c", ".cpp", ".cs", ".go", ".rs", ".php", ".rb",
    ".sql", ".yaml", ".yml", ".log",
  ]);
  return (
    String(tipo || "").startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
    ].includes(tipo) ||
    extensionesTexto.has(ext)
  );
}

// ─── Mensajes ─────────────────────────────────────────────────────────────────

function contenidoComoTexto(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || "")
      .filter(Boolean)
      .join("\n");
  }
  return String(content || "");
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_EXTRACTED_CHARS,
  modoValido,
  normalizarNombreArchivo,
  extensionArchivo,
  extraerMimeDataUrl,
  bufferDesdeContenido,
  recortarTextoExtraido,
  esImagen,
  esPdf,
  esDocx,
  esTextoPlano,
  contenidoComoTexto,
};
