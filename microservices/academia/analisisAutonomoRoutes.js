// ===== RUTAS PARA ANÁLISIS AUTÓNOMO DEL AGENTE =====

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const AnalisisAutonomo = require('./analisisAutonomo');
const AnalisisAutonomoJob = require('./analisisAutonomoJob');
const pool = require('./config');

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

// ===== ENDPOINTS DE CONSULTA =====

// Obtener alertas del sistema
router.get('/alertas', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { estado, severidad, tipo_alerta, estudiante_id } = req.query;
    
    let query = `
      SELECT 
        a.*,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante
      FROM alertas_sistema a
      LEFT JOIN estudiantes e ON a.estudiante_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (estado) {
      query += ' AND a.estado = ?';
      params.push(estado);
    }
    if (severidad) {
      query += ' AND a.severidad = ?';
      params.push(severidad);
    }
    if (tipo_alerta) {
      query += ' AND a.tipo_alerta = ?';
      params.push(tipo_alerta);
    }
    if (estudiante_id) {
      query += ' AND a.estudiante_id = ?';
      params.push(estudiante_id);
    }

    query += ' ORDER BY a.fecha_deteccion DESC LIMIT 100';

    const [alertas] = await pool.query(query, params);

    res.json({
      ok: true,
      alertas: alertas,
      total: alertas.length
    });
  } catch (error) {
    console.error('Error obteniendo alertas:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener alertas',
      error: error.message
    });
  }
});

// Obtener sugerencias de becas
router.get('/sugerencias-becas', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { estado } = req.query;
    
    let query = `
      SELECT 
        sb.*,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante,
        ce.total_general,
        b.descripcion as beca_actual_descripcion
      FROM sugerencias_becas sb
      JOIN estudiantes e ON sb.estudiante_id = e.id
      JOIN compromiso_economico ce ON sb.compromiso_id = ce.id
      LEFT JOIN becas b ON ce.id_beca = b.id
      WHERE 1=1
    `;
    const params = [];

    if (estado) {
      query += ' AND sb.estado = ?';
      params.push(estado);
    }

    query += ' ORDER BY sb.porcentaje_morosidad DESC, sb.fecha_sugerencia DESC';

    const [sugerencias] = await pool.query(query, params);

    res.json({
      ok: true,
      sugerencias: sugerencias,
      total: sugerencias.length
    });
  } catch (error) {
    console.error('Error obteniendo sugerencias de becas:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener sugerencias de becas',
      error: error.message
    });
  }
});

// Obtener análisis de deserción
router.get('/analisis-desercion', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { nivel_riesgo, limite = 50 } = req.query;
    
    let query = `
      SELECT 
        ad.*,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante
      FROM analisis_desercion ad
      JOIN estudiantes e ON ad.estudiante_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (nivel_riesgo) {
      query += ' AND ad.nivel_riesgo = ?';
      params.push(nivel_riesgo);
    }

    query += ' ORDER BY ad.score_riesgo DESC, ad.fecha_ultima_actualizacion DESC LIMIT ?';
    params.push(parseInt(limite));

    const [analisis] = await pool.query(query, params);

    res.json({
      ok: true,
      analisis: analisis,
      total: analisis.length
    });
  } catch (error) {
    console.error('Error obteniendo análisis de deserción:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener análisis de deserción',
      error: error.message
    });
  }
});

// Obtener recordatorios de inscripción
router.get('/recordatorios-inscripcion', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { gestion_objetivo, estado } = req.query;
    
    let query = `
      SELECT 
        ri.*,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante
      FROM recordatorios_inscripcion ri
      JOIN estudiantes e ON ri.estudiante_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (gestion_objetivo) {
      query += ' AND ri.gestion_objetivo = ?';
      params.push(gestion_objetivo);
    }
    if (estado) {
      query += ' AND ri.estado = ?';
      params.push(estado);
    }

    query += ' ORDER BY ri.dias_restantes ASC, ri.fecha_recordatorio DESC';

    const [recordatorios] = await pool.query(query, params);

    res.json({
      ok: true,
      recordatorios: recordatorios,
      total: recordatorios.length
    });
  } catch (error) {
    console.error('Error obteniendo recordatorios:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener recordatorios',
      error: error.message
    });
  }
});

// Obtener reportes automáticos
router.get('/reportes', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { tipo_reporte, limite = 10 } = req.query;
    
    let query = `
      SELECT 
        id,
        tipo_reporte,
        periodo_inicio,
        periodo_fin,
        datos_reporte,
        fecha_generacion
      FROM reportes_automaticos
      WHERE 1=1
    `;
    const params = [];

    if (tipo_reporte) {
      query += ' AND tipo_reporte = ?';
      params.push(tipo_reporte);
    }

    query += ' ORDER BY fecha_generacion DESC LIMIT ?';
    params.push(parseInt(limite));

    const [reportes] = await pool.query(query, params);

    res.json({
      ok: true,
      reportes: reportes,
      total: reportes.length
    });
  } catch (error) {
    console.error('Error obteniendo reportes:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener reportes',
      error: error.message
    });
  }
});

// ===== ENDPOINTS DE ACCIÓN =====

// Ejecutar análisis completo manualmente
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

// Ejecutar análisis específico
router.post('/ejecutar-analisis/:tipo', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { tipo } = req.params;
    const analisisAutonomo = new AnalisisAutonomo();
    
    let resultado;
    switch (tipo) {
      case 'pagos-atrasados':
        resultado = await analisisAutonomo.detectarPagosAtrasados();
        break;
      case 'sugerencias-becas':
        resultado = await analisisAutonomo.sugerirBecas();
        break;
      case 'recordatorios-inscripcion':
        resultado = await analisisAutonomo.recordatoriosInscripcion();
        break;
      case 'analisis-desercion':
        resultado = await analisisAutonomo.analizarRiesgoDesercion();
        break;
      case 'reporte':
        const tipoReporte = req.body.tipo || 'diario';
        resultado = await analisisAutonomo.generarReporteInteligente(tipoReporte);
        break;
      default:
        return res.status(400).json({
          ok: false,
          message: 'Tipo de análisis no válido'
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

// Marcar alerta como resuelta
router.put('/alertas/:id/resolver', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { id } = req.params;
    const { observacion } = req.body;
    const usuario = req.user.usuario;

    await pool.query(`
      UPDATE alertas_sistema
      SET estado = 'resuelta',
          fecha_resolucion = NOW(),
          usuario_resolucion = ?,
          datos_adicionales = JSON_SET(
            COALESCE(datos_adicionales, '{}'),
            '$.observacion_resolucion', ?
          )
      WHERE id = ?
    `, [usuario, observacion || null, id]);

    res.json({
      ok: true,
      message: 'Alerta marcada como resuelta'
    });
  } catch (error) {
    console.error('Error resolviendo alerta:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al resolver alerta',
      error: error.message
    });
  }
});

// Aplicar sugerencia de beca
router.put('/sugerencias-becas/:id/aplicar', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { id } = req.params;
    const { porcentaje_beca, id_beca } = req.body;
    const usuario = req.user.usuario;

    // Obtener sugerencia
    const [sugerencia] = await pool.query(`
      SELECT * FROM sugerencias_becas WHERE id = ?
    `, [id]);

    if (sugerencia.length === 0) {
      return res.status(404).json({
        ok: false,
        message: 'Sugerencia no encontrada'
      });
    }

    const sug = sugerencia[0];

    // Aplicar beca al compromiso
    if (id_beca) {
      await pool.query(`
        UPDATE compromiso_economico
        SET id_beca = ?
        WHERE id = ?
      `, [id_beca, sug.compromiso_id]);
    }

    // Marcar sugerencia como aplicada
    await pool.query(`
      UPDATE sugerencias_becas
      SET estado = 'aplicada',
          fecha_aplicacion = NOW(),
          usuario_aplicacion = ?
      WHERE id = ?
    `, [usuario, id]);

    res.json({
      ok: true,
      message: 'Beca aplicada exitosamente'
    });
  } catch (error) {
    console.error('Error aplicando beca:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al aplicar beca',
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

// Obtener estadísticas generales
router.get('/estadisticas', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    // Contar alertas por severidad
    const [alertasPorSeveridad] = await pool.query(`
      SELECT severidad, COUNT(*) as cantidad
      FROM alertas_sistema
      WHERE estado = 'pendiente'
      GROUP BY severidad
    `);

    // Contar sugerencias pendientes
    const [sugerenciasPendientes] = await pool.query(`
      SELECT COUNT(*) as total
      FROM sugerencias_becas
      WHERE estado = 'pendiente'
    `);

    // Contar estudiantes en riesgo
    const [estudiantesRiesgo] = await pool.query(`
      SELECT 
        nivel_riesgo,
        COUNT(*) as cantidad
      FROM analisis_desercion
      WHERE nivel_riesgo IN ('alto', 'critico')
      GROUP BY nivel_riesgo
    `);

    // Contar recordatorios pendientes
    const [recordatoriosPendientes] = await pool.query(`
      SELECT COUNT(*) as total
      FROM recordatorios_inscripcion
      WHERE estado = 'pendiente'
    `);

    res.json({
      ok: true,
      estadisticas: {
        alertas: {
          por_severidad: alertasPorSeveridad,
          total_pendientes: alertasPorSeveridad.reduce((sum, a) => sum + parseInt(a.cantidad), 0)
        },
        sugerencias_becas: {
          pendientes: parseInt(sugerenciasPendientes[0]?.total || 0)
        },
        analisis_desercion: {
          estudiantes_alto_riesgo: estudiantesRiesgo.reduce((sum, e) => sum + parseInt(e.cantidad), 0),
          por_nivel: estudiantesRiesgo
        },
        recordatorios: {
          pendientes: parseInt(recordatoriosPendientes[0]?.total || 0)
        }
      }
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener estadísticas',
      error: error.message
    });
  }
});

module.exports = router;

