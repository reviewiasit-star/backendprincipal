const express = require('express');
const { authMiddleware } = require('../../middleware/auth');
const { obtenerInstancia } = require('./whatsappServiceSingleton');
const {
  listarOcrComprobantes,
  obtenerOcrComprobante,
  obtenerImagenOcr,
  marcarRevisado,
  eliminarTodosComprobantes
} = require('./ocrComprobantesStore');
const pool = require('../academia/config');

const router = express.Router();
const whatsappService = obtenerInstancia();

// Listar comprobantes OCR (pendientes o revisados)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { estado, limite, excluir_usados } = req.query;
    
    // Obtener todos los comprobantes
    let items = await listarOcrComprobantes({ estado, limite: limite || 100 });
    
    // Si se solicita excluir los ya usados, filtrar los que están asociados a pagos
    if (excluir_usados === 'true' || excluir_usados === '1') {
      const pool = require('../academia/config');
      try {
        // Verificar si la columna existe antes de hacer la consulta
        const [columns] = await pool.query(`
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = 'pagos_realizados' 
          AND COLUMN_NAME = 'id_ocr_comprobante'
        `);
        
        if (columns.length > 0) {
          // Obtener IDs de comprobantes OCR ya usados
          const [pagosConOcr] = await pool.query(
            'SELECT DISTINCT id_ocr_comprobante FROM pagos_realizados WHERE id_ocr_comprobante IS NOT NULL'
          );
          const idsUsados = pagosConOcr.map(p => p.id_ocr_comprobante);
          
          // Filtrar los comprobantes que ya están usados
          items = items.filter(item => !idsUsados.includes(item.id));
        }
      } catch (filterError) {
        console.log('Error al filtrar comprobantes usados:', filterError.message);
        // Continuar sin filtrar si hay error
      }
    }
    
    res.json({ ok: true, items });
  } catch (error) {
    console.error('Error listando ocr_comprobantes:', error);
    res.status(500).json({ ok: false, message: 'Error al listar comprobantes OCR' });
  }
});

// Endpoint para buscar hijos del remitente por teléfono o CI
// IMPORTANTE: Esta ruta debe estar ANTES de /:id para que no sea capturada como parámetro
router.get('/buscar-hijos-remitente', authMiddleware, async (req, res) => {
  try {
    const { telefono, ci } = req.query;
    
    console.log('🔍 Buscando hijos del remitente:', { telefono, ci });
    
    if (!telefono && !ci) {
      return res.status(400).json({ ok: false, message: 'Se requiere teléfono o CI' });
    }

    const condiciones = [];
    const parametros = [];
    let usarContactoAviso = false;
    let estudianteIdsDesdeContactoAviso = [];

    // Buscar por CI del padre o madre
    if (ci) {
      const ciLimpio = ci.replace(/\D/g, ''); // Solo dígitos
      console.log('📋 CI limpio:', ciLimpio);
      if (ciLimpio.length >= 5) {
        condiciones.push('(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.ci_padre, " ", ""), "-", ""), ".", ""), " ", ""), " ", "") = ? OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.ci_madre, " ", ""), "-", ""), ".", ""), " ", ""), " ", "") = ?)');
        parametros.push(ciLimpio, ciLimpio);
      }
    }

    // Buscar por teléfono - PRIMERO buscar en contacto_aviso
    if (telefono) {
      const tel = telefono.replace(/\D/g, ''); // Solo dígitos
      console.log('📞 Teléfono limpio:', tel);
      
      if (tel.length >= 7) {
        // Usar los últimos 7-8 dígitos para búsqueda más flexible
        const ultimosDigitos = tel.length >= 8 ? tel.slice(-8) : tel.slice(-7);
        const telPattern = `%${ultimosDigitos}%`;
        
        console.log('🔎 Patrón de búsqueda:', telPattern);
        
        // PRIMERO: Buscar en contacto_aviso para obtener estudiante_ids
        try {
          const [contactos] = await pool.query(`
            SELECT DISTINCT estudiante_id 
            FROM contacto_aviso 
            WHERE activo = 1 
              AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(telefono, " ", ""), "-", ""), "(", ""), ")", ""), "+", "") LIKE ?
          `, [telPattern]);
          
          if (contactos.length > 0) {
            estudianteIdsDesdeContactoAviso = contactos.map(c => c.estudiante_id);
            usarContactoAviso = true;
            console.log(`✅ Encontrados ${contactos.length} contacto(s) en contacto_aviso para teléfono ${tel}`);
            console.log(`📋 IDs de estudiantes desde contacto_aviso:`, estudianteIdsDesdeContactoAviso);
          }
        } catch (error) {
          console.warn('⚠️ Error buscando en contacto_aviso (continuando con búsqueda normal):', error.message);
        }
        
        // TAMBIÉN buscar en campos de teléfono de estudiantes (por si no está en contacto_aviso)
        condiciones.push(`(
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, " ", ""), "-", ""), "(", ""), ")", ""), "+", "") LIKE ? OR 
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, " ", ""), "-", ""), "(", ""), ")", ""), "+", "") LIKE ? OR 
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, " ", ""), "-", ""), "(", ""), ")", ""), "+", "") LIKE ? OR 
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, " ", ""), "-", ""), "(", ""), ")", ""), "+", "") LIKE ?
        )`);
        parametros.push(telPattern, telPattern, telPattern, telPattern);
      }
    }

    // Si encontramos estudiantes desde contacto_aviso, agregar condición
    if (usarContactoAviso && estudianteIdsDesdeContactoAviso.length > 0) {
      const placeholders = estudianteIdsDesdeContactoAviso.map(() => '?').join(',');
      condiciones.push(`e.id IN (${placeholders})`);
      parametros.push(...estudianteIdsDesdeContactoAviso);
    }

    if (condiciones.length === 0) {
      console.log('⚠️ No hay condiciones válidas para buscar');
      return res.json({ ok: true, hijos: [] });
    }

    const query = `
      SELECT DISTINCT
        e.id,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante,
        e.nombre_padre,
        e.apellido_padre,
        e.nombre_madre,
        e.apellido_madre,
        MAX(n.nombre) as nivel_nombre,
        MAX(c.nombre) as curso_nombre
      FROM estudiantes e
      LEFT JOIN inscripciones i ON e.id = i.estudiante_id AND i.estado = 'activo'
      LEFT JOIN nivel n ON i.nivel_id = n.id
      LEFT JOIN curso c ON i.curso_id = c.id
      WHERE e.estado_id = 1 AND (${condiciones.join(' OR ')})
      GROUP BY e.id
      ORDER BY e.nombre, e.apellido_paterno
    `;

    console.log('📝 Query SQL:', query);
    console.log('📊 Parámetros:', parametros);

    const [estudiantes] = await pool.query(query, parametros);

    console.log(`✅ Encontrados ${estudiantes.length} estudiante(s)`);

    res.json({ 
      ok: true, 
      hijos: estudiantes.map(est => ({
        id: est.id,
        nombre: `${est.nombre} ${est.apellido_paterno || ''} ${est.apellido_materno || ''}`.trim(),
        ci: est.ci_estudiante,
        nivel: est.nivel_nombre || 'Sin nivel',
        curso: est.curso_nombre || 'Sin curso',
        nombrePadre: `${est.nombre_padre || ''} ${est.apellido_padre || ''}`.trim(),
        nombreMadre: `${est.nombre_madre || ''} ${est.apellido_madre || ''}`.trim()
      }))
    });

  } catch (error) {
    console.error('❌ Error al buscar hijos del remitente:', error);
    res.status(500).json({ ok: false, message: 'Error al buscar hijos: ' + error.message });
  }
});

// Obtener detalle sin imagen
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const item = await obtenerOcrComprobante(req.params.id);
    if (!item) return res.status(404).json({ ok: false, message: 'No encontrado' });
    res.json({ ok: true, item });
  } catch (error) {
    console.error('Error obteniendo ocr_comprobante:', error);
    res.status(500).json({ ok: false, message: 'Error al obtener comprobante OCR' });
  }
});

// Obtener imagen en base64
router.get('/:id/imagen', authMiddleware, async (req, res) => {
  try {
    const img = await obtenerImagenOcr(req.params.id);
    if (!img) return res.status(404).json({ ok: false, message: 'Imagen no encontrada' });
    res.json({ ok: true, ...img });
  } catch (error) {
    console.error('Error obteniendo imagen de ocr_comprobante:', error);
    res.status(500).json({ ok: false, message: 'Error al obtener imagen' });
  }
});

// Eliminar todos los comprobantes (útil para pruebas)
router.delete('/todos', authMiddleware, async (req, res) => {
  try {
    const eliminados = await eliminarTodosComprobantes();
    res.json({ ok: true, message: `Se eliminaron ${eliminados} comprobante(s)` });
  } catch (error) {
    console.error('Error eliminando todos los comprobantes:', error);
    res.status(500).json({ ok: false, message: 'Error al eliminar comprobantes' });
  }
});

// Marcar como revisado
router.patch('/:id/revisar', authMiddleware, async (req, res) => {
  try {
    const observaciones = req.body?.observaciones || null;
    
    // Obtener los datos del comprobante antes de marcarlo como revisado
    const comprobante = await obtenerOcrComprobante(req.params.id);
    if (!comprobante) {
      return res.status(404).json({ ok: false, message: 'Comprobante no encontrado' });
    }

    // Marcar como revisado
    await marcarRevisado(req.params.id, req.user?.id || null, observaciones);

    // Enviar mensaje de confirmación por WhatsApp
    console.log(`📋 Intentando enviar mensaje de confirmación para comprobante ${req.params.id}...`);
    
    try {
      // Verificar que WhatsApp esté disponible
      if (!whatsappService) {
        console.error('❌ WhatsAppService no está disponible (null)');
        throw new Error('WhatsAppService no está disponible');
      }

      // Verificar que WhatsApp esté conectado
      const isReady = await whatsappService.isClientReady();
      console.log(`📱 Estado de WhatsApp: ${isReady ? 'Conectado' : 'No conectado'}`);
      
      if (!isReady) {
        throw new Error('WhatsApp no está conectado. Por favor, verifique la conexión en el panel de administración.');
      }

      const datos = comprobante.datos || {};
      const numeroRemitente = comprobante.numero_remitente;
      
      console.log(`📞 Número remitente en BD: ${numeroRemitente || 'No disponible'}`);
      console.log(`📝 Observaciones: ${datos.observaciones || 'No disponible'}`);
      
      // Extraer datos del remitente desde observaciones si están disponibles
      const parseRemitente = (obs) => {
        const txt = String(obs || '');
        const get = (re) => {
          const m = txt.match(re);
          return m ? String(m[1]).trim() : null;
        };
        return {
          nombre: get(/Nombre\s+remitente:\s*([^|;]+)/i),
          telefono: get(/Tel[eé]fono\s+remitente:\s*([^|;]+)/i),
          descripcionMonto: get(/Descripci[oó]n\s+del\s+monto:\s*([^|;]+)/i)
        };
      };

      const remit = parseRemitente(datos.observaciones);
      const telefonoParaEnviar = remit.telefono || numeroRemitente;

      console.log(`📱 Teléfono extraído para enviar: ${telefonoParaEnviar || 'No encontrado'}`);
      console.log(`📝 Descripción del monto: ${remit.descripcionMonto || 'No especificada'}`);

      if (!telefonoParaEnviar) {
        console.warn(`⚠️ No se encontró número de teléfono para enviar confirmación del comprobante ${req.params.id}`);
        throw new Error('No se encontró número de teléfono del remitente');
      }

      // Construir mensaje de confirmación simplificado
      const monto = datos.monto_detectado ? `${datos.monto_detectado} ${datos.moneda || 'BOB'}` : 'No especificado';
      const fecha = datos.fecha_detectada || 'No especificada';
      const banco = datos.banco_detectado || 'No especificado';
      
      // Formatear fecha de manera más legible si está disponible
      let fechaFormateada = fecha;
      if (fecha && fecha !== 'No especificada' && fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [año, mes, dia] = fecha.split('-');
        const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        fechaFormateada = `${dia} de ${meses[parseInt(mes) - 1]} de ${año}`;
      }
      
      // Personalizar saludo con nombre del remitente
      const nombreRemitente = remit.nombre || 'Estimado/a';
      const saludo = remit.nombre ? `${nombreRemitente}` : 'Estimado/a';
      
      const mensaje = 
        `✅ *Comprobante revisado*\n\n` +
        `Se recibió comprobante de pago:\n\n` +
        `*Monto:* ${monto}\n` +
        `*Fecha:* ${fechaFormateada}\n` +
        `*Banco:* ${banco}\n\n` +
        `En un momento actualizaremos la cuota.`;

      console.log(`📤 Preparando envío de mensaje a ${telefonoParaEnviar}...`);
      console.log(`📄 Contenido del mensaje (primeros 100 chars): "${mensaje.substring(0, 100)}..."`);
      
      await whatsappService.enviarMensajeANumero(telefonoParaEnviar, mensaje);
      console.log(`✅ ✅ Mensaje de confirmación enviado exitosamente a ${telefonoParaEnviar} para comprobante ${req.params.id}`);
      
    } catch (whatsappError) {
      // No fallar la operación si el envío de WhatsApp falla, pero loguear el error completo
      console.error('❌ ❌ Error al enviar mensaje de confirmación por WhatsApp:');
      console.error('   Mensaje:', whatsappError.message);
      console.error('   Stack:', whatsappError.stack);
      // Continuar con la respuesta exitosa aunque falle el envío
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error marcando ocr_comprobante como revisado:', error);
    res.status(500).json({ ok: false, message: 'Error al actualizar estado' });
  }
});

module.exports = router;
