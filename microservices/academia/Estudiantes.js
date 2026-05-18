// Función para configurar las rutas de gestión de estudiantes
const { guardarContactosWhatsApp } = require('./contacto-aviso');

function configurarRutasEstudiantes(app, pool, authMiddleware) {

  // ===== ENDPOINTS PARA GESTIÓN DE ESTUDIANTES =====

  // Endpoint específico para búsqueda básica de estudiantes (sin datos de inscripciones)
  app.get('/api/estudiantes/busqueda-basica', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.fecha_nacimiento, e.lugar_nacimiento, e.genero, e.direccion,
               e.nombre_padre, e.apellido_padre, e.ci_padre, 
               e.nombre_madre, e.apellido_madre, e.ci_madre,
               e.telefono_domicilio_padre, e.telefono_oficina_padre,
               e.telefono_domicilio_madre, e.telefono_oficina_madre,
               e.codigo_estudiante, e.fecha_registro as fecha_creacion
        FROM estudiantes e
        WHERE e.estado_id = 1
        ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre
      `);

      res.json(rows);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiantes',
        error: error.message
      });
    }
  });

  // Buscar estudiantes (hijos) por número de teléfono del tutor/padre/madre/autorizado
  // Útil para atención presencial: se ingresa el número y se listan estudiantes asociados.
  app.get('/api/estudiantes/hijos-por-telefono', authMiddleware, async (req, res) => {
    try {
      const telefono = String(req.query.telefono || '').trim();
      if (!telefono) {
        return res.status(400).json({ ok: false, message: 'El parámetro telefono es requerido' });
      }

      const soloDigitos = telefono.replace(/\D/g, '');
      if (soloDigitos.length < 7) {
        return res.status(400).json({ ok: false, message: 'Número de teléfono inválido' });
      }

      const ultimos8 = soloDigitos.length >= 8 ? soloDigitos.slice(-8) : soloDigitos;
      const patternMain = `%${soloDigitos}%`;
      const pattern8 = `%${ultimos8}%`;

      const [rows] = await pool.query(
        `
        SELECT DISTINCT
          e.id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          e.codigo_estudiante
        FROM estudiantes e
        WHERE e.estado_id = 1
          AND (
            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          )
        ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre
        `,
        [
          patternMain, patternMain, patternMain, patternMain, patternMain, patternMain,
          pattern8, pattern8, pattern8, pattern8, pattern8, pattern8
        ]
      );

      return res.json({ ok: true, estudiantes: rows });
    } catch (error) {
      console.error('Error en hijos-por-telefono:', error);
      return res.status(500).json({ ok: false, message: 'Error al buscar estudiantes por teléfono', error: error.message });
    }
  });

  // ===== NUEVO: Buscar datos del padre/madre por CI =====
  // Permite autocompletar datos al registrar hermanos
  app.get('/api/estudiantes/buscar-padre-por-ci/:ci', authMiddleware, async (req, res) => {
    try {
      const { ci } = req.params;

      if (!ci || ci.length < 5) {
        return res.json({ encontrado: false, mensaje: 'CI muy corto' });
      }

      // Buscar primer estudiante que tenga este CI como padre o madre
      const [rows] = await pool.query(`
        SELECT 
          nombre_padre, apellido_padre, ci_padre, tipo_ci_padre, extension_ci_padre,
          profesion_padre, lugar_trabajo_padre, telefono_domicilio_padre, telefono_oficina_padre,
          nombre_madre, apellido_madre, ci_madre, tipo_ci_madre, extension_ci_madre,
          profesion_madre, lugar_trabajo_madre, telefono_domicilio_madre, telefono_oficina_madre,
          direccion,
          nombre_autorizado1, telefono_autorizado1, nombre_autorizado2, telefono_autorizado2
        FROM estudiantes
        WHERE (ci_padre = ? OR ci_madre = ?) AND estado_id = 1
        LIMIT 1
      `, [ci, ci]);

      if (rows.length === 0) {
        return res.json({ encontrado: false, mensaje: 'No se encontró padre/madre con ese CI' });
      }

      // Determinar si el CI corresponde al padre o a la madre
      const datos = rows[0];
      const esPadre = datos.ci_padre === ci;
      const esMadre = datos.ci_madre === ci;

      // Contar cuántos hijos tiene este padre/madre
      const [conteo] = await pool.query(`
        SELECT COUNT(*) as total_hijos
        FROM estudiantes
        WHERE (ci_padre = ? OR ci_madre = ?) AND estado_id = 1
      `, [ci, ci]);

      res.json({
        encontrado: true,
        datos: datos,
        esPadre: esPadre,
        esMadre: esMadre,
        totalHijos: conteo[0].total_hijos,
        mensaje: `Se encontraron datos. Este padre/madre tiene ${conteo[0].total_hijos} hijo(s) registrado(s).`
      });

    } catch (error) {
      console.error('Error en buscar-padre-por-ci:', error);
      res.status(500).json({
        ok: false,
        encontrado: false,
        message: 'Error al buscar padre por CI',
        error: error.message
      });
    }
  });

  // Listar todos los estudiantes con sus inscripciones y filtros
  app.get('/api/estudiantes', authMiddleware, async (req, res) => {
    try {
      const { filtro, anio, incluir_concluidos, incluir_todos_estados } = req.query; // Parámetro de filtro, año y opciones
      const isAllYears = typeof anio === 'string' && anio.toLowerCase().trim() === 'todos';
      const anioNum = isAllYears ? new Date().getFullYear() : (parseInt(anio, 10) || new Date().getFullYear());
      const includeConcluidos = incluir_concluidos === '1' || incluir_concluidos === 'true';
      const incluirTodosEstados = incluir_todos_estados === '1' || incluir_todos_estados === 'true';
      // Nota: "retirado" (abandono/baja lógica) se considera un estado histórico, similar a "concluido".
      const estadoInscCond = includeConcluidos ? "i.estado IN ('activo','concluido','retirado')" : "i.estado = 'activo'";
      const yearCond = isAllYears
        ? '1=1'
        : `((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum}) OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))`;

      let whereCondition = incluirTodosEstados ? '1=1' : 'e.estado_id = 1';

      // Aplicar filtros según el parámetro
      switch (filtro) {
        case 'con_nivel':
          whereCondition += ` AND (SELECT i.nivel_id FROM inscripciones i 
                                   WHERE i.estudiante_id = e.id 
                                     AND ${estadoInscCond}
                                     AND ((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum})
                                       OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))
                                   ORDER BY i.fecha_inscripcion DESC LIMIT 1) IS NOT NULL`;
          break;
        case 'sin_nivel':
          whereCondition += ` AND (SELECT i.nivel_id FROM inscripciones i 
                                   WHERE i.estudiante_id = e.id 
                                     AND ${estadoInscCond}
                                     AND ((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum})
                                       OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))
                                   ORDER BY i.fecha_inscripcion DESC LIMIT 1) IS NULL`;
          break;
        case 'con_curso':
          whereCondition += ` AND (SELECT i.curso_id FROM inscripciones i 
                                   WHERE i.estudiante_id = e.id 
                                     AND ${estadoInscCond}
                                     AND ((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum})
                                       OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))
                                   ORDER BY i.fecha_inscripcion DESC LIMIT 1) IS NOT NULL`;
          break;
        case 'sin_curso':
          whereCondition += ` AND (SELECT i.curso_id FROM inscripciones i 
                                   WHERE i.estudiante_id = e.id 
                                     AND ${estadoInscCond}
                                     AND ((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum})
                                       OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))
                                   ORDER BY i.fecha_inscripcion DESC LIMIT 1) IS NULL`;
          break;
        case 'con_compromiso':
          whereCondition += ' AND ce.id IS NOT NULL';
          break;
        case 'sin_compromiso':
          whereCondition += ' AND ce.id IS NULL';
          break;
        case 'compromiso_activo':
          whereCondition += ' AND ce.estado_compromiso = "activo"';
          break;
        case 'compromiso_concluido':
          whereCondition += ' AND ce.estado_compromiso = "concluido"';
          break;
      }

      const [rows] = await pool.query(`
        SELECT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.fecha_nacimiento, e.lugar_nacimiento, e.genero, e.direccion,
               e.nombre_padre, e.apellido_padre, e.ci_padre, 
               e.nombre_madre, e.apellido_madre, e.ci_madre,
               e.telefono_domicilio_padre, e.telefono_oficina_padre,
               e.telefono_domicilio_madre, e.telefono_oficina_madre,
               e.fecha_registro as fecha_creacion,
               e.codigo_estudiante,
               e.estado_id,
               COALESCE((SELECT ee.nombre FROM estados_estudiante ee WHERE ee.id = e.estado_id), 'Activo') as estado_estudiante_nombre,
               -- Información de la inscripción más reciente
               (SELECT i.id FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as inscripcion_id,
               (SELECT i.nivel_id FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as nivel_id,
               COALESCE((SELECT n.nombre FROM inscripciones i 
                         LEFT JOIN nivel n ON i.nivel_id = n.id 
                         WHERE i.estudiante_id = e.id 
                           AND ${estadoInscCond}
                           AND ${yearCond}
                         ORDER BY i.fecha_inscripcion DESC LIMIT 1), 'Sin nivel') AS nivel_nombre,
               (SELECT i.curso_id FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as curso_id,
               COALESCE((SELECT c.nombre FROM inscripciones i 
                         LEFT JOIN curso c ON i.curso_id = c.id 
                         WHERE i.estudiante_id = e.id 
                           AND ${estadoInscCond}
                           AND ${yearCond}
                         ORDER BY i.fecha_inscripcion DESC LIMIT 1), 'Sin curso') AS curso_nombre,
               (SELECT i.bloque_id FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as bloque_id,
               COALESCE((SELECT b.descripcion FROM inscripciones i 
                         LEFT JOIN bloque b ON i.bloque_id = b.id 
                         WHERE i.estudiante_id = e.id 
                           AND ${estadoInscCond}
                           AND ${yearCond}
                         ORDER BY i.fecha_inscripcion DESC LIMIT 1), 'Sin bloque') AS bloque_nombre,
               (SELECT i.turno FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as turno,
               (SELECT i.fecha_inscripcion FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as fecha_inscripcion,
               (SELECT i.id_beca FROM inscripciones i 
                 WHERE i.estudiante_id = e.id 
                   AND ${estadoInscCond}
                   AND ${yearCond}
                 ORDER BY i.fecha_inscripcion DESC LIMIT 1) as id_beca,
               CASE 
                 WHEN EXISTS (SELECT 1 FROM inscripciones i 
                              WHERE i.estudiante_id = e.id 
                                AND i.estado = 'activo'
                                AND ${yearCond})
                 THEN 'activo'
                WHEN ${includeConcluidos ? `EXISTS (SELECT 1 FROM inscripciones i 
                             WHERE i.estudiante_id = e.id 
                               AND i.estado = 'retirado'
                               AND ${yearCond})` : 'FALSE'}
                THEN 'retirado'
                WHEN ${includeConcluidos ? `EXISTS (SELECT 1 FROM inscripciones i 
                             WHERE i.estudiante_id = e.id 
                               AND i.estado = 'concluido'
                               AND ${yearCond})` : 'FALSE'}
                 THEN 'concluido'
                 ELSE 'Sin inscripción'
               END as estado_inscripcion,
               -- Información del compromiso
               ce.id as compromiso_id,
               ce.estado_compromiso,
               ce.total_general as monto_compromiso,
               ce.fecha_creacion as fecha_compromiso,
               ce.observacion as observacion_compromiso,
               -- Indicadores de estado
               CASE 
                 WHEN (SELECT i.nivel_id FROM inscripciones i 
                        WHERE i.estudiante_id = e.id 
                          AND i.estado = 'activo'
                          AND ((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum})
                            OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))
                        ORDER BY i.fecha_inscripcion DESC LIMIT 1) IS NOT NULL THEN 'Sí' 
                 ELSE 'No' 
               END as tiene_nivel,
               CASE 
                 WHEN (SELECT i.curso_id FROM inscripciones i 
                        WHERE i.estudiante_id = e.id 
                          AND i.estado = 'activo'
                          AND ((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum})
                            OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))
                        ORDER BY i.fecha_inscripcion DESC LIMIT 1) IS NOT NULL THEN 'Sí' 
                 ELSE 'No' 
               END as tiene_curso,
               CASE 
                 WHEN ce.id IS NOT NULL THEN 'Sí' 
                 ELSE 'No' 
               END as tiene_compromiso
        FROM estudiantes e
        LEFT JOIN compromiso_economico ce ON e.id = ce.id_estudiante
        WHERE ${whereCondition}
        ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre, ce.fecha_creacion DESC
      `);

      res.json(rows);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiantes',
        error: error.message
      });
    }
  });

  // Obtener un estudiante por ID (seleccionando inscripción por año si se solicita)
  app.get('/api/estudiantes/:id', async (req, res) => {
    try {
      const estudianteId = req.params.id;
      const anioParam = req.query.anio ? parseInt(req.query.anio, 10) : null;

      let query = `
        SELECT 
          e.*, 
          i.id AS inscripcion_id, 
          i.nivel_id, n.nombre AS nivel_nombre,
          i.curso_id, c.nombre AS curso_nombre, 
          i.bloque_id, b.descripcion AS bloque_nombre,
          i.turno, i.fecha_inscripcion, i.id_beca, i.estado AS estado_inscripcion
        FROM estudiantes e
        LEFT JOIN inscripciones i 
          ON i.id = (
            SELECT i2.id FROM inscripciones i2 
            WHERE i2.estudiante_id = e.id
              ${anioParam !== null
          ? `AND ((i2.gestion_academica IS NOT NULL AND i2.gestion_academica = ?) OR (i2.gestion_academica IS NULL AND YEAR(i2.fecha_inscripcion) = ?))`
          : `AND i2.estado = 'activo'`}
            ORDER BY i2.fecha_inscripcion DESC 
            LIMIT 1
          )
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        WHERE e.id = ? AND e.estado_id = 1
      `;

      const params = [];
      if (anioParam !== null) {
        params.push(anioParam, anioParam);
      }
      params.push(estudianteId);

      const [rows] = await pool.query(query, params);

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Estudiante no encontrado' });
      }

      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiante',
        error: error.message
      });
    }
  });

  // Buscar estudiante por CI de padre o madre
  app.get('/api/estudiantes/buscar-por-ci-padre/:ci', async (req, res) => {
    try {
      const { ci } = req.params;
      const [rows] = await pool.query(`
        SELECT e.*, i.id as inscripcion_id, i.nivel_id, n.nombre AS nivel_nombre, 
               i.curso_id, c.nombre AS curso_nombre, i.bloque_id, b.descripcion AS bloque_nombre, 
               i.turno, i.fecha_inscripcion, i.id_beca, i.estado as estado_inscripcion
        FROM estudiantes e
        LEFT JOIN inscripciones i ON e.id = i.estudiante_id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        WHERE (e.ci_padre = ? OR e.ci_madre = ?) AND e.estado_id = 1
        LIMIT 1
      `, [ci, ci]);

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Estudiante no encontrado' });
      }

      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al buscar estudiante',
        error: error.message
      });
    }
  });

  // Buscar estudiante por nombre (con apellido materno)
  app.get('/api/estudiantes/buscar/:nombre/:apellido_paterno/:apellido_materno', async (req, res) => {
    try {
      const { nombre, apellido_paterno, apellido_materno } = req.params;
      const query = `
        SELECT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.fecha_nacimiento, e.lugar_nacimiento, e.genero, e.direccion,
               e.nombre_padre, e.apellido_padre, e.ci_padre, 
               e.nombre_madre, e.apellido_madre, e.ci_madre,
               e.telefono_domicilio_padre, e.telefono_oficina_padre,
               e.telefono_domicilio_madre, e.telefono_oficina_madre,
               e.fecha_registro, e.estado_id, e.codigo_estudiante
        FROM estudiantes e
        WHERE e.nombre LIKE ? AND e.apellido_paterno LIKE ? AND e.apellido_materno LIKE ? AND e.estado_id = 1
        LIMIT 1
      `;

      const params = [`%${nombre}%`, `%${apellido_paterno}%`, `%${apellido_materno}%`];
      const [rows] = await pool.query(query, params);

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Estudiante no encontrado' });
      }

      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al buscar estudiante',
        error: error.message
      });
    }
  });

  // Buscar estudiante por nombre (sin apellido materno)
  app.get('/api/estudiantes/buscar/:nombre/:apellido_paterno', async (req, res) => {
    try {
      const { nombre, apellido_paterno } = req.params;
      const query = `
        SELECT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.fecha_nacimiento, e.lugar_nacimiento, e.genero, e.direccion,
               e.nombre_padre, e.apellido_padre, e.ci_padre, 
               e.nombre_madre, e.apellido_madre, e.ci_madre,
               e.telefono_domicilio_padre, e.telefono_oficina_padre,
               e.telefono_domicilio_madre, e.telefono_oficina_madre,
               e.fecha_registro, e.estado_id, e.codigo_estudiante
        FROM estudiantes e
        WHERE e.nombre LIKE ? AND e.apellido_paterno LIKE ? AND e.estado_id = 1
        LIMIT 1
      `;

      const params = [`%${nombre}%`, `%${apellido_paterno}%`];
      const [rows] = await pool.query(query, params);

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Estudiante no encontrado' });
      }

      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al buscar estudiante',
        error: error.message
      });
    }
  });

  // Buscar estudiante por CI
  app.get('/api/estudiantes/buscar-por-ci/:ci', async (req, res) => {
    try {
      const { ci } = req.params;
      const [rows] = await pool.query(`
        SELECT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.fecha_nacimiento, e.lugar_nacimiento, e.genero, e.direccion,
               e.nombre_padre, e.apellido_padre, e.ci_padre, 
               e.nombre_madre, e.apellido_madre, e.ci_madre,
               e.telefono_domicilio_padre, e.telefono_oficina_padre,
               e.telefono_domicilio_madre, e.telefono_oficina_madre,
               e.fecha_registro, e.estado_id, e.codigo_estudiante
        FROM estudiantes e
        WHERE e.ci_estudiante = ? AND e.estado_id = 1
        LIMIT 1
      `, [ci]);

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Estudiante no encontrado' });
      }

      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al buscar estudiante',
        error: error.message
      });
    }
  });

  // Buscar estudiantes por query (para el buscador del MaterialApoyo)
  app.get('/api/estudiantes/buscar', authMiddleware, async (req, res) => {
    try {
      const { q } = req.query;

      if (!q || q.trim().length < 2) {
        return res.json([]);
      }

      const searchTerm = `%${q.trim()}%`;
      const [rows] = await pool.query(`
        SELECT DISTINCT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.codigo_estudiante,
               CONCAT(e.nombre, ' ', e.apellido_paterno, ' ', IFNULL(e.apellido_materno, '')) as nombre_completo,
               i.nivel_id, n.nombre as nivel_nombre,
               i.bloque_id, b.descripcion as bloque_nombre,
               i.curso_id, c.nombre as curso_nombre,
               i.turno, i.estado as estado_inscripcion
        FROM estudiantes e
        INNER JOIN inscripciones i ON e.id = i.estudiante_id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN curso c ON i.curso_id = c.id
        WHERE e.estado_id = 1 
        AND i.estado = 'activo'
        AND (
          e.nombre LIKE ? OR 
          e.apellido_paterno LIKE ? OR 
          e.apellido_materno LIKE ? OR
          e.ci_estudiante LIKE ? OR
          e.codigo_estudiante LIKE ? OR
          CONCAT(e.nombre, ' ', e.apellido_paterno, ' ', IFNULL(e.apellido_materno, '')) LIKE ?
        )
        ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre
        LIMIT 20
      `, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]);

      res.json(rows);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al buscar estudiantes',
        error: error.message
      });
    }
  });

  // Crear nuevo estudiante
  app.post('/api/estudiantes', authMiddleware, async (req, res) => {
    try {
      console.log('Datos recibidos en el backend:', req.body);

      const {
        codigo_estudiante, nombre, apellido_paterno, apellido_materno, ci_estudiante,
        fecha_nacimiento, lugar_nacimiento, genero, direccion,
        nombre_padre, apellido_padre, ci_padre, profesion_padre, lugar_trabajo_padre,
        tipo_ci_padre, extension_ci_padre,
        telefono_domicilio_padre, telefono_oficina_padre,
        nombre_madre, apellido_madre, ci_madre, profesion_madre, lugar_trabajo_madre,
        tipo_ci_madre, extension_ci_madre,
        telefono_domicilio_madre, telefono_oficina_madre,
        nombre_autorizado1, telefono_autorizado1,
        nombre_autorizado2, telefono_autorizado2,
        whatsapp_domicilio_padre, whatsapp_oficina_padre, // NUEVO
        whatsapp_domicilio_madre, whatsapp_oficina_madre, // NUEVO
        alergias, vacunas, seguro_medico
      } = req.body;

      // Mapear género de M/F a masculino/femenino
      const generoMapeado = genero === 'M' ? 'masculino' : genero === 'F' ? 'femenino' : genero;

      // Validaciones básicas
      if (!nombre || !ci_estudiante || !fecha_nacimiento) {
        return res.status(400).json({
          ok: false,
          message: 'Nombre, CI y fecha de nacimiento son requeridos'
        });
      }

      // Verificar si el CI ya existe
      const [existingStudent] = await pool.query(
        'SELECT id FROM estudiantes WHERE ci_estudiante = ? AND estado_id = 1',
        [ci_estudiante]
      );

      if (existingStudent.length > 0) {
        return res.status(400).json({
          ok: false,
          message: 'Ya existe un estudiante con este CI'
        });
      }

      console.log('Valores a insertar:', [
        codigo_estudiante, nombre, apellido_paterno, apellido_materno, ci_estudiante,
        fecha_nacimiento, lugar_nacimiento, generoMapeado, direccion,
        nombre_padre, apellido_padre, ci_padre, tipo_ci_padre || 'ci', extension_ci_padre || null, profesion_padre, lugar_trabajo_padre,
        telefono_domicilio_padre, telefono_oficina_padre,
        nombre_madre, apellido_madre, ci_madre, tipo_ci_madre || 'ci', extension_ci_madre || null, profesion_madre, lugar_trabajo_madre,
        telefono_domicilio_madre, telefono_oficina_madre,
        nombre_autorizado1, telefono_autorizado1,
        nombre_autorizado2, telefono_autorizado2,
        alergias, 1, vacunas, seguro_medico
      ]);

      console.log('Ejecutando consulta SQL...');

      const [result] = await pool.query(`
        INSERT INTO estudiantes (
          codigo_estudiante, nombre, apellido_paterno, apellido_materno, ci_estudiante,
          fecha_nacimiento, lugar_nacimiento, genero, direccion,
          nombre_padre, apellido_padre, ci_padre, tipo_ci_padre, extension_ci_padre, profesion_padre, lugar_trabajo_padre,
          telefono_domicilio_padre, telefono_oficina_padre,
          nombre_madre, apellido_madre, ci_madre, tipo_ci_madre, extension_ci_madre, profesion_madre, lugar_trabajo_madre,
          telefono_domicilio_madre, telefono_oficina_madre,
          nombre_autorizado1, telefono_autorizado1,
          nombre_autorizado2, telefono_autorizado2,
          alergias, estado_id, vacunas, seguro_medico
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigo_estudiante, nombre, apellido_paterno, apellido_materno, ci_estudiante,
          fecha_nacimiento, lugar_nacimiento, generoMapeado, direccion,
          nombre_padre, apellido_padre, ci_padre, tipo_ci_padre || 'ci', extension_ci_padre || null, profesion_padre, lugar_trabajo_padre,
          telefono_domicilio_padre, telefono_oficina_padre,
          nombre_madre, apellido_madre, ci_madre, tipo_ci_madre || 'ci', extension_ci_madre || null, profesion_madre, lugar_trabajo_madre,
          telefono_domicilio_madre, telefono_oficina_madre,
          nombre_autorizado1, telefono_autorizado1,
          nombre_autorizado2, telefono_autorizado2,
          alergias, 1, vacunas, seguro_medico
        ]
      );

      console.log('Consulta ejecutada exitosamente. Insert ID:', result.insertId);

      const estudianteId = result.insertId;

      // ✅ NUEVO: Guardar contactos WhatsApp
      try {
        await guardarContactosWhatsApp(
          estudianteId,
          {
            telefono_domicilio_padre,
            telefono_oficina_padre,
            telefono_domicilio_madre,
            telefono_oficina_madre,
            whatsapp_domicilio_padre: !!whatsapp_domicilio_padre,
            whatsapp_oficina_padre: !!whatsapp_oficina_padre,
            whatsapp_domicilio_madre: !!whatsapp_domicilio_madre,
            whatsapp_oficina_madre: !!whatsapp_oficina_madre,
          },
          {
            nombre_padre,
            apellido_padre,
            nombre_madre,
            apellido_madre,
          }
        );
        console.log('✅ Contactos WhatsApp registrados para el nuevo estudiante');
      } catch (waError) {
        console.error('⚠️ Error guardando contactos WhatsApp en CREATE:', waError);
      }

      // Si se proporciona información de inscripción, crear la inscripción
      if (req.body.nivel_id || req.body.curso_id) {
        const {
          nivel_id, curso_id, bloque_id,
          turno, fecha_inscripcion, id_beca, meses_beca
        } = req.body;

        await pool.query(
          `INSERT INTO inscripciones (
            estudiante_id, nivel_id, curso_id, bloque_id, 
            turno, fecha_inscripcion, id_beca, meses_beca
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            estudianteId, nivel_id, curso_id, bloque_id,
            turno, fecha_inscripcion, id_beca, meses_beca
          ]
        );
      }

      res.json({
        ok: true,
        id: estudianteId,
        message: 'Estudiante creado exitosamente'
      });
    } catch (error) {
      console.error('Error completo al crear estudiante:', error);
      console.error('Código de error SQL:', error.code);
      console.error('Número de error SQL:', error.errno);
      console.error('Estado SQL:', error.sqlState);
      console.error('Mensaje SQL:', error.sqlMessage);

      res.status(500).json({
        ok: false,
        message: 'Error al crear estudiante',
        error: error.message,
        sqlError: error.sqlMessage || error.message
      });
    }
  });

  // Actualizar estudiante
  app.put('/api/estudiantes/:id', authMiddleware, async (req, res) => {
    try {
      const {
        nombre, apellido_paterno, apellido_materno, ci_estudiante,
        fecha_nacimiento, lugar_nacimiento, genero, direccion, codigo_estudiante,
        nivel_id, curso_id, bloque_id, turno, fecha_inscripcion,
        nombre_padre, apellido_padre, ci_padre, tipo_ci_padre, extension_ci_padre, profesion_padre, lugar_trabajo_padre,
        telefono_domicilio_padre, telefono_oficina_padre,
        whatsapp_domicilio_padre, whatsapp_oficina_padre, // NUEVO
        nombre_madre, apellido_madre, ci_madre, tipo_ci_madre, extension_ci_madre, profesion_madre, lugar_trabajo_madre,
        telefono_domicilio_madre, telefono_oficina_madre,
        whatsapp_domicilio_madre, whatsapp_oficina_madre, // NUEVO
        autorizado1_nombre, autorizado1_telefono, autorizado2_nombre, autorizado2_telefono,
        nombre_autorizado1, telefono_autorizado1, nombre_autorizado2, telefono_autorizado2,
        seguro_medico, alergias, vacunas, id_beca
      } = req.body;

      // Mapear campos alternativos del frontend
      const autorizado1Nombre = autorizado1_nombre || nombre_autorizado1 || '';
      const autorizado1Telefono = autorizado1_telefono || telefono_autorizado1 || '';
      const autorizado2Nombre = autorizado2_nombre || nombre_autorizado2 || '';
      const autorizado2Telefono = autorizado2_telefono || telefono_autorizado2 || '';

      const estudianteId = req.params.id;

      // Verificar si el estudiante existe
      const [existingStudent] = await pool.query(
        'SELECT id FROM estudiantes WHERE id = ? AND estado_id = 1',
        [estudianteId]
      );

      if (existingStudent.length === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Estudiante no encontrado'
        });
      }

      // Verificar si el CI ya existe (excluyendo el estudiante actual)
      const [duplicateCI] = await pool.query(
        'SELECT id FROM estudiantes WHERE ci_estudiante = ? AND id != ? AND estado_id = 1',
        [ci_estudiante, estudianteId]
      );

      if (duplicateCI.length > 0) {
        return res.status(400).json({
          ok: false,
          message: 'Ya existe otro estudiante con este CI'
        });
      }

      // ✅ ACTUALIZADO: Guardar contactos WhatsApp
      try {
        await guardarContactosWhatsApp(
          estudianteId,
          {
            telefono_domicilio_padre,
            telefono_oficina_padre,
            telefono_domicilio_madre,
            telefono_oficina_madre,
            whatsapp_domicilio_padre,
            whatsapp_oficina_padre,
            whatsapp_domicilio_madre,
            whatsapp_oficina_madre,
          },
          {
            nombre_padre,
            apellido_padre,
            nombre_madre,
            apellido_madre,
          }
        );
      } catch (waError) {
        console.error('⚠️ Error guardando contactos WhatsApp en UPDATE:', waError);
      }

      // Actualizar datos del estudiante
      // Mapear género de M/F a masculino/femenino si es necesario
      const generoMapeado = genero === 'M' ? 'masculino' : genero === 'F' ? 'femenino' : genero;

      // Asegurar que los valores requeridos no sean undefined
      const updateData = [
        nombre || '',
        apellido_paterno || '',
        apellido_materno || '',
        ci_estudiante || '',
        fecha_nacimiento || null,
        lugar_nacimiento || '',
        generoMapeado || '',
        direccion || '',
        nombre_padre || '',
        apellido_padre || '',
        ci_padre || '',
        tipo_ci_padre || 'ci',
        extension_ci_padre || null,
        profesion_padre || '',
        lugar_trabajo_padre || '',
        telefono_domicilio_padre || '',
        telefono_oficina_padre || '',
        nombre_madre || '',
        apellido_madre || '',
        ci_madre || '',
        tipo_ci_madre || 'ci',
        extension_ci_madre || null,
        profesion_madre || '',
        lugar_trabajo_madre || '',
        telefono_domicilio_madre || '',
        telefono_oficina_madre || '',
        autorizado1Nombre || '',
        autorizado1Telefono || '',
        autorizado2Nombre || '',
        autorizado2Telefono || '',
        seguro_medico || '',
        alergias || '',
        vacunas || '',
        estudianteId
      ];

      await pool.query(`
        UPDATE estudiantes SET 
          nombre=?, apellido_paterno=?, apellido_materno=?, ci_estudiante=?,
          fecha_nacimiento=?, lugar_nacimiento=?, genero=?, direccion=?,
          nombre_padre=?, apellido_padre=?, ci_padre=?, tipo_ci_padre=?, extension_ci_padre=?, profesion_padre=?, lugar_trabajo_padre=?,
          telefono_domicilio_padre=?, telefono_oficina_padre=?,
          nombre_madre=?, apellido_madre=?, ci_madre=?, tipo_ci_madre=?, extension_ci_madre=?, profesion_madre=?, lugar_trabajo_madre=?,
          telefono_domicilio_madre=?, telefono_oficina_madre=?,
          nombre_autorizado1=?, telefono_autorizado1=?, nombre_autorizado2=?, telefono_autorizado2=?,
          seguro_medico=?, alergias=?, vacunas=?
        WHERE id=?`,
        updateData
      );

      // Verificar si existe inscripción
      const [existingInscription] = await pool.query(
        'SELECT id FROM inscripciones WHERE estudiante_id = ?',
        [estudianteId]
      );

      // Solo actualizar/crear inscripción si se proporcionan datos de inscripción
      if (nivel_id || curso_id || bloque_id || turno || fecha_inscripcion || codigo_estudiante) {
        if (existingInscription.length > 0) {
          // Actualizar inscripción existente
          await pool.query(
            `UPDATE inscripciones SET 
              codigo_estudiante=COALESCE(?, codigo_estudiante), 
              nivel_id=COALESCE(?, nivel_id), 
              curso_id=COALESCE(?, curso_id), 
              bloque_id=COALESCE(?, bloque_id), 
              turno=COALESCE(?, turno), 
              fecha_inscripcion=COALESCE(?, fecha_inscripcion), 
              id_beca=COALESCE(?, id_beca)
            WHERE estudiante_id=?`,
            [
              codigo_estudiante || null, nivel_id || null, curso_id || null, bloque_id || null,
              turno || null, fecha_inscripcion || null, id_beca || null, estudianteId
            ]
          );
        } else if (nivel_id && curso_id) {
          // Crear nueva inscripción solo si hay nivel y curso
          await pool.query(
            `INSERT INTO inscripciones (
              estudiante_id, codigo_estudiante, nivel_id, curso_id, bloque_id, 
              turno, fecha_inscripcion, id_beca, estado
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo')`,
            [
              estudianteId, codigo_estudiante || null, nivel_id, curso_id, bloque_id || null,
              turno || null, fecha_inscripcion || null, id_beca || null
            ]
          );
        }
      }

      res.json({
        ok: true,
        message: 'Estudiante actualizado exitosamente'
      });
    } catch (error) {
      console.error('Error al actualizar estudiante:', error);
      console.error('Stack:', error.stack);
      res.status(500).json({
        ok: false,
        message: 'Error al actualizar estudiante',
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Eliminar estudiante y TODOS sus datos relacionados
  app.delete('/api/estudiantes/:id', authMiddleware, async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      const estudianteId = req.params.id;

      // Verificar si el estudiante existe
      const [existingStudent] = await connection.query(
        'SELECT id, nombre, apellido_paterno FROM estudiantes WHERE id = ?',
        [estudianteId]
      );

      if (existingStudent.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          ok: false,
          message: 'Estudiante no encontrado'
        });
      }

      const estudianteNombre = `${existingStudent[0].nombre} ${existingStudent[0].apellido_paterno}`;

      // Deshabilitar verificación de foreign keys temporalmente para eliminación en cascada
      await connection.query('SET FOREIGN_KEY_CHECKS = 0');

      // Obtener IDs de compromisos económicos del estudiante
      const [compromisos] = await connection.query(
        'SELECT id FROM compromiso_economico WHERE id_estudiante = ?',
        [estudianteId]
      );
      const compromisoIds = compromisos.map(c => c.id);

      // 1. Eliminar pagos realizados relacionados (si hay compromisos)
      if (compromisoIds.length > 0) {
        const placeholders = compromisoIds.map(() => '?').join(',');
        await connection.query(
          `DELETE FROM pagos_realizados WHERE id_compromiso IN (${placeholders})`,
          compromisoIds
        );

        // 2. Eliminar pagos mensuales relacionados
        await connection.query(
          `DELETE FROM pagos_mensuales WHERE id_compromiso IN (${placeholders})`,
          compromisoIds
        );
      }

      // 3. Eliminar compromisos económicos
      await connection.query(
        'DELETE FROM compromiso_economico WHERE id_estudiante = ?',
        [estudianteId]
      );

      // 4. Eliminar servicios del estudiante
      await connection.query(
        'DELETE FROM servicios_estudiante WHERE estudiante_id = ?',
        [estudianteId]
      );

      // 5. Eliminar ingresos relacionados con este estudiante
      await connection.query(
        'DELETE FROM ingresos WHERE estudiante_id = ?',
        [estudianteId]
      );

      // 6. Eliminar inscripciones relacionadas
      await connection.query(
        'DELETE FROM inscripciones WHERE estudiante_id = ?',
        [estudianteId]
      );

      // 7. Eliminar contactos de aviso (WhatsApp)
      await connection.query(
        'DELETE FROM contacto_aviso WHERE estudiante_id = ?',
        [estudianteId]
      );

      // 8. Eliminar mensajes de conversación relacionados (si existen)
      // Nota: Esto puede no ser necesario dependiendo de tu esquema

      // 9. Finalmente, eliminar el estudiante (DELETE físico, no soft delete)
      await connection.query(
        'DELETE FROM estudiantes WHERE id = ?',
        [estudianteId]
      );

      // Rehabilitar verificación de foreign keys
      await connection.query('SET FOREIGN_KEY_CHECKS = 1');

      await connection.commit();

      res.json({
        ok: true,
        message: `Estudiante "${estudianteNombre}" y todos sus datos relacionados eliminados exitosamente`,
        eliminado: {
          estudiante: estudianteNombre,
          datos_eliminados: [
            'Estudiante',
            'Inscripciones',
            'Compromisos económicos',
            'Pagos mensuales',
            'Pagos realizados',
            'Servicios del estudiante',
            'Ingresos relacionados',
            'Contactos de aviso'
          ]
        }
      });
    } catch (error) {
      await connection.rollback();
      // Asegurar que foreign keys estén habilitadas incluso si hay error
      try {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
      } catch (e) {}
      
      console.error('Error al eliminar estudiante:', error);
      res.status(500).json({
        ok: false,
        message: 'Error al eliminar estudiante',
        error: error.message
      });
    } finally {
      connection.release();
    }
  });

  // Obtener estado de contactos WhatsApp de un estudiante
  app.get('/api/contacto-aviso/:estudiante_id', authMiddleware, async (req, res) => {
    try {
      const { estudiante_id } = req.params;
      const [rows] = await pool.query(
        'SELECT tipo_contacto, activo FROM contacto_aviso WHERE estudiante_id = ?',
        [estudiante_id]
      );

      const estados = {
        whatsapp_domicilio_padre: false,
        whatsapp_oficina_padre: false,
        whatsapp_domicilio_madre: false,
        whatsapp_oficina_madre: false
      };

      rows.forEach(row => {
        if (row.tipo_contacto === 'padre') estados.whatsapp_domicilio_padre = Boolean(row.activo);
        if (row.tipo_contacto === 'padre_oficina') estados.whatsapp_oficina_padre = Boolean(row.activo);
        if (row.tipo_contacto === 'madre') estados.whatsapp_domicilio_madre = Boolean(row.activo);
        if (row.tipo_contacto === 'madre_oficina') estados.whatsapp_oficina_madre = Boolean(row.activo);
      });

      res.json({ ok: true, estados });
    } catch (error) {
      console.error('Error al obtener estado contacto_aviso:', error);
      res.status(500).json({ ok: false, message: 'Error interno' });
    }
  });

  // Migración masiva: Poblar contacto_aviso para estudiantes existentes
  app.post('/api/contacto-aviso/migrar', authMiddleware, async (req, res) => {
    try {
      // Obtener todos los estudiantes activos que no tienen registros en contacto_aviso
      const [estudiantes] = await pool.query(`
        SELECT id, nombre_padre, apellido_padre, telefono_domicilio_padre, 
               nombre_madre, apellido_madre, telefono_domicilio_madre
        FROM estudiantes
        WHERE estado_id = 1
          AND id NOT IN (SELECT DISTINCT estudiante_id FROM contacto_aviso)
      `);

      console.log(`🚀 Iniciando migración de ${estudiantes.length} estudiantes a contacto_aviso...`);

      let migrados = 0;
      for (const e of estudiantes) {
        // Por defecto, si tiene teléfono de padre, lo marcamos como WhatsApp activo para migración
        await guardarContactosWhatsApp(
          e.id,
          {
            telefono_domicilio_padre: e.telefono_domicilio_padre,
            telefono_domicilio_madre: e.telefono_domicilio_madre,
            whatsapp_domicilio_padre: !!e.telefono_domicilio_padre,
            whatsapp_domicilio_madre: false // Solo padre por defecto en migración masiva para evitar spam
          },
          {
            nombre_padre: e.nombre_padre,
            apellido_padre: e.apellido_padre,
            nombre_madre: e.nombre_madre,
            apellido_madre: e.apellido_madre
          }
        );
        migrados++;
      }

      res.json({
        ok: true,
        message: `Migración completada. Se crearon registros para ${migrados} estudiantes.`,
        migrados
      });
    } catch (error) {
      console.error('❌ Error en migración de contacto_aviso:', error);
      res.status(500).json({ ok: false, message: 'Error en migración', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA GESTIÓN DE INSCRIPCIONES =====

  // Listar todas las inscripciones
  app.get('/api/inscripciones/estado-actual/:estudiante_id', authMiddleware, async (req, res) => {
    try {
      const { estudiante_id } = req.params;
      const anio = parseInt(req.query.anio, 10) || new Date().getFullYear();

      if (!estudiante_id) {
        return res.status(400).json({
          ok: false,
          message: 'El ID del estudiante es requerido'
        });
      }

      const [rows] = await pool.query(
        `SELECT 
           i.id,
           i.fecha_inscripcion,
           i.gestion_academica,
           i.estado,
           n.nombre AS nivel_nombre,
           c.nombre AS curso_nombre,
           b.descripcion AS bloque_nombre,
           e.nombre,
           e.apellido_paterno,
           e.apellido_materno
         FROM inscripciones i
         LEFT JOIN nivel n ON i.nivel_id = n.id
         LEFT JOIN curso c ON i.curso_id = c.id
         LEFT JOIN bloque b ON i.bloque_id = b.id
         LEFT JOIN estudiantes e ON i.estudiante_id = e.id
         WHERE i.estudiante_id = ?
           AND i.estado IN ('activo','concluido','retirado')
           AND (
             (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
             OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
           )
         ORDER BY i.fecha_inscripcion DESC
         LIMIT 1`,
        [estudiante_id, anio, anio]
      );

      if (rows.length > 0) {
        return res.json({
          ok: true,
          tiene_inscripcion: true,
          inscripcion: rows[0]
        });
      }

      return res.json({
        ok: true,
        tiene_inscripcion: false
      });
    } catch (error) {
      console.error('Error al verificar inscripción actual:', error);
      return res.status(500).json({
        ok: false,
        message: 'Error al verificar la inscripción actual',
        error: error.message
      });
    }
  });

  app.get('/api/inscripciones', authMiddleware, async (req, res) => {
    try {
      const { nivel_id, curso_id, bloque_id, estado } = req.query;

      let query = `
        SELECT i.*, e.nombre, e.apellido_paterno, e.apellido_materno,
               n.nombre as nivel_nombre, c.nombre as curso_nombre, 
               b.descripcion as bloque_nombre, bc.descripcion as beca_descripcion,
               u.nombre_completo as usuario_registro_nombre
        FROM inscripciones i
        JOIN estudiantes e ON i.estudiante_id = e.id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN becas bc ON i.id_beca = bc.id
        LEFT JOIN usuarios u ON i.usuario_registro = u.id
        WHERE e.estado_id = 1
      `;

      const params = [];

      if (nivel_id) {
        query += ' AND i.nivel_id = ?';
        params.push(nivel_id);
      }

      if (curso_id) {
        query += ' AND i.curso_id = ?';
        params.push(curso_id);
      }

      if (bloque_id) {
        query += ' AND i.bloque_id = ?';
        params.push(bloque_id);
      }

      if (estado) {
        query += ' AND i.estado = ?';
        params.push(estado);
      }

      query += ' ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre';

      const [rows] = await pool.query(query, params);
      res.json(rows);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener inscripciones',
        error: error.message
      });
    }
  });

  // Crear nueva inscripción
  app.post('/api/inscripciones', authMiddleware, async (req, res) => {
    try {
      console.log('Datos recibidos para inscripción:', req.body);

      const {
        estudiante_id,
        codigo_estudiante,
        nivel_id,
        curso_id,
        bloque_id,
        turno,
        fecha_inscripcion,
        id_beca,
        meses_beca,
        estado = 'activo',
        gestion_academica = new Date().getFullYear()
      } = req.body;

      // Validar campos requeridos
      if (!estudiante_id) {
        return res.status(400).json({
          ok: false,
          message: 'El ID del estudiante es requerido'
        });
      }

      // Verificar si el estudiante existe
      const [existingStudent] = await pool.query(
        'SELECT id FROM estudiantes WHERE id = ? AND estado_id = 1',
        [estudiante_id]
      );

      if (existingStudent.length === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Estudiante no encontrado'
        });
      }

      // Regla de negocio: un estudiante SOLO puede tener 1 inscripción por gestión (año académico)
      // Usamos gestion_academica si viene; si no, caemos al año de fecha_inscripcion o al año actual.
      const anioObjetivo = (() => {
        const g = parseInt(gestion_academica, 10);
        if (!Number.isNaN(g) && g > 2000) return g;
        if (fecha_inscripcion) {
          const f = new Date(fecha_inscripcion);
          const y = f.getFullYear();
          if (!Number.isNaN(y) && y > 2000) return y;
        }
        return new Date().getFullYear();
      })();

      const [existingInscription] = await pool.query(
        `SELECT i.id, i.fecha_inscripcion, i.gestion_academica, 
                n.nombre as nivel_nombre, c.nombre as curso_nombre,
                e.nombre, e.apellido_paterno, e.apellido_materno
         FROM inscripciones i
         LEFT JOIN nivel n ON i.nivel_id = n.id
         LEFT JOIN curso c ON i.curso_id = c.id
         LEFT JOIN estudiantes e ON i.estudiante_id = e.id
         WHERE i.estudiante_id = ? 
           AND i.estado IN ("activo","concluido","retirado")
           AND (
             (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
             OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
           )
         ORDER BY i.fecha_inscripcion DESC
         LIMIT 1`,
        [estudiante_id, anioObjetivo, anioObjetivo]
      );

      if (existingInscription.length > 0) {
        const inscripcion = existingInscription[0];
        const nombreCompleto = `${inscripcion.nombre} ${inscripcion.apellido_paterno} ${inscripcion.apellido_materno || ''}`.trim();
        return res.status(400).json({
          ok: false,
          message: `El estudiante ${nombreCompleto} ya cuenta con una inscripción para la gestión ${anioObjetivo}. 
                    Inscripción registrada el ${new Date(inscripcion.fecha_inscripcion).toLocaleDateString('es-ES')} 
                    ${inscripcion.nivel_nombre ? `en ${inscripcion.nivel_nombre}` : ''} 
                    ${inscripcion.curso_nombre ? `- ${inscripcion.curso_nombre}` : ''}. 
                    No se puede registrar otra inscripción en la misma gestión.`,
          inscripcion_existente: {
            id: inscripcion.id,
            fecha: inscripcion.fecha_inscripcion,
            nivel: inscripcion.nivel_nombre,
            curso: inscripcion.curso_nombre
          }
        });
      }

      // Marcar inscripciones anteriores como concluidas
      await pool.query(
        'UPDATE inscripciones SET estado = "concluido" WHERE estudiante_id = ? AND estado = "activo" AND gestion_academica < ?',
        [estudiante_id, gestion_academica]
      );

      console.log('Valores para insertar:', [
        estudiante_id, codigo_estudiante, nivel_id, curso_id, bloque_id,
        turno, fecha_inscripcion, id_beca, meses_beca, estado, gestion_academica
      ]);

      const [result] = await pool.query(
        `INSERT INTO inscripciones (
          estudiante_id, codigo_estudiante, nivel_id, curso_id, bloque_id,
          turno, fecha_inscripcion, id_beca, meses_beca, estado, gestion_academica
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          estudiante_id, codigo_estudiante || null, nivel_id, curso_id, bloque_id,
          turno, fecha_inscripcion, id_beca, meses_beca, estado, gestion_academica
        ]
      );

      console.log('Inscripción creada con ID:', result.insertId);

      // ===== CREAR COMPROMISO ECONÓMICO AUTOMÁTICAMENTE =====
      try {
        // Obtener el precio y los meses del nivel para calcular los montos
        const [nivelInfo] = await pool.query(
          'SELECT precio, meses FROM nivel WHERE id = ?',
          [nivel_id]
        );

        if (nivelInfo.length > 0) {
          const precioNivel = parseFloat(nivelInfo[0].precio);
          const mesesNivel = JSON.parse(nivelInfo[0].meses || '[]');
          const cuotas = mesesNivel.length; // Número de cuotas según los meses del nivel
          const total_cuotas = precioNivel;
          const total_general = total_cuotas;

          // Calcular descuento si hay beca
          let descuento_aplicado = 0;
          let porcentaje_beca_real = 0;
          if (id_beca && id_beca !== null && id_beca !== '') { // Si hay beca válida
            // Obtener el descuento real de la tabla becas
            const [becaInfo] = await pool.query(
              'SELECT descuento FROM becas WHERE id = ?',
              [id_beca]
            );
            if (becaInfo.length > 0) {
              porcentaje_beca_real = parseFloat(becaInfo[0].descuento);
              descuento_aplicado = porcentaje_beca_real / 100; // Convertir porcentaje a decimal
            }
          }

          // Crear el compromiso económico
          const [compromisoResult] = await pool.query(
            `INSERT INTO compromiso_economico (
              id_estudiante, inscripcion_id, id_beca, meses_beca, 
              total_cuotas, total_general, cuotas, 
              descuento_aplicado, observacion, estado_compromiso, fecha_cambio_estado
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', CURDATE())`,
            [
              estudiante_id, result.insertId, id_beca, meses_beca,
              total_cuotas, total_general, cuotas,
              descuento_aplicado, 'Compromiso creado automáticamente con la inscripción'
            ]
          );

          const compromisoId = compromisoResult.insertId;
          console.log('Compromiso económico creado automáticamente para inscripción:', result.insertId, 'con ID:', compromisoId);

          // ===== GENERAR PAGOS MENSUALES AUTOMÁTICAMENTE =====
          try {
            const numeroCuotas = cuotas || 10;
            const costoMensualOriginal = precioNivel / numeroCuotas;
            const anioActual = new Date().getFullYear();

            // Obtener información de la beca
            let becaInfo = {
              descuento: 0,
              meses_beca: [],
              porcentaje_descuento: 0
            };

            if (id_beca && meses_beca) {
              becaInfo.porcentaje_descuento = porcentaje_beca_real; // Usar el porcentaje real obtenido de la tabla becas

              // Procesar los meses de beca (viene como string: "febrero,marzo,abril")
              const mesesBecaArray = meses_beca.split(',').map(mes => mes.trim().toLowerCase());
              becaInfo.meses_beca = mesesBecaArray;

              console.log(`📊 Beca configurada: ${becaInfo.porcentaje_descuento}% en meses: ${mesesBecaArray.join(', ')}`);
            }

            // Función para convertir nombre de mes a número
            const obtenerNumeroMes = (nombreMes) => {
              const meses = {
                'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
                'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
                'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
              };
              return meses[nombreMes.toLowerCase()] || 0;
            };

            // Meses del año escolar según el nivel específico
            console.log(`📅 Meses del nivel ${nivel_id}:`, mesesNivel);
            const mesesEscolares = mesesNivel.map(nombreMes => ({
              nombre: nombreMes.toLowerCase(),
              numero: obtenerNumeroMes(nombreMes)
            })).filter(mes => mes.numero > 0); // Filtrar meses válidos

            console.log(`📅 Meses procesados para pagos:`, mesesEscolares.map(m => `${m.nombre}(${m.numero})`).join(', '));

            // Función para verificar si un mes tiene beca
            const mesConBeca = (nombreMes) => {
              return becaInfo.meses_beca.includes(nombreMes.toLowerCase());
            };

            // Generar los pagos mensuales
            const pagosMensuales = [];

            for (let i = 0; i < mesesEscolares.length; i++) {
              const mesInfo = mesesEscolares[i];
              const nombreMes = mesInfo.nombre;
              const numeroMes = mesInfo.numero;

              // Determinar si este mes tiene beca
              const tieneBeca = mesConBeca(nombreMes);

              // Calcular montos usando el costo original del nivel
              const montoBase = costoMensualOriginal;
              const porcentajeBeca = tieneBeca ? becaInfo.porcentaje_descuento : 0;
              const montoDescuento = tieneBeca ? (montoBase * porcentajeBeca / 100) : 0;
              const montoEsperado = montoBase - montoDescuento;

              // Calcular fecha de vencimiento (día 15 de cada mes)
              const fechaVencimiento = new Date(anioActual, numeroMes - 1, 15); // numeroMes-1 porque Date usa 0-11
              const fechaVencimientoStr = fechaVencimiento.toISOString().split('T')[0];

              pagosMensuales.push([
                parseInt(compromisoId),
                parseInt(numeroMes),
                parseInt(anioActual),
                nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1), // Capitalizar primera letra
                tieneBeca ? 1 : 0,
                tieneBeca ? parseFloat(porcentajeBeca) : null,
                parseFloat(montoBase.toFixed(2)),
                parseFloat(montoDescuento.toFixed(2)),
                parseFloat(montoEsperado.toFixed(2)),
                0.00, // monto_pagado inicial
                parseFloat(montoEsperado.toFixed(2)), // monto_pendiente inicial (igual al esperado)
                fechaVencimientoStr,
                'pendiente'
              ]);

              console.log(`📅 ${nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1)} ${anioActual}: Mes=${numeroMes}, Base=${montoBase.toFixed(2)}, Beca=${tieneBeca ? 'Sí' : 'No'}, Descuento=${montoDescuento.toFixed(2)}, Esperado=${montoEsperado.toFixed(2)}`);
            }



            // Insertar todos los pagos mensuales
            if (pagosMensuales.length > 0) {
              console.log('🔍 Datos a insertar en pagos_mensuales:', JSON.stringify(pagosMensuales, null, 2));

              await pool.query(
                `INSERT INTO pagos_mensuales (
                  id_compromiso, mes, anio, nombre_mes, tiene_beca, porcentaje_beca, 
                  monto_base, monto_descuento, monto_esperado, monto_pagado, monto_pendiente,
                  fecha_vencimiento, estado
                ) VALUES ?`,
                [pagosMensuales]
              );

              console.log(`✅ Se generaron ${pagosMensuales.length} pagos mensuales para el compromiso ${compromisoId}`);
              console.log(`📊 Desglose: ${pagosMensuales.length} cuotas mensuales`);
              console.log(`📊 Beca aplicada: ${becaInfo.porcentaje_descuento}% en ${becaInfo.meses_beca.length} meses específicos`);
            }

            // ===== ENVIAR PDF DE PLAN DE CUOTAS POR WHATSAPP AUTOMÁTICAMENTE =====
            // Se ejecuta después de crear los pagos mensuales para tener toda la información
            try {
              const PlanCuotasPDFService = require('./planCuotasPDFService');
              const planCuotasService = new PlanCuotasPDFService();

              // Enviar PDF en segundo plano (no bloquear la respuesta)
              planCuotasService.generarYEnviarPlanCuotas(
                estudiante_id,
                result.insertId,
                gestion_academica
              ).then(resultado => {
                if (resultado.success) {
                  console.log('✅ PDF de plan de cuotas enviado exitosamente por WhatsApp');
                } else {
                  console.log('⚠️ No se pudo enviar PDF por WhatsApp:', resultado.mensaje);
                }
              }).catch(error => {
                console.error('❌ Error al enviar PDF por WhatsApp:', error.message);
              });
            } catch (error) {
              console.error('⚠️ Error al inicializar servicio de envío de PDF:', error.message);
              // No fallar la inscripción si hay error en el envío de PDF
            }
            // ===== FIN ENVÍO PDF =====

          } catch (pagoError) {
            console.error('❌ ERROR CRÍTICO al generar pagos mensuales:', pagoError);
            console.error('❌ Stack trace:', pagoError.stack);
            // No fallar la inscripción si hay error en los pagos
          }
          // ===== FIN GENERACIÓN PAGOS MENSUALES =====
        }
      } catch (compromisoError) {
        console.error('Error al crear compromiso económico automático:', compromisoError);
        // No fallar la inscripción si hay error en el compromiso
      }

      res.json({
        ok: true,
        id: result.insertId,
        message: 'Inscripción y compromiso económico creados exitosamente'
      });
    } catch (error) {
      console.error('Error completo al crear inscripción:', error);
      console.error('Error code:', error.code);
      console.error('Error errno:', error.errno);
      console.error('Error sqlState:', error.sqlState);
      console.error('Error sqlMessage:', error.sqlMessage);

      res.status(500).json({
        ok: false,
        message: 'Error al crear inscripción',
        error: error.message
      });
    }
  });

  // Marcar inscripción/compromiso como "retirado" (baja lógica / abandono)
  app.post('/api/inscripciones/retirar', authMiddleware, async (req, res) => {
    try {
      // Solo roles con gestión
      if (!req.user || !['Administrador', 'Director', 'Secretaria'].includes(req.user.rol)) {
        return res.status(403).json({ ok: false, message: 'No tiene permisos para realizar esta acción' });
      }

      const { estudiante_id, gestion_academica, estado_id, motivo } = req.body || {};
      const estudianteId = parseInt(estudiante_id, 10);
      const gestion = parseInt(gestion_academica, 10) || null;
      const estadoIdSolicitado = parseInt(estado_id, 10) || null;

      if (!estudianteId) {
        return res.status(400).json({ ok: false, message: 'estudiante_id es requerido' });
      }

      // Resolver estado objetivo para el estudiante (por defecto: Retirado)
      let estadoObjetivoId = estadoIdSolicitado;
      if (!estadoObjetivoId) {
        const [estadoRetirado] = await pool.query(
          "SELECT id FROM estados_estudiante WHERE LOWER(nombre) = 'retirado' LIMIT 1"
        );
        estadoObjetivoId = estadoRetirado?.[0]?.id || 4;
      }

      const [estadoExiste] = await pool.query(
        'SELECT id, nombre FROM estados_estudiante WHERE id = ? LIMIT 1',
        [estadoObjetivoId]
      );
      if (estadoExiste.length === 0) {
        return res.status(400).json({ ok: false, message: 'estado_id inválido' });
      }

      // Buscar inscripción por gestión si llega; si no, usar la más reciente.
      let insRows;
      if (gestion) {
        const [rows] = await pool.query(
          `SELECT i.id, i.estado, i.fecha_inscripcion, i.gestion_academica,
                  ce.id AS compromiso_id, ce.estado_compromiso
           FROM inscripciones i
           LEFT JOIN compromiso_economico ce ON ce.inscripcion_id = i.id
           WHERE i.estudiante_id = ?
             AND i.estado IN ('activo','concluido','retirado')
             AND (
               (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
               OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
             )
           ORDER BY i.fecha_inscripcion DESC
           LIMIT 1`,
          [estudianteId, gestion, gestion]
        );
        insRows = rows;
      } else {
        const [rows] = await pool.query(
          `SELECT i.id, i.estado, i.fecha_inscripcion, i.gestion_academica,
                  ce.id AS compromiso_id, ce.estado_compromiso
           FROM inscripciones i
           LEFT JOIN compromiso_economico ce ON ce.inscripcion_id = i.id
           WHERE i.estudiante_id = ?
             AND i.estado IN ('activo','concluido','retirado')
           ORDER BY COALESCE(i.gestion_academica, YEAR(i.fecha_inscripcion)) DESC, i.fecha_inscripcion DESC
           LIMIT 1`,
          [estudianteId]
        );
        insRows = rows;
      }

      if (insRows.length === 0) {
        // Aunque no exista inscripción para esa gestión, actualizar estado del estudiante
        await pool.query(`UPDATE estudiantes SET estado_id = ? WHERE id = ?`, [estadoObjetivoId, estudianteId]);
        return res.json({
          ok: true,
          message: gestion
            ? `Estudiante actualizado a estado "${estadoExiste[0].nombre}". No se encontró inscripción para la gestión ${gestion}, por lo que solo se actualizó el estado del estudiante.`
            : `Estudiante actualizado a estado "${estadoExiste[0].nombre}". No se encontró inscripción para actualizar compromiso/inscripción.`,
          inscripcion_id: null,
          compromiso_id: null,
          estado_id: estadoObjetivoId
        });
      }

      const ins = insRows[0];

      // Si ya está retirado, devolver ok
      if (ins.estado === 'retirado' && (!ins.estado_compromiso || ins.estado_compromiso === 'retirado')) {
        return res.json({ ok: true, message: 'El estudiante ya estaba marcado como retirado en esa gestión' });
      }

      // Actualizar inscripción
      await pool.query(`UPDATE inscripciones SET estado = 'retirado' WHERE id = ?`, [ins.id]);

      // Actualizar estado del estudiante
      await pool.query(`UPDATE estudiantes SET estado_id = ? WHERE id = ?`, [estadoObjetivoId, estudianteId]);

      // Actualizar compromiso económico asociado (si existe)
      if (ins.compromiso_id) {
        await pool.query(
          `UPDATE compromiso_economico
           SET estado_compromiso = 'retirado',
               fecha_cambio_estado = CURDATE(),
               observacion_estado = ?
           WHERE id = ?`,
          [motivo ? String(motivo).trim().slice(0, 500) : 'Retirado (baja lógica)', ins.compromiso_id]
        );
      }

      return res.json({
        ok: true,
        message: gestion
          ? `Estudiante actualizado a estado "${estadoExiste[0].nombre}" y marcado como retirado para la gestión ${gestion}`
          : `Estudiante actualizado a estado "${estadoExiste[0].nombre}" y marcado como retirado en su inscripción más reciente`,
        inscripcion_id: ins.id,
        compromiso_id: ins.compromiso_id || null,
        estado_id: estadoObjetivoId
      });
    } catch (error) {
      console.error('Error al marcar retirado:', error);
      return res.status(500).json({ ok: false, message: 'Error al marcar como retirado', error: error.message });
    }
  });

  // Obtener inscripción por ID
  app.get('/api/inscripciones/:id', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT i.*, e.nombre, e.apellido_paterno, e.apellido_materno,
               n.nombre as nivel_nombre, c.nombre as curso_nombre, 
               b.descripcion as bloque_nombre, bc.descripcion as beca_descripcion,
               i.meses_beca
        FROM inscripciones i
        JOIN estudiantes e ON i.estudiante_id = e.id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN becas bc ON i.id_beca = bc.id
        WHERE i.id = ? AND e.estado_id = 1
      `, [req.params.id]);

      if (rows.length === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Inscripción no encontrada'
        });
      }

      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener inscripción',
        error: error.message
      });
    }
  });

  // Actualizar inscripción
  app.put('/api/inscripciones/:id', authMiddleware, async (req, res) => {
    try {
      const {
        codigo_estudiante,
        nivel_id,
        curso_id,
        bloque_id,
        turno,
        fecha_inscripcion,
        id_beca,
        meses_beca,
        estado
      } = req.body;

      // Verificar si la inscripción existe
      const [existingInscription] = await pool.query(
        'SELECT id FROM inscripciones WHERE id = ?',
        [req.params.id]
      );

      if (existingInscription.length === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Inscripción no encontrada'
        });
      }

      await pool.query(
        `UPDATE inscripciones SET 
          codigo_estudiante=?, nivel_id=?, curso_id=?, bloque_id=?,
          turno=?, fecha_inscripcion=?, id_beca=?, meses_beca=?, estado=?
        WHERE id=?`,
        [
          codigo_estudiante, nivel_id, curso_id, bloque_id,
          turno, fecha_inscripcion, id_beca, meses_beca, estado,
          req.params.id
        ]
      );

      res.json({
        ok: true,
        message: 'Inscripción actualizada exitosamente'
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al actualizar inscripción',
        error: error.message
      });
    }
  });

  // Eliminar inscripción
  app.delete('/api/inscripciones/:id', authMiddleware, async (req, res) => {
    try {
      // Verificar si la inscripción existe
      const [existingInscription] = await pool.query(
        'SELECT estudiante_id FROM inscripciones WHERE id = ?',
        [req.params.id]
      );

      if (existingInscription.length === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Inscripción no encontrada'
        });
      }

      // Verificar si hay compromisos económicos asociados
      const [commitments] = await pool.query(
        'SELECT COUNT(*) as count FROM compromiso_economico WHERE inscripcion_id = ?',
        [req.params.id]
      );

      if (commitments[0].count > 0) {
        return res.status(400).json({
          ok: false,
          message: 'No se puede eliminar la inscripción porque tiene compromisos económicos asociados'
        });
      }

      await pool.query('DELETE FROM inscripciones WHERE id = ?', [req.params.id]);

      res.json({
        ok: true,
        message: 'Inscripción eliminada exitosamente'
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al eliminar inscripción',
        error: error.message
      });
    }
  });

  // Eliminar todas las inscripciones del año 2026 en adelante (con sus compromisos y pagos mensuales)
  app.delete('/api/inscripciones/eliminar-por-anio/:anio', authMiddleware, async (req, res) => {
    try {
      const anio = parseInt(req.params.anio, 10);

      // Validar que el año sea 2026
      if (anio !== 2026) {
        return res.status(400).json({
          ok: false,
          message: 'Solo se pueden eliminar inscripciones del año 2026 en adelante'
        });
      }

      // Verificar que el usuario tenga permisos (solo Admin o Director)
      const user = req.user;
      if (user.rol !== 'Administrador' && user.rol !== 'Director') {
        return res.status(403).json({
          ok: false,
          message: 'No tiene permisos para realizar esta acción'
        });
      }

      // Obtener todas las inscripciones del año 2026 en adelante
      const [inscripciones] = await pool.query(`
        SELECT id 
        FROM inscripciones 
        WHERE (
          (gestion_academica IS NOT NULL AND gestion_academica >= ?)
          OR (gestion_academica IS NULL AND YEAR(fecha_inscripcion) >= ?)
        )
      `, [anio, anio]);

      if (inscripciones.length === 0) {
        return res.json({
          ok: true,
          message: 'No se encontraron inscripciones del año 2026 en adelante para eliminar',
          eliminadas: 0
        });
      }

      const inscripcionIds = inscripciones.map(i => i.id);

      // Obtener todos los compromisos económicos asociados a estas inscripciones
      const placeholdersInscripciones = inscripcionIds.map(() => '?').join(',');
      const [compromisos] = await pool.query(`
        SELECT id 
        FROM compromiso_economico 
        WHERE inscripcion_id IN (${placeholdersInscripciones})
      `, inscripcionIds);

      const compromisoIds = compromisos.map(c => c.id);

      // Iniciar transacción
      await pool.query('START TRANSACTION');

      try {
        // 1. Eliminar pagos mensuales asociados a los compromisos
        if (compromisoIds.length > 0) {
          const placeholdersCompromisos = compromisoIds.map(() => '?').join(',');
          await pool.query(`
            DELETE FROM pagos_mensuales 
            WHERE id_compromiso IN (${placeholdersCompromisos})
          `, compromisoIds);
        }

        // 2. Eliminar pagos realizados asociados a los compromisos
        if (compromisoIds.length > 0) {
          const placeholdersCompromisos = compromisoIds.map(() => '?').join(',');
          await pool.query(`
            DELETE FROM pagos_realizados 
            WHERE id_compromiso IN (${placeholdersCompromisos})
          `, compromisoIds);
        }

        // 3. Eliminar compromisos económicos
        if (compromisoIds.length > 0) {
          const placeholdersCompromisos = compromisoIds.map(() => '?').join(',');
          await pool.query(`
            DELETE FROM compromiso_economico 
            WHERE id IN (${placeholdersCompromisos})
          `, compromisoIds);
        }

        // 4. Eliminar inscripciones
        const placeholdersInscripcionesFinal = inscripcionIds.map(() => '?').join(',');
        await pool.query(`
          DELETE FROM inscripciones 
          WHERE id IN (${placeholdersInscripcionesFinal})
        `, inscripcionIds);

        // Confirmar transacción
        await pool.query('COMMIT');

        res.json({
          ok: true,
          message: `Se eliminaron ${inscripciones.length} inscripción(es) del año ${anio} en adelante junto con sus compromisos y pagos`,
          eliminadas: inscripciones.length,
          compromisos_eliminados: compromisos.length
        });

      } catch (error) {
        // Revertir transacción en caso de error
        await pool.query('ROLLBACK');
        throw error;
      }

    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al eliminar inscripciones',
        error: error.message
      });
    }
  });

  // ===== SERVICIOS ADQUIRIDOS POR ESTUDIANTE =====
  // NOTA: Estas rutas han sido movidas a backend-cajas
  // Las rutas de servicios-estudiante ahora están en backend-cajas/microservices/academia/estudiantesCajas.js
  // Las siguientes rutas fueron eliminadas del backend principal:
  // - POST /api/servicios-estudiante
  // - GET /api/servicios-estudiante/:estudiante_id
  // - POST /api/servicios-estudiante/:id/pagar
  // - PUT /api/servicios-estudiante/:id/anular

  // Obtener todas las inscripciones de un estudiante
  app.get('/api/estudiantes/:id/inscripciones', async (req, res) => {
    try {
      const estudianteId = req.params.id;

      // Primero, verificar y actualizar compromisos que deberían estar concluidos
      const [compromisosActivos] = await pool.query(`
        SELECT ce.id
        FROM compromiso_economico ce
        INNER JOIN inscripciones i ON ce.inscripcion_id = i.id
        WHERE i.estudiante_id = ? AND ce.estado_compromiso = 'activo'
      `, [estudianteId]);

      // Actualizar compromisos completamente pagados (verificando tanto por total como por pagos mensuales)
      for (const comp of compromisosActivos) {
        try {
          // Verificar por total pagado vs total general
          const [compromisoCheck] = await pool.query(`
            SELECT ce.id, ce.total_general, ce.estado_compromiso,
                   COALESCE(SUM(pr.monto), 0) as total_pagado,
                   (ce.total_general - COALESCE(SUM(pr.monto), 0)) as saldo_pendiente
            FROM compromiso_economico ce
            LEFT JOIN pagos_realizados pr ON ce.id = pr.id_compromiso
            WHERE ce.id = ?
            GROUP BY ce.id
          `, [comp.id]);

          if (compromisoCheck.length === 0) continue;

          const compData = compromisoCheck[0];

          // Verificar también por pagos mensuales - si todos están pagados, el compromiso está concluido
          const [pagosMensuales] = await pool.query(`
            SELECT COUNT(*) as total_meses,
                   SUM(CASE WHEN estado = 'pagado' THEN 1 ELSE 0 END) as meses_pagados,
                   SUM(CASE WHEN estado IN ('pendiente', 'parcial') THEN 1 ELSE 0 END) as meses_pendientes
            FROM pagos_mensuales
            WHERE id_compromiso = ?
          `, [comp.id]);

          const todosMesesPagados = pagosMensuales.length > 0 &&
            pagosMensuales[0].total_meses > 0 &&
            pagosMensuales[0].meses_pendientes === 0;

          // Si está completamente pagado (por total o por pagos mensuales) y aún está activo, marcarlo como concluido
          if (compData.estado_compromiso === 'activo' &&
            (compData.saldo_pendiente <= 0.01 || todosMesesPagados)) {
            await pool.query(`
              UPDATE compromiso_economico 
              SET estado_compromiso = 'concluido',
                  fecha_cambio_estado = CURDATE(),
                  fecha_conclusion = CURDATE(),
                  observacion_estado = 'Concluido automáticamente al completar pagos'
              WHERE id = ?
            `, [comp.id]);
            console.log(`✅ Compromiso ${comp.id} actualizado a concluido automáticamente`);
          }
        } catch (error) {
          console.error(`Error al verificar compromiso ${comp.id}:`, error);
        }
      }

      // Ahora obtener las inscripciones con el estado actualizado
      const [rows] = await pool.query(`
        SELECT i.*, n.nombre AS nivel_nombre, c.nombre AS curso_nombre, 
               b.descripcion AS bloque_nombre, i.meses_beca,
               CASE WHEN ce.id IS NOT NULL THEN 1 ELSE 0 END as tiene_compromiso,
               ce.estado_compromiso
        FROM inscripciones i
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN compromiso_economico ce ON i.id = ce.inscripcion_id
        WHERE i.estudiante_id = ?
        ORDER BY i.fecha_inscripcion DESC
      `, [estudianteId]);

      res.json(rows);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener inscripciones', error: error.message });
    }
  });

  // Obtener historial de inscripciones del año pasado para sugerencias del agente
  app.get('/api/estudiantes/:id/historial-anterior', authMiddleware, async (req, res) => {
    try {
      const estudianteId = req.params.id;
      const anioAnterior = new Date().getFullYear() - 1;

      const [inscripciones] = await pool.query(`
        SELECT 
          i.id,
          i.gestion_academica,
          i.turno,
          i.fecha_inscripcion,
          i.id_beca,
          i.meses_beca,
          n.id as nivel_id,
          n.nombre AS nivel_nombre,
          c.id as curso_id,
          c.nombre AS curso_nombre,
          b.id as bloque_id,
          b.descripcion AS bloque_nombre,
          bc.descripcion AS beca_descripcion,
          bc.descuento AS beca_descuento,
          i.estado
        FROM inscripciones i
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN becas bc ON i.id_beca = bc.id
        WHERE i.estudiante_id = ?
          AND (
            (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
            OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
          )
        ORDER BY i.fecha_inscripcion DESC
        LIMIT 1
      `, [estudianteId, anioAnterior, anioAnterior]);

      res.json({
        ok: true,
        tiene_historial: inscripciones.length > 0,
        inscripcion: inscripciones.length > 0 ? inscripciones[0] : null
      });
    } catch (error) {
      console.error('Error al obtener historial anterior:', error);
      res.status(500).json({
        ok: false,
        message: 'Error al obtener historial anterior',
        error: error.message
      });
    }
  });

  // NOTA: Los endpoints de Compromiso Económico, Ingresos Académicos y Reportes 
  // han sido movidos a backend/microservices/pagos/

  // Auto-migración al inicio del servidor (si la tabla está vacía o faltan estudiantes)
  setTimeout(async () => {
    try {
      const [count] = await pool.query('SELECT COUNT(*) as total FROM contacto_aviso');
      if (count[0].total === 0) {
        console.log('📦 Tabla contacto_aviso vacía. Iniciando auto-poblado inicial...');
        const [estudiantes] = await pool.query(`
          SELECT id, nombre_padre, apellido_padre, telefono_domicilio_padre, 
                 nombre_madre, apellido_madre, telefono_domicilio_madre
          FROM estudiantes
          WHERE estado_id = 1
        `);

        for (const e of estudiantes) {
          await guardarContactosWhatsApp(
            e.id,
            {
              telefono_domicilio_padre: e.telefono_domicilio_padre,
              telefono_oficina_padre: null,
              telefono_domicilio_madre: e.telefono_domicilio_madre,
              telefono_oficina_madre: null,
              whatsapp_domicilio_padre: !!e.telefono_domicilio_padre,
              whatsapp_oficina_padre: false,
              whatsapp_domicilio_madre: false,
              whatsapp_oficina_madre: false
            },
            {
              nombre_padre: e.nombre_padre,
              apellido_padre: e.apellido_padre,
              nombre_madre: e.nombre_madre,
              apellido_madre: e.apellido_madre
            }
          );
        }
        console.log(`✅ Auto-poblado completado: ${estudiantes.length} estudiantes procesados.`);
      }
    } catch (err) {
      console.error('❌ Error en auto-poblado de contacto_aviso:', err);
    }
  }, 5000);

}

module.exports = { configurarRutasEstudiantes };
