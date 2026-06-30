// ===== MÓDULO DE ANÁLISIS AUTÓNOMO DEL AGENTE INTELIGENTE =====
// Este módulo permite al agente analizar datos, detectar patrones y actuar de forma autónoma

const pool = require('./config');
const { obtenerInstancia } = require('./whatsappServiceSingleton');
const NotificacionesService = require('./notificacionesService');

class AnalisisAutonomo {
  constructor() {
    this.pool = pool;
    this.whatsappService = obtenerInstancia();
    this.notificacionesService = null;
  }

  // Inicializar servicio de notificaciones
  async inicializarNotificaciones() {
    if (!this.notificacionesService) {
      this.notificacionesService = new NotificacionesService(this.whatsappService);
    }
  }

  // ===== 1. DETECCIÓN Y ALERTA DE PAGOS ATRASADOS =====
  async detectarPagosAtrasados() {
    try {
      console.log('🔍 Iniciando detección de pagos atrasados...');

      const hoy = new Date();
      const fechaHoy = hoy.toISOString().split('T')[0];

      // ✅ ACTUALIZADO: Obtener pagos vencidos con contacto verificado
      const [pagosVencidos] = await this.pool.query(`
        SELECT 
          e.id as estudiante_id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          ca.telefono,
          ca.nombre_contacto as tutor_name,
          ce.id as compromiso_id,
          COUNT(pm.id) as total_pagos_vencidos,
          SUM(pm.monto_pendiente) as total_deuda,
          MIN(pm.fecha_vencimiento) as primer_vencimiento,
          MAX(pm.fecha_vencimiento) as ultimo_vencimiento,
          DATEDIFF(?, MIN(pm.fecha_vencimiento)) as dias_vencido
        FROM pagos_mensuales pm
        JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
        JOIN estudiantes e ON ce.id_estudiante = e.id
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
        WHERE pm.estado IN ('pendiente', 'parcial')
          AND pm.fecha_vencimiento < ?
          AND ce.estado_compromiso = 'activo'
          AND e.estado_id = 1
        GROUP BY e.id, ce.id, ca.id
        ORDER BY dias_vencido DESC, total_deuda DESC
      `, [fechaHoy, fechaHoy]);

      console.log(`📊 Encontrados ${pagosVencidos.length} estudiantes con pagos atrasados`);

      const alertas = [];
      const notificacionesEnviadas = [];

      for (const estudiante of pagosVencidos) {
        const diasVencido = estudiante.dias_vencido;
        const totalDeuda = parseFloat(estudiante.total_deuda);
        const nombreCompleto = `${estudiante.nombre} ${estudiante.apellido_paterno} ${estudiante.apellido_materno || ''}`.trim();

        // Determinar severidad y tipo de recordatorio
        let tipoAlerta = 'baja';
        let mensaje = '';
        let enviarNotificacion = false;

        if (diasVencido >= 7) {
          tipoAlerta = 'critica';
          mensaje = `⚠️ URGENTE: ${nombreCompleto} tiene ${estudiante.total_pagos_vencidos} pago(s) vencido(s) hace ${diasVencido} días. Deuda total: Bs ${totalDeuda.toFixed(2)}`;
          enviarNotificacion = true;
        } else if (diasVencido >= 3) {
          tipoAlerta = 'alta';
          mensaje = `⚠️ ${nombreCompleto} tiene ${estudiante.total_pagos_vencidos} pago(s) vencido(s) hace ${diasVencido} días. Deuda: Bs ${totalDeuda.toFixed(2)}`;
          enviarNotificacion = true;
        } else {
          tipoAlerta = 'media';
          mensaje = `ℹ️ ${nombreCompleto} tiene ${estudiante.total_pagos_vencidos} pago(s) recientemente vencido(s). Deuda: Bs ${totalDeuda.toFixed(2)}`;
        }

        // Guardar alerta en base de datos (actualizar si ya existe una alerta pendiente del mismo tipo)
        const [alertasExistentes] = await this.pool.query(`
          SELECT id FROM alertas_sistema
          WHERE tipo_alerta = ? AND estudiante_id = ? AND estado = 'pendiente'
          LIMIT 1
        `, ['pago_atrasado', estudiante.estudiante_id]);

        if (alertasExistentes.length > 0) {
          await this.pool.query(`
            UPDATE alertas_sistema
            SET severidad = ?,
                descripcion = ?,
                fecha_deteccion = NOW(),
                datos_adicionales = ?
            WHERE id = ?
          `, [
            tipoAlerta,
            mensaje,
            JSON.stringify({
              total_pagos_vencidos: estudiante.total_pagos_vencidos,
              total_deuda: totalDeuda,
              dias_vencido: diasVencido,
              primer_vencimiento: estudiante.primer_vencimiento,
              ultimo_vencimiento: estudiante.ultimo_vencimiento
            }),
            alertasExistentes[0].id
          ]);
        } else {
          await this.pool.query(`
            INSERT INTO alertas_sistema (
              tipo_alerta, severidad, descripcion, estudiante_id, 
              fecha_deteccion, estado, datos_adicionales
            ) VALUES (?, ?, ?, ?, NOW(), 'pendiente', ?)
          `, [
            'pago_atrasado',
            tipoAlerta,
            mensaje,
            estudiante.estudiante_id,
            JSON.stringify({
              total_pagos_vencidos: estudiante.total_pagos_vencidos,
              total_deuda: totalDeuda,
              dias_vencido: diasVencido,
              primer_vencimiento: estudiante.primer_vencimiento,
              ultimo_vencimiento: estudiante.ultimo_vencimiento
            })
          ]);
        }

        alertas.push({
          estudiante_id: estudiante.estudiante_id,
          nombre: nombreCompleto,
          tipo: 'pago_atrasado',
          severidad: tipoAlerta,
          mensaje: mensaje,
          datos: {
            total_pagos_vencidos: estudiante.total_pagos_vencidos,
            total_deuda: totalDeuda,
            dias_vencido: diasVencido
          }
        });

        // Enviar notificación automática si corresponde
        if (enviarNotificacion && await this.whatsappService?.isClientReady()) {
          try {
            await this.inicializarNotificaciones();

            const telefono = estudiante.telefono;
            if (telefono && this.whatsappService.client) {
              const mensajeWhatsApp = `🔔 *Recordatorio de Pago*\n\n` +
                `Estimado/a ${estudiante.tutor_name || 'tutor/a'},\n\n` +
                `Le recordamos que ${nombreCompleto} tiene ${estudiante.total_pagos_vencidos} pago(s) vencido(s).\n\n` +
                `💰 *Deuda total: Bs ${totalDeuda.toFixed(2)}*\n` +
                `📅 Vencido hace: ${diasVencido} día(s)\n\n` +
                `Por favor, acérquese a la institución para regularizar su situación.\n\n` +
                `Gracias por su atención.`;

              await this.whatsappService.client.sendMessage(telefono, mensajeWhatsApp);

              // Registrar notificación enviada
              await this.pool.query(`
                INSERT INTO notificaciones_enviadas (
                  estudiante_id, tipo_notificacion, fecha_envio, estado, mensaje
                ) VALUES (?, ?, NOW(), 'enviada', ?)
              `, [estudiante.estudiante_id, 'pago_atrasado', mensajeWhatsApp]);

              notificacionesEnviadas.push({
                estudiante_id: estudiante.estudiante_id,
                nombre: nombreCompleto,
                telefono: telefono
              });

              console.log(`✅ Notificación enviada a ${nombreCompleto} (${telefono})`);
            }
          } catch (error) {
            console.error(`❌ Error enviando notificación a ${nombreCompleto}:`, error.message);
          }
        }
      }

      return {
        ok: true,
        total_estudiantes: pagosVencidos.length,
        alertas_generadas: alertas.length,
        notificaciones_enviadas: notificacionesEnviadas.length,
        alertas: alertas,
        notificaciones: notificacionesEnviadas
      };
    } catch (error) {
      console.error('❌ Error en detección de pagos atrasados:', error);
      return { ok: false, error: error.message };
    }
  }

  // ===== 2. SUGERENCIAS PROACTIVAS DE BECAS =====
  async sugerirBecas() {
    try {
      console.log('🔍 Analizando candidatos para becas...');

      // Identificar estudiantes con múltiples pagos atrasados
      const [candidatos] = await this.pool.query(`
        SELECT 
          e.id as estudiante_id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          ce.id as compromiso_id,
          ce.id_beca as beca_actual,
          COUNT(pm.id) as total_pagos_vencidos,
          SUM(pm.monto_pendiente) as total_deuda,
          ce.total_general,
          (SUM(pm.monto_pendiente) / ce.total_general * 100) as porcentaje_morosidad,
          DATEDIFF(CURDATE(), MIN(pm.fecha_vencimiento)) as dias_morosidad_maxima
        FROM estudiantes e
        JOIN compromiso_economico ce ON e.id = ce.id_estudiante
        JOIN pagos_mensuales pm ON ce.id = pm.id_compromiso
        WHERE pm.estado IN ('pendiente', 'parcial')
          AND pm.fecha_vencimiento < CURDATE()
          AND ce.estado_compromiso = 'activo'
          AND e.estado_id = 1
          AND (ce.id_beca IS NULL OR ce.id_beca = 0)
        GROUP BY e.id, ce.id
        HAVING total_pagos_vencidos >= 3
          AND porcentaje_morosidad >= 50
          AND dias_morosidad_maxima >= 30
        ORDER BY porcentaje_morosidad DESC, total_pagos_vencidos DESC
      `);

      console.log(`📊 Encontrados ${candidatos.length} candidatos para becas`);

      const sugerencias = [];

      for (const candidato of candidatos) {
        const nombreCompleto = `${candidato.nombre} ${candidato.apellido_paterno} ${candidato.apellido_materno || ''}`.trim();
        const porcentajeMorosidad = parseFloat(candidato.porcentaje_morosidad);
        const totalDeuda = parseFloat(candidato.total_deuda);

        // Calcular porcentaje de beca sugerido
        let porcentajeBecaSugerido = 0;
        if (porcentajeMorosidad >= 80) {
          porcentajeBecaSugerido = 50; // Beca alta
        } else if (porcentajeMorosidad >= 60) {
          porcentajeBecaSugerido = 30; // Beca media
        } else {
          porcentajeBecaSugerido = 20; // Beca baja
        }

        const mensaje = `💡 *Sugerencia de Beca*\n\n` +
          `El estudiante ${nombreCompleto} presenta dificultades económicas:\n\n` +
          `📊 *Indicadores:*\n` +
          `• Pagos vencidos: ${candidato.total_pagos_vencidos}\n` +
          `• Morosidad: ${porcentajeMorosidad.toFixed(1)}%\n` +
          `• Deuda total: Bs ${totalDeuda.toFixed(2)}\n` +
          `• Días de morosidad: ${candidato.dias_morosidad_maxima}\n\n` +
          `💡 *Recomendación:* Aplicar beca del ${porcentajeBecaSugerido}%\n\n` +
          `Esto ayudaría a mejorar la retención del estudiante.`;

        // Guardar sugerencia
        await this.pool.query(`
          INSERT INTO sugerencias_becas (
            estudiante_id, compromiso_id, porcentaje_morosidad, 
            total_pagos_vencidos, total_deuda, porcentaje_beca_sugerido,
            fecha_sugerencia, estado, razon
          ) VALUES (?, ?, ?, ?, ?, ?, NOW(), 'pendiente', ?)
        `, [
          candidato.estudiante_id,
          candidato.compromiso_id,
          porcentajeMorosidad,
          candidato.total_pagos_vencidos,
          totalDeuda,
          porcentajeBecaSugerido,
          `Estudiante con ${candidato.total_pagos_vencidos} pagos vencidos y ${porcentajeMorosidad.toFixed(1)}% de morosidad`
        ]);

        sugerencias.push({
          estudiante_id: candidato.estudiante_id,
          nombre: nombreCompleto,
          porcentaje_morosidad: porcentajeMorosidad,
          total_pagos_vencidos: candidato.total_pagos_vencidos,
          total_deuda: totalDeuda,
          porcentaje_beca_sugerido: porcentajeBecaSugerido,
          mensaje: mensaje
        });
      }

      return {
        ok: true,
        total_candidatos: candidatos.length,
        sugerencias: sugerencias
      };
    } catch (error) {
      console.error('❌ Error en sugerencias de becas:', error);
      return { ok: false, error: error.message };
    }
  }

  // ===== 4. RECORDATORIOS DE INSCRIPCIÓN PARA NUEVO AÑO =====
  async recordatoriosInscripcion() {
    try {
      console.log('🔍 Verificando recordatorios de inscripción...');

      const hoy = new Date();
      const anioActual = hoy.getFullYear();
      const anioSiguiente = anioActual + 1;
      const diasRestantes = Math.ceil((new Date(anioSiguiente, 0, 1) - hoy) / (1000 * 60 * 60 * 24));

      // ✅ ACTUALIZADO: Obtener estudiantes sin renovar con contacto verificado
      const [estudiantesSinRenovar] = await this.pool.query(`
        SELECT DISTINCT
          e.id as estudiante_id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          ca.telefono,
          ca.nombre_contacto as tutor_name,
          i_actual.id as inscripcion_actual_id,
          i_actual.gestion_academica as gestion_actual,
          n.nombre as nivel_actual,
          c.nombre as curso_actual
        FROM estudiantes e
        JOIN inscripciones i_actual ON e.id = i_actual.estudiante_id
        LEFT JOIN nivel n ON i_actual.nivel_id = n.id
        LEFT JOIN curso c ON i_actual.curso_id = c.id
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
        LEFT JOIN inscripciones i_siguiente ON e.id = i_siguiente.estudiante_id 
          AND i_siguiente.gestion_academica = ?
          AND i_siguiente.estado = 'activo'
        WHERE i_actual.estado = 'activo'
          AND i_actual.gestion_academica = ?
          AND i_siguiente.id IS NULL
          AND e.estado_id = 1
        ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre
      `, [anioSiguiente, anioActual]);

      console.log(`📊 Encontrados ${estudiantesSinRenovar.length} estudiantes sin renovar inscripción`);

      const recordatorios = [];
      const notificacionesEnviadas = [];

      for (const estudiante of estudiantesSinRenovar) {
        const nombreCompleto = `${estudiante.nombre} ${estudiante.apellido_paterno} ${estudiante.apellido_materno || ''}`.trim();

        let tipoRecordatorio = '';
        let mensaje = '';
        let enviarNotificacion = false;

        if (diasRestantes <= 7) {
          tipoRecordatorio = 'urgente';
          mensaje = `🚨 URGENTE: ${nombreCompleto} no ha renovado su inscripción para ${anioSiguiente}. Faltan ${diasRestantes} días.`;
          enviarNotificacion = true;
        } else if (diasRestantes <= 15) {
          tipoRecordatorio = 'importante';
          mensaje = `⚠️ ${nombreCompleto} no ha renovado su inscripción para ${anioSiguiente}. Faltan ${diasRestantes} días.`;
          enviarNotificacion = true;
        } else if (diasRestantes <= 30) {
          tipoRecordatorio = 'recordatorio';
          mensaje = `ℹ️ ${nombreCompleto} aún no ha renovado su inscripción para ${anioSiguiente}. Faltan ${diasRestantes} días.`;
          enviarNotificacion = true;
        }

        if (mensaje) {
          // Guardar recordatorio
          await this.pool.query(`
            INSERT INTO recordatorios_inscripcion (
              estudiante_id, gestion_objetivo, dias_restantes,
              tipo_recordatorio, fecha_recordatorio, estado
            ) VALUES (?, ?, ?, ?, NOW(), 'pendiente')
          `, [
            estudiante.estudiante_id,
            anioSiguiente,
            diasRestantes,
            tipoRecordatorio
          ]);

          recordatorios.push({
            estudiante_id: estudiante.estudiante_id,
            nombre: nombreCompleto,
            tipo: tipoRecordatorio,
            dias_restantes: diasRestantes,
            mensaje: mensaje
          });

          // Enviar notificación si corresponde
          if (enviarNotificacion && await this.whatsappService?.isClientReady()) {
            try {
              const telefono = estudiante.telefono;
              if (telefono && this.whatsappService.client) {
                const mensajeWhatsApp = `🔔 *Recordatorio de Renovación de Inscripción*\n\n` +
                  `Estimado/a ${estudiante.tutor_name || 'tutor/a'},\n\n` +
                  `Le recordamos que ${nombreCompleto} aún no ha renovado su inscripción para el año ${anioSiguiente}.\n\n` +
                  `📅 *Faltan ${diasRestantes} días* para el inicio del nuevo año académico.\n\n` +
                  `Nivel actual: ${estudiante.nivel_actual || 'N/A'} - ${estudiante.curso_actual || 'N/A'}\n\n` +
                  `Por favor, acérquese a la institución para completar el proceso de renovación.\n\n` +
                  `Gracias por su atención.`;

                await this.whatsappService.client.sendMessage(telefono, mensajeWhatsApp);

                await this.pool.query(`
                  INSERT INTO notificaciones_enviadas (
                    estudiante_id, tipo_notificacion, fecha_envio, estado, mensaje
                  ) VALUES (?, ?, NOW(), 'enviada', ?)
                `, [estudiante.estudiante_id, 'recordatorio_inscripcion', mensajeWhatsApp]);

                notificacionesEnviadas.push({
                  estudiante_id: estudiante.estudiante_id,
                  nombre: nombreCompleto,
                  telefono: telefono
                });

                console.log(`✅ Recordatorio enviado a ${nombreCompleto} (${telefono})`);
              }
            } catch (error) {
              console.error(`❌ Error enviando recordatorio a ${nombreCompleto}:`, error.message);
            }
          }
        }
      }

      return {
        ok: true,
        total_estudiantes: estudiantesSinRenovar.length,
        recordatorios_generados: recordatorios.length,
        notificaciones_enviadas: notificacionesEnviadas.length,
        dias_restantes: diasRestantes,
        recordatorios: recordatorios,
        notificaciones: notificacionesEnviadas
      };
    } catch (error) {
      console.error('❌ Error en recordatorios de inscripción:', error);
      return { ok: false, error: error.message };
    }
  }

  // ===== 5. ANÁLISIS PREDICTIVO DE DESERCIÓN =====
  async analizarRiesgoDesercion() {
    try {
      console.log('🔍 Iniciando análisis predictivo de deserción...');

      // Obtener todos los estudiantes activos con sus indicadores
      const [estudiantes] = await this.pool.query(`
        SELECT 
          e.id as estudiante_id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          e.fecha_registro,
          -- Indicadores de morosidad
          (SELECT COUNT(*) FROM pagos_mensuales pm
           JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
           WHERE ce.id_estudiante = e.id
             AND pm.estado IN ('pendiente', 'parcial')
             AND pm.fecha_vencimiento < CURDATE()) as pagos_vencidos,
          (SELECT SUM(pm.monto_pendiente) FROM pagos_mensuales pm
           JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
           WHERE ce.id_estudiante = e.id
             AND pm.estado IN ('pendiente', 'parcial')) as deuda_total,
          -- Indicador de inscripción futura
          (SELECT COUNT(*) FROM inscripciones i
           WHERE i.estudiante_id = e.id
             AND i.gestion_academica = YEAR(CURDATE()) + 1
             AND i.estado = 'activo') as tiene_inscripcion_futura,
          -- Indicador de actividad reciente
          (SELECT MAX(pr.fecha_pago) FROM pagos_realizados pr
           JOIN compromiso_economico ce ON pr.id_compromiso = ce.id
           WHERE ce.id_estudiante = e.id) as ultimo_pago,
          -- Indicador de compromiso activo
          (SELECT COUNT(*) FROM compromiso_economico ce
           WHERE ce.id_estudiante = e.id
             AND ce.estado_compromiso = 'activo') as compromisos_activos
        FROM estudiantes e
        WHERE e.estado_id = 1
        HAVING compromisos_activos > 0
        ORDER BY pagos_vencidos DESC, deuda_total DESC
      `);

      console.log(`📊 Analizando ${estudiantes.length} estudiantes`);

      const analisis = [];

      for (const estudiante of estudiantes) {
        const pagosVencidos = parseInt(estudiante.pagos_vencidos) || 0;
        const deudaTotal = parseFloat(estudiante.deuda_total) || 0;
        const tieneInscripcionFutura = parseInt(estudiante.tiene_inscripcion_futura) > 0;
        const ultimoPago = estudiante.ultimo_pago ? new Date(estudiante.ultimo_pago) : null;
        const diasSinPago = ultimoPago ? Math.floor((new Date() - ultimoPago) / (1000 * 60 * 60 * 24)) : 999;

        // Calcular score de riesgo (0-100)
        let scoreRiesgo = 0;
        const factoresRiesgo = [];

        // Factor 1: Pagos vencidos (peso: 30%)
        if (pagosVencidos >= 5) {
          scoreRiesgo += 30;
          factoresRiesgo.push({ factor: 'pagos_vencidos', valor: pagosVencidos, impacto: 'alto' });
        } else if (pagosVencidos >= 3) {
          scoreRiesgo += 20;
          factoresRiesgo.push({ factor: 'pagos_vencidos', valor: pagosVencidos, impacto: 'medio' });
        } else if (pagosVencidos >= 1) {
          scoreRiesgo += 10;
          factoresRiesgo.push({ factor: 'pagos_vencidos', valor: pagosVencidos, impacto: 'bajo' });
        }

        // Factor 2: Sin inscripción futura (peso: 25%)
        if (!tieneInscripcionFutura) {
          scoreRiesgo += 25;
          factoresRiesgo.push({ factor: 'sin_inscripcion_futura', valor: true, impacto: 'alto' });
        }

        // Factor 3: Días sin pago (peso: 25%)
        if (diasSinPago >= 90) {
          scoreRiesgo += 25;
          factoresRiesgo.push({ factor: 'dias_sin_pago', valor: diasSinPago, impacto: 'alto' });
        } else if (diasSinPago >= 60) {
          scoreRiesgo += 15;
          factoresRiesgo.push({ factor: 'dias_sin_pago', valor: diasSinPago, impacto: 'medio' });
        } else if (diasSinPago >= 30) {
          scoreRiesgo += 10;
          factoresRiesgo.push({ factor: 'dias_sin_pago', valor: diasSinPago, impacto: 'bajo' });
        }

        // Factor 4: Deuda alta (peso: 20%)
        if (deudaTotal >= 2000) {
          scoreRiesgo += 20;
          factoresRiesgo.push({ factor: 'deuda_alta', valor: deudaTotal, impacto: 'alto' });
        } else if (deudaTotal >= 1000) {
          scoreRiesgo += 10;
          factoresRiesgo.push({ factor: 'deuda_alta', valor: deudaTotal, impacto: 'medio' });
        }

        // Determinar nivel de riesgo
        let nivelRiesgo = 'bajo';
        let recomendaciones = [];

        if (scoreRiesgo >= 70) {
          nivelRiesgo = 'critico';
          recomendaciones = [
            'Contactar inmediatamente al tutor/padre',
            'Evaluar aplicación de beca urgente',
            'Ofrecer plan de pago flexible',
            'Programar reunión con familia'
          ];
        } else if (scoreRiesgo >= 50) {
          nivelRiesgo = 'alto';
          recomendaciones = [
            'Enviar recordatorio de pagos pendientes',
            'Evaluar posibilidad de beca',
            'Contactar al tutor para conocer situación'
          ];
        } else if (scoreRiesgo >= 30) {
          nivelRiesgo = 'medio';
          recomendaciones = [
            'Monitorear de cerca los pagos',
            'Enviar recordatorios preventivos',
            'Verificar situación familiar'
          ];
        } else {
          nivelRiesgo = 'bajo';
          recomendaciones = [
            'Monitoreo rutinario',
            'Mantener comunicación regular'
          ];
        }

        const nombreCompleto = `${estudiante.nombre} ${estudiante.apellido_paterno} ${estudiante.apellido_materno || ''}`.trim();

        // Guardar análisis
        await this.pool.query(`
          INSERT INTO analisis_desercion (
            estudiante_id, score_riesgo, nivel_riesgo, factores_riesgo,
            recomendaciones, fecha_analisis
          ) VALUES (?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            score_riesgo = VALUES(score_riesgo),
            nivel_riesgo = VALUES(nivel_riesgo),
            factores_riesgo = VALUES(factores_riesgo),
            recomendaciones = VALUES(recomendaciones),
            fecha_analisis = NOW()
        `, [
          estudiante.estudiante_id,
          scoreRiesgo,
          nivelRiesgo,
          JSON.stringify(factoresRiesgo),
          JSON.stringify(recomendaciones)
        ]);

        // Crear alerta si el riesgo es alto o crítico
        if (scoreRiesgo >= 50) {
          const [alertasExistentes] = await this.pool.query(`
            SELECT id FROM alertas_sistema
            WHERE tipo_alerta = 'riesgo_desercion' AND estudiante_id = ? AND estado = 'pendiente'
            LIMIT 1
          `, [estudiante.estudiante_id]);

          if (alertasExistentes.length > 0) {
            await this.pool.query(`
              UPDATE alertas_sistema
              SET severidad = ?,
                  descripcion = ?,
                  fecha_deteccion = NOW(),
                  datos_adicionales = ?
              WHERE id = ?
            `, [
              nivelRiesgo === 'critico' ? 'critica' : 'alta',
              `⚠️ ${nombreCompleto} presenta riesgo ${nivelRiesgo} de deserción (Score: ${scoreRiesgo}/100)`,
              JSON.stringify({
                score_riesgo: scoreRiesgo,
                nivel_riesgo: nivelRiesgo,
                factores_riesgo: factoresRiesgo,
                recomendaciones: recomendaciones
              }),
              alertasExistentes[0].id
            ]);
          } else {
            await this.pool.query(`
              INSERT INTO alertas_sistema (
                tipo_alerta, severidad, descripcion, estudiante_id,
                fecha_deteccion, estado, datos_adicionales
              ) VALUES (?, ?, ?, ?, NOW(), 'pendiente', ?)
            `, [
              'riesgo_desercion',
              nivelRiesgo === 'critico' ? 'critica' : 'alta',
              `⚠️ ${nombreCompleto} presenta riesgo ${nivelRiesgo} de deserción (Score: ${scoreRiesgo}/100)`,
              estudiante.estudiante_id,
              JSON.stringify({
                score_riesgo: scoreRiesgo,
                nivel_riesgo: nivelRiesgo,
                factores_riesgo: factoresRiesgo,
                recomendaciones: recomendaciones
              })
            ]);
          }
        }

        analisis.push({
          estudiante_id: estudiante.estudiante_id,
          nombre: nombreCompleto,
          score_riesgo: scoreRiesgo,
          nivel_riesgo: nivelRiesgo,
          factores_riesgo: factoresRiesgo,
          recomendaciones: recomendaciones,
          indicadores: {
            pagos_vencidos: pagosVencidos,
            deuda_total: deudaTotal,
            tiene_inscripcion_futura: tieneInscripcionFutura,
            dias_sin_pago: diasSinPago
          }
        });
      }

      // Ordenar por score de riesgo descendente
      analisis.sort((a, b) => b.score_riesgo - a.score_riesgo);

      return {
        ok: true,
        total_estudiantes: estudiantes.length,
        analisis_realizados: analisis.length,
        estudiantes_alto_riesgo: analisis.filter(a => a.score_riesgo >= 50).length,
        estudiantes_critico_riesgo: analisis.filter(a => a.score_riesgo >= 70).length,
        analisis: analisis
      };
    } catch (error) {
      console.error('❌ Error en análisis de deserción:', error);
      return { ok: false, error: error.message };
    }
  }

  // ===== 6. GENERACIÓN AUTOMÁTICA DE REPORTES INTELIGENTES =====
  async generarReporteInteligente(tipo = 'diario') {
    try {
      console.log(`📊 Generando reporte ${tipo}...`);

      const hoy = new Date();
      let fechaInicio, fechaFin, titulo;

      switch (tipo) {
        case 'diario':
          fechaInicio = new Date(hoy);
          fechaFin = new Date(hoy);
          titulo = `Reporte Diario - ${hoy.toLocaleDateString('es-ES')}`;
          break;
        case 'semanal':
          const inicioSemana = new Date(hoy);
          inicioSemana.setDate(hoy.getDate() - hoy.getDay());
          fechaInicio = inicioSemana;
          fechaFin = new Date(inicioSemana);
          fechaFin.setDate(inicioSemana.getDate() + 6);
          titulo = `Reporte Semanal - ${fechaInicio.toLocaleDateString('es-ES')} a ${fechaFin.toLocaleDateString('es-ES')}`;
          break;
        case 'mensual':
          fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
          fechaFin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
          titulo = `Reporte Mensual - ${fechaInicio.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}`;
          break;
        default:
          fechaInicio = new Date(hoy);
          fechaFin = new Date(hoy);
          titulo = `Reporte - ${hoy.toLocaleDateString('es-ES')}`;
      }

      const fechaInicioStr = fechaInicio.toISOString().split('T')[0];
      const fechaFinStr = fechaFin.toISOString().split('T')[0];

      // Obtener estadísticas de ingresos
      const [ingresos] = await this.pool.query(`
        SELECT 
          SUM(monto) as total_ingresos,
          COUNT(*) as total_pagos,
          AVG(monto) as promedio_pago,
          forma_pago,
          COUNT(*) as cantidad_por_forma
        FROM pagos_realizados
        WHERE fecha_pago BETWEEN ? AND ?
        GROUP BY forma_pago
      `, [fechaInicioStr, fechaFinStr]);

      // Obtener estadísticas de morosidad
      const [morosidad] = await this.pool.query(`
        SELECT 
          COUNT(DISTINCT e.id) as estudiantes_con_deuda,
          SUM(pm.monto_pendiente) as deuda_total,
          COUNT(pm.id) as pagos_vencidos
        FROM estudiantes e
        JOIN compromiso_economico ce ON e.id = ce.id_estudiante
        JOIN pagos_mensuales pm ON ce.id = pm.id_compromiso
        WHERE pm.estado IN ('pendiente', 'parcial')
          AND pm.fecha_vencimiento < CURDATE()
          AND ce.estado_compromiso = 'activo'
      `);

      // Obtener nuevos estudiantes
      const [nuevosEstudiantes] = await this.pool.query(`
        SELECT COUNT(*) as total
        FROM estudiantes
        WHERE fecha_registro BETWEEN ? AND ?
          AND estado_id = 1
      `, [fechaInicioStr, fechaFinStr]);

      // Obtener inscripciones nuevas
      const [nuevasInscripciones] = await this.pool.query(`
        SELECT COUNT(*) as total
        FROM inscripciones
        WHERE fecha_inscripcion BETWEEN ? AND ?
          AND estado = 'activo'
      `, [fechaInicioStr, fechaFinStr]);

      // Obtener alertas pendientes
      const [alertasPendientes] = await this.pool.query(`
        SELECT 
          tipo_alerta,
          severidad,
          COUNT(*) as cantidad
        FROM alertas_sistema
        WHERE estado = 'pendiente'
        GROUP BY tipo_alerta, severidad
      `);

      // Obtener sugerencias de becas pendientes
      const [sugerenciasBecas] = await this.pool.query(`
        SELECT COUNT(*) as total
        FROM sugerencias_becas
        WHERE estado = 'pendiente'
      `);

      // Generar recomendaciones inteligentes
      const recomendaciones = [];
      const totalIngresos = ingresos.reduce((sum, ing) => sum + parseFloat(ing.total_ingresos || 0), 0);
      const estudiantesConDeuda = parseInt(morosidad[0]?.estudiantes_con_deuda || 0);
      const deudaTotal = parseFloat(morosidad[0]?.deuda_total || 0);

      if (estudiantesConDeuda > 0) {
        recomendaciones.push({
          tipo: 'morosidad',
          prioridad: 'alta',
          mensaje: `${estudiantesConDeuda} estudiante(s) con deuda pendiente. Deuda total: Bs ${deudaTotal.toFixed(2)}`,
          accion: 'Revisar y contactar a estudiantes con pagos atrasados'
        });
      }

      if (parseInt(sugerenciasBecas[0]?.total || 0) > 0) {
        recomendaciones.push({
          tipo: 'becas',
          prioridad: 'media',
          mensaje: `${sugerenciasBecas[0].total} sugerencia(s) de beca pendiente(s)`,
          accion: 'Revisar candidatos a becas y evaluar aplicación'
        });
      }

      if (parseInt(alertasPendientes.length) > 0) {
        const alertasCriticas = alertasPendientes.filter(a => a.severidad === 'critica').reduce((sum, a) => sum + parseInt(a.cantidad), 0);
        if (alertasCriticas > 0) {
          recomendaciones.push({
            tipo: 'alertas',
            prioridad: 'critica',
            mensaje: `${alertasCriticas} alerta(s) crítica(s) pendiente(s)`,
            accion: 'Revisar y atender alertas críticas inmediatamente'
          });
        }
      }

      // Construir reporte
      const reporte = {
        titulo: titulo,
        periodo: {
          inicio: fechaInicioStr,
          fin: fechaFinStr,
          tipo: tipo
        },
        estadisticas: {
          ingresos: {
            total: totalIngresos,
            total_pagos: ingresos.reduce((sum, ing) => sum + parseInt(ing.total_pagos || 0), 0),
            promedio_pago: ingresos.length > 0 ? totalIngresos / ingresos.length : 0,
            por_forma_pago: ingresos.map(ing => ({
              forma: ing.forma_pago || 'otro',
              total: parseFloat(ing.total_ingresos || 0),
              cantidad: parseInt(ing.cantidad_por_forma || 0)
            }))
          },
          morosidad: {
            estudiantes_con_deuda: estudiantesConDeuda,
            deuda_total: deudaTotal,
            pagos_vencidos: parseInt(morosidad[0]?.pagos_vencidos || 0)
          },
          estudiantes: {
            nuevos: parseInt(nuevosEstudiantes[0]?.total || 0),
            nuevas_inscripciones: parseInt(nuevasInscripciones[0]?.total || 0)
          },
          alertas: {
            pendientes: alertasPendientes.reduce((sum, a) => sum + parseInt(a.cantidad), 0),
            por_tipo: alertasPendientes.map(a => ({
              tipo: a.tipo_alerta,
              severidad: a.severidad,
              cantidad: parseInt(a.cantidad)
            }))
          },
          sugerencias: {
            becas_pendientes: parseInt(sugerenciasBecas[0]?.total || 0)
          }
        },
        recomendaciones: recomendaciones,
        fecha_generacion: new Date().toISOString()
      };

      // Guardar reporte en base de datos
      await this.pool.query(`
        INSERT INTO reportes_automaticos (
          tipo_reporte, periodo_inicio, periodo_fin,
          datos_reporte, fecha_generacion
        ) VALUES (?, ?, ?, ?, NOW())
      `, [
        tipo,
        fechaInicioStr,
        fechaFinStr,
        JSON.stringify(reporte)
      ]);

      console.log(`✅ Reporte ${tipo} generado exitosamente`);

      return {
        ok: true,
        reporte: reporte
      };
    } catch (error) {
      console.error('❌ Error generando reporte:', error);
      return { ok: false, error: error.message };
    }
  }

  // ===== EJECUTAR TODOS LOS ANÁLISIS =====
  async ejecutarTodosLosAnalisis() {
    console.log('🚀 Iniciando análisis autónomo completo...');

    const resultados = {
      pagos_atrasados: null,
      reporte_diario: null
    };

    try {
      // 1. Detección de pagos atrasados
      resultados.pagos_atrasados = await this.detectarPagosAtrasados();

      // 2. Reporte diario
      resultados.reporte_diario = await this.generarReporteInteligente('diario');

      console.log('✅ Análisis autónomo completado');

      return {
        ok: true,
        fecha_ejecucion: new Date().toISOString(),
        resultados: resultados
      };
    } catch (error) {
      console.error('❌ Error en análisis autónomo completo:', error);
      return {
        ok: false,
        error: error.message,
        resultados: resultados
      };
    }
  }
}

module.exports = AnalisisAutonomo;

