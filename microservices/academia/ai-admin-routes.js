// ===== RUTAS DE AGENTE INTELIGENTE - NODE.JS =====
// Migrado desde Python/Flask

const express = require('express');
const pool = require('./config');
const {
  ejecutarAgente,
  registrarConsulta,
  obtenerReportesConsultas,
  inicializarAgente
} = require('./agenteInteligente');
const ConversacionManager = require('./conversacionManager');
const { authMiddleware } = require('../../middleware/auth');
const NotificacionesService = require('./notificacionesService');
const { obtenerInstancia } = require('./whatsappServiceSingleton');

const router = express.Router();
const conversacionManager = new ConversacionManager(pool);

// Inicializar servicios de notificaciones
let notificacionesService = null;

// De-duplicador: solicitudes en curso por clave. Si llega duplicado, espera el resultado en lugar de bloquear.
const solicitudesEnCurso = new Map(); // key -> Promise<{ respuesta, herramienta, clasificacion, tiempo_ms }>
const TIEMPO_ESPERA_DUPLICADO = 90000; // 90 segundos para esperar consulta en curso

function inicializarServiciosNotificaciones() {
  const whatsappService = obtenerInstancia();
  if (!notificacionesService) {
    notificacionesService = new NotificacionesService(whatsappService);
  }
}

// Middleware para verificar permisos según rol
const verificarPermisos = (rolesPermitidos = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        message: 'Usuario no autenticado'
      });
    }

    // Si no se especifican roles, permitir a todos los usuarios autenticados
    if (rolesPermitidos.length === 0) {
      return next();
    }

    // Verificar si el rol del usuario está permitido
    if (!rolesPermitidos.includes(req.user.rol)) {
      return res.status(403).json({
        ok: false,
        message: `No tienes permisos para acceder a este recurso. Rol requerido: ${rolesPermitidos.join(', ')}`
      });
    }

    next();
  };
};

// Estado de inicialización del agente para el panel admin
let agenteInicializado = false;
let inicializacionEnCurso = false;

async function asegurarAgenteInicializado() {
  if (agenteInicializado) return;
  if (inicializacionEnCurso) {
    // Si ya se está inicializando, esperar a que termine (máximo 60s)
    let intentos = 0;
    const maxIntentos = 120;
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        intentos++;
        if (agenteInicializado) {
          clearInterval(timer);
          return resolve();
        }
        if (!inicializacionEnCurso && !agenteInicializado) {
          // Falló la inicialización
          clearInterval(timer);
          return reject(new Error('Inicialización del agente fallida'));
        }
        if (intentos >= maxIntentos) {
          clearInterval(timer);
          return reject(new Error('Timeout esperando inicialización del agente'));
        }
      }, 500);
    });
  }

  inicializacionEnCurso = true;
  try {
   
    await inicializarAgente();

    // Inicializar gestor de conversaciones
    await conversacionManager.inicializar();
    // Inicializar tabla de documentos
    const documentosService = require('./documentosService');
    await documentosService.inicializarTablaDocumentos();

    // Limpiar sesiones antiguas cada 24 horas
    setInterval(async () => {
      await conversacionManager.limpiarSesionesAntiguas();
    }, 24 * 60 * 60 * 1000);

    agenteInicializado = true;
    console.log('✅ [ai-admin] Agente para panel admin inicializado correctamente');
  } catch (error) {
    console.error('❌ [ai-admin] Error al inicializar agente para panel admin:', error);
    throw error;
  } finally {
    inicializacionEnCurso = false;
  }
}

// Endpoint principal de chat para admin (requiere autenticación)
router.post('/chat', authMiddleware, verificarPermisos(), async (req, res) => {
  const { mensaje, sesion_id } = req.body;

  // De-duplicación: si ya hay una consulta idéntica en curso, esperar su resultado en lugar de bloquear
  const deduplicacionKey = `${sesion_id || 'new'}-${mensaje.trim()}`;
  const promesaExistente = solicitudesEnCurso.get(deduplicacionKey);
  if (promesaExistente) {
    console.log('⏳ [chat] Petición duplicada: esperando resultado de consulta en curso...');
    try {
      const resultado = await Promise.race([
        promesaExistente,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), TIEMPO_ESPERA_DUPLICADO))
      ]);
      return res.json({
        ok: true,
        respuesta: resultado.respuesta,
        herramienta_usada: resultado.herramienta,
        clasificacion: resultado.clasificacion,
        tiempo_respuesta_ms: resultado.tiempo_ms,
        sesion_id: resultado.sesion_id,
        duplicado: true
      });
    } catch (e) {
      if (e.message === 'Timeout') {
        return res.status(504).json({
          ok: false,
          message: 'Tiempo de espera agotado. Por favor intenta de nuevo.'
        });
      }
      throw e;
    }
  }

  // Primera petición: ejecutar procesamiento y guardar promesa para duplicados
  const promesaProcesamiento = (async () => {
    if (!agenteInicializado) {
      await asegurarAgenteInicializado();
    }
    const usuarioId = req.user?.id || null;
    let sesionId = sesion_id;
    if (!sesionId) {
      sesionId = await conversacionManager.obtenerOCrearSesion(
        usuarioId,
        'admin',
        null,
        {
          usuario_id: usuarioId,
          usuario: req.user.usuario,
          nombre: req.user.nombre,
          rol: req.user.rol
        }
      );
    }

    // Obtener historial de conversación
    const historial = await conversacionManager.obtenerHistorial(sesionId, 5);

    // Preparar información del usuario para personalizar respuestas
    const infoUsuario = {
      id: usuarioId,
      usuario: req.user.usuario,
      nombre: req.user.nombre,
      rol: req.user.rol,
      rol_id: req.user.rol_id
    };

    // Verificar si es un comando de notificación
    const mensajeLower = mensaje.toLowerCase().trim();
    const esComandoNotificacion = [
      'notificar', 'notifica', 'notifique', 'enviar mensaje', 'enviar mensajes',
      'comunicar', 'comunica', 'avisar', 'avisa', 'avisar a todos',
      'notificar a todos', 'notificar a los padres', 'notificar a padres',
      'enviar comunicado', 'comunicado', 'anuncio', 'anunciar',
      'informar', 'informa', 'envía', 'envia', 'mandar', 'manda'
    ].some(p => mensajeLower.includes(p));

    let resultado;

    // Si es comando de notificación y el usuario tiene permisos, procesarlo
    if (esComandoNotificacion && (infoUsuario.rol === 'Administrador' || infoUsuario.rol === 'Director')) {
      inicializarServiciosNotificaciones();

      // Extraer mensaje y fecha del comando usando el agente
      try {
        // Extraer el mensaje manualmente primero (más confiable)
        // Caso frecuente: "Comunica a toda la unidad educativa que mañana no hay clases"
        let mensajeExtraido = '';
        const matchUnidadQue = mensaje.match(
          /(?:comunica|comunicar|avisa|avisar|informa|informar)\s+a\s+toda\s+la\s+(?:unidad\s+educativa|comunidad\s+educativa)\s+que\s+(.+)/i
        );
        if (matchUnidadQue && matchUnidadQue[1]) {
          mensajeExtraido = matchUnidadQue[1].trim();
        }

        if (!mensajeExtraido) {
          const matchEstNivelQue = mensaje.match(
            /(?:comunica|comunicar|avisa|avisar|informa|informar)\s+a\s+los\s+estudiantes\s+de(?:l)?\s+((?:primer|primero|segundo|tercer|tercero|cuarto|quinto|sexto)\s+nivel)\s+que\s+(.+)/i
          );
          if (matchEstNivelQue && matchEstNivelQue[2]) {
            mensajeExtraido = matchEstNivelQue[2].trim();
          }
        }

        if (!mensajeExtraido) {
          const matchNivelQue = mensaje.match(
            /(?:comunica|comunicar|avisa|avisar|informa|informar)\s+(?:a\s+)?(?:los\s+)?(?:estudiantes|padres|tutores|familias)\s+de(?:l)?\s+((?:primer|primero|segundo|tercer|tercero|cuarto|quinto|sexto)\s+nivel)[^.,]*?\s+que\s+(.+)/i
          );
          if (matchNivelQue && matchNivelQue[2]) {
            mensajeExtraido = matchNivelQue[2].trim();
          }
        }

        if (!mensajeExtraido) {
          mensajeExtraido = mensaje
            .replace(/^(hola|buenos\s+d[ií]as|buenas\s+tardes)\s*,?\s*/i, '')
            .replace(/^(puedes|puede|quiero\s+que)\s+(avisar|notificar|comunicar|enviar)\s*(a\s*(todos|los\s*(padres|tutores)))?\s*(que|:)?\s*/i, '')
            .replace(/^(avisar|notificar|comunicar|enviar)\s*(a\s*(todos|los\s*(padres|tutores)))?\s*(que|:)?\s*/i, '')
            .replace(/\s*(a\s*)?(todos\s*)?(los\s*)?(padres|tutores|padres\s+o\s+tutores)\s+(que|:)?\s*/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }

        // Si el mensaje extraído está vacío o es muy corto, usar el mensaje original
        if (!mensajeExtraido || mensajeExtraido.length < 10) {
          mensajeExtraido = mensaje
            .replace(/^(hola|buenos\s+d[ií]as|buenas\s+tardes)\s*,?\s*/i, '')
            .replace(/^(puedes|puede|quiero\s+que)\s+/i, '')
            .replace(/^(avisar|notificar|comunicar|enviar)\s*/i, '')
            .replace(/\s*(a\s*)?(todos\s*)?(los\s*)?(padres|tutores|padres\s+o\s+tutores)\s+(que|:)?\s*/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }

        // Mejorar el mensaje para que sea más profesional
        // Capitalizar primera letra
        if (mensajeExtraido.length > 0) {
          mensajeExtraido = mensajeExtraido.charAt(0).toUpperCase() + mensajeExtraido.slice(1);
        }

        // Agregar punto final si no lo tiene
        if (mensajeExtraido && !mensajeExtraido.match(/[.!?]$/)) {
          mensajeExtraido += '.';
        }

        console.log('📝 Mensaje extraído y mejorado:', mensajeExtraido);

        // Usar el agente para extraer información adicional (fecha y filtros)
        const promptExtraccion = `Analiza el siguiente comando de notificación y extrae SOLO la fecha y filtros (si existen). NO modifiques el mensaje.

Comando: "${mensaje}"
Mensaje extraído: "${mensajeExtraido}"

IMPORTANTE: 
- Si el mensaje dice "a todos", "todos los padres", "toda la unidad educativa", "toda la comunidad educativa", NO agregues filtros académicos (nivel_id, curso_id, bloque_id, turno = null)
- Solo agrega filtros si el mensaje menciona ESPECÍFICAMENTE un nivel, curso, bloque o turno (mañana/tarde)
- Los IDs deben ser los de la base de datos si los conoces; si el usuario dice solo "primer nivel", deja nivel_id null y el sistema puede igual enviar si el texto es claro (prioriza turno en "turno mañana" / "de la mañana")
- Si dice "turno mañana", "jornada mañana", "de la mañana" (sin ser la palabra fecha "mañana"), pon turno: "Mañana" o el texto que coincida con inscripciones.turno
- Si menciona "mañana" como FECHA (no como turno), calcula la fecha de mañana en formato YYYY-MM-DD

Responde SOLO en formato JSON:
{
  "fecha": "YYYY-MM-DD o null",
  "filtros": {
    "nivel_id": número o null,
    "curso_id": número o null,
    "bloque_id": número o null,
    "turno": "texto o null (ej. Mañana, Tarde según inscripciones)"
  }
}`;


        const resultadoExtraccion = await ejecutarAgente(
          promptExtraccion,
          pool,
          usuarioId,
          null,
          [], // NO usar historial para extracción, evita duplicados
          infoUsuario
        );

        // Intentar parsear JSON de la respuesta del agente (solo fecha y filtros)
        let datosNotificacion = {
          mensaje: mensajeExtraido, // Usar el mensaje extraído manualmente
          fecha: null,
          filtros: {}
        };

        try {
          // Buscar JSON en la respuesta del agente
          const jsonMatch = resultadoExtraccion.respuesta.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const datosAgente = JSON.parse(jsonMatch[0]);
            // Solo usar fecha y filtros del agente, el mensaje ya lo tenemos
            datosNotificacion.fecha = datosAgente.fecha || null;
            datosNotificacion.filtros = datosAgente.filtros || {};
          }
        } catch (parseError) {
          console.log('⚠️ No se pudo parsear respuesta del agente, usando valores por defecto');
          // Mantener el mensaje extraído manualmente
        }

        // VALIDACIÓN CRÍTICA: Si el mensaje dice "a todos", eliminar TODOS los filtros
        const mensajeLower = mensaje.toLowerCase();
        const tieneTodos = mensajeLower.includes('a todos') ||
          mensajeLower.includes('todos los padres') ||
          mensajeLower.includes('todos los tutores') ||
          mensajeLower.includes('a todos los padres') ||
          mensajeLower.includes('a todos los tutores') ||
          /\btoda\s+la\s+unidad\s+educativa\b/i.test(mensaje) ||
          /\btoda\s+la\s+comunidad\s+educativa\b/i.test(mensaje) ||
          /\ba\s+toda\s+la\s+unidad\b/i.test(mensajeLower);

        if (tieneTodos) {
          console.log('🔍 Detectado "a todos" en el mensaje - eliminando TODOS los filtros académicos');
          console.log('📋 Filtros ANTES de eliminar:', datosNotificacion.filtros);
          datosNotificacion.filtros = {};
          console.log('✅ Filtros DESPUÉS de eliminar:', datosNotificacion.filtros);
        } else {
          console.log('📋 Filtros extraídos por el agente (sin "a todos"):', datosNotificacion.filtros);
        }

        // Extraer fecha si está en el mensaje (mañana o fecha específica)
        if (!datosNotificacion.fecha) {
          // Buscar fecha en formato DD/MM/YYYY
          const fechaMatch = mensaje.match(/(\d{2}\/\d{2}\/\d{4})/);
          if (fechaMatch) {
            const [dia, mes, anio] = fechaMatch[1].split('/');
            datosNotificacion.fecha = `${anio}-${mes}-${dia}`;
          } else if (mensajeLower.includes('mañana')) {
            // Si dice "mañana", calcular la fecha de mañana
            const mañana = new Date();
            mañana.setDate(mañana.getDate() + 1);
            datosNotificacion.fecha = mañana.toISOString().split('T')[0];
          }
        }

        console.log('📤 Datos de notificación finales:', {
          mensaje: datosNotificacion.mensaje?.substring(0, 50) + '...',
          fecha: datosNotificacion.fecha,
          filtros: datosNotificacion.filtros
        });

        // Enviar notificación
        const mensajePersonalizado = notificacionesService.generarMensajePersonalizado(
          datosNotificacion.mensaje,
          datosNotificacion.fecha
        );

        const resultadoNotificacion = await notificacionesService.enviarNotificacionManual(
          mensajePersonalizado,
          datosNotificacion.filtros || {}
        );

        resultado = {
          respuesta: `✅ Notificación enviada exitosamente:\n\n` +
            `📤 ${resultadoNotificacion.enviadas} mensajes enviados\n` +
            `👥 ${resultadoNotificacion.total_telefonos} contactos notificados\n` +
            `📊 ${resultadoNotificacion.total_estudiantes} estudiantes incluidos\n` +
            (resultadoNotificacion.errores > 0 ? `\n⚠️ ${resultadoNotificacion.errores} errores` : ''),
          herramienta: 'notificacion',
          clasificacion: 'notificacion',
          tiempo_ms: 0
        };
      } catch (error) {
        console.error('Error procesando comando de notificación:', error);
        // Asegurarse de que el error no afecte la conexión de WhatsApp
        const errorMessage = error.message || 'Error desconocido';
        resultado = {
          respuesta: `❌ Error al procesar el comando de notificación: ${errorMessage}\n\n` +
            `Por favor, verifica que WhatsApp esté conectado y que el mensaje sea válido.\n\n` +
            `Si el problema persiste, verifica la conexión de la base de datos.`,
          herramienta: 'notificacion',
          clasificacion: 'notificacion',
          tiempo_ms: 0
        };
        // No relanzar el error para evitar que afecte otros procesos
      }
    } else {
      resultado = await ejecutarAgente(
        mensaje.trim(),
        pool,
        usuarioId,
        null,
        historial,
        infoUsuario
      );
    }
    return { ...resultado, sesion_id: sesionId };
  })()
    .finally(() => solicitudesEnCurso.delete(deduplicacionKey));

  solicitudesEnCurso.set(deduplicacionKey, promesaProcesamiento);

  try {
    const resultadoCompleto = await promesaProcesamiento;

    // Guardar mensaje del usuario
    await conversacionManager.agregarMensaje(
      resultadoCompleto.sesion_id,
      'usuario',
      mensaje.trim()
    );

    // Guardar respuesta del asistente
    await conversacionManager.agregarMensaje(
      resultadoCompleto.sesion_id,
      'asistente',
      resultadoCompleto.respuesta,
      resultadoCompleto.herramienta,
      resultadoCompleto.clasificacion,
      { tiempo_respuesta_ms: resultadoCompleto.tiempo_ms }
    );

    // Registrar consulta
    registrarConsulta(
      mensaje,
      resultadoCompleto.respuesta,
      resultadoCompleto.herramienta,
      resultadoCompleto.clasificacion,
      resultadoCompleto.tiempo_ms,
      req.user?.id || null
    );

    return res.json({
      ok: true,
      respuesta: resultadoCompleto.respuesta,
      herramienta_usada: resultadoCompleto.herramienta,
      clasificacion: resultadoCompleto.clasificacion,
      tiempo_respuesta_ms: resultadoCompleto.tiempo_ms,
      sesion_id: resultadoCompleto.sesion_id
    });
  } catch (error) {
    console.error('Error en agente inteligente:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo obtener respuesta del agente inteligente.',
      error: error.message
    });
  }
});

// Endpoint para obtener reportes de consultas (requiere autenticación, solo Administrador y Director)
router.get('/reportes/consultas', authMiddleware, verificarPermisos(['Administrador', 'Director']), async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 100;
    const reportes = obtenerReportesConsultas(limite);
    res.json(reportes);
  } catch (error) {
    console.error('Error al obtener reportes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check del agente
router.get('/health', (req, res) => {
  res.json({
    ok: agenteInicializado,
    message: agenteInicializado
      ? 'Agente Inteligente operativo'
      : 'Agente Inteligente inicializando...',
    modelo: 'agente-inteligente',
    herramientas: ['fecha_hora', 'base_datos', 'reglamento'],
    conversacion: 'habilitada'
  });
});

// Endpoint para obtener historial de una sesión (requiere autenticación)
router.get('/sesion/:sesionId/historial', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { sesionId } = req.params;
    const limite = parseInt(req.query.limite) || 20;

    const historial = await conversacionManager.obtenerHistorial(sesionId, limite);
    const infoSesion = await conversacionManager.obtenerInfoSesion(sesionId);

    return res.json({
      ok: true,
      sesion: infoSesion,
      historial: historial
    });
  } catch (error) {
    console.error('Error al obtener historial:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al obtener historial de conversación.',
      error: error.message
    });
  }
});

// Endpoint para obtener sugerencias del agente para preinscripción
router.get('/sugerencias-preinscripcion/:estudianteId', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const { estudianteId } = req.params;

    // Obtener historial del año anterior (si estamos en 2026, buscar 2025)
    const anioActual = new Date().getFullYear();
    const anioAnterior = anioActual - 1;

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
        e.nombre as estudiante_nombre,
        e.apellido_paterno,
        e.apellido_materno
      FROM inscripciones i
      LEFT JOIN nivel n ON i.nivel_id = n.id
      LEFT JOIN curso c ON i.curso_id = c.id
      LEFT JOIN bloque b ON i.bloque_id = b.id
      LEFT JOIN becas bc ON i.id_beca = bc.id
      LEFT JOIN estudiantes e ON i.estudiante_id = e.id
      WHERE i.estudiante_id = ?
        AND (
          (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
          OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
        )
      ORDER BY i.fecha_inscripcion DESC
      LIMIT 1
    `, [estudianteId, anioAnterior, anioAnterior]);

    if (inscripciones.length === 0) {
      return res.json({
        ok: true,
        tiene_historial: false,
        sugerencias: []
      });
    }

    const inscripcionAnterior = inscripciones[0];

    // Obtener siguiente nivel
    const [siguienteNivel] = await pool.query(`
      SELECT id, nombre 
      FROM nivel 
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 1
    `, [inscripcionAnterior.nivel_id]);

    // Construir sugerencias estructuradas SOLO con información directa de la BD
    // NO llamar al agente para evitar mensajes genéricos
    const sugerencias = [];

    if (siguienteNivel.length > 0) {
      sugerencias.push({
        tipo: 'nivel',
        mensaje: `Este estudiante le corresponde el siguiente nivel: ${siguienteNivel[0].nombre}`,
        valor: siguienteNivel[0].id
      });
    }

    if (inscripcionAnterior.turno) {
      sugerencias.push({
        tipo: 'turno',
        mensaje: `Este estudiante estuvo en el turno "${inscripcionAnterior.turno}" anteriormente`,
        valor: inscripcionAnterior.turno
      });
    }

    if (inscripcionAnterior.beca_descripcion) {
      sugerencias.push({
        tipo: 'beca',
        mensaje: `Este estudiante tuvo la beca "${inscripcionAnterior.beca_descripcion} (${inscripcionAnterior.beca_descuento}%)" el año pasado`,
        valor: inscripcionAnterior.id_beca
      });
    }

    res.json({
      ok: true,
      tiene_historial: true,
      inscripcion_anterior: inscripcionAnterior,
      siguiente_nivel: siguienteNivel.length > 0 ? siguienteNivel[0] : null,
      sugerencias: sugerencias
    });

  } catch (error) {
    console.error('Error al obtener sugerencias:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener sugerencias del agente',
      error: error.message
    });
  }
});

// Endpoint para crear nueva sesión (requiere autenticación)
router.post('/sesion/nueva', authMiddleware, verificarPermisos(), async (req, res) => {
  try {
    const usuarioId = req.user?.id || null;
    const { tipo_sesion = 'admin', identificador_externo = null, contexto = {} } = req.body;

    const sesionId = await conversacionManager.obtenerOCrearSesion(
      usuarioId,
      tipo_sesion,
      identificador_externo,
      contexto
    );

    return res.json({
      ok: true,
      sesion_id: sesionId
    });
  } catch (error) {
    console.error('Error al crear sesión:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error al crear sesión.',
      error: error.message
    });
  }
});

module.exports = router;
