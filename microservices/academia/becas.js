// ===== GESTIÓN DE BECAS =====

function configurarRutasBecas(app, pool, authMiddleware) {
  // Obtener todas las becas
  app.get('/api/becas', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM becas ORDER BY descripcion');
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener becas:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener becas', error: error.message });
    }
  });

  // Crear una nueva beca
  app.post('/api/becas', authMiddleware, async (req, res) => {
    try {
      // Solo el Director puede crear nuevas becas
      if (!req.user || req.user.rol !== 'Director') {
        return res.status(403).json({
          ok: false,
          message: 'Solo el Director puede crear becas'
        });
      }

      const { descripcion, descuento } = req.body;
      
      // Validaciones
      if (!descripcion || !descuento) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Los campos descripcion y descuento son obligatorios' 
        });
      }

      if (descuento < 0 || descuento > 100) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El descuento debe estar entre 0 y 100 (0% a 100%)' 
        });
      }

      const [result] = await pool.query(
        'INSERT INTO becas (descripcion, descuento) VALUES (?, ?)', 
        [descripcion, parseFloat(descuento)]
      );
      
      res.json({ 
        ok: true, 
        id: result.insertId,
        message: 'Beca creada exitosamente',
        beca: { id: result.insertId, descripcion, descuento }
      });
    } catch (error) {
      console.error('Error al crear beca:', error);
      res.status(500).json({ ok: false, message: 'Error al crear beca', error: error.message });
    }
  });

  // Actualizar una beca
  app.put('/api/becas/:id', authMiddleware, async (req, res) => {
    try {
      // Solo el Director puede actualizar becas
      if (!req.user || req.user.rol !== 'Director') {
        return res.status(403).json({
          ok: false,
          message: 'Solo el Director puede actualizar becas'
        });
      }

      const { id } = req.params;
      const { descripcion, descuento } = req.body;
      
      // Validaciones
      if (!descripcion || !descuento) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Los campos descripcion y descuento son obligatorios' 
        });
      }

      if (descuento < 0 || descuento > 100) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El descuento debe estar entre 0 y 100 (0% a 100%)' 
        });
      }

      // Verificar que la beca existe
      const [existingBeca] = await pool.query('SELECT id FROM becas WHERE id = ?', [id]);
      if (existingBeca.length === 0) {
        return res.status(404).json({ ok: false, message: 'Beca no encontrada' });
      }

      await pool.query(
        'UPDATE becas SET descripcion=?, descuento=? WHERE id=?', 
        [descripcion, parseFloat(descuento), id]
      );
      
      res.json({ 
        ok: true, 
        message: 'Beca actualizada exitosamente',
        beca: { id, descripcion, descuento }
      });
    } catch (error) {
      console.error('Error al actualizar beca:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar beca', error: error.message });
    }
  });

  // Eliminar una beca
  app.delete('/api/becas/:id', authMiddleware, async (req, res) => {
    try {
      // Solo el Director puede eliminar becas
      if (!req.user || req.user.rol !== 'Director') {
        return res.status(403).json({
          ok: false,
          message: 'Solo el Director puede eliminar becas'
        });
      }

      const { id } = req.params;

      // Verificar que la beca existe
      const [existingBeca] = await pool.query('SELECT id FROM becas WHERE id = ?', [id]);
      if (existingBeca.length === 0) {
        return res.status(404).json({ ok: false, message: 'Beca no encontrada' });
      }

      // Verificar si la beca está siendo utilizada
      const [usageCheck] = await pool.query(
        'SELECT COUNT(*) as count FROM inscripciones WHERE id_beca = ?', 
        [id]
      );
      
      if (usageCheck[0].count > 0) {
        await pool.query(
          'UPDATE becas SET descuento = 0 WHERE id = ?',
          [id]
        );
        return res.json({
          ok: true,
          action: 'desactivada',
          message: 'La beca está en uso y no se eliminó. Se actualizó su descuento a 0% para preservar los datos históricos.'
        });
      }

      await pool.query('DELETE FROM becas WHERE id=?', [id]);
      res.json({ ok: true, action: 'eliminada', message: 'Beca eliminada exitosamente' });
    } catch (error) {
      console.error('Error al eliminar beca:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar beca', error: error.message });
    }
  });
}

module.exports = { configurarRutasBecas };

