// ===== RUTAS DE AGENTE INTELIGENTE CON LANGCHAIN - PARA DIRECTOR Y SECRETARIA =====
// Implementación separada que NO afecta el agente actual (agenteInteligente.js)

const express = require('express');
const fs = require('fs');
const pool = require('./config');
const {
  ejecutarAgenteLangChain,
  inicializarAgenteLangChain
} = require('./agenteInteligenteLangChain');
const ConversacionManager = require('./conversacionManager');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();
const conversacionManager = new ConversacionManager(pool);

// Estado de inicialización
let agenteInicializado = false;
let inicializacionEnCurso = false;

// Middleware para verificar permisos (Director, Secretaria y ahora también Administrador)
const verificarPermisosDirectorSecretaria = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      message: 'Usuario no autenticado'
    });
  }

  if (!['Director', 'Secretaria', 'Administrador'].includes(req.user.rol)) {
    return res.status(403).json({
      ok: false,
      message: 'Este agente está disponible solo para Directores, Secretarias y Administradores'
    });
  }

  next();
};

// Asegurar que el agente esté inicializado
async function asegurarAgenteInicializado() {
  if (agenteInicializado) return;
  
  if (inicializacionEnCurso) {
    // Esperar a que termine la inicialización
    let intentos = 0;
    const maxIntentos = 60; // 30 segundos máximo
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        intentos++;
        if (agenteInicializado) {
          clearInterval(timer);
          return resolve();
        }
        if (!inicializacionEnCurso && !agenteInicializado) {
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
    console.log('🔄 [LangChain Routes] Inicializando agente LangChain...');
    
    await inicializarAgenteLangChain();
    
    // Inicializar gestor de conversaciones
    await conversacionManager.inicializar();
    
    agenteInicializado = true;
    console.log('✅ [LangChain Routes] Agente LangChain inicializado correctamente');
  } catch (error) {
    console.error('❌ [LangChain Routes] Error al inicializar agente:', error);
    throw error;
  } finally {
    inicializacionEnCurso = false;
  }
}

// Endpoint principal de chat para Director/Secretaria con LangChain
router.post('/chat', authMiddleware, verificarPermisosDirectorSecretaria, async (req, res) => {
  try {
    await asegurarAgenteInicializado();
    
    const { pregunta, sesion_id } = req.body;
    const usuarioId = req.user.id;
    const rolUsuario = req.user.rol;
    const nombreUsuario = req.user.nombre;
    
    if (!pregunta || pregunta.trim().length === 0) {
      return res.status(400).json({
        ok: false,
        message: 'La pregunta es requerida'
      });
    }
    
    // Obtener o crear sesión de conversación
    let sesionId = sesion_id;
    if (!sesionId) {
      sesionId = await conversacionManager.obtenerOCrearSesion(
        usuarioId,
        'web',
        `usuario_${usuarioId}`,
        {
          rol: rolUsuario,
          nombre: nombreUsuario
        }
      );
    }
    
    // Obtener historial de conversación (últimos 10 mensajes)
    const historial = await conversacionManager.obtenerHistorial(sesionId, 10);
    
    // Preparar información del usuario para el agente
    const infoUsuario = {
      id: usuarioId,
      rol: rolUsuario,
      nombre: nombreUsuario
    };
    
    // Ejecutar agente LangChain
    const inicioTiempo = Date.now();
    const resultado = await ejecutarAgenteLangChain(
      pregunta.trim(),
      infoUsuario,
      historial
    );
    const tiempoTotal = Date.now() - inicioTiempo;
    
    // Guardar mensaje del usuario
    await conversacionManager.agregarMensaje(
      sesionId,
      'usuario',
      pregunta.trim()
    );
    
    // Guardar respuesta del asistente
    await conversacionManager.agregarMensaje(
      sesionId,
      'asistente',
      resultado.respuesta,
      resultado.herramienta,
      resultado.clasificacion,
      {
        tiempo_respuesta_ms: resultado.tiempo_ms,
        herramientas_usadas: resultado.herramientas_usadas
      }
    );
    
    // Responder al cliente (incluir documentoAsistencia si se generó lista de asistencia)
    res.json({
      ok: true,
      respuesta: resultado.respuesta,
      sesion_id: sesionId,
      herramienta: resultado.herramienta,
      clasificacion: resultado.clasificacion,
      tiempo_ms: tiempoTotal,
      herramientas_usadas: resultado.herramientas_usadas || [],
      documentoAsistencia: resultado.documentoAsistencia || null
    });
    
  } catch (error) {
    console.error('❌ [LangChain Routes] Error en endpoint /chat:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al procesar la consulta',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Endpoint para obtener historial de conversación
router.get('/historial/:sesion_id', authMiddleware, verificarPermisosDirectorSecretaria, async (req, res) => {
  try {
    const { sesion_id } = req.params;
    const historial = await conversacionManager.obtenerHistorial(sesion_id, 50);
    
    res.json({
      ok: true,
      historial: historial
    });
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener historial'
    });
  }
});

// Endpoint para obtener sesiones del usuario
router.get('/sesiones', authMiddleware, verificarPermisosDirectorSecretaria, async (req, res) => {
  try {
    const usuarioId = req.user.id;
    const sesiones = await conversacionManager.obtenerSesionesPorUsuario(usuarioId, 'web');
    
    res.json({
      ok: true,
      sesiones: sesiones
    });
  } catch (error) {
    console.error('Error al obtener sesiones:', error);
    res.status(500).json({
      ok: false,
      message: 'Error al obtener sesiones'
    });
  }
});

// Endpoint para verificar estado del agente
router.get('/estado', authMiddleware, verificarPermisosDirectorSecretaria, async (req, res) => {
  try {
    await asegurarAgenteInicializado();
    
    res.json({
      ok: true,
      estado: 'activo',
      agente: 'langchain',
      roles_permitidos: ['Director', 'Secretaria'],
      herramientas_disponibles: [
        'consultar_estadisticas_inscripciones',
        'consultar_estudiantes',
        'consultar_estadisticas_pagos',
        'consultar_pagos_pendientes',
        'generar_documento_asistencia'
      ]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      estado: 'error',
      message: error.message
    });
  }
});

// Endpoint para generar y descargar documento de asistencia
router.post('/generar-asistencia', authMiddleware, verificarPermisosDirectorSecretaria, async (req, res) => {
  try {
    const { nivel, turno, formato = 'pdf', anio } = req.body;
    
    if (!nivel) {
      return res.status(400).json({
        ok: false,
        message: 'El nivel es requerido'
      });
    }
    
    const documentosAsistenciaService = require('./documentosAsistenciaService');
    
    let resultado;
    if (formato === 'word' || formato === 'docx') {
      resultado = await documentosAsistenciaService.generarWordAsistencia(
        nivel,
        turno || null,
        anio ? parseInt(anio) : null
      );
    } else {
      resultado = await documentosAsistenciaService.generarPDFAsistencia(
        nivel,
        turno || null,
        anio ? parseInt(anio) : null
      );
    }
    
    // Leer archivo y enviarlo
    const archivoBuffer = fs.readFileSync(resultado.rutaArchivo);
    const mimeType = formato === 'word' || formato === 'docx' 
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${resultado.nombreArchivo}"`);
    res.send(archivoBuffer);
    
    // Opcional: eliminar archivo después de enviarlo (o mantenerlo para referencia)
    // fs.unlinkSync(resultado.rutaArchivo);
    
  } catch (error) {
    console.error('Error al generar documento de asistencia:', error);
    res.status(500).json({
      ok: false,
      message: error.message || 'Error al generar documento de asistencia'
    });
  }
});

module.exports = router;
