// ===== GESTIÓN DE ASIGNACIONES BLOQUE-CURSO =====

function configurarRutasBloqueCurso(app, pool, authMiddleware) {
  // Obtener todas las asignaciones bloque-curso
  app.get('/api/bloque_curso', async (req, res) => {
    try {
      const [rows] = await pool.execute('SELECT * FROM bloque_curso ORDER BY id DESC');
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener asignaciones bloque-curso:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener asignaciones', error: error.message });
    }
  });

  // Crear nueva asignación bloque-curso
  app.post('/api/bloque_curso', authMiddleware, async (req, res) => {
    try {
      const { bloque_id, curso_id } = req.body;
      
      // Validar campos obligatorios
      if (!bloque_id || !curso_id) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Los campos bloque_id y curso_id son obligatorios' 
        });
      }

      // Verificar que no exista ya la asignación
      const [existing] = await pool.execute(
        'SELECT id FROM bloque_curso WHERE bloque_id = ? AND curso_id = ?',
        [bloque_id, curso_id]
      );

      if (existing.length > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Ya existe una asignación entre este bloque y curso' 
        });
      }

      // Verificar que el bloque existe
      const [bloqueExists] = await pool.execute('SELECT id FROM bloque WHERE id = ?', [bloque_id]);
      if (bloqueExists.length === 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El bloque especificado no existe' 
        });
      }

      // Verificar que el curso existe
      const [cursoExists] = await pool.execute('SELECT id FROM curso WHERE id = ?', [curso_id]);
      if (cursoExists.length === 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El curso especificado no existe' 
        });
      }

      // Crear la asignación
      const [result] = await pool.execute(
        'INSERT INTO bloque_curso (bloque_id, curso_id) VALUES (?, ?)',
        [bloque_id, curso_id]
      );

      res.json({ 
        ok: true, 
        id: result.insertId, 
        message: 'Asignación bloque-curso creada exitosamente',
        asignacion: { id: result.insertId, bloque_id, curso_id }
      });
    } catch (error) {
      console.error('Error al crear asignación bloque-curso:', error);
      res.status(500).json({ ok: false, message: 'Error al crear asignación', error: error.message });
    }
  });

  // Eliminar asignación bloque-curso
  app.delete('/api/bloque_curso/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Verificar que la asignación existe
      const [existing] = await pool.execute('SELECT id FROM bloque_curso WHERE id = ?', [id]);
      if (existing.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          message: 'Asignación no encontrada' 
        });
      }

      // Eliminar la asignación
      await pool.execute('DELETE FROM bloque_curso WHERE id = ?', [id]);

      res.json({ 
        ok: true, 
        message: 'Asignación eliminada exitosamente' 
      });
    } catch (error) {
      console.error('Error al eliminar asignación bloque-curso:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar asignación', error: error.message });
    }
  });
}

module.exports = { configurarRutasBloqueCurso };

