// ===== GESTIÓN DE ESTADOS DE ESTUDIANTE =====

function configurarRutasEstadosEstudiante(app, pool, authMiddleware) {
  // Obtener todos los estados de estudiante
  app.get('/api/estados-estudiante', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM estados_estudiante ORDER BY descripcion');
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener estados de estudiante:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener estados de estudiante', error: error.message });
    }
  });
}

module.exports = { configurarRutasEstadosEstudiante };

