// ===== AGENTE INTELIGENTE - NODE.JS =====
// Sistema de procesamiento de consultas con IA

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("./config");
const {
  GEMINI_MAX_RETRIES,
  GEMINI_EMBEDDINGS_TIMEOUT_MS,
  getGeminiClient,
  obtenerModelosGemini,
  esErrorRecuperableGemini,
} = require("./geminiConfig");
const {
  obtenerTextosDocumentosActivos,
  obtenerChunksYEmbeddingsCache,
  guardarChunksDocumento,
  guardarEmbeddingsChunks,
} = require("./documentosService");

// Embeddings (se cargarán dinámicamente porque son ESM)
let pipeline = null;

// ===== CHUNKING INTELIGENTE POR SECCIONES/ARTÍCULOS =====

/**
 * Divide texto en chunks semánticos detectando artículos, capítulos y secciones
 * @param {string} texto - Texto completo del documento
 * @param {Object} opciones - Opciones de configuración
 * @returns {Array} Array de objetos chunk con metadata
 */
function dividirTextoEnChunksSemanticos(texto, opciones = {}) {
  const {
    maxChunkSize = 2800, // Aumentado para evitar cortes en artículos largos del reglamento
    minChunkSize = 50, // Reducido para no perder artículos o párrafos cortos
    nombreDocumento = "documento",
    tipoDocumento = "otros",
  } = opciones;

  const chunks = [];

  // Normalizar texto: DOCX/PDF pueden tener \r\n, espacios extra, etc.
  texto = (texto || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Patrones para detectar secciones (más flexibles para distintos formatos)
  const patronCapitulo = /(?:^|\n)\s*(CAP[ÍI]TULO\s+[IVXLCDM\d]+[^\n]*)/gi;
  const patronTitulo = /(?:^|\n)\s*(T[ÍI]TULO\s+[IVXLCDM\d]+[^\n]*)/gi;
  const patronSeccion = /(?:^|\n)\s*(SECCI[ÓO]N\s+[IVXLCDM\d]+[^\n]*)/gi;

  // Artículos: varios patrones para DOCX, PDF y formatos variados
  // 1) Con paréntesis: "Artículo 1. Descuento (Kinder a 1º)"
  const patronArticuloConParen =
    /(?:^|\n)\s*(Art[íi]culo\s*(?:N[°º]?\s*)?\d+[\.\-]?\s*[^(\n]*\([^)]+\)[^\n]*)/gi;
  // 2) Sin paréntesis obligatorio: "ARTÍCULO 1. Descuento por Fidelidad" o "Art. 2. Título"
  const patronArticuloSimple =
    /(?:^|\n)\s*(Art[íi]culo\s*(?:N[°º]?\s*)?\d+[\.\-]?\s*[^\n]+)/gi;

  const secciones = [];
  let match;

  // Buscar títulos
  while ((match = patronTitulo.exec(texto)) !== null) {
    secciones.push({
      tipo: "titulo",
      texto: match[1].trim(),
      posicion: match.index,
    });
  }

  // Buscar capítulos
  patronCapitulo.lastIndex = 0;
  while ((match = patronCapitulo.exec(texto)) !== null) {
    secciones.push({
      tipo: "capitulo",
      texto: match[1].trim(),
      posicion: match.index,
    });
  }

  // Buscar artículos (ambos patrones, evitar duplicados por posición)
  const posicionesArticulos = new Set();
  patronArticuloConParen.lastIndex = 0;
  while ((match = patronArticuloConParen.exec(texto)) !== null) {
    if (!posicionesArticulos.has(match.index)) {
      posicionesArticulos.add(match.index);
      secciones.push({
        tipo: "articulo",
        texto: match[1].trim(),
        posicion: match.index,
      });
    }
  }
  patronArticuloSimple.lastIndex = 0;
  while ((match = patronArticuloSimple.exec(texto)) !== null) {
    if (!posicionesArticulos.has(match.index)) {
      posicionesArticulos.add(match.index);
      secciones.push({
        tipo: "articulo",
        texto: match[1].trim(),
        posicion: match.index,
      });
    }
  }

  // Ordenar por posición
  secciones.sort((a, b) => a.posicion - b.posicion);

  // Si no hay secciones detectadas, intentar split por "Artículo N" como último recurso
  if (secciones.length === 0) {
    const splitPorArticulo =
      /(?=(?:^|\n)\s*Art[íi]culo\s*(?:N[°º]?\s*)?\d+[\.\-]?\s*)/gi;
    const partes = texto
      .split(splitPorArticulo)
      .filter((p) => p.trim().length > 0);
    if (partes.length > 1) {
      partes.forEach((parte, idx) => {
        const contenido = parte.trim();
        if (contenido.length >= minChunkSize) {
          const matchArt = contenido.match(
            /Art[íi]culo\s*(?:N[°º]?\s*)?(\d+)[\.\-]?\s*([^\n]*)/i,
          );
          chunks.push({
            texto: contenido,
            metadata: {
              documento: nombreDocumento,
              tipo: tipoDocumento,
              titulo: "",
              capitulo: "",
              articulo: matchArt ? matchArt[1] : String(idx + 1),
              titulo_articulo: matchArt ? matchArt[2].trim().slice(0, 80) : "",
              parte: null,
            },
          });
        } else if (contenido.length > 0) {
          chunks.push({
            texto: contenido,
            metadata: {
              documento: nombreDocumento,
              tipo: tipoDocumento,
              titulo: "",
              capitulo: "",
              articulo: String(idx + 1),
              titulo_articulo: "",
              parte: null,
            },
          });
        }
      });
      if (chunks.length > 0) {
        console.log(
          `📄 [ChunkingSemantico] Documento "${nombreDocumento}": ${chunks.length} chunks (split por Artículo)`,
        );
        return chunks;
      }
    }
    return dividirTextoEnChunks(texto, Math.min(maxChunkSize, 1500), 150);
  }

  // Contexto actual (título y capítulo)
  let tituloActual = "";
  let capituloActual = "";

  // Procesar cada sección
  for (let i = 0; i < secciones.length; i++) {
    const seccion = secciones[i];
    const siguientePosicion =
      i < secciones.length - 1 ? secciones[i + 1].posicion : texto.length;

    // Actualizar contexto
    if (seccion.tipo === "titulo") {
      tituloActual = seccion.texto;
      continue;
    }
    if (seccion.tipo === "capitulo") {
      capituloActual = seccion.texto;
      continue;
    }

    // Extraer contenido del artículo
    const contenidoCompleto = texto
      .slice(seccion.posicion, siguientePosicion)
      .trim();

    // Extraer número y título del artículo (paréntesis opcional)
    const matchNumero = seccion.texto.match(
      /Art[íi]culo\s*(?:N[°º]?\s*)?(\d+)/i,
    );
    const matchTituloArt =
      seccion.texto.match(/\(([^)]+)\)/) ||
      seccion.texto.match(/[\.\-]\s*([^\n(]+)/);
    const numeroArticulo = matchNumero ? matchNumero[1] : "";
    const tituloArticulo = matchTituloArt ? matchTituloArt[1] : "";

    // Si el contenido es muy largo, subdividir
    if (contenidoCompleto.length > maxChunkSize) {
      const subChunks = dividirTextoEnChunks(
        contenidoCompleto,
        maxChunkSize,
        150,
      );
      subChunks.forEach((subChunk, idx) => {
        chunks.push({
          texto: subChunk,
          metadata: {
            documento: nombreDocumento,
            tipo: tipoDocumento,
            titulo: tituloActual,
            capitulo: capituloActual,
            articulo: numeroArticulo,
            titulo_articulo: tituloArticulo,
            parte:
              subChunks.length > 1 ? `${idx + 1}/${subChunks.length}` : null,
          },
        });
      });
    } else if (contenidoCompleto.length >= minChunkSize) {
      chunks.push({
        texto: contenidoCompleto,
        metadata: {
          documento: nombreDocumento,
          tipo: tipoDocumento,
          titulo: tituloActual,
          capitulo: capituloActual,
          articulo: numeroArticulo,
          titulo_articulo: tituloArticulo,
          parte: null,
        },
      });
    } else if (contenidoCompleto.trim().length > 0) {
      // Incluir contenido corto - no perder información (artículos breves, párrafos)
      chunks.push({
        texto: contenidoCompleto.trim(),
        metadata: {
          documento: nombreDocumento,
          tipo: tipoDocumento,
          titulo: tituloActual,
          capitulo: capituloActual,
          articulo: numeroArticulo,
          titulo_articulo: tituloArticulo,
          parte: null,
        },
      });
    }
  }

  // Si quedó texto antes del primer artículo (introducción, índice), agregarlo
  if (secciones.length > 0 && secciones[0].posicion > minChunkSize) {
    const introduccion = texto.slice(0, secciones[0].posicion).trim();
    if (introduccion.length >= minChunkSize) {
      const introChunks = dividirTextoEnChunks(introduccion, maxChunkSize, 150);
      introChunks.forEach((chunk, idx) => {
        chunks.unshift({
          texto: chunk,
          metadata: {
            documento: nombreDocumento,
            tipo: tipoDocumento,
            titulo: "INTRODUCCIÓN/ÍNDICE",
            capitulo: "",
            articulo: "",
            titulo_articulo: "",
            parte:
              introChunks.length > 1
                ? `${idx + 1}/${introChunks.length}`
                : null,
          },
        });
      });
    }
  }

  console.log(
    `📄 [ChunkingSemantico] Documento "${nombreDocumento}": ${chunks.length} chunks creados`,
  );
  return chunks;
}

/**
 * Función básica de chunking (fallback y para subdivisión)
 */
function dividirTextoEnChunks(texto, chunkSize = 1200, chunkOverlap = 200) {
  const chunks = [];
  let inicio = 0;

  while (inicio < texto.length) {
    const fin = Math.min(inicio + chunkSize, texto.length);
    let chunk = texto.slice(inicio, fin);

    // Intentar cortar en un punto/párrafo si no es el final
    if (fin < texto.length) {
      const ultimoPunto = chunk.lastIndexOf(".");
      const ultimoSalto = chunk.lastIndexOf("\n");
      const corte = Math.max(ultimoPunto, ultimoSalto);

      if (corte > chunkSize * 0.5) {
        chunk = chunk.slice(0, corte + 1);
        inicio += corte + 1 - chunkOverlap;
      } else {
        inicio = fin - chunkOverlap;
      }
    } else {
      inicio = fin;
    }

    if (chunk.trim().length > 0) {
      chunks.push(chunk.trim());
    }
  }

  return chunks;
}
// Configuración
const RUTA_REGLAMENTO = path.join(__dirname, "reglamento.txt");
const RUTA_LOGS = path.join(__dirname, "..", "..", "logs_consultas.json");
const RUTA_CLAVE_TXT = path.join(__dirname, "..", "..", "..", "clave.txt");

function esErrorCuotaGemini(error) {
  return esErrorRecuperableGemini(error);
}
// Variables globales
let modeloEmbeddings = null;
let docsReglamento = [];
let docsEmbeddings = null;
let docsMetadata = []; // Metadata de cada chunk para búsqueda mejorada
let esquemaBdCache = null;
let documentosBdCache = null; // Cache de documentos de BD
let ultimaCargaDocumentos = null; // Timestamp de última carga
const cacheRespuestas = new Map();
const TIEMPO_CACHE_DOCUMENTOS = 5 * 60 * 1000; // 5 minutos

// Servicio de IA inicializado

// Cargar modelo de embeddings (local, gratis) - OPCIONAL
async function cargarModeloEmbeddings() {
  // Si ya está cargado, devolver la instancia existente
  if (modeloEmbeddings) return modeloEmbeddings;

  try {
    if (!pipeline) {
      console.log(
        "🔍 [Agente] Intentando carga dinámica de @xenova/transformers...",
      );
      try {
        const { pipeline: loadPipeline } = await import("@xenova/transformers");
        pipeline = loadPipeline;
        console.log("✅ [Agente] @xenova/transformers cargado (ESM Import)");
      } catch (importError) {
        console.error(
          "❌ [Agente] Error en import() dinámico:",
          importError.message,
        );
        return null;
      }
    }

    if (pipeline) {
      console.log("📥 Cargando modelo de embeddings multilingüe...");
      // Usar modelo multilingüe optimizado para español
      modeloEmbeddings = await pipeline(
        "feature-extraction",
        "Xenova/multilingual-e5-base",
      );
      console.log("✅ Modelo de embeddings multilingüe cargado exitosamente");
      return modeloEmbeddings;
    }
  } catch (error) {
    console.error("⚠️ Error al cargar embeddings multilingües:", error.message);
    try {
      if (pipeline) {
        modeloEmbeddings = await pipeline(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
        );
        console.log("✅ Modelo de embeddings base cargado (fallback)");
        return modeloEmbeddings;
      }
    } catch (fallbackError) {
      console.error(
        "❌ Error crítico en fallback de embeddings:",
        fallbackError.message,
      );
      modeloEmbeddings = null;
    }
  }
  return null;
}

// Cargar documentos desde la base de datos con chunking semántico
async function cargarDocumentosDesdeBD() {
  try {
    // Verificar si hay cache válido
    const ahora = Date.now();
    if (
      documentosBdCache &&
      ultimaCargaDocumentos &&
      ahora - ultimaCargaDocumentos < TIEMPO_CACHE_DOCUMENTOS
    ) {
      return { chunks: documentosBdCache, metadata: docsMetadata };
    }

    // Cargar documentos activos desde BD
    const documentos = await obtenerTextosDocumentosActivos();

    // Procesar cada documento con chunking semántico
    let todosLosChunks = [];
    let todaLaMetadata = [];

    if (documentos && documentos.length > 0) {
      console.log(
        `📚 [CargarDocumentos] Procesando ${documentos.length} documento(s) con chunking semántico...`,
      );

      for (const doc of documentos) {
        if (!doc.texto_extraido || doc.texto_extraido.trim().length === 0) {
          console.warn(
            `⚠️ Documento "${doc.nombre}" no tiene texto extraído, saltando...`,
          );
          continue;
        }

        // Usar chunking semántico para cada documento
        const chunksConMetadata = dividirTextoEnChunksSemanticos(
          doc.texto_extraido,
          {
            maxChunkSize: 2800,
            minChunkSize: 50,
            nombreDocumento: doc.nombre,
            tipoDocumento: doc.tipo || "otros",
          },
        );

        // Separar textos y metadata
        if (Array.isArray(chunksConMetadata) && chunksConMetadata.length > 0) {
          // Verificar si son chunks con metadata o strings simples (fallback)
          if (
            typeof chunksConMetadata[0] === "object" &&
            chunksConMetadata[0].texto
          ) {
            chunksConMetadata.forEach((chunk) => {
              todosLosChunks.push(chunk.texto);
              todaLaMetadata.push(chunk.metadata);
            });
          } else {
            // Fallback: chunks simples sin metadata
            chunksConMetadata.forEach((chunk) => {
              todosLosChunks.push(chunk);
              todaLaMetadata.push({
                documento: doc.nombre,
                tipo: doc.tipo || "otros",
                titulo: "",
                capitulo: "",
                articulo: "",
                titulo_articulo: "",
                parte: null,
              });
            });
          }
        }
      }
    }

    // También cargar el reglamento estático si existe (para retrocompatibilidad)
    try {
      if (fs.existsSync(RUTA_REGLAMENTO)) {
        const contenidoReglamento = fs.readFileSync(RUTA_REGLAMENTO, "utf-8");
        const chunksReglamento = dividirTextoEnChunksSemanticos(
          contenidoReglamento,
          {
            maxChunkSize: 1500,
            minChunkSize: 200,
            nombreDocumento: "reglamento_estatico",
            tipoDocumento: "reglamento",
          },
        );

        if (Array.isArray(chunksReglamento) && chunksReglamento.length > 0) {
          if (
            typeof chunksReglamento[0] === "object" &&
            chunksReglamento[0].texto
          ) {
            chunksReglamento.forEach((chunk) => {
              todosLosChunks.push(chunk.texto);
              todaLaMetadata.push(chunk.metadata);
            });
          } else {
            chunksReglamento.forEach((chunk) => {
              todosLosChunks.push(chunk);
              todaLaMetadata.push({
                documento: "reglamento_estatico",
                tipo: "reglamento",
                titulo: "",
                capitulo: "",
                articulo: "",
                titulo_articulo: "",
                parte: null,
              });
            });
          }
        }
      }
    } catch (error) {
      console.log(
        "ℹ️  No se encontró reglamento estático, usando solo documentos de BD",
      );
    }

    console.log(
      `✅ [CargarDocumentos] Total: ${todosLosChunks.length} chunks con metadata cargados`,
    );

    // Actualizar cache
    documentosBdCache = todosLosChunks;
    docsMetadata = todaLaMetadata;
    ultimaCargaDocumentos = ahora;

    return { chunks: todosLosChunks, metadata: todaLaMetadata };
  } catch (error) {
    console.error("❌ Error al cargar documentos desde BD:", error);
    // Fallback al reglamento estático si existe
    try {
      if (fs.existsSync(RUTA_REGLAMENTO)) {
        const contenido = fs.readFileSync(RUTA_REGLAMENTO, "utf-8");
        const chunks = dividirTextoEnChunks(contenido, 800, 150);
        return {
          chunks,
          metadata: chunks.map(() => ({
            documento: "fallback",
            tipo: "reglamento",
          })),
        };
      }
    } catch (fallbackError) {
      console.error("❌ Error en fallback:", fallbackError);
    }
    return { chunks: [], metadata: [] };
  }
}

// Cargar reglamento y calcular embeddings (con soporte de cache en BD)
async function cargarReglamentoYEmbeddings() {
  try {
    // 1. Intentar cargar desde cache de BD primero
    console.log("🔄 [CargarEmbeddings] Verificando cache de BD...");
    const cache = await obtenerChunksYEmbeddingsCache();

    if (cache && cache.chunks && cache.chunks.length > 0) {
      docsReglamento = cache.chunks;
      docsMetadata = cache.metadata || [];

      if (cache.embeddings && cache.embeddings.length > 0) {
        docsEmbeddings = cache.embeddings;
        console.log(
          `✅ [CargarEmbeddings] Cargados ${docsReglamento.length} chunks y ${docsEmbeddings.length} embeddings desde cache BD`,
        );
        return; // Todo listo desde cache
      } else {
        console.log(
          `📦 [CargarEmbeddings] Cargados ${docsReglamento.length} chunks desde cache, pero sin embeddings`,
        );
      }
    }

    // 2. Si no hay cache, cargar documentos desde BD
    if (!docsReglamento || docsReglamento.length === 0) {
      console.log(
        "📚 [CargarEmbeddings] No hay cache, cargando documentos desde BD...",
      );
      const resultado = await cargarDocumentosDesdeBD();
      docsReglamento = resultado.chunks || [];
      docsMetadata = resultado.metadata || [];
    }

    if (docsReglamento.length === 0) {
      console.warn("⚠️  No se encontraron documentos para cargar");
      return;
    }

    // 3. Calcular embeddings si el modelo está disponible
    console.log(
      `📊 [CargarEmbeddings] Calculando embeddings para ${docsReglamento.length} chunks...`,
    );

    // Evitar que la carga del modelo deje colgada la primera petición del chat.
    // Si tarda demasiado, seguimos sin embeddings (fallback por keywords/BD).
    const EMBEDDINGS_TIMEOUT_MS = GEMINI_EMBEDDINGS_TIMEOUT_MS;
    const modelo = await Promise.race([
      cargarModeloEmbeddings(),
      new Promise((resolve) =>
        setTimeout(() => resolve(null), EMBEDDINGS_TIMEOUT_MS),
      ),
    ]);
    if (!modelo) {
      console.warn(
        `⚠️ [CargarEmbeddings] Timeout (${EMBEDDINGS_TIMEOUT_MS}ms) al cargar modelo. Continuando sin embeddings.`,
      );
    }
    if (modelo) {
      const embeddings = [];
      const startTime = Date.now();

      for (let i = 0; i < docsReglamento.length; i++) {
        const texto = docsReglamento[i];
        const output = await modelo(texto, {
          pooling: "mean",
          normalize: true,
        });
        embeddings.push(Array.from(output.data));

        // Log de progreso cada 50 chunks
        if ((i + 1) % 50 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(
            `  📈 Progreso: ${i + 1}/${docsReglamento.length} chunks (${elapsed}s)`,
          );
        }
      }
      docsEmbeddings = embeddings;

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `✅ [CargarEmbeddings] ${embeddings.length} embeddings calculados en ${totalTime}s`,
      );

      // 4. Guardar embeddings en cache BD para próxima vez
      // (Esto se hará cuando se suba un documento, no aquí para no duplicar)
    } else {
      console.warn(
        "⚠️  Modelo de embeddings no disponible, usando búsqueda por keywords",
      );
    }
  } catch (error) {
    console.error("❌ Error al cargar reglamento:", error);
    throw error;
  }
}

// Función para forzar recarga de documentos (útil después de subir/eliminar)
async function recargarDocumentos() {
  documentosBdCache = null;
  ultimaCargaDocumentos = null;
  await cargarReglamentoYEmbeddings();
}

/**
 * Procesa un documento recién subido: crea chunks, embeddings y los guarda en BD
 * @param {number} documentoId - ID del documento en documentos_agente
 * @param {string} textoExtraido - Texto extraído del documento
 * @param {string} nombre - Nombre del documento
 * @param {string} tipo - Tipo (reglamento, becas, etc.)
 * @returns {Promise<{chunks: number, embeddings: number}>}
 */
async function procesarYGuardarChunksEmbeddings(
  documentoId,
  textoExtraido,
  nombre,
  tipo,
) {
  if (!textoExtraido || textoExtraido.trim().length === 0) {
    console.warn(
      `⚠️ Documento ID ${documentoId} sin texto, omitiendo chunks/embeddings`,
    );
    return { chunks: 0, embeddings: 0 };
  }

  const chunksConMetadata = dividirTextoEnChunksSemanticos(textoExtraido, {
    maxChunkSize: 2800,
    minChunkSize: 50,
    nombreDocumento: nombre,
    tipoDocumento: tipo || "otros",
  });

  if (!Array.isArray(chunksConMetadata) || chunksConMetadata.length === 0) {
    return { chunks: 0, embeddings: 0 };
  }

  const ok = await guardarChunksDocumento(documentoId, chunksConMetadata);
  if (!ok) return { chunks: 0, embeddings: 0 };

  const modelo = await cargarModeloEmbeddings();
  if (!modelo) {
    console.warn(
      "⚠️ Modelo de embeddings no disponible, chunks guardados sin embeddings",
    );
    return { chunks: chunksConMetadata.length, embeddings: 0 };
  }

  const textos = chunksConMetadata.map((c) =>
    typeof c === "object" && c.texto ? c.texto : c,
  );
  const embeddings = [];
  for (let i = 0; i < textos.length; i++) {
    const output = await modelo(textos[i], {
      pooling: "mean",
      normalize: true,
    });
    embeddings.push(Array.from(output.data));
  }

  const okEmb = await guardarEmbeddingsChunks(documentoId, embeddings);
  return {
    chunks: chunksConMetadata.length,
    embeddings: okEmb ? embeddings.length : 0,
  };
}

// Recuperar contexto desde reglamento usando búsqueda híbrida mejorada
async function recuperarContextoDesdeReglamento(pregunta, k = 8) {
  // Verificar si el cache está expirado y recargar si es necesario
  const ahora = Date.now();
  if (
    !documentosBdCache ||
    !ultimaCargaDocumentos ||
    ahora - ultimaCargaDocumentos >= TIEMPO_CACHE_DOCUMENTOS
  ) {
    // Recargar documentos si el cache expiró
    try {
      const resultado = await cargarDocumentosDesdeBD();
      docsReglamento = resultado.chunks || [];
      docsMetadata = resultado.metadata || [];
    } catch (error) {
      console.warn(
        "⚠️  Error al recargar documentos, usando cache:",
        error.message,
      );
    }
  }

  if (!docsReglamento || docsReglamento.length === 0) {
    return "No hay documentos cargados. Por favor, contacta con la administración.";
  }

  // Detectar tipo de pregunta para ajustar búsqueda
  const preguntaLower = pregunta.toLowerCase();

  // Detectar si pregunta sobre un artículo específico
  let articuloBuscado = null;
  const matchArticulo = preguntaLower.match(
    /art[íi]culo\s*(?:n[°º]?\s*)?(\d+)/i,
  );
  if (matchArticulo) {
    articuloBuscado = matchArticulo[1];
  } else {
    // Mapeo ordinal → número de artículo (primer, segundo, tercer, etc.)
    const ordinales = {
      primer: "1",
      primero: "1",
      "1ro": "1",
      "1er": "1",
      segundo: "2",
      "2do": "2",
      tercer: "3",
      tercero: "3",
      "3ro": "3",
      "3er": "3",
      cuarto: "4",
      "4to": "4",
      quinto: "5",
      "5to": "5",
      sexto: "6",
      "6to": "6",
      septimo: "7",
      séptimo: "7",
      "7mo": "7",
      octavo: "8",
      "8vo": "8",
      noveno: "9",
      "9no": "9",
      decimo: "10",
      décimo: "10",
      "10mo": "10",
      once: "11",
      doce: "12",
      trece: "13",
      catorce: "14",
      quince: "15",
    };
    for (const [ordinal, num] of Object.entries(ordinales)) {
      const pat = new RegExp(
        `(?:^|[^a-z])${ordinal.replace(/[áéíóú]/g, ".")}\\s+art[íi]culo|art[íi]culo\\s+${ordinal.replace(/[áéíóú]/g, ".")}|cu[áa]l\\s+es\\s+el\\s+${ordinal.replace(/[áéíóú]/g, ".")}\\s+art[íi]culo`,
        "i",
      );
      if (pat.test(preguntaLower)) {
        articuloBuscado = num;
        break;
      }
    }
  }

  // Detectar tipo de pregunta
  const esPreguntaSobreFechas =
    /cu[áa]ndo|fecha|inicio|empiezan|comienzan|apertura|calendario/i.test(
      preguntaLower,
    );
  const esPreguntaSobreRequisitos =
    /requisito|documento|necesito|inscrib|inscripci[óo]n/i.test(preguntaLower);
  const esPreguntaSobreReglas = /regla|norma|prohib|falta|sanc/i.test(
    preguntaLower,
  );
  const esPreguntaSobreBecas = /beca|descuento|beneficio/i.test(preguntaLower);
  const esPreguntaListaAmplia =
    /cu[áa]les?\s+son|qu[eé]\s+(becas?|reglamentos|tipos)|(becas?|descuentos?)\s+existen|dedicad[oa]s?\s+(a|para)|dirigid[oa]s?\s+(a|para)|para\s+(padres|estudiantes|madres|apoderados|tutores)/i.test(
      preguntaLower,
    );
  const esPreguntaPrimerosArticulos =
    /primeros?\s+art[íi]culos?|art[íi]culos?\s+primeros?/i.test(preguntaLower);
  const esPreguntaSobrePadresOEstudiantes =
    /padre|madre|estudiante|apoderado|tutor|padres\b|madres\b|estudiantes\b/i.test(
      preguntaLower,
    );

  // Ajustar K según tipo de pregunta - más chunks = más contexto completo para el agente
  let kAjustado = k;
  if (esPreguntaSobreFechas) kAjustado = Math.max(k, 14);
  if (esPreguntaSobreRequisitos) kAjustado = Math.max(k, 12);
  if (articuloBuscado) kAjustado = Math.max(k, 10);
  if (articuloBuscado === "1") kAjustado = Math.max(kAjustado, 12);
  if (esPreguntaPrimerosArticulos || esPreguntaListaAmplia)
    kAjustado = Math.max(kAjustado, 18);
  if (esPreguntaSobrePadresOEstudiantes) kAjustado = Math.max(kAjustado, 14);
  if (esPreguntaSobreBecas) kAjustado = Math.max(kAjustado, 20); // Listar todas las becas/descuentos

  // Diccionario de sinónimos expandido
  const sinonimos = {
    inicio: [
      "inicio",
      "comienzo",
      "iniciación",
      "apertura",
      "empieza",
      "empiezan",
      "comienza",
      "comenzar",
      "empezar",
      "inicia",
    ],
    clases: [
      "clases",
      "año escolar",
      "periodo académico",
      "ciclo escolar",
      "gestion",
      "gestión",
      "actividades",
    ],
    fecha: ["fecha", "fechas", "día", "días", "calendario", "cuando", "cuándo"],
    inscripcion: [
      "inscripción",
      "inscripciones",
      "inscribir",
      "matricula",
      "matrícula",
    ],
    requisitos: [
      "requisitos",
      "documentos",
      "necesario",
      "requerir",
      "presentar",
    ],
    beca: ["beca", "becas", "descuento", "beneficio", "ayuda"],
    regla: [
      "regla",
      "reglas",
      "norma",
      "normas",
      "prohibido",
      "sanción",
      "falta",
    ],
    padre: [
      "padre",
      "padres",
      "madre",
      "madres",
      "apoderado",
      "apoderados",
      "tutor",
      "tutores",
      "familia",
      "familiar",
    ],
    estudiante: [
      "estudiante",
      "estudiantes",
      "alumno",
      "alumnos",
      "educando",
      "educandos",
    ],
  };

  // Expandir palabras clave con sinónimos
  let palabrasClave = preguntaLower.split(/\s+/).filter((p) => p.length > 2);
  Object.keys(sinonimos).forEach((key) => {
    if (preguntaLower.includes(key)) {
      palabrasClave = [...palabrasClave, ...sinonimos[key]];
    }
  });

  // Calcular scores con búsqueda híbrida: metadata + keywords + embeddings
  const scores = docsReglamento.map((doc, idx) => {
    const docLower = doc.toLowerCase();
    const metadata = docsMetadata[idx] || {};
    let score = 0;

    // 1. BOOST POR METADATA (búsqueda por artículo específico)
    if (articuloBuscado && metadata.articulo === articuloBuscado) {
      score += 50; // Mayor prioridad si coincide el artículo exacto
    }

    // 2. BOOST POR TIPO DE PREGUNTA Y METADATA
    if (
      esPreguntaSobreFechas &&
      (metadata.titulo_articulo?.toLowerCase().includes("fecha") ||
        metadata.titulo_articulo?.toLowerCase().includes("calendario") ||
        metadata.capitulo?.toLowerCase().includes("calendario"))
    ) {
      score += 15;
    }

    if (
      esPreguntaSobreRequisitos &&
      (metadata.titulo_articulo?.toLowerCase().includes("requisito") ||
        metadata.titulo_articulo?.toLowerCase().includes("inscripci"))
    ) {
      score += 15;
    }

    if (esPreguntaSobreBecas) {
      if (
        metadata.tipo === "becas" ||
        metadata.titulo_articulo?.toLowerCase().includes("beca") ||
        metadata.titulo_articulo?.toLowerCase().includes("descuento")
      )
        score += 20;
      // Priorizar documento ESPECÍFICO de becas/descuentos sobre el reglamento general (ej. Reglamento_Becas_y_Descuentos vs EDUCACIÓN_REGULAR)
      const nombreDoc = (metadata.documento || "").toLowerCase();
      if (/beca|descuento/.test(nombreDoc)) score += 35;
      if (/beca|descuento|art[íi]culo\s*\d+|hermanos|fidelidad/i.test(docLower))
        score += 12;
    }

    // 2b. BOOST para "primeros artículos" - priorizar artículos 1-10
    if (esPreguntaPrimerosArticulos && metadata.articulo) {
      const n = parseInt(metadata.articulo, 10);
      if (n >= 1 && n <= 10) score += 25 - n * 2; // Art. 1: +23, Art. 5: +15, Art. 10: +5
    }

    // 2c. BOOST para preguntas sobre padres/estudiantes - chunks que mencionan estos grupos
    if (esPreguntaSobrePadresOEstudiantes) {
      if (/padre|madre|apoderado|tutor|familia|familiar/i.test(docLower))
        score += 12;
      if (/estudiante|alumno|educando/i.test(docLower)) score += 12;
    }

    // 2d. BOOST para preguntas amplias (cuáles son, reglamentos para X)
    if (esPreguntaListaAmplia && (metadata.articulo || metadata.capitulo))
      score += 8;

    // 3. BÚSQUEDA POR KEYWORDS
    palabrasClave.forEach((palabra) => {
      if (docLower.includes(palabra)) {
        score += 3;
      }
    });

    // 4. BONUS POR COINCIDENCIA EN TÍTULO DE ARTÍCULO
    if (metadata.titulo_articulo) {
      const tituloLower = metadata.titulo_articulo.toLowerCase();
      palabrasClave.forEach((palabra) => {
        if (tituloLower.includes(palabra)) {
          score += 5; // Mayor peso si coincide en el título
        }
      });
    }

    // 5. BONUS POR COINCIDENCIA EN CAPÍTULO
    if (metadata.capitulo) {
      const capituloLower = metadata.capitulo.toLowerCase();
      palabrasClave.forEach((palabra) => {
        if (capituloLower.includes(palabra)) {
          score += 2;
        }
      });
    }

    return { idx, score, metadata };
  });

  // Ordenar por score descendente
  scores.sort((a, b) => b.score - a.score);

  // Para preguntas de becas: incluir TODOS los chunks del documento de becas/descuentos
  let topChunks;
  if (esPreguntaSobreBecas) {
    const idxDocBecas = scores
      .filter((s) =>
        /beca|descuento/.test((s.metadata?.documento || "").toLowerCase()),
      )
      .map((s) => s.idx);
    const idxResto = scores
      .filter((s) => !idxDocBecas.includes(s.idx))
      .map((s) => s.idx);
    const ordenadosBecas = idxDocBecas
      .map((idx) => scores.find((s) => s.idx === idx))
      .filter(Boolean)
      .sort((a, b) => {
        const nA = parseInt(a.metadata?.articulo || "999", 10);
        const nB = parseInt(b.metadata?.articulo || "999", 10);
        return nA - nB;
      });
    const restoOrdenado = idxResto
      .map((idx) => scores.find((s) => s.idx === idx))
      .filter(Boolean)
      .slice(0, Math.max(0, kAjustado - ordenadosBecas.length));
    topChunks = [...ordenadosBecas, ...restoOrdenado].slice(0, kAjustado);
  } else {
    topChunks = scores.slice(0, kAjustado);
  }

  // Construir contexto con metadata enriquecida
  let contexto = "";
  topChunks.forEach((item, i) => {
    const chunk = docsReglamento[item.idx];
    const meta = item.metadata;

    // Agregar encabezado con metadata si existe
    if (meta && (meta.articulo || meta.titulo_articulo || meta.capitulo)) {
      contexto += `\n--- Documento: ${meta.documento || "N/A"}`;
      if (meta.capitulo) contexto += ` | ${meta.capitulo}`;
      if (meta.articulo) contexto += ` | Artículo ${meta.articulo}`;
      if (meta.titulo_articulo) contexto += ` (${meta.titulo_articulo})`;
      contexto += " ---\n";
    }

    contexto += chunk + "\n\n";
  });

  // Log de búsqueda para debugging
  console.log(`🔍 [BusquedaHibrida] Pregunta: "${pregunta.substring(0, 50)}..."
    - Artículo buscado: ${articuloBuscado || "ninguno"}
    - Top ${kAjustado} chunks recuperados
    - Mejor score: ${topChunks[0]?.score || 0}`);

  return contexto.trim();
}

// Obtener esquema de base de datos (mejorado con más detalles)
async function obtenerEsquemaBd(pool) {
  if (esquemaBdCache) {
    return esquemaBdCache;
  }

  try {
    const [tablas] = await pool.query(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `);

    let esquema = "ESQUEMA COMPLETO DE BASE DE DATOS - Unidad Educativa:\n\n";

    // Tablas principales con descripción
    const descripcionesTablas = {
      estudiantes:
        "Tabla principal de estudiantes. Contiene: nombre, apellido_paterno, apellido_materno, ci_estudiante, fecha_nacimiento, datos de padres, etc.",
      inscripciones:
        "Inscripciones de estudiantes a niveles/cursos. Relaciona estudiantes con niveles, cursos, bloques y becas.",
      compromiso_economico:
        "Compromisos económicos de estudiantes. Relaciona estudiantes con inscripciones y becas. Contiene total_cuotas, total_material, total_general.",
      pagos_mensuales:
        "Pagos mensuales por compromiso. Cada fila es un mes (febrero=2, marzo=3, etc.). Contiene: mes (1-12), anio, nombre_mes, monto_esperado, monto_pagado, estado (pendiente/parcial/pagado/vencido).",
      pagos_realizados:
        "Registro de pagos realizados. Relaciona con compromiso_economico. Contiene: fecha_pago, monto, tipo_pago (cuota/material/ambos), mes, anio.",
      nivel:
        "Niveles académicos (ej: PRIMER NIVEL, SEGUNDO NIVEL). Tiene precio y meses (JSON array).",
      curso: "Cursos dentro de niveles.",
      bloque: "Bloques académicos.",
      becas: "Becas disponibles con descuento.",
      servicios_estudiante:
        "Servicios adicionales contratados por estudiantes (ej: APOYO ESCOLAR).",
      ingresos: "Registro de todos los ingresos (académicos y servicios).",
      usuarios: "Usuarios del sistema con roles.",
      roles:
        "Roles del sistema (Administrador, Director, Secretaria, Cajero, etc.).",
    };

    for (const tablaRow of tablas) {
      const tabla = tablaRow.TABLE_NAME;
      const [columnas] = await pool.query(
        `
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `,
        [tabla],
      );

      esquema += `\n=== ${tabla.toUpperCase()} ===\n`;
      if (descripcionesTablas[tabla]) {
        esquema += `Descripción: ${descripcionesTablas[tabla]}\n`;
      }
      esquema += "Columnas:\n";
      columnas.forEach((col) => {
        let colInfo = `  - ${col.COLUMN_NAME} (${col.DATA_TYPE}`;
        if (col.IS_NULLABLE === "NO") colInfo += ", NOT NULL";
        if (col.COLUMN_KEY === "PRI") colInfo += ", PRIMARY KEY";
        if (col.COLUMN_KEY === "MUL") colInfo += ", INDEX";
        if (col.COLUMN_COMMENT) colInfo += `, ${col.COLUMN_COMMENT}`;
        colInfo += ")";
        esquema += colInfo + "\n";
      });
      esquema += "\n";
    }

    // Obtener foreign keys con más detalle
    const [foreignKeys] = await pool.query(`
      SELECT
        TABLE_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, COLUMN_NAME
    `);

    if (foreignKeys.length > 0) {
      esquema += "\n=== RELACIONES ENTRE TABLAS (Foreign Keys) ===\n";
      foreignKeys.forEach((fk) => {
        esquema += `${fk.TABLE_NAME}.${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}\n`;
      });
    }

    // Agregar estructura clave de tablas
    esquema += "\n=== ESTRUCTURA CLAVE DE TABLAS ===\n";
    esquema += `IMPORTANTE - Horarios y precios por nivel:
  - La tabla 'nivel' tiene: id, bloque_id, nombre, descripcion, precio, meses (JSON array de nombres de meses)
  - La tabla 'nivel' NO tiene hora_entrada ni hora_salida
  - Los horarios están en la tabla 'curso': id, nivel_id, nombre, turno, hora_inicio, hora_fin
  - Para obtener precio Y horario de un nivel: JOIN nivel n LEFT JOIN curso c ON c.nivel_id = n.id
  - Niveles actuales: PRIMER NIVEL (Bs 5000, 3-5 años, Mañana 08:00-12:00), SEGUNDO NIVEL (Bs 4500, 5-8 años, Tarde 12:00-17:00)
  - Becas: beca salud (20%), beca asistencia (5%), beca excelencia (15%)
`;

    // Agregar ejemplos de consultas comunes
    esquema += "\n=== EJEMPLOS DE CONSULTAS COMUNES ===\n";
    esquema += `1. Para ver pagos de un estudiante:
   SELECT pm.mes, pm.nombre_mes, pm.monto_esperado, pm.monto_pagado, pm.estado
   FROM pagos_mensuales pm
   JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
   JOIN estudiantes e ON ce.id_estudiante = e.id
   WHERE e.nombre = 'Mariana' AND e.apellido_paterno = 'Rodríguez'
   ORDER BY pm.mes;

2. Para ver todos los pagos realizados de un estudiante:
   SELECT pr.fecha_pago, pr.monto, pr.mes, pr.anio, pr.tipo_pago, pr.detalle
   FROM pagos_realizados pr
   JOIN compromiso_economico ce ON pr.id_compromiso = ce.id
   JOIN estudiantes e ON ce.id_estudiante = e.id
   WHERE e.nombre = 'Mariana' AND e.apellido_paterno = 'Rodríguez'
   ORDER BY pr.anio, pr.mes;

3. Para ver cuotas pendientes:
   SELECT pm.nombre_mes, pm.monto_pendiente, pm.estado
   FROM pagos_mensuales pm
   JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
   JOIN estudiantes e ON ce.id_estudiante = e.id
   WHERE e.nombre = 'Mariana' AND pm.estado IN ('pendiente', 'parcial')
   ORDER BY pm.mes;

4. Nombres de meses en español: febrero=2, marzo=3, abril=4, mayo=5, junio=6, julio=7, agosto=8, septiembre=9, octubre=10, noviembre=11, diciembre=12

5. Para ver precio y horario de todos los niveles (catálogo para padres):
   SELECT n.nombre, n.descripcion, n.precio, n.meses, c.turno, c.hora_inicio, c.hora_fin
   FROM nivel n
   LEFT JOIN curso c ON c.nivel_id = n.id
   ORDER BY n.id;
`;

    esquemaBdCache = esquema;
    return esquema;
  } catch (error) {
    console.error("Error al obtener esquema BD:", error);
    return "Error al obtener esquema de BD";
  }
}

// Llamar al servicio de IA (Google Gemini vía AI Studio)
async function llamarGemini(prompt, maxTokens = 2000) {
  const geminiClient = getGeminiClient();
  const modelos = await obtenerModelosGemini();
  if (modelos.length === 0) {
    throw new Error("No hay modelos Gemini disponibles.");
  }
  const reintentosPorModelo = GEMINI_MAX_RETRIES;

  for (let i = 0; i < modelos.length; i++) {
    const modelo = modelos[i];

    for (let intento = 1; intento <= reintentosPorModelo; intento++) {
      try {
        const model = geminiClient.getGenerativeModel({ model: modelo });
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: Math.max(maxTokens, 4000),
            temperature: 0.1,
            topP: 0.9,
          },
        });

        let texto = result?.response?.text?.()?.trim() || "";
        const finishReason = result?.response?.candidates?.[0]?.finishReason;

        // Si se corta por tokens, intentar continuación
        if (finishReason === "MAX_TOKENS" && texto.length > 0) {
          try {
            const continuation = await model.generateContent({
              contents: [
                { role: "user", parts: [{ text: prompt }] },
                { role: "model", parts: [{ text: texto }] },
                {
                  role: "user",
                  parts: [
                    {
                      text: "Continúa la respuesta anterior desde donde te quedaste. Solo continúa, no repitas.",
                    },
                  ],
                },
              ],
              generationConfig: {
                maxOutputTokens: 3000,
                temperature: 0.1,
                topP: 0.9,
              },
            });
            const extra = continuation?.response?.text?.()?.trim() || "";
            if (extra) texto = `${texto}\n${extra}`;
          } catch (_) {
            // Si falla la continuación, devolver lo obtenido
          }
        }

        if (texto) return texto;
      } catch (apiError) {
        const errorMsg = (apiError?.message || "").toLowerCase();
        const esUltimoIntento = intento === reintentosPorModelo;
        const esUltimoModelo = i === modelos.length - 1;
        const errorRecuperable =
          errorMsg.includes("quota") ||
          errorMsg.includes("rate") ||
          errorMsg.includes("429") ||
          errorMsg.includes("overload") ||
          errorMsg.includes("temporarily unavailable");

        if (errorRecuperable && !esUltimoIntento) {
          continue;
        }

        if (!esUltimoModelo) {
          break; // Intentar siguiente modelo
        }

        throw new Error(`No se pudo conectar con Gemini: ${apiError.message}`);
      }
    }
  }

  throw new Error("No se pudo conectar con el servicio de IA.");
}

// ===== FUNCIÓN PARA BUSCAR HIJOS DE UN PADRE =====
/**
 * Busca todos los estudiantes (hijos) relacionados con un padre/madre
 * usando múltiples criterios: CI, teléfono, dirección
 * @param {Object} pool - Pool de conexión a la base de datos
 * @param {Object} datosPadre - Datos del padre para buscar (ci, telefono, direccion, nombre, apellido)
 * @returns {Array} Lista de estudiantes relacionados
 */
async function buscarHijosPorDatosPadre(pool, datosPadre) {
  try {
    const condiciones = [];
    const parametros = [];

    // Buscar por CI del padre o madre
    if (datosPadre.ci_padre) {
      condiciones.push("(e.ci_padre = ? OR e.ci_madre = ?)");
      parametros.push(datosPadre.ci_padre, datosPadre.ci_padre);
    }
    if (datosPadre.ci_madre) {
      condiciones.push("(e.ci_padre = ? OR e.ci_madre = ?)");
      parametros.push(datosPadre.ci_madre, datosPadre.ci_madre);
    }

    // Buscar por teléfono (cualquiera de los 4 campos)
    if (datosPadre.telefono) {
      const tel = datosPadre.telefono.replace(/\D/g, ""); // Solo dígitos
      if (tel.length >= 7) {
        condiciones.push(`(
          e.telefono_domicilio_padre LIKE ? OR
          e.telefono_oficina_padre LIKE ? OR
          e.telefono_domicilio_madre LIKE ? OR
          e.telefono_oficina_madre LIKE ?
        )`);
        const telPattern = `%${tel.slice(-8)}%`; // Últimos 8 dígitos
        parametros.push(telPattern, telPattern, telPattern, telPattern);
      }
    }

    // Buscar por nombre y apellido del padre
    if (datosPadre.nombre_padre && datosPadre.apellido_padre) {
      condiciones.push("(e.nombre_padre LIKE ? AND e.apellido_padre LIKE ?)");
      parametros.push(
        `%${datosPadre.nombre_padre}%`,
        `%${datosPadre.apellido_padre}%`,
      );
    }

    // Buscar por nombre y apellido de la madre
    if (datosPadre.nombre_madre && datosPadre.apellido_madre) {
      condiciones.push("(e.nombre_madre LIKE ? AND e.apellido_madre LIKE ?)");
      parametros.push(
        `%${datosPadre.nombre_madre}%`,
        `%${datosPadre.apellido_madre}%`,
      );
    }

    if (condiciones.length === 0) {
      console.log(
        "⚠️ [buscarHijosPorDatosPadre] No hay criterios suficientes para buscar",
      );
      return [];
    }

    const query = `
      SELECT
        e.id,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante,
        e.nombre_padre,
        e.apellido_padre,
        e.ci_padre,
        e.nombre_madre,
        e.apellido_madre,
        e.ci_madre,
        e.telefono_domicilio_padre,
        e.telefono_oficina_padre,
        e.telefono_domicilio_madre,
        e.telefono_oficina_madre,
        e.direccion,
        MAX(n.nombre) as nivel_nombre,
        MAX(c.nombre) as curso_nombre
      FROM estudiantes e
      LEFT JOIN inscripciones i ON e.id = i.estudiante_id AND i.estado = 'activo'
      LEFT JOIN nivel n ON i.nivel_id = n.id
      LEFT JOIN curso c ON i.curso_id = c.id
      WHERE e.estado_id = 1 AND (${condiciones.join(" OR ")})
      GROUP BY e.id
      ORDER BY e.nombre, e.apellido_paterno
    `;

    const [estudiantes] = await pool.query(query, parametros);

    console.log(
      `✅ [buscarHijosPorDatosPadre] Encontrados ${estudiantes.length} estudiante(s) relacionado(s)`,
    );
    estudiantes.forEach((est) => {
      console.log(
        `  - ID: ${est.id}, Nombre: ${est.nombre} ${est.apellido_paterno || ""} (Nivel: ${est.nivel_nombre || "Sin nivel"})`,
      );
    });

    return estudiantes;
  } catch (error) {
    console.error("❌ [buscarHijosPorDatosPadre] Error:", error.message);
    return [];
  }
}

// ===== HERRAMIENTAS =====
class Herramienta {
  constructor(nombre, descripcion) {
    this.nombre = nombre;
    this.descripcion = descripcion;
  }

  async ejecutar(pregunta, contexto = {}) {
    throw new Error("Método ejecutar debe ser implementado");
  }
}

class HerramientaFechaHora extends Herramienta {
  constructor() {
    super("fecha_hora", "Responde preguntas sobre la fecha y hora actual");
  }

  async ejecutar(pregunta, contexto = {}) {
    const ahora = new Date();
    const fechaStr = ahora.toLocaleDateString("es-BO", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const horaStr = ahora.toLocaleTimeString("es-BO", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const preguntaLower = pregunta.toLowerCase();
    if (preguntaLower.includes("hoy") || preguntaLower.includes("fecha")) {
      return `La fecha de hoy es **${fechaStr}** y la hora actual es **${horaStr}**.`;
    } else if (preguntaLower.includes("hora")) {
      return `La hora actual es **${horaStr}**.`;
    }
    return `Fecha: ${fechaStr}, Hora: ${horaStr}`;
  }
}

class HerramientaBaseDatos extends Herramienta {
  constructor(pool) {
    super(
      "base_datos",
      "Consulta información de la base de datos (estudiantes, pagos, inscripciones, etc.)",
    );
    this.pool = pool;
  }

  async ejecutar(
    pregunta,
    infoRemitente = null,
    contextoHistorial = "",
    infoUsuario = null,
  ) {
    try {
      const esquema = await obtenerEsquemaBd(this.pool);

      // Verificar permisos para consultas sensibles
      if (infoUsuario) {
        const rol = infoUsuario.rol;
        const preguntaLower = pregunta.toLowerCase();

        // Restricciones para Cajero
        if (rol === "Cajero") {
          const consultasRestringidas = [
            "eliminar",
            "borrar",
            "modificar",
            "cambiar",
            "actualizar",
            "configuración",
            "configuracion",
            "configurar",
            "usuarios del sistema",
            "roles",
            "permisos",
          ];

          if (consultasRestringidas.some((p) => preguntaLower.includes(p))) {
            return "Lo siento, no tienes permisos para realizar esta consulta. Por favor, contacta con un administrador.";
          }
        }

        // Restricciones para Secretaria
        if (rol === "Secretaria") {
          const consultasRestringidas = [
            "eliminar",
            "borrar",
            "modificar usuarios",
            "cambiar roles",
            "configuración del sistema",
            "configuracion del sistema",
          ];

          if (consultasRestringidas.some((p) => preguntaLower.includes(p))) {
            return "Lo siento, no tienes permisos para realizar esta consulta. Por favor, contacta con un administrador.";
          }
        }
      }

      // Si hay información del remitente, buscar estudiantes relacionados
      let contextoRemitente = "";
      let estudiantesRelacionados = [];
      let mesCorregidoPregunta = null; // Para mostrar "Refiriéndose a marzo" cuando se corrigió ortografía
      let preguntaNormalizadaParaFormato = null; // Pregunta con meses corregidos para detección de mes en formato

      // Extraer nombre de hijo/hija de la pregunta si se menciona
      let nombreHijoMencionado = null;
      const preguntaLower = pregunta.toLowerCase();
      // Si el padre pregunta por "mis hijos" (plural) sin nombrar, dar info de TODOS los hijos
      const preguntaPorTodosLosHijos =
        /\bmis\s+hijos\b|\bmis\s+niños\b|\bde\s+mis\s+hijos\b|\bpara\s+mis\s+hijos\b|\btodos\s+mis\s+hijos\b|\bcuota[s]?\s+de\s+mis\s+hijos\b|\bcuanto\s+(tengo|debo|pagar).*mis\s+hijos\b|\bcuota\s+de\s+(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+mis\s+hijos\b/i.test(
          preguntaLower,
        );

      // Patrones más flexibles para extraer nombres (incluye letras simples como "N")
      // IMPORTANTE: Excluir palabras comunes que no son nombres (cuando, cuanto, que, etc.)
      const palabrasExcluidas = [
        "cuando",
        "cuanto",
        "que",
        "qué",
        "cual",
        "cuál",
        "donde",
        "dónde",
        "como",
        "cómo",
        "porque",
        "por qué",
        "para",
        "con",
        "sin",
        "sobre",
        "bajo",
        "entre",
        "hasta",
        "desde",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
        "vence",
        "vencimiento",
        "cuota",
        "mensualidad",
        "pago",
      ];
      const relacionesEstudiante =
        "hija|hijo|estudiante|sobrino|sobrina|nieto|nieta|vecino|vecina|amigo|amiga|familiar|tutor|tutora";
      const relacionesNombre = `(?:${relacionesEstudiante})`;
      const patronesNombre = [
        new RegExp(
          `(?:mi|de mi)\\s+${relacionesNombre}\\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)*)`,
          "i",
        ),
        new RegExp(
          `${relacionesNombre}\\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)*)`,
          "i",
        ),
        /(?:se llama|llamada|llamado)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)*)/i,
        new RegExp(`(?:${relacionesEstudiante})\\s+([A-ZÁÉÍÓÚÑ])`, "i"), // Para casos como "mi sobrino N"
      ];

      const nombresHijosMencionados = [];
      const palabrasComunes = [
        "hija",
        "hijo",
        "estudiante",
        "sobrino",
        "sobrina",
        "nieto",
        "nieta",
        "vecino",
        "vecina",
        "amigo",
        "amiga",
        "familiar",
        "tutor",
        "tutora",
        "cuota",
        "pago",
        "mensualidad",
        "deuda",
        "me",
        "puede",
        "decir",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
      ];

      // Extraer "mis hijos X y Y", "mis hijas X y Y", "mis hijos X, Y y Z" (ej. "cuanto debo del mes de febrero de mis hijos María y José")
      const patronesMisHijosVarios = [
        /(?:de\s+)?mis\s+hijos\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s*,\s*[A-ZÁÉÍÓÚÑa-záéíóúñ]+)*(?:\s+y\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)?)/gi,
        /(?:de\s+)?mis\s+hijas\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s*,\s*[A-ZÁÉÍÓÚÑa-záéíóúñ]+)*(?:\s+y\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)?)/gi,
      ];
      for (const pat of patronesMisHijosVarios) {
        let m;
        while ((m = pat.exec(pregunta)) !== null) {
          const bloque = m[1].trim();
          const partes = bloque
            .split(/\s*,\s*|\s+y\s+/)
            .map((s) => s.trim())
            .filter(Boolean);
          for (const n of partes) {
            const nombreLower = n.toLowerCase();
            if (
              n.length > 0 &&
              !palabrasComunes.includes(nombreLower) &&
              !palabrasExcluidas.includes(nombreLower) &&
              !nombresHijosMencionados.includes(n)
            ) {
              nombresHijosMencionados.push(n);
            }
          }
        }
      }

      for (const patron of patronesNombre) {
        // Crear una versión con bandera global para encontrar múltiples nombres
        const regexGlobal = new RegExp(
          patron.source,
          patron.flags.includes("g") ? patron.flags : patron.flags + "g",
        );
        const matches = pregunta.matchAll(regexGlobal);

        for (const match of matches) {
          if (match && match[1]) {
            const nombreExtraido = match[1].trim();
            const nombreLower = nombreExtraido.toLowerCase();

            if (
              !palabrasComunes.includes(nombreLower) &&
              !palabrasExcluidas.includes(nombreLower) &&
              nombreExtraido.length > 0
            ) {
              if (!nombresHijosMencionados.includes(nombreExtraido)) {
                nombresHijosMencionados.push(nombreExtraido);
              }
            }
          }
        }
      }

      if (infoRemitente) {
        try {
          // ===== USAR NUEVA FUNCIÓN DE BÚSQUEDA DE HIJOS POR DATOS DEL PADRE =====
          // Esta función busca por: CI, teléfono, nombre y apellido del padre/madre
          const datosBusqueda = {
            ci_padre: infoRemitente.ci_padre,
            ci_madre: infoRemitente.ci_madre,
            telefono: infoRemitente.telefono, // El teléfono de WhatsApp del remitente
            nombre_padre: infoRemitente.nombre_padre,
            apellido_padre: infoRemitente.apellido_padre,
            nombre_madre: infoRemitente.nombre_madre,
            apellido_madre: infoRemitente.apellido_madre,
          };

          console.log(`🔍 [HerramientaBaseDatos] Buscando hijos con datos:`, {
            ci_padre: datosBusqueda.ci_padre || "N/A",
            ci_madre: datosBusqueda.ci_madre || "N/A",
            telefono: datosBusqueda.telefono || "N/A",
            nombre_padre: datosBusqueda.nombre_padre || "N/A",
            nombre_madre: datosBusqueda.nombre_madre || "N/A",
          });

          const estudiantes = await buscarHijosPorDatosPadre(
            this.pool,
            datosBusqueda,
          );

          if (estudiantes && estudiantes.length > 0) {
            // ===== LÓGICA PARA MÚLTIPLES HIJOS =====
            if (nombresHijosMencionados.length > 0) {
              // Si el padre mencionó uno o más nombres específicos, filtrar
              const estudiantesFiltrados = estudiantes.filter((est) => {
                const nombreCompleto =
                  `${est.nombre} ${est.apellido_paterno || ""} ${est.apellido_materno || ""}`.toLowerCase();
                const soloNombre = est.nombre.toLowerCase();

                // Verificar si coincide con CUALQUIERA de los nombres mencionados
                return nombresHijosMencionados.some((nombreMencionado) => {
                  const nombreMencionadoLower = nombreMencionado.toLowerCase();
                  if (nombreMencionadoLower.length === 1) {
                    return (
                      soloNombre.startsWith(nombreMencionadoLower) ||
                      nombreCompleto.includes(nombreMencionadoLower)
                    );
                  } else {
                    return (
                      nombreCompleto.includes(nombreMencionadoLower) ||
                      soloNombre.includes(nombreMencionadoLower) ||
                      soloNombre.startsWith(nombreMencionadoLower)
                    );
                  }
                });
              });

              if (estudiantesFiltrados.length > 0) {
                estudiantesRelacionados = estudiantesFiltrados;
                console.log(
                  `✅ Filtrado: Encontrado ${estudiantesFiltrados.length} estudiante(s) que coinciden con los nombres: ${nombresHijosMencionados.join(", ")}`,
                );
              } else {
                console.log(
                  `⚠️ No se encontró estudiante con los nombres mencionados, usando todos los estudiantes relacionados`,
                );
                estudiantesRelacionados = estudiantes;
              }
            } else if (estudiantes.length > 1) {
              // ===== MÚLTIPLES HIJOS SIN NOMBRE ESPECÍFICO =====
              // El padre tiene varios hijos y no especificó cuál
              // Guardar todos pero marcar para preguntar después
              estudiantesRelacionados = estudiantes;

              // Crear mensaje de selección de hijo
              const listaHijos = estudiantes
                .map((est, idx) => {
                  const nivel = est.nivel_nombre || "Sin nivel asignado";
                  const nombreCompleto =
                    `${est.nombre} ${est.apellido_paterno || ""} ${est.apellido_materno || ""}`.trim();
                  return `${idx + 1}. *${nombreCompleto}* - ${nivel}`;
                })
                .join("\n");

              console.log(
                `📊 [HerramientaBaseDatos] Padre con ${estudiantes.length} hijos detectado. Se preguntará sobre cuál.`,
              );

              // Marcar contexto para que se genere pregunta de selección
              contextoRemitente = `\n\n⚠️ ATENCIÓN - MÚLTIPLES HIJOS DETECTADOS:\n`;
              contextoRemitente += `El usuario tiene ${estudiantes.length} estudiantes registrados:\n${listaHijos}\n\n`;
              contextoRemitente += `INSTRUCCIONES ESPECIALES:\n`;
              contextoRemitente += `1. Si el usuario pregunta genéricamente (ej: "cuánto debo", "mis pagos"), DEBES listar a sus hijos y preguntarle sobre cuál desea información.\n`;
              contextoRemitente += `2. Si el usuario menciona un nombre específico (ej: "de mi hija María"), filtra y responde solo sobre ese estudiante.\n`;
              contextoRemitente += `3. Formato de respuesta cuando hay múltiples hijos y pregunta genérica:\n`;
              contextoRemitente += `   "📊 Tienes [N] estudiantes registrados en nuestra institución:\\n\\n[lista de hijos]\\n\\n¿De cuál de tus hijos deseas consultar la información?"\n\n`;
              contextoRemitente += `- Estudiantes relacionados (IDs: ${estudiantes.map((e) => e.id).join(", ")})\n`;
            } else {
              // Un solo hijo
              estudiantesRelacionados = estudiantes;
            }

            // Agregar contexto estándar para consultas SQL
            if (!contextoRemitente.includes("MÚLTIPLES HIJOS DETECTADOS")) {
              contextoRemitente = `\n\nINFORMACIÓN CRÍTICA DEL REMITENTE:\n`;
              contextoRemitente += `- El usuario es: ${infoRemitente.nombre_padre || infoRemitente.nombre_madre || infoRemitente.nombre_autorizado || "Padre/Tutor"}\n`;
              contextoRemitente += `- Estudiantes relacionados con este usuario:\n`;
              estudiantesRelacionados.forEach((est) => {
                contextoRemitente += `  * ID: ${est.id}, Nombre: ${est.nombre} ${est.apellido_paterno || ""} ${est.apellido_materno || ""} (Nivel: ${est.nivel_nombre || "N/A"})\n`;
              });
              if (
                nombresHijosMencionados.length > 0 &&
                estudiantesRelacionados.length < estudiantes.length
              ) {
                contextoRemitente += `\nNOTA: El usuario mencionó específicamente a: ${nombresHijosMencionados.join(", ")}. Se filtraron los estudiantes para mostrar solo los que coinciden.\n`;
              }
            }

            contextoRemitente += `\nIMPORTANTE: Cuando el usuario pregunta sobre "mi hija", "mi hijo", "mi estudiante", "mis pagos", "mis mensualidades", etc.,`;
            contextoRemitente += ` debes buscar SOLO información de estos estudiantes (IDs: ${estudiantesRelacionados.map((e) => e.id).join(", ")}).\n`;
            contextoRemitente += `- Si pregunta sobre pagos/mensualidades, filtra por id_estudiante IN (${estudiantesRelacionados.map((e) => e.id).join(", ")}) en la tabla compromiso_economico.\n`;
            contextoRemitente += `- Si pregunta sobre cuánto debe, qué meses vencen, etc., busca en pagos_mensuales uniendo con compromiso_economico donde id_estudiante IN (${estudiantesRelacionados.map((e) => e.id).join(", ")}).\n`;
            contextoRemitente += `- Si pregunta "qué cuota me falta pagar" o "qué cuotas faltan", muestra SOLO las cuotas pendientes (estado = 'pendiente' o 'parcial') de estos estudiantes.\n`;
            contextoRemitente += `- CRÍTICO: Si pregunta "cuanto debo del mes de [mes]" o "cuanto debo de [mes]", genera SQL que filtre por nombre_mes = '[Mes]' (con primera letra mayúscula: Febrero, Marzo, Abril, etc.) y id_estudiante IN (${estudiantesRelacionados.map((e) => e.id).join(", ")}).\n`;
            contextoRemitente += `- CRÍTICO: Los meses en nombre_mes están capitalizados: 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'\n`;
            console.log(
              `✅ [HerramientaBaseDatos] Estudiantes relacionados encontrados: ${estudiantesRelacionados.length}`,
            );
            estudiantesRelacionados.forEach((est) => {
              console.log(
                `  - ID: ${est.id}, Nombre: ${est.nombre} ${est.apellido_paterno || ""}`,
              );
            });
          } else {
            console.log(
              `⚠️ [HerramientaBaseDatos] No se encontraron estudiantes relacionados para el remitente`,
            );
          }
        } catch (error) {
          console.error(
            "❌ [HerramientaBaseDatos] Error al buscar estudiantes relacionados:",
            error.message,
          );
        }
      } else {
        console.log(
          `⚠️ [HerramientaBaseDatos] No hay infoRemitente disponible`,
        );

        // CRÍTICO:
        // - Desde WhatsApp / canal externo: se requiere número de teléfono para consultas PERSONALES de pagos.
        // - Desde el panel web (con infoUsuario y rol administrativo): se permiten consultas globales de pagos.
        //
        // Solo aplicamos la restricción cuando:
        //   - NO hay infoRemitente (no sabemos qué teléfono es) Y
        //   - NO hay infoUsuario con rol administrativo (Admin/Director/Secretaria/Cajero) Y
        //   - La pregunta parece ser de pagos personales (usa "mi/mis" + pagos/deuda, etc.)
        const esUsuarioAdmin =
          infoUsuario &&
          ["Administrador", "Director", "Secretaria", "Cajero"].includes(
            infoUsuario.rol,
          );

        if (!esUsuarioAdmin) {
          const mencionaPagos =
            /(cuánto|cuanto).*debo/i.test(pregunta) ||
            /(pago|cuota|mensualidad|deuda)/i.test(pregunta);
          const esPrimeraPersona =
            /\bmi(s)?\b/i.test(pregunta) || /\byo\b/i.test(pregunta);

          // Solo bloquear si parece una consulta de pagos personales
          if (mencionaPagos && esPrimeraPersona) {
            throw new Error(
              "Para consultar información de pagos personales, necesitamos identificar tu número de teléfono en nuestros registros. Por favor, verifica que tu número esté registrado correctamente en el sistema o contacta con Secretaría.",
            );
          }
        }
      }

      // ===== ATENDER CONSULTAS DE HORARIO (ENTRADA/SALIDA) PARA PADRES/TUTORES =====
      // Si el remitente está identificado y hay estudiantesRelacionados, podemos responder directamente
      const relacionesHorario =
        "hijo|hija|estudiante|sobrino|sobrina|nieto|nieta|vecino|vecina|amigo|amiga|familiar|tutor|tutora";
      const esPreguntaHorario = new RegExp(
        `horario|hora de entrada|hora de salida|a qu[eé]\\s+hora|a que\\s+hora|(?:sale|salida de|entra|entrada de)\\s+(?:mi\\s+)?(?:${relacionesHorario})`,
        "i",
      ).test(preguntaLower);

      if (
        esPreguntaHorario &&
        estudiantesRelacionados &&
        estudiantesRelacionados.length > 0
      ) {
        const esAutorizado = !!infoRemitente?.nombre_autorizado;
        const sujetoHorario = esAutorizado ? "Su estudiante" : "Su hijo(a)";

        // Si el padre tiene varios hijos y no especificó claramente, pedir que indique cuál
        if (
          estudiantesRelacionados.length > 1 &&
          (!nombresHijosMencionados || nombresHijosMencionados.length === 0)
        ) {
          const listaHijos = estudiantesRelacionados
            .map((est, idx) => {
              const nivel = est.nivel_nombre || "Sin nivel asignado";
              const nombreCompleto =
                `${est.nombre} ${est.apellido_paterno || ""} ${est.apellido_materno || ""}`.trim();
              return `${idx + 1}. *${nombreCompleto}* - ${nivel}`;
            })
            .join("\n");

          return (
            `Tienes registrados varios estudiantes con tu número de contacto:\n\n` +
            `${listaHijos}\n\n` +
            `Por favor indícame sobre cuál de tus estudiantes deseas consultar el horario (por ejemplo: "el horario de mi sobrino José").`
          );
        }

        // En caso de un solo estudiante (o ya filtrado por nombre), obtener su inscripción y nivel con horarios
        const estudianteSeleccionado = estudiantesRelacionados[0];

        const sqlHorario = `
          SELECT
            e.nombre,
            e.apellido_paterno,
            e.apellido_materno,
            n.nombre AS nivel_nombre,
            c.hora_inicio AS hora_entrada,
            c.hora_fin AS hora_salida,
            COALESCE(i.turno, c.turno) AS turno
          FROM estudiantes e
          JOIN inscripciones i ON e.id = i.estudiante_id AND i.estado = 'activo'
          LEFT JOIN nivel n ON i.nivel_id = n.id
          LEFT JOIN curso c ON c.nivel_id = n.id AND (i.curso_id IS NULL OR c.id = i.curso_id)
          WHERE e.id = ?
          ORDER BY i.fecha_inscripcion DESC
          LIMIT 1
        `;

        const [rowsHorario] = await this.pool.query(sqlHorario, [
          estudianteSeleccionado.id,
        ]);

        if (!rowsHorario || rowsHorario.length === 0) {
          return "No encontré una inscripción activa para tu estudiante, por lo que no puedo determinar su horario actual. Te sugiero consultar con Secretaría.";
        }

        const info = rowsHorario[0];
        const nombreCompleto =
          `${info.nombre} ${info.apellido_paterno || ""} ${info.apellido_materno || ""}`.trim();
        const nivelNombre = info.nivel_nombre || "su nivel actual";
        const turno = info.turno ? info.turno.toLowerCase() : null;

        const horaEntrada = info.hora_entrada
          ? String(info.hora_entrada).slice(0, 5)
          : null;
        const horaSalida = info.hora_salida
          ? String(info.hora_salida).slice(0, 5)
          : null;

        if (!horaEntrada && !horaSalida) {
          // Fallback por turno cuando el nivel no tiene horas cargadas explícitamente.
          // Horarios institucionales tomados del reglamento vigente.
          if (turno) {
            const turnoNorm = turno
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "");
            if (turnoNorm.includes("manana")) {
              return (
                `${sujetoHorario} **${nombreCompleto}**, del nivel **${nivelNombre}** (turno mañana), ` +
                `entra a las **08:00** y sale a las **12:30**.`
              );
            }
            if (turnoNorm.includes("tarde")) {
              return (
                `${sujetoHorario} **${nombreCompleto}**, del nivel **${nivelNombre}** (turno tarde), ` +
                `entra a las **14:00** y sale a las **18:30**.`
              );
            }
          }

          return (
            `Actualmente no tengo registrado el horario de entrada o salida del nivel de ${nombreCompleto} ` +
            `(${nivelNombre}${turno ? `, turno ${turno}` : ""}). Por favor consulta con Secretaría para confirmar el horario.`
          );
        }

        // Construir respuesta según la información disponible
        if (horaEntrada && horaSalida) {
          return (
            `${sujetoHorario} **${nombreCompleto}**, del nivel **${nivelNombre}**` +
            `${turno ? ` (turno ${turno})` : ""}, entra a las **${horaEntrada}** y sale a las **${horaSalida}**.`
          );
        }

        if (horaSalida) {
          return (
            `${sujetoHorario} **${nombreCompleto}**, del nivel **${nivelNombre}**` +
            `${turno ? ` (turno ${turno})` : ""}, sale a las **${horaSalida}**.`
          );
        }

        // Solo entrada
        return (
          `${sujetoHorario} **${nombreCompleto}**, del nivel **${nivelNombre}**` +
          `${turno ? ` (turno ${turno})` : ""}, entra a las **${horaEntrada}**.`
        );
      }

      // Preparar contexto de usuario para SQL
      let contextoUsuarioSQL = "";
      if (infoUsuario) {
        contextoUsuarioSQL = `\n\nINFORMACIÓN DEL USUARIO:\n`;
        contextoUsuarioSQL += `- Rol: ${infoUsuario.rol}\n`;
        if (infoUsuario.rol === "Cajero") {
          contextoUsuarioSQL += `- IMPORTANTE: Este usuario es Cajero, solo puede ver información de pagos y estudiantes. No debe ver información de otros usuarios o configuraciones.\n`;
        } else if (infoUsuario.rol === "Secretaria") {
          contextoUsuarioSQL += `- IMPORTANTE: Este usuario es Secretaria, puede ver información de estudiantes, inscripciones y pagos, pero no configuraciones del sistema.\n`;
        }
      }

      const promptSQL = `Eres un experto en SQL y MySQL. Dada esta pregunta del usuario y el esquema completo de la base de datos, genera UNA SOLA consulta SQL válida que responda la pregunta.

${esquema}${contextoRemitente}${contextoHistorial}${contextoUsuarioSQL}

PREGUNTA DEL USUARIO: ${pregunta}

INSTRUCCIONES CRÍTICAS:
- Genera SOLO la consulta SQL válida, sin explicaciones, sin markdown, sin código de bloque, sin comentarios, sin texto adicional.
- La respuesta debe comenzar directamente con SELECT y terminar con punto y coma (;).
- CRÍTICO: La consulta SQL DEBE incluir SELECT, FROM y al menos un JOIN si es necesario. NUNCA generes solo "SELECT campo" sin FROM.
- Usa nombres de tablas y columnas EXACTOS del esquema (respetando mayúsculas/minúsculas).
- CRÍTICO PARA HORARIOS: La tabla 'nivel' NO tiene hora_entrada ni hora_salida. Los horarios están en la tabla 'curso' que tiene: turno, hora_inicio, hora_fin. Para obtener horarios de un nivel, siempre haz JOIN nivel n LEFT JOIN curso c ON c.nivel_id = n.id y usa c.hora_inicio, c.hora_fin, c.turno.
- CRÍTICO PARA PRECIOS POR NIVEL: El precio está en 'nivel.precio'. La descripción del nivel (edad) está en 'nivel.descripcion'. Los meses están en 'nivel.meses' (JSON array). Los horarios (turno, hora_inicio, hora_fin) están en 'curso'.
- EJEMPLO CORRECTO para "precio y horario del primer nivel": SELECT n.nombre, n.descripcion, n.precio, n.meses, c.turno, c.hora_inicio, c.hora_fin FROM nivel n LEFT JOIN curso c ON c.nivel_id = n.id WHERE LOWER(REPLACE(n.nombre,' ','')) LIKE '%primernivel%';
- EJEMPLO para todos los niveles con horarios: SELECT n.nombre, n.descripcion, n.precio, n.meses, c.turno, c.hora_inicio, c.hora_fin FROM nivel n LEFT JOIN curso c ON c.nivel_id = n.id ORDER BY n.id;
- IMPORTANTE: Para buscar estudiantes por nombre completo, usa: WHERE nombre = 'Nombre' AND apellido_paterno = 'Apellido1' AND apellido_materno = 'Apellido2'
- Si la pregunta es sobre PAGOS o MENSUALIDADES de un estudiante:
  * CRÍTICO: SIEMPRE debes incluir FROM pagos_mensuales (o alias pm) y hacer JOIN con compromiso_economico
  * Usa la tabla 'pagos_mensuales' para ver el estado de cada mes (pendiente/parcial/pagado/vencido)
  * Usa la tabla 'pagos_realizados' para ver los pagos que se han hecho
  * Une: estudiantes -> compromiso_economico -> pagos_mensuales
  * Une: estudiantes -> compromiso_economico -> pagos_realizados
  * La columna 'mes' en pagos_mensuales es numérica (2=febrero, 3=marzo, etc.)
  * La columna 'nombre_mes' en pagos_mensuales tiene el nombre en español
  * 'monto_esperado' es lo que debe pagar (está en la tabla pagos_mensuales)
  * 'monto_pagado' DEBE calcularse sumando los pagos de 'pagos_realizados' donde id_compromiso coincide y mes coincide
  * 'monto_pendiente' = monto_esperado - monto_pagado
  * 'estado' puede ser: 'pendiente' (monto_pagado = 0), 'parcial' (0 < monto_pagado < monto_esperado), 'pagado' (monto_pagado >= monto_esperado), 'vencido' (pendiente y fecha_vencimiento < hoy)
  * 'fecha_vencimiento' indica cuándo vence cada mensualidad (está en pagos_mensuales)
  * CRÍTICO: Para obtener monto_pagado ACTUALIZADO, DEBES hacer LEFT JOIN con pagos_realizados y SUM(pr.monto) agrupado por mes
  * CRÍTICO: El campo monto_pagado en pagos_mensuales puede estar desactualizado, SIEMPRE calcula el monto_pagado real sumando pagos_realizados
  * IMPORTANTE: Si preguntan sobre un mes específico (ej: "cuando vence la cuota de febrero", "cuanto debo del mes de febrero", "cuanto debo de febrero"):
    * CRÍTICO: Detecta el mes mencionado en la pregunta (febrero, marzo, abril, mayo, junio, julio, agosto, septiembre, octubre, noviembre, diciembre)
    * CRÍTICO: Los meses en la BD están con primera letra mayúscula: 'Febrero', 'Marzo', 'Abril', etc.
    * Usa WHERE nombre_mes = 'Febrero' (capitalizado) - SIEMPRE usa nombre_mes con primera letra mayúscula, NO el campo numérico 'mes'
    * SIEMPRE incluye fecha_vencimiento, monto_esperado, monto_pagado y monto_pendiente en el SELECT
    * SIEMPRE haz FROM pagos_mensuales pm y JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
    * SIEMPRE calcula monto_pagado sumando pagos_realizados: COALESCE(SUM(pr.monto), 0) as monto_pagado
    * SIEMPRE calcula monto_pendiente: (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) as monto_pendiente
    * SIEMPRE incluye GROUP BY con todos los campos no agregados (pm.id, pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, pm.estado)
    * CRÍTICO: En pagos_realizados, el campo 'mes' es VARCHAR con el nombre del mes (ej: 'febrero'), NO es numérico
    * CRÍTICO: En pagos_mensuales, el campo 'mes' es INT (2=febrero) y 'nombre_mes' es VARCHAR ('febrero')
    * CRÍTICO: Para hacer JOIN correcto, debes comparar pr.mes (VARCHAR) con pm.nombre_mes (VARCHAR), NO con pm.mes (INT)
    * CRÍTICO: Si la pregunta es "cuanto debo del mes de febrero" o "cuanto debo de febrero", el usuario quiere saber el monto_pendiente de ese mes específico
    * Ejemplo completo OBLIGATORIO para preguntas sobre meses específicos: SELECT pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, COALESCE(SUM(pr.monto), 0) as monto_pagado, (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) as monto_pendiente, pm.estado FROM pagos_mensuales pm JOIN compromiso_economico ce ON pm.id_compromiso = ce.id LEFT JOIN pagos_realizados pr ON pr.id_compromiso = ce.id AND pr.mes = pm.nombre_mes WHERE ce.id_estudiante IN (lista_de_ids) AND pm.nombre_mes = 'Febrero' GROUP BY pm.id, pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, pm.estado
    * NOTA: Los meses en nombre_mes están capitalizados: 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
- Si el usuario pregunta sobre "mi hija", "mi hijo", "mis pagos", "mis mensualidades", etc., y hay INFORMACIÓN CRÍTICA DEL REMITENTE arriba:
  * DEBES usar los IDs de estudiantes proporcionados en esa sección
  * Filtra por id_estudiante IN (lista de IDs) en compromiso_economico
  * Ejemplo: SELECT pm.nombre_mes, pm.monto_esperado, pm.monto_pagado, pm.monto_pendiente, pm.estado, pm.fecha_vencimiento FROM pagos_mensuales pm JOIN compromiso_economico ce ON pm.id_compromiso = ce.id WHERE ce.id_estudiante IN (lista_de_ids)
- Si necesitas unir tablas, usa las relaciones (Foreign Keys) indicadas en el esquema.
- Para fechas actuales, usa funciones MySQL: YEAR(CURDATE()), MONTH(CURDATE()), CURDATE().
- Si pregunta por meses, usa la columna 'mes' (1-12) o 'nombre_mes' según corresponda.
- Para conteos, usa COUNT(*). Para sumas, usa SUM(columna).
- Si la pregunta dice 'este año', usa WHERE gestion_academica = YEAR(CURDATE()) o WHERE anio = YEAR(CURDATE()).
- Si la pregunta dice 'este mes', usa WHERE YEAR(fecha) = YEAR(CURDATE()) AND MONTH(fecha) = MONTH(CURDATE()).
- Si pregunta "cuáles pagó" o "cuáles le falta", muestra los meses con su estado y monto.
- NUNCA generes consultas vacías o incompletas. SIEMPRE incluye SELECT, FROM y al menos un JOIN si es necesario.
- Si no puedes generar una consulta válida, responde solo con: "ERROR: No se puede generar consulta"

SQL:`;

      let sqlGenerado = null;
      try {
        sqlGenerado = await llamarGemini(promptSQL, 200);
      } catch (geminiError) {
        if (esErrorCuotaGemini(geminiError)) {
          console.warn(
            "⚠️ Gemini sin cuota para generar SQL. Se usará SQL de respaldo.",
          );
          sqlGenerado = null; // Forzar construcción de SQL de respaldo local
        } else {
          throw geminiError;
        }
      }

      // Limpiar SQL
      sqlGenerado = sqlGenerado
        .replace(/```sql/g, "")
        .replace(/```/g, "")
        .trim();

      // Extraer solo la consulta SQL (eliminar explicaciones antes o después)
      const sqlMatch = sqlGenerado.match(/(SELECT[\s\S]*?)(?:;|$)/i);
      if (sqlMatch) {
        sqlGenerado = sqlMatch[1].trim();
      } else if (sqlGenerado.toLowerCase().startsWith("select")) {
        sqlGenerado = sqlGenerado.split(";")[0].trim();
      } else {
        // Si no hay SQL válido, intentar generar SQL de respaldo si es pregunta de pagos
        console.log(
          "⚠️ No se encontró SQL válido. Intentando SQL de respaldo...",
        );
        sqlGenerado = null; // Marcar como inválido para que se genere el SQL de respaldo
      }

      // Validar que el SQL no esté vacío y sea seguro (solo SELECT)
      if (!sqlGenerado || sqlGenerado.length < 10) {
        console.log(
          "⚠️ SQL generado está vacío o es muy corto. Intentando SQL de respaldo...",
        );
        sqlGenerado = null; // Marcar como inválido para que se genere el SQL de respaldo
      }

      if (
        sqlGenerado &&
        !sqlGenerado.trim().toUpperCase().startsWith("SELECT")
      ) {
        console.log(
          "⚠️ SQL generado no comienza con SELECT. Intentando SQL de respaldo...",
        );
        sqlGenerado = null; // Marcar como inválido para que se genere el SQL de respaldo
      }

      // Validar que el SQL incluya FROM (crítico para evitar errores)
      // Si sqlGenerado es null, también generar SQL de respaldo
      const sqlUpper = sqlGenerado ? sqlGenerado.toUpperCase() : "";
      let sqlIncompleto =
        !sqlGenerado ||
        !sqlUpper.includes("FROM") ||
        sqlGenerado.trim().length < 50;
      // Si el padre preguntó por "mis hijos" y hay varios: el SQL DEBE traer id_estudiante para separar por hijo
      if (
        !sqlIncompleto &&
        sqlGenerado &&
        preguntaPorTodosLosHijos &&
        estudiantesRelacionados.length > 1
      ) {
        const mencionaPagosEnPregunta =
          /\b(cuota|pago|mensualidad|cuanto\s+debo|debo\s+del|debo\s+de)\b/i.test(
            pregunta,
          );
        const sqlTraeIdEstudiante =
          /id_estudiante|e\.id\s+FROM|SELECT\s+.*\be\.id\b/i.test(sqlGenerado);
        if (mencionaPagosEnPregunta && !sqlTraeIdEstudiante) {
          console.log(
            "🔄 SQL sin id_estudiante con múltiples hijos: forzando SQL de respaldo para separar por estudiante.",
          );
          sqlGenerado = null;
          sqlIncompleto = true;
        }
      }

      if (sqlIncompleto) {
        console.error(
          "❌ SQL generado está incompleto o no incluye FROM:",
          sqlGenerado,
        );
        console.log(
          `📋 Estudiantes relacionados: ${estudiantesRelacionados.length}`,
        );
        console.log(`📋 Info remitente: ${infoRemitente ? "Sí" : "No"}`);

        // Si es una pregunta sobre pagos y hay estudiantes relacionados, generar SQL de respaldo
        const preguntaLower = pregunta.toLowerCase();
        const mencionaPagos =
          preguntaLower.includes("cuota") ||
          preguntaLower.includes("mensualidad") ||
          preguntaLower.includes("pago") ||
          preguntaLower.includes("vencimiento") ||
          preguntaLower.includes("cuanto debo") ||
          preguntaLower.includes("cuánto debo") ||
          preguntaLower.includes("debo del mes") ||
          preguntaLower.includes("debo de") ||
          preguntaLower.includes("cuanto debe") ||
          preguntaLower.includes("cuánto debe");

        console.log(`🔍 Menciona pagos: ${mencionaPagos}`);
        console.log(
          `🔍 Estudiantes relacionados disponibles: ${estudiantesRelacionados.length > 0}`,
        );

        if (estudiantesRelacionados.length > 0 && mencionaPagos) {
          console.log(
            "🔄 Generando SQL de respaldo para pregunta sobre pagos...",
          );

          // Normalizar errores ortográficos en nombres de meses (ej. "marsso" -> "marzo")
          const { preguntaNormalizada, mesCorregido } =
            normalizarMesesEnPregunta(pregunta);
          const preguntaParaMeses = preguntaNormalizada || pregunta;
          mesCorregidoPregunta = mesCorregido || null;
          preguntaNormalizadaParaFormato = preguntaParaMeses;
          if (mesCorregidoPregunta) {
            console.log(
              `📝 Mes corregido en pregunta: "${mesCorregidoPregunta}" (para mostrar en respuesta)`,
            );
          }

          // Detectar mes(es) específico(s) - mejorado para detectar múltiples meses
          // Ejemplo: "cuanto debo del mes de junio, julio, agosto"
          const mesesRegex =
            /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi;
          const mesesEncontrados = preguntaParaMeses.match(mesesRegex);
          const mesesCapitalizados = mesesEncontrados
            ? mesesEncontrados.map(
                (m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase(),
              )
            : null;

          // Para compatibilidad con código existente, mantener mesEspecifico y mesCapitalizado
          const mesEspecifico =
            mesesCapitalizados && mesesCapitalizados.length === 1
              ? mesesCapitalizados[0].toLowerCase()
              : null;
          const mesCapitalizado =
            mesesCapitalizados && mesesCapitalizados.length === 1
              ? mesesCapitalizados[0]
              : null;

          const idsEstudiantes = estudiantesRelacionados
            .map((e) => e.id)
            .join(", ");

          console.log(
            `📅 Mes(es) detectado(s): ${mesesCapitalizados ? mesesCapitalizados.join(", ") : "ninguno"}`,
          );
          console.log(`👥 IDs estudiantes: ${idsEstudiantes}`);

          // Soporte "mis hijos X y Y": si el padre mencionó varios nombres, usar IN(id1, id2, ...).
          // Si preguntó por "mis hijos" / "cuota de febrero de mis hijos" (plural), dar info de TODOS.
          const usarVariosHijos =
            estudiantesRelacionados.length > 1 &&
            (nombresHijosMencionados.length >= 1 || preguntaPorTodosLosHijos);

          const estudianteIdUnico =
            estudiantesRelacionados.length === 1
              ? estudiantesRelacionados[0].id
              : estudiantesRelacionados.length > 0
                ? estudiantesRelacionados[0].id
                : null;

          if (!estudianteIdUnico && !usarVariosHijos) {
            throw new Error(
              "No se encontró estudiante relacionado con tu número de teléfono.",
            );
          }

          const whereEstudiantes = usarVariosHijos
            ? `ce.id_estudiante IN (${idsEstudiantes})`
            : `ce.id_estudiante = ${estudianteIdUnico}`;
          console.log(
            `👤 Usando estudiantes: ${usarVariosHijos ? `IN (${idsEstudiantes})` : estudianteIdUnico} (${estudiantesRelacionados.length} relacionado(s), nombres mencionados: ${nombresHijosMencionados.length})`,
          );

          if (mesesCapitalizados && mesesCapitalizados.length > 0) {
            const mesesSQL = mesesCapitalizados.map((m) => `'${m}'`).join(", ");
            sqlGenerado = `SELECT pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, COALESCE(SUM(pr.monto), 0) as monto_pagado, (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) as monto_pendiente, pm.estado, ce.id_estudiante FROM pagos_mensuales pm JOIN compromiso_economico ce ON pm.id_compromiso = ce.id LEFT JOIN pagos_realizados pr ON pr.id_compromiso = ce.id AND pr.mes = pm.nombre_mes WHERE ${whereEstudiantes} AND pm.nombre_mes IN (${mesesSQL}) GROUP BY pm.id, pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, pm.estado, ce.id_estudiante ORDER BY ce.id_estudiante, FIELD(pm.nombre_mes, ${mesesSQL})`;
          } else {
            sqlGenerado = `SELECT pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, COALESCE(SUM(pr.monto), 0) as monto_pagado, (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) as monto_pendiente, pm.estado, ce.id_estudiante FROM pagos_mensuales pm JOIN compromiso_economico ce ON pm.id_compromiso = ce.id LEFT JOIN pagos_realizados pr ON pr.id_compromiso = ce.id AND pr.mes = pm.nombre_mes WHERE ${whereEstudiantes} GROUP BY pm.id, pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, pm.estado, ce.id_estudiante ORDER BY ce.id_estudiante, pm.nombre_mes`;
          }
          console.log(`✅ SQL de respaldo generado: ${sqlGenerado}`);
        } else {
          // Si no hay estudiantes relacionados pero hay infoRemitente, intentar buscar estudiantes primero
          if (
            infoRemitente &&
            mencionaPagos &&
            estudiantesRelacionados.length === 0
          ) {
            console.log(
              "⚠️ No hay estudiantes relacionados pero hay infoRemitente. Intentando buscar estudiantes...",
            );
            // El código ya debería haber buscado estudiantes arriba, pero si no los encontró, lanzar error más descriptivo
            throw new Error(
              "No se encontraron estudiantes relacionados con tu número de teléfono. Por favor, verifica que tu número esté registrado correctamente en el sistema.",
            );
          } else {
            throw new Error(
              "La consulta SQL generada está incompleta. Debe incluir FROM y las tablas necesarias.",
            );
          }
        }
      }

      // Si el SQL usa "IN (SELECT id FROM ESTUDIANTES)" sin filtro, reemplazar por los estudiantes del padre
      if (
        sqlGenerado &&
        (sqlGenerado.includes("IN (SELECT id FROM ESTUDIANTES)") ||
          sqlGenerado.includes("IN (SELECT id FROM estudiantes)") ||
          sqlGenerado.includes("IN (SELECT id FROM `estudiantes`)"))
      ) {
        console.error(
          "❌ DETECTADO SQL que selecciona TODOS los estudiantes sin filtro",
        );
        if (estudiantesRelacionados.length > 0) {
          const usarvarios =
            estudiantesRelacionados.length > 1 &&
            nombresHijosMencionados.length >= 1;
          const idsJoin = estudiantesRelacionados.map((e) => e.id).join(", ");
          const reemplazo = usarvarios
            ? `IN (${idsJoin})`
            : `= ${estudiantesRelacionados[0].id}`;
          console.log(
            `🔧 Reemplazando por estudiantes: ${reemplazo} (${estudiantesRelacionados.length} relacionado(s))`,
          );

          sqlGenerado = sqlGenerado.replace(
            /IN\s*\(\s*SELECT\s+id\s+FROM\s+(?:ESTUDIANTES|estudiantes|`estudiantes`)\s*\)/gi,
            reemplazo,
          );
          console.log(`✅ SQL corregido: ${sqlGenerado}`);
        } else {
          throw new Error(
            "No se encontraron estudiantes relacionados con tu número de teléfono. El SQL intentó seleccionar todos los estudiantes, lo cual no está permitido para consultas de pagos personales.",
          );
        }
      }

      // Si hay múltiples estudiantes y el SQL usa IN(): mantener IN cuando el padre
      // mencionó varios hijos por nombre ("mis hijos X y Y") o preguntó por "mis hijos" (todos).
      const usarVariosHijosOverride =
        estudiantesRelacionados.length > 1 &&
        (nombresHijosMencionados.length >= 1 || preguntaPorTodosLosHijos);
      if (
        estudiantesRelacionados.length > 1 &&
        !usarVariosHijosOverride &&
        sqlGenerado.includes("IN (")
      ) {
        const estudianteIdUnicoOverride = estudiantesRelacionados[0].id;
        console.log(
          `⚠️ Múltiples estudiantes (${estudiantesRelacionados.length}), sin nombres mencionados. Filtrando SQL para usar solo ID: ${estudianteIdUnicoOverride}`,
        );

        const patronIN = /IN\s*\([^)]+\)/gi;
        if (patronIN.test(sqlGenerado)) {
          sqlGenerado = sqlGenerado.replace(
            patronIN,
            `= ${estudianteIdUnicoOverride}`,
          );
          console.log(
            `🔍 SQL modificado para un solo estudiante: ${sqlGenerado}`,
          );
        }
      }

      // Si el usuario pide "cuotas vencidas", no depender de pm.estado='vencido' (puede no estar actualizado).
      // Usar la misma lógica del recordatorio: fecha_vencimiento < hoy y saldo pendiente > 0.
      const preguntaLowerVencidas = String(pregunta || "").toLowerCase();
      const preguntaNormalizadaVencidas = normalizarTextoComparacion(
        pregunta || "",
      );
      const esConsultaVencidas =
        /(vencid[oa]s?|atrasad[oa]s?|en mora|moros[oa]s?)/i.test(
          preguntaNormalizadaVencidas,
        ) &&
        /(detalle|detalles|mostrar|muestr|cual|cuales|ver|cuota|cuotas|pago|pagos)/i.test(
          preguntaNormalizadaVencidas,
        );

      if (esConsultaVencidas && estudiantesRelacionados.length > 0) {
        const usarVariosHijosVencidas =
          estudiantesRelacionados.length > 1 &&
          (nombresHijosMencionados.length >= 1 || preguntaPorTodosLosHijos);
        const idsEstudiantesVencidas = estudiantesRelacionados
          .map((e) => e.id)
          .join(", ");
        const whereEstudiantesVencidas = usarVariosHijosVencidas
          ? `ce.id_estudiante IN (${idsEstudiantesVencidas})`
          : `ce.id_estudiante = ${estudiantesRelacionados[0].id}`;

        sqlGenerado = `SELECT pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, COALESCE(SUM(pr.monto), 0) as monto_pagado, (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) as monto_pendiente, pm.estado, ce.id_estudiante FROM pagos_mensuales pm JOIN compromiso_economico ce ON pm.id_compromiso = ce.id LEFT JOIN pagos_realizados pr ON pr.id_compromiso = ce.id AND pr.mes = pm.nombre_mes WHERE ${whereEstudiantesVencidas} AND pm.fecha_vencimiento < CURDATE() AND (pm.estado IN ('pendiente', 'parcial', 'vencido') OR pm.estado IS NULL) GROUP BY pm.id, pm.nombre_mes, pm.fecha_vencimiento, pm.monto_esperado, pm.estado, ce.id_estudiante HAVING (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) > 0 ORDER BY ce.id_estudiante, pm.fecha_vencimiento ASC`;
        console.log(
          "🔄 SQL forzado para detalle de cuotas vencidas:",
          sqlGenerado,
        );
      }

      // Autocorrección: evitar "Invalid use of group function" cuando la IA mete SUM(...) en WHERE.
      const condicionSaldoPendiente = `(pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) > 0`;
      if (
        sqlGenerado &&
        sqlGenerado.includes(condicionSaldoPendiente) &&
        /\bwhere\b/i.test(sqlGenerado)
      ) {
        const whereConAgregado = new RegExp(
          `\\s+AND\\s+\\(${condicionSaldoPendiente.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
          "i",
        );
        if (whereConAgregado.test(sqlGenerado)) {
          sqlGenerado = sqlGenerado.replace(whereConAgregado, "");
          if (!/\bHAVING\b/i.test(sqlGenerado)) {
            if (/\bORDER BY\b/i.test(sqlGenerado)) {
              sqlGenerado = sqlGenerado.replace(
                /\bORDER BY\b/i,
                ` HAVING ${condicionSaldoPendiente} ORDER BY`,
              );
            } else {
              sqlGenerado = `${sqlGenerado} HAVING ${condicionSaldoPendiente}`;
            }
          }
          console.log(
            "🩹 SQL corregido automáticamente (SUM en WHERE -> HAVING).",
          );
        }
      }

      // Ejecutar SQL con manejo de errores mejorado
      let resultados;
      try {
        console.log(`🔍 SQL generado: ${sqlGenerado}`);
        [resultados] = await this.pool.query(sqlGenerado);
        console.log(
          `✅ SQL ejecutado exitosamente. Resultados: ${resultados.length} fila(s)`,
        );
        if (resultados.length > 0) {
          console.log(
            `📊 Primer resultado:`,
            JSON.stringify(resultados[0], null, 2),
          );
        }
      } catch (sqlError) {
        console.error("❌ Error SQL generado:", sqlGenerado);
        console.error("❌ Error SQL:", sqlError.message);
        // Si hay error SQL, intentar responder desde el reglamento como fallback
        throw new Error(
          `Error en la consulta: ${sqlError.message}. Por favor, reformula tu pregunta de manera más específica.`,
        );
      }

      if (!resultados || resultados.length === 0) {
        console.log(
          `⚠️ No se encontraron resultados para la consulta SQL: ${sqlGenerado}`,
        );
        console.log(
          `📋 Info remitente disponible: ${infoRemitente ? "Sí" : "No"}`,
        );
        console.log(
          `📋 Estudiantes relacionados: ${estudiantesRelacionados.length}`,
        );
        if (estudiantesRelacionados.length > 0) {
          console.log(
            `📋 IDs de estudiantes: ${estudiantesRelacionados.map((e) => e.id).join(", ")}`,
          );
        }

        // Si es una pregunta sobre pagos y hay estudiantes relacionados, dar mensaje más útil
        const preguntaLower = pregunta.toLowerCase();
        const esPreguntaPagos =
          preguntaLower.includes("cuanto debo") ||
          preguntaLower.includes("cuánto debo") ||
          preguntaLower.includes("pago") ||
          preguntaLower.includes("cuota") ||
          preguntaLower.includes("mensualidad");
        const esPreguntaVencidas =
          /(vencid[oa]s?|atrasad[oa]s?|en mora|moros[oa]s?)/i.test(pregunta);

        if (esPreguntaVencidas && estudiantesRelacionados.length > 0) {
          return (
            `No encontré cuotas vencidas con saldo pendiente para este estudiante en este momento.\n\n` +
            `Si hace un momento el sistema mostró un recordatorio, puede que los datos se estén actualizando o que esa alerta corresponda a otro período. ` +
            `¿Quieres que te muestre todas las cuotas pendientes para revisar una por una?`
          );
        }

        if (esPreguntaPagos && estudiantesRelacionados.length > 0) {
          return (
            `No se encontraron registros de pagos mensuales para los estudiantes relacionados con tu número. Esto puede deberse a que:\n\n` +
            `• Aún no se ha creado el compromiso económico para este año\n` +
            `• No hay pagos mensuales registrados para el mes consultado\n` +
            `• Los datos aún están en proceso de registro\n\n` +
            `Por favor, contacta con la Secretaría para verificar el estado de las cuotas.`
          );
        }

        return "No se encontraron resultados para tu consulta.";
      }

      // Formatear respuesta de manera más clara
      if (resultados.length === 1 && Object.keys(resultados[0]).length === 1) {
        const preguntaLowerSimple = String(pregunta || "").toLowerCase();
        const esConsultaInscripcionPrecio =
          /(inscrip|inscrib|matr[ií]cul|precio|costo|cu[aá]nto\s+cuesta|cuanto\s+cuesta|valor)/i.test(
            preguntaLowerSimple,
          ) &&
          /(kinder|pre[\s-]?kinder|inicial|primaria|secundaria|nivel|curso)/i.test(
            preguntaLowerSimple,
          );

        // Mejorar respuesta para consultas comerciales de inscripción:
        // en lugar de devolver solo "4000.00", devolver ficha resumida del nivel.
        if (esConsultaInscripcionPrecio) {
          let nivelBuscado = null;
          if (/pre[\s-]?kinder/i.test(preguntaLowerSimple))
            nivelBuscado = "prekinder";
          else if (/kinder/i.test(preguntaLowerSimple)) nivelBuscado = "kinder";
          else if (/inicial/i.test(preguntaLowerSimple))
            nivelBuscado = "inicial";
          else if (/primaria/i.test(preguntaLowerSimple))
            nivelBuscado = "primaria";
          else if (/secundaria/i.test(preguntaLowerSimple))
            nivelBuscado = "secundaria";
          // Niveles numéricos: "primer nivel", "segundo nivel", "1er nivel", etc.
          else if (
            /primer\s+nivel|1er\s+nivel|1°\s*nivel|nivel\s+1\b/i.test(
              preguntaLowerSimple,
            )
          )
            nivelBuscado = "primer nivel";
          else if (
            /segundo\s+nivel|2do\s+nivel|2°\s*nivel|nivel\s+2\b/i.test(
              preguntaLowerSimple,
            )
          )
            nivelBuscado = "segundo nivel";
          else if (
            /tercer\s+nivel|tercero\s+nivel|3er\s+nivel|3°\s*nivel|nivel\s+3\b/i.test(
              preguntaLowerSimple,
            )
          )
            nivelBuscado = "tercer nivel";
          else if (
            /cuarto\s+nivel|4to\s+nivel|4°\s*nivel|nivel\s+4\b/i.test(
              preguntaLowerSimple,
            )
          )
            nivelBuscado = "cuarto nivel";
          else if (
            /quinto\s+nivel|5to\s+nivel|5°\s*nivel|nivel\s+5\b/i.test(
              preguntaLowerSimple,
            )
          )
            nivelBuscado = "quinto nivel";
          else if (
            /sexto\s+nivel|6to\s+nivel|6°\s*nivel|nivel\s+6\b/i.test(
              preguntaLowerSimple,
            )
          )
            nivelBuscado = "sexto nivel";

          if (nivelBuscado) {
            try {
              let detalleNivel = [];
              try {
                [detalleNivel] = await this.pool.query(
                  `SELECT
                     n.id,
                     n.nombre,
                     n.descripcion,
                     n.precio,
                     n.meses,
                     MIN(c.hora_inicio) AS hora_entrada,
                     MIN(c.hora_fin) AS hora_salida,
                     MIN(c.turno) AS turno_ref,
                     COUNT(c.id) AS total_cursos
                   FROM nivel n
                   LEFT JOIN curso c ON c.nivel_id = n.id
                   WHERE LOWER(REPLACE(n.nombre, ' ', '')) LIKE ?
                   GROUP BY n.id, n.nombre, n.descripcion, n.precio, n.meses
                   ORDER BY n.id ASC
                   LIMIT 1`,
                  [`%${nivelBuscado.replace(/\s+/g, "")}%`],
                );
              } catch (_) {
                // Compatibilidad con esquemas donde nivel no tiene hora_entrada/hora_salida.
                [detalleNivel] = await this.pool.query(
                  `SELECT
                     n.id,
                     n.nombre,
                     n.descripcion,
                     n.precio,
                     n.meses,
                     MIN(c.hora_inicio) AS hora_entrada,
                     MIN(c.hora_fin) AS hora_salida,
                     MIN(c.turno) AS turno_ref,
                     COUNT(c.id) AS total_cursos
                   FROM nivel n
                   LEFT JOIN curso c ON c.nivel_id = n.id
                   WHERE LOWER(REPLACE(n.nombre, ' ', '')) LIKE ?
                   GROUP BY n.id, n.nombre, n.descripcion, n.precio, n.meses
                   ORDER BY n.id ASC
                   LIMIT 1`,
                  [`%${nivelBuscado.replace(/\s+/g, "")}%`],
                );
              }

              if (detalleNivel && detalleNivel.length > 0) {
                const n = detalleNivel[0];
                const precio =
                  parseFloat(
                    n.precio || Object.values(resultados[0])[0] || 0,
                  ) || 0;
                let mesesArr = [];
                try {
                  if (n.meses) mesesArr = JSON.parse(n.meses);
                } catch (_) {
                  mesesArr = [];
                }
                const duracion = Array.isArray(mesesArr) ? mesesArr.length : 0;
                const cursos = Number(n.total_cursos || 0);
                const horaEntrada = n.hora_entrada
                  ? String(n.hora_entrada).slice(0, 5)
                  : null;
                const horaSalida = n.hora_salida
                  ? String(n.hora_salida).slice(0, 5)
                  : null;
                const nombreNivel = n.nombre || nivelBuscado.toUpperCase();

                let saludoCorto = "Con gusto";
                if (infoRemitente?.nombre_padre)
                  saludoCorto = `Claro Sr. ${infoRemitente.nombre_padre}`;
                else if (infoRemitente?.nombre_madre)
                  saludoCorto = `Claro Sra. ${infoRemitente.nombre_madre}`;

                let respuestaNivel = `${saludoCorto}, contamos con el nivel *${nombreNivel}*.\n\n`;
                if (n.descripcion) {
                  respuestaNivel += `📘 *Descripción:* ${n.descripcion}\n`;
                }
                if (duracion > 0) {
                  respuestaNivel += `📅 *Duración:* ${duracion} mes(es)\n`;
                }
                if (horaEntrada || horaSalida) {
                  if (horaEntrada && horaSalida) {
                    respuestaNivel += `🕒 *Horario referencial:* ${horaEntrada} - ${horaSalida}\n`;
                  } else if (horaEntrada) {
                    respuestaNivel += `🕒 *Hora de entrada:* ${horaEntrada}\n`;
                  } else if (horaSalida) {
                    respuestaNivel += `🕒 *Hora de salida:* ${horaSalida}\n`;
                  }
                }
                if (cursos > 0) {
                  respuestaNivel += `🏫 *Cursos disponibles:* ${cursos}\n`;
                }
                respuestaNivel += `💰 *Precio:* Bs. ${precio.toFixed(2)}\n\n`;
                respuestaNivel += `Si desea, también le indico los *requisitos de inscripción*.`;
                return respuestaNivel.trim();
              }
            } catch (detalleErr) {
              console.warn(
                "⚠️ No se pudo construir respuesta detallada de nivel:",
                detalleErr.message,
              );
            }
          }
        }

        const valor = Object.values(resultados[0])[0];
        return `**${valor}**`;
      }

      // Si es consulta de costos/horarios por nivel (externos), formatear como ficha humana
      const preguntaLowerFormato = String(pregunta || "").toLowerCase();
      const pareceConsultaNivelInformativa =
        /(precio|costo|cu[aá]nto\s+cuesta|cuanto\s+cuesta|arancel|mensualidad|horario|hora de entrada|hora de salida|turno|informaci[oó]n|cat[aá]logo|niveles|qu[eé]\s+ofrecen|qu[eé]\s+tienen)/i.test(
          preguntaLowerFormato,
        ) &&
        /(kinder|pre[\s-]?kinder|inicial|primaria|secundaria|nivel|curso|primer|segundo|tercer|cuarto|quinto|sexto)/i.test(
          preguntaLowerFormato,
        );

      const tieneCamposNivelEnResultado =
        resultados.length > 0 &&
        ("precio" in resultados[0] ||
          "hora_entrada" in resultados[0] ||
          "hora_salida" in resultados[0] ||
          "descripcion" in resultados[0] ||
          "meses" in resultados[0] ||
          "nivel_nombre" in resultados[0] ||
          "nombre" in resultados[0]);

      // Respuesta tipo catálogo: cuando hay múltiples niveles en los resultados
      const esConsultaCatalogo =
        pareceConsultaNivelInformativa &&
        resultados.length > 1 &&
        tieneCamposNivelEnResultado;
      if (esConsultaCatalogo) {
        let respuestaCatalogo =
          "📚 *Catálogo de Niveles - Unidad Educativa EMI*\n\n";
        for (const row of resultados) {
          const nombre = row.nombre || row.nivel_nombre || "";
          const descripcion = row.descripcion || "";
          const precio = parseFloat(row.precio || 0);
          let duracion = 0;
          try {
            duracion = JSON.parse(row.meses || "[]").length;
          } catch (_) {}
          const turno = row.turno || row.turno_ref || "";
          const horaInicio = row.hora_inicio
            ? String(row.hora_inicio).slice(0, 5)
            : row.hora_entrada
              ? String(row.hora_entrada).slice(0, 5)
              : null;
          const horaFin = row.hora_fin
            ? String(row.hora_fin).slice(0, 5)
            : row.hora_salida
              ? String(row.hora_salida).slice(0, 5)
              : null;
          respuestaCatalogo += `📌 *${nombre}*\n`;
          if (descripcion)
            respuestaCatalogo += `   👶 Edades: ${descripcion}\n`;
          if (duracion > 0)
            respuestaCatalogo += `   📅 Duración: ${duracion} meses\n`;
          if (turno) respuestaCatalogo += `   🌅 Turno: ${turno}\n`;
          if (horaInicio && horaFin)
            respuestaCatalogo += `   🕒 Horario: ${horaInicio} - ${horaFin}\n`;
          if (precio > 0)
            respuestaCatalogo += `   💰 Precio: Bs. ${precio.toFixed(2)}\n`;
          respuestaCatalogo += "\n";
        }
        respuestaCatalogo +=
          "¿Le gustaría saber sobre los *requisitos de inscripción* o las *becas disponibles*?";
        return respuestaCatalogo.trim();
      }

      if (pareceConsultaNivelInformativa && tieneCamposNivelEnResultado) {
        let nivelDetectado = null;
        if (/pre[\s-]?kinder/i.test(preguntaLowerFormato))
          nivelDetectado = "prekinder";
        else if (/kinder/i.test(preguntaLowerFormato))
          nivelDetectado = "kinder";
        else if (/inicial/i.test(preguntaLowerFormato))
          nivelDetectado = "inicial";
        else if (/primaria/i.test(preguntaLowerFormato))
          nivelDetectado = "primaria";
        else if (/secundaria/i.test(preguntaLowerFormato))
          nivelDetectado = "secundaria";
        else if (
          /primer\s+nivel|1er\s+nivel|1°\s*nivel|nivel\s+1\b/i.test(
            preguntaLowerFormato,
          )
        )
          nivelDetectado = "primer nivel";
        else if (
          /segundo\s+nivel|2do\s+nivel|2°\s*nivel|nivel\s+2\b/i.test(
            preguntaLowerFormato,
          )
        )
          nivelDetectado = "segundo nivel";
        else if (
          /tercer\s+nivel|3er\s+nivel|3°\s*nivel|nivel\s+3\b/i.test(
            preguntaLowerFormato,
          )
        )
          nivelDetectado = "tercer nivel";
        else if (
          /cuarto\s+nivel|4to\s+nivel|4°\s*nivel|nivel\s+4\b/i.test(
            preguntaLowerFormato,
          )
        )
          nivelDetectado = "cuarto nivel";
        else if (
          /quinto\s+nivel|5to\s+nivel|5°\s*nivel|nivel\s+5\b/i.test(
            preguntaLowerFormato,
          )
        )
          nivelDetectado = "quinto nivel";
        else if (
          /sexto\s+nivel|6to\s+nivel|6°\s*nivel|nivel\s+6\b/i.test(
            preguntaLowerFormato,
          )
        )
          nivelDetectado = "sexto nivel";

        let detalleNivel = resultados[0];

        // Si el SQL vino incompleto (ej: solo precio/hora_entrada), completar con datos de nivel.
        const faltanDatosClave =
          !detalleNivel.descripcion ||
          !detalleNivel.meses ||
          !detalleNivel.nombre;
        if (nivelDetectado && faltanDatosClave) {
          try {
            let rowsNivel = [];
            try {
              [rowsNivel] = await this.pool.query(
                `SELECT
                   n.nombre,
                   n.descripcion,
                   n.precio,
                   n.meses,
                   MIN(c.hora_inicio) AS hora_entrada,
                   MIN(c.hora_fin) AS hora_salida,
                   MIN(c.turno) AS turno_ref
                 FROM nivel n
                 LEFT JOIN curso c ON c.nivel_id = n.id
                 WHERE LOWER(REPLACE(n.nombre, ' ', '')) LIKE ?
                 GROUP BY n.nombre, n.descripcion, n.precio, n.meses
                 ORDER BY n.id ASC
                 LIMIT 1`,
                [`%${nivelDetectado.replace(/\s+/g, "")}%`],
              );
            } catch (_) {
              [rowsNivel] = await this.pool.query(
                `SELECT
                   n.nombre,
                   n.descripcion,
                   n.precio,
                   n.meses
                 FROM nivel n
                 WHERE LOWER(REPLACE(n.nombre, ' ', '')) LIKE ?
                 ORDER BY n.id ASC
                 LIMIT 1`,
                [`%${nivelDetectado.replace(/\s+/g, "")}%`],
              );
            }
            if (rowsNivel && rowsNivel.length > 0) {
              const nivelBD = rowsNivel[0] || {};
              // Preferir datos ya obtenidos en el SQL original solo si NO son nulos.
              // Evita pisar un horario válido de "nivel" con null.
              detalleNivel = {
                ...nivelBD,
                ...detalleNivel,
                nombre: detalleNivel.nombre ?? nivelBD.nombre,
                descripcion: detalleNivel.descripcion ?? nivelBD.descripcion,
                precio: detalleNivel.precio ?? nivelBD.precio,
                meses: detalleNivel.meses ?? nivelBD.meses,
                hora_entrada: detalleNivel.hora_entrada ?? nivelBD.hora_entrada,
                hora_salida: detalleNivel.hora_salida ?? nivelBD.hora_salida,
              };
            }
          } catch (errNivel) {
            console.warn(
              "⚠️ No se pudo completar detalle de nivel para formato informativo:",
              errNivel.message,
            );
          }
        }

        const nombreNivel = (
          detalleNivel.nombre ||
          detalleNivel.nivel_nombre ||
          (nivelDetectado ? nivelDetectado.toUpperCase() : "este nivel")
        )
          .toString()
          .toUpperCase();
        const descripcion = detalleNivel.descripcion
          ? String(detalleNivel.descripcion)
          : null;
        const precio = parseFloat(detalleNivel.precio || 0) || 0;

        let mesesCantidad = null;
        try {
          if (detalleNivel.meses) {
            const arrMeses = Array.isArray(detalleNivel.meses)
              ? detalleNivel.meses
              : JSON.parse(detalleNivel.meses);
            if (Array.isArray(arrMeses)) mesesCantidad = arrMeses.length;
          }
        } catch (_) {
          mesesCantidad = null;
        }

        const horaEntrada = detalleNivel.hora_entrada
          ? String(detalleNivel.hora_entrada).slice(0, 5)
          : null;
        const horaSalida = detalleNivel.hora_salida
          ? String(detalleNivel.hora_salida).slice(0, 5)
          : null;
        const preguntaPideHorario = /(hora|horario|entrada|salida|turno)/i.test(
          preguntaLowerFormato,
        );

        let respuestaNivel = `Claro, contamos con el nivel *${nombreNivel}*.\n`;
        if (descripcion) {
          respuestaNivel += `📘 Descripción: ${descripcion}\n`;
        }
        if (mesesCantidad != null) {
          respuestaNivel += `📅 Duración: ${mesesCantidad} mes(es)\n`;
        }
        if (horaEntrada || horaSalida) {
          if (horaEntrada && horaSalida)
            respuestaNivel += `🕒 Horario referencial: ${horaEntrada} - ${horaSalida}\n`;
          else if (horaEntrada)
            respuestaNivel += `🕒 Hora de entrada: ${horaEntrada}\n`;
          else if (horaSalida)
            respuestaNivel += `🕒 Hora de salida: ${horaSalida}\n`;
        } else if (preguntaPideHorario) {
          // Fallback institucional para consultas externas cuando no hay horas explícitas en BD.
          const turnoTexto = String(detalleNivel.turno || "").toLowerCase();
          const turnoNorm = turnoTexto
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
          if (turnoNorm.includes("manana")) {
            respuestaNivel += `🕒 Horario referencial (turno mañana): 08:00 - 12:30\n`;
          } else if (turnoNorm.includes("tarde")) {
            respuestaNivel += `🕒 Horario referencial (turno tarde): 14:00 - 18:30\n`;
          } else {
            respuestaNivel += `🕒 Horario referencial: turno mañana 08:00 - 12:30 / turno tarde 14:00 - 18:30\n`;
          }
        }
        respuestaNivel += `💰 Precio: Bs. ${precio.toFixed(2)}`;
        return respuestaNivel.trim();
      }

      // Si es información de pagos mensuales, formatear de manera especial
      if (resultados.length > 0 && resultados[0].nombre_mes) {
        // Fallback: si hay varias filas y varios hijos pero el SQL no trajo id_estudiante, asignar por orden
        if (
          resultados.length >= 2 &&
          estudiantesRelacionados.length >= 2 &&
          (resultados[0].id_estudiante == null ||
            resultados[0].id_estudiante === undefined)
        ) {
          resultados.forEach((r, i) => {
            if (i < estudiantesRelacionados.length)
              r.id_estudiante = estudiantesRelacionados[i].id;
          });
        }
        // Detectar si la pregunta es sobre un mes específico (respuesta más concisa)
        // Usar pregunta normalizada si hubo corrección ortográfica (ej. "marsso" -> "marzo")
        const preguntaParaFormato = preguntaNormalizadaParaFormato || pregunta;
        const preguntaLower = preguntaParaFormato.toLowerCase();
        const esPreguntaMesEspecifico =
          // "¿cuándo vence mayo?" / "vencimiento de mayo"
          /(cuándo vence|cuando vence|vencimiento).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
            preguntaParaFormato,
          ) ||
          /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*(cuándo vence|cuando vence|vencimiento)/i.test(
            preguntaParaFormato,
          ) ||
          // "¿cuándo debo pagar en mayo?" / "¿hasta cuándo puedo pagar mayo?"
          /((cuándo|cuando)\s+debo\s+pagar|(hasta\s+cu[aá]ndo\s+(puedo|debo)\s+pagar)).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
            preguntaParaFormato,
          ) ||
          /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*((cuándo|cuando)\s+debo\s+pagar|(hasta\s+cu[aá]ndo\s+(puedo|debo)\s+pagar))/i.test(
            preguntaParaFormato,
          );

        // Fallback: capturar variantes cortas tipo "cuando pagar mayo", "hasta cuando pagar en mayo"
        // (algunos usuarios omiten "debo" o reordenan palabras).
        const esPreguntaCuandoPagarMes =
          /((cuándo|cuando).*(pagar).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))/i.test(
            preguntaParaFormato,
          ) ||
          /((febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*(cuándo|cuando).*(pagar))/i.test(
            preguntaParaFormato,
          );

        const esPreguntaVencimientoOMesEspecifico =
          esPreguntaMesEspecifico || esPreguntaCuandoPagarMes;

        // Detectar si pregunta específicamente cuánto debe pagar en un mes.
        // Casos típicos:
        // - "¿cuánto debo pagar en mayo?"
        // - "¿cuánto tengo que pagar en mayo?"
        // - "¿cuánto debo de mayo?" / "¿cuánto debo del mes de mayo?"
        // - "¿cuánto hay que pagar en mayo?"
        // Nota: Esto controla el formato de respuesta (monto pendiente + detalles).
        const esPreguntaCuantoDeboMes =
          /(cuánto|cuanto)\s+(debo|tengo\s+que|hay\s+que)\s+(pagar\s+)?(del\s+mes\s+de|de|en)\s+(mes\s+de\s+)?(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
            preguntaParaFormato,
          );

        // Detectar si menciona múltiples meses
        const mesesRegex =
          /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi;
        const mesesMencionados = preguntaParaFormato.match(mesesRegex);
        const esPreguntaMultiplesMeses =
          mesesMencionados && mesesMencionados.length > 1;

        // Obtener información del estudiante y padre para personalizar (fuera del bloque if para que esté disponible en todo el scope)
        let nombreEstudiante = null;
        let nombrePadre = null;

        if (infoRemitente && estudiantesRelacionados.length > 0) {
          const estudiante = estudiantesRelacionados[0];
          nombreEstudiante =
            `${estudiante.nombre} ${estudiante.apellido_paterno || ""} ${estudiante.apellido_materno || ""}`.trim();

          if (infoRemitente.nombre_padre) {
            nombrePadre =
              `Sr. ${infoRemitente.nombre_padre} ${infoRemitente.apellido_padre || ""}`.trim();
          } else if (infoRemitente.nombre_madre) {
            nombrePadre =
              `Sra. ${infoRemitente.nombre_madre} ${infoRemitente.apellido_madre || ""}`.trim();
          } else if (infoRemitente.nombre_autorizado) {
            nombrePadre = infoRemitente.nombre_autorizado;
          }
        }

        const mapIdNombre = {};
        estudiantesRelacionados.forEach((e) => {
          const nombreCompleto =
            `${e.nombre} ${e.apellido_paterno || ""} ${e.apellido_materno || ""}`.trim();
          mapIdNombre[e.id] = nombreCompleto;
          mapIdNombre[String(e.id)] = nombreCompleto;
        });
        const idsUnicos = [
          ...new Set(resultados.map((r) => r.id_estudiante).filter(Boolean)),
        ];
        const porEstudiante = {};
        resultados.forEach((r) => {
          const id = r.id_estudiante;
          const idKey = typeof id === "number" ? id : Number(id);
          if (!porEstudiante[idKey]) porEstudiante[idKey] = [];
          porEstudiante[idKey].push(r);
        });
        // Orden: mismo orden que estudiantesRelacionados para que cada hijo quede bien identificado
        const idsEnResultados = estudiantesRelacionados
          .map((e) => e.id)
          .filter(
            (id) => idsUnicos.includes(id) || idsUnicos.includes(String(id)),
          );
        const idsFaltantes = idsUnicos.filter(
          (id) =>
            !idsEnResultados.includes(id) &&
            !idsEnResultados.includes(Number(id)),
        );
        idsEnResultados.push(...idsFaltantes);
        const multiplesEstudiantes = idsEnResultados.length > 1;

        let respuesta = "";

        const prefijoMesCorregido = mesCorregidoPregunta
          ? `_(Refiriéndose a *${mesCorregidoPregunta}*)_\n\n`
          : "";
        if (multiplesEstudiantes && nombrePadre) {
          respuesta = `${nombrePadre},\n\n`;
          respuesta += prefijoMesCorregido;
          respuesta += `A continuación la información de pagos *por cada uno de sus hijos*:\n\n`;
        } else if (nombrePadre && nombreEstudiante) {
          if (
            esPreguntaCuantoDeboMes &&
            !esPreguntaMultiplesMeses &&
            resultados.length === 1
          ) {
            respuesta = prefijoMesCorregido;
          } else if (esPreguntaMultiplesMeses) {
            respuesta = `${nombrePadre},\n\n`;
            respuesta += prefijoMesCorregido;
            respuesta += `Información de pagos de *${nombreEstudiante}* para los meses consultados:\n\n`;
          } else {
            respuesta = `${nombrePadre},\n\n`;
            respuesta += prefijoMesCorregido;
            respuesta += `Información de pagos de *${nombreEstudiante}*:\n\n`;
          }
        } else if (nombreEstudiante && !multiplesEstudiantes) {
          if (
            esPreguntaCuantoDeboMes &&
            !esPreguntaMultiplesMeses &&
            resultados.length === 1
          ) {
            respuesta = prefijoMesCorregido;
          } else if (esPreguntaMultiplesMeses) {
            respuesta =
              prefijoMesCorregido +
              `📊 Información de pagos para *${nombreEstudiante}* (meses consultados):\n\n`;
          } else {
            respuesta =
              esPreguntaMesEspecifico && resultados.length === 1
                ? prefijoMesCorregido
                : prefijoMesCorregido +
                  `📊 Información de pagos para *${nombreEstudiante}*:\n\n`;
          }
        } else {
          if (
            esPreguntaCuantoDeboMes &&
            !esPreguntaMultiplesMeses &&
            resultados.length === 1
          ) {
            respuesta = prefijoMesCorregido;
          } else if (esPreguntaMultiplesMeses) {
            respuesta =
              prefijoMesCorregido +
              `📊 Información de pagos (meses consultados):\n\n`;
          } else {
            respuesta =
              esPreguntaMesEspecifico && resultados.length === 1
                ? prefijoMesCorregido
                : prefijoMesCorregido + `📊 Información de pagos:\n\n`;
          }
        }

        // Diagnóstico (solo para este tipo de respuesta): ayuda a detectar por qué se queda "solo encabezado"
        console.log(
          `🧾 [FormatoPagos] flags: esPreguntaCuantoDeboMes=${esPreguntaCuantoDeboMes} esPreguntaMultiplesMeses=${!!esPreguntaMultiplesMeses} esPreguntaVencimientoOMesEspecifico=${esPreguntaVencimientoOMesEspecifico} resultados=${resultados.length}`,
        );

        const agregarFilasPago = (filas, nombreParaFilas) => {
          filas.forEach((row, idx) => {
            const mes = row.nombre_mes || `Mes ${row.mes || idx + 1}`;
            // Convertir a números de forma segura
            // Intentar obtener monto_esperado de múltiples campos posibles
            let montoEsperado =
              parseFloat(
                row.monto_esperado ||
                  row.monto_esperado_mensual ||
                  row.monto ||
                  0,
              ) || 0;

            // Si el monto_esperado es 0, intentar obtenerlo del compromiso económico
            if (montoEsperado === 0 && row.monto_base) {
              montoEsperado = parseFloat(row.monto_base) || 0;
            }

            // Obtener monto_pagado (puede venir del SQL calculado o de la tabla)
            let montoPagado =
              parseFloat(row.monto_pagado || row.total_pagado || 0) || 0;

            // Si el SQL no calculó monto_pagado correctamente, intentar recalcularlo
            // Esto es un fallback si el SQL no hizo el JOIN con pagos_realizados
            if (montoPagado === 0 && row.monto_pagado_tabla) {
              montoPagado = parseFloat(row.monto_pagado_tabla) || 0;
            }

            const montoPendienteCalculado =
              parseFloat(row.monto_pendiente) || montoEsperado - montoPagado;
            const montoPendiente = isNaN(montoPendienteCalculado)
              ? Math.max(0, montoEsperado - montoPagado)
              : montoPendienteCalculado;

            // Actualizar estado basado en montos reales (no confiar solo en el estado de la BD)
            let estado = row.estado || "pendiente";
            if (montoPagado >= montoEsperado && montoEsperado > 0) {
              estado = "pagado";
            } else if (montoPagado > 0 && montoPagado < montoEsperado) {
              estado = "parcial";
            } else if (montoPagado === 0 && montoEsperado > 0) {
              // Verificar si está vencido
              const fechaVenc = row.fecha_vencimiento;
              if (fechaVenc) {
                try {
                  const fechaVencDate = new Date(fechaVenc);
                  const hoy = new Date();
                  hoy.setHours(0, 0, 0, 0);
                  fechaVencDate.setHours(0, 0, 0, 0);
                  if (fechaVencDate < hoy) {
                    estado = "vencido";
                  } else {
                    estado = "pendiente";
                  }
                } catch (e) {
                  estado = "pendiente";
                }
              } else {
                estado = "pendiente";
              }
            }

            const fechaVencimiento = row.fecha_vencimiento || "";

            // Log para debugging
            if (montoEsperado === 0) {
              console.warn(
                `⚠️ Monto esperado es 0 para ${mes}. Datos disponibles:`,
                JSON.stringify(row),
              );
            }
            if (montoPagado > 0) {
              console.log(
                `✅ ${mes}: Esperado=${montoEsperado.toFixed(2)}, Pagado=${montoPagado.toFixed(2)}, Pendiente=${montoPendiente.toFixed(2)}, Estado=${estado}`,
              );
            }

            let estadoEmoji = "⏳";
            if (estado === "pagado") estadoEmoji = "✅";
            else if (estado === "parcial") estadoEmoji = "⚠️";
            else if (estado === "vencido") estadoEmoji = "❌";

            // Formatear fecha correctamente (solo fecha, no hora)
            let fechaFormateada = "";
            if (fechaVencimiento) {
              if (fechaVencimiento instanceof Date) {
                fechaFormateada = fechaVencimiento.toLocaleDateString("es-BO", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                });
              } else if (typeof fechaVencimiento === "string") {
                try {
                  const fecha = new Date(fechaVencimiento);
                  if (!isNaN(fecha.getTime())) {
                    fechaFormateada = fecha.toLocaleDateString("es-BO", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    });
                  }
                } catch (e) {
                  fechaFormateada = fechaVencimiento.split(" ")[0]; // Solo la fecha, sin hora
                }
              }
            }

            if (
              esPreguntaCuantoDeboMes &&
              filas.length === 1 &&
              !esPreguntaMultiplesMeses
            ) {
              if (!respuesta && nombrePadre && nombreParaFilas) {
                respuesta = `${nombrePadre},\n\n`;
              }

              if (montoPendiente > 0) {
                respuesta += `Del mes de *${mes}* de *${nombreParaFilas || "su hijo/hija"}* debe pagar: *Bs. ${montoPendiente.toFixed(2)}*\n\n`;
                respuesta += `📋 *Detalles:*\n`;
                respuesta += `• Monto total: Bs. ${montoEsperado.toFixed(2)}\n`;
                respuesta += `• Ya pagado: Bs. ${montoPagado.toFixed(2)}\n`;
                respuesta += `• Pendiente: Bs. ${montoPendiente.toFixed(2)} ${estadoEmoji}\n`;
                if (fechaFormateada) {
                  respuesta += `• Vence: ${fechaFormateada}\n`;
                }
              } else {
                respuesta += `✅ La cuota del mes de *${mes}* de *${nombreParaFilas || "su hijo/hija"}* ya está pagada completamente.\n\n`;
                respuesta += `• Monto pagado: Bs. ${montoPagado.toFixed(2)}\n`;
              }
            } else if (esPreguntaCuantoDeboMes && esPreguntaMultiplesMeses) {
              if (!respuesta && nombrePadre && nombreParaFilas) {
                respuesta = `${nombrePadre},\n\n`;
              }

              if (montoPendiente > 0) {
                respuesta += `${estadoEmoji} *${mes}*:\n`;
                respuesta += `   • Pendiente: *Bs. ${montoPendiente.toFixed(2)}*\n`;
                respuesta += `   • Monto total: Bs. ${montoEsperado.toFixed(2)}\n`;
                respuesta += `   • Ya pagado: Bs. ${montoPagado.toFixed(2)}\n`;
                if (fechaFormateada) {
                  respuesta += `   • Vence: ${fechaFormateada}\n`;
                }
                respuesta += `\n`;
              } else {
                respuesta += `✅ *${mes}*: Pagado completamente (Bs. ${montoPagado.toFixed(2)})\n\n`;
              }
            } else if (
              esPreguntaVencimientoOMesEspecifico &&
              filas.length === 1
            ) {
              respuesta += `La cuota de *${mes}* vence el *${fechaFormateada || "fecha no disponible"}*.\n\n`;
              respuesta += `💰 *Detalles:*\n`;
              respuesta += `• Monto esperado: Bs. ${montoEsperado.toFixed(2)}\n`;
              respuesta += `• Monto pagado: Bs. ${montoPagado.toFixed(2)}\n`;
              respuesta += `• Monto pendiente: Bs. ${montoPendiente.toFixed(2)}\n`;
              respuesta += `• Estado: ${estado} ${estadoEmoji}\n`;
            } else {
              // Respuesta completa para múltiples meses (formato WhatsApp legible)
              respuesta += `${estadoEmoji} *${mes}*\n`;
              respuesta += `• Monto: Bs. ${montoEsperado.toFixed(2)}\n`;
              respuesta += `• Pagado: Bs. ${montoPagado.toFixed(2)}\n`;
              respuesta += `• Pendiente: Bs. ${montoPendiente.toFixed(2)}\n`;
              respuesta += `• Estado: ${estado}\n`;
              if (fechaFormateada) {
                respuesta += `• Vence: ${fechaFormateada}\n`;
              }
              respuesta += `\n`;
            }
          });
        };

        if (multiplesEstudiantes) {
          idsEnResultados.forEach((id, index) => {
            const idKey = typeof id === "number" ? id : Number(id);
            const nombreHijo =
              mapIdNombre[id] ||
              mapIdNombre[idKey] ||
              mapIdNombre[String(id)] ||
              "Estudiante";
            const filas =
              porEstudiante[id] ||
              porEstudiante[idKey] ||
              porEstudiante[String(id)] ||
              [];
            if (filas.length === 0) return;
            if (index > 0) respuesta += "\n\n";
            respuesta += `📌 *${nombreHijo}:*\n`;
            agregarFilasPago(filas, nombreHijo);
            respuesta += "\n";
          });
        } else {
          agregarFilasPago(resultados, nombreEstudiante);
        }

        // Fallback de seguridad: si por algún motivo quedó solo el encabezado (caso reportado),
        // agregar al menos el vencimiento y montos del único resultado.
        if (resultados.length === 1 && typeof respuesta === "string") {
          const soloEncabezado =
            respuesta.trim().endsWith(":") ||
            respuesta.trim().endsWith(":\n") ||
            respuesta.trim().endsWith(":\r\n");
          if (soloEncabezado) {
            const row = resultados[0] || {};
            const mes = row.nombre_mes || "este mes";
            const montoEsperado =
              parseFloat(row.monto_esperado || row.monto || 0) || 0;
            const montoPagado = parseFloat(row.monto_pagado || 0) || 0;
            const montoPendiente =
              parseFloat(row.monto_pendiente) ||
              Math.max(0, montoEsperado - montoPagado);
            let fechaFormateada = "";
            if (row.fecha_vencimiento) {
              try {
                const fecha = new Date(row.fecha_vencimiento);
                if (!isNaN(fecha.getTime())) {
                  fechaFormateada = fecha.toLocaleDateString("es-BO", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  });
                }
              } catch (_) {}
            }
            respuesta += `\n\nLa cuota de *${mes}* vence el *${fechaFormateada || "fecha no disponible"}*.\n`;
            respuesta += `Pendiente: *Bs. ${Number(montoPendiente).toFixed(2)}* (Total Bs. ${Number(montoEsperado).toFixed(2)}, Pagado Bs. ${Number(montoPagado).toFixed(2)})`;
          }
        }

        // Mostrar resumen si:
        // 1. NO es pregunta sobre un mes específico (único)
        // 2. O hay múltiples meses
        // 3. O es pregunta sobre múltiples meses
        if (
          !esPreguntaMesEspecifico ||
          resultados.length > 1 ||
          esPreguntaMultiplesMeses
        ) {
          // Calcular totales si están disponibles
          const totalEsperado = resultados.reduce((sum, row) => {
            const valor = parseFloat(row.monto_esperado || row.monto || 0) || 0;
            return sum + valor;
          }, 0);
          const totalPagado = resultados.reduce((sum, row) => {
            const valor = parseFloat(row.monto_pagado || 0) || 0;
            return sum + valor;
          }, 0);
          const totalPendiente = resultados.reduce((sum, row) => {
            const valorEsperado =
              parseFloat(row.monto_esperado || row.monto || 0) || 0;
            const valorPagado = parseFloat(row.monto_pagado || 0) || 0;
            const valorPendiente =
              parseFloat(row.monto_pendiente) || valorEsperado - valorPagado;
            return sum + (isNaN(valorPendiente) ? 0 : valorPendiente);
          }, 0);

          if (totalEsperado > 0) {
            respuesta += `\n💰 *Resumen ${multiplesEstudiantes ? "total (todos sus hijos)" : "de los meses consultados"}:*\n`;
            respuesta += `• Total esperado: Bs. ${totalEsperado.toFixed(2)}\n`;
            respuesta += `• Total pagado: Bs. ${totalPagado.toFixed(2)}\n`;
            respuesta += `• Total pendiente: *Bs. ${totalPendiente.toFixed(2)}*\n`;
          }
        }

        return respuesta.trim();
      }

      // Formato genérico para otros tipos de resultados
      let respuesta = `Se encontraron **${resultados.length}** resultado(s):\n\n`;
      resultados.slice(0, 20).forEach((row, idx) => {
        if (row.nombre && (row.apellido_paterno || row.apellido_materno)) {
          const nombre =
            `${row.nombre} ${row.apellido_paterno || ""} ${row.apellido_materno || ""}`.trim();
          respuesta += `${idx + 1}. ${nombre}\n`;
        } else {
          const campos = Object.entries(row)
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          respuesta += `${idx + 1}. ${campos}\n`;
        }
      });

      if (resultados.length > 20) {
        respuesta += `\n... y ${resultados.length - 20} resultado(s) más.`;
      }

      return respuesta;
    } catch (error) {
      console.error("Error en HerramientaBaseDatos:", error);

      // Si el error es de SQL inválido, intentar responder desde el reglamento como fallback
      if (
        error.message.includes("SQL") ||
        error.message.includes("syntax") ||
        error.message.includes("Error en la consulta")
      ) {
        console.log(
          "⚠️ Error SQL detectado, intentando fallback al reglamento...",
        );
        try {
          const herramientaReglamento = new HerramientaReglamento();
          const respuestaReglamento =
            await herramientaReglamento.ejecutar(pregunta);
          return respuestaReglamento;
        } catch (reglamentoError) {
          // Si también falla el reglamento, devolver el error original
          return `No pude encontrar información específica en la base de datos. Por favor, reformula tu pregunta o consulta con Secretaría.`;
        }
      }

      if (esErrorCuotaGemini(error)) {
        return "En este momento el servicio de IA está temporalmente saturado o sin cuota. Intenta nuevamente en unos minutos, por favor.";
      }

      return `Error al consultar la base de datos: ${error.message}`;
    }
  }
}

class HerramientaNotificacion extends Herramienta {
  constructor(notificacionesService) {
    super(
      "notificacion",
      "Procesa comandos de notificación a padres y tutores",
    );
    this.notificacionesService = notificacionesService;
  }

  async ejecutar(
    pregunta,
    infoRemitente = null,
    contextoHistorial = "",
    infoUsuario = null,
  ) {
    // Esta herramienta solo procesa comandos, la ejecución real se hace desde las rutas
    // Retornar instrucciones para el usuario
    return "Comando de notificación detectado. Por favor, use el endpoint de notificaciones manuales para enviar mensajes.";
  }
}

// ===== NUEVA HERRAMIENTA DE AYUDA Y BIENVENIDA =====
class HerramientaAyuda extends Herramienta {
  constructor() {
    super(
      "ayuda",
      "Responde a saludos y proporciona información sobre las capacidades del agente",
    );
  }

  async ejecutar(
    pregunta,
    infoRemitente = null,
    contextoHistorial = "",
    infoUsuario = null,
  ) {
    // Obtener hora actual para saludo personalizado
    const hora = new Date().getHours();
    let saludo = "¡Hola!";
    if (hora >= 5 && hora < 12) {
      saludo = "¡Buenos días!";
    } else if (hora >= 12 && hora < 19) {
      saludo = "¡Buenas tardes!";
    } else {
      saludo = "¡Buenas noches!";
    }

    // Obtener documentos cargados desde la BD
    let documentosDisponibles = [];
    try {
      documentosDisponibles = await obtenerTextosDocumentosActivos();
    } catch (error) {
      console.error("Error al obtener documentos:", error);
    }

    // Agrupar documentos por tipo
    const documentosPorTipo = {
      reglamento: [],
      becas: [],
      inscripcion: [],
      otros: [],
    };

    documentosDisponibles.forEach((doc) => {
      const tipo = doc.tipo || "otros";
      if (documentosPorTipo[tipo]) {
        documentosPorTipo[tipo].push(doc.nombre);
      } else {
        documentosPorTipo.otros.push(doc.nombre);
      }
    });

    // Personalizar según el tipo de usuario
    let nombreUsuario = "";
    let respuesta = "";

    if (infoUsuario) {
      // Usuario autenticado (admin, secretaria, cajero, director)
      nombreUsuario = infoUsuario.nombre
        ? ` ${infoUsuario.nombre.split(" ")[0]}`
        : "";

      respuesta = `${saludo}${nombreUsuario} 👋\n\n`;
      respuesta += `Soy el asistente inteligente de la Unidad Educativa. Estoy aquí para ayudarte.\n\n`;
      respuesta += `🔹 **Consultas que puedo responder:**\n\n`;

      if (
        infoUsuario.rol === "Administrador" ||
        infoUsuario.rol === "Director"
      ) {
        respuesta += `📊 **Reportes y estadísticas:**\n`;
        respuesta += `• "¿Cuántos estudiantes hay inscritos?"\n`;
        respuesta += `• "¿Cuántos estudiantes tienen deuda?"\n`;
        respuesta += `• "Mostrar estadísticas de pagos"\n`;
        respuesta += `• "¿Cuánto se ha recaudado este mes?"\n\n`;

        respuesta += `💰 **Consultas de pagos:**\n`;
        respuesta += `• "Pagos de [nombre del estudiante]"\n`;
        respuesta += `• "¿Quiénes están en mora?"\n`;
        respuesta += `• "Deuda del estudiante Juan Pérez"\n\n`;

        respuesta += `📢 **Notificaciones:**\n`;
        respuesta += `• "Notificar a todos que mañana no hay clases"\n`;
        respuesta += `• "Enviar comunicado sobre el inicio de clases"\n\n`;
      } else if (infoUsuario.rol === "Secretaria") {
        respuesta += `👨‍🎓 **Estudiantes e inscripciones:**\n`;
        respuesta += `• "¿Cuántos estudiantes hay inscritos?"\n`;
        respuesta += `• "Listar estudiantes del nivel inicial"\n`;
        respuesta += `• "Información de [nombre del estudiante]"\n\n`;

        respuesta += `💰 **Consultas de pagos:**\n`;
        respuesta += `• "Pagos de [nombre del estudiante]"\n`;
        respuesta += `• "Estado de cuenta de María García"\n\n`;
      } else if (infoUsuario.rol === "Cajero") {
        respuesta += `💰 **Consultas de pagos:**\n`;
        respuesta += `• "Pagos de [nombre del estudiante]"\n`;
        respuesta += `• "¿Cuánto debe [nombre]?"\n`;
        respuesta += `• "Estado de cuenta de [nombre]"\n\n`;
      }

      respuesta += `📋 **Información del reglamento:**\n`;
      respuesta += `• "¿Cuáles son los requisitos para inscribir?"\n`;
      respuesta += `• "¿Qué becas existen?"\n`;
      respuesta += `• "¿Cuándo inician las clases?"\n`;
      respuesta += `• "¿Cuál es el horario del turno mañana?"\n`;
    } else if (infoRemitente) {
      // Padre o tutor por WhatsApp
      nombreUsuario =
        infoRemitente.nombre_padre ||
        infoRemitente.nombre_madre ||
        infoRemitente.nombre_autorizado ||
        "";
      if (nombreUsuario) {
        nombreUsuario = ` ${nombreUsuario.split(" ")[0]}`;
      }

      respuesta = `${saludo}${nombreUsuario} 👋\n\n`;
      respuesta += `Soy el asistente de la Unidad Educativa. Puedo ayudarle con información sobre sus hijos.\n\n`;

      // Mostrar documentos disponibles
      respuesta += `📚 **Documentos disponibles:**\n\n`;

      if (documentosPorTipo.reglamento.length > 0) {
        respuesta += `📋 **Reglamento:**\n`;
        documentosPorTipo.reglamento.forEach((nombre) => {
          respuesta += `• ${nombre}\n`;
        });
        respuesta += `\n`;
      }

      if (documentosPorTipo.inscripcion.length > 0) {
        respuesta += `📝 **Inscripción:**\n`;
        documentosPorTipo.inscripcion.forEach((nombre) => {
          respuesta += `• ${nombre}\n`;
        });
        respuesta += `\n`;
      }

      if (documentosPorTipo.becas.length > 0) {
        respuesta += `🎓 **Becas:**\n`;
        documentosPorTipo.becas.forEach((nombre) => {
          respuesta += `• ${nombre}\n`;
        });
        respuesta += `\n`;
      }

      if (documentosPorTipo.otros.length > 0) {
        respuesta += `📄 **Otros documentos:**\n`;
        documentosPorTipo.otros.forEach((nombre) => {
          respuesta += `• ${nombre}\n`;
        });
        respuesta += `\n`;
      }

      // Si no hay documentos, mostrar mensaje alternativo
      if (documentosDisponibles.length === 0) {
        respuesta += `Puedo ayudarle con información sobre:\n`;
        respuesta += `• Requisitos de inscripción\n`;
        respuesta += `• Becas y descuentos\n`;
        respuesta += `• Fechas importantes\n`;
        respuesta += `• Horarios y turnos\n`;
        respuesta += `• Uniformes y materiales\n\n`;
      }

      // Agregar información sobre pagos (siempre disponible)
      respuesta += `💰 **Pagos y cuotas:**\n`;
      respuesta += `• "¿Cuánto debo pagar?"\n`;
      respuesta += `• "¿Qué meses me faltan?"\n`;
      respuesta += `• "¿Cuándo vence la próxima cuota?"\n`;
      respuesta += `• "Estado de pagos de mi hija"\n\n`;

      respuesta += `Puede preguntarme sobre cualquiera de estos temas. ¿En qué puedo ayudarle? 😊`;
    } else {
      // Usuario sin contexto
      respuesta = `${saludo} 👋\n\n`;
      respuesta += `Soy el asistente inteligente de la Unidad Educativa.\n\n`;
      respuesta += `🔹 **Puedo ayudarte con:**\n\n`;
      respuesta += `• Información sobre requisitos de inscripción\n`;
      respuesta += `• Fechas importantes y calendario escolar\n`;
      respuesta += `• Información sobre becas y descuentos\n`;
      respuesta += `• Horarios y turnos disponibles\n`;
      respuesta += `• Uniformes y materiales\n`;
      respuesta += `• Consultas sobre pagos y mensualidades\n`;
    }

    respuesta += `\n\n¿En qué puedo ayudarte? 😊`;

    return respuesta;
  }
}

// ===== UTILIDADES: FECHAS EN TEXTO (ES) =====
// Extrae rangos/fechas desde texto en español para respuestas “aún puedo...”
const MESES_ES_NUM = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8, // variante común
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

function _stripContextMetadataLineas(texto = "") {
  return String(texto)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--- Documento:"))
    .join("\n");
}

function _toDateLocalInicio(anio, mesNum, dia) {
  const d = new Date(anio, mesNum, dia, 0, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

function _toDateLocalFin(anio, mesNum, dia) {
  const d = new Date(anio, mesNum, dia, 23, 59, 59, 999);
  return isNaN(d.getTime()) ? null : d;
}

function _cercaDeInscripcion(textoLower, idx) {
  const start = Math.max(0, idx - 120);
  const end = Math.min(textoLower.length, idx + 180);
  const ventana = textoLower.slice(start, end);
  return /inscrip|inscrib|matric|matr[ií]cul/i.test(ventana);
}

function extraerRangosFechasEspanol(texto) {
  const limpio = _stripContextMetadataLineas(texto).toLowerCase();
  const rangos = [];

  // Ej: "19 y 20 de enero de 2026"
  const reDosDias =
    /(\d{1,2})\s*y\s*(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})/gi;
  let m;
  while ((m = reDosDias.exec(limpio)) !== null) {
    if (!_cercaDeInscripcion(limpio, m.index || 0)) continue;
    const d1 = Number(m[1]);
    const d2 = Number(m[2]);
    const mes = m[3];
    const anio = Number(m[4]);
    const mesNum = MESES_ES_NUM[mes];
    if (mesNum == null) continue;
    const start = _toDateLocalInicio(anio, mesNum, Math.min(d1, d2));
    const end = _toDateLocalFin(anio, mesNum, Math.max(d1, d2));
    if (start && end) {
      rangos.push({
        start,
        end,
        raw: `${m[1]} y ${m[2]} de ${mes} de ${m[4]}`,
      });
    }
  }

  // Ej: "del 21 al 23 de enero de 2026" / "21 al 23 de enero de 2026"
  const reRango =
    /(del\s+)?(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})/gi;
  while ((m = reRango.exec(limpio)) !== null) {
    if (!_cercaDeInscripcion(limpio, m.index || 0)) continue;
    const d1 = Number(m[2]);
    const d2 = Number(m[3]);
    const mes = m[4];
    const anio = Number(m[5]);
    const mesNum = MESES_ES_NUM[mes];
    if (mesNum == null) continue;
    const start = _toDateLocalInicio(anio, mesNum, Math.min(d1, d2));
    const end = _toDateLocalFin(anio, mesNum, Math.max(d1, d2));
    if (start && end) {
      rangos.push({
        start,
        end,
        raw: `${m[1] ? "del " : ""}${m[2]} al ${m[3]} de ${mes} de ${m[5]}`,
      });
    }
  }

  // Dedupe por raw
  const seen = new Set();
  return rangos.filter((r) => {
    const key = r.raw;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatearFechaCortaEsBO(d) {
  try {
    return d.toLocaleDateString("es-BO", {
      year: "numeric",
      month: "long",
      day: "2-digit",
    });
  } catch (_) {
    return String(d);
  }
}

function detectarAudienciaReglamento(preguntaLower = "") {
  const p = String(preguntaLower || "").toLowerCase();
  const preguntaPadres =
    /\bpadres?\b|\bmadres?\b|\bapoderad|\btutor(es)?\b|\bfamilia\b/.test(p);
  const preguntaEstudiantes =
    /\bestudiantes?\b|\balumnos?\b|\bniñ[oa]s?\b|\badolescentes?\b/.test(p);
  if (preguntaPadres && !preguntaEstudiantes) return "padres";
  if (preguntaEstudiantes && !preguntaPadres) return "estudiantes";
  // si menciona ambos o ninguno, no filtrar por audiencia
  return null;
}

function filtrarContextoReglamentoPorAudiencia(
  contexto,
  audiencia,
  preguntaLower = "",
) {
  const ctx = String(contexto || "");
  if (!ctx.trim() || !audiencia) return ctx;

  // Si el usuario explícitamente pregunta por inscripción/requisitos, NO filtrar eso.
  const p = String(preguntaLower || "").toLowerCase();
  const pidioInscripcion =
    /(inscrip|inscrib|matr[ií]cul|requisit|documento|rude)/i.test(p);
  if (pidioInscripcion) return ctx;

  // Separar por bloques que empiezan con "--- Documento:" (así preservamos metadata)
  const bloques = ctx
    .split(/\n(?=--- Documento:)/g)
    .map((b) => b.trim())
    .filter(Boolean);
  if (bloques.length === 0) return ctx;

  const incluye = (txt, re) => re.test(normalizarTextoComparacion(txt));

  // Excluir artículos típicos de inscripción/requisitos/fechas si no los pidieron
  const reExcluir =
    /(inscrip|inscrib|matric|rude|vacun|certificado de nacimiento|requisit|fechas?|calendario|traslad|transferen)/i;

  const rePadres =
    /(padre|madre|tutor|apoderad|junta escolar|consejo educativo|participacion|prohib|ingreso.*hora de clases|convivencia|disciplina|sancion|infraestructura|cuidado.*bienes)/i;
  const reEstudiantes =
    /(estudiante|alumno|adolesc|convivencia|disciplina|sancion|falta|deber|derecho|asistencia|puntualidad|uniforme|comportamiento)/i;

  const reElegir = audiencia === "padres" ? rePadres : reEstudiantes;

  // Mantener solo bloques relevantes a la audiencia y que NO sean de inscripción/requisitos
  const filtrados = bloques.filter((b) => {
    if (reExcluir.test(b)) return false;
    return incluye(b, reElegir);
  });

  // Si filtramos demasiado, devolver el contexto original (mejor que quedarse sin nada)
  if (filtrados.length < 2) return ctx;
  return filtrados.join("\n\n");
}

class HerramientaReglamento extends Herramienta {
  constructor() {
    super(
      "reglamento",
      "Responde preguntas sobre el reglamento académico, requisitos, fechas de inscripción, uniformes, etc.",
    );
  }

  async ejecutar(
    pregunta,
    infoRemitente = null,
    contextoHistorial = "",
    infoUsuario = null,
  ) {
    try {
      // Determinar cuántos chunks recuperar según el tipo de pregunta
      const preguntaLower = pregunta.toLowerCase();
      const necesitaTabla =
        /qu[eé]|cu[áa]les?|tipos?|lista|requisitos?|documentos?/i.test(
          preguntaLower,
        );
      const esPreguntaSobreFechas =
        /cu[áa]ndo|cuando|fecha|inicio|empiezan|comienzan|apertura|calendario/i.test(
          preguntaLower,
        );
      const esPreguntaAmplia =
        /primeros?\s+art[íi]culos?|cu[áa]les?\s+son\s+los|reglamentos?\s+(para|dedicad|dirigid)|padres?|madres?|estudiantes?|apoderados?|tutores?/i.test(
          preguntaLower,
        );
      const esPreguntaSobreBecas = /beca|descuento|beneficio/i.test(
        preguntaLower,
      );
      const esRequisitosInscripcion =
        /(requisit|documento|papel|papeleri[áa])/.test(preguntaLower) &&
        /(inscrip|inscrib|matr[ií]cul)/.test(preguntaLower);
      const pidioDetalle =
        /(detalle|detall|explica|completo|toda la informaci[oó]n)/i.test(
          preguntaLower,
        );

      const audiencia = detectarAudienciaReglamento(preguntaLower);

      // Si preguntan por “reglamentos para padres/estudiantes”, traer más chunks y luego filtrar.
      const numChunks = esPreguntaSobreBecas
        ? 24
        : audiencia
          ? 18
          : esPreguntaAmplia
            ? 18
            : necesitaTabla || esPreguntaSobreFechas
              ? 12
              : 8;

      let contexto = await recuperarContextoDesdeReglamento(
        pregunta,
        numChunks,
      );
      if (audiencia) {
        contexto = filtrarContextoReglamentoPorAudiencia(
          contexto,
          audiencia,
          preguntaLower,
        );
      }

      // ===== AJUSTE CRÍTICO: “¿Aún puedo inscribir...?” =====
      // Si el contexto trae fechas de inscripción ya vencidas, NO afirmar que aún se puede.
      const esConsultaAunInscribir =
        /(a[uú]n|todav[ií]a)\s+puedo\s+inscrib/i.test(preguntaLower) ||
        /se\s+puede\s+inscrib.*(a[uú]n|todav[ií]a)/i.test(preguntaLower) ||
        /inscrib(ir|irse)?\s+fuera\s+de\s+fecha/i.test(preguntaLower) ||
        /(ya\s+pas[oó]|ya\s+termin[oó]).*(inscrip|fecha)/i.test(preguntaLower);

      if (esConsultaAunInscribir && contexto && contexto.trim().length > 0) {
        const rangos = extraerRangosFechasEspanol(contexto);
        const ahora = new Date();
        const hoyStr = formatearFechaCortaEsBO(ahora);

        if (!rangos || rangos.length === 0) {
          return (
            `Para confirmar si todavía está dentro de las fechas de inscripción, por favor consulte con *Secretaría* o acérquese a la unidad educativa.\n\n` +
            `Hoy es ${hoyStr}.\n\n` +
            `Para orientarle mejor, indíqueme: (1) ¿qué curso/nivel necesita? y (2) ¿es estudiante nuevo o traslado de otra unidad educativa?`
          );
        }

        const maxEnd = rangos.reduce(
          (acc, r) => (acc && acc.end > r.end ? acc : r),
          null,
        )?.end;
        const fechasTexto = rangos.map((r) => `* ${r.raw}`).join("\n");

        // Si ya pasó la última fecha encontrada, responder que concluyeron.
        if (maxEnd && ahora.getTime() > maxEnd.getTime()) {
          return (
            `Las inscripciones regulares fueron en estas fechas:\n${fechasTexto}\n\n` +
            `Hoy es ${hoyStr}, por lo que esas fechas ya concluyeron.\n\n` +
            `Si necesita una inscripción fuera de fecha (caso excepcional), por favor acérquese a *Secretaría/Dirección* de la unidad educativa para que evalúen su caso.\n\n` +
            `Para orientarle mejor, indíqueme: (1) ¿qué curso/nivel necesita? y (2) ¿es estudiante nuevo o traslado de otra unidad educativa?`
          );
        }

        // Si todavía no pasaron, dar respuesta afirmativa pero con fechas.
        if (maxEnd) {
          const hastaStr = formatearFechaCortaEsBO(maxEnd);
          return (
            `Sí, todavía está dentro de las fechas de inscripción.\n\n` +
            `Fechas:\n${fechasTexto}\n\n` +
            `Hoy es ${hoyStr}. (Las fechas indicadas llegan hasta ${hastaStr}).\n\n` +
            `Si desea, indíqueme: (1) ¿qué curso/nivel necesita? y (2) ¿es estudiante nuevo o traslado?`
          );
        }
      }

      // ===== RESPUESTA DETERMINÍSTICA (WhatsApp): REQUISITOS DE INSCRIPCIÓN =====
      // Evita respuestas cortadas y evita “contaminarse” con nombres del historial/BD.
      if (esRequisitosInscripcion && !pidioDetalle) {
        const norm = normalizarTextoComparacion(preguntaLower);
        const diceNuevo = /\bnuevo\b|\bestudiante nuevo\b/.test(norm);
        const diceRegular =
          /\bregular\b|\bestudiante regular\b|\bantiguo\b|\bantigua\b/.test(
            norm,
          );
        const diceTraslado =
          /\btraslado\b|\btransferencia\b|\bcambio de unidad\b|\bcambiar de unidad\b/.test(
            norm,
          );

        // Checklist base (según el reglamento usado en el sistema)
        const requisitosNuevo = [
          "Certificado de nacimiento original y *cédula de identidad* del estudiante.",
          "Si es *estudiante extranjero*: documento de identidad válido (Bolivia o país de origen). En casos extremos, *Declaración Jurada de Buena Fe* para el RUDE.",
          "Carnet/Certificado de vacunas (aplica para Inicial y 1ro de Primaria). Si no lo tiene, *no impide* la inscripción, pero debe completarse durante la gestión.",
          "Certificado del Centro de Atención Infantil Integral (CAII) para 2do de Inicial o 1ro de Primaria (si aplica). Si no lo tiene, *no impide* la inscripción.",
        ];

        const requisitosRegular = [
          "La inscripción es *automática* (ya tiene RUDE), pero se debe *ratificar* con presencia física del estudiante y padre/madre/tutor (hasta 15 días de iniciado el desarrollo curricular).",
          "Se verifica/actualiza el Formulario RUDE.",
        ];

        const notaTraslado = [
          "Si es *traslado* (cambio de unidad educativa), normalmente se solicita la documentación del estudiante y la verificación/actualización en el RUDE. Para el caso exacto, confirme en Secretaría.",
        ];

        if (diceNuevo) {
          return (
            `✅ *Requisitos para inscripción de estudiante nuevo:*\n\n` +
            requisitosNuevo.map((x) => `* ${x}`).join("\n") +
            `\n\nPara orientarle mejor: ¿a qué *nivel/curso* va a inscribir (Inicial/Primaria/Secundaria) y el estudiante es *boliviano o extranjero*?`
          );
        }

        if (diceRegular) {
          return (
            `✅ *Si es estudiante regular:*\n\n` +
            requisitosRegular.map((x) => `* ${x}`).join("\n") +
            `\n\n¿Es en la *misma unidad educativa* o es *traslado* desde otra unidad?`
          );
        }

        if (diceTraslado) {
          return (
            `✅ *Si es traslado (cambio de unidad educativa):*\n\n` +
            notaTraslado.map((x) => `* ${x}`).join("\n") +
            `\n\nPara indicarle exactamente qué traer: ¿el estudiante es *nuevo* (primera vez en el sistema) o ya tiene *RUDE* (regular)?`
          );
        }

        // Si no aclara, dar las dos opciones en corto
        return (
          `✅ *Requisitos de inscripción (resumen):*\n\n` +
          `* *Estudiante nuevo:* certificado de nacimiento + CI; (si aplica) vacunas/CAII; extranjeros: documento o declaración jurada.\n` +
          `* *Estudiante regular:* la inscripción es automática, pero se ratifica presencialmente y se actualiza RUDE.\n\n` +
          `¿Su caso es *nuevo*, *regular* o *traslado*?`
        );
      }

      // Personalizar el prompt si hay información del remitente
      let contextoPersonalizado = "";
      if (infoRemitente) {
        const esInscripcionOMatricula = /(inscrip|inscrib|matr[ií]cul)/i.test(
          preguntaLower,
        );
        const aclaraNuevo = /\bnuevo\b|\bestudiante\s+nuevo\b/i.test(
          preguntaLower,
        );

        // Si el usuario aclara "nuevo", NO asumir que se trata del estudiante ya registrado en BD.
        if (esInscripcionOMatricula && aclaraNuevo) {
          const nombreAdulto =
            infoRemitente.nombre_padre ||
            infoRemitente.nombre_madre ||
            infoRemitente.nombre_autorizado ||
            "";
          const prefijo = infoRemitente.nombre_padre
            ? `Sr. ${infoRemitente.nombre_padre}`
            : infoRemitente.nombre_madre
              ? `Sra. ${infoRemitente.nombre_madre}`
              : nombreAdulto || "Padre/Tutor";

          contextoPersonalizado =
            `\nNOTA: El usuario es un padre/madre/tutor (${prefijo}). ` +
            `IMPORTANTE: El usuario indicó que es *estudiante nuevo*, así que NO asumas que la inscripción es para estudiantes ya registrados. ` +
            `NO menciones nombres de estudiantes registrados a menos que el usuario los indique explícitamente.\n`;
        } else if (infoRemitente.nombre_padre) {
          contextoPersonalizado = `\nNOTA: El usuario es el padre del estudiante ${infoRemitente.nombre_estudiante} ${infoRemitente.apellido_paterno || ""}. Puedes personalizar la respuesta refiriéndote a él como "Sr. ${infoRemitente.nombre_padre}".\n`;
        } else if (infoRemitente.nombre_madre) {
          contextoPersonalizado = `\nNOTA: El usuario es la madre del estudiante ${infoRemitente.nombre_estudiante} ${infoRemitente.apellido_paterno || ""}. Puedes personalizar la respuesta refiriéndote a ella como "Sra. ${infoRemitente.nombre_madre}".\n`;
        } else if (infoRemitente.nombre_autorizado) {
          contextoPersonalizado = `\nNOTA: El usuario es una persona autorizada para el estudiante ${infoRemitente.nombre_estudiante} ${infoRemitente.apellido_paterno || ""}.\n`;
        }
      }

      // Personalizar según usuario autenticado
      let contextoUsuarioReglamento = "";
      if (infoUsuario) {
        contextoUsuarioReglamento = `\n\nINFORMACIÓN DEL USUARIO AUTENTICADO:\n`;
        contextoUsuarioReglamento += `- Nombre: ${infoUsuario.nombre || "N/A"}\n`;
        contextoUsuarioReglamento += `- Rol: ${infoUsuario.rol || "N/A"}\n`;
        contextoUsuarioReglamento += `Puedes referirte a él por su nombre cuando sea apropiado.\n`;
      }

      const esBecasLista =
        /(qu[eé]|cu[áa]les?)\s+(becas?|descuentos?)\s+(existen|hay|ofrece)/i.test(
          preguntaLower,
        ) ||
        /(becas?|descuentos?)\s+(existen|hay|que\s+ofrece)/i.test(
          preguntaLower,
        );
      const instruccionBecas = esBecasLista
        ? `
⚠️ BECAS/DESCUENTOS: El CONTEXTO tiene los 12 artículos. DEBES listar TODOS (Art. 1 al 12). Formato: * Art. N: Nombre - X%. Descripción breve. No te detengas: escribe los 12 artículos completos.`
        : "";

      const instruccionAudiencia = audiencia
        ? `

⚠️ FILTRO POR AUDIENCIA (OBLIGATORIO):
- El usuario preguntó por reglamentos que aplican para: *${audiencia}*.
- Responde SOLO con normas aplicables a *${audiencia}*.
- NO incluyas requisitos/fechas de inscripción, RUDE, vacunas, certificados o traslados, a menos que el usuario lo haya pedido explícitamente.
- Presenta la respuesta como lista corta: 4 a 8 puntos máximo, con frases claras.`
        : "";

      const instruccionBreveWhatsApp =
        esRequisitosInscripcion && !pidioDetalle
          ? `

⚠️ PRIORIDAD WHATSAPP (RESPUESTA BREVE OBLIGATORIA):
- El usuario quiere un resumen fácil de leer.
- NO repitas la pregunta del usuario.
- NO menciones “Artículo X” ni porcentajes de contexto irrelevantes.
- Responde con un CHECKLIST corto (máx. 8 viñetas) y, si aplica, separa SOLO en:
  1) *Si es estudiante nuevo* (documentos principales)
  2) *Si es estudiante regular* (qué debe hacer/ratificar)
- NO incluyas “casos vulnerables/excepcionales” a menos que el usuario lo pregunte explícitamente.
- Cierra con 1 pregunta para aclarar: “¿Es estudiante nuevo o regular/traslado?”`
          : "";

      const prompt = `Eres un agente inteligente de una unidad educativa. DEBES LEER Y ENTENDER COMPLETAMENTE los documentos en el CONTEXTO antes de responder.${instruccionBecas}${contextoHistorial}${contextoUsuarioReglamento}

INSTRUCCIONES CRÍTICAS - LECTURA Y COMPRENSIÓN:

1. LECTURA DETALLADA DEL CONTEXTO:
   - LEE COMPLETAMENTE todos los documentos proporcionados en el CONTEXTO
   - PRESTA ESPECIAL ATENCIÓN a TABLAS, que contienen información estructurada importante
   - Las TABLAS suelen tener columnas como "Tipo", "Porcentaje", "Descripción", "Requisitos", etc.
   - Si ves una TABLA sobre el tema de la pregunta, DEBES incluir TODA la información de esa tabla en tu respuesta
   - No digas "no se detallan" o "no están explícitamente" si la información está en una TABLA del contexto

2. COMPRENSIÓN DE TABLAS:
   - Las tablas pueden estar en formato texto con separadores (|, tabulaciones, etc.)
   - Cada fila de una tabla representa un elemento completo (por ejemplo, un tipo de beca)
   - Si la pregunta es sobre tipos/categorías (ej: "qué becas existen"), DEBES listar TODOS los tipos de la tabla
   - Incluye: nombre/tipo, porcentaje/valor, descripción, y requisitos de CADA elemento de la tabla

3. RESPUESTAS COMPLETAS Y PRECISAS:
   - Responde de forma COMPLETA y DETALLADA sobre el tema que se pregunta
   - Incluye TODA la información relevante que encuentres en el CONTEXTO
   - Si hay una TABLA sobre el tema, lista TODOS los elementos de esa tabla
   - Sé PRECISO y específico, usando exactamente los datos del contexto
   - NO digas "no se detallan" si la información está claramente en el contexto

4. REGLAS ESPECÍFICAS POR TIPO DE PREGUNTA:
   - Si preguntan "qué becas existen", "que becas hay", "tipos de becas/descuentos": DEBES listar TODAS las becas y descuentos que encuentres en el CONTEXTO. Busca cada ARTÍCULO, cada mención de descuento o beca. No te detengas en el primero: recorre TODO el contexto y enumera cada tipo (Art. 1, Art. 2, Art. 3, etc.) con su porcentaje y descripción.
   - Si preguntan sobre fechas: Incluye TODAS las fechas relevantes (inicio, actos, períodos, trimestres, etc.). Completa cada oración y lista todos los trimestres/períodos si aplica. No dejes respuestas a medias.
   - Si preguntan sobre requisitos: Lista TODOS los requisitos sin omitir ninguno
   - Si preguntan sobre documentos: Lista TODOS los documentos necesarios
   - Si preguntan sobre procesos: Explica TODOS los pasos en orden detallado
   - Si preguntan "cuáles son los primeros artículos" o "primeros artículos": Lista los artículos del 1 en adelante que estén en el CONTEXTO, con su número, título y contenido. No inventes artículos que no estén en el contexto.
   - Si preguntan sobre reglamentos/secciones "para padres", "para estudiantes", "dedicados a padres/estudiantes": Busca en TODO el contexto menciones a padres, madres, apoderados, tutores, estudiantes, alumnos. Resume las secciones o artículos relevantes para ese grupo.
   - Para CUALQUIER pregunta: usa toda la información relevante del contexto. Puede haber varios documentos (reglamento general, reglamento de becas, etc.). Si la pregunta es "qué becas existen" o similar, debes listar TODAS las becas/descuentos de TODOS los documentos del contexto, artículo por artículo.

5. EXCLUSIÓN DE INFORMACIÓN NO RELACIONADA:
   - Solo incluye información directamente relacionada con el tema específico de la pregunta
   - Si la pregunta es sobre "becas", NO incluyas información sobre inscripción general, pasajes, etc.
   - Si la pregunta es sobre "inicio de clases", NO incluyas información sobre pagos, pasajes, becas, etc.

6. BÚSQUEDA EN EL CONTEXTO:
   - Los documentos en el CONTEXTO pueden incluir reglamentos, tablas, listas, y texto estructurado
   - Busca TODA la información relevante al tema de la pregunta en todos los documentos del contexto
   - Si encuentras TABLAS sobre el tema, úsalas como fuente principal de información
   - Para preguntas sobre FECHAS o INICIO DE CLASES: Busca activamente palabras como "inicio", "comienzo", "apertura", "fecha", "día", "calendario", "año escolar", "periodo académico", "trimestre", "semestre", "febrero", "marzo", números de días/meses/años, y cualquier mención de fechas en formato texto (ej: "15 de febrero", "marzo de 2026", etc.)
   - Si la pregunta es sobre "cuándo inician las clases" o similar, busca información relacionada incluso si usa palabras diferentes (ej: "fecha de inicio", "comienzo del año escolar", "apertura académica")
   - SI ENCUENTRAS cualquier fecha o información relacionada en el contexto, DEBES incluirla en tu respuesta, incluso si no está explícitamente en una sección llamada "fecha de inicio"
   - Solo si REALMENTE no hay ninguna mención de fechas o información relacionada en TODO el contexto proporcionado, entonces explica brevemente que no puedes responder y que consulten con Secretaría

7. ESTILO DE RESPUESTA - INFORMACIÓN DIRECTA:
   - NUNCA cites nombres de documentos ni archivos (NO digas "del documento X.pdf", "según EDUCACIN_REGULAR", "Artículo 78 del documento...")
   - Presenta la información como si la conocieras: di directamente qué becas hay, qué dice cada artículo, etc.
   - El usuario quiere la INFORMACIÓN, no referencias bibliográficas. Ejemplo INCORRECTO: "Artículo 78 del documento X..."; CORRECTO: "La institución ofrece: *Descuento por Fidelidad - 10%*..."

8. FORMATO DE RESPUESTA (IMPORTANTE - Formato para WhatsApp):
   - NO uses formato de tabla con pipes (|) o separadores, ya que WhatsApp no los muestra bien
   - Si hay una tabla en el contexto, convierte esa información a un formato de lista con viñetas (*)
   - Para listar tipos/categorías (ej: tipos de becas):
     * Usa el formato: *Nombre/Tipo* - Porcentaje/Valor
     * Descripción completa
     * Requisitos: lista de requisitos
   - Usa viñetas (*) para organizar información
   - Usa saltos de línea para separar elementos
   - Organiza la información de forma clara y estructurada, pero en formato texto simple
   - Proporciona descripciones completas y precisas
   - Ejemplo correcto de formato:
     * Beca Salud - 25%
     Apoyo para estudiantes con situaciones médicas comprobadas que afecten la economía familiar.
     Requisitos: Informe médico oficial y evaluación socioeconómica.
   - Ejemplo INCORRECTO (NO usar):
     | Tipo de Beca | Porcentaje | Descripción | Requisitos |
     |---|---|---|---|
${instruccionAudiencia}
${instruccionBreveWhatsApp}
${contextoPersonalizado}

CONTEXTO (información de documentos oficiales - LEE COMPLETAMENTE, especialmente TABLAS):
${contexto}

PREGUNTA: ${pregunta}

IMPORTANTE: LEE el CONTEXTO y responde con la INFORMACIÓN directamente. NO menciones nombres de archivos ni documentos (PDF, DOCX). Presenta las becas, descuentos, fechas, etc. como información de la institución. Responde COMPLETA y DETALLADA:`;

      const maxTokensBecas = esBecasLista
        ? 8000
        : esRequisitosInscripcion && !pidioDetalle
          ? 1400
          : 4500;
      let respuesta = await llamarGemini(prompt, maxTokensBecas);

      if (!respuesta || respuesta.trim().length === 0) {
        return "No encontré información suficiente en el reglamento. Por favor, consulta con Secretaría.";
      }

      let respuestaTrim = respuesta.trim();
      const articulosMencionados = (
        respuestaTrim.match(/Art[íi]culo\s*\d+|Art\.\s*\d+/gi) || []
      ).length;
      const pareceIncompleta =
        !respuestaTrim.match(/[.!?]$/) ||
        (esBecasLista && articulosMencionados < 6);

      if (pareceIncompleta && respuestaTrim.length > 100) {
        console.warn(
          `⚠️ Respuesta incompleta (${articulosMencionados} artículos), solicitando continuación...`,
        );
        try {
          const promptContinuar = `Continúa la siguiente respuesta desde donde se quedó. NO repitas lo ya escrito. Lista los artículos restantes (Art. ${articulosMencionados + 1} en adelante) con su nombre, porcentaje y descripción breve.

RESPUESTA ACTUAL (incompleta):
${respuestaTrim}

CONTEXTO (para continuar):
${contexto}

Continúa enumerando los artículos que faltan:`;
          const continuacion = await llamarGemini(promptContinuar, 4000);
          if (continuacion && continuacion.trim().length > 0) {
            respuesta = respuestaTrim + "\n\n" + continuacion.trim();
            respuestaTrim = respuesta.trim();
            console.log("✅ Respuesta completada con continuación");
          }
        } catch (e) {
          console.warn("⚠️ No se pudo obtener continuación:", e?.message);
        }
      }

      return respuesta;
    } catch (error) {
      console.error("Error en HerramientaReglamento:", error);
      return `Error al consultar el reglamento: ${error.message}`;
    }
  }
}

// ===== ANÁLISIS DE SENTIMIENTO Y CONTEXTO =====
function analizarSentimiento(pregunta, historialConversacion = []) {
  const preguntaLower = pregunta.toLowerCase();

  // Palabras clave de frustración
  const palabrasFrustracion = [
    "no entiendo",
    "no funciona",
    "no sirve",
    "no me ayuda",
    "hablar con alguien",
    "hablar con una persona",
    "hablar con secretaria",
    "no puedo",
    "imposible",
    "muy difícil",
    "complicado",
    "molesto",
    "enojado",
    "frustrado",
    "desesperado",
    "no me resuelve",
    "no me ayuda",
    "inútil",
    "no sirve para nada",
  ];

  // Palabras clave de satisfacción
  const palabrasSatisfaccion = [
    "gracias",
    "perfecto",
    "excelente",
    "muy bien",
    "genial",
    "perfecto",
    "exacto",
    "correcto",
    "me ayudó",
    "muy útil",
    "muy bueno",
  ];

  // Detectar frustración
  const tieneFrustracion = palabrasFrustracion.some((palabra) =>
    preguntaLower.includes(palabra),
  );

  // Detectar necesidad de escalamiento
  const necesitaEscalamiento =
    preguntaLower.includes("hablar con") ||
    preguntaLower.includes("contactar") ||
    preguntaLower.includes("secretaria") ||
    preguntaLower.includes("director") ||
    preguntaLower.includes("administrador");

  // Detectar satisfacción
  const tieneSatisfaccion = palabrasSatisfaccion.some((palabra) =>
    preguntaLower.includes(palabra),
  );

  // Analizar historial para detectar frustración acumulada
  let frustracionAcumulada = 0;
  if (historialConversacion && historialConversacion.length > 0) {
    const ultimosMensajes = historialConversacion
      .slice(-3)
      .map((msg) => msg.mensaje?.toLowerCase() || "");
    frustracionAcumulada = ultimosMensajes.filter((msg) =>
      palabrasFrustracion.some((palabra) => msg.includes(palabra)),
    ).length;
  }

  return {
    tieneFrustracion: tieneFrustracion || frustracionAcumulada >= 2,
    necesitaEscalamiento:
      necesitaEscalamiento || (tieneFrustracion && frustracionAcumulada >= 2),
    tieneSatisfaccion,
    frustracionAcumulada,
    nivelUrgencia: necesitaEscalamiento
      ? "alto"
      : tieneFrustracion
        ? "medio"
        : "bajo",
  };
}

// Generar respuesta empática cuando hay frustración
function generarRespuestaEmpatica(analisisSentimiento, respuestaOriginal) {
  if (
    !analisisSentimiento.tieneFrustracion &&
    !analisisSentimiento.necesitaEscalamiento
  ) {
    return respuestaOriginal;
  }

  let prefijoEmpatico = "";

  if (analisisSentimiento.necesitaEscalamiento) {
    prefijoEmpatico = "😔 Entiendo que esto puede ser frustrante. ";
    prefijoEmpatico +=
      "Te puedo ayudar a contactar con secretaría para que te atiendan personalmente. ";
    prefijoEmpatico += "¿Te parece bien?\n\n";
    prefijoEmpatico +=
      "Mientras tanto, aquí está la información que pediste:\n\n";
  } else if (analisisSentimiento.tieneFrustracion) {
    prefijoEmpatico = "😊 Entiendo tu preocupación. ";
    prefijoEmpatico += "Déjame ayudarte de la mejor manera:\n\n";
  }

  return prefijoEmpatico + respuestaOriginal;
}

function normalizarTextoComparacion(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar tildes/diacríticos
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // quitar puntuación
    .replace(/\s+/g, " ")
    .trim();
}

/** Igual que normalizarTextoComparacion pero además corrige typos de meses (marsso->marzo) para comparar y quitar eco. */
function normalizarTextoComparacionConMeses(s) {
  let t = normalizarTextoComparacion(s);
  const meses = [
    ["marsso", "marzo"],
    ["marso", "marzo"],
    ["febrer", "febrero"],
    ["abrirl", "abril"],
    ["septiembr", "septiembre"],
    ["ociubre", "octubre"],
    ["diciembr", "diciembre"],
  ];
  meses.forEach(([mal, bien]) => {
    t = t.replace(new RegExp(mal, "gi"), bien);
  });
  return t;
}

// Detectar si la respuesta debe ser corta o detallada
function determinarLongitudRespuesta(pregunta, tipoConsulta) {
  const preguntaLower = pregunta.toLowerCase();
  const esConsultaPago =
    /(pagar|pago|pagos|debo|deuda|pendiente|cuota|mensualidad|vence|vencimiento)/i.test(
      preguntaLower,
    );

  // Para WhatsApp: "requisitos/documentos de inscripción" debe ser checklist breve por defecto
  const esRequisitosInscripcion =
    /(requisit|documento|papel|papeleri[áa])/.test(preguntaLower) &&
    /(inscrip|inscrib|matr[ií]cul)/.test(preguntaLower);
  const pidioDetalle =
    /(detalle|detall|explica|completo|toda la informaci[oó]n)/i.test(
      preguntaLower,
    );

  // Preguntas que requieren respuestas cortas
  const requiereCorta =
    preguntaLower.includes("sí o no") ||
    preguntaLower.includes("si o no") ||
    preguntaLower.includes("solo") ||
    preguntaLower.includes("rápido") ||
    preguntaLower.length < 30; // Preguntas muy cortas

  // Preguntas que requieren respuestas detalladas
  const requiereDetallada =
    preguntaLower.includes("explica") ||
    preguntaLower.includes("detalle") ||
    preguntaLower.includes("cómo funciona") ||
    preguntaLower.includes("como funciona") ||
    tipoConsulta === "reglamento";

  // Override: checklist breve salvo que pidan detalle explícito
  if (tipoConsulta === "reglamento" && esRequisitosInscripcion && !pidioDetalle)
    return "corta";
  // CRÍTICO: consultas de pagos (base de datos) no deben recortarse a "respuesta corta",
  // porque se pierde justo el detalle de monto/vencimiento.
  if (tipoConsulta === "base_datos" && esConsultaPago) return "normal";

  if (requiereCorta) return "corta";
  if (requiereDetallada) return "detallada";
  return "normal";
}

// Mejorar formato de respuesta según contexto
function mejorarFormatoRespuesta(
  respuesta,
  tipoConsulta,
  longitud,
  preguntaOriginal = "",
) {
  // Quitar repetición de la pregunta al inicio (muy común en WhatsApp / LLM que repite la pregunta)
  try {
    const pregNorm = normalizarTextoComparacion(preguntaOriginal);
    const pregNormMeses = normalizarTextoComparacionConMeses(preguntaOriginal);
    if (pregNorm || pregNormMeses) {
      const lineas = String(respuesta || "")
        .replace(/\r\n/g, "\n")
        .split("\n");
      let i = 0;
      while (i < Math.min(3, lineas.length)) {
        const ln = lineas[i].trim();
        const lnNorm = normalizarTextoComparacion(ln);
        const lnNormMeses = normalizarTextoComparacionConMeses(ln);
        const nextNorm =
          i + 1 < lineas.length
            ? normalizarTextoComparacion(lineas[i + 1])
            : "";
        const repitePregunta =
          (lnNorm && (lnNorm === pregNorm || lnNorm.startsWith(pregNorm))) ||
          (lnNormMeses &&
            pregNormMeses &&
            (lnNormMeses === pregNormMeses ||
              lnNormMeses.startsWith(pregNormMeses)));
        const duplicada = lnNorm && nextNorm && lnNorm === nextNorm;
        if (repitePregunta || duplicada) {
          lineas.splice(i, 1);
          continue;
        }
        break;
      }
      respuesta = lineas.join("\n").trim();
    }
  } catch (_) {
    // no bloquear por errores de normalización
  }

  // Si es respuesta corta, hacerla más concisa
  if (longitud === "corta") {
    // Preferir un checklist legible: máximo ~12 líneas o 2 párrafos, lo que ocurra primero
    const partes = String(respuesta || "").split("\n\n");
    const primera = partes.slice(0, 2).join("\n\n");
    const lineas = primera.split("\n");
    respuesta = lineas.slice(0, 12).join("\n").trim();
  }

  // Mejorar formato para WhatsApp
  // Normalizar espacios SIN romper saltos de línea (CRÍTICO para WhatsApp)
  respuesta = String(respuesta || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  // Quitar indentación al inicio de línea (evita que "\n   " se colapse)
  respuesta = respuesta.replace(/\n[ \t]+/g, "\n");
  // Reemplazar múltiples espacios/tabs dentro de líneas (pero no \n)
  respuesta = respuesta.replace(/[ \t]{2,}/g, " ");

  // Asegurar que los emojis estén bien posicionados
  respuesta = respuesta.replace(/\n\s*([✅❌⚠️📊💰📅🔔])/g, "\n$1");

  return respuesta;
}

// Generar sugerencias proactivas basadas en contexto
async function generarSugerenciasProactivas(infoRemitente, pool) {
  // Desactivado por decisión de UX: evitar recordatorios/sugerencias automáticas
  // al final de las respuestas de WhatsApp.
  return "";
}

// ===== DETECCIÓN Y PROCESAMIENTO DE MÚLTIPLES PREGUNTAS =====

// Constantes para detección de múltiples preguntas
const CONECTORES_PREGUNTAS = [
  "y",
  "también",
  "además",
  "igualmente",
  "asimismo",
  "otra cosa",
  "por otro lado",
];
const PATRONES_PREGUNTAS_MULTIPLES = [
  /\?\s*,?\s*(y|también|además|igualmente|asimismo|otra\s+cosa|por\s+otro\s+lado)\s+¿/gi,
  /\?\s*,?\s*(y|también|además)\s+([a-záéíóúñü][^¿]*?)\?/gi,
  /\?\s+¿/g, // Nueva pregunta después de ? seguido de ¿
  /[.!]\s*¿/g, // Nueva pregunta después de punto o exclamación
];

// Templates de respuesta para múltiples preguntas
const TEMPLATES_RESPUESTA_MULTIPLE = {
  dos_preguntas: (r1, r2) => `Con gusto le respondo:\n\n1️⃣ ${r1}\n\n2️⃣ ${r2}`,
  tres_o_mas: (respuestas) => {
    let resultado = "Le proporciono la información solicitada:\n\n";
    respuestas.forEach((r, idx) => {
      const emoji =
        ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"][idx] ||
        `${idx + 1}.`;
      resultado += `${emoji} ${r}\n\n`;
    });
    return resultado.trim();
  },
};

/**
 * Detecta si un mensaje contiene múltiples preguntas y las separa
 * @param {string} mensaje - El mensaje a analizar
 * @returns {Object} - {esMultiple: boolean, preguntas: string[]}
 */
function detectarMultiplesPreguntas(mensaje) {
  const mensajeOriginal = mensaje.trim();

  // Contar signos de interrogación
  const signosInterrogacion = (mensajeOriginal.match(/\?/g) || []).length;

  console.log(
    `🔍 [detectarMultiples] Mensaje: "${mensajeOriginal.substring(0, 100)}..."`,
  );
  console.log(
    `🔍 [detectarMultiples] Signos de interrogación encontrados: ${signosInterrogacion}`,
  );

  // Si hay menos de 2 signos de interrogación, es una sola pregunta
  if (signosInterrogacion < 2) {
    return {
      esMultiple: false,
      preguntas: [mensajeOriginal],
      preguntaOriginal: mensajeOriginal,
    };
  }

  // Dividir por signos de interrogación manteniendo el contexto
  const preguntas = [];
  let preguntaActual = "";
  let inicioConSaludo = "";

  // Detectar saludo inicial (primera parte antes de la primera pregunta)
  const primerSignoInterrogacion = mensajeOriginal.indexOf("¿");
  if (primerSignoInterrogacion > 0) {
    const textoAntes = mensajeOriginal
      .substring(0, primerSignoInterrogacion)
      .trim();
    const palabrasSaludo = [
      "hola",
      "buenos días",
      "buenas tardes",
      "buenas noches",
      "buen día",
    ];
    if (palabrasSaludo.some((s) => textoAntes.toLowerCase().includes(s))) {
      inicioConSaludo = textoAntes;
    }
  }

  // Dividir por patrones de múltiples preguntas
  let partes = mensajeOriginal.split(/\?\s*/);

  // Procesar cada parte
  partes.forEach((parte, idx) => {
    if (!parte.trim()) return;

    // Reconstruir pregunta con su signo de interrogación
    let pregunta = parte.trim();

    // Si la parte no empieza con ¿ (excepto la primera), agregarlo
    if (!pregunta.startsWith("¿") && idx > 0) {
      // Verificar si hay un conector al inicio
      let tieneConector = false;
      for (const conector of CONECTORES_PREGUNTAS) {
        const regex = new RegExp(
          `^(y\\s+|también\\s+|además\\s+|${conector}\\s+)`,
          "i",
        );
        if (regex.test(pregunta)) {
          tieneConector = true;
          break;
        }
      }

      // Si tiene conector, quitarlo y agregar ¿
      if (tieneConector) {
        pregunta = pregunta.replace(
          /^(y\s+|también\s+|además\s+|igualmente\s+|asimismo\s+|otra\s+cosa,?\s+|por\s+otro\s+lado,?\s+)/i,
          "",
        );
        pregunta = "¿" + pregunta;
      } else {
        pregunta = "¿" + pregunta;
      }
    }

    // Agregar signo de interrogación final si no lo tiene
    if (!pregunta.endsWith("?")) {
      pregunta += "?";
    }

    // Limpiar espacios extras
    pregunta = pregunta.replace(/\s+/g, " ").trim();

    if (pregunta.length > 3) {
      // Evitar fragmentos muy cortos
      preguntas.push(pregunta);
    }
  });

  // Si no se pudo separar correctamente, intentar otro método
  if (preguntas.length < 2) {
    // Intentar separar por "¿" seguido de texto
    const preguntasAlt = mensajeOriginal
      .split(/¿/)
      .filter((p) => p.trim().length > 0);
    if (preguntasAlt.length >= 2) {
      preguntas.length = 0; // Limpiar array
      preguntasAlt.forEach((parte, idx) => {
        let p = parte.trim();
        if (!p.endsWith("?")) p += "?";
        if (!p.startsWith("¿")) p = "¿" + p;
        // Limpiar conectores
        p = p.replace(/^¿\s*(y\s+|también\s+|además\s+)/i, "¿");
        if (p.length > 3) preguntas.push(p);
      });
    }
  }

  console.log(
    `🔍 [detectarMultiples] Preguntas detectadas: ${preguntas.length}`,
  );
  preguntas.forEach((p, idx) => {
    console.log(`   ${idx + 1}. "${p}"`);
  });

  return {
    esMultiple: preguntas.length >= 2,
    preguntas: preguntas.length >= 2 ? preguntas : [mensajeOriginal],
    preguntaOriginal: mensajeOriginal,
    inicioConSaludo,
  };
}

/**
 * Clasifica múltiples preguntas individualmente
 * @param {string[]} preguntas - Array de preguntas
 * @param {Object} infoRemitente - Información del remitente
 * @returns {Array} - Array de clasificaciones con metadata
 */
function clasificarPreguntasMultiples(preguntas, infoRemitente = null) {
  console.log(
    `🔍 [clasificarMultiples] Clasificando ${preguntas.length} preguntas`,
  );

  const clasificaciones = preguntas.map((pregunta, idx) => {
    const clasificacion = clasificarConsulta(pregunta, infoRemitente);
    console.log(
      `   ${idx + 1}. "${pregunta.substring(0, 50)}..." -> ${clasificacion.tipo} (${clasificacion.confianza})`,
    );

    return {
      pregunta,
      clasificacion,
      orden: idx,
    };
  });

  // Detectar relaciones entre preguntas
  // Por ejemplo, si pregunta 1 es sobre un estudiante y pregunta 2 menciona "él" o "ella"
  clasificaciones.forEach((item, idx) => {
    if (idx > 0) {
      const preguntaAnterior = clasificaciones[idx - 1];

      // Si la pregunta actual es muy corta o usa pronombres, marcar como relacionada
      const usaPronombres = /(él|ella|esa|ese|esto|aquello|lo|la)/i.test(
        item.pregunta,
      );
      const esMuyCorta = item.pregunta.length < 30;

      if (usaPronombres || esMuyCorta) {
        item.relacionadaCon = idx - 1;
        item.necesitaContexto = true;
      }
    }
  });

  return clasificaciones;
}

/**
 * Procesa múltiples preguntas manteniendo el contexto
 * @param {Array} preguntasClasificadas - Preguntas ya clasificadas
 * @param {Object} pool - Pool de base de datos
 * @param {Object} infoRemitente - Info del remitente
 * @param {string} contextoHistorial - Historial de conversación
 * @param {Object} infoUsuario - Info del usuario autenticado
 * @returns {Promise<Array>} - Array de respuestas
 */
async function procesarPreguntasEnContexto(
  preguntasClasificadas,
  pool,
  infoRemitente,
  contextoHistorial,
  infoUsuario,
) {
  console.log(
    `🔄 [procesarEnContexto] Procesando ${preguntasClasificadas.length} preguntas`,
  );

  const respuestas = [];
  let contextoDinamico = contextoHistorial || "";

  for (const item of preguntasClasificadas) {
    try {
      console.log(
        `🔄 [procesarEnContexto] Procesando pregunta ${item.orden + 1}: "${item.pregunta.substring(0, 50)}..."`,
      );

      // Si la pregunta necesita contexto de la anterior, agregarlo
      if (item.necesitaContexto && respuestas.length > 0) {
        contextoDinamico += `\n\nCONTEXTO DE PREGUNTA ANTERIOR:\n`;
        contextoDinamico += `Pregunta anterior: ${preguntasClasificadas[item.relacionadaCon].pregunta}\n`;
        contextoDinamico += `Respuesta anterior: ${respuestas[item.relacionadaCon].substring(0, 200)}...\n`;
      }

      // Seleccionar herramienta según clasificación
      let herramienta;
      let respuesta;

      if (item.clasificacion.herramienta === "fecha_hora") {
        herramienta = new HerramientaFechaHora();
        respuesta = await herramienta.ejecutar(item.pregunta, {
          historial: contextoDinamico,
        });
      } else if (item.clasificacion.herramienta === "ayuda") {
        herramienta = new HerramientaAyuda();
        respuesta = await herramienta.ejecutar(
          item.pregunta,
          infoRemitente,
          contextoDinamico,
          infoUsuario,
        );
      } else if (item.clasificacion.herramienta === "base_datos") {
        herramienta = new HerramientaBaseDatos(pool);
        respuesta = await herramienta.ejecutar(
          item.pregunta,
          infoRemitente,
          contextoDinamico,
          infoUsuario,
        );
      } else {
        herramienta = new HerramientaReglamento();
        respuesta = await herramienta.ejecutar(
          item.pregunta,
          infoRemitente,
          contextoDinamico,
          infoUsuario,
        );
      }

      // Limpiar respuesta (quitar saludo redundante si ya hay uno al inicio)
      respuesta = respuesta
        .replace(/^(hola|buenos días|buenas tardes|buenas noches)[,!\s]*/i, "")
        .trim();

      respuestas.push(respuesta);

      console.log(
        `✅ [procesarEnContexto] Pregunta ${item.orden + 1} procesada exitosamente`,
      );
    } catch (error) {
      console.error(
        `❌ [procesarEnContexto] Error procesando pregunta ${item.orden + 1}:`,
        error.message,
      );
      respuestas.push(
        `Lo siento, tuve un problema procesando esta pregunta: ${error.message}`,
      );
    }
  }

  return respuestas;
}

/**
 * Genera una respuesta estructurada para múltiples preguntas
 * @param {Array} respuestas - Array de respuestas individuales
 * @param {Array} preguntasOriginales - Preguntas originales
 * @param {string} inicioConSaludo - Saludo inicial si existe
 * @returns {string} - Respuesta final formateada
 */
function generarRespuestaEstructurada(
  respuestas,
  preguntasOriginales,
  inicioConSaludo = "",
) {
  console.log(
    `📝 [generarEstructurada] Formateando ${respuestas.length} respuestas`,
  );

  // Si solo hay una respuesta, retornarla directamente
  if (respuestas.length === 1) {
    return respuestas[0];
  }

  // Generar saludo si no viene uno
  let saludoInicial = "";
  if (inicioConSaludo) {
    saludoInicial = `${inicioConSaludo}! 😊\n\n`;
  } else {
    saludoInicial = "Con gusto le respondo:\n\n";
  }

  // Si son 2 preguntas, usar template simple
  if (respuestas.length === 2) {
    return (
      saludoInicial +
      TEMPLATES_RESPUESTA_MULTIPLE.dos_preguntas(respuestas[0], respuestas[1])
    );
  }

  // Si son 3 o más, usar template numerado
  return saludoInicial + TEMPLATES_RESPUESTA_MULTIPLE.tres_o_mas(respuestas);
}

// ===== FUNCIONES PARA ENVÍO MASIVO DE MENSAJES =====

/**
 * Normaliza nombre de nivel educativo
 */
function normalizarNivel(texto) {
  const mapeo = {
    primer: "PRIMER",
    primero: "PRIMER",
    segundo: "SEGUNDO",
    tercer: "TERCER",
    tercero: "TERCER",
    cuarto: "CUARTO",
    quinto: "QUINTO",
    sexto: "SEXTO",
  };

  const palabras = texto.toLowerCase().split(/\s+/);
  const numero = palabras.find((p) => mapeo[p]);

  if (
    numero &&
    (texto.toLowerCase().includes("nivel") ||
      texto.toLowerCase().includes("grado"))
  ) {
    return `${mapeo[numero]} NIVEL`;
  }

  return null;
}

/**
 * Extrae el mensaje del comando de envío masivo
 */
function extraerMensaje(pregunta) {
  const matchComillas = pregunta.match(/["'](.+?)["']/);
  if (matchComillas) return matchComillas[1];

  const matchQue = pregunta.match(
    /que\s+(.+?)\s+(?:a\s+todos|para|del?|en|primer|segundo|tercer)/i,
  );
  if (matchQue) return matchQue[1];

  const matchMensaje = pregunta.match(
    /mensaje\s+(.+?)\s+(?:a\s+todos|para|del?|primer|segundo|tercer)/i,
  );
  if (matchMensaje) return matchMensaje[1];

  return null;
}

/**
 * Extrae nivel(es) educativo(s) y mensaje de un comando de envío masivo
 */
function extraerParametrosEnvioMasivo(pregunta) {
  const preguntaLower = pregunta.toLowerCase();

  // Detectar si es aviso GENERAL (a todos)
  const esGeneral =
    /(a\s+todos|todos\s+los\s+niveles|toda\s+la\s+unidad|todos\s+los\s+padres(?!\s+de)|general)/i.test(
      pregunta,
    ) &&
    !/(de\s+primer|de\s+segundo|del\s+primer|del\s+segundo|para\s+primer|para\s+segundo)/i.test(
      pregunta,
    );

  if (esGeneral) {
    console.log("📢 Detectado: Envío GENERAL a todos los niveles");
    const mensaje = extraerMensaje(pregunta);
    if (!mensaje) {
      return { error: "No se pudo identificar el mensaje a enviar." };
    }
    return { niveles: null, esGeneral: true, mensaje, error: null };
  }

  // Extraer nivel(es) específico(s)
  const niveles = [];
  const patronMultiple =
    /(primer|primero|segundo|tercer|tercero|cuarto|quinto|sexto)\s+(nivel|grado)/gi;
  const matchesMultiple = pregunta.matchAll(patronMultiple);

  for (const match of matchesMultiple) {
    const nivelNormalizado = normalizarNivel(match[0]);
    if (nivelNormalizado && !niveles.includes(nivelNormalizado)) {
      niveles.push(nivelNormalizado);
    }
  }

  if (niveles.length === 0) {
    return {
      error:
        'No se pudo identificar el nivel educativo. Especifica:\n• Un nivel: "PRIMER NIVEL"\n• Múltiples: "PRIMER NIVEL Y SEGUNDO NIVEL"\n• Todos: "todos los niveles"',
    };
  }

  const mensaje = extraerMensaje(pregunta);
  if (!mensaje) {
    return { error: "No se pudo identificar el mensaje a enviar." };
  }

  console.log(
    `📢 Detectados ${niveles.length} nivel(es): ${niveles.join(", ")}`,
  );
  return { niveles, esGeneral: false, mensaje, error: null };
}

/**
 * Obtiene lista de padres/tutores de nivel(es) especificado(s)
 * Usa la tabla contacto_aviso para números verificados de WhatsApp
 */
async function obtenerPadresPorNivel(niveles, pool) {
  try {
    const anioActual = new Date().getFullYear();
    let query, params;

    if (niveles === null) {
      // TODOS los niveles - con contactos verificados
      query = `
        SELECT DISTINCT
          e.id as estudiante_id,
          e.nombre as estudiante_nombre,
          e.apellido_paterno as estudiante_apellido_paterno,
          e.apellido_materno as estudiante_apellido_materno,
          ca.telefono as telefono_contacto,
          ca.nombre_contacto,
          ca.tipo_contacto,
          n.nombre as nivel_nombre
        FROM estudiantes e
        INNER JOIN inscripciones i ON e.id = i.id_estudiante
        INNER JOIN nivel n ON i.id_nivel = n.id
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id
        WHERE i.gestion = ?
          AND i.activo = TRUE
          AND ca.activo = TRUE
        ORDER BY n.nombre, e.apellido_paterno, e.nombre
      `;
      params = [anioActual];
    } else {
      // Niveles específicos - con contactos verificados
      const placeholders = niveles.map(() => "n.nombre LIKE ?").join(" OR ");
      query = `
        SELECT DISTINCT
          e.id as estudiante_id,
          e.nombre as estudiante_nombre,
          e.apellido_paterno as estudiante_apellido_paterno,
          e.apellido_materno as estudiante_apellido_materno,
          ca.telefono as telefono_contacto,
          ca.nombre_contacto,
          ca.tipo_contacto,
          n.nombre as nivel_nombre
        FROM estudiantes e
        INNER JOIN inscripciones i ON e.id = i.id_estudiante
        INNER JOIN nivel n ON i.id_nivel = n.id
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id
        WHERE (${placeholders})
          AND i.gestion = ?
          AND i.activo = TRUE
          AND ca.activo = TRUE
        ORDER BY n.nombre, e.apellido_paterno, e.nombre
      `;
      params = [...niveles.map((n) => `%${n}%`), anioActual];
    }

    const [padres] = await pool.query(query, params);

    const nivelesTexto =
      niveles === null ? "TODOS los niveles" : niveles.join(", ");
    console.log(
      `📊 Encontrados ${padres.length} contactos verificados en ${nivelesTexto} (${anioActual})`,
    );

    return padres;
  } catch (error) {
    console.error("Error obteniendo padres por nivel:", error);
    throw error;
  }
}

/**
 * Personaliza un mensaje para un padre específico
 */
function personalizarMensaje(template, padre) {
  let nombreTutor = "Estimado/a";
  let apellidoTutor = "";

  if (padre.telefono_padre && padre.nombre_padre) {
    nombreTutor = padre.nombre_padre || "Sr.";
    apellidoTutor = padre.apellido_padre || "";
  } else if (padre.telefono_madre && padre.nombre_madre) {
    nombreTutor = padre.nombre_madre || "Sra.";
    apellidoTutor = padre.apellido_madre || "";
  }

  const nombreEstudiante =
    `${padre.estudiante_nombre} ${padre.estudiante_apellido_paterno || ""}`.trim();
  const mensaje =
    `Hola ${nombreTutor} ${apellidoTutor}, quería informarle que ${template}. ` +
    `Estudiante: ${nombreEstudiante} (${padre.nivel_nombre}). ` +
    `Muchas gracias. Atentamente, la Unidad Educativa.`;

  return mensaje.trim();
}

// ===== NORMALIZACIÓN DE MESES CON ERRORES ORTOGRÁFICOS =====
/** Corrige errores ortográficos comunes en nombres de meses (ej. "marsso" -> "marzo") para mejorar detección y respuesta. */
function normalizarMesesEnPregunta(pregunta) {
  if (!pregunta || typeof pregunta !== "string")
    return { preguntaNormalizada: pregunta, mesCorregido: null };
  const sustituciones = [
    { mal: /\bmarsso\b/gi, bien: "marzo", corregido: "Marzo" },
    { mal: /\bmarso\b/gi, bien: "marzo", corregido: "Marzo" },
    { mal: /\bfebrer\b/gi, bien: "febrero", corregido: "Febrero" },
    { mal: /\babrirl\b/gi, bien: "abril", corregido: "Abril" },
    { mal: /\bseptiembr[eo]\b/gi, bien: "septiembre", corregido: "Septiembre" },
    { mal: /\bociubre\b/gi, bien: "octubre", corregido: "Octubre" },
    { mal: /\bdiciembr[eo]\b/gi, bien: "diciembre", corregido: "Diciembre" },
  ];
  let texto = pregunta;
  let mesCorregido = null;
  for (const { mal, bien, corregido } of sustituciones) {
    if (mal.test(texto)) {
      texto = texto.replace(mal, bien);
      mesCorregido = corregido;
    }
  }
  return { preguntaNormalizada: texto, mesCorregido };
}

// ===== AGENTE BASADO EN UTILIDAD =====
function clasificarConsulta(pregunta, infoRemitente = null) {
  const preguntaLower = pregunta.toLowerCase().trim();

  // ===== PAGOS PERSONALES (Prioridad ABSOLUTA - DEBE ir PRIMERO) =====
  // CRÍTICO: Esta verificación debe ir ANTES de TODO para padres/tutores
  // Si hay infoRemitente y menciona pagos/meses/hijos, es SIEMPRE base_datos
  if (infoRemitente) {
    console.log(
      `🔍 [clasificarConsulta] PRIORIDAD MÁXIMA: Verificando pagos personales para padre/tutor`,
    );

    // Detectar patrones de pagos con máxima prioridad
    const mencionaDebo = /(cuánto|cuanto|cuándo|cuando).*debo/i.test(pregunta);
    const mencionaMesEspecifico =
      /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
        pregunta,
      );
    const mencionaHijo =
      /(mi hija|mi hijo|mis hijos|mis hijas|de mi hija|de mi hijo|de mis hijos|de mis hijas|mi estudiante|mis estudiantes|mi niño|mi niña|mis niños|mis niñas)/i.test(
        pregunta,
      );
    const mencionaPagos = /(pago|cuota|mensualidad|debo|deuda)/i.test(pregunta);
    const mencionaVencidas =
      /(vencid[oa]s?|atrasad[oa]s?|en\s+mora|moros[oa]s?)/i.test(pregunta);
    const pideDetalleVencidas =
      /(detalle|detalles|mostrar|muestrame|muéstrame|cual|cuales|ver)/i.test(
        preguntaLower,
      );

    console.log(`  [clasificarConsulta] - mencionaDebo: ${mencionaDebo}`);
    console.log(
      `  [clasificarConsulta] - mencionaMesEspecifico: ${mencionaMesEspecifico}`,
    );
    console.log(`  [clasificarConsulta] - mencionaHijo: ${mencionaHijo}`);
    console.log(`  [clasificarConsulta] - mencionaPagos: ${mencionaPagos}`);
    console.log(
      `  [clasificarConsulta] - mencionaVencidas: ${mencionaVencidas}`,
    );
    console.log(
      `  [clasificarConsulta] - pideDetalleVencidas: ${pideDetalleVencidas}`,
    );

    // CRÍTICO: frases tipo "si cuales se han vencido" / "muestrame las vencidas"
    if (
      mencionaVencidas &&
      (pideDetalleVencidas || mencionaPagos || mencionaDebo)
    ) {
      console.log(
        `✅ [clasificarConsulta] PRIORIDAD MÁXIMA: detalle de cuotas vencidas detectado - RETORNANDO base_datos`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.99 };
    }

    // CRÍTICO: Si menciona "cuanto debo" + mes + hijo, es SIEMPRE base_datos
    if (mencionaDebo && mencionaMesEspecifico && mencionaHijo) {
      console.log(
        `✅ [clasificarConsulta] PRIORIDAD MÁXIMA: "cuanto debo" + mes + hijo detectado - RETORNANDO base_datos`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.99 };
    }

    // CRÍTICO: Si menciona "cuanto debo" + mes, es SIEMPRE base_datos
    if (mencionaDebo && mencionaMesEspecifico) {
      console.log(
        `✅ [clasificarConsulta] PRIORIDAD ALTA: "cuanto debo" + mes detectado - RETORNANDO base_datos`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.98 };
    }

    // CRÍTICO: Si menciona pagos + mes + hijo, es SIEMPRE base_datos
    if (mencionaPagos && mencionaMesEspecifico && mencionaHijo) {
      console.log(
        `✅ [clasificarConsulta] PRIORIDAD ALTA: pagos + mes + hijo detectado - RETORNANDO base_datos`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.98 };
    }

    // Si menciona "cuanto debo" (sin mes específico pero con hijo), también es base_datos
    if (mencionaDebo && mencionaHijo) {
      console.log(
        `✅ [clasificarConsulta] PRIORIDAD ALTA: "cuanto debo" + hijo detectado - RETORNANDO base_datos`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.97 };
    }
  }

  // ===== SALUDOS Y AYUDA (Nueva categoría) =====
  const palabrasSaludos = [
    "hola",
    "buenos días",
    "buenas tardes",
    "buenas noches",
    "buen día",
    "saludos",
    "qué tal",
    "como estas",
    "cómo estás",
    "hey",
    "hi",
  ];

  const palabrasAyuda = [
    "ayuda",
    "ayúdame",
    "help",
    "qué puedes hacer",
    "que puedes hacer",
    "qué sabes",
    "que sabes",
    "para qué sirves",
    "para que sirves",
    "cómo funciona",
    "como funciona",
    "qué opciones",
    "que opciones",
    "menú",
    "menu",
    "opciones disponibles",
    "qué puedo preguntar",
    "que puedo preguntar",
    "qué consultas",
    "que consultas",
  ];

  // Si solo es un saludo corto (pero NO si menciona pagos/meses/cuotas después del saludo)
  const tieneSaludo = palabrasSaludos.some((p) => preguntaLower.startsWith(p));
  const mencionaPagosDespuesSaludo =
    /(cuanto|cuánto|pago|cuota|mensualidad|debo|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|mi hijo|mi hija)/i.test(
      pregunta,
    );
  const esSoloSaludo =
    tieneSaludo && preguntaLower.length < 25 && !mencionaPagosDespuesSaludo;
  const esAyuda = palabrasAyuda.some((p) => preguntaLower.includes(p));

  // Si menciona pagos después del saludo y es padre/tutor, NO es solo saludo
  if (infoRemitente && tieneSaludo && mencionaPagosDespuesSaludo) {
    // Saltar verificación de saludo/ayuda, continuar con pagos personales
  } else if (esSoloSaludo || esAyuda) {
    return { tipo: "ayuda", herramienta: "ayuda", confianza: 0.95 };
  }

  // ===== DETECTAR COMANDOS DE ENVÍO MASIVO =====
  // CRÍTICO: Debe ir ANTES de notificaciones genéricas
  const patronEnvioMasivo =
    /(envía|envia|envíe|enviar|manda|mandar).*mensaje.*a.*(todos|padres|tutores|nivel)/i;
  const esEnvioMasivo = patronEnvioMasivo.test(pregunta);

  if (esEnvioMasivo) {
    console.log(`📨 [clasificarConsulta] Comando de envío masivo detectado`);
    return {
      tipo: "envio_masivo",
      herramienta: "envio_masivo",
      confianza: 0.99,
    };
  }

  // ===== DETECTAR COMANDOS DE NOTIFICACIÓN GENÉRICA =====
  const palabrasNotificacion = [
    "notificar",
    "notifica",
    "notifique",
    "enviar comunicado",
    "comunicar",
    "comunica",
    "avisar",
    "avisa",
    "comunicado",
    "anuncio",
    "anunciar",
    "informar",
    "enviar aviso",
    "circular",
    "memo",
    "memorandum",
  ];

  const esComandoNotificacion = palabrasNotificacion.some((p) =>
    preguntaLower.includes(p),
  );
  if (esComandoNotificacion) {
    return {
      tipo: "notificacion",
      herramienta: "notificacion",
      confianza: 0.95,
    };
  }

  // ===== HORARIO DE ESTUDIANTE (antes de FECHA/HORA) =====
  // Evita que "¿a qué hora sale mi hijo?" se responda con la hora actual del sistema.
  const consultaHorarioEstudiante =
    /(a\s+qu[eé]\s+hora|hora\s+de\s+entrada|hora\s+de\s+salida|horario|entra|sale)/i.test(
      preguntaLower,
    ) &&
    /(mi\s+hij[oa]s?|mis\s+hij[oa]s?|mi\s+estudiante|mis\s+estudiantes|hij[oa]s?)/i.test(
      preguntaLower,
    );

  if (consultaHorarioEstudiante) {
    return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.96 };
  }

  // ===== INSCRIPCIÓN + COSTO/NIVEL (antes de FECHA/HORA) =====
  // Evita que preguntas mixtas como:
  // "cuanto cuesta prekinder y a qué hora es la entrada"
  // se clasifiquen como "hora actual".
  const mencionaCostoONivel =
    /(precio|costo|cu[aá]nto\s+cuesta|cuanto\s+cuesta|valor|mensualidad|arancel)/i.test(
      preguntaLower,
    ) &&
    /(kinder|pre[\s-]?kinder|inicial|primaria|secundaria|nivel|curso|inscrip|inscrib|matr[ií]cul)/i.test(
      preguntaLower,
    );

  const mencionaHorarioEscolar =
    /(hora\s+de\s+entrada|hora\s+de\s+salida|a\s+qu[eé]\s+hora\s+(entra|sale|es\s+la\s+entrada)|horario|turno)/i.test(
      preguntaLower,
    ) &&
    /(kinder|pre[\s-]?kinder|inicial|primaria|secundaria|nivel|curso|inscrip|inscrib|matr[ií]cul|entrada|salida)/i.test(
      preguntaLower,
    );

  if (mencionaCostoONivel || mencionaHorarioEscolar) {
    return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.94 };
  }

  // ===== FECHA/HORA =====
  const palabrasFechaHora = [
    "hoy",
    "fecha",
    "día",
    "día es",
    "hora",
    "qué día",
    "que dia",
    "qué hora",
    "que hora",
    "fecha actual",
    "día actual",
    "ahora",
    "momento actual",
    "qué fecha",
    "que fecha",
  ];

  // IMPORTANTE: Si el usuario menciona "fecha" pero está hablando de *inscripciones* (ej: "fuera de fecha"),
  // NO es una consulta de fecha/hora actual.
  const pareceInscripcion = /(inscrip|inscrib|matr[ií]cul)/i.test(pregunta);
  const pareceFueraDeFecha =
    /fuera\s+de\s+fecha|fecha\s+de\s+inscrip|fechas?\s+de\s+inscrip/i.test(
      preguntaLower,
    );

  if (
    !pareceInscripcion &&
    !pareceFueraDeFecha &&
    palabrasFechaHora.some((p) => preguntaLower.includes(p))
  ) {
    return { tipo: "fecha_hora", herramienta: "fecha_hora", confianza: 0.95 };
  }

  // ===== PAGOS PERSONALES (Prioridad ABSOLUTA para padres/tutores) =====
  // CRÍTICO: Esta verificación debe ir ANTES de cualquier otra para padres/tutores
  // Debe ejecutarse ANTES de saludos, ayuda, fecha/hora, notificaciones, etc.
  if (infoRemitente) {
    console.log(
      `🔍 [clasificarConsulta] Verificando clasificación para padre/tutor. Pregunta: "${pregunta}"`,
    );

    // Detectar si menciona meses específicos O cuotas/mensualidades O vencimientos
    const mencionaMesEspecifico =
      /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
        pregunta,
      );
    const mencionaCuotaOMensualidad =
      /(cuota|cuotas|mensualidad|mensualidades|pago|pagos|deuda|deudas|pendiente|pendientes)/i.test(
        pregunta,
      );
    const mencionaVencimiento =
      /(cuándo vence|cuando vence|vencimiento|fecha.*vencimiento|vencid[oa]s?|se han vencido)/i.test(
        pregunta,
      );
    const mencionaHijo =
      /(mi hija|mi hijo|mis hijos|mis hijas|de mi hija|de mi hijo|de mis hijos|de mis hijas|mi estudiante|mis estudiantes|mi niño|mi niña|mis niños|mis niñas)/i.test(
        pregunta,
      );
    // CRÍTICO: Detectar "cuanto debo" permitiendo palabras entre "cuanto" y "debo"
    const mencionaDebo = /(cuánto|cuanto|cuándo|cuando).*debo/i.test(pregunta);

    console.log(`  [clasificarConsulta] - mencionaDebo: ${mencionaDebo}`);
    console.log(
      `  [clasificarConsulta] - mencionaMesEspecifico: ${mencionaMesEspecifico}`,
    );
    console.log(`  [clasificarConsulta] - mencionaHijo: ${mencionaHijo}`);

    // Patrón específico para "cuando vence la cuota de [mes] de mi hija"
    const patronVencimientoCuotaMesHijo =
      /(cuándo vence|cuando vence).*(cuota|mensualidad|pago).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*(mi hija|mi hijo|mis hijos|mis hijas|de mi hija|de mi hijo|de mis hijos|de mis hijas)/i.test(
        pregunta,
      ) ||
      /(cuota|mensualidad|pago).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*(mi hija|mi hijo|mis hijos|mis hijas|de mi hija|de mi hijo|de mis hijos|de mis hijas).*(cuándo vence|cuando vence|vencimiento)/i.test(
        pregunta,
      );

    console.log(
      `  [clasificarConsulta] - Menciona mes específico: ${mencionaMesEspecifico}`,
    );
    console.log(
      `  [clasificarConsulta] - Menciona cuota/mensualidad: ${mencionaCuotaOMensualidad}`,
    );
    console.log(
      `  [clasificarConsulta] - Menciona vencimiento: ${mencionaVencimiento}`,
    );
    console.log(`  [clasificarConsulta] - Menciona hijo: ${mencionaHijo}`);
    console.log(`  [clasificarConsulta] - Menciona "debo": ${mencionaDebo}`);
    console.log(
      `  [clasificarConsulta] - Patrón vencimiento+cuota+mes+hijo: ${patronVencimientoCuotaMesHijo}`,
    );

    // CRÍTICO: Patrón específico tiene máxima prioridad
    if (patronVencimientoCuotaMesHijo) {
      console.log(
        `✅ Clasificado como base_datos - Patrón específico detectado (vencimiento + cuota + mes + hijo)`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.99 };
    }

    // CRÍTICO: Detectar "cuanto debo del mes de X de mi hijo" - máxima prioridad
    if (mencionaDebo && mencionaMesEspecifico && mencionaHijo) {
      console.log(
        `✅ [clasificarConsulta] Clasificado como base_datos - Patrón "cuanto debo del mes de X de mi hijo" detectado`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.99 };
    }

    // CRÍTICO: Si hay infoRemitente y menciona "cuanto debo" + mes, SIEMPRE es base_datos
    if (mencionaDebo && mencionaMesEspecifico) {
      console.log(
        `✅ [clasificarConsulta] Clasificado como base_datos - Padre/tutor pregunta "cuanto debo del mes de X"`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.98 };
    }

    // CRÍTICO: Si hay infoRemitente y menciona vencimiento/cuota/mes, SIEMPRE es base_datos
    // No importa si también menciona "fecha" o "plan de pagos", si pregunta sobre SU hija, es base_datos
    if (
      mencionaHijo &&
      (mencionaMesEspecifico ||
        mencionaCuotaOMensualidad ||
        mencionaVencimiento)
    ) {
      console.log(
        `✅ Clasificado como base_datos - Padre/tutor pregunta sobre pagos específicos (hijo + mes/cuota/vencimiento)`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.98 };
    }

    // También detectar si menciona vencimiento/cuota/mes aunque no mencione explícitamente "mi hija"
    // porque el contexto de infoRemitente ya indica que es un padre
    if (
      mencionaMesEspecifico &&
      (mencionaCuotaOMensualidad || mencionaVencimiento)
    ) {
      console.log(
        `✅ Clasificado como base_datos - Padre/tutor pregunta sobre pagos específicos (mes + cuota/vencimiento)`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.97 };
    }

    const palabrasPagosPersonales = [
      // Referencias directas a hijos
      "mi hija",
      "mi hijo",
      "mis hijos",
      "mis hijas",
      "mi estudiante",
      "mis estudiantes",
      "mi niño",
      "mi niña",
      "mis niños",
      "mis niñas",
      "de mi hija",
      "de mi hijo",
      "de mis hijos",
      "de mis hijas",
      "mi wawa",
      "mi nena",
      "mi nene",
      // Pagos propios
      "mis pagos",
      "mis mensualidades",
      "mis cuotas",
      "mi deuda",
      "mis deudas",
      // Cuánto debo (variaciones bolivianas)
      "cuánto debo",
      "cuanto debo",
      "cuándo debo",
      "cuando debo",
      "cuánto debo pagar",
      "cuanto debo pagar",
      "cuándo debo pagar",
      "cuando debo pagar",
      "cuánto debo del mes",
      "cuanto debo del mes",
      "cuánto debo de",
      "cuanto debo de",
      "cuánto debo del mes de",
      "cuanto debo del mes de",
      "cuánto debo de febrero",
      "cuanto debo de febrero",
      "cuánto debo de marzo",
      "cuanto debo de marzo",
      "cuánto debo de abril",
      "cuanto debo de abril",
      "cuánto debo de mayo",
      "cuanto debo de mayo",
      "cuánto debo de junio",
      "cuanto debo de junio",
      "cuánto debo de julio",
      "cuanto debo de julio",
      "cuánto debo de agosto",
      "cuanto debo de agosto",
      "cuánto debo de septiembre",
      "cuanto debo de septiembre",
      "cuánto debo de octubre",
      "cuanto debo de octubre",
      "cuánto debo de noviembre",
      "cuanto debo de noviembre",
      "cuánto debo de diciembre",
      "cuanto debo de diciembre",
      "cuánto toca pagar",
      "cuanto toca pagar",
      "cuánto me toca",
      "cuanto me toca",
      "cuánto toca",
      "cuanto toca",
      "cuánto es",
      "cuanto es",
      "cuánto sale",
      "cuanto sale",
      "cuánto cuesta",
      "cuanto cuesta",
      "cuánto va a ser",
      "cuanto va a ser",
      "cuánto sería",
      "cuanto seria",
      // Pagos realizados
      "cuánto pago",
      "cuanto pago",
      "cuánto pagué",
      "cuanto pague",
      "cuánto he pagado",
      "cuanto he pagado",
      "ya pagué",
      "ya pague",
      // Qué debo
      "qué debo",
      "que debo",
      "qué debo pagar",
      "que debo pagar",
      "qué me falta",
      "que me falta",
      "qué falta pagar",
      "que falta pagar",
      "cuánto falta",
      "cuanto falta",
      "cuánto me falta",
      "cuanto me falta",
      // Vencimientos (CRÍTICO - debe detectar estas frases)
      "cuándo vence",
      "cuando vence",
      "cuándo tengo que pagar",
      "cuando tengo que pagar",
      "fecha límite",
      "fecha limite",
      "hasta cuándo",
      "hasta cuando",
      "próximo pago",
      "proximo pago",
      "siguiente pago",
      "cuándo vence la",
      "cuando vence la",
      "cuándo vence el",
      "cuando vence el",
      "vencimiento",
      "vencimiento de",
      "vencimiento del",
      // Meses específicos (CRÍTICO para detectar consultas sobre meses)
      "cuota de febrero",
      "cuota de marzo",
      "cuota de abril",
      "cuota de mayo",
      "cuota de junio",
      "cuota de julio",
      "cuota de agosto",
      "cuota de septiembre",
      "cuota de octubre",
      "cuota de noviembre",
      "cuota de diciembre",
      "mensualidad de febrero",
      "mensualidad de marzo",
      "mensualidad de abril",
      "pago de febrero",
      "pago de marzo",
      "pago de abril",
      // Meses
      "cada qué mes",
      "cada que mes",
      "qué meses",
      "que meses",
      "cuáles meses",
      "cuales meses",
      "qué meses faltan",
      "que meses faltan",
      "meses pendientes",
      "meses pagados",
      "meses atrasados",
      // Estado
      "pagos pendientes",
      "deuda",
      "deudas",
      "pendiente",
      "pendientes",
      "estado de pagos",
      "saldo",
      "saldo pendiente",
      "mora",
      "en mora",
      "atrasado",
      "atrasados",
      "al día",
      "al dia",
      // Nuevas palabras clave de pago
      "factura",
      "facturas",
      "recibo",
      "recibos",
      "comprobante",
      "comprobantes",
      "pagar",
      "cancelar",
      "abonar",
      "abono",
      "pagado",
      "cancelado",
      "abonado",
      "cuánto es el total",
      "cuanto es el total",
      "total a pagar",
      "total pendiente",
      "plan de pagos",
      "plan de pago",
      "cronograma de pagos",
      "cuotas atrasadas",
      "pagos realizados",
      "historial de pagos",
      "estado de cuenta",
      "mi estado de cuenta",
    ];

    // Detectar patrones específicos como "cuanto debo del mes de febrero" o "cuanto debo de febrero"
    // Mejorado para detectar incluso si hay "de mi hijo" o "de mi hija" después
    // CRÍTICO: Permitir que haya palabras entre "debo" y "del mes de" o "de"
    const patronCuantoDeboMes =
      /(cuánto|cuanto|cuándo|cuando)\s+debo\s+.*?(del\s+mes\s+de|de)\s+(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(.*(mi hija|mi hijo|mis hijos|mis hijas|de mi hija|de mi hijo|de mis hijos|de mis hijas))?/i.test(
        pregunta,
      );

    // También detectar "cuanto debo del mes de febrero de mi hijo" (palabras en diferente orden)
    const patronCuantoDeboMesHijo =
      /(cuánto|cuanto|cuándo|cuando)\s+debo\s+.*?del\s+mes\s+de\s+(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(mi hijo|mi hija|mis hijos|mis hijas)/i.test(
        pregunta,
      );

    // Detectar también variaciones como "cuanto debo del mes de febrero de mi hijo" sin "de" antes de "mi hijo"
    const patronCuantoDeboMesHijo2 =
      /(cuánto|cuanto|cuándo|cuando)\s+debo\s+.*?del\s+mes\s+de\s+(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*?(mi hijo|mi hija|mis hijos|mis hijas)/i.test(
        pregunta,
      );

    console.log(`  - Patrón "cuanto debo del mes": ${patronCuantoDeboMes}`);
    console.log(
      `  - Patrón "cuanto debo del mes de X de mi hijo": ${patronCuantoDeboMesHijo}`,
    );
    console.log(
      `  - Patrón "cuanto debo del mes de X mi hijo": ${patronCuantoDeboMesHijo2}`,
    );

    const esConsultaPersonalPagos =
      palabrasPagosPersonales.some((p) => preguntaLower.includes(p)) ||
      (mencionaMesEspecifico &&
        (mencionaCuotaOMensualidad || mencionaVencimiento)) ||
      patronCuantoDeboMes ||
      patronCuantoDeboMesHijo ||
      patronCuantoDeboMesHijo2;

    if (esConsultaPersonalPagos) {
      console.log(
        `✅ [clasificarConsulta] Clasificado como base_datos - Consulta personal de pagos detectada`,
      );
      console.log(
        `  [clasificarConsulta] - palabrasPagosPersonales match: ${palabrasPagosPersonales.some((p) => preguntaLower.includes(p))}`,
      );
      console.log(
        `  [clasificarConsulta] - mes + cuota/vencimiento: ${mencionaMesEspecifico && (mencionaCuotaOMensualidad || mencionaVencimiento)}`,
      );
      console.log(
        `  [clasificarConsulta] - patronCuantoDeboMes: ${patronCuantoDeboMes}`,
      );
      console.log(
        `  [clasificarConsulta] - patronCuantoDeboMesHijo: ${patronCuantoDeboMesHijo}`,
      );
      console.log(
        `  [clasificarConsulta] - patronCuantoDeboMesHijo2: ${patronCuantoDeboMesHijo2}`,
      );
      return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.95 };
    } else {
      console.log(
        `⚠️ [clasificarConsulta] NO clasificado como base_datos para pagos personales`,
      );
      console.log(
        `  [clasificarConsulta] - palabrasPagosPersonales match: ${palabrasPagosPersonales.some((p) => preguntaLower.includes(p))}`,
      );
      console.log(
        `  [clasificarConsulta] - mes + cuota/vencimiento: ${mencionaMesEspecifico && (mencionaCuotaOMensualidad || mencionaVencimiento)}`,
      );
      console.log(
        `  [clasificarConsulta] - patronCuantoDeboMes: ${patronCuantoDeboMes}`,
      );
      console.log(
        `  [clasificarConsulta] - patronCuantoDeboMesHijo: ${patronCuantoDeboMesHijo}`,
      );
      console.log(
        `  [clasificarConsulta] - patronCuantoDeboMesHijo2: ${patronCuantoDeboMesHijo2}`,
      );
    }
  }

  // ===== CONSULTAS POR NOMBRE DE ESTUDIANTE =====
  const patronesNombreEstudiante = [
    /pagos?\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /información\s+(de|del|de la|sobre)\s+[a-záéíóúñ]+/i,
    /info\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /datos\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /cuáles?\s+son\s+los\s+pagos\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /cuánto\s+(debe|pag[óo]|tiene|adeuda)\s+[a-záéíóúñ]+/i,
    /cuanto\s+(debe|pago|tiene|adeuda)\s+[a-záéíóúñ]+/i,
    /estado\s+(de|del)\s+pagos?\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /deuda\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /saldo\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /mora\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /mensualidades?\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /cuotas?\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /inscripci[oó]n\s+(de|del|de la)\s+[a-záéíóúñ]+/i,
    /estudiante\s+[a-záéíóúñ]+/i,
    /alumno\s+[a-záéíóúñ]+/i,
    /buscar\s+[a-záéíóúñ]+/i,
  ];

  const mencionaEstudianteEspecifico = patronesNombreEstudiante.some((patron) =>
    patron.test(pregunta),
  );

  if (
    mencionaEstudianteEspecifico ||
    preguntaLower.includes("pagos de") ||
    preguntaLower.includes("pago de")
  ) {
    return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.95 };
  }

  // ===== BASE DE DATOS - CONSULTAS GENERALES =====
  const palabrasDatos = [
    // Conteos y listados
    "cuántos estudiantes",
    "cuantos estudiantes",
    "cuántos alumnos",
    "cuantos alumnos",
    "cuántas inscripciones",
    "cuantas inscripciones",
    "cuántos hay",
    "cuantos hay",
    "listar estudiantes",
    "mostrar estudiantes",
    "ver estudiantes",
    "lista de estudiantes",
    "listar alumnos",
    "mostrar alumnos",
    "todos los estudiantes",
    "todos los alumnos",
    "listado",
    "reporte",
    "resumen",
    "estadísticas",
    "estadisticas",
    // Deudas y pagos
    "deuda",
    "deudas",
    "pendiente de pago",
    "pagos pendientes",
    "morosos",
    "morosidad",
    "en mora",
    "atrasados",
    "quiénes deben",
    "quienes deben",
    "quién debe",
    "quien debe",
    // Sistema y usuarios
    "usuarios del sistema",
    "estudiantes inscritos",
    "total de",
    "total inscritos",
    "cuántos usuarios",
    "cuantos usuarios",
    "roles",
    "administradores",
    // Consultas de pagos específicas
    "cuánto debe",
    "cuanto debe",
    "cuánto pagó",
    "cuanto pago",
    "cuánto debo",
    "cuanto debo",
    "cuánto tengo que pagar",
    "cuanto tengo que pagar",
    "cuándo vence",
    "cuando vence",
    "fecha de vencimiento",
    "fechas de vencimiento",
    "pagos de",
    "pago de",
    "estado de pago",
    "estado de pagos",
    // Ingresos y finanzas
    "ingresos",
    "recaudación",
    "recaudacion",
    "cobros",
    "cobrado",
    "recibido",
    "cuánto se ha cobrado",
    "cuanto se ha cobrado",
    "total cobrado",
    "total recaudado",
    // Inscripciones y gestión
    "inscritos",
    "inscripciones del",
    "inscripciones de",
    "matriculados",
    "nuevos estudiantes",
    "este año",
    "este año",
    "gestión",
    "gestion",
  ];

  const esBaseDatos = palabrasDatos.some((p) => preguntaLower.includes(p));

  if (esBaseDatos) {
    return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.9 };
  }

  // ===== REGLAMENTO Y PROCESOS ACADÉMICOS =====
  // IMPORTANTE: Esta verificación debe ir DESPUÉS de las verificaciones de pagos personales
  // para evitar que se clasifique como reglamento cuando un padre pregunta sobre pagos específicos

  // Detectar si es sobre pagos específicos ANTES de verificar reglamento
  // CRÍTICO: Cualquier pregunta que contenga "cuando vence" + "cuota" + mes es base_datos
  const patronVencimientoCuotaMes =
    /(cuándo vence|cuando vence).*(cuota|mensualidad|pago).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
      pregunta,
    ) ||
    /(cuota|mensualidad|pago).*(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*(cuándo vence|cuando vence|vencimiento)/i.test(
      pregunta,
    );

  const esSobrePagosEspecificos =
    patronVencimientoCuotaMes ||
    ((preguntaLower.includes("pagos") ||
      preguntaLower.includes("cuota") ||
      preguntaLower.includes("mensualidad") ||
      preguntaLower.includes("vencimiento") ||
      preguntaLower.includes("cuándo vence") ||
      preguntaLower.includes("cuando vence") ||
      /vencid[oa]s?|atrasad[oa]s?|moros[oa]s?/.test(preguntaLower)) &&
      (preguntaLower.includes(" de ") ||
        preguntaLower.includes(" del ") ||
        preguntaLower.includes(" de la ") ||
        preguntaLower.includes(" de los ") ||
        preguntaLower.includes(" de las ") ||
        preguntaLower.includes(" mi ") ||
        preguntaLower.includes(" de mi ") ||
        preguntaLower.includes(" mis ") ||
        preguntaLower.includes(" de mis ") ||
        /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
          pregunta,
        ) ||
        /(mi hija|mi hijo|mis hijos|mis hijas|de mi hija|de mi hijo|de mis hijos|de mis hijas)/i.test(
          pregunta,
        )));

  // Si hay infoRemitente y menciona pagos/cuotas/meses/vencimientos, SIEMPRE es base_datos
  if (infoRemitente && esSobrePagosEspecificos) {
    console.log(
      `✅ Clasificado como base_datos - Padre/tutor pregunta sobre pagos específicos (infoRemitente + pagos específicos)`,
    );
    return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.98 };
  }

  // Si menciona pagos específicos (incluso sin infoRemitente), también es base_datos
  if (esSobrePagosEspecificos) {
    console.log(
      `✅ Clasificado como base_datos - Consulta sobre pagos específicos detectada`,
    );
    return { tipo: "base_datos", herramienta: "base_datos", confianza: 0.95 };
  }

  // ===== REGLAMENTO Y PROCESOS ACADÉMICOS =====
  // CRÍTICO: Esta verificación debe ir DESPUÉS de todas las verificaciones de pagos personales
  // Si llegamos aquí y hay infoRemitente con pagos, NO debería llegar nunca
  const palabrasReglamento = [
    // Inscripción y requisitos
    "requisitos",
    "requisito",
    "inscribir",
    "inscripción",
    "inscripcion",
    "inscribirse",
    "documentos",
    "documento",
    "papeles",
    "papelería",
    "papeleria",
    "necesito",
    "necesita",
    "traer",
    "presentar",
    "entregar",
    "qué piden",
    "que piden",
    "qué necesito",
    "que necesito",
    "qué hay que",
    "que hay que",
    // Uniforme y vestimenta
    "uniforme",
    "uniformes",
    "vestimenta",
    "ropa",
    "buzo",
    "chompa",
    "polera",
    // Matrícula y costos generales
    "matrícula",
    "matricula",
    "costo de",
    "precio de",
    "cuánto cuesta inscribir",
    "cuanto cuesta inscribir",
    "valor de",
    "tarifa",
    // Horarios y turnos
    "turno",
    "turnos",
    "horario",
    "horarios",
    "clases",
    "hora de entrada",
    "hora de salida",
    "mañana",
    "tarde",
    "doble turno",
    "jornada",
    // Fechas importantes (PERO NO fechas de vencimiento de cuotas específicas)
    "inicio",
    "cuándo inicia",
    "cuando inicia",
    "cuándo empiezan",
    "cuando empiezan",
    "inicio de clases",
    "primer día",
    "primer dia",
    "apertura",
    "calendario",
    "calendario escolar",
    "año escolar",
    "vacaciones",
    "feriados",
    "receso",
    "trimestre",
    "bimestre",
    // Becas y descuentos
    "becas",
    "beca",
    "descuento",
    "descuentos",
    "rebaja",
    "beneficio",
    "ayuda económica",
    "ayuda economica",
    "apoyo",
    "subvención",
    "subvencion",
    // Aranceles generales (NO específicos de un estudiante)
    "aranceles",
    "arancel",
    "pensión",
    "pension",
    "mensualidad regular",
    "cuánto es la mensualidad",
    // Procesos
    "proceso",
    "paso",
    "pasos",
    "cómo",
    "como",
    "procedimiento",
    "trámite",
    "tramite",
    "cómo hago",
    "como hago",
    "cómo puedo",
    "como puedo",
    "qué hago para",
    "que hago para",
    // Normativa
    "reglamento",
    "normas",
    "norma",
    "política",
    "politica",
    "reglas",
    "conducta",
    "disciplina",
    "sanciones",
    "faltas",
    // Materiales
    "materiales",
    "material",
    "útiles",
    "utiles",
    "escolares",
    "lista de materiales",
    "cuadernos",
    "libros",
    "textos",
    // Actividades
    "actividades",
    "extracurriculares",
    "deportes",
    "talleres",
    "cursos extra",
    "música",
    "musica",
    "danza",
    "arte",
    "inglés",
    "ingles",
    // Servicios
    "transporte",
    "movilidad",
    "bus",
    "almuerzo",
    "comedor",
    "refrigerio",
    "lonchera",
    // Cambios y transferencias
    "transferencia",
    "cambio",
    "cambio de turno",
    "cambio de curso",
    "traslado",
    "reinscripción",
    "reinscripcion",
    "re-inscripción",
    "renovar inscripción",
    // Niveles educativos
    "inicial",
    "kinder",
    "primaria",
    "secundaria",
    "prekinder",
    "pre-kinder",
    "primer grado",
    "segundo grado",
    "nivel",
    "grado",
    "curso",
    // Otros
    "certificado",
    "libreta",
    "notas",
    "calificaciones",
    "boletín",
    "boletin",
    "promoción",
    "promocion",
    "aprobación",
    "aprobacion",
  ];

  // Solo usar reglamento si NO es sobre pagos específicos
  const esReglamento = palabrasReglamento.some((p) =>
    preguntaLower.includes(p),
  );

  if (esReglamento && !esSobrePagosEspecificos) {
    return { tipo: "reglamento", herramienta: "reglamento", confianza: 0.85 };
  }

  // ===== DETECCIÓN DE CONSULTAS AMBIGUAS =====
  // Si la pregunta es muy corta o genérica, ofrecer ayuda
  if (preguntaLower.length < 10) {
    return { tipo: "ayuda", herramienta: "ayuda", confianza: 0.6 };
  }

  // Por defecto: reglamento (pero con confianza más alta por la mejora en detección)
  return { tipo: "reglamento", herramienta: "reglamento", confianza: 0.75 };
}

function detectarAclaracionInscripcion(pregunta, historialConversacion = []) {
  const txt = normalizarTextoComparacion(pregunta);
  if (!txt) return null;

  // Respuestas típicas a la pregunta de aclaración del bot
  const mapa = new Map([
    ["nuevo", "nuevo"],
    ["nueva", "nuevo"],
    ["estudiante nuevo", "nuevo"],
    ["regular", "regular"],
    ["antiguo", "regular"],
    ["antigua", "regular"],
    ["traslado", "traslado"],
    ["transferencia", "traslado"],
    ["cambio", "traslado"],
    ["cambia de unidad educativa", "traslado"],
    ["cambio de unidad educativa", "traslado"],
  ]);

  // Normalizar respuestas de una palabra/frase corta
  const seleccion =
    mapa.get(txt) ||
    (txt.length <= 12 ? mapa.get(txt.split(" ")[0]) || null : null);
  if (!seleccion) return null;

  if (
    !Array.isArray(historialConversacion) ||
    historialConversacion.length === 0
  )
    return null;

  // ¿El bot preguntó recientemente "nuevo o regular"?
  const ultimos = historialConversacion.slice(-16); // Ampliar ventana de búsqueda
  const idxUltimaPreguntaBot = (() => {
    for (let i = ultimos.length - 1; i >= 0; i--) {
      const m = ultimos[i];
      if (!m) continue;
      // Buscar en mensajes del asistente
      const esAsistente =
        m.rol === "asistente" || m.rol === "bot" || m.autor === "assistant";
      if (!esAsistente) continue;
      const textoMsg = m.mensaje || m.texto || m.respuesta || "";
      const t = normalizarTextoComparacion(textoMsg);

      // Detectar CUALQUIER variante donde el bot haya preguntado el tipo de estudiante
      const preguntaTipoEstudiante =
        // Variante 1: "es estudiante nuevo o regular"
        (t.includes("nuevo") &&
          t.includes("regular") &&
          t.includes("estudiante")) ||
        // Variante 2: "Su caso es nuevo, regular o traslado"
        (t.includes("nuevo") &&
          t.includes("regular") &&
          (t.includes("traslado") || t.includes("caso"))) ||
        // Variante 3: "es estudiante nuevo, regular o transferencia"
        (t.includes("nuevo") &&
          t.includes("regular") &&
          t.includes("transferencia")) ||
        // Variante 4: cualquier pregunta que mencione los tres tipos
        (t.includes("nuevo") &&
          t.includes("traslado") &&
          t.includes("regular")) ||
        // Variante 5: preguntas simples tipo "¿es nuevo o regular?"
        (t.includes("nuevo") && t.includes("regular") && t.length < 300) ||
        // Variante 6: Gemini puede formular diferente
        t.includes("tipo de estudiante") ||
        t.includes("tipo estudiante") ||
        (t.includes("primera vez") && t.includes("nuevo"));

      if (preguntaTipoEstudiante) {
        return i;
      }
    }
    return -1;
  })();

  // Si no se encontró la pregunta del bot en el historial PERO el contexto de la sesión
  // es de inscripción (hay mensajes sobre inscripción en los últimos mensajes), también proceder
  const hayContextoInscripcion =
    idxUltimaPreguntaBot === -1 &&
    ultimos.some((m) => {
      const t = normalizarTextoComparacion(m?.mensaje || m?.texto || "");
      return (
        t.includes("inscrip") ||
        t.includes("inscrib") ||
        t.includes("matric") ||
        t.includes("requisit") ||
        t.includes("documento") ||
        t.includes("ingresar")
      );
    });

  if (idxUltimaPreguntaBot === -1 && !hayContextoInscripcion) return null;

  // Buscar la pregunta original del usuario antes de la pregunta del bot
  // Ampliar patrones: no solo "requisit" + "inscrip" sino cualquier pregunta sobre inscripción
  let preguntaOriginal = null;
  const idxInicio =
    idxUltimaPreguntaBot >= 0 ? idxUltimaPreguntaBot : ultimos.length - 1;
  for (let i = idxInicio; i >= 0; i--) {
    const m = ultimos[i];
    if (!m) continue;
    const esUsuario =
      m.rol === "usuario" || m.rol === "user" || m.autor === "user";
    if (!esUsuario) continue;
    const t = normalizarTextoComparacion(m.mensaje || m.texto || "");
    // Patrón ampliado: cualquier pregunta sobre inscripción / requisitos / matrícula
    if (
      t.includes("inscrip") ||
      t.includes("inscrib") ||
      t.includes("matric") ||
      t.includes("requisit") ||
      t.includes("documento") ||
      t.includes("ingresar") ||
      t.includes("entrar") ||
      (t.includes("hijo") &&
        (t.includes("nivel") ||
          t.includes("estudiar") ||
          t.includes("colegio"))) ||
      t.includes("que necesito") ||
      t.includes("que necesita") ||
      t.includes("que piden")
    ) {
      preguntaOriginal = m.mensaje || m.texto;
      break;
    }
  }

  const preguntaReescrita =
    preguntaOriginal && String(preguntaOriginal).trim().length > 0
      ? `${preguntaOriginal}\n\nAclaración del usuario: el estudiante es ${seleccion}${seleccion === "nuevo" ? " (posiblemente no registrado aún)" : ""}.`
      : `¿Qué requisitos necesito para la inscripción? Aclaración: el estudiante es ${seleccion}.`;

  return {
    seleccion,
    preguntaReescrita,
    clasificacionForzada: {
      tipo: "reglamento",
      herramienta: "reglamento",
      confianza: 0.92,
    },
  };
}

function detectarAclaracionDetallesPagos(pregunta, historialConversacion = []) {
  const txt = normalizarTextoComparacion(pregunta);
  if (!txt) return null;
  if (
    !Array.isArray(historialConversacion) ||
    historialConversacion.length === 0
  )
    return null;

  const esAfirmacionCorta =
    /\b(si|sí|claro|ok|dale|de acuerdo|correcto)\b/.test(txt);
  const pideDetalleVencidos =
    /\b(cual|cuales|detalle|detalles|mostrar|muestr|ver)\b/.test(txt) &&
    /\b(vencid|cuota|cuotas|deuda|pendiente)\b/.test(txt);
  const preguntaPorVencidos =
    /\b(cual|cuales)\b/.test(txt) && /\b(vencid)\b/.test(txt);

  if (!(esAfirmacionCorta || pideDetalleVencidos || preguntaPorVencidos)) {
    return null;
  }

  const ultimos = historialConversacion.slice(-12);
  const botPidioDetallesVencidos = ultimos.some((m) => {
    if (!m || m.rol !== "asistente") return false;
    const t = normalizarTextoComparacion(m.mensaje);
    return (
      t.includes("recordatorio") &&
      t.includes("cuota") &&
      t.includes("vencid") &&
      (t.includes("quieres ver los detalles") ||
        t.includes("te gustaria que te muestre los detalles"))
    );
  });

  if (!botPidioDetallesVencidos) return null;

  return {
    preguntaReescrita:
      "Muéstrame el detalle de mis cuotas vencidas, incluyendo mes, fecha de vencimiento, monto esperado, monto pagado y monto pendiente.",
    clasificacionForzada: {
      tipo: "base_datos",
      herramienta: "base_datos",
      confianza: 0.96,
    },
  };
}

// Ejecutar agente
// ─── Carga diferida de servicios de memorias y PDF ──────────────────────────
let _memoriasService = null;
let _reportesPDFService = null;
function getMemoriasService() {
  if (!_memoriasService) _memoriasService = require("./agenteMemoriasService");
  return _memoriasService;
}
function getReportesPDFService() {
  if (!_reportesPDFService)
    _reportesPDFService = require("./agenteReportesPDFService");
  return _reportesPDFService;
}
// ─────────────────────────────────────────────────────────────────────────────

async function ejecutarAgente(
  pregunta,
  pool,
  usuarioId = null,
  infoRemitente = null,
  historialConversacion = [],
  infoUsuario = null,
) {
  const inicio = Date.now();

  // ===== DETECCIÓN DE MÚLTIPLES PREGUNTAS =====
  console.log(`\n🚀 [ejecutarAgente] ========== NUEVA CONSULTA ==========`);
  console.log(`🚀 [ejecutarAgente] Pregunta recibida: "${pregunta}"`);

  // ===== 🆕 CARGAR MEMORIAS ACTIVAS (avisos del admin al agente) =====
  let contextoMemoriaInstitucional = "";
  try {
    const memorias = await getMemoriasService().obtenerMemoriasActivas();
    if (memorias && memorias.length > 0) {
      contextoMemoriaInstitucional =
        "\n\n===== AVISOS INSTITUCIONALES ACTIVOS (recordados por el agente) =====\n";
      contextoMemoriaInstitucional +=
        "El admin/director ha comunicado los siguientes avisos. ÚSALOS al responder preguntas relacionadas:\n";
      memorias.forEach((m, idx) => {
        const fechaFin = m.fecha_fin
          ? ` (hasta ${new Date(m.fecha_fin).toLocaleDateString("es-BO")})`
          : "";
        contextoMemoriaInstitucional += `• [${m.tipo.toUpperCase()}] ${m.contenido}${fechaFin}\n`;
      });
      contextoMemoriaInstitucional +=
        "====================================================\n";
      console.log(
        `🧠 [ejecutarAgente] ${memorias.length} memoria(s) institucional(es) cargada(s)`,
      );
    }
  } catch (memErr) {
    console.warn(
      "⚠️ [ejecutarAgente] No se pudieron cargar memorias:",
      memErr.message,
    );
  }

  // ===== 🆕 DETECCIÓN DE SOLICITUD DE REPORTE PDF =====
  const preguntaLowerPDF = (pregunta || "").toLowerCase();
  const esSolicitudPDF =
    infoUsuario &&
    ["Administrador", "Director", "Secretaria"].includes(infoUsuario.rol) &&
    /reporte|listado|lista|informe|pdf|generar.*lista|dame.*lista|puedes.*lista|exportar|imprimir/.test(
      preguntaLowerPDF,
    ) &&
    /estudiante|inscrit|nivel|turno|pago|pendiente|deuda|moros|inscripci/.test(
      preguntaLowerPDF,
    );

  if (esSolicitudPDF) {
    console.log("📄 [ejecutarAgente] Detectada solicitud de reporte PDF");
    try {
      const reporteService = getReportesPDFService();
      const resultado = await reporteService.generarReporte(pregunta);
      const tiempo = Date.now() - inicio;
      if (!resultado.ok) {
        return {
          respuesta: resultado.message,
          herramienta: "reporte_pdf",
          clasificacion: "reporte_pdf",
          tiempo_ms: tiempo,
        };
      }
      // Construir URL absoluta del PDF (Railway provee RAILWAY_PUBLIC_DOMAIN)
      // Sin esto, el link apunta al frontend (Vercel) en vez del backend (Railway)
      const backendDomain = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.BACKEND_URL ||
          `http://localhost:${process.env.PORT || 3001}`;
      const urlDescarga = `${backendDomain}/api/reportes-agente/descargar/${encodeURIComponent(resultado.nombreArchivo)}`;
      let mensajeRespuesta = `✅ *Reporte generado exitosamente*\n\n`;
      mensajeRespuesta += `📊 *Tipo:* ${resultado.tipo || "lista"}\n`;
      mensajeRespuesta += `👥 *Total registros:* ${resultado.total || 0}\n`;
      if (resultado.totalPendiente)
        mensajeRespuesta += `💰 *Total pendiente:* Bs. ${parseFloat(resultado.totalPendiente).toFixed(2)}\n`;
      mensajeRespuesta += `\n📥 *Descarga (clic para abrir):*\n${urlDescarga}\n`;
      mensajeRespuesta += `\n_El archivo estará disponible por 2 horas._`;
      return {
        respuesta: mensajeRespuesta,
        herramienta: "reporte_pdf",
        clasificacion: "reporte_pdf",
        tiempo_ms: tiempo,
        pdf_url: urlDescarga,
        pdf_path: resultado.rutaPDF,
        pdf_nombre: resultado.nombreArchivo,
      };
    } catch (pdfErr) {
      console.error("❌ [ejecutarAgente] Error generando PDF:", pdfErr.message);
      const tiempo = Date.now() - inicio;
      return {
        respuesta: `❌ No pude generar el reporte: ${pdfErr.message}`,
        herramienta: "reporte_pdf",
        clasificacion: "reporte_pdf",
        tiempo_ms: tiempo,
      };
    }
  }

  // ===== NORMALIZAR ERRORES ORTOGRÁFICOS EN MESES (antes de clasificar) =====
  // Así "cuanto debo de marsso?" se clasifica como base_datos y no como reglamento (evita eco de la pregunta por LLM)
  try {
    const { preguntaNormalizada } = normalizarMesesEnPregunta(pregunta);
    if (preguntaNormalizada && preguntaNormalizada !== pregunta) {
      console.log(
        `📝 [ejecutarAgente] Pregunta normalizada (meses): "${preguntaNormalizada}"`,
      );
      pregunta = preguntaNormalizada;
    }
  } catch (e) {
    // No bloquear el flujo
  }

  // ===== PRIVACIDAD: BLOQUEAR EXTRACCIÓN DE DATOS SENSIBLES MASIVOS =====
  // Ejemplos a bloquear:
  // - "muéstrame todos los teléfonos de padres"
  // - "dame la lista de contactos de madres/tutores"
  try {
    const preguntaPriv = normalizarTextoComparacion(pregunta);
    const pideListadoMasivo =
      /(todos|todas|lista|listado|base de datos|exportar|descargar)/i.test(
        preguntaPriv,
      );
    const pideContactoSensible =
      /(telefono|telefonos|celular|celulares|contacto|contactos|numero|numeros|whatsapp)/i.test(
        preguntaPriv,
      );
    const objetivoFamilias =
      /(padre|padres|madre|madres|tutor|tutores|apoderado|apoderados|familia|familias)/i.test(
        preguntaPriv,
      );

    if (pideListadoMasivo && pideContactoSensible && objetivoFamilias) {
      const tiempo = Date.now() - inicio;
      return {
        respuesta:
          "Lo siento, no puedo compartir teléfonos ni contactos de padres/tutores, ya que es información sensible y confidencial. Si necesita comunicarse con una familia en particular, por favor gestione la solicitud por Secretaría con la autorización correspondiente.",
        herramienta: "privacidad",
        clasificacion: "privacidad_datos_sensibles",
        tiempo_ms: tiempo,
      };
    }
  } catch (_) {
    // No bloquear el flujo si falla esta validación
  }

  // ===== CONTINUIDAD: respuestas cortas tipo "nuevo/regular" =====
  let clasificacionForzada = null;
  try {
    const aclaracionPagos = detectarAclaracionDetallesPagos(
      pregunta,
      historialConversacion,
    );
    if (aclaracionPagos) {
      console.log(
        "🔁 [ejecutarAgente] Aclaración detectada para detalle de cuotas vencidas. Reescribiendo pregunta para continuar el flujo.",
      );
      pregunta = aclaracionPagos.preguntaReescrita;
      clasificacionForzada = aclaracionPagos.clasificacionForzada;
    }

    const aclaracion = detectarAclaracionInscripcion(
      pregunta,
      historialConversacion,
    );
    if (!clasificacionForzada && aclaracion) {
      console.log(
        `🔁 [ejecutarAgente] Aclaración detectada: "${aclaracion.seleccion}". Reescribiendo pregunta para continuar el flujo.`,
      );
      pregunta = aclaracion.preguntaReescrita;
      clasificacionForzada = aclaracion.clasificacionForzada;
    }
  } catch (e) {
    // No bloquear el flujo por errores en detección de aclaraciones
  }

  // Detectar si el mensaje contiene múltiples preguntas
  const analisisPreguntas = detectarMultiplesPreguntas(pregunta);

  // Si hay múltiples preguntas, procesarlas de forma especial
  if (analisisPreguntas.esMultiple) {
    console.log(
      `\n🔀 [ejecutarAgente] MÚLTIPLES PREGUNTAS DETECTADAS (${analisisPreguntas.preguntas.length})`,
    );
    console.log(`🔀 [ejecutarAgente] Procesando en modo múltiple...`);

    try {
      // Clasificar todas las preguntas
      const preguntasClasificadas = clasificarPreguntasMultiples(
        analisisPreguntas.preguntas,
        infoRemitente,
      );

      // Preparar contexto del historial
      let contextoHistorial = "";
      if (historialConversacion && historialConversacion.length > 0) {
        contextoHistorial = "\n\nHISTORIAL DE CONVERSACIÓN PREVIA:\n";
        historialConversacion.slice(-5).forEach((msg) => {
          const rol = msg.rol === "usuario" ? "Usuario" : "Asistente";
          contextoHistorial += `${rol}: ${msg.mensaje}\n`;
        });
        contextoHistorial +=
          "\nIMPORTANTE: Considera el historial anterior para dar respuestas coherentes y contextualizadas.\n";
      }

      // Procesar todas las preguntas manteniendo contexto
      const respuestasIndividuales = await procesarPreguntasEnContexto(
        preguntasClasificadas,
        pool,
        infoRemitente,
        contextoHistorial,
        infoUsuario,
      );

      // Generar respuesta estructurada final
      const respuestaFinal = generarRespuestaEstructurada(
        respuestasIndividuales,
        analisisPreguntas.preguntas,
        analisisPreguntas.inicioConSaludo,
      );

      // Agregar sugerencias proactivas si es apropiado
      let respuestaConSugerencias = respuestaFinal;
      if (infoRemitente) {
        try {
          const sugerencias = await generarSugerenciasProactivas(
            infoRemitente,
            pool,
          );
          if (sugerencias) {
            respuestaConSugerencias += sugerencias;
          }
        } catch (error) {
          console.error("Error generando sugerencias proactivas:", error);
        }
      }

      const tiempo = Date.now() - inicio;
      console.log(
        `\n✅ [ejecutarAgente] Procesamiento múltiple completado en ${tiempo}ms`,
      );

      return {
        respuesta: respuestaConSugerencias,
        herramienta: "multiple",
        clasificacion: "multiple_preguntas",
        tiempo_ms: tiempo,
        cantidad_preguntas: analisisPreguntas.preguntas.length,
        preguntas_individuales: analisisPreguntas.preguntas,
      };
    } catch (error) {
      console.error(
        `❌ [ejecutarAgente] Error procesando múltiples preguntas:`,
        error,
      );
      // Si falla el procesamiento múltiple, intentar con el flujo normal
      console.log(`⚠️ [ejecutarAgente] Fallback a procesamiento simple`);
    }
  }

  // ===== PROCESAMIENTO SIMPLE (UNA PREGUNTA) =====
  console.log(`\n📝 [ejecutarAgente] Procesamiento simple (una pregunta)`);

  // Verificar cache (solo si no hay historial, para mantener coherencia conversacional)
  if (historialConversacion.length === 0) {
    // No usar cache para consultas dinámicas (pagos/deudas por mes), porque cambian con el tiempo y dependen de BD.
    const esConsultaDinamicaPagos =
      /(pagar|pagos?|debo|deuda|pendiente|cuota|mensualidad|saldo)\b/i.test(
        pregunta,
      ) &&
      /(febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(
        pregunta,
      );

    const preguntaHash = crypto
      .createHash("md5")
      .update(pregunta.toLowerCase().trim())
      .digest("hex");
    if (!esConsultaDinamicaPagos && cacheRespuestas.has(preguntaHash)) {
      const tiempo = Date.now() - inicio;
      return {
        respuesta: cacheRespuestas.get(preguntaHash),
        herramienta: "cache",
        clasificacion: "cache",
        tiempo_ms: tiempo,
      };
    }
  }

  // Clasificar consulta (pasar infoRemitente para mejor clasificación)
  console.log(`🔍 [ejecutarAgente] Clasificando pregunta: "${pregunta}"`);
  console.log(
    `🔍 [ejecutarAgente] Info remitente disponible: ${infoRemitente ? "Sí" : "No"}`,
  );
  if (infoRemitente) {
    console.log(`🔍 [ejecutarAgente] Info remitente:`, {
      nombre_padre: infoRemitente.nombre_padre,
      nombre_madre: infoRemitente.nombre_madre,
      nombre_autorizado: infoRemitente.nombre_autorizado,
    });
  }
  const clasificacion =
    clasificacionForzada || clasificarConsulta(pregunta, infoRemitente);
  console.log(`🔍 [ejecutarAgente] Clasificación resultante:`, clasificacion);
  console.log(
    `🔍 Clasificación: ${clasificacion.tipo} (${clasificacion.herramienta}) - Confianza: ${clasificacion.confianza}`,
  );

  // Analizar sentimiento ANTES de procesar
  const analisisSentimiento = analizarSentimiento(
    pregunta,
    historialConversacion,
  );

  // Preparar contexto del historial
  let contextoHistorial = "";
  if (historialConversacion && historialConversacion.length > 0) {
    contextoHistorial = "\n\nHISTORIAL DE CONVERSACIÓN PREVIA:\n";
    historialConversacion.slice(-5).forEach((msg) => {
      const rol = msg.rol === "usuario" ? "Usuario" : "Asistente";
      contextoHistorial += `${rol}: ${msg.mensaje}\n`;
    });
    contextoHistorial +=
      "\nIMPORTANTE: Considera el historial anterior para dar respuestas coherentes y contextualizadas. Si el usuario hace referencia a algo mencionado antes, usa ese contexto.\n";

    // Agregar contexto de sentimiento si hay frustración
    if (analisisSentimiento.tieneFrustracion) {
      contextoHistorial +=
        "\n⚠️ ATENCIÓN: El usuario muestra signos de frustración. Sé empático, claro y ofrece ayuda adicional o escalamiento si es necesario.\n";
    }
  }

  // 🧠 Agregar memorias institucionales al contexto
  if (contextoMemoriaInstitucional) {
    contextoHistorial =
      contextoMemoriaInstitucional + (contextoHistorial || "");
  }

  // Preparar contexto del usuario autenticado
  let contextoUsuario = "";
  if (infoUsuario) {
    contextoUsuario = `\n\nINFORMACIÓN DEL USUARIO AUTENTICADO:\n`;
    contextoUsuario += `- Nombre: ${infoUsuario.nombre || "N/A"}\n`;
    contextoUsuario += `- Usuario: ${infoUsuario.usuario || "N/A"}\n`;
    contextoUsuario += `- Rol: ${infoUsuario.rol || "N/A"}\n`;
    contextoUsuario += `\nIMPORTANTE: Personaliza las respuestas según el rol del usuario. `;

    // Restricciones según rol
    if (infoUsuario.rol === "Cajero") {
      contextoUsuario += `Este usuario es Cajero, tiene acceso limitado. No debe ver información sensible de otros usuarios o configuraciones del sistema. `;
    } else if (infoUsuario.rol === "Secretaria") {
      contextoUsuario += `Este usuario es Secretaria, puede ver información de estudiantes y pagos, pero no configuraciones administrativas. `;
    } else if (
      infoUsuario.rol === "Administrador" ||
      infoUsuario.rol === "Director"
    ) {
      contextoUsuario += `Este usuario tiene acceso completo al sistema. `;
    }

    contextoUsuario += `Puedes referirte a él por su nombre cuando sea apropiado.\n`;
  }

  // Seleccionar y ejecutar herramienta
  let respuesta;
  let herramienta;

  try {
    if (clasificacion.herramienta === "fecha_hora") {
      herramienta = new HerramientaFechaHora();
      respuesta = await herramienta.ejecutar(pregunta, {
        historial: contextoHistorial,
      });
    } else if (clasificacion.herramienta === "ayuda") {
      // Nueva herramienta de ayuda y bienvenida
      herramienta = new HerramientaAyuda();
      respuesta = await herramienta.ejecutar(
        pregunta,
        infoRemitente,
        contextoHistorial,
        infoUsuario,
      );
    } else if (clasificacion.herramienta === "base_datos") {
      herramienta = new HerramientaBaseDatos(pool);
      respuesta = await herramienta.ejecutar(
        pregunta,
        infoRemitente,
        contextoHistorial,
        infoUsuario,
      );
    } else if (clasificacion.herramienta === "envio_masivo") {
      // ===== ENVÍO MASIVO DE MENSAJES =====
      const { obtenerInstancia } = require("./whatsappServiceSingleton");
      const whatsappService = obtenerInstancia();

      if (
        !infoUsuario ||
        (infoUsuario.rol !== "Administrador" && infoUsuario.rol !== "Director")
      ) {
        respuesta =
          "⚠️ Solo administradores y directores pueden enviar mensajes masivos.";
      } else {
        const params = extraerParametrosEnvioMasivo(pregunta);

        if (params.error) {
          respuesta = `❌ ${params.error}\n\n**Ejemplos de uso:**\n• "Envía a todos los padres que mañana no hay clases"\n• "Envía a PRIMER NIVEL que hay reunión el viernes"`;
        } else {
          try {
            const { niveles, mensaje } = params;
            const padres = await obtenerPadresPorNivel(niveles, pool);

            if (padres.length === 0) {
              respuesta = `No se encontraron estudiantes inscritos para los niveles especificados.`;
            } else if (
              !whatsappService ||
              !(await whatsappService.isClientReady())
            ) {
              respuesta = `⚠️ WhatsApp no está conectado. Por favor, conéctalo primero desde el panel de administración.`;
            } else {
              const nivelesTexto =
                niveles === null ? "TODOS los niveles" : niveles.join(", ");

              // Enviar mensajes en background
              (async () => {
                let enviados = 0,
                  errores = 0;
                console.log(
                  `📨 Iniciando envío masivo a ${padres.length} padres...`,
                );

                for (const padre of padres) {
                  try {
                    const telefono =
                      padre.telefono_padre || padre.telefono_madre;
                    if (telefono) {
                      const mensajePersonalizado = personalizarMensaje(
                        mensaje,
                        padre,
                      );
                      await whatsappService.enviarMensajeANumero(
                        telefono,
                        mensajePersonalizado,
                      );
                      enviados++;
                      console.log(
                        `✅ [${enviados}/${padres.length}] Enviado a ${padre.nombre_padre || padre.nombre_madre}`,
                      );
                      await new Promise((r) => setTimeout(r, 2000)); // 2 seg entre mensajes
                    } else {
                      errores++;
                    }
                  } catch (error) {
                    console.error(`❌ Error enviando:`, error.message);
                    errores++;
                  }
                }

                console.log(
                  `\n📊 REPORTE FINAL: ${enviados} enviados, ${errores} errores, ${padres.length} total`,
                );
              })();

              respuesta =
                `📨 **Envío Masivo Iniciado**\n\n` +
                `📚 **Destinatarios:** ${nivelesTexto}\n` +
                `👥 **Total:** ${padres.length} padres/tutores\n` +
                `📝 **Mensaje:** "${mensaje}"\n\n` +
                `⏳ **Estado:** Enviando (2 segundos entre mensajes)...\n\n` +
                `✅ El envío se está procesando en segundo plano. Revisa los logs para el reporte final.`;
            }
          } catch (error) {
            console.error("❌ Error en envío masivo:", error);
            respuesta = `❌ Error al procesar el envío masivo: ${error.message}`;
          }
        }
      }
    } else if (clasificacion.herramienta === "notificacion") {
      // Para comandos de notificación, retornar instrucciones para usar el endpoint
      respuesta =
        `He detectado que quieres enviar una notificación. Para enviar notificaciones a padres y tutores, por favor usa el endpoint de notificaciones manuales:\n\n` +
        `POST /api/notificaciones/enviar-manual\n\n` +
        `Ejemplo de uso:\n` +
        `{\n` +
        `  "mensaje": "Su mensaje aquí. Puede usar {nombre} y {estudiante} para personalizar.",\n` +
        `  "fecha": "2026-01-02",\n` +
        `  "filtros": {\n` +
        `    "nivel_id": 1,\n` +
        `    "curso_id": 2\n` +
        `  }\n` +
        `}\n\n` +
        `O puedes decirme directamente qué mensaje quieres enviar y yo lo procesaré.`;
      herramienta = { nombre: "notificacion" };
    } else {
      herramienta = new HerramientaReglamento();
      respuesta = await herramienta.ejecutar(
        pregunta,
        infoRemitente,
        contextoHistorial,
        infoUsuario,
      );
    }

    // Aplicar mejoras contextuales
    const longitudRespuesta = determinarLongitudRespuesta(
      pregunta,
      clasificacion.tipo,
    );
    respuesta = mejorarFormatoRespuesta(
      respuesta,
      clasificacion.tipo,
      longitudRespuesta,
      pregunta,
    );

    // Aplicar análisis de sentimiento (respuesta empática si hay frustración)
    respuesta = generarRespuestaEmpatica(analisisSentimiento, respuesta);

    // Agregar sugerencias proactivas si es apropiado (solo para padres/tutores y si no hay frustración)
    if (
      infoRemitente &&
      !analisisSentimiento.tieneFrustracion &&
      !analisisSentimiento.necesitaEscalamiento
    ) {
      try {
        const sugerencias = await generarSugerenciasProactivas(
          infoRemitente,
          pool,
        );
        if (sugerencias) {
          respuesta += sugerencias;
        }
      } catch (error) {
        console.error("Error generando sugerencias proactivas:", error);
        // No fallar si las sugerencias no se pueden generar
      }
    }

    // Si necesita escalamiento, agregar información de contacto
    if (analisisSentimiento.necesitaEscalamiento) {
      respuesta += "\n\n📞 *Información de contacto:*\n";
      respuesta += "• Secretaría: [Número de teléfono]\n";
      respuesta += "• Horario de atención: Lunes a Viernes, 8:00 - 17:00\n";
      respuesta += "• Email: [Email de contacto]";
    }

    // Guardar en cache solo si no hay historial y no hay frustración (para evitar cachear respuestas empáticas)
    // Además, no cachear respuestas dinámicas de BD (pagos, etc.)
    if (
      historialConversacion.length === 0 &&
      !analisisSentimiento.tieneFrustracion &&
      herramienta.nombre !== "base_datos"
    ) {
      const preguntaHash = crypto
        .createHash("md5")
        .update(pregunta.toLowerCase().trim())
        .digest("hex");
      cacheRespuestas.set(preguntaHash, respuesta);
    }

    const tiempo = Date.now() - inicio;
    return {
      respuesta,
      herramienta: herramienta.nombre,
      clasificacion: clasificacion.tipo,
      tiempo_ms: tiempo,
      sentimiento: analisisSentimiento, // Incluir análisis de sentimiento en la respuesta
      necesitaEscalamiento: analisisSentimiento.necesitaEscalamiento,
    };
  } catch (error) {
    const tiempo = Date.now() - inicio;
    return {
      respuesta: `Error al procesar la consulta: ${error.message}`,
      herramienta: clasificacion.herramienta,
      clasificacion: clasificacion.tipo,
      tiempo_ms: tiempo,
    };
  }
}

// Registrar consulta en logs
function registrarConsulta(
  pregunta,
  respuesta,
  herramienta,
  clasificacion,
  tiempoMs,
  usuarioId = null,
) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    pregunta,
    herramienta,
    clasificacion,
    tiempo_respuesta_ms: tiempoMs,
    usuario_id: usuarioId,
  };

  let logs = [];
  if (fs.existsSync(RUTA_LOGS)) {
    try {
      const contenido = fs.readFileSync(RUTA_LOGS, "utf-8");
      logs = JSON.parse(contenido);
    } catch (error) {
      console.warn("Error al leer logs, creando nuevo archivo");
      logs = [];
    }
  }

  logs.push(logEntry);

  // Mantener solo los últimos 1000 logs
  if (logs.length > 1000) {
    logs = logs.slice(-1000);
  }

  try {
    fs.writeFileSync(RUTA_LOGS, JSON.stringify(logs, null, 2), "utf-8");
  } catch (error) {
    console.error("⚠️  Error al guardar log:", error);
  }
}

// Obtener reportes de consultas
function obtenerReportesConsultas(limite = 100) {
  if (!fs.existsSync(RUTA_LOGS)) {
    return { consultas: [], total: 0 };
  }

  try {
    const contenido = fs.readFileSync(RUTA_LOGS, "utf-8");
    const logs = JSON.parse(contenido);

    const total = logs.length;
    const porHerramienta = {};
    const porClasificacion = {};

    logs.slice(-limite).forEach((log) => {
      const herramienta = log.herramienta || "desconocida";
      const clasificacion = log.clasificacion || "desconocida";
      porHerramienta[herramienta] = (porHerramienta[herramienta] || 0) + 1;
      porClasificacion[clasificacion] =
        (porClasificacion[clasificacion] || 0) + 1;
    });

    return {
      total,
      ultimas_consultas: logs.slice(-limite),
      estadisticas: {
        por_herramienta: porHerramienta,
        por_clasificacion: porClasificacion,
      },
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Inicializar agente (cargar reglamento y embeddings)
async function inicializarAgente() {
  // Log silenciado
  try {
    await cargarReglamentoYEmbeddings();
    // Servicio de IA listo

    // Verificar que el servicio de IA está configurado

    // Log silenciado
  } catch (error) {
    console.error("❌ Error al inicializar agente:", error);
    throw error;
  }
}

module.exports = {
  // Función principal que ejecuta el agente inteligente: procesa una pregunta del usuario,
  // la clasifica, busca información relevante (reglamento, base de datos, etc.) y genera una respuesta usando IA
  ejecutarAgente,

  // Registra una consulta en el archivo de logs con información sobre la pregunta, respuesta,
  // herramienta utilizada, clasificación y tiempo de respuesta
  registrarConsulta,

  // Obtiene reportes y estadísticas de las consultas realizadas al agente,
  // incluyendo total de consultas, últimas consultas y estadísticas por herramienta/clasificación
  obtenerReportesConsultas,

  // Inicializa el agente cargando el reglamento y los embeddings desde la base de datos
  // o desde archivos. Debe ejecutarse al iniciar el servidor.
  inicializarAgente,

  // Obtiene el esquema completo de la base de datos (tablas, columnas, tipos de datos)
  // para que el agente pueda entender la estructura y hacer consultas SQL correctas
  obtenerEsquemaBd,

  // Clasifica una consulta del usuario para determinar qué herramienta usar:
  // 'base_datos' (consultas sobre pagos, estudiantes), 'reglamento' (preguntas sobre normas),
  // o 'general' (preguntas generales). Retorna tipo, herramienta y nivel de confianza.
  clasificarConsulta,

  // Recarga los documentos del reglamento desde la base de datos y recalcula los embeddings.
  // Útil cuando se actualizan documentos y se necesita refrescar el cache.
  recargarDocumentos,

  // Procesa un documento recién subido: divide el texto en chunks semánticos,
  // calcula embeddings para cada chunk y los guarda en la base de datos.
  // Retorna el número de chunks y embeddings creados.
  procesarYGuardarChunksEmbeddings,
};
