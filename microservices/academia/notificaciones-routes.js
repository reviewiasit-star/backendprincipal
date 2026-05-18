// ===== RUTAS DE NOTIFICACIONES =====
// Endpoints para notificaciones automáticas y manuales

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const NotificacionesService = require('./notificacionesService');
const NotificacionesJob = require('./notificacionesJob');
const RecordatoriosProactivosJob = require('./recordatoriosProactivosJob');
const { obtenerInstancia } = require('./whatsappServiceSingleton');
const pool = require('./config');

// Instancias globales
let notificacionesService = null;
let notificacionesJob = null;
let recordatoriosProactivosJob = null;

// Obtener instancia única de WhatsApp
const whatsappService = obtenerInstancia();

// Inicializar servicios
function inicializarServicios() {
  if (!notificacionesService) {
    notificacionesService = new NotificacionesService(whatsappService);
  }

  if (!notificacionesJob) {
    notificacionesJob = new NotificacionesJob(notificacionesService);
    // Iniciar job automático (revisa cada 6 horas)
    notificacionesJob.iniciar(6);
    // Log silenciado
  }

  // Inicializar job de recordatorios proactivos (mejora del agente inteligente)
  if (!recordatoriosProactivosJob) {
    recordatoriosProactivosJob = new RecordatoriosProactivosJob();
    // Iniciar job automático (ejecuta una vez al día a las 8:00 AM)
    recordatoriosProactivosJob.iniciar(24);
  }
}

// Inicializar jobs al cargar el módulo (igual que análisis autónomo).
// Así los recordatorios proactivos y las notificaciones de vencimiento
// se ejecutan sin que un admin use antes los endpoints.
inicializarServicios();
if (notificacionesJob || recordatoriosProactivosJob) {
  console.log('✅ [notificaciones] Jobs de notificaciones y recordatorios proactivos inicializados al arranque');
}

// Middleware para verificar permisos (solo Administrador y Director)
const verificarPermisosNotificaciones = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      message: 'Usuario no autenticado'
    });
  }

  const rolesPermitidos = ['Administrador', 'Director'];
  if (!rolesPermitidos.includes(req.user.rol)) {
    return res.status(403).json({
      ok: false,
      message: 'No tienes permisos para enviar notificaciones. Solo Administradores y Directores pueden hacerlo.'
    });
  }

  next();
};

// Endpoint para revisar vencimientos manualmente
router.post('/revisar-vencimientos', authMiddleware, verificarPermisosNotificaciones, async (req, res) => {
  try {
    const { dias_anticipacion = 2 } = req.body;

    if (!notificacionesJob) {
      inicializarServicios();
    }

    const resultado = await notificacionesJob.ejecutarRevisionManual(dias_anticipacion);

    return res.json({
      ok: true,
      ...resultado,
      mensaje: `Revisión completada: ${resultado.enviadas} notificaciones enviadas, ${resultado.errores} errores`
    });
  } catch (error) {
    console.error('Error en revisar vencimientos:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al revisar vencimientos',
      error: error.message
    });
  }
});

// Endpoint para enviar notificación manual
router.post('/enviar-manual', authMiddleware, verificarPermisosNotificaciones, async (req, res) => {
  try {
    const { mensaje, fecha, filtros } = req.body;

    if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
      return res.status(400).json({
        ok: false,
        message: 'El campo "mensaje" es requerido y no puede estar vacío'
      });
    }

    if (!notificacionesService) {
      inicializarServicios();
    }

    // Generar mensaje personalizado
    const mensajePersonalizado = notificacionesService.generarMensajePersonalizado(mensaje, fecha);

    // Enviar notificación
    const resultado = await notificacionesService.enviarNotificacionManual(mensajePersonalizado, filtros || {});

    return res.json({
      ok: true,
      ...resultado,
      mensaje: `Notificación enviada: ${resultado.enviadas} mensajes enviados a ${resultado.total_telefonos} contactos`
    });
  } catch (error) {
    console.error('Error en enviar notificación manual:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al enviar notificación',
      error: error.message
    });
  }
});

// Endpoint para procesar comando de notificación desde el agente
router.post('/procesar-comando', authMiddleware, verificarPermisosNotificaciones, async (req, res) => {
  try {
    const { comando, fecha, filtros } = req.body;

    if (!comando || typeof comando !== 'string') {
      return res.status(400).json({
        ok: false,
        message: 'El campo "comando" es requerido'
      });
    }

    if (!notificacionesService) {
      inicializarServicios();
    }

    // Extraer mensaje del comando usando el agente
    // Por ahora, usar el comando directamente como mensaje
    // (en el futuro se puede mejorar con procesamiento de lenguaje natural)
    let mensaje = comando;

    // Intentar extraer fecha si está en el comando
    const fechaMatch = comando.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (fechaMatch && !fecha) {
      const fechaStr = fechaMatch[1];
      const [dia, mes, anio] = fechaStr.split('/');
      fecha = `${anio}-${mes}-${dia}`;
    }

    // Generar mensaje personalizado
    const mensajePersonalizado = notificacionesService.generarMensajePersonalizado(mensaje, fecha);

    // Enviar notificación
    const resultado = await notificacionesService.enviarNotificacionManual(mensajePersonalizado, filtros || {});

    return res.json({
      ok: true,
      ...resultado,
      mensaje: `Comando procesado: ${resultado.enviadas} mensajes enviados a ${resultado.total_telefonos} contactos`
    });
  } catch (error) {
    console.error('Error en procesar comando de notificación:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al procesar comando de notificación',
      error: error.message
    });
  }
});

// Endpoint para obtener estado del job automático
router.get('/estado-job', authMiddleware, verificarPermisosNotificaciones, (req, res) => {
  try {
    return res.json({
      ok: true,
      job_activo: notificacionesJob !== null,
      whatsapp_conectado: whatsappService ? whatsappService.isReady : false
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Endpoint para obtener notificaciones programadas (cuotas que se notificarán automáticamente)
// Solo requiere autenticación, no permisos especiales, para que pueda ser visto en el panel del admin
router.get('/notificaciones-programadas', authMiddleware, async (req, res) => {
  try {
    // Días de anticipación configurados en el sistema (según notificacionesService.js)
    const diasAnticipacionSistema = 2;
    const { dias_anticipacion_vista = 30 } = req.query; // Por defecto mostrar próximos 30 días en la vista

    // Calcular fechas
    const fechaHoy = new Date();
    fechaHoy.setHours(0, 0, 0, 0);
    const fechaLimiteVista = new Date();
    fechaLimiteVista.setDate(fechaLimiteVista.getDate() + parseInt(dias_anticipacion_vista));
    fechaLimiteVista.setHours(23, 59, 59, 999);

    const fechaHoyStr = fechaHoy.toISOString().split('T')[0];
    const fechaLimiteVistaStr = fechaLimiteVista.toISOString().split('T')[0];

    // Obtener TODAS las cuotas pendientes o parciales que vencen en el futuro
    // ✅ ACTUALIZADO: Obtener teléfonos de contacto_aviso
    const [cuotas] = await pool.query(`
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
        e.apellido_materno,
        ca.telefono,
        ca.nombre_contacto as tutor_nombre,
        ca.tipo_contacto,
        i.nivel_id,
        i.curso_id,
        i.bloque_id,
        n.nombre as nivel_nombre,
        c.nombre as curso_nombre,
        b.descripcion as bloque_nombre
      FROM pagos_mensuales pm
      JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
      JOIN estudiantes e ON ce.id_estudiante = e.id
      JOIN inscripciones i ON ce.inscripcion_id = i.id
      LEFT JOIN nivel n ON i.nivel_id = n.id
      LEFT JOIN curso c ON i.curso_id = c.id
      LEFT JOIN bloque b ON i.bloque_id = b.id
      LEFT JOIN contacto_aviso ca ON e.id = ca.estudiante_id AND ca.activo = TRUE
      WHERE pm.estado IN ('pendiente', 'parcial')
        AND pm.fecha_vencimiento >= CURDATE()
        AND pm.fecha_vencimiento <= ?
        AND ce.estado_compromiso = 'activo'
      ORDER BY pm.fecha_vencimiento ASC, e.apellido_paterno ASC, e.nombre ASC
    `, [fechaLimiteVistaStr]);

    // Procesar cuotas y agrupar por notificaciones reales (una por contacto verificado)
    const notificacionesProgramadas = cuotas.map(cuota => {
      const fechaVencimiento = new Date(cuota.fecha_vencimiento);
      fechaVencimiento.setHours(0, 0, 0, 0);

      const diasRestantes = Math.ceil((fechaVencimiento - fechaHoy) / (1000 * 60 * 60 * 24));
      const fechaNotificacion = new Date(fechaVencimiento);
      fechaNotificacion.setDate(fechaNotificacion.getDate() - diasAnticipacionSistema);
      const diasHastaNotificacion = Math.ceil((fechaNotificacion - fechaHoy) / (1000 * 60 * 60 * 24));

      const nombreEstudiante = `${cuota.nombre_estudiante} ${cuota.apellido_paterno || ''} ${cuota.apellido_materno || ''}`.trim();

      return {
        id: cuota.id,
        estudiante: nombreEstudiante,
        tutor: cuota.tutor_nombre || 'Tutor registrado',
        nombre_tutor: cuota.tutor_nombre,
        telefono: cuota.telefono,
        mes: cuota.nombre_mes,
        monto_pendiente: parseFloat(cuota.monto_pendiente || cuota.monto_esperado),
        fecha_vencimiento: cuota.fecha_vencimiento,
        fecha_notificacion: fechaNotificacion.toISOString().split('T')[0],
        dias_restantes: diasRestantes,
        dias_hasta_notificacion: diasHastaNotificacion,
        nivel: cuota.nivel_nombre,
        curso: cuota.curso_nombre,
        bloque: cuota.bloque_nombre,
        estado: cuota.estado,
        tipo_contacto: cuota.tipo_contacto
      };
    });

    // Agrupar por tutor para contar notificaciones
    const notificacionesPorTutor = {};
    notificacionesProgramadas.forEach(notif => {
      const key = `${notif.tutor}_${notif.telefono || 'sin_telefono'}`;
      if (!notificacionesPorTutor[key]) {
        notificacionesPorTutor[key] = {
          tutor: notif.tutor,
          telefono: notif.telefono,
          estudiantes: [],
          total_notificaciones: 0
        };
      }
      notificacionesPorTutor[key].estudiantes.push(notif);
      notificacionesPorTutor[key].total_notificaciones++;
    });

    res.json({
      ok: true,
      total_notificaciones: notificacionesProgramadas.length,
      total_tutores: Object.keys(notificacionesPorTutor).length,
      notificaciones: notificacionesProgramadas,
      agrupadas_por_tutor: Object.values(notificacionesPorTutor),
      dias_anticipacion_sistema: diasAnticipacionSistema,
      dias_anticipacion_vista: parseInt(dias_anticipacion_vista),
      fecha_desde: fechaHoyStr,
      fecha_hasta: fechaLimiteVistaStr
    });
  } catch (error) {
    console.error('Error al obtener notificaciones programadas:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al obtener notificaciones programadas',
      error: error.message
    });
  }
});

module.exports = router;

