// ===== GESTIÓN DE SERVICIOS =====

function configurarRutasServicios(app, pool, authMiddleware) {
  // Listar servicios
  app.get('/api/servicios', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT id, descripcion FROM servicios ORDER BY descripcion');
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener servicios:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener servicios', error: error.message });
    }
  });

  // Crear servicio
  app.post('/api/servicios', authMiddleware, async (req, res) => {
    try {
      const { descripcion } = req.body;
      if (!descripcion || !descripcion.trim()) {
        return res.status(400).json({ ok: false, message: 'La descripción es obligatoria' });
      }

      // Evitar duplicados por nombre
      const [dup] = await pool.query('SELECT id FROM servicios WHERE descripcion = ?', [descripcion.trim()]);
      if (dup.length > 0) {
        return res.status(400).json({ ok: false, message: 'Ya existe un servicio con esa descripción' });
      }

      const [result] = await pool.query('INSERT INTO servicios (descripcion) VALUES (?)', [descripcion.trim()]);
      res.json({ ok: true, id: result.insertId, message: 'Servicio creado' });
    } catch (error) {
      console.error('Error al crear servicio:', error);
      res.status(500).json({ ok: false, message: 'Error al crear servicio', error: error.message });
    }
  });

  // Actualizar servicio
  app.put('/api/servicios/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { descripcion } = req.body;
      if (!descripcion || !descripcion.trim()) {
        return res.status(400).json({ ok: false, message: 'La descripción es obligatoria' });
      }

      const [exists] = await pool.query('SELECT id FROM servicios WHERE id = ?', [id]);
      if (exists.length === 0) {
        return res.status(404).json({ ok: false, message: 'Servicio no encontrado' });
      }

      // Evitar duplicados
      const [dup] = await pool.query('SELECT id FROM servicios WHERE descripcion = ? AND id != ?', [descripcion.trim(), id]);
      if (dup.length > 0) {
        return res.status(400).json({ ok: false, message: 'Ya existe un servicio con esa descripción' });
      }

      await pool.query('UPDATE servicios SET descripcion=? WHERE id=?', [descripcion.trim(), id]);
      res.json({ ok: true, message: 'Servicio actualizado' });
    } catch (error) {
      console.error('Error al actualizar servicio:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar servicio', error: error.message });
    }
  });

  // Eliminar servicio
  app.delete('/api/servicios/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const [exists] = await pool.query('SELECT id FROM servicios WHERE id = ?', [id]);
      if (exists.length === 0) {
        return res.status(404).json({ ok: false, message: 'Servicio no encontrado' });
      }

      // Verificar uso en servicios_estudiante
      const [usage] = await pool.query('SELECT COUNT(*) as count FROM servicios_estudiante WHERE servicio_id = ?', [id]);
      if (usage[0].count > 0) {
        return res.status(400).json({ ok: false, message: 'No se puede eliminar: hay estudiantes con este servicio' });
      }

      await pool.query('DELETE FROM servicios WHERE id = ?', [id]);
      res.json({ ok: true, message: 'Servicio eliminado' });
    } catch (error) {
      console.error('Error al eliminar servicio:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar servicio', error: error.message });
    }
  });
}

module.exports = { configurarRutasServicios };

