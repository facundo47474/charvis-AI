/**
 * fileWorker.js — Worker Thread para extracción de texto de archivos pesados.
 *
 * PDF y DOCX requieren parsing intensivo de CPU que bloquearía el Event Loop
 * del hilo principal, congelando el servidor para todos los usuarios.
 * Este worker ejecuta esas operaciones en un hilo separado.
 */
"use strict";

const { parentPort, workerData } = require("worker_threads");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

(async () => {
  try {
    const { method, bufferData } = workerData;
    const buffer = Buffer.from(bufferData);
    let text = "";

    if (method === "pdf") {
      const data = await pdfParse(buffer);
      text = data.text || "";
    } else if (method === "docx") {
      const data = await mammoth.extractRawText({ buffer });
      text = data.value || "";
    } else {
      text = buffer.toString("utf8");
    }

    parentPort.postMessage({ ok: true, text });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
})();
