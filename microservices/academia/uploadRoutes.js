const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'pdfs');
try {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
} catch (e) {
  // Si no se puede crear, el endpoint fallará más adelante con mensaje claro.
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (_req, file, cb) {
    const safeOriginal = String(file.originalname || 'archivo.pdf')
      .replace(/[^\w.\-() ]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 120);

    const ext = path.extname(safeOriginal).toLowerCase() || '.pdf';
    const base = path.basename(safeOriginal, ext) || 'archivo';
    const name = `${base}_${Date.now()}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB
  },
  fileFilter: function (_req, file, cb) {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      String(file.originalname || '').toLowerCase().endsWith('.pdf');
    if (!isPdf) return cb(new Error('Solo se permite subir archivos PDF'));
    cb(null, true);
  }
});

// Subir un PDF al servidor para enviarlo por WhatsApp
router.post('/upload-pdf', authMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se recibió el archivo PDF' });
    }

    // Devolver ruta relativa (para que WhatsApp la resuelva del lado del servidor)
    const relativePath = path.posix.join('uploads', 'pdfs', req.file.filename);

    return res.json({
      success: true,
      filePath: relativePath,
      filename: req.file.filename,
      size: req.file.size
    });
  } catch (error) {
    console.error('Error en /api/upload/upload-pdf:', error);
    return res.status(500).json({ success: false, error: error.message || 'Error al subir PDF' });
  }
});

module.exports = router;

