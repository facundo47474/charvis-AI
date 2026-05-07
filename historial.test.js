"use strict";
/**
 * tests/historial.test.js
 * Pruebas unitarias para recortarHistorial()
 * Ejecutar: node --test tests/historial.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { recortarHistorial, MAX_HISTORIAL } = require("../historial");

// ─── Helpers ──────────────────────────────────────────────
const SYSTEM = { role: "system", content: "Sos Charvis" };

/** Crea un historial con el mensaje system + n mensajes alternados user/assistant */
function crearHistorial(n) {
  const h = [SYSTEM];
  for (let i = 0; i < n; i++) {
    h.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `mensaje-${i}`,
    });
  }
  return h;
}

// ═══════════════════════════════════════════════════════════
//  recortarHistorial()
// ═══════════════════════════════════════════════════════════
describe("recortarHistorial()", () => {

  // ── No debe modificar historiales cortos ───────────────

  it("devuelve el mismo arreglo si tiene exactamente MAX_HISTORIAL + 1 elementos", () => {
    const h = crearHistorial(MAX_HISTORIAL); // system + MAX_HISTORIAL mensajes
    assert.equal(h.length, MAX_HISTORIAL + 1);
    const result = recortarHistorial(h);
    assert.deepEqual(result, h);
  });

  it("no modifica un historial por debajo del límite", () => {
    const h = crearHistorial(5);
    const result = recortarHistorial(h);
    assert.deepEqual(result, h);
  });

  it("no modifica un historial de 2 elementos (system + 1 mensaje)", () => {
    const h = crearHistorial(1);
    const result = recortarHistorial(h);
    assert.deepEqual(result, h);
  });

  it("no modifica un historial que solo tiene el mensaje system", () => {
    const h = [SYSTEM];
    const result = recortarHistorial(h);
    assert.deepEqual(result, h);
  });

  it("no modifica un historial vacío", () => {
    const result = recortarHistorial([]);
    assert.deepEqual(result, []);
  });

  // ── Debe recortar cuando supera el límite ──────────────

  it("recorta a MAX_HISTORIAL + 1 cuando supera el límite por 1", () => {
    const h = crearHistorial(MAX_HISTORIAL + 1); // un mensaje extra
    const result = recortarHistorial(h);
    assert.equal(result.length, MAX_HISTORIAL + 1);
  });

  it("recorta a MAX_HISTORIAL + 1 cuando supera el límite por muchos mensajes", () => {
    const h = crearHistorial(MAX_HISTORIAL + 20);
    const result = recortarHistorial(h);
    assert.equal(result.length, MAX_HISTORIAL + 1);
  });

  // ── Siempre conserva el mensaje system ─────────────────

  it("el primer elemento siempre es el mensaje system tras recortar", () => {
    const h = crearHistorial(MAX_HISTORIAL + 10);
    const result = recortarHistorial(h);
    assert.deepEqual(result[0], SYSTEM);
  });

  it("el mensaje system se conserva incluso cuando el historial es muy largo", () => {
    const h = crearHistorial(200);
    const result = recortarHistorial(h);
    assert.deepEqual(result[0], SYSTEM);
  });

  // ── Conserva los mensajes más recientes ────────────────

  it("los mensajes conservados son los últimos MAX_HISTORIAL del original", () => {
    const h = crearHistorial(MAX_HISTORIAL + 10);
    const result = recortarHistorial(h);

    const ultimosOriginales = h.slice(-MAX_HISTORIAL);
    const mensajesResultado = result.slice(1); // excluimos el system

    assert.deepEqual(mensajesResultado, ultimosOriginales);
  });

  it("el último mensaje del resultado coincide con el último mensaje original", () => {
    const h = crearHistorial(MAX_HISTORIAL + 5);
    const result = recortarHistorial(h);
    assert.deepEqual(result[result.length - 1], h[h.length - 1]);
  });

  it("los mensajes antiguos (descartados) no aparecen en el resultado", () => {
    const h = crearHistorial(MAX_HISTORIAL + 5);
    const mensajeEliminado = h[1]; // primer mensaje de usuario (el más viejo)
    const result = recortarHistorial(h);

    const aparece = result.slice(1).some(
      (m) => m.content === mensajeEliminado.content
    );
    assert.equal(aparece, false);
  });

  // ── Idempotencia ───────────────────────────────────────

  it("aplicar la función dos veces sobre un historial largo produce el mismo resultado", () => {
    const h = crearHistorial(MAX_HISTORIAL + 30);
    const primera = recortarHistorial(h);
    const segunda = recortarHistorial(primera);
    assert.deepEqual(primera, segunda);
  });

  // ── Integridad del contenido ───────────────────────────

  it("todos los elementos del resultado tienen role y content definidos", () => {
    const h = crearHistorial(MAX_HISTORIAL + 5);
    const result = recortarHistorial(h);
    for (const msg of result) {
      assert.ok(msg.role, "Falta role en un mensaje");
      assert.ok(msg.content !== undefined, "Falta content en un mensaje");
    }
  });

  // ── MAX_HISTORIAL exportado ────────────────────────────

  it("MAX_HISTORIAL es un número positivo", () => {
    assert.equal(typeof MAX_HISTORIAL, "number");
    assert.ok(MAX_HISTORIAL > 0);
  });
});
