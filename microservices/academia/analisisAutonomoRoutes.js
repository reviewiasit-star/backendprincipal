// ===== RUTAS PARA ANÁLISIS AUTÓNOMO DEL AGENTE =====

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const AnalisisAutonomo = require('./analisisAutonomo');
const AnalisisAutonomoJob = require('./analisisAutonomoJob');

// Instancia global del job
let analisisJob = null;

// Inicializar job
function inicializarJob() {
  if (!analisisJob) {
    analisisJob = new AnalisisAutonomoJob();
    // Iniciar job automáticamente (ejecuta cada 6 horas)
    analisisJob.iniciar(6);
    console.log('✅ Job de análisis autónomo inicializado');
  }
}

// Inicializar al cargar el módulo
inicializarJob();

// Middleware para verificar permisos (solo Admin y Director)
function verificarPermisos() {
  return (req, res, next) => {
    const user = req.user;
    if (user.rol !== 'Administrador' && user.rol !== 'Director') {
      return res.status(403).json({
        ok: false,
        message: 'No tiene permisos para acceder a esta funcionalidad'
      });
    }
    next();
  };
}

// ===== ENDPOINTS DE ACCIÓN =====

// Ejecutar análisis completo manualmente (pagos atrasados + reporte)
router.post('/ejecutar-analisis', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const analisisAutonomo = new AnalisisAutonomo();
    const resultado = await analisisAutonomo.ejecutarTodosLosAnalisis();
    res.json(resultado);
  } catch (error) {
    console.error('Error ejecutando análisis:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al ejecutar análisis',
      error: error.message
    });
  }
});

// Ejecutar análisis específico (solo pagos-atrasados y reporte)
router.post('/ejecutar-analisis/:tipo', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { tipo } = req.params;
    const analisisAutonomo = new AnalisisAutonomo();

    let resultado;
    switch (tipo) {
      case 'pagos-atrasados':
        resultado = await analisisAutonomo.detectarPagosAtrasados();
        break;
      case 'reporte':
        const tipoReporte = req.body.tipo || 'diario';
        resultado = await analisisAutonomo.generarReporteInteligente(tipoReporte);
        break;
      default:
        return res.status(400).json({
          ok: false,
          message: 'Tipo de análisis no válido. Tipos disponibles: pagos-atrasados, reporte'
        });
    }

    res.json(resultado);
  } catch (error) {
    console.error('Error ejecutando análisis específico:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al ejecutar análisis',
      error: error.message
    });
  }
});

// Obtener estado del job
router.get('/job/estado', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const estado = analisisJob ? analisisJob.getEstado() : { activo: false };
    res.json({
      ok: true,
      estado: estado
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: 'Error al obtener estado del job',
      error: error.message
    });
  }
});

module.exports = router;
