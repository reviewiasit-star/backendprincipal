// ===== MÓDULO DE REPORTES DE PAGOS =====

function configurarRutasReportes(app, pool, authMiddleware) {
  // ===== ENDPOINTS PARA REPORTES DE ESTUDIANTES =====

  // ------------------------------------------------------------
  // FUNCION: /api/reporte-pagos-estudiantes
  // Entradas (req.query):
  // - anio, estado_compromiso, bloque_id, nivel_id, curso_id
  // Como calcula:
  // - Consolida pagos por mes usando pagos_mensuales y pagos_realizados.
  // - Calcula estado mensual (pagado/parcial/pendiente) y totales por estudiante.
  // - saldo_pendiente = max(0, total_esperado - total_pagado)
  // Salida:
  // - Reporte completo por estudiante con desglose mensual y resumen economico.
  // ------------------------------------------------------------
  // Endpoint para reporte de pagos de estudiantes (CORREGIDO)
  app.get('/api/reporte-pagos-estudiantes', authMiddleware, async (req, res) => {
    try {
      const { anio, estado_compromiso, bloque_id, nivel_id, curso_id } = req.query;
      const isAllYears = typeof anio === 'string' && anio.toLowerCase().trim() === 'todos';
      const yearFilter = isAllYears ? null : (anio || new Date().getFullYear());
      const estadoFilter = estado_compromiso || 'todos';
      
      console.log('Solicitud de reporte de pagos para año:', yearFilter);

      const normalizarFiltro = (val) => {
        if (val == null) return null;
        const s = String(val).trim();
        if (!s) return null;
        if (s.toLowerCase() === 'todos') return null;
        return s;
      };

      const bloqueFilter = normalizarFiltro(bloque_id);
      const nivelFilter = normalizarFiltro(nivel_id);
      const cursoFilter = normalizarFiltro(curso_id);

      const whereClauses = [];
      const queryParams = [];

      if (estadoFilter === 'todos') {
        whereClauses.push("ce.estado_compromiso IN ('activo', 'concluido', 'cancelado', 'retirado')");
      } else {
        whereClauses.push('ce.estado_compromiso = ?');
        queryParams.push(estadoFilter);
      }

      // Incluir también inscripciones retiradas (baja lógica) para que el filtro "Retirados" funcione
      whereClauses.push("i.estado IN ('activo','concluido','retirado')");

      if (!isAllYears) {
        whereClauses.push(`(
          (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
          OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
        )`);
        queryParams.push(yearFilter, yearFilter);
      }

      if (bloqueFilter) {
        whereClauses.push('i.bloque_id = ?');
        queryParams.push(bloqueFilter);
      }

      if (nivelFilter) {
        whereClauses.push('i.nivel_id = ?');
        queryParams.push(nivelFilter);
      }

      if (cursoFilter) {
        whereClauses.push('i.curso_id = ?');
        queryParams.push(cursoFilter);
      }

      const estudiantesQuery = `
        SELECT
          e.id as estudiante_id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          e.telefono_domicilio_padre,
          e.telefono_oficina_padre,
          e.telefono_domicilio_madre,
          e.telefono_oficina_madre,
          ca.telefonos_aviso,
          i.bloque_id,
          b.descripcion AS bloque_nombre,
          i.nivel_id,
          n.nombre AS nivel_nombre,
          n.meses AS nivel_meses,
          i.curso_id,
          c.nombre AS curso_nombre,
          COALESCE(NULLIF(TRIM(c.turno), ''), i.turno) AS turno,
          ce.id AS compromiso_id,
          ce.total_cuotas,
          ce.total_general,
          ce.estado_compromiso,
          ce.fecha_creacion
        FROM
          estudiantes e
        INNER JOIN
          compromiso_economico ce ON e.id = ce.id_estudiante
        INNER JOIN
          inscripciones i ON i.id = ce.inscripcion_id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN (
          SELECT estudiante_id, GROUP_CONCAT(telefono SEPARATOR ', ') as telefonos_aviso
          FROM contacto_aviso
          WHERE activo = TRUE
          GROUP BY estudiante_id
        ) ca ON e.id = ca.estudiante_id
        WHERE
          ${whereClauses.join('\n          AND ')}
        ORDER BY
          e.nombre, e.apellido_paterno, ce.fecha_creacion DESC
      `;
      
      const [estudiantes] = await pool.query(estudiantesQuery, queryParams);
      
      console.log('Estudiantes encontrados:', estudiantes.length);
      
      // Para cada estudiante, obtener el detalle mensual
      const estudiantesConPagos = await Promise.all(estudiantes.map(async (estudiante) => {
        // Parsear meses válidos del nivel (si existen)
        let mesesPlan = [];
        if (estudiante.nivel_meses) {
          try {
            const parsed = JSON.parse(estudiante.nivel_meses);
            if (Array.isArray(parsed)) {
              mesesPlan = parsed
                .filter(m => typeof m === 'string' && m.trim() !== '')
                .map(m => {
                  const limpio = m.trim().toLowerCase();
                  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
                });
            }
          } catch (e) {
            console.error('Error parseando nivel_meses:', e);
          }
        }
        // Obtener pagos mensuales desde pagos_mensuales (si existen)
        const pagosDetalleQuery = isAllYears ? `
          SELECT
            pm.mes,
            pm.nombre_mes,
            pm.monto_base,
            pm.tiene_beca,
            pm.porcentaje_beca,
            pm.monto_descuento,
            pm.monto_esperado,
            pm.monto_pagado,
            pm.estado,
            pm.fecha_vencimiento,
            pm.observaciones
          FROM
            pagos_mensuales pm
          WHERE
            pm.id_compromiso = ?
          ORDER BY
            pm.mes
        ` : `
          SELECT
            pm.mes,
            pm.nombre_mes,
            pm.monto_base,
            pm.tiene_beca,
            pm.porcentaje_beca,
            pm.monto_descuento,
            pm.monto_esperado,
            pm.monto_pagado,
            pm.estado,
            pm.fecha_vencimiento,
            pm.observaciones
          FROM
            pagos_mensuales pm
          WHERE
            pm.id_compromiso = ? AND pm.anio = ?
          ORDER BY
            pm.mes
        `;
        
        const [pagosDetalle] = isAllYears 
          ? await pool.query(pagosDetalleQuery, [estudiante.compromiso_id])
          : await pool.query(pagosDetalleQuery, [estudiante.compromiso_id, yearFilter]);
        
        // Obtener pagos realizados por mes desde pagos_realizados
        const pagosRealizadosQuery = isAllYears ? `
          SELECT 
            mes,
            SUM(monto) as total_pagado_mes
          FROM pagos_realizados 
          WHERE id_compromiso = ? AND tipo_pago = 'cuota'
          GROUP BY mes
        ` : `
          SELECT 
            mes,
            SUM(monto) as total_pagado_mes
          FROM pagos_realizados 
          WHERE id_compromiso = ? AND tipo_pago = 'cuota' AND anio = ?
          GROUP BY mes
        `;
        
        const [pagosRealizados] = isAllYears 
          ? await pool.query(pagosRealizadosQuery, [estudiante.compromiso_id])
          : await pool.query(pagosRealizadosQuery, [estudiante.compromiso_id, yearFilter]);
        
        // Crear mapa de pagos realizados por mes
        const pagosRealizadosPorMes = {};
        pagosRealizados.forEach(pago => {
          pagosRealizadosPorMes[pago.mes] = parseFloat(pago.total_pagado_mes) || 0;
        });
        
        // Crear objeto de pagos por mes para compatibilidad con frontend
        const pagosPorMes = {};
        const mesesDelAnio = [
          { numero: 1, nombre: 'Enero' },
          { numero: 2, nombre: 'Febrero' },
          { numero: 3, nombre: 'Marzo' },
          { numero: 4, nombre: 'Abril' },
          { numero: 5, nombre: 'Mayo' },
          { numero: 6, nombre: 'Junio' },
          { numero: 7, nombre: 'Julio' },
          { numero: 8, nombre: 'Agosto' },
          { numero: 9, nombre: 'Septiembre' },
          { numero: 10, nombre: 'Octubre' },
          { numero: 11, nombre: 'Noviembre' },
          { numero: 12, nombre: 'Diciembre' }
        ];
        
        let totalPagadoCuotas = 0;
        let totalEsperadoCuotas = 0;
        
        // ==========================================
        // CALCULO AUTOMATICO POR MES (REPORTE DETALLADO)
        // Entrada:
        // - pagos_mensuales: define monto_esperado, monto_pagado, beca y vencimiento por mes
        // - pagos_realizados: respaldo de pagos efectivamente registrados
        // Regla de prioridad:
        // 1) Si existe pagos_mensuales para el mes, se usa como fuente principal.
        // 2) Si no existe, pero hay pago_realizado, se toma ese monto.
        // 3) Si no existe ninguno, se genera cuota por defecto:
        //    cuotaMensualBase = total_cuotas / (mesesPlan o 12)
        // Estado mensual:
        // - pagado  : monto_pagado >= monto_esperado
        // - parcial : monto_pagado > 0 y monto_pagado < monto_esperado
        // - pendiente: sin pago o pago insuficiente
        // ==========================================
        mesesDelAnio.forEach(mesInfo => {
          // Si el nivel define meses y este mes NO está en el plan, marcar como no aplicable
          if (mesesPlan.length > 0 && !mesesPlan.includes(mesInfo.nombre)) {
            pagosPorMes[mesInfo.nombre] = {
              cuota: 0,
              material: 0,
              total: 0,
              estado: 'no_aplica',
              tiene_beca: false,
              descuento_beca: 0,
              monto_esperado: 0,
              monto_con_descuento: 0,
              fecha_vencimiento: null,
              observaciones: 'Mes fuera del plan del nivel'
            };
            return; // No sumar a esperados ni pagados
          }

          const pagoMensual = pagosDetalle.find(p => p.mes === mesInfo.numero);
          const montoPagadoRealizado = pagosRealizadosPorMes[mesInfo.nombre.toLowerCase()] || 0;
          
          if (pagoMensual) {
            // Si existe en pagos_mensuales, usar esos datos como fuente de verdad
            const montoPagado = parseFloat(pagoMensual.monto_pagado) || 0;
            const montoEsperado = parseFloat(pagoMensual.monto_esperado) || 0;
            
            let estado = 'pendiente';
            if (montoPagado >= montoEsperado && montoEsperado > 0) {
              estado = 'pagado';
            } else if (montoPagado > 0) {
              estado = 'parcial';
            }
            
            pagosPorMes[mesInfo.nombre] = {
              cuota: montoPagado,
              material: 0,
              total: montoPagado,
              estado: estado,
              tiene_beca: pagoMensual.tiene_beca,
              descuento_beca: pagoMensual.porcentaje_beca,
              monto_esperado: parseFloat(pagoMensual.monto_base) || 0,
              monto_con_descuento: montoEsperado,
              fecha_vencimiento: pagoMensual.fecha_vencimiento,
              observaciones: pagoMensual.observaciones
            };
            
            totalPagadoCuotas += montoPagado;
            totalEsperadoCuotas += montoEsperado;
          } else if (montoPagadoRealizado > 0) {
            // Si no existe en pagos_mensuales pero hay pagos realizados
            pagosPorMes[mesInfo.nombre] = {
              cuota: montoPagadoRealizado,
              material: 0,
              total: montoPagadoRealizado,
              estado: 'pagado',
              tiene_beca: false,
              descuento_beca: 0,
              monto_esperado: montoPagadoRealizado,
              monto_con_descuento: montoPagadoRealizado,
              fecha_vencimiento: null,
              observaciones: null
            };
            
            totalPagadoCuotas += montoPagadoRealizado;
            totalEsperadoCuotas += montoPagadoRealizado;
          } else {
            // Si no existe en pagos_mensuales ni hay pagos realizados, generar registro por defecto
            // Calcular cuota mensual base considerando el plan del nivel si existe
            const divisor = mesesPlan.length > 0 ? mesesPlan.length : 12;
            const cuotaMensualBase = parseFloat(estudiante.total_cuotas) / divisor;
            
            pagosPorMes[mesInfo.nombre] = {
              cuota: 0,
              material: 0,
              total: 0,
              estado: 'pendiente',
              tiene_beca: false,
              descuento_beca: 0,
              monto_esperado: cuotaMensualBase,
              monto_con_descuento: cuotaMensualBase,
              fecha_vencimiento: null,
              observaciones: null
            };
            
            totalEsperadoCuotas += cuotaMensualBase;
          }
        });
        
        // Totales generales
        // ==========================================
        // CONSOLIDACION AUTOMATICA POR ESTUDIANTE
        // - total_pagado     : suma mensual de montos pagados
        // - total_esperado   : suma mensual de montos esperados
        // - saldo_pendiente  : max(0, total_esperado - total_pagado)
        // Estos valores alimentan reportes individuales y agregados.
        // ==========================================
        const totalPagado = totalPagadoCuotas;
        const totalEsperado = totalEsperadoCuotas;
        const saldoPendiente = Math.max(0, totalEsperado - totalPagado);
        
        return {
          id: estudiante.estudiante_id,
          compromiso_id: estudiante.compromiso_id,
          nombre: `${estudiante.nombre} ${estudiante.apellido_paterno} ${estudiante.apellido_materno}`,
          ci_estudiante: estudiante.ci_estudiante,
          telefono_domicilio_padre: estudiante.telefono_domicilio_padre,
          telefono_oficina_padre: estudiante.telefono_oficina_padre,
          telefono_domicilio_madre: estudiante.telefono_domicilio_madre,
          telefono_oficina_madre: estudiante.telefono_oficina_madre,
          telefonos_aviso: estudiante.telefonos_aviso,
          bloque_id: estudiante.bloque_id,
          bloque_nombre: estudiante.bloque_nombre,
          nivel_id: estudiante.nivel_id,
          nivel_nombre: estudiante.nivel_nombre,
          curso_id: estudiante.curso_id,
          curso_nombre: estudiante.curso_nombre,
          turno: estudiante.turno,
          pagos_por_mes: pagosPorMes,
          total_pagado: totalPagado,
          total_esperado: totalEsperado,
          total_cuotas: estudiante.total_cuotas,
          total_general: estudiante.total_general,
          saldo_pendiente: saldoPendiente,
          estado_compromiso: estudiante.estado_compromiso
        };
      }));
      
      console.log('Estudiantes procesados:', estudiantesConPagos.length);
      
      res.json({
        ok: true,
        estudiantes: estudiantesConPagos,
        total_estudiantes: estudiantesConPagos.length
      });
      
    } catch (error) {
      console.error('Error al obtener reporte de pagos:', error);
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener reporte de pagos', 
        error: error.message 
      });
    }
  });

  // Obtener estudiantes con compromisos concluidos
  app.get('/api/estudiantes-compromisos-concluidos', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT 
          e.id, e.nombre, e.apellido_paterno, e.apellido_materno, 
          e.ci_estudiante, e.fecha_creacion as fecha_creacion_estudiante,
          ce.id as compromiso_id, ce.total_general, ce.estado_compromiso,
          ce.fecha_creacion as fecha_compromiso, ce.fecha_conclusion
        FROM estudiantes e
        INNER JOIN compromiso_economico ce ON e.id = ce.id_estudiante
        WHERE ce.estado_compromiso = 'concluido' AND e.estado_id = 1
        ORDER BY ce.fecha_conclusion DESC, e.apellido_paterno, e.apellido_materno, e.nombre
      `);
      
      res.json(rows);
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener estudiantes con compromisos concluidos', 
        error: error.message 
      });
    }
  });

  // Log silenciado
}

module.exports = { configurarRutasReportes };

