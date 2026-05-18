// ===== MÓDULO DE GESTIÓN ACADÉMICA =====


const { configurarRutasBecas } = require('./becas');
const { configurarRutasBloques } = require('./bloques');
const { configurarRutasNiveles } = require('./niveles');
const { configurarRutasCursos } = require('./cursos');
const { configurarRutasBloqueCurso } = require('./bloque_curso');
const { configurarRutasServicios } = require('./servicios');
const { configurarRutasEstadosEstudiante } = require('./estados-estudiante');

function configurarRutasGestionAcademica(app, pool, authMiddleware) {
  // Configurar todas las rutas de los módulos
  configurarRutasBecas(app, pool, authMiddleware);
  configurarRutasBloques(app, pool, authMiddleware);
  configurarRutasNiveles(app, pool, authMiddleware);
  configurarRutasCursos(app, pool, authMiddleware);
  configurarRutasBloqueCurso(app, pool, authMiddleware);
  configurarRutasServicios(app, pool, authMiddleware);
  configurarRutasEstadosEstudiante(app, pool, authMiddleware);

  // ===== ENDPOINTS ADICIONALES =====

  // Obtener resumen de la gestión académica
  app.get('/api/gestion-academica/resumen', authMiddleware, async (req, res) => {
    try {
      const [becasCount] = await pool.query('SELECT COUNT(*) as count FROM becas');
      const [nivelesCount] = await pool.query('SELECT COUNT(*) as count FROM nivel');
      const [cursosCount] = await pool.query('SELECT COUNT(*) as count FROM curso');
      const [bloquesCount] = await pool.query('SELECT COUNT(*) as count FROM bloque');

      res.json({
        ok: true,
        resumen: {
          becas: becasCount[0].count,
          niveles: nivelesCount[0].count,
          cursos: cursosCount[0].count,
          bloques: bloquesCount[0].count
        }
      });
    } catch (error) {
      console.error('Error al obtener resumen:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener resumen', error: error.message });
    }
  });

  // Log silenciado
}

module.exports = { configurarRutasGestionAcademica };
