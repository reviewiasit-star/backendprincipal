// ===== SERVICIO PARA GENERAR Y ENVIAR PDF DE PLAN DE CUOTAS =====
// Genera el PDF del plan de pagos y lo envía por WhatsApp automáticamente

const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const autoTable = autoTableModule.autoTable || autoTableModule.default || autoTableModule;
const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const pool = require('./config');
const { obtenerInstancia } = require('./whatsappServiceSingleton');

class PlanCuotasPDFService {
  constructor() {
    this.whatsappService = obtenerInstancia();
  }

  // Normalizar número de teléfono para WhatsApp
  normalizarNumeroParaWhatsApp(numero) {
    if (!numero) return null;
    
    // Eliminar espacios, guiones, paréntesis
    let normalizado = numero.replace(/[\s\-\(\)]/g, '');
    
    // Si empieza con 591 (código de país de Bolivia), mantenerlo
    if (normalizado.startsWith('591')) {
      return normalizado + '@c.us';
    }
    
    // Si no empieza con código de país, asumir que es número local boliviano
    if (normalizado.length >= 8) {
      return '591' + normalizado + '@c.us';
    }
    
    return null;
  }

  // Generar PDF del plan de cuotas (igual formato que frontend)
  async generarPDFPlanCuotas(estudianteId, inscripcionId, gestionAcademica) {
    try {
      // Obtener información completa del estudiante, inscripción y compromiso económico
      const [datos] = await pool.query(`
        SELECT 
          e.id as estudiante_id,
          e.nombre as nombre_estudiante,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          e.nombre_padre,
          e.apellido_padre,
          e.telefono_domicilio_padre,
          i.turno,
          i.gestion_academica,
          i.nivel_id,
          i.curso_id,
          i.bloque_id,
          i.id_beca,
          i.meses_beca,
          n.nombre as nivel_nombre,
          n.precio as nivel_precio,
          n.meses as nivel_meses,
          c.nombre as curso_nombre,
          b.descripcion as bloque_nombre,
          bc.descripcion as beca_descripcion,
          bc.descuento as beca_descuento,
          ce.id as compromiso_id,
          ce.total_cuotas,
          ce.total_general,
          ce.cuotas as numero_cuotas
        FROM estudiantes e
        JOIN inscripciones i ON e.id = i.estudiante_id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        LEFT JOIN becas bc ON i.id_beca = bc.id
        LEFT JOIN compromiso_economico ce ON i.id = ce.inscripcion_id
        WHERE e.id = ? AND i.id = ?
      `, [estudianteId, inscripcionId]);

      if (datos.length === 0) {
        throw new Error('No se encontraron datos del estudiante o inscripción');
      }

      const info = datos[0];

      // Obtener pagos mensuales para calcular valores
      const [pagosMensuales] = await pool.query(`
        SELECT 
          mes,
          nombre_mes,
          monto_base,
          monto_descuento,
          monto_esperado,
          tiene_beca,
          porcentaje_beca
        FROM pagos_mensuales
        WHERE id_compromiso = ?
        ORDER BY mes ASC
      `, [info.compromiso_id]);

      // Calcular valores igual que en el frontend
      const precioNivel = Number(info.nivel_precio || 0);
      const nivelMeses = info.nivel_meses ? JSON.parse(info.nivel_meses) : [];
      const todosLosMeses = nivelMeses.length > 0 ? nivelMeses : ['febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre'];
      const cuotaMensual = precioNivel / todosLosMeses.length;
      const descuentoPorcentaje = info.beca_descuento ? Number(info.beca_descuento) : 0;
      
      // Separar meses con y sin descuento
      const mesesBecaArray = info.meses_beca ? info.meses_beca.split(',').map(m => m.trim().toLowerCase()) : [];
      const mesesConDescuento = todosLosMeses.filter(mes => mesesBecaArray.includes(mes.toLowerCase()));
      const mesesSinDescuento = todosLosMeses.filter(mes => !mesesBecaArray.includes(mes.toLowerCase()));
      
      // Calcular totales
      const totalConDescuento = mesesConDescuento.length * (cuotaMensual * (1 - descuentoPorcentaje / 100));
      const totalSinDescuento = mesesSinDescuento.length * cuotaMensual;
      const totalCuotas = totalConDescuento + totalSinDescuento;
      const totalGeneral = totalCuotas;

      // Crear directorio para PDFs si no existe
      const pdfsDir = path.join(__dirname, '..', '..', 'pdfs');
      if (!fs.existsSync(pdfsDir)) {
        fs.mkdirSync(pdfsDir, { recursive: true });
      }

      // Nombre del archivo
      const nombreArchivo = `Plan_Pagos_${info.nombre_estudiante.replace(/\s+/g, '_')}_${gestionAcademica}.pdf`;
      const rutaArchivo = path.join(pdfsDir, nombreArchivo);

      // Crear documento PDF usando jsPDF (igual que frontend)
      const doc = new jsPDF();

      // Intentar agregar logo si existe
      try {
        const logoPath = path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'assets', 'img', 'logo.jpg');
        if (fs.existsSync(logoPath)) {
          const logoBase64 = fs.readFileSync(logoPath, 'base64');
          doc.addImage(`data:image/jpeg;base64,${logoBase64}`, 'JPEG', 89, 8, 32, 20);
        }
      } catch (logoError) {
        console.warn('No se pudo cargar el logo:', logoError.message);
      }

      // Encabezado (igual que frontend)
      doc.setFillColor(255, 255, 255);
      doc.rect(20, 28, 170, 14, 'F');
      doc.setFontSize(14);
      doc.text('PLAN DE PAGOS - COMPROMISO ECONÓMICO', 105, 35, { align: 'center' });
      doc.setFontSize(9);
      doc.text(`Gestión ${gestionAcademica}`, 105, 41, { align: 'center' });
      doc.setFontSize(7);
      const detalleAcademico = `Nivel: ${info.nivel_nombre || 'Sin nivel'} • Curso: ${info.curso_nombre || 'Sin curso'} • Bloque: ${info.bloque_nombre || 'Sin bloque'} • Turno: ${info.turno || 'Sin turno'}`;
      doc.text(detalleAcademico, 105, 46, { align: 'center' });
      doc.line(20, 50, 190, 50);
      
      let y = 56;

      // Tabla de datos del estudiante (igual que frontend)
      autoTable(doc, {
        startY: y,
        head: [['Campo', 'Detalle']],
        body: [
          ['Estudiante', `${info.nombre_estudiante} ${info.apellido_paterno || ''} ${info.apellido_materno || ''}`],
          ['CI', info.ci_estudiante || ''],
          ['Turno', info.turno || ''],
          ['Beca', info.beca_descripcion ? `${info.beca_descripcion} (${info.beca_descuento}%)` : 'Sin beca'],
          ['Meses con beca', mesesBecaArray.length > 0 ? mesesBecaArray.join(', ') : 'Ninguno']
        ],
        theme: 'grid',
        styles: { fontSize: 6 }
      });

      y = doc.lastAutoTable.finalY + 6;

      // Tabla de meses (igual que frontend)
      const filas = [];
      mesesConDescuento.forEach(m => {
        const monto = Math.round(cuotaMensual * (1 - descuentoPorcentaje / 100) * 100) / 100;
        filas.push([m, `Bs ${cuotaMensual.toFixed(2)}`, `${descuentoPorcentaje}%`, `Bs ${monto.toFixed(2)}`]);
      });
      mesesSinDescuento.forEach(m => {
        filas.push([m, `Bs ${cuotaMensual.toFixed(2)}`, '0%', `Bs ${cuotaMensual.toFixed(2)}`]);
      });

      autoTable(doc, {
        startY: y,
        head: [['Mes', 'Monto Base', 'Descuento', 'Monto a Pagar']],
        body: filas,
        theme: 'grid',
        styles: { fontSize: 6 }
      });

      y = doc.lastAutoTable.finalY + 6;

      // Tabla de resumen (igual que frontend)
      autoTable(doc, {
        startY: y,
        head: [['Concepto', 'Valor']],
        body: [
          ['Cuota mensual', `Bs ${cuotaMensual.toFixed(2)}`],
          ['Subtotal con descuento', `Bs ${totalConDescuento.toFixed(2)}`],
          ['Subtotal sin descuento', `Bs ${totalSinDescuento.toFixed(2)}`],
          ['Total cuotas', `Bs ${totalCuotas.toFixed(2)}`],
          ['Total general', `Bs ${totalGeneral.toFixed(2)}`]
        ],
        theme: 'grid',
        styles: { fontSize: 6 }
      });

      const firmasY = doc.lastAutoTable.finalY + 20;
      doc.setFontSize(8);
      doc.text('Firma del Padre/Madre/Tutor', 40, firmasY);
      doc.line(20, firmasY - 2, 90, firmasY - 2);
      doc.text('Firma de Administración', 140, firmasY);
      doc.line(120, firmasY - 2, 190, firmasY - 2);

      // Guardar PDF (en Node.js usamos output() en lugar de save())
      const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
      fs.writeFileSync(rutaArchivo, pdfBuffer);

      return rutaArchivo;

    } catch (error) {
      console.error('Error al generar PDF del plan de cuotas:', error);
      throw error;
    }
  }

  // Enviar PDF por WhatsApp
  async enviarPDFPorWhatsApp(rutaPDF, telefono, mensaje) {
    try {
      // Esperar a que WhatsApp esté completamente listo (con retry)
      let intentos = 0;
      const maxIntentos = 10;
      const tiempoEspera = 2000; // 2 segundos entre intentos

      while (intentos < maxIntentos) {
        if (this.whatsappService && await this.whatsappService.isClientReady()) {
          // Verificar que el cliente realmente existe y está conectado
          if (this.whatsappService.client) {
            try {
              const state = await this.whatsappService.client.getState();
              if (state === 'CONNECTED') {
                break; // WhatsApp está listo
              }
            } catch (stateError) {
              // Continuar esperando
            }
          }
        }

        intentos++;
        if (intentos < maxIntentos) {
          console.log(`⏳ Esperando que WhatsApp esté listo... (intento ${intentos}/${maxIntentos})`);
          await new Promise(resolve => setTimeout(resolve, tiempoEspera));
        }
      }

      // Verificar nuevamente después de los intentos
      if (!this.whatsappService || !(await this.whatsappService.isClientReady())) {
        throw new Error('WhatsApp no está conectado después de múltiples intentos');
      }

      if (!this.whatsappService.client) {
        throw new Error('Cliente de WhatsApp no está disponible');
      }

      // Normalizar número
      const numeroNormalizado = this.normalizarNumeroParaWhatsApp(telefono);
      if (!numeroNormalizado) {
        throw new Error('Número de teléfono inválido');
      }

      // Verificar que el archivo existe
      if (!fs.existsSync(rutaPDF)) {
        throw new Error(`El archivo PDF no existe: ${rutaPDF}`);
      }

      // Leer el archivo PDF
      const pdfBuffer = fs.readFileSync(rutaPDF);

      // Crear MessageMedia para el PDF
      const media = new MessageMedia(
        'application/pdf',
        pdfBuffer.toString('base64'),
        path.basename(rutaPDF)
      );

      // Verificar que el cliente tenga acceso a la API de WhatsApp
      // El error "getChat" undefined sugiere que el cliente no está completamente inicializado
      // Intentar verificar que el cliente tiene acceso a la página de WhatsApp Web
      try {
        // Verificar que el cliente tiene el método sendMessage disponible
        if (typeof this.whatsappService.client.sendMessage !== 'function') {
          throw new Error('El cliente de WhatsApp no tiene el método sendMessage disponible');
        }
        
        // Esperar un momento adicional para asegurar que WhatsApp Web está completamente cargado
        // El error "getChat" undefined generalmente ocurre cuando la página aún no está lista
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (verifyError) {
        console.warn('⚠️ Advertencia al verificar cliente:', verifyError.message);
        // Esperar un poco más antes de continuar
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Intentar enviar el PDF con manejo de errores mejorado
      let intentosEnvio = 0;
      const maxIntentosEnvio = 3;
      let ultimoError = null;

      while (intentosEnvio < maxIntentosEnvio) {
        try {
          // Enviar el PDF con el mensaje como caption
          // Usar timeout para evitar que se quede colgado
          const sendPromise = this.whatsappService.client.sendMessage(numeroNormalizado, media, { 
            caption: mensaje 
          });
          
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout: El envío tardó demasiado')), 60000);
          });

          await Promise.race([sendPromise, timeoutPromise]);
          
          // Si llegamos aquí, el envío fue exitoso
          break;
          
        } catch (sendError) {
          ultimoError = sendError;
          intentosEnvio++;
          
          // Si el error es sobre getChat undefined, esperar más tiempo
          if (sendError.message && sendError.message.includes('getChat')) {
            console.log(`⚠️ Error de inicialización detectado, esperando más tiempo... (intento ${intentosEnvio}/${maxIntentosEnvio})`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Esperar 5 segundos
          } else {
            // Para otros errores, esperar menos tiempo
            if (intentosEnvio < maxIntentosEnvio) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
          
          if (intentosEnvio >= maxIntentosEnvio) {
            throw ultimoError;
          }
        }
      }

      console.log(`✅ PDF enviado exitosamente a ${telefono}`);

      return { success: true, mensaje: 'PDF enviado exitosamente' };

    } catch (error) {
      console.error('Error al enviar PDF por WhatsApp:', error);
      throw error;
    }
  }

  // Proceso completo: generar PDF y enviarlo por WhatsApp
  async generarYEnviarPlanCuotas(estudianteId, inscripcionId, gestionAcademica) {
    try {
      // Obtener teléfono del padre
      const [estudiante] = await pool.query(`
        SELECT 
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.telefono_domicilio_padre,
          e.nombre_padre,
          e.apellido_padre
        FROM estudiantes e
        WHERE e.id = ?
      `, [estudianteId]);

      if (estudiante.length === 0) {
        throw new Error('Estudiante no encontrado');
      }

      const est = estudiante[0];
      const telefonoPadre = est.telefono_domicilio_padre;

      if (!telefonoPadre) {
        console.log(`⚠️ No se encontró teléfono del padre para el estudiante ${estudianteId}`);
        return { 
          success: false, 
          mensaje: 'No se encontró teléfono del padre. El PDF no se envió por WhatsApp.' 
        };
      }

      // Generar PDF
      const rutaPDF = await this.generarPDFPlanCuotas(estudianteId, inscripcionId, gestionAcademica);

      // Preparar mensaje personalizado
      const nombreEstudiante = `${est.nombre} ${est.apellido_paterno || ''} ${est.apellido_materno || ''}`.trim();
      const nombrePadre = est.nombre_padre ? `Sr. ${est.nombre_padre} ${est.apellido_padre || ''}`.trim() : 'Estimado padre/madre';
      
      const mensaje = `Buenos días ${nombrePadre},\n\n` +
        `Le informamos que la inscripción de su hijo/a *${nombreEstudiante}* fue procesada correctamente.\n\n` +
        `Adjuntamos el plan de pagos - compromiso económico para la gestión ${gestionAcademica}.\n\n` +
        `Por favor, revise el documento y realice los pagos según el cronograma establecido.\n\n` +
        `Saludos cordiales,\n` +
        `Unidad Educativa`;

      // Enviar por WhatsApp
      await this.enviarPDFPorWhatsApp(rutaPDF, telefonoPadre, mensaje);

      return { 
        success: true, 
        mensaje: 'PDF generado y enviado exitosamente por WhatsApp',
        rutaPDF: rutaPDF
      };

    } catch (error) {
      console.error('Error en generarYEnviarPlanCuotas:', error);
      return { 
        success: false, 
        mensaje: `Error: ${error.message}`,
        error: error.message
      };
    }
  }
}

module.exports = PlanCuotasPDFService;

