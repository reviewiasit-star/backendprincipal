// ===== MÓDULO DE COMPROMISO ECONÓMICO =====

// Función para verificar y actualizar el estado de un compromiso
async function verificarYActualizarEstadoCompromiso(pool, compromisoId) {
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
    `, [compromisoId]);
    
    if (compromisoCheck.length === 0) return false;
    
    const comp = compromisoCheck[0];
    
    // Verificar también por pagos mensuales - si todos están pagados, el compromiso está concluido
    const [pagosMensuales] = await pool.query(`
      SELECT COUNT(*) as total_meses,
             SUM(CASE WHEN estado = 'pagado' THEN 1 ELSE 0 END) as meses_pagados,
             SUM(CASE WHEN estado IN ('pendiente', 'parcial') THEN 1 ELSE 0 END) as meses_pendientes
      FROM pagos_mensuales
      WHERE id_compromiso = ?
    `, [compromisoId]);
    
    const todosMesesPagados = pagosMensuales.length > 0 && 
                               pagosMensuales[0].total_meses > 0 &&
                               pagosMensuales[0].meses_pendientes === 0;
    
    // Si está completamente pagado (por total o por pagos mensuales) y aún está activo, marcarlo como concluido
    if (comp.estado_compromiso === 'activo' && 
        (comp.saldo_pendiente <= 0.01 || todosMesesPagados)) {
      await pool.query(`
        UPDATE compromiso_economico 
        SET estado_compromiso = 'concluido',
            fecha_cambio_estado = CURDATE(),
            fecha_conclusion = CURDATE(),
            observacion_estado = 'Concluido automáticamente al completar pagos'
        WHERE id = ?
      `, [compromisoId]);
      
      console.log(`✅ Compromiso ${compromisoId} actualizado a concluido automáticamente`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`Error al verificar compromiso ${compromisoId}:`, error);
    return false;
  }
}

async function asegurarColumnasComprobanteIngresos(pool) {
  const columnasRequeridas = [
    { nombre: 'pdf_firmado', ddl: 'ADD COLUMN pdf_firmado VARCHAR(255) NULL' },
    { nombre: 'fecha_subida_firmado', ddl: 'ADD COLUMN fecha_subida_firmado DATETIME NULL' },
    { nombre: 'subido_por', ddl: 'ADD COLUMN subido_por VARCHAR(120) NULL' },
    { nombre: 'id_ocr_comprobante', ddl: 'ADD COLUMN id_ocr_comprobante INT NULL' }
  ];

  for (const col of columnasRequeridas) {
    const [exists] = await pool.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'ingresos'
         AND COLUMN_NAME = ?`,
      [col.nombre]
    );
    if (exists.length === 0) {
      await pool.query(`ALTER TABLE ingresos ${col.ddl}`);
    }
  }
}

function configurarRutasCompromisoEconomico(app, pool, authMiddleware) {
  // ===== ENDPOINTS PARA COMPROMISOS ECONÓMICOS =====

  // Crear un compromiso económico
  app.post('/api/compromiso-economico', authMiddleware, async (req, res) => {
    try {
      const { id_estudiante, inscripcion_id, total_cuotas, total_general, cuotas, descuento_aplicado, observacion } = req.body;
      
      // Validaciones básicas
      if (!id_estudiante || !inscripcion_id) {
        return res.status(400).json({ ok: false, message: 'El ID del estudiante y la inscripción son obligatorios' });
      }
      
      if (!total_cuotas || !total_general) {
        return res.status(400).json({ ok: false, message: 'Los montos son obligatorios' });
      }

      // Verificar si ya existe un compromiso para esta inscripción específica
      const [existingCompromiso] = await pool.query(
        'SELECT id FROM compromiso_economico WHERE inscripcion_id = ?',
        [inscripcion_id]
      );
      
      if (existingCompromiso.length > 0) {
        return res.status(400).json({ ok: false, message: 'Ya existe un compromiso económico para esta inscripción' });
      }

      // Obtener los datos de la inscripción (incluyendo id_beca, meses_beca, costo_mensual y meses desde nivel)
      const [inscripcion] = await pool.query(
        `SELECT i.id_beca, i.meses_beca, n.precio as costo_mensual, n.meses as meses_nivel 
         FROM inscripciones i 
         LEFT JOIN nivel n ON i.nivel_id = n.id 
         WHERE i.id = ?`,
        [inscripcion_id]
      );

      if (inscripcion.length === 0) {
        return res.status(404).json({ ok: false, message: 'Inscripción no encontrada' });
      }

      const [result] = await pool.query(
        `INSERT INTO compromiso_economico (id_estudiante, inscripcion_id, id_beca, meses_beca, total_cuotas, total_general, cuotas, descuento_aplicado, observacion, estado_compromiso, fecha_cambio_estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', CURDATE())`,
        [id_estudiante, inscripcion_id, inscripcion[0].id_beca, inscripcion[0].meses_beca, total_cuotas, total_general, cuotas || 10, descuento_aplicado || 0, observacion || null]
      );
      
      const compromisoId = result.insertId;
      
      // --- GENERAR PAGOS MENSUALES AUTOMÁTICAMENTE ---
      try {
        // Obtener los meses del nivel desde la base de datos
        const mesesNivel = JSON.parse(inscripcion[0].meses_nivel || '[]');
        const numeroCuotas = cuotas || mesesNivel.length;
        // CORRECCIÓN: Dividir el precio del nivel entre el número de cuotas para obtener el costo mensual
        const costoMensualOriginal = parseFloat(inscripcion[0].costo_mensual) / numeroCuotas;
        const anioActual = new Date().getFullYear();
        
        // Obtener información de la beca del compromiso económico
        let becaInfo = { 
          descuento: 0, 
          meses_beca: [], 
          porcentaje_descuento: 0 
        };
        
        if (inscripcion[0].id_beca && inscripcion[0].meses_beca) {
          // Usar la información directamente del compromiso económico
          becaInfo.porcentaje_descuento = parseFloat(descuento_aplicado || 0) * 100; // Convertir decimal a porcentaje
          
          // Procesar los meses de beca (viene como string: "febrero,marzo,abril")
          const mesesBecaArray = inscripcion[0].meses_beca.split(',').map(mes => mes.trim().toLowerCase());
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
        console.log(`📅 Meses del nivel (compromiso):`, mesesNivel);
        const mesesEscolares = mesesNivel.map(nombreMes => ({
          nombre: nombreMes.toLowerCase(),
          numero: obtenerNumeroMes(nombreMes)
        })).filter(mes => mes.numero > 0); // Filtrar meses válidos
        
        console.log(`📅 Meses procesados para pagos (compromiso):`, mesesEscolares.map(m => `${m.nombre}(${m.numero})`).join(', '));
        
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
        
      } catch (pagoError) {
        console.error('❌ ERROR CRÍTICO al generar pagos mensuales:', pagoError);
        console.error('❌ Stack trace:', pagoError.stack);
        // Retornar error para que sea visible
        return res.status(500).json({ 
          ok: false, 
          message: 'Error al generar pagos mensuales automáticamente', 
          error: pagoError.message,
          compromiso_id: compromisoId
        });
      }
      // --- FIN GENERACIÓN PAGOS MENSUALES ---
      
      res.json({ 
        ok: true, 
        id: compromisoId, 
        message: 'Compromiso económico registrado correctamente con pagos mensuales generados automáticamente',
        pagos_generados: cuotas || 10
      });
    } catch (error) {
      console.error('Error al crear compromiso:', error);
      
      // Manejo específico de errores
      if (error.code === 'ER_NO_REFERENCED_ROW_2') {
        return res.status(400).json({ ok: false, message: 'El estudiante, la inscripción o la beca especificada no existe' });
      }
      
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ ok: false, message: 'Ya existe un compromiso para esta inscripción' });
      }
      
      res.status(500).json({ ok: false, message: 'Error interno del servidor al crear compromiso', error: error.message });
    }
  });

  // Obtener el compromiso económico de un estudiante
  app.get('/api/compromiso-economico/:id_estudiante', async (req, res) => {
    try {
      const { id_estudiante } = req.params;
      const [rows] = await pool.query(`
        SELECT ce.*, n.precio as costo_mensual_original
        FROM compromiso_economico ce
        LEFT JOIN inscripciones i ON ce.inscripcion_id = i.id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        WHERE ce.id_estudiante = ? 
        ORDER BY ce.fecha_creacion DESC LIMIT 1
      `, [id_estudiante]);
      if (rows.length === 0) return res.status(404).json({ ok: false, message: 'Compromiso no encontrado' });
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener compromiso', error: error.message });
    }
  });

  // Obtener compromiso por inscripción específica
  app.get('/api/compromiso-economico/inscripcion/:inscripcion_id', async (req, res) => {
    try {
      const { inscripcion_id } = req.params;
      const [rows] = await pool.query(`
        SELECT ce.*, i.nivel_id, i.curso_id, i.bloque_id, i.turno,
               n.nombre as nivel_nombre, n.meses as nivel_meses, c.nombre as curso_nombre,
               b.descripcion as bloque_nombre
        FROM compromiso_economico ce
        LEFT JOIN inscripciones i ON ce.inscripcion_id = i.id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        WHERE ce.inscripcion_id = ?
      `, [inscripcion_id]);
      
      if (rows.length === 0) {
        return res.json({ ok: true, compromiso: null });
      }
      
      const compromiso = rows[0];
      
      // Verificar y actualizar el estado del compromiso si está completamente pagado
      if (compromiso.estado_compromiso === 'activo') {
        const actualizado = await verificarYActualizarEstadoCompromiso(pool, compromiso.id);
        if (actualizado) {
          compromiso.estado_compromiso = 'concluido';
        }
      }
      
      res.json({ ok: true, compromiso });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener compromiso', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA PAGOS =====

  // Registrar un pago realizado
  app.post('/api/pagos-realizados', authMiddleware, async (req, res) => {
    try {
      const { id_compromiso, fecha_pago, monto, tipo_pago, detalle, observacion, mes, anio, forma_pago, numero_comprobante, nit_ci } = req.body;
      
      // Validaciones básicas
      if (!id_compromiso || !fecha_pago || !monto || !tipo_pago) {
        return res.status(400).json({ ok: false, message: 'Los campos id_compromiso, fecha_pago, monto y tipo_pago son obligatorios' });
      }

      const [result] = await pool.query(
        `INSERT INTO pagos_realizados (id_compromiso, fecha_pago, monto, tipo_pago, detalle, observacion, mes, anio, forma_pago, numero_comprobante, nit_ci)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id_compromiso, fecha_pago, monto, tipo_pago, detalle || null, observacion || 'ninguna observación', mes || null, anio || null, forma_pago || null, numero_comprobante || null, nit_ci || null]
      );

      // --- Registro automático en ingresos ---
      // Buscar el estudiante relacionado al compromiso
      const [compromisoRows] = await pool.query(
        `SELECT id_estudiante FROM compromiso_economico WHERE id = ?`,
        [id_compromiso]
      );
      const estudiante_id = compromisoRows[0]?.id_estudiante || null;

      // Determinar el rubro
      let rubro = '';
      if (tipo_pago === 'cuota' || tipo_pago === 'material' || tipo_pago === 'ambos') {
        rubro = 'cuotas_material';
      }
      // Solo registrar si el rubro es válido
      if (rubro) {
        await pool.query(
          `INSERT INTO ingresos (monto, fecha, tipo, rubro, detalle, estudiante_id, forma_pago, numero_comprobante, nit_ci, usuario_registro, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [monto, fecha_pago, 'academico', rubro, detalle, estudiante_id, forma_pago || null, numero_comprobante || null, nit_ci || null, null, null]
        );
      }
      // --- Fin registro automático ---

      // --- Actualizar estado de pagos mensuales si es pago de cuota ---
      if ((tipo_pago === 'cuota' || tipo_pago === 'ambos') && mes && anio) {
        try {
          // Convertir nombre del mes a número si es necesario
          const mesesMap = {
            'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
            'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
          };
          
          let numeroMes = mes;
          if (isNaN(mes)) {
            // Si mes no es un número, convertir desde nombre
            numeroMes = mesesMap[mes.toLowerCase()] || null;
          }
          
          if (numeroMes) {
            // Buscar el pago mensual correspondiente
            const [pagoMensual] = await pool.query(`
              SELECT id, monto_esperado, monto_pagado, estado FROM pagos_mensuales 
              WHERE id_compromiso = ? AND mes = ? AND anio = ? AND estado IN ('pendiente', 'parcial')
              LIMIT 1
            `, [id_compromiso, numeroMes, anio]);
          
          if (pagoMensual.length > 0) {
            const pagoMensualData = pagoMensual[0];
            const montoEsperado = parseFloat(pagoMensualData.monto_esperado);
            const montoPagadoAnterior = parseFloat(pagoMensualData.monto_pagado || 0);
            const montoPagadoNuevo = parseFloat(monto);
            const montoTotalPagado = montoPagadoAnterior + montoPagadoNuevo;
            
            let nuevoEstado = 'pendiente';
            if (montoTotalPagado >= montoEsperado) {
              nuevoEstado = 'pagado';
            } else if (montoTotalPagado > 0) {
              nuevoEstado = 'parcial';
            }
            
            // Actualizar el pago mensual
            await pool.query(`
              UPDATE pagos_mensuales 
              SET monto_pagado = ?, estado = ?
              WHERE id = ?
            `, [montoTotalPagado, nuevoEstado, pagoMensualData.id]);
            
            console.log(`✅ Pago mensual ${pagoMensualData.id} actualizado: ${nuevoEstado} (${montoTotalPagado}/${montoEsperado})`);
          }
          } else {
            console.log(`⚠️ No se pudo convertir el mes "${mes}" a número`);
          }
        } catch (pagoMensualError) {
          console.error('Error al actualizar estado de pago mensual:', pagoMensualError);
          // No fallar el registro del pago por este error
        }
      }
      // --- Fin actualización pagos mensuales ---



      // --- Verificar si el compromiso está completamente pagado ---
      const [compromisoCheck] = await pool.query(`
        SELECT ce.id, ce.total_general, ce.estado_compromiso,
               COALESCE(SUM(pr.monto), 0) as total_pagado,
               (ce.total_general - COALESCE(SUM(pr.monto), 0)) as saldo_pendiente
        FROM compromiso_economico ce
        LEFT JOIN pagos_realizados pr ON ce.id = pr.id_compromiso
        WHERE ce.id = ?
        GROUP BY ce.id
      `, [id_compromiso]);

      if (compromisoCheck.length > 0) {
        const comp = compromisoCheck[0];
        
        // Si está completamente pagado y aún está activo, marcarlo como concluido
        if (comp.saldo_pendiente <= 0.01 && comp.estado_compromiso === 'activo') {
          await pool.query(`
            UPDATE compromiso_economico 
            SET estado_compromiso = 'concluido',
                fecha_cambio_estado = CURDATE(),
                observacion_estado = 'Concluido automáticamente al completar pagos'
            WHERE id = ?
          `, [id_compromiso]);
          
          res.json({ 
            ok: true, 
            id: result.insertId, 
            message: 'Pago registrado correctamente. Compromiso marcado como CONCLUIDO.',
            compromiso_concluido: true,
            total_pagado: comp.total_pagado + parseFloat(monto),
            total_general: comp.total_general
          });
        } else {
          res.json({ 
            ok: true, 
            id: result.insertId, 
            message: 'Pago registrado correctamente',
            compromiso_concluido: false,
            saldo_pendiente: comp.saldo_pendiente
          });
        }
      } else {
        res.json({ ok: true, id: result.insertId, message: 'Pago registrado correctamente' });
      }
    } catch (error) {
      console.error('Error al registrar pago:', error);
      
      // Manejo específico de errores
      if (error.code === 'ER_NO_REFERENCED_ROW_2') {
        return res.status(400).json({ ok: false, message: 'El compromiso especificado no existe' });
      }
      
      res.status(500).json({ ok: false, message: 'Error interno del servidor al registrar pago', error: error.message });
    }
  });

  // Regenerar pagos mensuales para un compromiso existente
  app.post('/api/regenerar-pagos-mensuales/:id_compromiso', authMiddleware, async (req, res) => {
    try {
      const { id_compromiso } = req.params;
      
      // Obtener información del compromiso y la inscripción
      const [compromiso] = await pool.query(`
        SELECT ce.*, i.id_beca, i.meses_beca, i.costo_mensual
        FROM compromiso_economico ce
        LEFT JOIN inscripciones i ON ce.inscripcion_id = i.id
        WHERE ce.id = ?
      `, [id_compromiso]);
      
      if (compromiso.length === 0) {
        return res.status(404).json({ ok: false, message: 'Compromiso no encontrado' });
      }
      
      const compromisoData = compromiso[0];
      const anioActual = new Date().getFullYear();
      // CORRECCIÓN: Usar el costo original del nivel, no el total_cuotas que ya tiene descuentos
      const costoMensualOriginal = parseFloat(compromisoData.costo_mensual);
      
      // Eliminar pagos mensuales existentes
      await pool.query('DELETE FROM pagos_mensuales WHERE id_compromiso = ?', [id_compromiso]);
      
      // Configurar información de beca
      let becaInfo = { 
        descuento: 0, 
        meses_beca: [], 
        porcentaje_descuento: 0 
      };
      
      if (compromisoData.id_beca && compromisoData.meses_beca) {
        becaInfo.porcentaje_descuento = parseFloat(compromisoData.descuento_aplicado || 0) * 100;
        const mesesBecaArray = compromisoData.meses_beca.split(',').map(mes => mes.trim().toLowerCase());
        becaInfo.meses_beca = mesesBecaArray;
      }
      
      // Meses del año escolar
      const mesesEscolares = [
        { nombre: 'enero', numero: 1 },
        { nombre: 'febrero', numero: 2 },
        { nombre: 'marzo', numero: 3 },
        { nombre: 'abril', numero: 4 },
        { nombre: 'mayo', numero: 5 },
        { nombre: 'junio', numero: 6 },
        { nombre: 'julio', numero: 7 },
        { nombre: 'agosto', numero: 8 },
        { nombre: 'septiembre', numero: 9 },
        { nombre: 'octubre', numero: 10 },
        { nombre: 'noviembre', numero: 11 },
        { nombre: 'diciembre', numero: 12 }
      ];
      
      const mesConBeca = (nombreMes) => {
        return becaInfo.meses_beca.includes(nombreMes.toLowerCase());
      };
      
      // Generar los pagos mensuales
      const pagosMensuales = [];
      
      for (let i = 0; i < mesesEscolares.length; i++) {
        const mesInfo = mesesEscolares[i];
        const nombreMes = mesInfo.nombre;
        const numeroMes = mesInfo.numero;
        
        const tieneBeca = mesConBeca(nombreMes);
        const montoBase = costoMensualOriginal;
        const porcentajeBeca = tieneBeca ? becaInfo.porcentaje_descuento : 0;
        const montoDescuento = tieneBeca ? (montoBase * porcentajeBeca / 100) : 0;
        const montoEsperado = montoBase - montoDescuento;
        
        const fechaVencimiento = new Date(anioActual, numeroMes - 1, 15);
        const fechaVencimientoStr = fechaVencimiento.toISOString().split('T')[0];
        
        pagosMensuales.push([
          parseInt(id_compromiso),
          parseInt(numeroMes),
          parseInt(anioActual),
          nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1),
          tieneBeca ? 1 : 0,
          tieneBeca ? parseFloat(porcentajeBeca) : null,
          parseFloat(montoBase.toFixed(2)),
          parseFloat(montoDescuento.toFixed(2)),
          parseFloat(montoEsperado.toFixed(2)),
          0.00,
          fechaVencimientoStr,
          'pendiente'
        ]);
      }
      
      // Insertar todos los pagos mensuales
      if (pagosMensuales.length > 0) {
        await pool.query(
          `INSERT INTO pagos_mensuales (
            id_compromiso, mes, anio, nombre_mes, tiene_beca, porcentaje_beca, 
            monto_base, monto_descuento, monto_esperado, monto_pagado, 
            fecha_vencimiento, estado
          ) VALUES ?`,
          [pagosMensuales]
        );
        
        console.log(`✅ Se regeneraron ${pagosMensuales.length} pagos mensuales para el compromiso ${id_compromiso}`);
      }


      
      res.json({ 
        ok: true, 
        message: `Se regeneraron ${pagosMensuales.length} pagos mensuales correctamente`,
        pagos_generados: pagosMensuales.length
      });
      
    } catch (error) {
      console.error('Error al regenerar pagos mensuales:', error);
      res.status(500).json({ ok: false, message: 'Error al regenerar pagos mensuales', error: error.message });
    }
  });

  // Obtener todos los pagos realizados de un compromiso
  app.get('/api/pagos-realizados/:id_compromiso', async (req, res) => {
    try {
      const { id_compromiso } = req.params;
      // Identificar estudiante relacionado al compromiso para incluir servicios pagados
      const [compromisoRows] = await pool.query(
        'SELECT id_estudiante FROM compromiso_economico WHERE id = ? LIMIT 1',
        [id_compromiso]
      );
      if (compromisoRows.length === 0) {
        return res.json([]);
      }

      const estudianteId = compromisoRows[0].id_estudiante;

      // Migración suave para soportar comprobantes de servicios en ingresos
      try {
        await asegurarColumnasComprobanteIngresos(pool);
      } catch (migrationError) {
        console.warn('⚠️ No se pudieron asegurar columnas de comprobante en ingresos:', migrationError.message);
      }

      // Pagos de compromiso (cuotas/material)
      const [pagosCompromiso] = await pool.query(
        `SELECT
          pr.*,
          'pagos_realizados' AS origen_registro
        FROM pagos_realizados pr
        WHERE pr.id_compromiso = ?`,
        [id_compromiso]
      );

      // Pagos de servicios (tabla ingresos)
      let pagosServicios = [];
      try {
        const [rowsServicios] = await pool.query(
          `SELECT
            i.id,
            NULL AS id_compromiso,
            i.fecha AS fecha_pago,
            i.monto,
            'servicio' AS tipo_pago,
            i.detalle,
            COALESCE(i.observaciones, 'ninguna observación') AS observacion,
            NULL AS mes,
            YEAR(i.fecha) AS anio,
            i.forma_pago,
            i.numero_comprobante,
            i.nit_ci,
            NULL AS pdf_original,
            i.pdf_firmado,
            i.fecha_subida_firmado,
            i.subido_por,
            i.id_ocr_comprobante,
            'ingresos' AS origen_registro
          FROM ingresos i
          WHERE i.estudiante_id = ?
            AND i.tipo = 'servicios_estudiante'`,
          [estudianteId]
        );
        pagosServicios = rowsServicios;
      } catch (serviciosError) {
        console.warn('⚠️ No se pudieron cargar pagos de servicios en historial:', serviciosError.message);
      }

      const rows = [...pagosCompromiso, ...pagosServicios].sort(
        (a, b) => new Date(a.fecha_pago).getTime() - new Date(b.fecha_pago).getTime()
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener pagos', error: error.message });
    }
  });

  // Actualizar estado de un pago mensual específico
  app.put('/api/pagos-mensuales/:id/estado', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { estado, monto_pagado, observaciones } = req.body;
      
      // Validar estado
      if (!['pendiente', 'pagado', 'vencido', 'parcial'].includes(estado)) {
        return res.status(400).json({ ok: false, message: 'Estado inválido. Debe ser: pendiente, pagado, vencido o parcial' });
      }
      
      // Verificar que el pago mensual existe
      const [pagoMensual] = await pool.query('SELECT * FROM pagos_mensuales WHERE id = ?', [id]);
      
      if (pagoMensual.length === 0) {
        return res.status(404).json({ ok: false, message: 'Pago mensual no encontrado' });
      }
      
      // Preparar campos a actualizar
      let updateFields = ['estado = ?'];
      let updateValues = [estado];
      
      // Si se proporciona monto_pagado, actualizarlo
      if (monto_pagado !== undefined) {
        updateFields.push('monto_pagado = ?');
        updateValues.push(parseFloat(monto_pagado));
      }
      
      // Si se proporcionan observaciones, actualizarlas
      if (observaciones !== undefined) {
        updateFields.push('observaciones = ?');
        updateValues.push(observaciones);
      }
      
      updateValues.push(id);
      
      // Actualizar el pago mensual
      await pool.query(
        `UPDATE pagos_mensuales SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
      
      // Obtener el pago actualizado
      const [pagoActualizado] = await pool.query('SELECT * FROM pagos_mensuales WHERE id = ?', [id]);
      
      res.json({ 
        ok: true, 
        message: `Pago mensual actualizado exitosamente`,
        pago_mensual: pagoActualizado[0]
      });
      
    } catch (error) {
      console.error('Error al actualizar pago mensual:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar pago mensual', error: error.message });
    }
  });

  // Eliminar un pago realizado
  app.delete('/api/pagos-realizados/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM pagos_realizados WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al eliminar pago', error: error.message });
    }
  });

  // Marcar compromiso como concluido
  app.put('/api/compromiso-economico/:id/concluir', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { observacion } = req.body;
      
      // Verificar que el compromiso existe y obtener información
      const [compromiso] = await pool.query(`
        SELECT ce.*, 
               COALESCE(SUM(pr.monto), 0) as total_pagado,
               (ce.total_general - COALESCE(SUM(pr.monto), 0)) as saldo_pendiente
        FROM compromiso_economico ce
        LEFT JOIN pagos_realizados pr ON ce.id = pr.id_compromiso
        WHERE ce.id = ?
        GROUP BY ce.id
      `, [id]);
      
      if (compromiso.length === 0) {
        return res.status(404).json({ ok: false, message: 'Compromiso no encontrado' });
      }
      
      const comp = compromiso[0];
      
      // Verificar que esté completamente pagado
      if (comp.saldo_pendiente > 0.01) { // Tolerancia para decimales
        return res.status(400).json({ 
          ok: false, 
          message: `No se puede concluir el compromiso. Saldo pendiente: Bs ${comp.saldo_pendiente.toFixed(2)}` 
        });
      }
      
      // Marcar como concluido
      await pool.query(`
        UPDATE compromiso_economico 
        SET estado_compromiso = 'concluido',
            fecha_conclusion = CURDATE(),
            observacion_conclusion = ?
        WHERE id = ?
      `, [observacion || 'Compromiso concluido automáticamente', id]);
      
      res.json({ 
        ok: true, 
        message: 'Compromiso marcado como concluido exitosamente',
        total_pagado: comp.total_pagado,
        total_general: comp.total_general
      });
      
    } catch (error) {
      console.error('Error al concluir compromiso:', error);
      res.status(500).json({ ok: false, message: 'Error al concluir compromiso', error: error.message });
    }
  });

  // Obtener compromisos por estudiante y gestión académica
  app.get('/api/estudiante/:id/compromisos-historial', async (req, res) => {
    try {
      const { id } = req.params;
      const { gestion } = req.query;
      
      let query = `
        SELECT ce.*, 
               i.gestion_academica,
               i.estado_inscripcion,
               n.nombre as nivel_nombre,
               c.nombre as curso_nombre,
               b.descripcion as bloque_nombre,
               COALESCE(SUM(pr.monto), 0) as total_pagado,
               (ce.total_general - COALESCE(SUM(pr.monto), 0)) as saldo_pendiente,
               CASE 
                 WHEN (ce.total_general - COALESCE(SUM(pr.monto), 0)) <= 0.01 THEN 'SI'
                 ELSE 'NO'
               END as completamente_pagado
        FROM compromiso_economico ce
        INNER JOIN inscripciones i ON ce.inscripcion_id = i.id
        INNER JOIN nivel n ON i.nivel_id = n.id
        INNER JOIN curso c ON i.curso_id = c.id
        INNER JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN pagos_realizados pr ON ce.id = pr.id_compromiso
        WHERE ce.id_estudiante = ?
      `;
      
      let params = [id];
      
      if (gestion) {
        query += ' AND i.gestion_academica = ?';
        params.push(gestion);
      }
      
      query += ' GROUP BY ce.id ORDER BY i.gestion_academica DESC, ce.fecha_creacion DESC';
      
      const [rows] = await pool.query(query, params);
      res.json(rows);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener historial de compromisos', error: error.message });
    }
  });

  // Obtener pagos mensuales de un compromiso
  app.get('/api/compromiso-economico/:id_compromiso/detalle-pagos', async (req, res) => {
    try {
      const { id_compromiso } = req.params;
      
      // Obtener pagos mensuales
      const [pagosMensuales] = await pool.query(`
        SELECT pm.*, 
               CASE pm.mes
                 WHEN 1 THEN 'Enero'
                 WHEN 2 THEN 'Febrero'
                 WHEN 3 THEN 'Marzo'
                 WHEN 4 THEN 'Abril'
                 WHEN 5 THEN 'Mayo'
                 WHEN 6 THEN 'Junio'
                 WHEN 7 THEN 'Julio'
                 WHEN 8 THEN 'Agosto'
                 WHEN 9 THEN 'Septiembre'
                 WHEN 10 THEN 'Octubre'
                 WHEN 11 THEN 'Noviembre'
                 WHEN 12 THEN 'Diciembre'
               END as nombre_mes,
               (pm.monto_esperado - COALESCE(pm.monto_pagado, 0)) as saldo_pendiente
        FROM pagos_mensuales pm
        WHERE pm.id_compromiso = ?
        ORDER BY pm.anio, pm.mes
      `, [id_compromiso]);
      
      // Obtener información del compromiso
      const [compromiso] = await pool.query(`
        SELECT ce.*, e.nombre, e.apellido_paterno, e.apellido_materno,
               i.nivel_id, i.curso_id, i.bloque_id,
               n.nombre as nivel_nombre, c.nombre as curso_nombre, b.descripcion as bloque_nombre
        FROM compromiso_economico ce
        LEFT JOIN inscripciones i ON ce.inscripcion_id = i.id
        LEFT JOIN estudiantes e ON i.estudiante_id = e.id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        WHERE ce.id = ?
      `, [id_compromiso]);
      
      if (compromiso.length === 0) {
        return res.status(404).json({ ok: false, message: 'Compromiso no encontrado' });
      }
      
      res.json({
        ok: true,
        compromiso: compromiso[0],
        pagosMensuales
      });
      
    } catch (error) {
      console.error('Error al obtener detalle de pagos:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener detalle de pagos', error: error.message });
    }
  });

  // Endpoint para actualizar todos los compromisos que deberían estar concluidos
  app.post('/api/compromiso-economico/actualizar-estados', authMiddleware, async (req, res) => {
    try {
      // Obtener todos los compromisos activos
      const [compromisosActivos] = await pool.query(`
        SELECT id FROM compromiso_economico WHERE estado_compromiso = 'activo'
      `);
      
      let actualizados = 0;
      let errores = 0;
      
      // Verificar y actualizar cada compromiso
      for (const comp of compromisosActivos) {
        try {
          const actualizado = await verificarYActualizarEstadoCompromiso(pool, comp.id);
          if (actualizado) {
            actualizados++;
          }
        } catch (error) {
          console.error(`Error al verificar compromiso ${comp.id}:`, error);
          errores++;
        }
      }
      
      res.json({
        ok: true,
        message: `Proceso completado. ${actualizados} compromiso(s) actualizado(s) a concluido. ${errores} error(es).`,
        actualizados,
        errores,
        total_revisados: compromisosActivos.length
      });
    } catch (error) {
      console.error('Error al actualizar estados de compromisos:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar estados', error: error.message });
    }
  });

  // Log silenciado
}

module.exports = { configurarRutasCompromisoEconomico };

