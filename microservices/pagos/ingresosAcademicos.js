// ===== MÓDULO DE INGRESOS ACADÉMICOS =====

function configurarRutasIngresosAcademicos(app, pool, authMiddleware) {
  // ===== ENDPOINTS PARA INGRESOS ACADÉMICOS =====

  // ------------------------------------------------------------
  // FUNCION: /api/ingresos-academicos
  // Entradas (req.query):
  // - fechaInicio, fechaFin
  // Como calcula:
  // - Une pagos de cuotas/material (pagos_realizados) con ingresos por servicios.
  // - total = suma de todos los montos del periodo.
  // - totalesPorForma = acumulado por metodo de pago (efectivo, transferencia, etc.).
  // Salida:
  // - Consolidado de ingresos academicos y resumen financiero por forma de pago.
  // ------------------------------------------------------------
  // Endpoint para obtener ingresos académicos (pagos de compromisos y servicios pagados)
  app.get('/api/ingresos-academicos', authMiddleware, async (req, res) => {
    try {
      const { fechaInicio, fechaFin } = req.query;

      // Pagos de mensualidades/material (pagos_realizados)
      let queryPagos = `
        SELECT 
          pr.id,
          pr.fecha_pago,
          pr.monto,
          pr.forma_pago,
          pr.detalle,
          pr.tipo_pago,
          pr.mes,
          pr.anio,
          pr.numero_comprobante,
          pr.nit_ci,
          e.nombre as estudiante_nombre, 
          e.apellido_paterno, 
          e.apellido_materno,
          e.ci_estudiante,
          ce.total_cuotas,
          ce.total_general,
          ce.estado_compromiso,
          b.descripcion as beca_descripcion,
          b.descuento as beca_descuento
        FROM pagos_realizados pr
        LEFT JOIN compromiso_economico ce ON pr.id_compromiso = ce.id
        LEFT JOIN estudiantes e ON ce.id_estudiante = e.id
        LEFT JOIN becas b ON ce.id_beca = b.id
        WHERE 1=1
      `;
      const paramsPagos = [];
      if (fechaInicio && fechaFin) {
        queryPagos += ' AND pr.fecha_pago BETWEEN ? AND ?';
        paramsPagos.push(fechaInicio, fechaFin);
      }

      // Pagos de servicios (ingresos)
      let queryServicios = `
        SELECT 
          i.id,
          i.fecha as fecha_pago,
          i.monto,
          i.forma_pago,
          i.detalle,
          'servicio' as tipo_pago,
          NULL as mes,
          NULL as anio,
          i.numero_comprobante,
          i.nit_ci,
          e.nombre as estudiante_nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          NULL as total_cuotas,
          NULL as total_general,
          NULL as estado_compromiso,
          NULL as beca_descripcion,
          NULL as beca_descuento,
          s.descripcion AS servicio_nombre
        FROM ingresos i
        LEFT JOIN estudiantes e ON i.estudiante_id = e.id
        LEFT JOIN servicios_estudiante se ON i.detalle = CONCAT('servicio:', se.id)
        LEFT JOIN servicios s ON se.servicio_id = s.id
        WHERE i.tipo = 'servicios_estudiante'
      `;
      const paramsServicios = [];
      if (fechaInicio && fechaFin) {
        queryServicios += ' AND DATE(i.fecha) BETWEEN DATE(?) AND DATE(?)';
        paramsServicios.push(fechaInicio, fechaFin);
      }

      const [rowsPagos] = await pool.query(queryPagos + ' ORDER BY pr.fecha_pago DESC', paramsPagos);
      const [rowsServicios] = await pool.query(queryServicios + ' ORDER BY i.fecha DESC', paramsServicios);

      // Combinar y ordenar por fecha desc
      const rowsCombined = [...rowsPagos, ...rowsServicios].sort((a, b) => {
        const fa = new Date(a.fecha_pago).getTime();
        const fb = new Date(b.fecha_pago).getTime();
        return fb - fa;
      });

      // Totales
      // ==========================================
      // CONSOLIDACION DE INGRESOS ACADEMICOS
      // Entrada:
      // - pagos_realizados (cuotas/material)
      // - ingresos (servicios_estudiante)
      // Calculos:
      // - total general = suma de todos los montos combinados
      // - totalesPorForma[forma_pago] = acumulado por metodo de pago
      // Salida:
      // - reporte financiero consolidado para panel de ingresos.
      // ==========================================
      const total = rowsCombined.reduce((acc, curr) => acc + Number(curr.monto || 0), 0);
      const totalesPorForma = {};
      rowsCombined.forEach(r => {
        const forma = (r.forma_pago || 'otro').toLowerCase();
        if (!totalesPorForma[forma]) totalesPorForma[forma] = 0;
        totalesPorForma[forma] += Number(r.monto || 0);
      });

      // Formatear respuesta para frontend
      const ingresos = rowsCombined.map(r => ({
        id: r.id,
        fecha: r.fecha_pago,
        monto: r.monto,
        forma_pago: r.forma_pago,
        detalle: r.detalle,
        tipo_pago: r.tipo_pago, // 'cuota' | 'material' | 'ambos' | 'servicio'
        mes: r.mes,
        anio: r.anio,
        numero_comprobante: r.numero_comprobante,
        nit_ci: r.nit_ci,
        estudiante_nombre: r.estudiante_nombre ? `${r.estudiante_nombre} ${r.apellido_paterno || ''} ${r.apellido_materno || ''}`.trim() : 'Sin asignar',
        ci_estudiante: r.ci_estudiante,
        beca_descripcion: r.beca_descripcion,
        beca_descuento: r.beca_descuento,
        total_compromiso: r.total_general,
        observacion: r.observacion,
        servicio_nombre: r.servicio_nombre || null
      }));

      res.json({ ingresos, total, totalesPorForma });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener ingresos académicos', error: error.message });
    }
  });

  // Log silenciado
}

module.exports = { configurarRutasIngresosAcademicos };

