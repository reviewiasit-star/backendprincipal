const express = require('express');
const { obtenerInstancia } = require('./whatsappServiceSingleton');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const path = require('path');
const fs = require('fs');

// Obtener instancia única del servicio de WhatsApp
const whatsappService = obtenerInstancia();

// La inicialización se realiza ahora desde index.js para evitar duplicidad
// inicializar().catch((error) => {
//   console.error('❌ Error al inicializar servicio de WhatsApp:', error.message);
// });

// Ruta para obtener el estado del cliente WhatsApp
router.get('/status', authMiddleware, async (req, res) => {
  try {
    // Verificar realmente si el cliente está conectado (como en el proyecto Entradas)
    const isReady = await whatsappService.isClientReady();
    const qrCode = whatsappService.getQRCode();
    const qrImage = whatsappService.getQRImage();
    const phoneNumber = await whatsappService.getPhoneNumber();

    res.json({
      success: true,
      isReady,
      qrCode: isReady ? null : qrCode,
      qrImage: isReady ? null : qrImage,
      phoneNumber
    });
  } catch (error) {
    console.error('❌ Error al obtener estado de WhatsApp:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el estado de WhatsApp',
      isReady: false,
      qrCode: null,
      qrImage: null,
      phoneNumber: null
    });
  }
});

// Ruta para cerrar sesión de WhatsApp
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await whatsappService.logout();

    // Limpiar archivos de autenticación para forzar nuevo QR
    const fs = require('fs');
    const path = require('path');
    const authPath = path.join(process.cwd(), '.wwebjs_auth');

    try {
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('✅ Archivos de autenticación eliminados');
      }
    } catch (cleanError) {
      console.warn('⚠️ No se pudieron eliminar archivos de autenticación:', cleanError.message);
    }

    // Reiniciar después de cerrar sesión
    setTimeout(async () => {
      try {
        await whatsappService.initialize();
        console.log('✅ WhatsApp reiniciado después de logout');
      } catch (err) {
        console.error('❌ Error al reiniciar WhatsApp:', err);
      }
    }, 2000);

    res.json({
      success: true,
      message: 'Sesión de WhatsApp cerrada exitosamente. El servicio se está reiniciando...'
    });
  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Error al cerrar sesión'
    });
  }
});

// Ruta para reiniciar/forzar reinicio del servicio de WhatsApp
router.post('/reiniciar', authMiddleware, async (req, res) => {
  try {
    console.log('🔄 Reiniciando servicio de WhatsApp...');

    // Cerrar cliente/navegador sin hacer logout (mantiene sesión)
    if (whatsappService.client) {
      try {
        await whatsappService.destroy();
      } catch (e) {
        console.warn('⚠️ Error al cerrar cliente previo:', e?.message);
      }
    }

    // IMPORTANTE: NO borrar .wwebjs_auth - mantener sesión del número logueado

    // Resetear estado (destroy ya lo hace, pero por si acaso)
    whatsappService.isReady = false;
    whatsappService.qrCode = null;
    whatsappService.qrImage = null;
    whatsappService.phoneNumber = null;
    whatsappService.initializing = false;

    // Esperar más tiempo antes de reinicializar para asegurar que todo se limpió
    console.log('⏳ Esperando 3 segundos antes de reinicializar...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Reinicializar en segundo plano (no bloquear la respuesta)
    whatsappService.initialize().then(() => {
      console.log('✅ WhatsApp reiniciado correctamente');
      if (whatsappService.qrCode) {
        console.log('✅ QR generado después del reinicio');
      }
    }).catch((initError) => {
      console.error('❌ Error al reinicializar WhatsApp:', initError.message);
      console.error('Stack:', initError.stack);
    });

    // Responder inmediatamente mientras se inicializa en segundo plano
    res.json({
      success: true,
      message: 'Servicio de WhatsApp se está reiniciando. Si la sesión sigue vigente, debería reconectar sin pedir QR. Verifique el estado en unos momentos.'
    });
  } catch (error) {
    console.error('Error en reiniciar:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Error al reiniciar el servicio'
    });
  }
});

// Ruta para enviar mensaje a un número (usado por backend-cajas u otros servicios internos)
// Requiere autenticación para seguridad
router.post('/enviar-mensaje', authMiddleware, async (req, res) => {
  try {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
      return res.status(400).json({
        success: false,
        error: 'Número y mensaje son requeridos'
      });
    }

    console.log(`📤 [whatsappRoutes] Solicitud de envío de mensaje a ${numero} desde servicio interno`);

    await whatsappService.enviarMensajeANumero(numero, mensaje);

    res.json({
      success: true,
      message: `Mensaje enviado exitosamente a ${numero}`
    });
  } catch (error) {
    console.error('❌ Error en ruta /enviar-mensaje:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al enviar mensaje'
    });
  }
});

// Ruta para enviar un PDF por WhatsApp (requiere que el PDF exista en el servidor)
router.post('/send-pdf', authMiddleware, async (req, res) => {
  try {
    const { phoneNumber, pdfPath, message } = req.body || {};

    if (!phoneNumber || !pdfPath) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber y pdfPath son requeridos'
      });
    }

    // Resolver ruta absoluta y evitar path traversal
    const normalized = path.normalize(String(pdfPath)).replace(/^(\.\.(\/|\\|$))+/, '');
    const absPath = path.join(process.cwd(), normalized);
    const uploadsRoot = path.join(process.cwd(), 'uploads');
    const absNormalized = path.normalize(absPath);
    if (!absNormalized.startsWith(path.normalize(uploadsRoot))) {
      return res.status(400).json({
        success: false,
        error: 'pdfPath inválido'
      });
    }

    if (!fs.existsSync(absNormalized)) {
      return res.status(404).json({
        success: false,
        error: 'El PDF no existe en el servidor'
      });
    }

    await whatsappService.enviarPDFANumero(phoneNumber, absNormalized, message || '');

    return res.json({
      success: true,
      message: 'PDF enviado exitosamente por WhatsApp'
    });
  } catch (error) {
    console.error('❌ Error en ruta /send-pdf:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Error al enviar PDF'
    });
  }
});

module.exports = router;
