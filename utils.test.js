"use strict";
/**
 * tests/utils.test.js
 * Pruebas unitarias para las funciones utilitarias extraídas de server.js
 * Ejecutar: node --test tests/utils.test.js
 *
 * Requiere utils.js en la raíz del proyecto.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../utils");

// ═══════════════════════════════════════════════════════════
//  modoValido()
// ═══════════════════════════════════════════════════════════
describe("modoValido()", () => {
  it("retorna 'razonamiento' para el string exacto", () => {
    assert.equal(modoValido("razonamiento"), "razonamiento");
  });

  it("retorna 'normal' para cualquier otro valor", () => {
    assert.equal(modoValido("normal"), "normal");
    assert.equal(modoValido("RAZONAMIENTO"), "normal");
    assert.equal(modoValido(""), "normal");
    assert.equal(modoValido(null), "normal");
    assert.equal(modoValido(undefined), "normal");
  });
});

// ═══════════════════════════════════════════════════════════
//  normalizarNombreArchivo()
// ═══════════════════════════════════════════════════════════
describe("normalizarNombreArchivo()", () => {
  it("devuelve 'archivo' para null", () => {
    assert.equal(normalizarNombreArchivo(null), "archivo");
  });

  it("devuelve 'archivo' para undefined", () => {
    assert.equal(normalizarNombreArchivo(undefined), "archivo");
  });

  it("conserva nombres simples sin cambios", () => {
    assert.equal(normalizarNombreArchivo("informe.pdf"), "informe.pdf");
  });

  it("reemplaza caracteres especiales por guion bajo", () => {
    const resultado = normalizarNombreArchivo("mi archivo@especial$.txt");
    assert.ok(!resultado.includes("@"), "No debe contener @");
    assert.ok(!resultado.includes("$"), "No debe contener $");
  });

  it("extrae solo el basename de una ruta", () => {
    assert.equal(normalizarNombreArchivo("/etc/passwd"), "passwd");
  });

  it("trunca a 140 caracteres máximo", () => {
    const largo = "a".repeat(200) + ".txt";
    const resultado = normalizarNombreArchivo(largo);
    assert.ok(resultado.length <= 140, `Longitud ${resultado.length} supera 140`);
  });

  it("conserva espacios, guiones y paréntesis permitidos", () => {
    const nombre = "mi archivo (v2) - final.docx";
    const resultado = normalizarNombreArchivo(nombre);
    assert.ok(resultado.includes("("), "Debe conservar paréntesis");
    assert.ok(resultado.includes("-"), "Debe conservar guiones");
  });
});

// ═══════════════════════════════════════════════════════════
//  extensionArchivo()
// ═══════════════════════════════════════════════════════════
describe("extensionArchivo()", () => {
  it("devuelve la extensión en minúsculas", () => {
    assert.equal(extensionArchivo("FOTO.PNG"), ".png");
    assert.equal(extensionArchivo("doc.PDF"), ".pdf");
  });

  it("devuelve cadena vacía si no hay extensión", () => {
    assert.equal(extensionArchivo("sinextension"), "");
  });

  it("devuelve cadena vacía para null", () => {
    assert.equal(extensionArchivo(null), "");
  });

  it("maneja nombres con múltiples puntos correctamente", () => {
    assert.equal(extensionArchivo("archivo.backup.tar.gz"), ".gz");
  });
});

// ═══════════════════════════════════════════════════════════
//  extraerMimeDataUrl()
// ═══════════════════════════════════════════════════════════
describe("extraerMimeDataUrl()", () => {
  it("extrae el tipo MIME de un data URL base64", () => {
    assert.equal(
      extraerMimeDataUrl("data:image/png;base64,ABC123=="),
      "image/png"
    );
  });

  it("extrae el tipo MIME de un data URL sin base64", () => {
    assert.equal(
      extraerMimeDataUrl("data:text/plain,Hola mundo"),
      "text/plain"
    );
  });

  it("devuelve cadena vacía para texto plano que no es data URL", () => {
    assert.equal(extraerMimeDataUrl("contenido normal"), "");
  });

  it("devuelve cadena vacía para null", () => {
    assert.equal(extraerMimeDataUrl(null), "");
  });

  it("devuelve el MIME en minúsculas", () => {
    assert.equal(
      extraerMimeDataUrl("data:Image/JPEG;base64,abc"),
      "image/jpeg"
    );
  });
});

// ═══════════════════════════════════════════════════════════
//  bufferDesdeContenido()
// ═══════════════════════════════════════════════════════════
describe("bufferDesdeContenido()", () => {
  it("convierte texto plano a Buffer UTF-8", () => {
    const buf = bufferDesdeContenido("hola");
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString("utf8"), "hola");
  });

  it("devuelve Buffer vacío para null", () => {
    const buf = bufferDesdeContenido(null);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 0);
  });

  it("decodifica un data URL base64 correctamente", () => {
    const texto = "Charvis";
    const b64 = Buffer.from(texto).toString("base64");
    const buf = bufferDesdeContenido(`data:text/plain;base64,${b64}`);
    assert.equal(buf.toString("utf8"), texto);
  });

  it("lanza error si el data URL no tiene coma separadora", () => {
    assert.throws(
      () => bufferDesdeContenido("data:image/png;base64"),
      /Archivo adjunto invalido/
    );
  });

  it("decodifica un data URL sin base64 (URL-encoded)", () => {
    const buf = bufferDesdeContenido("data:text/plain,Hola%20mundo");
    assert.equal(buf.toString("utf8"), "Hola mundo");
  });
});

// ═══════════════════════════════════════════════════════════
//  recortarTextoExtraido()
// ═══════════════════════════════════════════════════════════
describe("recortarTextoExtraido()", () => {
  it("devuelve cadena vacía para null", () => {
    assert.equal(recortarTextoExtraido(null), "");
  });

  it("no modifica texto dentro del límite", () => {
    const texto = "hola mundo";
    assert.equal(recortarTextoExtraido(texto), texto);
  });

  it("recorta texto que supera MAX_EXTRACTED_CHARS y agrega aviso", () => {
    const largo = "a".repeat(MAX_EXTRACTED_CHARS + 1000);
    const resultado = recortarTextoExtraido(largo);
    assert.ok(resultado.length < largo.length, "Debe ser más corto");
    assert.ok(
      resultado.includes("[Texto recortado por seguridad"),
      "Debe incluir el aviso de recorte"
    );
  });

  it("el texto recortado tiene exactamente MAX_EXTRACTED_CHARS chars antes del aviso", () => {
    const largo = "b".repeat(MAX_EXTRACTED_CHARS + 500);
    const resultado = recortarTextoExtraido(largo);
    const parteTexto = resultado.split("\n\n[Texto recortado")[0];
    assert.equal(parteTexto.length, MAX_EXTRACTED_CHARS);
  });

  it("elimina caracteres nulos (\\u0000)", () => {
    const resultado = recortarTextoExtraido("hola\u0000mundo");
    assert.ok(!resultado.includes("\u0000"), "No debe contener nulos");
    assert.equal(resultado, "holamundo");
  });

  it("elimina espacios y tabs al final de las líneas", () => {
    const resultado = recortarTextoExtraido("linea1   \nlinea2\t\nlinea3");
    assert.ok(!resultado.includes("   \n"), "No debe tener espacios antes de \\n");
  });
});

// ═══════════════════════════════════════════════════════════
//  esImagen()
// ═══════════════════════════════════════════════════════════
describe("esImagen()", () => {
  it("true para mime type image/*", () => {
    assert.equal(esImagen("image/png", ""), true);
    assert.equal(esImagen("image/jpeg", ""), true);
    assert.equal(esImagen("image/gif", ""), true);
  });

  it("true por extensión conocida aunque el tipo sea vacío", () => {
    assert.equal(esImagen("", ".jpg"), true);
    assert.equal(esImagen("", ".webp"), true);
    assert.equal(esImagen("", ".png"), true);
    assert.equal(esImagen("", ".jpeg"), true);
    assert.equal(esImagen("", ".gif"), true);
  });

  it("false para extensión desconocida y tipo no imagen", () => {
    assert.equal(esImagen("application/pdf", ".pdf"), false);
    assert.equal(esImagen("text/plain", ".txt"), false);
    assert.equal(esImagen("", ".bmp"), false); // .bmp no está en la lista
  });

  it("false para null en ambos parámetros", () => {
    assert.equal(esImagen(null, null), false);
  });
});

// ═══════════════════════════════════════════════════════════
//  esPdf()
// ═══════════════════════════════════════════════════════════
describe("esPdf()", () => {
  it("true para mime type application/pdf", () => {
    assert.equal(esPdf("application/pdf", ""), true);
  });

  it("true para extensión .pdf aunque el tipo sea vacío", () => {
    assert.equal(esPdf("", ".pdf"), true);
  });

  it("false para otro mime y otra extensión", () => {
    assert.equal(esPdf("application/json", ".json"), false);
  });

  it("false para null en ambos parámetros", () => {
    assert.equal(esPdf(null, null), false);
  });
});

// ═══════════════════════════════════════════════════════════
//  esDocx()
// ═══════════════════════════════════════════════════════════
describe("esDocx()", () => {
  it("true para mime type OOXML de Word", () => {
    assert.equal(
      esDocx(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ""
      ),
      true
    );
  });

  it("true para extensión .docx aunque el tipo sea vacío", () => {
    assert.equal(esDocx("", ".docx"), true);
  });

  it("false para extensión .doc (formato antiguo) sin el mime correcto", () => {
    assert.equal(esDocx("", ".doc"), false);
  });

  it("false para null en ambos parámetros", () => {
    assert.equal(esDocx(null, null), false);
  });
});

// ═══════════════════════════════════════════════════════════
//  esTextoPlano()
// ═══════════════════════════════════════════════════════════
describe("esTextoPlano()", () => {
  const EXTENSIONES_VALIDAS = [
    ".txt", ".md", ".csv", ".json", ".js", ".ts", ".py",
    ".java", ".go", ".rs", ".sql", ".yaml", ".yml", ".log",
    ".html", ".css", ".xml",
  ];

  for (const ext of EXTENSIONES_VALIDAS) {
    it(`true para extensión ${ext}`, () => {
      assert.equal(esTextoPlano("", ext), true);
    });
  }

  it("true para mime type text/*", () => {
    assert.equal(esTextoPlano("text/plain", ""), true);
    assert.equal(esTextoPlano("text/html", ""), true);
  });

  it("true para application/json como mime", () => {
    assert.equal(esTextoPlano("application/json", ""), true);
  });

  it("false para PDF", () => {
    assert.equal(esTextoPlano("application/pdf", ".pdf"), false);
  });

  it("false para imagen", () => {
    assert.equal(esTextoPlano("image/png", ".png"), false);
  });

  it("false para null en ambos", () => {
    assert.equal(esTextoPlano(null, null), false);
  });
});

// ═══════════════════════════════════════════════════════════
//  contenidoComoTexto()
// ═══════════════════════════════════════════════════════════
describe("contenidoComoTexto()", () => {
  it("devuelve el string tal cual si ya es string", () => {
    assert.equal(contenidoComoTexto("hola"), "hola");
  });

  it("concatena bloques de texto de un array de partes", () => {
    const partes = [{ type: "text", text: "Hola" }, { type: "text", text: "mundo" }];
    assert.equal(contenidoComoTexto(partes), "Hola\nmundo");
  });

  it("ignora partes del array sin campo text", () => {
    const partes = [
      { type: "image_url", image_url: { url: "data:..." } },
      { type: "text", text: "texto útil" },
    ];
    assert.equal(contenidoComoTexto(partes), "texto útil");
  });

  it("devuelve cadena vacía para array vacío", () => {
    assert.equal(contenidoComoTexto([]), "");
  });

  it("convierte a string si no es ni string ni array", () => {
    assert.equal(contenidoComoTexto(42), "42");
    assert.equal(contenidoComoTexto(null), "");
    assert.equal(contenidoComoTexto(undefined), "");
  });

  it("devuelve cadena vacía para null", () => {
    assert.equal(contenidoComoTexto(null), "");
  });
});
