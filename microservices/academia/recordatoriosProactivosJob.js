// ===== JOB PROGRAMADO PARA RECORDATORIOS PROACTIVOS =====
// Ejecuta recordatorios proactivos de forma programada

const RecordatoriosProactivosService = require('./recordatoriosProactivosService');

class RecordatoriosProactivosJob {
  constructor() {
    this.recordatoriosService = new RecordatoriosProactivosService();
    this.intervalId = null;
    this.estaEjecutando = false;
    this.ultimaEjecucion = null;
  }

  // Iniciar job con intervalo en horas (por defecto, una vez al día)
  iniciar(intervaloHoras = 24) {
    if (this.intervalId) {
      console.log('⚠️ Job de recordatorios proactivos ya está iniciado');
      return;
    }

    // Ejecutar inmediatamente al iniciar (solo si es la primera vez)
    // Luego ejecutar a las 8:00 AM cada día
    this.programarEjecucionDiaria();

    // También programar ejecución periódica como respaldo
    const intervaloMs = intervaloHoras * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.ejecutar();
    }, intervaloMs);
  }

  // Programar ejecución diaria a las 8:00 AM
  programarEjecucionDiaria() {
    const ahora = new Date();
    const horaEjecucion = new Date();
    horaEjecucion.setHours(8, 0, 0, 0); // 8:00 AM

    // Si ya pasaron las 8:00 AM hoy, programar para mañana
    if (ahora.getTime() > horaEjecucion.getTime()) {
      horaEjecucion.setDate(horaEjecucion.getDate() + 1);
    }

    const tiempoHastaEjecucion = horaEjecucion.getTime() - ahora.getTime();

    setTimeout(() => {
      this.ejecutar();
      // Programar siguiente ejecución (cada 24 horas)
      this.programarEjecucionDiaria();
    }, tiempoHastaEjecucion);
  }

  // Detener job
  detener() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('⏹️ Job de recordatorios proactivos detenido');
    }
  }

  // Ejecutar recordatorios
  async ejecutar() {
    if (this.estaEjecutando) {
      console.log('⚠️ Recordatorios proactivos ya en ejecución');
      return;
    }

    this.estaEjecutando = true;
    const inicio = Date.now();

    try {
      console.log('🔄 Ejecutando recordatorios proactivos...');

      // Enviar recordatorios de pagos próximos a vencer (3 días de anticipación)
      const resultado = await this.recordatoriosService.enviarRecordatorioPagoProactivo(3);

      const tiempo = Date.now() - inicio;
      this.ultimaEjecucion = new Date();

      console.log(`✅ Recordatorios proactivos completados en ${tiempo}ms`);
      console.log(`   - Recordatorios enviados: ${resultado.enviados}`);
      console.log(`   - Errores: ${resultado.errores}`);
      console.log(`   - Total cuotas encontradas: ${resultado.total_cuotas || 0}`);

      return resultado;
    } catch (error) {
      console.error('❌ Error ejecutando recordatorios proactivos:', error);
      return { enviados: 0, errores: 1, error: error.message };
    } finally {
      this.estaEjecutando = false;
    }
  }

  // Ejecutar recordatorio de evento específico
  async ejecutarRecordatorioEvento(tipoEvento, fechaEvento, mensajePersonalizado = null) {
    if (this.estaEjecutando) {
      return { ok: false, message: 'Recordatorios ya en ejecución' };
    }

    this.estaEjecutando = true;

    try {
      const resultado = await this.recordatoriosService.enviarRecordatorioEvento(
        tipoEvento,
        fechaEvento,
        mensajePersonalizado
      );

      return { ok: true, ...resultado };
    } catch (error) {
      console.error(`❌ Error ejecutando recordatorio de evento:`, error);
      return { ok: false, error: error.message };
    } finally {
      this.estaEjecutando = false;
    }
  }

  // Obtener estado del job
  getEstado() {
    return {
      activo: this.intervalId !== null,
      ejecutando: this.estaEjecutando,
      ultima_ejecucion: this.ultimaEjecucion
    };
  }
}

module.exports = RecordatoriosProactivosJob;
