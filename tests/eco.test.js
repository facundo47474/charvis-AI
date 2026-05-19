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
    assert.equal(esEco("x y z", "alpha beta gamma delta"), false);
  });

  it("false para palabras de un char aunque formen substring (longitud menor al umbral)", () => {
    // "a b c" tiene longitud corta y no debe ser tratado como eco
    assert.equal(esEco("a b c", "a b c d e f g"), false);
  });

  // ── Casos que deben retornar true/false corregidos ────────

  it("false para palabras monosílabas o respuestas muy cortas (evita falsos positivos)", () => {
    assert.equal(esEco("hola", "hola cómo estás"), false);
    assert.equal(esEco("pan", "me gusta el pan fresco"), false);
    assert.equal(esEco("sí", "sí, por favor decime qué necesitás"), false);
  });

  it("true si la transcripción larga es substring exacto", () => {
    assert.equal(esEco("hola como estas amigo mio", "hola como estas amigo mio espero que te encuentres bien"), true);
  });

  it("false si todas las palabras coinciden pero la frase es muy corta (ej: hola mundo)", () => {
    assert.equal(esEco("hola mundo", "hola buen mundo amigo"), false);
  });

  it("true si todas las palabras coinciden y tiene longitud prudente (ej: hola mundo maravilloso)", () => {
    assert.equal(esEco("hola mundo maravilloso", "hola buen mundo maravilloso amigo"), true);
  });

  it("true con exactamente 5 palabras que coinciden todas", () => {
    assert.equal(
      esEco("uno dos tres cuatro cinco", "yo dije uno dos tres cuatro cinco veces"),
      true
    );
  });

  it("true si ≥ 75% de palabras (> 5) coinciden en la respuesta", () => {
    // 5 de 6 = 83.3 % → eco
    assert.equal(
      esEco("uno dos tres cuatro cinco seis", "uno dos tres cuatro cinco siete"),
      true
    );
  });

  it("false si < 75% de palabras coinciden en la respuesta", () => {
    // 4 de 6 = 66.7 % → no eco (antes daba true en el código con 52%)
    assert.equal(
      esEco("uno dos tres cuatro cinco seis", "uno dos tres cuatro siete ocho"),
      false
    );
  });

  it("es insensible a mayúsculas", () => {
    assert.equal(esEco("HOLA MUNDO INTERESANTE", "hola buen mundo interesante amigo"), true);
  });

  it("es insensible a tildes y acentos", () => {
    assert.equal(esEco("heroe valiente y audaz", "el heroe valiente y audaz lucho"), true);
  });

  it("es insensible a signos de puntuación", () => {
    assert.equal(esEco("¡hola mundo esperado!", "hola buen mundo esperado amigo"), true);
  });

  // ── Límites exactos ────────────────────────────────────

  it("transcripción de exactamente 2 caracteres pasa la guarda mínima", () => {
    assert.equal(esEco("hi", "saludo de bienvenida"), false);
  });
});
