const MESES = [
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

const obtenerNombreMes = (numero) => {
  const mes = MESES.find((m) => m.numero === Number(numero));
  return mes ? mes.nombre : 'Sin mes';
};

const numeroSeguro = (valor) => {
  const num = Number(valor || 0);
  return Number.isFinite(num) ? num : 0;
};

const primerDatoDisponible = (...valores) => {
  for (const value of valores) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
    if (value && typeof value === 'number') {
      return value.toString();
    }
  }
  return '';
};

const construirMensaje = ({ tutor, estudiante, mesNombre, saldoPendiente, anio }) => {
  const monto = saldoPendiente.toFixed(2);
  return `Buenos días ${tutor || 'tutor/a'}, le recordamos que la cuota del mes de ${mesNombre} (${anio}) correspondiente a ${estudiante} continúa pendiente por Bs ${monto}. Agradecemos confirmar su pago o indicarnos la fecha estimada. Atte. Unidad Educativa EMI.`;
};

const construirRanking = (items, campoClave, campoEtiqueta, max = 5) => {
  const mapa = new Map();

  items.forEach((item) => {
    const clave = item[campoClave] || 'sin_dato';
    const etiqueta = item[campoEtiqueta] || 'Sin registro';
    if (!mapa.has(clave)) {
      mapa.set(clave, {
        id: clave,
        nombre: etiqueta,
        deudores: 0,
        montoPendiente: 0
      });
    }
    const entry = mapa.get(clave);
    entry.deudores += 1;
    entry.montoPendiente += item.saldo_pendiente;
  });

  return Array.from(mapa.values())
    .sort((a, b) => {
      if (b.montoPendiente !== a.montoPendiente) {
        return b.montoPendiente - a.montoPendiente;
      }
      return b.deudores - a.deudores;
    })
    .slice(0, max);
};

function configurarRutasDashboardPagos(app, pool, authMiddleware) {
  const DASHBOARD_PAGOS_DEBUG =
    process.env.DASHBOARD_PAGOS_DEBUG === 'true' || process.env.DASHBOARD_PAGOS_DEBUG === '1';
  const debugLog = (...args) => {
    if (DASHBOARD_PAGOS_DEBUG) console.log(...args);
  };

  // ------------------------------------------------------------
  // FUNCION: /api/dashboard/pagos/deudores
  // Entradas (req.query):
  // - anio, mes, estado, bloque_id, nivel_id, curso_id, incluir_pagados
  // Como calcula:
  // - saldo_pendiente = max(0, monto_esperado - monto_pagado)
  // - estado automatico: pagado/parcial/pendiente/vencido
  // - dias_atraso segun fecha_vencimiento
  // - totales: esperado, pagado, pendiente, vencido
  // - porcentaje_pagado = (total_pagado / total_esperado) * 100
  // - rankings por bloque, nivel y curso
  // Salida:
  // - Dashboard consolidado de deudores y resumen financiero.
  // ------------------------------------------------------------
  app.get('/api/dashboard/pagos/deudores', authMiddleware, async (req, res) => {
    try {
      const hoy = new Date();
      const anioActual = hoy.getFullYear();
      const mesActual = hoy.getMonth() + 1;

      const anio = parseInt(req.query.anio, 10) || anioActual;
      const mesParam = req.query.mes;
      const estadoFiltro = (req.query.estado || 'todos').toLowerCase();
      const bloqueId = req.query.bloque_id ? parseInt(req.query.bloque_id, 10) : null;
      const nivelId = req.query.nivel_id ? parseInt(req.query.nivel_id, 10) : null;
      const cursoId = req.query.curso_id ? parseInt(req.query.curso_id, 10) : null;
      const incluirPagados = req.query.incluir_pagados === 'true' || req.query.incluir_pagados === '1';

      let mesFiltrado = mesActual;
      if (mesParam && ['todos', 'all', '0'].includes(mesParam.toString().toLowerCase())) {
        mesFiltrado = null;
      } else if (mesParam) {
        const mesParsed = parseInt(mesParam, 10);
        if (!Number.isNaN(mesParsed) && mesParsed >= 1 && mesParsed <= 12) {
          mesFiltrado = mesParsed;
        }
      }

      // Evitar logs con datos sensibles por defecto.
      debugLog('[Dashboard Pagos] Parámetros recibidos:', {
        anio,
        mesParam,
        mesFiltrado,
        incluirPagados,
        bloqueId,
        nivelId,
        cursoId
      });

      const condiciones = ['pm.anio = ?'];
      const params = [anio];

      if (mesFiltrado) {
        condiciones.push('pm.mes = ?');
        params.push(mesFiltrado);
      }

      if (bloqueId) {
        condiciones.push('b.id = ?');
        params.push(bloqueId);
      }

      if (nivelId) {
        condiciones.push('n.id = ?');
        params.push(nivelId);
      }

      if (cursoId) {
        condiciones.push('c.id = ?');
        params.push(cursoId);
      }

      // No considerar compromisos retirados/cancelados como deuda activa (baja lógica)
      condiciones.push(`COALESCE(ce.estado_compromiso, 'activo') NOT IN ('retirado','cancelado')`);

      // Solo filtrar deudores si no se incluyen pagados
      // Un estudiante debe si: monto_pagado < monto_esperado (incluye pendientes y parciales)
      if (!incluirPagados) {
        condiciones.push(`COALESCE(pm.monto_pagado, 0) < COALESCE(pm.monto_esperado, 0)`);
      }

      const query = `
        SELECT 
          pm.id,
          pm.id_compromiso,
          pm.mes,
          pm.nombre_mes,
          pm.anio,
          pm.estado,
          pm.fecha_vencimiento,
          pm.monto_esperado,
          pm.monto_pagado,
          ce.id_estudiante,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.nombre_padre,
          e.nombre_madre,
          e.telefono_domicilio_padre,
          e.telefono_oficina_padre,
          e.telefono_domicilio_madre,
          i.turno,
          n.id AS nivel_id,
          n.nombre AS nivel_nombre,
          c.id AS curso_id,
          c.nombre AS curso_nombre,
          b.id AS bloque_id,
          b.descripcion AS bloque_nombre
        FROM pagos_mensuales pm
        JOIN compromiso_economico ce ON ce.id = pm.id_compromiso
        JOIN estudiantes e ON e.id = ce.id_estudiante
        LEFT JOIN inscripciones i ON i.id = ce.inscripcion_id
        LEFT JOIN nivel n ON n.id = i.nivel_id
        LEFT JOIN curso c ON c.id = i.curso_id
        LEFT JOIN bloque b ON b.id = i.bloque_id
        WHERE ${condiciones.join(' AND ')}
        ORDER BY pm.mes ASC, b.descripcion ASC, n.nombre ASC, e.apellido_paterno ASC
      `;

      // No imprimir SQL/params por defecto (pueden incluir filtros y datos).
      debugLog('[Dashboard Pagos] Query SQL:', query);
      debugLog('[Dashboard Pagos] Params:', params);

      const [rows] = await pool.query(query, params);

      debugLog('[Dashboard Pagos] Registros encontrados en BD:', rows.length);

      // ==========================================
      // AUTOMATIZACION DE CALCULOS ECONOMICOS
      // Entrada de datos:
      // - pagos_mensuales: monto_esperado, monto_pagado, estado, fecha_vencimiento
      // - compromiso_economico/estudiantes/inscripciones: contexto academico
      // Proceso:
      // 1) saldo_pendiente = max(0, monto_esperado - monto_pagado)
      // 2) estado:
      //    - pagado  : saldo <= 0.05
      //    - parcial : pago > 0 y saldo > 0.05
      //    - pendiente/vencido: segun fecha_vencimiento
      // 3) dias_atraso:
      //    - si fecha_vencimiento < hoy y existe saldo, se calcula diferencia en dias
      // Salida:
      // - dataset de deudores listo para dashboard y reportes operativos.
      // ==========================================
      const hoyISO = new Date();
      const registrosProcesados = rows.map((row) => {
        const montoEsperado = numeroSeguro(row.monto_esperado);
        const montoPagado = numeroSeguro(row.monto_pagado);
        const saldoPendiente = Math.max(0, Number((montoEsperado - montoPagado).toFixed(2)));

        let estado = (row.estado || 'pendiente').toLowerCase();
        if (saldoPendiente <= 0.05) {
          estado = 'pagado';
        } else if (estado === 'pagado' && saldoPendiente > 0.05) {
          estado = 'parcial';
        } else if (montoPagado > 0 && montoPagado < montoEsperado) {
          estado = 'parcial';
        }

        let diasAtraso = 0;
        if (row.fecha_vencimiento && saldoPendiente > 0) {
          const fechaVencimiento = new Date(row.fecha_vencimiento);
          const diffMs = hoyISO - fechaVencimiento;
          if (diffMs > 0) {
            diasAtraso = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            estado = 'vencido';
          }
        }

        // Si no se incluyen pagados, filtrar los pagados
        // Un pago está completamente pagado si saldoPendiente <= 0.05
        if (!incluirPagados && saldoPendiente <= 0.05) {
          return null;
        }

        const mesNombre = row.nombre_mes || obtenerNombreMes(row.mes);
        const tutor = primerDatoDisponible(row.nombre_padre, row.nombre_madre, 'tutor/a');
        const telefonoReferencia = row.telefono_domicilio_padre || row.telefono_domicilio_madre || '';

        // Solo construir mensaje si hay saldo pendiente
        const mensaje = saldoPendiente > 0.05 
          ? construirMensaje({
              tutor,
              estudiante: `${row.nombre} ${row.apellido_paterno || ''} ${row.apellido_materno || ''}`.trim(),
              mesNombre,
              saldoPendiente,
              anio: row.anio
            })
          : '';

        return {
          pago_id: row.id,
          compromiso_id: row.id_compromiso,
          estudiante_id: row.id_estudiante,
          estudiante: `${row.nombre} ${row.apellido_paterno || ''} ${row.apellido_materno || ''}`.trim(),
          nivel_id: row.nivel_id,
          nivel_nombre: row.nivel_nombre || 'Sin nivel',
          curso_id: row.curso_id,
          curso_nombre: row.curso_nombre || 'Sin curso',
          bloque_id: row.bloque_id,
          bloque_nombre: row.bloque_nombre || 'Sin bloque',
          turno: row.turno || 'Sin turno',
          mes: row.mes,
          mes_nombre: mesNombre,
          anio: row.anio,
          monto_esperado: montoEsperado,
          monto_pagado: montoPagado,
          saldo_pendiente: saldoPendiente,
          estado,
          fecha_vencimiento: row.fecha_vencimiento,
          dias_atraso: diasAtraso,
          tutor,
          telefono_referencia: telefonoReferencia,
          mensaje_recordatorio: mensaje
        };
      }).filter(Boolean);

      const datasetFiltrado =
        estadoFiltro === 'todos'
          ? registrosProcesados
          : registrosProcesados.filter((item) => item.estado === estadoFiltro);

      // ==========================================
      // TOTALES Y PORCENTAJES DEL DASHBOARD
      // - total_esperado : suma de montos esperados del conjunto filtrado
      // - total_pagado   : suma de montos pagados (o consulta extendida si incluir_pagados=true)
      // - total_pendiente: suma de saldos pendientes
      // - total_vencido  : suma de saldos con estado "vencido"
      // - porcentaje_pagado = (total_pagado / total_esperado) * 100
      // Estos indicadores se calculan en backend para evitar calculo manual en frontend.
      // ==========================================
      // Si se incluyen pagados, calcular el total_pagado de todos los pagos pagados del mes/año
      let totalPagadoCalculado = 0;
      if (incluirPagados) {
        const condicionesPagados = ['pm.anio = ?', "pm.estado = 'pagado'", 'COALESCE(pm.monto_pagado, 0) >= COALESCE(pm.monto_esperado, 0)'];
        const paramsPagados = [anio];
        
        if (mesFiltrado) {
          condicionesPagados.push('pm.mes = ?');
          paramsPagados.push(mesFiltrado);
        }
        
        if (bloqueId) {
          condicionesPagados.push('b.id = ?');
          paramsPagados.push(bloqueId);
        }
        
        if (nivelId) {
          condicionesPagados.push('n.id = ?');
          paramsPagados.push(nivelId);
        }
        
        if (cursoId) {
          condicionesPagados.push('c.id = ?');
          paramsPagados.push(cursoId);
        }

        const queryPagados = `
          SELECT COALESCE(SUM(pm.monto_pagado), 0) as total_pagado
          FROM pagos_mensuales pm
          JOIN compromiso_economico ce ON ce.id = pm.id_compromiso
          JOIN estudiantes e ON e.id = ce.id_estudiante
          LEFT JOIN inscripciones i ON i.id = ce.inscripcion_id
          LEFT JOIN nivel n ON n.id = i.nivel_id
          LEFT JOIN curso c ON c.id = i.curso_id
          LEFT JOIN bloque b ON b.id = i.bloque_id
          WHERE ${condicionesPagados.join(' AND ')}
        `;
        
        const [rowsPagados] = await pool.query(queryPagados, paramsPagados);
        totalPagadoCalculado = numeroSeguro(rowsPagados[0]?.total_pagado || 0);
      }

      const totalCuotas = datasetFiltrado.length;
      const totalEsperado = datasetFiltrado.reduce((acc, item) => acc + item.monto_esperado, 0);
      const totalPagado = incluirPagados && totalPagadoCalculado > 0 
        ? totalPagadoCalculado 
        : datasetFiltrado.reduce((acc, item) => acc + item.monto_pagado, 0);
      const totalPendiente = datasetFiltrado.reduce((acc, item) => acc + item.saldo_pendiente, 0);
      const totalVencido = datasetFiltrado
        .filter((item) => item.estado === 'vencido')
        .reduce((acc, item) => acc + item.saldo_pendiente, 0);
      const estudiantesConDeuda = new Set(datasetFiltrado.map((item) => item.estudiante_id)).size;
      
      // Calcular total esperado incluyendo pagados si es necesario
      let totalEsperadoCompleto = totalEsperado;
      if (incluirPagados && totalPagadoCalculado > 0) {
        // Sumar el monto esperado de los pagados también
        const condicionesEsperado = ['pm.anio = ?'];
        const paramsEsperado = [anio];
        
        if (mesFiltrado) {
          condicionesEsperado.push('pm.mes = ?');
          paramsEsperado.push(mesFiltrado);
        }
        
        if (bloqueId) {
          condicionesEsperado.push('b.id = ?');
          paramsEsperado.push(bloqueId);
        }
        
        if (nivelId) {
          condicionesEsperado.push('n.id = ?');
          paramsEsperado.push(nivelId);
        }
        
        if (cursoId) {
          condicionesEsperado.push('c.id = ?');
          paramsEsperado.push(cursoId);
        }

        const queryEsperado = `
          SELECT COALESCE(SUM(pm.monto_esperado), 0) as total_esperado
          FROM pagos_mensuales pm
          JOIN compromiso_economico ce ON ce.id = pm.id_compromiso
          JOIN estudiantes e ON e.id = ce.id_estudiante
          LEFT JOIN inscripciones i ON i.id = ce.inscripcion_id
          LEFT JOIN nivel n ON n.id = i.nivel_id
          LEFT JOIN curso c ON c.id = i.curso_id
          LEFT JOIN bloque b ON b.id = i.bloque_id
          WHERE ${condicionesEsperado.join(' AND ')}
        `;
        
        const [rowsEsperado] = await pool.query(queryEsperado, paramsEsperado);
        totalEsperadoCompleto = numeroSeguro(rowsEsperado[0]?.total_esperado || 0);
      }
      
      const porcentajePagado =
        totalEsperadoCompleto > 0 ? Math.round((totalPagado / totalEsperadoCompleto) * 100) : 0;

      const resumen = {
        anio,
        mes: mesFiltrado || 'todos',
        mes_nombre: mesFiltrado ? obtenerNombreMes(mesFiltrado) : 'Todos',
        total_cuotas: totalCuotas,
        total_esperado: Number(totalEsperadoCompleto.toFixed(2)),
        total_pagado: Number(totalPagado.toFixed(2)),
        total_pendiente: Number(totalPendiente.toFixed(2)),
        total_vencido: Number(totalVencido.toFixed(2)),
        estudiantes_con_deuda: estudiantesConDeuda,
        porcentaje_pagado: porcentajePagado
      };

      const rankingBloques = construirRanking(datasetFiltrado, 'bloque_id', 'bloque_nombre');
      const rankingNiveles = construirRanking(datasetFiltrado, 'nivel_id', 'nivel_nombre');
      const rankingCursos = construirRanking(datasetFiltrado, 'curso_id', 'curso_nombre');

      res.json({
        ok: true,
        filtros: {
          anio,
          mes: mesFiltrado ?? 'todos',
          estado: estadoFiltro,
          bloque_id: bloqueId,
          nivel_id: nivelId,
          curso_id: cursoId
        },
        resumen,
        ranking: {
          bloques: rankingBloques,
          niveles: rankingNiveles,
          cursos: rankingCursos
        },
        deudores: datasetFiltrado,
        total_registros: datasetFiltrado.length
      });
    } catch (error) {
      console.error('Error al obtener deudores del dashboard:', error);
      res.status(500).json({
        ok: false,
        message: 'Error al obtener la información de pagos pendientes',
        error: error.message
      });
    }
  });
}

module.exports = { configurarRutasDashboardPagos };


