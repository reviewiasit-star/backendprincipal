const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const sharp = require('sharp'); // Para convertir imágenes a PDF
const PDFDocument = require('pdfkit');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const pool = require('../academia/config');
const dbConfig = pool.dbConnectionConfig;

// Configurar multer para comprobantes firmados (ahora en academia/comprobantes_firmados)
const storageComprobantes = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../academia/comprobantes_firmados');
    // Crear directorio si no existe
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generar nombre único: comprobante-pagoID-timestamp.pdf
    const pagoId = req.body.pago_id || 'unknown';
    const timestamp = Date.now();
    cb(null, `comprobante-${pagoId}-${timestamp}.pdf`);
  }
});

const uploadComprobante = multer({ 
  storage: storageComprobantes,
  fileFilter: function (req, file, cb) {
    // Permitir imágenes y PDFs
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos JPG, PNG o PDF'), false);
    }
  },
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB máximo
  }
});

// Función para convertir imagen a PDF B&N
async function convertirImagenAPDF(inputPath, outputPath) {
  try {
    // Si ya es PDF, solo copiarlo
    if (path.extname(inputPath).toLowerCase() === '.pdf') {
      fs.copyFileSync(inputPath, outputPath);
      return outputPath;
    }

    // Convertir imagen a B&N y luego a PDF
    const imageBuffer = await sharp(inputPath)
      .greyscale() // Convertir a blanco y negro
      .jpeg({ quality: 80 }) // Comprimir un poco
      .toBuffer();

    // Crear PDF con la imagen
    const doc = new PDFDocument({ autoFirstPage: false });
    const writeStream = fs.createWriteStream(outputPath);
    doc.pipe(writeStream);

    // Obtener dimensiones de la imagen
    const metadata = await sharp(inputPath).metadata();
    const { width, height } = metadata;

    // Calcular dimensiones para ajustar a página A4
    const pageWidth = 595; // A4 width in points
    const pageHeight = 842; // A4 height in points
    const margin = 50;

    let imgWidth = width;
    let imgHeight = height;

    // Escalar si es necesario
    if (imgWidth > pageWidth - 2 * margin) {
      const ratio = (pageWidth - 2 * margin) / imgWidth;
      imgWidth = pageWidth - 2 * margin;
      imgHeight = imgHeight * ratio;
    }

    if (imgHeight > pageHeight - 2 * margin) {
      const ratio = (pageHeight - 2 * margin) / imgHeight;
      imgHeight = pageHeight - 2 * margin;
      imgWidth = imgWidth * ratio;
    }

    // Agregar página y imagen
    doc.addPage({ size: 'A4' });
    doc.image(imageBuffer, margin, margin, { width: imgWidth, height: imgHeight });
    
    doc.end();

    return new Promise((resolve, reject) => {
      writeStream.on('finish', () => resolve(outputPath));
      writeStream.on('error', reject);
    });

  } catch (error) {
    console.error('Error al convertir imagen a PDF:', error);
    throw error;
  }
}

// Ruta para subir comprobante firmado
router.post('/upload-comprobante-firmado', authMiddleware, uploadComprobante.single('comprobante'), async (req, res) => {
  let connection;
  try {
    const { pago_id, numero_comprobante, nit_ci, id_ocr_comprobante } = req.body;
    const origen = (req.body.origen_registro || 'pagos_realizados').toLowerCase();

    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó ningún archivo' });
    }

    if (!pago_id) {
      return res.status(400).json({ error: 'ID de pago es requerido' });
    }

    // Conectar a la base de datos
    connection = await mysql.createConnection(dbConfig);

    const tablaObjetivo = origen === 'ingresos' ? 'ingresos' : 'pagos_realizados';
    const [pagoRows] = await connection.execute(
      `SELECT * FROM ${tablaObjetivo} WHERE id = ?`,
      [pago_id]
    );
    if (pagoRows.length === 0) {
      return res.status(404).json({ error: 'Registro de pago no encontrado' });
    }

    // Migración automática de columnas de comprobante
    try {
      const asegurarColumna = async (tabla, columna, ddl) => {
        const [columns] = await connection.execute(`
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = ?
        `, [tabla, columna]);
        if (columns.length === 0) {
          await connection.execute(`ALTER TABLE ${tabla} ${ddl}`);
        }
      };

      // Base histórica de pagos
      await asegurarColumna('pagos_realizados', 'id_ocr_comprobante', 'ADD COLUMN id_ocr_comprobante INT NULL');
      // Servicios pagados (tabla ingresos)
      await asegurarColumna('ingresos', 'pdf_firmado', 'ADD COLUMN pdf_firmado VARCHAR(255) NULL');
      await asegurarColumna('ingresos', 'fecha_subida_firmado', 'ADD COLUMN fecha_subida_firmado DATETIME NULL');
      await asegurarColumna('ingresos', 'subido_por', 'ADD COLUMN subido_por VARCHAR(120) NULL');
      await asegurarColumna('ingresos', 'id_ocr_comprobante', 'ADD COLUMN id_ocr_comprobante INT NULL');

      // Índices (si ya existen, ignorar)
      try {
        await connection.execute(`CREATE INDEX idx_ocr_comprobante ON pagos_realizados(id_ocr_comprobante)`);
      } catch (_) {
        // ignore
      }
      try {
        await connection.execute(`CREATE INDEX idx_ingresos_ocr_comprobante ON ingresos(id_ocr_comprobante)`);
      } catch (_) {
        // ignore
      }
    } catch (alterError) {
      // Si hay error, continuar de todas formas
      console.log('Error en migración de columnas de comprobante:', alterError.message);
    }

    // Si se proporciona id_ocr_comprobante, verificar que no esté ya asociado en ambas tablas
    if (id_ocr_comprobante) {
      try {
        const [comprobanteUsado] = await connection.execute(
          `SELECT id FROM pagos_realizados WHERE id_ocr_comprobante = ? AND id != ?
           UNION ALL
           SELECT id FROM ingresos WHERE id_ocr_comprobante = ? AND id != ?`,
          [id_ocr_comprobante, pago_id, id_ocr_comprobante, pago_id]
        );
        
        if (comprobanteUsado.length > 0) {
          return res.status(400).json({ error: 'Este comprobante ya está asociado a otro pago' });
        }
      } catch (checkError) {
        // Si la columna no existe aún, continuar sin validación
        console.log('No se pudo verificar comprobante usado:', checkError.message);
      }
    }

    const inputPath = req.file.path;
    const outputPath = path.join(path.dirname(inputPath), `comprobante-${pago_id}-${Date.now()}-final.pdf`);

    // Convertir a PDF B&N si es necesario
    await convertirImagenAPDF(inputPath, outputPath);

    // Si se creó un nuevo archivo PDF, eliminar el original (si era imagen)
    if (inputPath !== outputPath && path.extname(inputPath).toLowerCase() !== '.pdf') {
      fs.unlinkSync(inputPath);
    }

    const updateQuery = `
      UPDATE ${tablaObjetivo}
      SET pdf_firmado = ?, 
          fecha_subida_firmado = NOW(), 
          subido_por = ?,
          numero_comprobante = COALESCE(?, numero_comprobante),
          nit_ci = COALESCE(?, nit_ci),
          id_ocr_comprobante = COALESCE(?, id_ocr_comprobante)
      WHERE id = ?
    `;

    await connection.execute(updateQuery, [
      path.basename(outputPath),
      req.user.nombre_completo || req.user.usuario,
      numero_comprobante || null,
      nit_ci || null,
      id_ocr_comprobante || null,
      pago_id
    ]);

    res.json({
      success: true,
      message: 'Comprobante firmado subido exitosamente',
      fileName: path.basename(outputPath),
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      pago_id: pago_id,
      origen_registro: tablaObjetivo
    });

  } catch (error) {
    console.error('Error al subir comprobante firmado:', error);
    res.status(500).json({ error: 'Error al subir el comprobante: ' + error.message });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Ruta para obtener comprobantes de un estudiante
router.get('/comprobantes-estudiante/:estudiante_id', authMiddleware, async (req, res) => {
  let connection;
  try {
    const { estudiante_id } = req.params;
    
    connection = await mysql.createConnection(dbConfig);

    const queryPagos = `
      SELECT 
        pr.id,
        pr.fecha_pago,
        pr.monto,
        pr.tipo_pago,
        pr.mes,
        pr.anio,
        pr.numero_comprobante,
        pr.nit_ci,
        pr.pdf_original,
        pr.pdf_firmado,
        pr.fecha_subida_firmado,
        pr.subido_por,
        e.nombre as estudiante_nombre,
        e.apellido_paterno,
        e.apellido_materno
      FROM pagos_realizados pr
      INNER JOIN compromiso_economico ce ON pr.id_compromiso = ce.id
      INNER JOIN estudiantes e ON ce.id_estudiante = e.id
      WHERE e.id = ?
      ORDER BY pr.fecha_pago DESC
    `;
    const queryServicios = `
      SELECT
        i.id,
        i.fecha as fecha_pago,
        i.monto,
        'servicio' as tipo_pago,
        NULL as mes,
        YEAR(i.fecha) as anio,
        i.numero_comprobante,
        i.nit_ci,
        NULL as pdf_original,
        i.pdf_firmado,
        i.fecha_subida_firmado,
        i.subido_por,
        e.nombre as estudiante_nombre,
        e.apellido_paterno,
        e.apellido_materno
      FROM ingresos i
      INNER JOIN estudiantes e ON i.estudiante_id = e.id
      WHERE e.id = ? AND i.tipo = 'servicios_estudiante'
      ORDER BY i.fecha DESC
    `;

    const [rowsPagos] = await connection.execute(queryPagos, [estudiante_id]);
    let rowsServicios = [];
    try {
      const [tmp] = await connection.execute(queryServicios, [estudiante_id]);
      rowsServicios = tmp;
    } catch (_) {
      rowsServicios = [];
    }
    const rows = [...rowsPagos, ...rowsServicios];

    res.json({
      success: true,
      comprobantes: rows
    });

  } catch (error) {
    console.error('Error al obtener comprobantes:', error);
    res.status(500).json({ error: 'Error al obtener comprobantes' });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Ruta para visualizar comprobante (original o firmado) - devuelve blob para visualización
router.get('/view-comprobante/:pago_id/:tipo', authMiddleware, async (req, res) => {
  let connection;
  try {
    const { pago_id, tipo } = req.params; // tipo: 'original' o 'firmado'
    const origen = (req.query.origen || 'pagos_realizados').toLowerCase();
    
    connection = await mysql.createConnection(dbConfig);

    const [rows] = await connection.execute(
      origen === 'ingresos'
        ? 'SELECT NULL as pdf_original, pdf_firmado FROM ingresos WHERE id = ?'
        : 'SELECT pdf_original, pdf_firmado FROM pagos_realizados WHERE id = ?',
      [pago_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const pago = rows[0];
    let filePath;

    if (tipo === 'original' && pago.pdf_original) {
      filePath = path.join(__dirname, '../academia/common/pdfs', pago.pdf_original);
    } else if (tipo === 'firmado' && pago.pdf_firmado) {
      filePath = path.join(__dirname, '../academia/comprobantes_firmados', pago.pdf_firmado);
    } else {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Archivo no encontrado en el servidor' });
    }

    // Determinar el tipo MIME basado en la extensión del archivo
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'application/pdf';
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.gif') contentType = 'image/gif';

    // Enviar el archivo como blob para visualización (no forzar descarga)
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.sendFile(filePath);

  } catch (error) {
    console.error('Error al visualizar comprobante:', error);
    res.status(500).json({ error: 'Error al visualizar comprobante' });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Ruta para descargar comprobante (original o firmado) - SIN AUTENTICACIÓN
router.get('/download-comprobante/:pago_id/:tipo', async (req, res) => {
  let connection;
  try {
    const { pago_id, tipo } = req.params; // tipo: 'original' o 'firmado'
    const origen = (req.query.origen || 'pagos_realizados').toLowerCase();
    
    connection = await mysql.createConnection(dbConfig);

    const [rows] = await connection.execute(
      origen === 'ingresos'
        ? 'SELECT NULL as pdf_original, pdf_firmado FROM ingresos WHERE id = ?'
        : 'SELECT pdf_original, pdf_firmado FROM pagos_realizados WHERE id = ?',
      [pago_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const pago = rows[0];
    let filePath;

    if (tipo === 'original' && pago.pdf_original) {
      filePath = path.join(__dirname, '../academia/common/pdfs', pago.pdf_original);
    } else if (tipo === 'firmado' && pago.pdf_firmado) {
      filePath = path.join(__dirname, '../academia/comprobantes_firmados', pago.pdf_firmado);
    } else {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Archivo no encontrado en el servidor' });
    }

    res.download(filePath);

  } catch (error) {
    console.error('Error al descargar comprobante:', error);
    res.status(500).json({ error: 'Error al descargar comprobante' });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Ruta para eliminar comprobante firmado
router.delete('/eliminar/:pago_id', authMiddleware, async (req, res) => {
  let connection;
  try {
    const { pago_id } = req.params;
    const origen = (req.query.origen || 'pagos_realizados').toLowerCase();
    
    if (!pago_id) {
      return res.status(400).json({ error: 'ID de pago es requerido' });
    }

    connection = await mysql.createConnection(dbConfig);

    // Obtener información del comprobante antes de eliminarlo
    const [pagoRows] = await connection.execute(
      origen === 'ingresos'
        ? 'SELECT pdf_firmado FROM ingresos WHERE id = ?'
        : 'SELECT pdf_firmado FROM pagos_realizados WHERE id = ?',
      [pago_id]
    );

    if (pagoRows.length === 0) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const pdfFirmado = pagoRows[0].pdf_firmado;

    // Eliminar el archivo físico si existe
    if (pdfFirmado) {
      const filePath = path.join(__dirname, '../academia/comprobantes_firmados', pdfFirmado);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (fileError) {
          console.warn('No se pudo eliminar el archivo físico:', fileError.message);
          // Continuar aunque no se pueda eliminar el archivo
        }
      }
    }

    // Actualizar la base de datos para eliminar la referencia al comprobante
    await connection.execute(
      `UPDATE ${origen === 'ingresos' ? 'ingresos' : 'pagos_realizados'}
       SET pdf_firmado = NULL, 
           fecha_subida_firmado = NULL, 
           subido_por = NULL
       WHERE id = ?`,
      [pago_id]
    );

    res.json({
      success: true,
      message: 'Comprobante eliminado exitosamente',
      pago_id: pago_id
    });

  } catch (error) {
    console.error('Error al eliminar comprobante:', error);
    res.status(500).json({ error: 'Error al eliminar el comprobante: ' + error.message });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Ruta para registrar consulta de comprobante (para auditoría)
router.post('/registrar-consulta-comprobante', async (req, res) => {
  let connection;
  try {
    const { pago_id, estudiante_id, consultado_por, parentesco } = req.body;
    
    connection = await mysql.createConnection(dbConfig);

    await connection.execute(
      `INSERT INTO consultas_comprobantes 
       (pago_id, estudiante_id, consultado_por, parentesco, ip_consulta) 
       VALUES (?, ?, ?, ?, ?)`,
      [pago_id, estudiante_id, consultado_por, parentesco, req.ip]
    );

    res.json({ success: true, message: 'Consulta registrada' });

  } catch (error) {
    console.error('Error al registrar consulta:', error);
    res.status(500).json({ error: 'Error al registrar consulta' });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

module.exports = router;

