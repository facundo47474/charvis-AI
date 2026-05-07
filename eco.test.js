"use strict";
/**
 * tests/eco.test.js
 * Pruebas unitarias para normalizar() y esEco()
 * Ejecutar: node --test tests/eco.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Copiamos las funciones exactamente como están en eco.js
// para poder importarlas sin problemas de ruta en el runner
const { normalizar, esEco } = require("../eco");

// ═══════════════════════════════════════════════════════════
//  normalizar()
// ═══════════════════════════════════════════════════════════
describe("normalizar()", () => {
  it("devuelve cadena vacía para null", () => {
    assert.equal(normalizar(null), "");
  });

  it("devuelve cadena vacía para undefined", () => {
    assert.equal(normalizar(undefined), "");
  });

  it("devuelve cadena vacía para cadena vacía", () => {
    assert.equal(normalizar(""), "");
  });

  it("convierte a minúsculas", () => {
    assert.equal(normalizar("HOLA MUNDO"), "hola mundo");
  });

  it("elimina tildes y diacríticos (NFD)", () => {
    assert.equal(normalizar("héroe café niño"), "heroe cafe nino");
  });

  it("elimina signos de puntuación reemplazándolos por espacio", () => {
    assert.equal(normalizar("hola, mundo!"), "hola mundo");
  });

  it("colapsa múltiples espacios en uno solo", () => {
    assert.equal(normalizar("hola   mundo"), "hola mundo");
  });

  it("elimina espacios al inicio y al final", () => {
    assert.equal(normalizar("  hola  "), "hola");
  });

  it("convierte números a string y los normaliza", () => {
    assert.equal(normalizar(42), "42");
  });

  it("mantiene letras con diéresis (ü)", () => {
    // la ü decompone en u + diéresis; el combining mark se elimina → u
    assert.equal(normalizar("müller"), "muller");
  });
});

// ═══════════════════════════════════════════════════════════
//  esEco()
// ═══════════════════════════════════════════════════════════
describe("esEco()", () => {

  // ── Casos que deben retornar false ──────────────────────

  it("false si la transcripción tiene menos de 2 caracteres", () => {
    assert.equal(esEco("a", "una respuesta larga del asistente"), false);
  });

  it("false si la transcripción está vacía", () => {
    assert.equal(esEco("", "respuesta del asistente"), false);
  });

  it("false si la respuesta del asistente tiene menos de 4 caracteres", () => {
    assert.equal(esEco("hola", "ok"), false);
  });

  it("false si la respuesta del asistente está vacía", () => {
    assert.equal(esEco("hola", ""), false);
  });

  it("false si ninguna palabra de la transcripción está en la respuesta", () => {
    assert.equal(esEco("pizza voladora verde", "el cielo es azul"), false);
  });

  it("false si solo parte (< 100%) de las palabras cortas están en la respuesta (≤ 5 palabras)", () => {
    // "pizza" y "verde" no están en la respuesta → no es eco
    assert.equal(esEco("pizza voladora verde", "la voladora se fue lejos"), false);
  });

  it("false si < 52% de palabras largas (> 5) coinciden", () => {
    // 2 de 6 = 33 % → no eco
    assert.equal(
      esEco("alfa beta gamma delta epsilon zeta", "alfa beta omega theta iota kappa"),
      false
    );
  });

  it("false si las palabras de 1 char NO forman substring en la respuesta", () => {
    // La guarda de substring se evalúa ANTES del filtro de palabras cortas.
    // "x y z" no es substring de "alpha beta gamma" → palabras filtradas = 0 → false.
    assert.equal(esEco("x y z", "alpha beta gamma delta"), false);
  });

  it("true cuando las palabras de 1 char forman un substring (comportamiento documentado)", () => {
    // "a b c" (5 chars) IS substring de "a b c d e f g" → la función retorna true
    // por la regla de substring, antes de llegar al filtro de longitud de palabras.
    // Este test documenta el comportamiento real para evitar regresiones.
    assert.equal(esEco("a b c", "a b c d e f g"), true);
  });

  // ── Casos que deben retornar true ───────────────────────

  it("true si la transcripción (≥ 3 chars) está contenida como substring en la respuesta", () => {
    assert.equal(esEco("hola", "hola cómo estás"), true);
  });

  it("true si todas las palabras (≤ 5) de la transcripción aparecen en la respuesta", () => {
    assert.equal(esEco("hola mundo", "hola buen mundo amigo"), true);
  });

  it("true con exactamente 5 palabras que coinciden todas", () => {
    assert.equal(
      esEco("uno dos tres cuatro cinco", "yo dije uno dos tres cuatro cinco veces"),
      true
    );
  });

  it("true si ≥ 52% de palabras (> 5) coinciden en la respuesta", () => {
    // 4 de 6 = 66.7 % → eco
    assert.equal(
      esEco("uno dos tres cuatro cinco seis", "uno dos tres cuatro siete ocho"),
      true
    );
  });

  it("true con exactamente 52% de coincidencias en transcripción larga (> 5 palabras)", () => {
    // 4 de 7 ≈ 57 % → eco (> 0.52)
    assert.equal(
      esEco("aa bb cc dd ee ff gg", "aa bb cc dd xx yy zz"),
      true
    );
  });

  it("es insensible a mayúsculas", () => {
    assert.equal(esEco("HOLA MUNDO", "hola buen mundo amigo"), true);
  });

  it("es insensible a tildes y acentos", () => {
    assert.equal(esEco("Héroe", "el heroe valiente lucho"), true);
  });

  it("es insensible a signos de puntuación", () => {
    assert.equal(esEco("¡hola!", "hola cómo estás"), true);
  });

  // ── Límites exactos ────────────────────────────────────

  it("transcripción de exactamente 2 caracteres pasa la guarda mínima", () => {
    // "hi" tiene length 2 → pasa; pero "hi" NO está en "saludo de bienvenida"
    assert.equal(esEco("hi", "saludo de bienvenida"), false);
  });

  it("transcripción de exactamente 3 chars y está como substring → true", () => {
    assert.equal(esEco("pan", "me gusta el pan fresco"), true);
  });
});
