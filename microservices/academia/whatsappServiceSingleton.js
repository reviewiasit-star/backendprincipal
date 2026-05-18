// ===== SINGLETON DE WHATSAPP SERVICE =====
// Asegura que solo haya una instancia de WhatsAppService en toda la aplicación

const WhatsAppService = require('./whatsappService');

let instancia = null;
let inicializando = false;

function obtenerInstancia() {
  if (!instancia) {
    instancia = new WhatsAppService();
  }
  return instancia;
}

async function inicializar() {
  // Si ya hay una instancia con cliente, no hacer nada
  if (instancia && instancia.client) {
    return;
  }

  // Si ya se está inicializando, esperar a que termine (máximo 60 segundos)
  if (inicializando) {
    return new Promise((resolve, reject) => {
      let intentos = 0;
      const maxIntentos = 120; // 60 segundos máximo
      
      const checkInterval = setInterval(() => {
        intentos++;
        
        if (!inicializando) {
          clearInterval(checkInterval);
          resolve();
        } else if (intentos >= maxIntentos) {
          clearInterval(checkInterval);
          reject(new Error('Timeout esperando inicialización de WhatsApp'));
        }
      }, 500);
    });
  }

  inicializando = true;
  try {
    const servicio = obtenerInstancia();
    
    // Verificar si ya está inicializado antes de intentar inicializar
    if (servicio.client) {
      return;
    }
    
    await servicio.initialize();
  } catch (error) {
    console.error('Error al inicializar WhatsApp (singleton):', error.message);
    // No relanzar el error, solo loguearlo para no romper otros módulos
  } finally {
    inicializando = false;
  }
}

// NO inicializar automáticamente - dejar que cada módulo lo haga cuando lo necesite
// Esto evita conflictos de inicialización simultánea

module.exports = {
  obtenerInstancia,
  inicializar
};

