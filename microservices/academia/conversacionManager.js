// ===== GESTIÓN DE SESIONES Y HISTORIAL CONVERSACIONAL =====
// Maneja sesiones de conversación y historial de mensajes

const crypto = require('crypto');

class ConversacionManager {
  constructor(pool) {
    this.pool = pool;
    this.sesionesEnMemoria = new Map(); // Cache en memoria para acceso rápido
    this.inicializado = false;
  }

  // Inicializar tablas necesarias
  async inicializar() {
    if (this.inicializado) return;

    try {
      // Crear tabla de sesiones
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sesiones_conversacion (
          id VARCHAR(64) PRIMARY KEY,
          usuario_id INT,
          tipo_sesion ENUM('admin', 'whatsapp', 'web') DEFAULT 'admin',
          identificador_externo VARCHAR(255) COMMENT 'Número de teléfono para WhatsApp, etc.',
          contexto JSON COMMENT 'Información adicional del contexto',
          creada_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          actualizada_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_usuario (usuario_id),
          INDEX idx_tipo (tipo_sesion),
          INDEX idx_identificador (identificador_externo),
          INDEX idx_actualizada (actualizada_en)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Crear tabla de mensajes
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mensajes_conversacion (
          id INT AUTO_INCREMENT PRIMARY KEY,
          sesion_id VARCHAR(64) NOT NULL,
          rol ENUM('usuario', 'asistente') NOT NULL,
          mensaje TEXT NOT NULL,
          herramienta_usada VARCHAR(50),
          clasificacion VARCHAR(50),
          metadata JSON COMMENT 'Información adicional (tiempo_respuesta, etc.)',
          creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_sesion (sesion_id),
          INDEX idx_creado (creado_en),
          FOREIGN KEY (sesion_id) REFERENCES sesiones_conversacion(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Log silenciado
      this.inicializado = true;
    } catch (error) {
      console.error('❌ Error al inicializar tablas de conversación:', error);
      throw error;
    }
  }

  // Crear o obtener sesión
  async obtenerOCrearSesion(usuarioId = null, tipoSesion = 'admin', identificadorExterno = null, contexto = {}) {
    await this.inicializar();

    // Si hay identificador externo, buscar sesión existente activa (últimas 24 horas)
    if (identificadorExterno) {
      const [sesionesExistentes] = await this.pool.query(`
        SELECT id FROM sesiones_conversacion
        WHERE identificador_externo = ? 
          AND tipo_sesion = ?
          AND actualizada_en > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        ORDER BY actualizada_en DESC
        LIMIT 1
      `, [identificadorExterno, tipoSesion]);

      if (sesionesExistentes.length > 0) {
        const sesionId = sesionesExistentes[0].id;
        // Actualizar timestamp
        await this.pool.query(`
          UPDATE sesiones_conversacion 
          SET actualizada_en = NOW() 
          WHERE id = ?
        `, [sesionId]);
        return sesionId;
      }
    }

    // Crear nueva sesión
    const sesionId = crypto.randomBytes(32).toString('hex');
    
    await this.pool.query(`
      INSERT INTO sesiones_conversacion (id, usuario_id, tipo_sesion, identificador_externo, contexto)
      VALUES (?, ?, ?, ?, ?)
    `, [sesionId, usuarioId, tipoSesion, identificadorExterno, JSON.stringify(contexto)]);

    return sesionId;
  }

  // Agregar mensaje a la sesión
  async agregarMensaje(sesionId, rol, mensaje, herramientaUsada = null, clasificacion = null, metadata = {}) {
    await this.inicializar();

    await this.pool.query(`
      INSERT INTO mensajes_conversacion (sesion_id, rol, mensaje, herramienta_usada, clasificacion, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [sesionId, rol, mensaje, herramientaUsada, clasificacion, JSON.stringify(metadata)]);

    // Actualizar timestamp de sesión
    await this.pool.query(`
      UPDATE sesiones_conversacion 
      SET actualizada_en = NOW() 
      WHERE id = ?
    `, [sesionId]);

    // Limpiar cache de esta sesión
    this.sesionesEnMemoria.delete(sesionId);
  }

  // Obtener historial de conversación (últimos N mensajes)
  async obtenerHistorial(sesionId, limite = 10) {
    await this.inicializar();

    // Verificar cache
    const cacheKey = `${sesionId}_${limite}`;
    if (this.sesionesEnMemoria.has(cacheKey)) {
      return this.sesionesEnMemoria.get(cacheKey);
    }

    const [mensajes] = await this.pool.query(`
      SELECT rol, mensaje, herramienta_usada, clasificacion, metadata, creado_en
      FROM mensajes_conversacion
      WHERE sesion_id = ?
      ORDER BY creado_en DESC
      LIMIT ?
    `, [sesionId, limite]);

    // Invertir para tener orden cronológico
    const historial = mensajes.reverse().map(msg => {
      let metadata = {};
      if (msg.metadata != null) {
        if (typeof msg.metadata === 'object') {
          metadata = msg.metadata;
        } else if (typeof msg.metadata === 'string') {
          try {
            metadata = JSON.parse(msg.metadata);
          } catch (_) {
            metadata = {};
          }
        }
      }
      return {
        rol: msg.rol,
        mensaje: msg.mensaje,
        herramienta_usada: msg.herramienta_usada,
        clasificacion: msg.clasificacion,
        metadata,
        timestamp: msg.creado_en
      };
    });

    // Guardar en cache (expira después de 5 minutos)
    this.sesionesEnMemoria.set(cacheKey, historial);
    setTimeout(() => {
      this.sesionesEnMemoria.delete(cacheKey);
    }, 5 * 60 * 1000);

    return historial;
  }

  // Obtener historial formateado para contexto del agente
  async obtenerHistorialParaContexto(sesionId, limite = 5) {
    const historial = await this.obtenerHistorial(sesionId, limite);
    
    if (historial.length === 0) {
      return '';
    }

    // Formatear historial para incluir en el prompt
    let contexto = '\n\nHISTORIAL DE CONVERSACIÓN PREVIA:\n';
    historial.forEach((msg, idx) => {
      const rol = msg.rol === 'usuario' ? 'Usuario' : 'Asistente';
      contexto += `${rol}: ${msg.mensaje}\n`;
    });
    contexto += '\nIMPORTANTE: Considera el historial anterior para dar respuestas coherentes y contextualizadas.\n';

    return contexto;
  }

  // Limpiar sesiones antiguas (más de 30 días sin actividad)
  async limpiarSesionesAntiguas() {
    await this.inicializar();

    try {
      const [resultado] = await this.pool.query(`
        DELETE FROM sesiones_conversacion
        WHERE actualizada_en < DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      console.log(`🧹 Limpieza: ${resultado.affectedRows} sesiones antiguas eliminadas`);
      return resultado.affectedRows;
    } catch (error) {
      console.error('Error al limpiar sesiones antiguas:', error);
      return 0;
    }
  }

  // Obtener información de sesión
  async obtenerInfoSesion(sesionId) {
    await this.inicializar();

    const [sesiones] = await this.pool.query(`
      SELECT id, usuario_id, tipo_sesion, identificador_externo, contexto, creada_en, actualizada_en
      FROM sesiones_conversacion
      WHERE id = ?
    `, [sesionId]);

    if (sesiones.length === 0) {
      return null;
    }

    const sesion = sesiones[0];
    let contexto = {};
    if (sesion.contexto != null) {
      if (typeof sesion.contexto === 'object') {
        contexto = sesion.contexto;
      } else if (typeof sesion.contexto === 'string') {
        try {
          contexto = JSON.parse(sesion.contexto);
        } catch (_) {
          contexto = {};
        }
      }
    }
    return {
      id: sesion.id,
      usuario_id: sesion.usuario_id,
      tipo_sesion: sesion.tipo_sesion,
      identificador_externo: sesion.identificador_externo,
      contexto,
      creada_en: sesion.creada_en,
      actualizada_en: sesion.actualizada_en
    };
  }

  // Actualiza parcialmente el contexto de la sesión (merge superficial).
  // Se usa para flags de seguridad como `ci_requerida` / `ci_verificada`.
  async actualizarContextoSesion(sesionId, contextoParcial = {}) {
    await this.inicializar();

    if (!sesionId) {
      throw new Error('sesionId es requerido');
    }

    const info = await this.obtenerInfoSesion(sesionId);
    const contextoActual = (info && info.contexto) ? info.contexto : {};
    const contextoMergeado = {
      ...contextoActual,
      ...(contextoParcial && typeof contextoParcial === 'object' ? contextoParcial : {})
    };

    await this.pool.query(`
      UPDATE sesiones_conversacion
      SET contexto = ?, actualizada_en = NOW()
      WHERE id = ?
    `, [JSON.stringify(contextoMergeado), sesionId]);

    // No toca el historial en memoria; solo el contexto.
  }

  // Buscar sesión por identificador externo (útil para WhatsApp)
  async buscarSesionPorIdentificador(identificadorExterno, tipoSesion = 'whatsapp') {
    await this.inicializar();

    const [sesiones] = await this.pool.query(`
      SELECT id FROM sesiones_conversacion
      WHERE identificador_externo = ? AND tipo_sesion = ?
      ORDER BY actualizada_en DESC
      LIMIT 1
    `, [identificadorExterno, tipoSesion]);

    if (sesiones.length > 0) {
      return sesiones[0].id;
    }

    return null;
  }
}

module.exports = ConversacionManager;

