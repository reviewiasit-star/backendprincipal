// Función para configurar las rutas de estudiantes necesarias para cajas
function configurarRutasEstudiantesCajas(app, pool, authMiddleware) {

  // Buscar estudiante por CI del estudiante
  app.get('/api/estudiantes/buscar-por-ci-estudiante/:ci', authMiddleware, async (req, res) => {
    try {
      const { ci } = req.params;
      const [rows] = await pool.query(`
        SELECT e.*, i.id as inscripcion_id, i.nivel_id, n.nombre AS nivel_nombre, 
               i.curso_id, c.nombre AS curso_nombre, i.bloque_id, b.descripcion AS bloque_nombre, 
               i.turno, i.fecha_inscripcion, i.id_beca, i.estado as estado_inscripcion
        FROM estudiantes e
        LEFT JOIN inscripciones i ON e.id = i.estudiante_id AND i.estado = 'activo'
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        WHERE e.ci_estudiante = ? AND e.estado_id = 1
        ORDER BY i.fecha_inscripcion DESC
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

  // Listar estudiantes con filtros (para búsqueda por nombre)
  app.get('/api/estudiantes', authMiddleware, async (req, res) => {
    try {
      const { incluir_concluidos, anio } = req.query;
      const isAllYears = typeof anio === 'string' && anio.toLowerCase().trim() === 'todos';
      const includeConcluidos = incluir_concluidos === '1' || incluir_concluidos === 'true';
      const anioNum = isAllYears ? new Date().getFullYear() : (parseInt(anio, 10) || new Date().getFullYear());
      const estadoInscCond = includeConcluidos ? "i.estado IN ('activo','concluido','retirado')" : "i.estado = 'activo'";
      const yearCond = isAllYears
        ? '1=1'
        : `((i.gestion_academica IS NOT NULL AND i.gestion_academica = ${anioNum}) OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ${anioNum}))`;
      
      const [rows] = await pool.query(`
        SELECT e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
               e.ci_estudiante, e.fecha_nacimiento, e.lugar_nacimiento, e.genero, e.direccion,
               e.nombre_padre, e.apellido_padre, e.ci_padre, 
               e.nombre_madre, e.apellido_madre, e.ci_madre,
               e.telefono_domicilio_padre, e.telefono_oficina_padre,
               e.telefono_domicilio_madre, e.telefono_oficina_madre,
               e.codigo_estudiante, e.fecha_registro as fecha_creacion,
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
               END as estado_inscripcion
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

  // Obtener todas las inscripciones de un estudiante
  app.get('/api/estudiantes/:id/inscripciones', authMiddleware, async (req, res) => {
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

  // Crear servicio adquirido
  app.post('/api/servicios-estudiante', authMiddleware, async (req, res) => {
    try {
      const { estudiante_id, servicio_id, anio, mes_inicio, mes_fin, monto_mensual } = req.body;

      // Validaciones básicas
      if (!estudiante_id || !servicio_id || !anio || !mes_inicio || !mes_fin || !monto_mensual) {
        return res.status(400).json({ ok: false, message: 'Campos requeridos: estudiante_id, servicio_id, anio, mes_inicio, mes_fin, monto_mensual' });
      }
      if (mes_inicio < 1 || mes_inicio > 12 || mes_fin < 1 || mes_fin > 12 || mes_fin < mes_inicio) {
        return res.status(400).json({ ok: false, message: 'Rango de meses inválido' });
      }

      // Verificar existencia de estudiante y servicio
      const [estExists] = await pool.query('SELECT id FROM estudiantes WHERE id = ? AND estado_id = 1', [estudiante_id]);
      if (estExists.length === 0) return res.status(404).json({ ok: false, message: 'Estudiante no encontrado' });
      const [srvExists] = await pool.query('SELECT id FROM servicios WHERE id = ?', [servicio_id]);
      if (srvExists.length === 0) return res.status(404).json({ ok: false, message: 'Servicio no encontrado' });

      const meses_total = (mes_fin - mes_inicio + 1);
      const monto_total = parseFloat(monto_mensual) * meses_total;

      const [result] = await pool.query(
        `INSERT INTO servicios_estudiante (
          estudiante_id, servicio_id, anio, mes_inicio, mes_fin, monto_mensual, monto_pagado, saldo_pendiente, estado
        ) VALUES (?, ?, ?, ?, ?, ?, 0.00, ?, 'activo')`,
        [estudiante_id, servicio_id, anio, mes_inicio, mes_fin, parseFloat(monto_mensual), monto_total]
      );

      res.json({ ok: true, id: result.insertId, message: 'Servicio adquirido registrado' });
    } catch (error) {
      console.error('Error al crear servicio_estudiante:', error);
      res.status(500).json({ ok: false, message: 'Error al registrar servicio del estudiante', error: error.message });
    }
  });

  // Listar servicios adquiridos por estudiante
  app.get('/api/servicios-estudiante/:estudiante_id', authMiddleware, async (req, res) => {
    try {
      const { estudiante_id } = req.params;
      const [rows] = await pool.query(
        `SELECT se.*, s.descripcion as servicio_descripcion,
                (se.mes_fin - se.mes_inicio + 1) as meses_total,
                (se.monto_mensual * (se.mes_fin - se.mes_inicio + 1)) as monto_total,
                CASE 
                  WHEN ig.id IS NOT NULL THEN 1 ELSE 0
                END AS pagado,
                ig.forma_pago AS forma_pago,
                ig.fecha AS fecha_pago,
                ig.numero_comprobante,
                ig.nit_ci
         FROM servicios_estudiante se
         JOIN servicios s ON se.servicio_id = s.id
         LEFT JOIN ingresos ig 
           ON ig.tipo = 'servicios_estudiante' 
          AND ig.detalle = CONCAT('servicio:', se.id)
         WHERE se.estudiante_id = ?
         ORDER BY se.anio DESC, se.mes_inicio ASC`,
        [estudiante_id]
      );
      res.json(rows);
    } catch (error) {
      console.error('Error al listar servicios_estudiante:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener servicios del estudiante', error: error.message });
    }
  });

  // Registrar pago de un servicio adquirido (mes)
  app.post('/api/servicios-estudiante/:id/pagar', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params; // id de servicios_estudiante
      const { fecha_pago, forma_pago, numero_comprobante, nit_ci } = req.body;

      // Obtener el registro del servicio adquirido
      const [serv] = await pool.query('SELECT * FROM servicios_estudiante WHERE id = ?', [id]);
      if (serv.length === 0) return res.status(404).json({ ok: false, message: 'Servicio adquirido no encontrado' });
      const registro = serv[0];

      // Verificar si ya fue pagado (por id)
      const [yaPagado] = await pool.query(
        `SELECT 1 FROM ingresos WHERE tipo='servicios_estudiante' AND detalle = CONCAT('servicio:', ?) LIMIT 1`,
        [id]
      );
      if (yaPagado.length > 0) return res.status(400).json({ ok: false, message: 'Este mes ya fue pagado' });

      // Registrar en ingresos
      await pool.query(
        `INSERT INTO ingresos (monto, fecha, tipo, rubro, detalle, estudiante_id, forma_pago, numero_comprobante, nit_ci)
         VALUES (?, ?, 'servicios_estudiante', 'servicios_estudiante', ?, ?, ?, ?, ?)`,
        [registro.monto_mensual, fecha_pago || new Date(), `servicio:${id}`, registro.estudiante_id, forma_pago || null, numero_comprobante || null, nit_ci || null]
      );

      res.json({ ok: true, message: 'Pago registrado' });
    } catch (error) {
      console.error('Error al registrar pago de servicio:', error);
      res.status(500).json({ ok: false, message: 'Error al registrar pago', error: error.message });
    }
  });

  // Anular servicio adquirido (desde ahora en adelante)
  app.put('/api/servicios-estudiante/:id/anular', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body;

      const [exists] = await pool.query('SELECT id FROM servicios_estudiante WHERE id = ?', [id]);
      if (exists.length === 0) return res.status(404).json({ ok: false, message: 'Registro no encontrado' });

      await pool.query(
        `UPDATE servicios_estudiante 
         SET estado='anulado', fecha_anulacion = NOW(), motivo_anulacion = ?
         WHERE id = ?`,
        [motivo || null, id]
      );

      res.json({ ok: true, message: 'Servicio anulado correctamente' });
    } catch (error) {
      console.error('Error al anular servicio_estudiante:', error);
      res.status(500).json({ ok: false, message: 'Error al anular servicio', error: error.message });
    }
  });

  console.log('✅ Rutas de Estudiantes (Cajas) configuradas correctamente');
}

module.exports = { configurarRutasEstudiantesCajas };

