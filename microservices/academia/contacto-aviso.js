// Servicio para gestionar contactos de WhatsApp verificados
const pool = require('./config');

/**
 * Guarda contactos de WhatsApp verificados en la tabla contacto_aviso
 * @param {number} estudianteId - ID del estudiante
 * @param {object} telefonos - Objeto con teléfonos y flags de WhatsApp
 * @param {object} nombres - Objeto con nombres de padre y madre
 */
async function guardarContactosWhatsApp(estudianteId, telefonos, nombres) {
    try {
        // Contacto domicilio padre
        if (telefonos.whatsapp_domicilio_padre && telefonos.telefono_domicilio_padre) {
            await pool.query(`
        INSERT INTO contacto_aviso (estudiante_id, telefono, tipo_contacto, nombre_contacto, activo)
        VALUES (?, ?, 'padre', ?, TRUE)
        ON DUPLICATE KEY UPDATE 
          nombre_contacto = VALUES(nombre_contacto),
          activo = TRUE,
          fecha_verificacion = NOW()
      `, [
                estudianteId,
                telefonos.telefono_domicilio_padre,
                `${nombres.nombre_padre || 'Sr.'} ${nombres.apellido_padre || ''}`.trim()
            ]);
        }

        // Contacto oficina padre
        if (telefonos.whatsapp_oficina_padre && telefonos.telefono_oficina_padre) {
            await pool.query(`
        INSERT INTO contacto_aviso (estudiante_id, telefono, tipo_contacto, nombre_contacto, activo)
        VALUES (?, ?, 'padre_oficina', ?, TRUE)
        ON DUPLICATE KEY UPDATE 
          nombre_contacto = VALUES(nombre_contacto),
          activo = TRUE,
          fecha_verificacion = NOW()
      `, [
                estudianteId,
                telefonos.telefono_oficina_padre,
                `${nombres.nombre_padre || 'Sr.'} ${nombres.apellido_padre || ''}`.trim()
            ]);
        }

        // Contacto domicilio madre
        if (telefonos.whatsapp_domicilio_madre && telefonos.telefono_domicilio_madre) {
            await pool.query(`
        INSERT INTO contacto_aviso (estudiante_id, telefono, tipo_contacto, nombre_contacto, activo)
        VALUES (?, ?, 'madre', ?, TRUE)
        ON DUPLICATE KEY UPDATE 
          nombre_contacto = VALUES(nombre_contacto),
          activo = TRUE,
          fecha_verificacion = NOW()
      `, [
                estudianteId,
                telefonos.telefono_domicilio_madre,
                `${nombres.nombre_madre || 'Sra.'} ${nombres.apellido_madre || ''}`.trim()
            ]);
        }

        // Contacto oficina madre
        if (telefonos.whatsapp_oficina_madre && telefonos.telefono_oficina_madre) {
            await pool.query(`
        INSERT INTO contacto_aviso (estudiante_id, telefono, tipo_contacto, nombre_contacto, activo)
        VALUES (?, ?, 'madre_oficina', ?, TRUE)
        ON DUPLICATE KEY UPDATE 
          nombre_contacto = VALUES(nombre_contacto),
          activo = TRUE,
          fecha_verificacion = NOW()
      `, [
                estudianteId,
                telefonos.telefono_oficina_madre,
                `${nombres.nombre_madre || 'Sra.'} ${nombres.apellido_madre || ''}`.trim()
            ]);
        }

        console.log(`✅ Contactos WhatsApp guardados para estudiante ${estudianteId}`);
    } catch (error) {
        console.error('Error guardando contactos WhatsApp:', error);
        throw error;
    }
}

module.exports = {
    guardarContactosWhatsApp
};
