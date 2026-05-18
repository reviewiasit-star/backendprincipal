// ===== GESTIÓN DE CURSOS =====
// Relacionado con niveles

function configurarRutasCursos(app, pool, authMiddleware) {
  const normalizarHora = (valor) => {
    if (valor == null) return null;
    const txt = String(valor).trim();
    if (!txt) return null;
    if (/^\d{2}:\d{2}$/.test(txt)) return `${txt}:00`;
    if (/^\d{2}:\d{2}:\d{2}$/.test(txt)) return txt;
    return null;
  };

  // Obtener todos los cursos
  app.get('/api/cursos', async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT c.*, 
               n.nombre as nivel_nombre, 
               n.precio as nivel_precio,
               b.id as bloque_id,
               b.descripcion as bloque_nombre
        FROM curso c
        LEFT JOIN nivel n ON c.nivel_id = n.id
        LEFT JOIN bloque b ON n.bloque_id = b.id
        ORDER BY b.id, n.nombre, c.nombre
      `);
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener cursos:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener cursos', error: error.message });
    }
  });

  // Obtener cursos por nivel
  app.get('/api/cursos/nivel/:nivel_id', async (req, res) => {
    try {
      const { nivel_id } = req.params;
      const [rows] = await pool.query(
        'SELECT * FROM curso WHERE nivel_id = ? ORDER BY nombre', 
        [nivel_id]
      );
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener cursos por nivel:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener cursos', error: error.message });
    }
  });

  // Obtener cursos por bloque
  app.get('/api/bloques/:bloque_id/cursos', authMiddleware, async (req, res) => {
    try {
      const { bloque_id } = req.params;
      
      // Verificar que el bloque existe
      const [bloqueExists] = await pool.query('SELECT id, descripcion FROM bloque WHERE id = ?', [bloque_id]);
      if (bloqueExists.length === 0) {
        return res.status(404).json({ ok: false, message: 'Bloque no encontrado' });
      }

      const [rows] = await pool.query(`
        SELECT c.*, 
               n.nombre as nivel_nombre, 
               n.precio as nivel_precio,
               b.descripcion as bloque_nombre
        FROM curso c
        LEFT JOIN nivel n ON c.nivel_id = n.id
        LEFT JOIN bloque b ON n.bloque_id = b.id
        WHERE b.id = ?
        ORDER BY n.nombre, c.nombre
      `, [bloque_id]);
      
      res.json({
        ok: true,
        bloque: bloqueExists[0],
        cursos: rows
      });
    } catch (error) {
      console.error('Error al obtener cursos por bloque:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener cursos por bloque', error: error.message });
    }
  });

  // Crear un nuevo curso
  app.post('/api/cursos', authMiddleware, async (req, res) => {
    try {
      const { nivel_id, nombre, turno, hora_inicio, hora_fin } = req.body;
      
      // Validaciones
      if (!nivel_id || !nombre) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Los campos nivel_id y nombre son obligatorios' 
        });
      }

      // Verificar que el nivel existe
      const [nivelExists] = await pool.query('SELECT id FROM nivel WHERE id = ?', [nivel_id]);
      if (nivelExists.length === 0) {
        return res.status(400).json({ ok: false, message: 'El nivel especificado no existe' });
      }

      const horaInicioNormalizada = normalizarHora(hora_inicio);
      const horaFinNormalizada = normalizarHora(hora_fin);
      if ((hora_inicio && !horaInicioNormalizada) || (hora_fin && !horaFinNormalizada)) {
        return res.status(400).json({
          ok: false,
          message: 'Formato de hora inválido. Usa HH:mm o HH:mm:ss'
        });
      }

      const [result] = await pool.query(
        'INSERT INTO curso (nivel_id, nombre, turno, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?)', 
        [nivel_id, nombre, turno || null, horaInicioNormalizada, horaFinNormalizada]
      );
      
      res.json({ 
        ok: true, 
        id: result.insertId, 
        message: 'Curso creado exitosamente',
        curso: { id: result.insertId, nivel_id, nombre, turno: turno || null, hora_inicio: horaInicioNormalizada, hora_fin: horaFinNormalizada }
      });
    } catch (error) {
      console.error('Error al crear curso:', error);
      res.status(500).json({ ok: false, message: 'Error al crear curso', error: error.message });
    }
  });

  // Actualizar un curso
  app.put('/api/cursos/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { nivel_id, nombre, turno, hora_inicio, hora_fin } = req.body;
      
      // Validaciones
      if (!nivel_id || !nombre) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Los campos nivel_id y nombre son obligatorios' 
        });
      }

      // Verificar que el curso existe
      const [existingCurso] = await pool.query('SELECT id FROM curso WHERE id = ?', [id]);
      if (existingCurso.length === 0) {
        return res.status(404).json({ ok: false, message: 'Curso no encontrado' });
      }

      // Verificar que el nivel existe
      const [nivelExists] = await pool.query('SELECT id FROM nivel WHERE id = ?', [nivel_id]);
      if (nivelExists.length === 0) {
        return res.status(400).json({ ok: false, message: 'El nivel especificado no existe' });
      }

      const horaInicioNormalizada = normalizarHora(hora_inicio);
      const horaFinNormalizada = normalizarHora(hora_fin);
      if ((hora_inicio && !horaInicioNormalizada) || (hora_fin && !horaFinNormalizada)) {
        return res.status(400).json({
          ok: false,
          message: 'Formato de hora inválido. Usa HH:mm o HH:mm:ss'
        });
      }

      await pool.query(
        'UPDATE curso SET nivel_id=?, nombre=?, turno=?, hora_inicio=?, hora_fin=? WHERE id=?', 
        [nivel_id, nombre, turno || null, horaInicioNormalizada, horaFinNormalizada, id]
      );
      
      res.json({ 
        ok: true, 
        message: 'Curso actualizado exitosamente',
        curso: { id, nivel_id, nombre, turno: turno || null, hora_inicio: horaInicioNormalizada, hora_fin: horaFinNormalizada }
      });
    } catch (error) {
      console.error('Error al actualizar curso:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar curso', error: error.message });
    }
  });

  // Eliminar un curso
  app.delete('/api/cursos/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;

      // Verificar que el curso existe
      const [existingCurso] = await pool.query('SELECT id FROM curso WHERE id = ?', [id]);
      if (existingCurso.length === 0) {
        return res.status(404).json({ ok: false, message: 'Curso no encontrado' });
      }

      // Verificar si el curso está siendo utilizado
      const [usageCheck] = await pool.query(
        'SELECT COUNT(*) as count FROM inscripciones WHERE curso_id = ?', 
        [id]
      );
      
      if (usageCheck[0].count > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'No se puede eliminar el curso porque está siendo utilizado en inscripciones' 
        });
      }

      await pool.query('DELETE FROM curso WHERE id=?', [id]);
      res.json({ ok: true, message: 'Curso eliminado exitosamente' });
    } catch (error) {
      console.error('Error al eliminar curso:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar curso', error: error.message });
    }
  });
}

module.exports = { configurarRutasCursos };

