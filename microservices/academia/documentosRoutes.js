// ===== RUTAS PARA GESTIÓN DE DOCUMENTOS DEL AGENTE INTELIGENTE =====

const express = require('express');
const multer = require('multer');
const documentosService = require('./documentosService');
const { authMiddleware } = require('../../middleware/auth');
const { recargarDocumentos, procesarYGuardarChunksEmbeddings } = require('./agenteInteligente');

const router = express.Router();

// Configurar multer para manejar archivos en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB máximo
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|docx|doc|txt/;
    const extname = allowedTypes.test(
      require('path').extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype) || 
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                     file.mimetype === 'application/msword';

    if (extname || mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF, Word (DOCX) o TXT'));
    }
  }
});

// Middleware para verificar permisos (solo Administrador y Director)
const verificarPermisos = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      message: 'Usuario no autenticado'
    });
  }

  if (!['Administrador', 'Director'].includes(req.user.rol)) {
    return res.status(403).json({
      ok: false,
      message: 'Solo Administradores y Directores pueden gestionar documentos'
    });
  }

  next();
};

// Subir nuevo documento
router.post('/subir', authMiddleware, verificarPermisos, upload.single('documento'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'No se proporcionó ningún archivo'
      });
    }

    const { tipo } = req.body;
    const usuarioId = req.user.id;

    const documento = await documentosService.guardarDocumento(
      req.file,
      tipo || 'otros',
      usuarioId
    );

    // Crear chunks y embeddings y guardarlos en BD
    try {
      if (documento.texto_completo) {
        const { chunks, embeddings } = await procesarYGuardarChunksEmbeddings(
          documento.id,
          documento.texto_completo,
          documento.nombre,
          documento.tipo
        );
        console.log(`📦 Chunks: ${chunks}, Embeddings: ${embeddings} para documento ${documento.id}`);
      }
    } catch (chunkError) {
      console.warn('⚠️  Error al generar chunks/embeddings:', chunkError.message);
      // No fallar la respuesta, el documento ya está guardado
    }

    // Recargar documentos en el agente
    try {
      await recargarDocumentos();
    } catch (error) {
      console.warn('⚠️  No se pudo recargar documentos en el agente:', error.message);
      // No fallar la respuesta si solo falla la recarga
    }

    const { texto_completo, ...docSinTexto } = documento;
    return res.json({
      ok: true,
      message: 'Documento subido y procesado exitosamente. El agente ha sido actualizado.',
      documento: docSinTexto
    });
  } catch (error) {
    const esDuplicado = error.message && error.message.includes('Ya existe un documento activo');
    if (!esDuplicado) {
      console.error('Error al subir documento:', error);
    }
    return res.status(esDuplicado ? 409 : 500).json({
      ok: false,
      message: error.message || 'Error al procesar el documento',
      error: error.message
    });
  }
});

// Listar todos los documentos
router.get('/listar', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { activos } = req.query;
    const soloActivos = activos !== 'false';

    const documentos = await documentosService.obtenerDocumentos(soloActivos);

    // No incluir el texto completo en la lista (solo preview)
    const documentosLista = documentos.map(doc => ({
      id: doc.id,
      nombre: doc.nombre,
      tipo: doc.tipo,
      formato: doc.formato,
      tamanio_bytes: doc.tamanio_bytes,
      activo: doc.activo,
      creado_en: doc.creado_en,
      actualizado_en: doc.actualizado_en,
      preview: doc.texto_extraido ? doc.texto_extraido.substring(0, 200) + '...' : ''
    }));

    return res.json({
      ok: true,
      documentos: documentosLista,
      total: documentosLista.length
    });
  } catch (error) {
    console.error('Error al listar documentos:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al listar documentos',
      error: error.message
    });
  }
});

// Regenerar chunks y embeddings de un documento (para aplicar nueva configuración de tamaño)
router.post('/:id/regenerar-chunks', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await documentosService.obtenerDocumentoPorId(parseInt(id));
    if (!doc) {
      return res.status(404).json({ ok: false, message: 'Documento no encontrado' });
    }
    if (!doc.texto_extraido || doc.texto_extraido.trim().length === 0) {
      return res.status(400).json({ ok: false, message: 'El documento no tiene texto extraído para regenerar chunks' });
    }

    const { chunks, embeddings } = await procesarYGuardarChunksEmbeddings(
      parseInt(id),
      doc.texto_extraido,
      doc.nombre,
      doc.tipo
    );
    await recargarDocumentos();

    return res.json({
      ok: true,
      message: `Chunks regenerados: ${chunks} fragmentos, ${embeddings} embeddings. El agente ha sido actualizado.`,
      chunks,
      embeddings
    });
  } catch (error) {
    console.error('Error al regenerar chunks:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al regenerar chunks',
      error: error.message
    });
  }
});

// Obtener chunks de un documento (capítulo, título, texto, etc.)
router.get('/:id/chunks', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;
    const chunks = await documentosService.obtenerChunksPorDocumento(parseInt(id));

    return res.json({
      ok: true,
      chunks,
      total: chunks.length
    });
  } catch (error) {
    console.error('Error al obtener chunks:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al obtener chunks del documento',
      error: error.message
    });
  }
});

// Obtener documento por ID (con texto completo)
router.get('/:id', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;
    const documento = await documentosService.obtenerDocumentoPorId(id);

    if (!documento) {
      return res.status(404).json({
        ok: false,
        message: 'Documento no encontrado'
      });
    }

    return res.json({
      ok: true,
      documento
    });
  } catch (error) {
    console.error('Error al obtener documento:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al obtener documento',
      error: error.message
    });
  }
});

// Eliminar documento (marcar como inactivo o eliminar físicamente)
router.delete('/:id', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;
    const { eliminar_fisico } = req.query;

    await documentosService.eliminarDocumento(
      parseInt(id),
      eliminar_fisico === 'true'
    );

    // Recargar documentos en el agente
    try {
      await recargarDocumentos();
    } catch (error) {
      console.warn('⚠️  No se pudo recargar documentos en el agente:', error.message);
    }

    return res.json({
      ok: true,
      message: eliminar_fisico === 'true' 
        ? 'Documento eliminado completamente. El agente ha sido actualizado.' 
        : 'Documento desactivado. El agente ha sido actualizado.'
    });
  } catch (error) {
    console.error('Error al eliminar documento:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al eliminar documento',
      error: error.message
    });
  }
});

// Activar documento
router.post('/:id/activar', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { id } = req.params;

    await documentosService.activarDocumento(parseInt(id));

    // Recargar documentos en el agente
    try {
      await recargarDocumentos();
    } catch (error) {
      console.warn('⚠️  No se pudo recargar documentos en el agente:', error.message);
    }

    return res.json({
      ok: true,
      message: 'Documento activado exitosamente. El agente ha sido actualizado.'
    });
  } catch (error) {
    console.error('Error al activar documento:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al activar documento',
      error: error.message
    });
  }
});

// Endpoint para recargar documentos en el agente (útil después de subir/eliminar)
router.post('/recargar', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    await recargarDocumentos();
    return res.json({
      ok: true,
      message: 'Documentos recargados exitosamente en el agente'
    });
  } catch (error) {
    console.error('Error al recargar documentos:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al recargar documentos',
      error: error.message
    });
  }
});

module.exports = router;

