// ===== GESTIÓN DE NIVELES EDUCATIVOS =====
// Incluye relación con bloques

function configurarRutasNiveles(app, pool, authMiddleware) {
  // Obtener todos los niveles
  app.get('/api/niveles', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT n.id, n.bloque_id, n.nombre, n.descripcion, n.precio, n.meses, b.descripcion as bloque_nombre 
        FROM nivel n 
        LEFT JOIN bloque b ON n.bloque_id = b.id 
        ORDER BY b.id, n.nombre
      `);
      
      // Parsear el campo meses de JSON a array
      const processedRows = rows.map(row => ({
        ...row,
        meses: row.meses ? JSON.parse(row.meses) : []
      }));
      
      res.json(processedRows);
    } catch (error) {
      console.error('Error al obtener niveles:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener niveles', error: error.message });
    }
  });

  // Crear un nuevo nivel (con curso por defecto)
  app.post('/api/niveles', authMiddleware, async (req, res) => {
    try {
      const { bloque_id, nombre, descripcion, precio, meses } = req.body;

      // Validaciones
      if (!bloque_id || !nombre || !precio) {
        return res.status(400).json({
          ok: false,
          message: 'Los campos bloque_id, nombre y precio son obligatorios'
        });
      }

      if (precio < 0) {
        return res.status(400).json({
          ok: false,
          message: 'El precio debe ser mayor o igual a 0'
        });
      }

      // Validar meses si se proporciona
      if (meses && (!Array.isArray(meses) || meses.length === 0)) {
        return res.status(400).json({
          ok: false,
          message: 'El campo meses debe ser un array con al menos un mes'
        });
      }

      // Verificar que el bloque existe
      const [bloqueExists] = await pool.query('SELECT id FROM bloque WHERE id = ?', [bloque_id]);
      if (bloqueExists.length === 0) {
        return res.status(404).json({ ok: false, message: 'El bloque especificado no existe' });
      }

      // Preparar los meses por defecto si no se proporcionan
      const mesesDefault = meses || ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      const mesesJson = JSON.stringify(mesesDefault);

      // Transacción: crear nivel y curso inicial automáticamente
      await pool.query('START TRANSACTION');
      try {
        const [nivelResult] = await pool.query(
          'INSERT INTO nivel (bloque_id, nombre, descripcion, precio, meses) VALUES (?, ?, ?, ?, ?)',
          [bloque_id, nombre, descripcion || null, parseFloat(precio), mesesJson]
        );

        const nivelId = nivelResult.insertId;
        // Crear curso por defecto con prefijo "CURSO " para diferenciar del nivel
        const cursoNombre = 'CURSO ' + nombre;
        const [cursoResult] = await pool.query(
          'INSERT INTO curso (nivel_id, nombre, turno, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?)',
          [nivelId, cursoNombre, null, null, null]
        );

        await pool.query('COMMIT');

        return res.json({
          ok: true,
          id: nivelId,
          message: 'Nivel creado exitosamente (con curso inicial)',
          nivel: { id: nivelId, bloque_id, nombre, descripcion, precio, meses: mesesDefault },
          curso_inicial: { id: cursoResult.insertId, nivel_id: nivelId, nombre: cursoNombre }
        });
      } catch (txError) {
        await pool.query('ROLLBACK');
        console.error('Error en transacción al crear nivel y curso:', txError);
        return res.status(500).json({ ok: false, message: 'Error al crear nivel y curso inicial', error: txError.message });
      }
    } catch (error) {
      console.error('Error al crear nivel:', error);
      res.status(500).json({ ok: false, message: 'Error al crear nivel', error: error.message });
    }
  });

  // Actualizar un nivel
  app.put('/api/niveles/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { bloque_id, nombre, descripcion, precio, meses } = req.body;
      
      // Validaciones
      if (!nombre || !precio) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Los campos nombre y precio son obligatorios' 
        });
      }

      if (precio < 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El precio debe ser mayor o igual a 0' 
        });
      }

      // Validar meses si se proporciona
      if (meses && (!Array.isArray(meses) || meses.length === 0)) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El campo meses debe ser un array con al menos un mes' 
        });
      }

      // Verificar que el nivel existe
      const [existingNivel] = await pool.query('SELECT id FROM nivel WHERE id = ?', [id]);
      if (existingNivel.length === 0) {
        return res.status(404).json({ ok: false, message: 'Nivel no encontrado' });
      }

      // Si se proporciona bloque_id, verificar que existe
      if (bloque_id) {
        const [bloqueExists] = await pool.query('SELECT id FROM bloque WHERE id = ?', [bloque_id]);
        if (bloqueExists.length === 0) {
          return res.status(404).json({ ok: false, message: 'El bloque especificado no existe' });
        }
      }

      // Construir la consulta dinámicamente
      let updateQuery = 'UPDATE nivel SET nombre=?, descripcion=?, precio=?';
      let updateParams = [nombre, descripcion || null, parseFloat(precio)];
      
      if (bloque_id) {
        updateQuery += ', bloque_id=?';
        updateParams.push(bloque_id);
      }

      if (meses) {
        updateQuery += ', meses=?';
        updateParams.push(JSON.stringify(meses));
      }
      
      updateQuery += ' WHERE id=?';
      updateParams.push(id);

      await pool.query(updateQuery, updateParams);
      
      res.json({ 
        ok: true, 
        message: 'Nivel actualizado exitosamente',
        nivel: { id, bloque_id, nombre, descripcion, precio, meses }
      });
    } catch (error) {
      console.error('Error al actualizar nivel:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar nivel', error: error.message });
    }
  });

  // Eliminar un nivel
  app.delete('/api/niveles/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;

      // Verificar que el nivel existe
      const [existingNivel] = await pool.query('SELECT id FROM nivel WHERE id = ?', [id]);
      if (existingNivel.length === 0) {
        return res.status(404).json({ ok: false, message: 'Nivel no encontrado' });
      }

      // Verificar si el nivel está siendo utilizado
      const [usageCheck] = await pool.query(
        'SELECT COUNT(*) as count FROM inscripciones WHERE nivel_id = ?', 
        [id]
      );
      
      if (usageCheck[0].count > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'No se puede eliminar el nivel porque está siendo utilizado en inscripciones' 
        });
      }

      await pool.query('DELETE FROM nivel WHERE id=?', [id]);
      res.json({ ok: true, message: 'Nivel eliminado exitosamente' });
    } catch (error) {
      console.error('Error al eliminar nivel:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar nivel', error: error.message });
    }
  });

  // Obtener niveles por bloque
  app.get('/api/bloques/:bloque_id/niveles', authMiddleware, async (req, res) => {
    try {
      const { bloque_id } = req.params;
      
      // Verificar que el bloque existe
      const [bloqueExists] = await pool.query('SELECT id, descripcion FROM bloque WHERE id = ?', [bloque_id]);
      if (bloqueExists.length === 0) {
        return res.status(404).json({ ok: false, message: 'Bloque no encontrado' });
      }

      const [rows] = await pool.query(`
        SELECT n.*, b.descripcion as bloque_nombre 
        FROM nivel n 
        LEFT JOIN bloque b ON n.bloque_id = b.id 
        WHERE n.bloque_id = ?
        ORDER BY n.nombre
      `, [bloque_id]);
      
      res.json({
        ok: true,
        bloque: bloqueExists[0],
        niveles: rows
      });
    } catch (error) {
      console.error('Error al obtener niveles por bloque:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener niveles por bloque', error: error.message });
    }
  });
}

module.exports = { configurarRutasNiveles };

