const express = require('express');
const multer = require('multer');
const upload = multer();

const pool = require('./config');
const { extraerDesdeImagenBuffer, extraerDesdePDFBuffer } = require('./ocrComprobantesService');
const { guardarOcrComprobante } = require('./ocrComprobantesStore');

const router = express.Router();

// Endpoint para previsualización OCR (sin guardar en BD)
router.post('/preview', upload.single('archivo'), async (req, res) => {
  try {
    const file = req.file;

    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, message: 'El archivo del comprobante es requerido.' });
    }

    const mimetype = file.mimetype || '';
    const buffer = file.buffer;

    let resultado;
    if (mimetype.startsWith('image/')) {
      resultado = await extraerDesdeImagenBuffer(buffer);
    } else if (mimetype === 'application/pdf') {
      resultado = await extraerDesdePDFBuffer(buffer);
    } else {
      return res.status(400).json({
        ok: false,
        message: 'Formato no soportado. Solo se aceptan imágenes (JPG, PNG) o PDF.'
      });
    }

    return res.json({
      ok: true,
      datos: resultado
    });
  } catch (error) {
    console.error('Error en /api/ocr-comprobantes-public/preview:', error);
    return res.status(500).json({
      ok: false,
      message: 'Ocurrió un error al procesar el comprobante. Intente de nuevo más tarde.'
    });
  }
});

// Normalizar número de teléfono (copiado de whatsappService)
function normalizarNumero(numero) {
  if (!numero) return '';
  let normalizado = String(numero).replace(/\D/g, '');
  if (normalizado.startsWith('591')) {
    normalizado = normalizado.substring(3);
  }
  if (String(numero).startsWith('+591')) {
    normalizado = String(numero).replace(/\+591/g, '').replace(/\D/g, '');
  }
  return normalizado;
}

// Endpoint público para que padres/tutores suban comprobantes desde la web
// Campos esperados: telefono, descripcion_monto, ci, archivo (multipart/form-data)
router.post('/upload', upload.single('archivo'), async (req, res) => {
  try {
    const { telefono, descripcion_monto, ci } = req.body || {};
    const file = req.file;

    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, message: 'El archivo del comprobante es requerido.' });
    }

    const mimetype = file.mimetype || '';
    const buffer = file.buffer;

    // Validar que el CI y teléfono correspondan a un padre/madre registrado
    if (!telefono || !ci) {
      return res.status(400).json({
        ok: false,
        message: 'Debe ingresar su número de WhatsApp y su CI/NIT para validar el comprobante.'
      });
    }

    const numeroNormalizado = normalizarNumero(telefono);
    let remitenteValido = null;

    try {
      if (numeroNormalizado && numeroNormalizado.length >= 7) {
        const like = `%${numeroNormalizado}%`;
        const [rows] = await pool.query(`
          SELECT 
            e.id,
            e.nombre_padre,
            e.apellido_padre,
            e.ci_padre,
            e.nombre_madre,
            e.apellido_madre,
            e.ci_madre
          FROM estudiantes e
          WHERE 
            (
              REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
              OR REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
              OR REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
              OR REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
              OR REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
              OR REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
            )
            AND (e.ci_padre = ? OR e.ci_madre = ?)
          LIMIT 1
        `, [like, like, like, like, like, like, ci, ci]);

        if (rows && rows.length > 0) {
          remitenteValido = rows[0];
        }
      }
    } catch (error) {
      console.error('Error validando remitente en /ocr-comprobantes-public:', error.message);
    }

    if (!remitenteValido) {
      return res.status(400).json({
        ok: false,
        message: 'No pudimos validar sus datos con la información registrada. Verifique su número de WhatsApp y su CI/NIT.'
      });
    }

    // Determinar nombre del remitente basado en CI
    let nombreRemitente = null;
    if (remitenteValido.ci_padre === ci && remitenteValido.nombre_padre) {
      nombreRemitente = `${remitenteValido.nombre_padre} ${remitenteValido.apellido_padre || ''}`.trim();
    } else if (remitenteValido.ci_madre === ci && remitenteValido.nombre_madre) {
      nombreRemitente = `${remitenteValido.nombre_madre} ${remitenteValido.apellido_madre || ''}`.trim();
    }

    let resultado;
    if (mimetype.startsWith('image/')) {
      resultado = await extraerDesdeImagenBuffer(buffer);
    } else if (mimetype === 'application/pdf') {
      resultado = await extraerDesdePDFBuffer(buffer);
    } else {
      return res.status(400).json({
        ok: false,
        message: 'Formato no soportado. Solo se aceptan imágenes (JPG, PNG) o PDF.'
      });
    }

    // Agregar datos del remitente y descripción del monto a las observaciones
    const extras = [];
    if (nombreRemitente) extras.push(`Nombre remitente: ${nombreRemitente}`);
    if (ci) extras.push(`CI/NIT remitente: ${ci}`);
    if (telefono) extras.push(`Teléfono remitente: ${telefono}`);
    if (descripcion_monto && descripcion_monto.trim()) {
      extras.push(`Descripción del monto: ${descripcion_monto.trim()}`);
    }

    const obsBase = resultado.observaciones ? `${resultado.observaciones}; ` : '';
    resultado.observaciones = obsBase + extras.join(' | ');

    await guardarOcrComprobante({
      numeroRemitente: telefono || null,
      mimetype,
      buffer,
      resultado,
      origen: 'web_form'
    });

    return res.json({
      ok: true,
      message: 'Comprobante recibido correctamente. La cajera revisará la información en breve.'
    });
  } catch (error) {
    console.error('Error en /api/ocr-comprobantes-public/upload:', error);
    return res.status(500).json({
      ok: false,
      message: 'Ocurrió un error al procesar el comprobante. Intente de nuevo más tarde.'
    });
  }
});

module.exports = router;

