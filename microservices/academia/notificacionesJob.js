// ===== JOB AUTOMÁTICO PARA REVISAR VENCIMIENTOS =====
// Se ejecuta periódicamente para revisar y notificar vencimientos de cuotas

const NotificacionesService = require('./notificacionesService');

class NotificacionesJob {
  constructor(notificacionesService) {
    this.notificacionesService = notificacionesService;
    this.intervalId = null;
    this.estaEjecutando = false;
  }

  // Iniciar job automático (revisa cada 6 horas)
  iniciar(intervaloHoras = 6) {
    if (this.intervalId) {
      console.log('⚠️ Job de notificaciones ya está ejecutándose');
      return;
    }

    // Log silenciado
    
    // Ejecutar inmediatamente al iniciar
    this.ejecutarRevision();

    // Programar ejecución periódica
    const intervaloMs = intervaloHoras * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.ejecutarRevision();
    }, intervaloMs);
  }

  // Detener job automático
  detener() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('⏹️ Job de notificaciones detenido');
    }
  }

  // Ejecutar revisión de vencimientos
  async ejecutarRevision() {
    if (this.estaEjecutando) {
      console.log('⚠️ Revisión de vencimientos ya en ejecución');
      return;
    }

    this.estaEjecutando = true;
    const inicio = Date.now();

    try {
      // Log silenciado
      
      // Revisar vencimientos con 2 días de anticipación
      const resultado = await this.notificacionesService.revisarVencimientosYNotificar(2);
      
      const tiempo = Date.now() - inicio;
      // Log silenciado
      
      return resultado;
    } catch (error) {
      console.error('❌ Error en revisión automática:', error);
      return { enviadas: 0, errores: 1, error: error.message };
    } finally {
      this.estaEjecutando = false;
    }
  }

  // Ejecutar revisión manual (desde endpoint)
  async ejecutarRevisionManual(diasAnticipacion = 2) {
    return await this.notificacionesService.revisarVencimientosYNotificar(diasAnticipacion);
  }
}

module.exports = NotificacionesJob;

