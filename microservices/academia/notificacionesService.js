// ===== SERVICIO DE NOTIFICACIONES AUTOMÁTICAS Y MANUALES =====
// Gestiona notificaciones de vencimientos de cuotas y comunicados generales

const pool = require("./config");

class NotificacionesService {
  constructor(whatsappService) {
    this.whatsappService = whatsappService;
    this.procesandoNotificaciones = false;
  }

  // Normalizar número de teléfono para WhatsApp
  normalizarNumeroParaWhatsApp(numero) {
    if (!numero) {
      console.log("⚠️ Número vacío o null");
      return null;
    }

    // Convertir a string y eliminar espacios al inicio y final
    let normalizado = String(numero).trim();

    if (normalizado.length === 0) {
      console.log("⚠️ Número solo contiene espacios");
      return null;
    }

    // Eliminar espacios, guiones, paréntesis
    normalizado = normalizado.replace(/[\s\-\(\)]/g, "");

    console.log(`📞 Normalizando número: "${numero}" -> "${normalizado}"`);

    // Si empieza con 591 (código de país de Bolivia), mantenerlo
    if (normalizado.startsWith("591")) {
      const resultado = normalizado + "@c.us";
      console.log(`✅ Número normalizado (con código país): ${resultado}`);
      return resultado;
    }

    // Si no empieza con código de país, asumir que es número local boliviano
    // Los números bolivianos tienen 8 dígitos (celular) o 7-8 dígitos (fijo)
    if (normalizado.length >= 7 && normalizado.length <= 9) {
      const resultado = "591" + normalizado + "@c.us";
      console.log(`✅ Número normalizado (sin código país): ${resultado}`);
      return resultado;
    }

    console.log(
      `⚠️ Número no válido (longitud: ${normalizado.length}): ${normalizado}`,
    );
    return null;
  }

  // ✅ ACTUALIZADO: Obtener teléfonos de contacto_aviso (números verificados)
  async obtenerTelefonosEstudiante(estudianteId) {
    try {
      // Consultar solo números verificados en contacto_aviso
      const [contactos] = await pool.query(
        `
        SELECT
          ca.telefono,
          ca.nombre_contacto,
          ca.tipo_contacto,
          e.nombre as nombre_estudiante,
          e.apellido_paterno,
          e.apellido_materno
        FROM contacto_aviso ca
        INNER JOIN estudiantes e ON ca.estudiante_id = e.id
        WHERE ca.estudiante_id = ?
          AND ca.activo = TRUE
        ORDER BY
          CASE ca.tipo_contacto
            WHEN 'padre' THEN 1
            WHEN 'madre' THEN 2
            WHEN 'padre_oficina' THEN 3
            WHEN 'madre_oficina' THEN 4
            ELSE 5
          END
      `,
        [estudianteId],
      );

      if (contactos.length === 0) {
        console.log(
          `⚠️ Estudiante ${estudianteId} no tiene contactos verificados en contacto_aviso`,
        );
        return [];
      }

      const estudiante = contactos[0];
      const nombreEstudiante =
        `${estudiante.nombre_estudiante} ${estudiante.apellido_paterno || ""}`.trim();

      // Transformar a formato esperado
      const telefonos = contactos
        .map((contacto) => {
          const numero = this.normalizarNumeroParaWhatsApp(contacto.telefono);
          if (!numero) return null;

          return {
            numero: numero,
            nombre: contacto.nombre_contacto || "Tutor",
            tipo: contacto.tipo_contacto,
            estudiante: nombreEstudiante,
          };
        })
        .filter((t) => t !== null);

      // Eliminar duplicados (mismo número)
      const telefonosUnicos = [];
      const numerosVistos = new Set();
      for (const tel of telefonos) {
        if (!numerosVistos.has(tel.numero)) {
          numerosVistos.add(tel.numero);
          telefonosUnicos.push(tel);
        }
      }

      console.log(
        `✅ Encontrados ${telefonosUnicos.length} contacto(s) verificado(s) para estudiante ${estudianteId}`,
      );
      return telefonosUnicos;
    } catch (error) {
      console.error("Error al obtener teléfonos del estudiante:", error);
      return [];
    }
  }

  // Revisar vencimientos de cuotas y enviar notificaciones
  async revisarVencimientosYNotificar(diasAnticipacion = 2) {
    if (this.procesandoNotificaciones) {
      console.log("⚠️ Ya hay un proceso de notificaciones en ejecución");
      return { enviadas: 0, errores: 0 };
    }

    this.procesandoNotificaciones = true;
    let enviadas = 0;
    let errores = 0;

    try {
      // Verificar que WhatsApp esté conectado
      if (
        !this.whatsappService ||
        !(await this.whatsappService.isClientReady())
      ) {
        // Log silenciado
        return {
          enviadas: 0,
          errores: 0,
          mensaje: "WhatsApp no está conectado",
        };
      }

      // Obtener cuotas que vencen en los próximos N días
      const fechaLimite = new Date();
      fechaLimite.setDate(fechaLimite.getDate() + diasAnticipacion);
      const fechaLimiteStr = fechaLimite.toISOString().split("T")[0];

      const fechaHoy = new Date();
      fechaHoy.setDate(fechaHoy.getDate() - 1); // Empezar desde ayer para no perder notificaciones
      const fechaHoyStr = fechaHoy.toISOString().split("T")[0];

      const [cuotas] = await pool.query(
        `
        SELECT
          pm.id,
          pm.mes,
          pm.nombre_mes,
          pm.monto_esperado,
          pm.monto_pagado,
          pm.monto_pendiente,
          pm.estado,
          pm.fecha_vencimiento,
          ce.id_estudiante,
          e.nombre as nombre_estudiante,
          e.apellido_paterno,
          e.apellido_materno
        FROM pagos_mensuales pm
        JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
        JOIN estudiantes e ON ce.id_estudiante = e.id
        WHERE pm.estado IN ('pendiente', 'parcial')
          AND pm.fecha_vencimiento BETWEEN ? AND ?
          AND pm.fecha_vencimiento >= CURDATE()
        ORDER BY pm.fecha_vencimiento ASC
      `,
        [fechaHoyStr, fechaLimiteStr],
      );

      console.log(`📊 Encontradas ${cuotas.length} cuotas próximas a vencer`);

      // Agrupar por estudiante para evitar múltiples mensajes al mismo padre
      const estudiantesNotificados = new Map();

      for (const cuota of cuotas) {
        try {
          const estudianteId = cuota.id_estudiante;

          // Si ya notificamos a este estudiante en esta ejecución, saltar
          if (estudiantesNotificados.has(estudianteId)) {
            continue;
          }

          // Obtener teléfonos del estudiante
          const telefonos = await this.obtenerTelefonosEstudiante(estudianteId);

          if (telefonos.length === 0) {
            console.log(
              `⚠️ Estudiante ${cuota.nombre_estudiante} no tiene teléfonos registrados`,
            );
            continue;
          }

          // Preparar mensaje personalizado
          const fechaVencimiento = new Date(cuota.fecha_vencimiento);
          const diasRestantes = Math.ceil(
            (fechaVencimiento - new Date()) / (1000 * 60 * 60 * 24),
          );

          let mensaje = "";
          if (diasRestantes === 0) {
            mensaje = `⏰ *Recordatorio de Pago*\n\n`;
          } else if (diasRestantes === 1) {
            mensaje = `⏰ *Recordatorio de Pago*\n\n`;
          } else {
            mensaje = `📅 *Recordatorio de Pago*\n\n`;
          }

          // Enviar a cada teléfono del estudiante
          for (const telefono of telefonos) {
            const mensajePersonalizado =
              mensaje +
              `Buenos días ${telefono.nombre},\n\n` +
              `Le recordamos que la mensualidad de ${cuota.nombre_mes} de su hijo/a ${telefono.estudiante} ` +
              `vencerá ${diasRestantes === 0 ? "hoy" : `en ${diasRestantes} día${diasRestantes > 1 ? "s" : ""}`} ` +
              `(${fechaVencimiento.toLocaleDateString("es-BO", { day: "2-digit", month: "2-digit", year: "numeric" })}).\n\n` +
              `💰 Monto a pagar: Bs. ${parseFloat(cuota.monto_pendiente || cuota.monto_esperado).toFixed(2)}\n\n` +
              `Por favor, realice el pago a tiempo para evitar inconvenientes.\n\n` +
              `Saludos cordiales,\n` +
              `Unidad Educativa`;

            try {
              await this.whatsappService.client.sendMessage(
                telefono.numero,
                mensajePersonalizado,
              );
              enviadas++;
              console.log(
                `✅ Notificación enviada a ${telefono.nombre} (${telefono.numero})`,
              );

              // Pequeña pausa para evitar rate limiting
              await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (error) {
              errores++;
              console.error(
                `❌ Error enviando a ${telefono.numero}:`,
                error.message,
              );
            }
          }

          // Marcar como notificado
          estudiantesNotificados.set(estudianteId, true);
        } catch (error) {
          errores++;
          console.error(
            `❌ Error procesando cuota ${cuota.id}:`,
            error.message,
          );
        }
      }

      console.log(
        `✅ Proceso de notificaciones completado: ${enviadas} enviadas, ${errores} errores`,
      );

      return { enviadas, errores, total_cuotas: cuotas.length };
    } catch (error) {
      console.error("❌ Error en revisarVencimientosYNotificar:", error);
      return { enviadas, errores, error: error.message };
    } finally {
      this.procesandoNotificaciones = false;
    }
  }

  // Enviar notificación manual a todos los padres/tutores
  async enviarNotificacionManual(mensaje, filtros = {}) {
    try {
      // Verificar que WhatsApp esté conectado
      if (
        !this.whatsappService ||
        !(await this.whatsappService.isClientReady())
      ) {
        throw new Error("WhatsApp no está conectado");
      }

      // Obtener el año académico dinámicamente de las inscripciones para evitar desincronizaciones
      let anioActual = new Date().getFullYear();
      try {
        const [maxRes] = await pool.query("SELECT MAX(gestion_academica) as max_gestion FROM inscripciones");
        if (maxRes && maxRes[0] && maxRes[0].max_gestion) {
          anioActual = maxRes[0].max_gestion;
          console.log(`📅 [enviarNotificacionManual] Usando gestión académica más reciente de la BD: ${anioActual}`);
        }
      } catch (dbErr) {
        console.warn("⚠️ [enviarNotificacionManual] No se pudo obtener la gestión más reciente de la BD, usando año actual:", dbErr.message);
      }

      const turnoFiltro =
        filtros.turno != null && String(filtros.turno).trim() !== ""
          ? String(filtros.turno).trim()
          : null;
      const tieneFiltrosAcademicos =
        filtros.nivel_id ||
        filtros.curso_id ||
        filtros.bloque_id ||
        turnoFiltro;
      const params = [];

      let query = `
        SELECT DISTINCT e.id
        FROM estudiantes e
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
      `;

      if (tieneFiltrosAcademicos) {
        query += ` INNER JOIN inscripciones i ON e.id = i.estudiante_id `;
        query += ` WHERE (
            (i.gestion_academica IS NOT NULL AND i.gestion_academica >= ?)
            OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) >= ?)
          ) `;
        params.push(anioActual, anioActual);

        if (filtros.nivel_id) {
          query += ` AND i.nivel_id = ? `;
          params.push(filtros.nivel_id);
        }
        if (filtros.curso_id) {
          query += ` AND i.curso_id = ? `;
          params.push(filtros.curso_id);
        }
        if (filtros.bloque_id) {
          query += ` AND i.bloque_id = ? `;
          params.push(filtros.bloque_id);
        }
        if (turnoFiltro) {
          const tn = turnoFiltro
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
          query += ` AND (
            LOWER(TRIM(COALESCE(i.turno, ''))) = LOWER(TRIM(?))
            OR LOWER(TRIM(COALESCE(i.turno, ''))) LIKE ?
          ) `;
          params.push(turnoFiltro, `%${tn}%`);
        }
      } else {
        // Si no hay filtros académicos, permitir enviar a todos los registrados activos
        query += ` WHERE e.estado_id = 1 `;
      }

      // Filtro por estudiante específico (siempre aplicable)
      if (filtros.estudiante_id) {
        query += ` AND e.id = ? `;
        params.push(filtros.estudiante_id);
      }

      // Primero, verificar cuántos estudiantes tienen contactos verificados
      const [testQuery] = await pool.query(`
        SELECT COUNT(DISTINCT e.id) as total
        FROM estudiantes e
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
      `);
      console.log(
        `🔍 Total de estudiantes con contactos verificados: ${testQuery[0]?.total || 0}`,
      );

      let estudiantes;
      try {
        console.log(`📋 Ejecutando query: ${query}`);
        console.log(`📋 Parámetros:`, params);
        [estudiantes] = await pool.query(query, params);
        console.log(
          `✅ Query ejecutada exitosamente. Estudiantes encontrados: ${estudiantes.length}`,
        );
      } catch (sqlError) {
        console.error("❌ Error en consulta SQL:", sqlError);
        console.error("❌ Stack trace:", sqlError.stack);
        throw new Error(`Error al consultar estudiantes: ${sqlError.message}`);
      }

      console.log(
        `📤 Enviando notificación a ${estudiantes.length} estudiantes`,
      );

      if (estudiantes.length === 0) {
        console.warn(
          "⚠️ No se encontraron estudiantes. Verificando posibles causas...",
        );
        // Verificar si hay estudiantes sin filtros
        const [sinFiltros] = await pool.query(`
          SELECT COUNT(DISTINCT e.id) as total
          FROM estudiantes e
          INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
        `);
        console.log(
          `📊 Estudiantes con contacto verificado (sin filtros): ${sinFiltros[0]?.total || 0}`,
        );

        if (tieneFiltrosAcademicos) {
          const [conInscripciones] = await pool.query(`
            SELECT COUNT(DISTINCT e.id) as total
            FROM estudiantes e
            INNER JOIN inscripciones i ON e.id = i.estudiante_id
            INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
          `);
          console.log(
            `📊 Estudiantes con contacto verificado e inscripciones: ${conInscripciones[0]?.total || 0}`,
          );
        }
      }

      let enviadas = 0;
      let errores = 0;
      const telefonosEnviados = new Set(); // Para evitar duplicados

      for (const estudianteRow of estudiantes) {
        try {
          const telefonos = await this.obtenerTelefonosEstudiante(
            estudianteRow.id,
          );
          console.log(
            `📱 Estudiante ${estudianteRow.id}: ${telefonos.length} teléfonos encontrados`,
          );

          for (const telefono of telefonos) {
            // Evitar enviar al mismo número múltiples veces
            if (telefonosEnviados.has(telefono.numero)) {
              continue;
            }

            // Personalizar mensaje
            let mensajePersonalizado = mensaje
              .replace(/\{nombre\}/g, telefono.nombre)
              .replace(/\{estudiante\}/g, telefono.estudiante);

            // Mejorar el mensaje: eliminar referencias a "padres o tutores" ya que es personalizado
            mensajePersonalizado = mensajePersonalizado
              .replace(
                /\s*(padres|tutores|padres\s+o\s+tutores)\s+(que|:)?\s*/gi,
                " ",
              )
              .replace(/\s+/g, " ") // Normalizar espacios múltiples
              .trim();

            // Si el mensaje no tiene saludo personalizado, agregarlo
            let mensajeFinal = mensajePersonalizado;
            if (
              !mensajePersonalizado.toLowerCase().includes("buenos días") &&
              !mensajePersonalizado.toLowerCase().includes("buenas tardes") &&
              !mensajePersonalizado.toLowerCase().includes("buenas noches")
            ) {
              // Formato profesional del mensaje
              mensajeFinal = `Buenos días ${telefono.nombre},\n\nLe informamos que ${mensajePersonalizado.toLowerCase()}\n\nSaludos cordiales,\nUnidad Educativa`;
            } else {
              // Si ya tiene saludo, solo agregar despedida si no la tiene
              if (
                !mensajePersonalizado.toLowerCase().includes("saludos") &&
                !mensajePersonalizado.toLowerCase().includes("unidad educativa")
              ) {
                mensajeFinal = `${mensajePersonalizado}\n\nSaludos cordiales,\nUnidad Educativa`;
              }
            }

            try {
              // Verificar que WhatsApp esté listo antes de enviar
              if (!(await this.whatsappService.isClientReady())) {
                throw new Error("WhatsApp no está conectado");
              }

              await this.whatsappService.client.sendMessage(
                telefono.numero,
                mensajeFinal,
              );
              telefonosEnviados.add(telefono.numero);
              enviadas++;
              console.log(
                `✅ Notificación enviada a ${telefono.nombre} (${telefono.numero})`,
              );

              // Pausa para evitar rate limiting
              await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (error) {
              errores++;
              const errorMsg = error.message || "Error desconocido";

              // Clasificar errores
              if (
                errorMsg.includes("No LID for user") ||
                errorMsg.includes("not registered")
              ) {
                console.warn(
                  `⚠️ Número ${telefono.numero} no tiene WhatsApp o no está registrado`,
                );
              } else if (errorMsg.includes("getChat")) {
                console.warn(
                  `⚠️ Error de conexión WhatsApp al enviar a ${telefono.numero}, reintentando...`,
                );
                // Reintentar una vez después de un delay
                await new Promise((resolve) => setTimeout(resolve, 3000));
                try {
                  if (await this.whatsappService.isClientReady()) {
                    await this.whatsappService.client.sendMessage(
                      telefono.numero,
                      mensajeFinal,
                    );
                    telefonosEnviados.add(telefono.numero);
                    enviadas++;
                    errores--; // Descontar el error ya que se envió exitosamente
                    console.log(
                      `✅ Notificación enviada a ${telefono.nombre} (${telefono.numero}) - Reintento exitoso`,
                    );
                  }
                } catch (retryError) {
                  console.error(
                    `❌ Error en reintento para ${telefono.numero}:`,
                    retryError.message,
                  );
                }
              } else {
                console.error(
                  `❌ Error enviando a ${telefono.numero}:`,
                  errorMsg,
                );
              }
            }
          }
        } catch (error) {
          errores++;
          console.error(
            `❌ Error procesando estudiante ${estudianteRow.id}:`,
            error.message,
          );
        }
      }

      return {
        enviadas,
        errores,
        total_estudiantes: estudiantes.length,
        total_telefonos: telefonosEnviados.size,
      };
    } catch (error) {
      console.error("❌ Error en enviarNotificacionManual:", error);
      // Asegurarse de que el error no afecte la conexión de WhatsApp
      // Solo relanzar el error si no es un error de conexión de WhatsApp
      if (error.message && error.message.includes("WhatsApp")) {
        throw error;
      }
      // Para otros errores (SQL, etc.), crear un nuevo error sin afectar WhatsApp
      throw new Error(
        `Error al enviar notificación: ${error.message || "Error desconocido"}`,
      );
    }
  }

  // Generar mensaje personalizado desde texto del admin
  // 🆕 NOTIFICACIÓN INTELIGENTE DE PAGOS PENDIENTES
  // Consulta la BD para encontrar quiénes deben de un mes específico
  // y envía un mensaje personalizado con el monto exacto a cada padre/tutor
  async enviarRecordatorioPagosPendientes({
    mes,
    fechaVencimiento,
    mensajeExtra = "",
  }) {
    try {
      if (
        !this.whatsappService ||
        !(await this.whatsappService.isClientReady())
      ) {
        throw new Error("WhatsApp no está conectado");
      }

      const anio = new Date().getFullYear();
      // El mes puede venir como nombre ("junio") o como número (6)
      const MESES_NUM = {
        enero: 2,
        febrero: 2,
        marzo: 3,
        abril: 4,
        mayo: 5,
        junio: 6,
        julio: 7,
        agosto: 8,
        septiembre: 9,
        octubre: 10,
        noviembre: 11,
        diciembre: 12,
      };
      const mesNombre = String(mes || "")
        .toLowerCase()
        .trim();
      const mesNum = MESES_NUM[mesNombre] || parseInt(mes) || null;
      const mesCapitalizado =
        mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1);

      console.log(
        `💰 [RecordatorioPagos] Buscando deudas del mes: ${mesNombre} (${mesNum}), año: ${anio}`,
      );

      // Consultar estudiantes con pagos pendientes del mes
      const [deudores] = await pool.query(
        `
        SELECT
          e.id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.nombre_padre,
          e.apellido_padre,
          e.nombre_madre,
          e.apellido_madre,
          e.telefono_domicilio_padre,
          e.telefono_oficina_padre,
          e.telefono_domicilio_madre,
          n.nombre AS nivel_nombre,
          pm.monto_esperado,
          COALESCE(SUM(pr.monto), 0)                               AS monto_pagado,
          (pm.monto_esperado - COALESCE(SUM(pr.monto), 0))        AS monto_pendiente,
          pm.nombre_mes,
          pm.estado
        FROM pagos_mensuales pm
        JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
        JOIN inscripciones i         ON ce.id_inscripcion = i.id
        JOIN estudiantes e           ON i.estudiante_id = e.id
        LEFT JOIN nivel n            ON n.id = i.nivel_id
        LEFT JOIN pagos_realizados pr
          ON pr.id_compromiso = ce.id AND LOWER(pr.mes) = LOWER(pm.nombre_mes)
        WHERE i.gestion_academica = ?
          AND pm.estado IN ('pendiente','parcial','vencido')
          AND (
            pm.mes = ?
            OR LOWER(pm.nombre_mes) = LOWER(?)
          )
          AND e.estado_id = 1
        GROUP BY pm.id, e.id, n.nombre, pm.monto_esperado, pm.nombre_mes, pm.estado
        HAVING monto_pendiente > 0
        ORDER BY e.apellido_paterno, e.nombre
      `,
        [anio, mesNum, mesNombre],
      );

      console.log(
        `📊 [RecordatorioPagos] Encontrados ${deudores.length} estudiante(s) con deuda en ${mesNombre}`,
      );

      if (deudores.length === 0) {
        return {
          enviadas: 0,
          errores: 0,
          total_estudiantes: 0,
          total_telefonos: 0,
          mensaje_estado: `No se encontraron estudiantes con deuda pendiente del mes de ${mesCapitalizado} ${anio}. ¡Todo está al día!`,
        };
      }

      let enviadas = 0,
        errores = 0;
      const telefonosEnviados = new Set();

      for (const est of deudores) {
        // Construir lista de teléfonos del padre/madre
        const telefonos = [];
        const addTel = (num, nombre, tipo) => {
          if (!num) return;
          const normalizado = this.normalizarNumeroParaWhatsApp(num);
          if (normalizado && !telefonosEnviados.has(normalizado)) {
            telefonos.push({ numero: normalizado, nombre, tipo });
          }
        };

        const nombrePadre =
          [est.nombre_padre, est.apellido_padre].filter(Boolean).join(" ") ||
          "Estimado padre/madre";
        const nombreMadre = [est.nombre_madre, est.apellido_madre]
          .filter(Boolean)
          .join(" ");
        const nombreEstudiante =
          `${est.nombre} ${est.apellido_paterno || ""}`.trim();
        const monto = parseFloat(est.monto_pendiente || 0).toFixed(2);
        const nivel = est.nivel_nombre || "";

        addTel(est.telefono_domicilio_padre, nombrePadre, "padre");
        addTel(est.telefono_oficina_padre, nombrePadre, "padre_ofic");
        addTel(
          est.telefono_domicilio_madre,
          nombreMadre || nombrePadre,
          "madre",
        );

        for (const tel of telefonos) {
          if (telefonosEnviados.has(tel.numero)) continue;

          const saludo = tel.nombre
            ? `Buenos días ${tel.nombre}`
            : "Buenos días";
          const vencimiento = fechaVencimiento
            ? `\nFecha límite de pago: *${fechaVencimiento}*`
            : "";
          let mensaje =
            `${saludo},\n\n` +
            `Le recordamos que el estudiante *${nombreEstudiante}*` +
            (nivel ? ` (${nivel})` : "") +
            ` tiene una cuota pendiente del mes de *${mesCapitalizado}*:\n\n` +
            `💰 Monto pendiente: *Bs. ${monto}*` +
            vencimiento +
            `\n\n` +
            (mensajeExtra ? `${mensajeExtra}\n\n` : "") +
            `Para consultas puede contactarnos por este mismo medio.\n\n` +
            `Saludos cordiales,\n*Unidad Educativa EMI*`;

          try {
            await this.whatsappService.client.sendMessage(tel.numero, mensaje);
            telefonosEnviados.add(tel.numero);
            enviadas++;
            console.log(
              `✅ [RecordatorioPagos] Enviado a ${tel.nombre} (${tel.numero}) por estudiante ${nombreEstudiante}`,
            );
            await new Promise((r) => setTimeout(r, 2000));
          } catch (err) {
            errores++;
            console.warn(
              `⚠️ [RecordatorioPagos] Error enviando a ${tel.numero}: ${err.message}`,
            );
          }
        }
      }

      return {
        enviadas,
        errores,
        total_estudiantes: deudores.length,
        total_telefonos: telefonosEnviados.size,
        mes: mesCapitalizado,
      };
    } catch (error) {
      console.error("❌ [RecordatorioPagos] Error:", error.message);
      throw error;
    }
  }

  generarMensajePersonalizado(textoAdmin, fecha = null) {
    // Si el texto ya tiene formato, usarlo directamente
    if (
      textoAdmin.includes("{nombre}") ||
      textoAdmin.includes("{estudiante}")
    ) {
      return textoAdmin;
    }

    // Si hay fecha, incluirla
    let mensaje = textoAdmin;
    if (fecha) {
      const fechaFormateada = new Date(fecha).toLocaleDateString("es-BO", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      mensaje = mensaje.replace(/\d{2}\/\d{2}\/\d{4}/g, fechaFormateada);
    }

    return mensaje;
  }
}

module.exports = NotificacionesService;
