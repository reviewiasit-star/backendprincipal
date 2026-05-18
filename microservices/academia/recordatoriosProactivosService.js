// ===== SERVICIO DE RECORDATORIOS PROACTIVOS MEJORADOS =====
// Envía mensajes proactivos inteligentes basados en contexto y comportamiento

const pool = require('./config');
const { obtenerInstancia } = require('./whatsappServiceSingleton');

class RecordatoriosProactivosService {
  constructor() {
    this.whatsappService = obtenerInstancia();
    this.ultimaConsultaCache = new Map(); // Cache de última consulta por teléfono
  }

  // Enviar recordatorio proactivo de pago próximo a vencer
  async enviarRecordatorioPagoProactivo(diasAnticipacion = 3) {
    try {
      if (!this.whatsappService || !(await this.whatsappService.isClientReady())) {
        console.log('⚠️ WhatsApp no está conectado, no se pueden enviar recordatorios');
        return { enviados: 0, errores: 0 };
      }

      const fechaLimite = new Date();
      fechaLimite.setDate(fechaLimite.getDate() + diasAnticipacion);
      const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

      // ✅ ACTUALIZADO: Obtener cuotas que vencen en los próximos N días (solo contactos verificados)
      const [cuotas] = await pool.query(`
        SELECT 
          pm.id,
          pm.nombre_mes,
          pm.monto_esperado,
          pm.monto_pendiente,
          pm.fecha_vencimiento,
          ce.id_estudiante,
          e.nombre as nombre_estudiante,
          e.apellido_paterno,
          e.apellido_materno,
          ca.telefono,
          ca.nombre_contacto
        FROM pagos_mensuales pm
        JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
        JOIN estudiantes e ON ce.id_estudiante = e.id
        JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
        WHERE pm.estado IN ('pendiente', 'parcial')
          AND pm.fecha_vencimiento BETWEEN CURDATE() AND ?
          AND pm.fecha_vencimiento >= CURDATE()
        ORDER BY pm.fecha_vencimiento ASC
      `, [fechaLimiteStr]);

      console.log(`📊 Encontradas ${cuotas.length} cuotas próximas a vencer para recordatorios proactivos`);

      let enviados = 0;
      let errores = 0;
      const telefonosProcesados = new Set(); // Evitar múltiples mensajes al mismo teléfono

      for (const cuota of cuotas) {
        try {
          // ✅ Usar teléfono y nombre de contacto_aviso
          const telefono = cuota.telefono;
          const nombreTutor = cuota.nombre_contacto || 'Estimado/a tutor/a';
          const nombreEstudiante = `${cuota.nombre_estudiante} ${cuota.apellido_paterno || ''} ${cuota.apellido_materno || ''}`.trim();

          // Evitar enviar múltiples mensajes al mismo teléfono en la misma ejecución
          if (telefonosProcesados.has(telefono)) {
            continue;
          }

          // Verificar si el usuario consultó recientemente (últimas 24 horas)
          // Si consultó recientemente, no enviar recordatorio (ya está informado)
          const ultimaConsulta = this.ultimaConsultaCache.get(telefono);
          if (ultimaConsulta && (Date.now() - ultimaConsulta) < 24 * 60 * 60 * 1000) {
            console.log(`⏭️ Saltando recordatorio para ${telefono} - consultó recientemente`);
            continue;
          }

          // Calcular días hasta vencimiento
          const fechaVenc = new Date(cuota.fecha_vencimiento);
          const diasRestantes = Math.ceil((fechaVenc - new Date()) / (1000 * 60 * 60 * 24));

          // Generar mensaje personalizado y amigable
          const mensaje = this.generarMensajeRecordatorioPersonalizado(
            nombreTutor,
            nombreEstudiante,
            cuota.nombre_mes,
            cuota.monto_pendiente,
            diasRestantes
          );

          // Normalizar teléfono
          const telefonoNormalizado = this.normalizarTelefono(telefono);
          const chatId = `${telefonoNormalizado}@c.us`;

          // Enviar mensaje
          await this.whatsappService.client.sendMessage(chatId, mensaje);

          telefonosProcesados.add(telefono);
          enviados++;

          console.log(`✅ Recordatorio proactivo enviado a ${nombreTutor} (${telefono}) - ${diasRestantes} días restantes`);

          // Pequeña pausa para evitar rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          console.error(`❌ Error enviando recordatorio proactivo:`, error.message);
          errores++;
        }
      }

      return { enviados, errores, total_cuotas: cuotas.length };
    } catch (error) {
      console.error('❌ Error en enviarRecordatorioPagoProactivo:', error);
      return { enviados: 0, errores: 1, error: error.message };
    }
  }

  // Generar mensaje de recordatorio personalizado y amigable
  generarMensajeRecordatorioPersonalizado(nombreTutor, nombreEstudiante, mes, monto, diasRestantes) {
    const saludo = this.obtenerSaludoPorHora();

    let mensaje = `${saludo} ${nombreTutor} 👋\n\n`;
    mensaje += `Te escribo para recordarte que la cuota de *${mes}* de ${nombreEstudiante} `;

    if (diasRestantes === 0) {
      mensaje += `vence *hoy* 📅\n\n`;
    } else if (diasRestantes === 1) {
      mensaje += `vence *mañana* 📅\n\n`;
    } else {
      mensaje += `vence en *${diasRestantes} días* 📅\n\n`;
    }

    mensaje += `💰 *Monto pendiente: Bs. ${monto.toFixed(2)}*\n\n`;

    // Mensaje motivacional según días restantes
    if (diasRestantes >= 2) {
      mensaje += `💡 *Sugerencia:* Puedes pagar con anticipación para evitar olvidos. `;
      mensaje += `¿Te gustaría que te muestre todas las cuotas pendientes?\n\n`;
    } else {
      mensaje += `⏰ *Importante:* Por favor, realiza el pago antes de la fecha de vencimiento para evitar recargos.\n\n`;
    }

    mensaje += `Si tienes alguna pregunta, no dudes en escribirme. Estoy aquí para ayudarte 😊\n\n`;
    mensaje += `_Este es un mensaje automático del sistema de la Unidad Educativa._`;

    return mensaje;
  }

  // Obtener saludo según hora del día
  obtenerSaludoPorHora() {
    const hora = new Date().getHours();
    if (hora >= 5 && hora < 12) {
      return 'Buenos días';
    } else if (hora >= 12 && hora < 19) {
      return 'Buenas tardes';
    } else {
      return 'Buenas noches';
    }
  }

  // Normalizar teléfono para WhatsApp
  normalizarTelefono(telefono) {
    // Eliminar espacios, guiones, paréntesis
    let normalizado = telefono.replace(/\D/g, '');

    // Si empieza con 591 (código de Bolivia), mantenerlo
    // Si no tiene código de país, asumir que es número local
    if (!normalizado.startsWith('591') && normalizado.length === 8) {
      normalizado = '591' + normalizado;
    }

    return normalizado;
  }

  // Registrar consulta del usuario (para evitar recordatorios inmediatos después de consultas)
  registrarConsulta(telefono) {
    if (telefono) {
      const telefonoNormalizado = this.normalizarTelefono(telefono);
      this.ultimaConsultaCache.set(telefonoNormalizado, Date.now());

      // Limpiar cache antiguo (más de 7 días)
      const ahora = Date.now();
      for (const [tel, timestamp] of this.ultimaConsultaCache.entries()) {
        if (ahora - timestamp > 7 * 24 * 60 * 60 * 1000) {
          this.ultimaConsultaCache.delete(tel);
        }
      }
    }
  }

  // Enviar recordatorio de eventos importantes (inicio de clases, feriados, etc.)
  async enviarRecordatorioEvento(tipoEvento, fechaEvento, mensajePersonalizado = null) {
    try {
      if (!this.whatsappService || !(await this.whatsappService.isClientReady())) {
        return { enviados: 0, errores: 0 };
      }

      // ✅ ACTUALIZADO: Obtener todos los estudiantes con contacto verificado
      const [estudiantes] = await pool.query(`
        SELECT DISTINCT
          e.id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          ca.telefono,
          ca.nombre_contacto
        FROM estudiantes e
        INNER JOIN inscripciones i ON e.id = i.estudiante_id
        INNER JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
        WHERE i.gestion_academica >= YEAR(CURDATE())
      `);

      let enviados = 0;
      let errores = 0;

      for (const estudiante of estudiantes) {
        try {
          // ✅ Usar contacto verificado
          const telefono = estudiante.telefono;
          const nombreTutor = estudiante.nombre_contacto || 'Estimado/a tutor/a';
          const nombreEstudiante = `${estudiante.nombre} ${estudiante.apellido_paterno || ''} ${estudiante.apellido_materno || ''}`.trim();

          const mensaje = mensajePersonalizado || this.generarMensajeEvento(tipoEvento, fechaEvento, nombreTutor, nombreEstudiante);

          const telefonoNormalizado = this.normalizarTelefono(telefono);
          const chatId = `${telefonoNormalizado}@c.us`;

          await this.whatsappService.client.sendMessage(chatId, mensaje);
          enviados++;

          // Pausa para evitar rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          console.error(`❌ Error enviando recordatorio de evento:`, error.message);
          errores++;
        }
      }

      return { enviados, errores };
    } catch (error) {
      console.error('❌ Error en enviarRecordatorioEvento:', error);
      return { enviados: 0, errores: 1, error: error.message };
    }
  }

  // Generar mensaje de evento
  generarMensajeEvento(tipoEvento, fechaEvento, nombreTutor, nombreEstudiante) {
    const saludo = this.obtenerSaludoPorHora();
    let mensaje = `${saludo} ${nombreTutor} 👋\n\n`;

    switch (tipoEvento) {
      case 'inicio_clases':
        mensaje += `📚 *Recordatorio importante*\n\n`;
        mensaje += `Te informamos que las clases inician el ${fechaEvento}.\n\n`;
        mensaje += `Por favor, asegúrate de que ${nombreEstudiante} tenga todo listo:\n`;
        mensaje += `• Uniforme completo\n`;
        mensaje += `• Materiales escolares\n`;
        mensaje += `• Documentación al día\n\n`;
        break;

      case 'feriado':
        mensaje += `📅 *Recordatorio de feriado*\n\n`;
        mensaje += `Te informamos que el ${fechaEvento} es feriado, no habrá clases.\n\n`;
        break;

      default:
        mensaje += `📢 *Recordatorio*\n\n`;
        mensaje += `Te informamos sobre un evento importante: ${tipoEvento} el ${fechaEvento}.\n\n`;
    }

    mensaje += `Si tienes alguna pregunta, no dudes en escribirme 😊\n\n`;
    mensaje += `_Este es un mensaje automático del sistema de la Unidad Educativa._`;

    return mensaje;
  }
}

module.exports = RecordatoriosProactivosService;
