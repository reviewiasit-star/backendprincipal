// ===== JOB PROGRAMADO PARA ANÁLISIS AUTÓNOMO =====
// Ejecuta los análisis del agente de forma programada

const AnalisisAutonomo = require('./analisisAutonomo');

class AnalisisAutonomoJob {
  constructor() {
    this.analisisAutonomo = new AnalisisAutonomo();
    this.intervalId = null;
    this.estaEjecutando = false;
    this.ultimaEjecucion = null;
  }

  // Iniciar job con intervalo en horas
  iniciar(intervaloHoras = 6) {
    if (this.intervalId) {
      console.log('⚠️ Job de análisis autónomo ya está iniciado');
      return;
    }

    // NO ejecutar inmediatamente al iniciar para ahorrar cuota en reinicios frecuentes (dev)
    // this.ejecutar();

    // Programar ejecuciones periódicas
    const intervaloMs = intervaloHoras * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.ejecutar();
    }, intervaloMs);
  }

  // Detener job
  detener() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('⏹️ Job de análisis autónomo detenido');
    }
  }

  // Ejecutar análisis completo
  async ejecutar() {
    if (this.estaEjecutando) {
      console.log('⚠️ Análisis autónomo ya en ejecución');
      return;
    }

    this.estaEjecutando = true;
    const inicio = Date.now();

    try {
      console.log('🔄 Ejecutando análisis autónomo...');

      const resultado = await this.analisisAutonomo.ejecutarTodosLosAnalisis();

      const tiempo = Date.now() - inicio;
      this.ultimaEjecucion = new Date();

      if (resultado.ok) {
        console.log(`✅ Análisis autónomo completado en ${tiempo}ms`);
        console.log(`   - Pagos atrasados: ${resultado.resultados.pagos_atrasados?.total_estudiantes || 0} estudiantes`);
        console.log(`   - Sugerencias de becas: ${resultado.resultados.sugerencias_becas?.total_candidatos || 0} candidatos`);
        console.log(`   - Recordatorios inscripción: ${resultado.resultados.recordatorios_inscripcion?.total_estudiantes || 0} estudiantes`);
        console.log(`   - Análisis deserción: ${resultado.resultados.analisis_desercion?.total_estudiantes || 0} estudiantes analizados`);
        console.log(`   - Reporte generado: ${resultado.resultados.reporte_diario?.ok ? 'Sí' : 'No'}`);
      } else {
        console.error('❌ Error en análisis autónomo:', resultado.error);
      }

      return resultado;
    } catch (error) {
      console.error('❌ Error ejecutando análisis autónomo:', error);
      return { ok: false, error: error.message };
    } finally {
      this.estaEjecutando = false;
    }
  }

  // Ejecutar análisis específico
  async ejecutarAnalisisEspecifico(tipo) {
    if (this.estaEjecutando) {
      return { ok: false, message: 'Análisis ya en ejecución' };
    }

    this.estaEjecutando = true;

    try {
      let resultado;

      switch (tipo) {
        case 'pagos_atrasados':
          resultado = await this.analisisAutonomo.detectarPagosAtrasados();
          break;
        case 'sugerencias_becas':
          resultado = await this.analisisAutonomo.sugerirBecas();
          break;
        case 'recordatorios_inscripcion':
          resultado = await this.analisisAutonomo.recordatoriosInscripcion();
          break;
        case 'analisis_desercion':
          resultado = await this.analisisAutonomo.analizarRiesgoDesercion();
          break;
        case 'reporte':
          resultado = await this.analisisAutonomo.generarReporteInteligente('diario');
          break;
        default:
          return { ok: false, message: 'Tipo de análisis no válido' };
      }

      return resultado;
    } catch (error) {
      console.error(`❌ Error ejecutando análisis ${tipo}:`, error);
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

module.exports = AnalisisAutonomoJob;

