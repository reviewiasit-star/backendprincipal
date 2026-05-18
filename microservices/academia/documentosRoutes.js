// ===== RUTAS PARA GESTIÓN DE DOCUMENTOS DEL AGENTE INTELIGENTE =====

const express = require("express");
const multer = require("multer");
const documentosService = require("./documentosService");
const { authMiddleware } = require("../../middleware/auth");
const {
  recargarDocumentos,
  procesarYGuardarChunksEmbeddings,
} = require("./agenteInteligente");

const router = express.Router();

// Mapa para rastrear el estado del procesamiento en segundo plano
const estadoProcesamiento = new Map(); // documentoId -> { fase, progreso, completado, error }

// Configurar multer para manejar archivos en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB máximo (reglamentos pueden ser grandes)
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|docx|doc|txt/;
    const extname = allowedTypes.test(
      require("path").extname(file.originalname).toLowerCase(),
    );
    const mimetype =
      allowedTypes.test(file.mimetype) ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.mimetype === "application/msword";

    if (extname || mimetype) {
      return cb(null, true);
    } else {
      cb(new Error("Solo se permiten archivos PDF, Word (DOCX) o TXT"));
    }
  },
});

// Middleware para verificar permisos (solo Administrador y Director)
const verificarPermisos = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      message: "Usuario no autenticado",
    });
  }

  if (!["Administrador", "Director"].includes(req.user.rol)) {
    return res.status(403).json({
      ok: false,
      message: "Solo Administradores y Directores pueden gestionar documentos",
    });
  }

  next();
};

// Subir nuevo documento
router.post(
  "/subir",
  authMiddleware,
  verificarPermisos,
  upload.single("documento"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: "No se proporcionó ningún archivo",
        });
      }

      const { tipo } = req.body;
      const usuarioId = req.user.id;

      // 1️⃣ Guardar el documento (texto extraído incluido) — SIEMPRE es rápido
      const documento = await documentosService.guardarDocumento(
        req.file,
        tipo || "otros",
        usuarioId,
      );

      const textoCompleto = documento.texto_completo;
      const caracteresExtraidos = textoCompleto ? textoCompleto.length : 0;
      console.log(
        `📝 Texto extraído: ${caracteresExtraidos.toLocaleString()} caracteres para "${documento.nombre}"`,
      );

      // Registrar estado inicial del procesamiento
      estadoProcesamiento.set(documento.id, {
        fase: "guardado",
        progreso: 0,
        total: 0,
        completado: false,
        error: null,
        inicio: Date.now(),
      });

      // 2️⃣ Responder inmediatamente al cliente — NO esperamos chunks/embeddings
      const { texto_completo, ...docSinTexto } = documento;
      res.json({
        ok: true,
        message: `Documento guardado exitosamente (${(caracteresExtraidos / 1000).toFixed(1)}K caracteres). Los fragmentos se están procesando en segundo plano.`,
        documento: docSinTexto,
        procesando_en_background: true,
      });

      // 3️⃣ Procesar chunks + embeddings EN SEGUNDO PLANO (sin bloquear la respuesta HTTP)
      // Esto evita que Railway corte la conexión por timeout al procesar documentos grandes
      setImmediate(async () => {
        try {
          if (!textoCompleto || textoCompleto.trim().length === 0) {
            estadoProcesamiento.set(documento.id, {
              fase: "completado",
              completado: true,
              error: null,
            });
            return;
          }

          console.log(
            `⏳ [Background] Iniciando procesamiento de chunks para documento ${documento.id} "${documento.nombre}"`,
          );
          estadoProcesamiento.set(documento.id, {
            fase: "chunking",
            progreso: 0,
            completado: false,
            error: null,
          });

          const { chunks, embeddings } = await procesarYGuardarChunksEmbeddings(
            documento.id,
            textoCompleto,
            documento.nombre,
            documento.tipo,
          );

          console.log(
            `✅ [Background] Documento ${documento.id}: ${chunks} fragmentos, ${embeddings} embeddings generados`,
          );
          estadoProcesamiento.set(documento.id, {
            fase: "completado",
            progreso: chunks,
            total: chunks,
            completado: true,
            error: null,
            duracion_ms:
              Date.now() -
              (estadoProcesamiento.get(documento.id)?.inicio || Date.now()),
          });

          // Recargar documentos en el agente ahora que los chunks están listos
          try {
            await recargarDocumentos();
            console.log(
              `✅ [Background] Agente recargado con documento ${documento.id}`,
            );
          } catch (reloadError) {
            console.warn(
              `⚠️ [Background] No se pudo recargar agente:`,
              reloadError.message,
            );
          }
        } catch (bgError) {
          console.error(
            `❌ [Background] Error procesando chunks del documento ${documento.id}:`,
            bgError.message,
          );
          estadoProcesamiento.set(documento.id, {
            fase: "error",
            completado: false,
            error: bgError.message,
          });
          // Aun así recargar el agente para que use el texto_extraido directamente
          try {
            await recargarDocumentos();
          } catch (_) {}
        }
      });
    } catch (error) {
      const esDuplicado =
        error.message &&
        error.message.includes("Ya existe un documento activo");
      if (!esDuplicado) {
        console.error("Error al subir documento:", error);
      }
      return res.status(esDuplicado ? 409 : 500).json({
        ok: false,
        message: error.message || "Error al procesar el documento",
        error: error.message,
      });
    }
  },
);

// Estado del procesamiento en background (para saber si los chunks ya están listos)
router.get(
  "/procesamiento/:id",
  authMiddleware,
  verificarPermisos,
  (req, res) => {
    const id = parseInt(req.params.id);
    const estado = estadoProcesamiento.get(id);
    if (!estado) {
      return res.json({
        ok: true,
        estado: "desconocido",
        message: "No hay información de procesamiento para este documento",
      });
    }
    return res.json({ ok: true, ...estado });
  },
);

// Listar todos los documentos
router.get("/listar", authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { activos } = req.query;
    const soloActivos = activos !== "false";

    const documentos = await documentosService.obtenerDocumentos(soloActivos);

    // No incluir el texto completo en la lista (solo preview)
    const documentosLista = documentos.map((doc) => ({
      id: doc.id,
      nombre: doc.nombre,
      tipo: doc.tipo,
      formato: doc.formato,
      tamanio_bytes: doc.tamanio_bytes,
      activo: doc.activo,
      creado_en: doc.creado_en,
      actualizado_en: doc.actualizado_en,
      preview: doc.texto_extraido
        ? doc.texto_extraido.substring(0, 200) + "..."
        : "",
    }));

    return res.json({
      ok: true,
      documentos: documentosLista,
      total: documentosLista.length,
    });
  } catch (error) {
    console.error("Error al listar documentos:", error);
    return res.status(500).json({
      ok: false,
      message: "Error al listar documentos",
      error: error.message,
    });
  }
});

// Regenerar chunks y embeddings de un documento (para aplicar nueva configuración de tamaño)
router.post(
  "/:id/regenerar-chunks",
  authMiddleware,
  verificarPermisos,
  async (req, res) => {
    try {
      const { id } = req.params;
      const doc = await documentosService.obtenerDocumentoPorId(parseInt(id));
      if (!doc) {
        return res
          .status(404)
          .json({ ok: false, message: "Documento no encontrado" });
      }
      if (!doc.texto_extraido || doc.texto_extraido.trim().length === 0) {
        return res.status(400).json({
          ok: false,
          message: "El documento no tiene texto extraído para regenerar chunks",
        });
      }

      const { chunks, embeddings } = await procesarYGuardarChunksEmbeddings(
        parseInt(id),
        doc.texto_extraido,
        doc.nombre,
        doc.tipo,
      );
      await recargarDocumentos();

      return res.json({
        ok: true,
        message: `Chunks regenerados: ${chunks} fragmentos, ${embeddings} embeddings. El agente ha sido actualizado.`,
        chunks,
        embeddings,
      });
    } catch (error) {
      console.error("Error al regenerar chunks:", error);
      return res.status(500).json({
        ok: false,
        message: "Error al regenerar chunks",
        error: error.message,
      });
    }
  },
);

// Obtener chunks de un documento (capítulo, título, texto, etc.)
router.get(
  "/:id/chunks",
  authMiddleware,
  verificarPermisos,
  async (req, res) => {
    try {
      const { id } = req.params;
      const chunks = await documentosService.obtenerChunksPorDocumento(
        parseInt(id),
      );

      return res.json({
        ok: true,
        chunks,
        total: chunks.length,
      });
    } catch (error) {
      console.error("Error al obtener chunks:", error);
      return res.status(500).json({
        ok: false,
        message: "Error al obtener chunks del documento",
        error: error.message,
      });
    }
  },
);

// Obtener documento por ID (con texto completo)
router.get("/:id", authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;
    const documento = await documentosService.obtenerDocumentoPorId(id);

    if (!documento) {
      return res.status(404).json({
        ok: false,
        message: "Documento no encontrado",
      });
    }

    return res.json({
      ok: true,
      documento,
    });
  } catch (error) {
    console.error("Error al obtener documento:", error);
    return res.status(500).json({
      ok: false,
      message: "Error al obtener documento",
      error: error.message,
    });
  }
});

// Eliminar documento (marcar como inactivo o eliminar físicamente)
router.delete("/:id", authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;
    const { eliminar_fisico } = req.query;

    await documentosService.eliminarDocumento(
      parseInt(id),
      eliminar_fisico === "true",
    );

    // Recargar documentos en el agente
    try {
      await recargarDocumentos();
    } catch (error) {
      console.warn(
        "⚠️  No se pudo recargar documentos en el agente:",
        error.message,
      );
    }

    return res.json({
      ok: true,
      message:
        eliminar_fisico === "true"
          ? "Documento eliminado completamente. El agente ha sido actualizado."
          : "Documento desactivado. El agente ha sido actualizado.",
    });
  } catch (error) {
    console.error("Error al eliminar documento:", error);
    return res.status(500).json({
      ok: false,
      message: "Error al eliminar documento",
      error: error.message,
    });
  }
});

// Activar documento
router.post(
  "/:id/activar",
  authMiddleware,
  verificarPermisos,
  async (req, res) => {
    try {
      const { id } = req.params;

      await documentosService.activarDocumento(parseInt(id));

      // Recargar documentos en el agente
      try {
        await recargarDocumentos();
      } catch (error) {
        console.warn(
          "⚠️  No se pudo recargar documentos en el agente:",
          error.message,
        );
      }

      return res.json({
        ok: true,
        message:
          "Documento activado exitosamente. El agente ha sido actualizado.",
      });
    } catch (error) {
      console.error("Error al activar documento:", error);
      return res.status(500).json({
        ok: false,
        message: "Error al activar documento",
        error: error.message,
      });
    }
  },
);

// Endpoint para recargar documentos en el agente (útil después de subir/eliminar)
router.post(
  "/recargar",
  authMiddleware,
  verificarPermisos,
  async (req, res) => {
    try {
      await recargarDocumentos();
      return res.json({
        ok: true,
        message: "Documentos recargados exitosamente en el agente",
      });
    } catch (error) {
      console.error("Error al recargar documentos:", error);
      return res.status(500).json({
        ok: false,
        message: "Error al recargar documentos",
        error: error.message,
      });
    }
  },
);

module.exports = router;
