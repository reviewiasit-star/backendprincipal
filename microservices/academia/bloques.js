// ===== GESTIÓN DE BLOQUES =====

function configurarRutasBloques(app, pool, authMiddleware) {
  // Obtener todos los bloques
  app.get('/api/bloques', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT id, descripcion, logo_url FROM bloque ORDER BY descripcion');
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener bloques:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener bloques', error: error.message });
    }
  });

  // Crear un nuevo bloque
  app.post('/api/bloques', authMiddleware, async (req, res) => {
    try {
      const { descripcion, logo_url } = req.body;
      
      // Validar campos obligatorios
      if (!descripcion) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El campo descripcion es obligatorio' 
        });
      }

      const [result] = await pool.query(
        'INSERT INTO bloque (descripcion, logo_url) VALUES (?, ?)', 
        [descripcion, logo_url || null]
      );
      
      res.json({ 
        ok: true, 
        id: result.insertId, 
        message: 'Bloque creado exitosamente',
        bloque: { id: result.insertId, descripcion, logo_url: logo_url || null }
      });
    } catch (error) {
      console.error('Error al crear bloque:', error);
      res.status(500).json({ ok: false, message: 'Error al crear bloque', error: error.message });
    }
  });

  // Actualizar un bloque
  app.put('/api/bloques/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { descripcion, logo_url } = req.body;
      
      // Validar campos obligatorios
      if (!descripcion) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El campo descripcion es obligatorio' 
        });
      }

      // Verificar que el bloque existe
      const [existingBloque] = await pool.query('SELECT id FROM bloque WHERE id = ?', [id]);
      if (existingBloque.length === 0) {
        return res.status(404).json({ ok: false, message: 'Bloque no encontrado' });
      }

      await pool.query(
        'UPDATE bloque SET descripcion=?, logo_url=? WHERE id=?',
        [descripcion, logo_url !== undefined ? logo_url : null, id]
      );
      res.json({ 
        ok: true, 
        message: 'Bloque actualizado exitosamente',
        bloque: { id, descripcion, logo_url: logo_url || null }
      });
    } catch (error) {
      console.error('Error al actualizar bloque:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar bloque', error: error.message });
    }
  });

  // Eliminar un bloque
  app.delete('/api/bloques/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;

      // Verificar que el bloque existe
      const [existingBloque] = await pool.query('SELECT id FROM bloque WHERE id = ?', [id]);
      if (existingBloque.length === 0) {
        return res.status(404).json({ ok: false, message: 'Bloque no encontrado' });
      }

      // Verificar si el bloque está siendo utilizado
      const [usageCheck] = await pool.query(
        'SELECT COUNT(*) as count FROM inscripciones WHERE bloque_id = ?', 
        [id]
      );
      
      if (usageCheck[0].count > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'No se puede eliminar el bloque porque está siendo utilizado en inscripciones' 
        });
      }

      await pool.query('DELETE FROM bloque WHERE id=?', [id]);
      res.json({ ok: true, message: 'Bloque eliminado exitosamente' });
    } catch (error) {
      console.error('Error al eliminar bloque:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar bloque', error: error.message });
    }
  });
}

module.exports = { configurarRutasBloques };


