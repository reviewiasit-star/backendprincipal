// ===== RUTAS DE MEMORIAS DEL AGENTE INTELIGENTE =====

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const memoriasService = require('./agenteMemoriasService');

// Verificar permisos (solo Administrador y Director)
const verificarPermisos = (req, res, next) => {
  if (!req.user) return res.status(401).json({ ok: false, message: 'No autenticado' });
  if (!['Administrador', 'Director'].includes(req.user.rol)) {
    return res.status(403).json({ ok: false, message: 'Solo Administradores y Directores pueden gestionar memorias del agente' });
  }
  next();
};

// GET /api/agente-memorias/activas — Memorias activas (también usadas por el agente)
router.get('/activas', authMiddleware, async (req, res) => {
  try {
    const memorias = await memoriasService.obtenerMemoriasActivas();
    res.json({ ok: true, memorias, total: memorias.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// GET /api/agente-memorias — Todas las memorias
router.get('/', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const memorias = await memoriasService.obtenerTodas();
    res.json({ ok: true, memorias, total: memorias.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// POST /api/agente-memorias — Crear nueva memoria
router.post('/', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    const { contenido, tipo, keywords, fecha_fin } = req.body;
    if (!contenido || !contenido.trim()) {
      return res.status(400).json({ ok: false, message: 'El contenido es requerido' });
    }

    const tipoFinal = tipo || memoriasService.detectarTipo(contenido);
    const keywordsFinal = keywords || memoriasService.extraerKeywords(contenido);

    const id = await memoriasService.crearMemoria({
      contenido: contenido.trim(),
      tipo: tipoFinal,
      keywords: keywordsFinal,
      fecha_fin: fecha_fin || null,
      creado_por: req.user.id,
    });

    res.json({ ok: true, message: 'Aviso guardado. El agente lo usará al responder preguntas relacionadas.', id });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// PATCH /api/agente-memorias/:id/desactivar — Desactivar
router.patch('/:id/desactivar', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    await memoriasService.desactivarMemoria(parseInt(req.params.id));
    res.json({ ok: true, message: 'Aviso desactivado correctamente' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// DELETE /api/agente-memorias/:id — Eliminar
router.delete('/:id', authMiddleware, verificarPermisos, async (req, res) => {
  try {
    await memoriasService.eliminarMemoria(parseInt(req.params.id));
    res.json({ ok: true, message: 'Aviso eliminado correctamente' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
