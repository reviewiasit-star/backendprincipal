// ===== SERVICIO PARA GENERAR DOCUMENTOS DE ASISTENCIA =====
// Genera documentos Word o PDF con listas de estudiantes para marcar asistencia

const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const autoTable = autoTableModule.autoTable || autoTableModule.default || autoTableModule;
const fs = require('fs');
const path = require('path');
const pool = require('./config');

// Directorio para almacenar documentos generados
const DOCUMENTOS_ASISTENCIA_DIR = path.join(__dirname, 'documentos_asistencia');

// Crear directorio si no existe
if (!fs.existsSync(DOCUMENTOS_ASISTENCIA_DIR)) {
  fs.mkdirSync(DOCUMENTOS_ASISTENCIA_DIR, { recursive: true });
}

/**
 * Obtiene estudiantes por nivel y turno
 */
async function obtenerEstudiantesPorNivelTurno(nivelNombre, turno, anio = null) {
  try {
    const añoActual = anio || new Date().getFullYear();
    
    let query = `
      SELECT 
        e.id,
        e.nombre,
        e.apellido_paterno,
        e.apellido_materno,
        e.ci_estudiante,
        n.nombre as nivel_nombre,
        c.nombre as curso_nombre,
        i.turno,
        i.gestion_academica as anio
      FROM estudiantes e
      INNER JOIN inscripciones i ON e.id = i.estudiante_id AND i.estado = 'activo'
      LEFT JOIN nivel n ON i.nivel_id = n.id
      LEFT JOIN curso c ON i.curso_id = c.id
      WHERE e.estado_id = 1
        AND i.gestion_academica = ?
    `;
    
    const params = [añoActual];
    
    if (nivelNombre) {
      query += ` AND LOWER(n.nombre) LIKE ?`;
      params.push(`%${nivelNombre.toLowerCase()}%`);
    }
    
    if (turno) {
      query += ` AND LOWER(TRIM(COALESCE(i.turno, ''))) = ?`;
      params.push(turno.toLowerCase().trim());
    }
    
    query += ` ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre`;
    
    const [resultados] = await pool.query(query, params);
    
    return resultados;
  } catch (error) {
    console.error('Error al obtener estudiantes:', error);
    throw error;
  }
}

/**
 * Genera un PDF con lista de estudiantes para asistencia
 */
async function generarPDFAsistencia(nivelNombre, turno, anio = null) {
  try {
    const estudiantes = await obtenerEstudiantesPorNivelTurno(nivelNombre, turno, anio);
    
    if (estudiantes.length === 0) {
      throw new Error(`No se encontraron estudiantes para el nivel "${nivelNombre}" y turno "${turno}"`);
    }
    
    const añoActual = anio || new Date().getFullYear();
    const fechaActual = new Date().toLocaleDateString('es-BO', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    // Crear documento PDF
    const doc = new jsPDF();
    
    // Encabezado
    doc.setFontSize(16);
    doc.text('LISTA DE ASISTENCIA', 105, 20, { align: 'center' });
    
    doc.setFontSize(12);
    doc.text(`Nivel: ${nivelNombre || 'Todos'}`, 20, 30);
    doc.text(`Turno: ${turno || 'Todos'}`, 20, 37);
    doc.text(`Año: ${añoActual}`, 20, 44);
    doc.text(`Fecha: ${fechaActual}`, 20, 51);
    
    // Tabla de estudiantes
    const filas = estudiantes.map((est, index) => [
      index + 1,
      `${est.nombre} ${est.apellido_paterno || ''} ${est.apellido_materno || ''}`.trim(),
      est.ci_estudiante || '',
      est.curso_nombre || '',
      '☐', // Checkbox para asistencia
      '☐'  // Checkbox para no asistencia
    ]);
    
    autoTable(doc, {
      startY: 60,
      head: [['#', 'Nombre Completo', 'CI', 'Curso', 'Asistió', 'No Asistió']],
      body: filas,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [102, 126, 234] },
      columnStyles: {
        0: { cellWidth: 15 }, // #
        1: { cellWidth: 70 }, // Nombre
        2: { cellWidth: 30 }, // CI
        3: { cellWidth: 30 }, // Curso
        4: { cellWidth: 20, halign: 'center' }, // Asistió
        5: { cellWidth: 25, halign: 'center' }  // No Asistió
      },
      margin: { top: 60 }
    });
    
    // Pie de página
    const finalY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(10);
    doc.text(`Total de estudiantes: ${estudiantes.length}`, 20, finalY);
    doc.text('Firma del docente: _________________________', 20, finalY + 10);
    
    // Generar nombre de archivo
    const nombreArchivo = `asistencia_${nivelNombre || 'todos'}_${turno || 'todos'}_${añoActual}_${Date.now()}.pdf`;
    const rutaArchivo = path.join(DOCUMENTOS_ASISTENCIA_DIR, nombreArchivo);
    
    // Guardar archivo
    doc.save(rutaArchivo);
    
    return {
      rutaArchivo,
      nombreArchivo,
      totalEstudiantes: estudiantes.length,
      nivel: nivelNombre,
      turno: turno,
      año: añoActual
    };
  } catch (error) {
    console.error('Error al generar PDF de asistencia:', error);
    throw error;
  }
}

/**
 * Genera un documento Word con lista de estudiantes para asistencia
 * Nota: Requiere instalar 'docx': npm install docx
 */
async function generarWordAsistencia(nivelNombre, turno, anio = null) {
  try {
    // Verificar si docx está disponible
    let docx;
    try {
      docx = require('docx');
    } catch (e) {
      throw new Error('La librería "docx" no está instalada. Ejecuta: npm install docx');
    }
    
    const estudiantes = await obtenerEstudiantesPorNivelTurno(nivelNombre, turno, anio);
    
    if (estudiantes.length === 0) {
      throw new Error(`No se encontraron estudiantes para el nivel "${nivelNombre}" y turno "${turno}"`);
    }
    
    const añoActual = anio || new Date().getFullYear();
    const fechaActual = new Date().toLocaleDateString('es-BO', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } = docx;
    
    // Crear tabla de estudiantes
    const filasTabla = [
      // Encabezado
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph('N°')], width: { size: 10, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph('Nombre Completo')], width: { size: 40, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph('CI')], width: { size: 15, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph('Curso')], width: { size: 15, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph('Asistió')], width: { size: 10, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph('No Asistió')], width: { size: 10, type: WidthType.PERCENTAGE } })
        ]
      })
    ];
    
    // Agregar filas de estudiantes
    estudiantes.forEach((est, index) => {
      filasTabla.push(
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(String(index + 1))] }),
            new TableCell({ children: [new Paragraph(`${est.nombre} ${est.apellido_paterno || ''} ${est.apellido_materno || ''}`.trim())] }),
            new TableCell({ children: [new Paragraph(est.ci_estudiante || '')] }),
            new TableCell({ children: [new Paragraph(est.curso_nombre || '')] }),
            new TableCell({ children: [new Paragraph('☐')], shading: { fill: 'F0F0F0' } }),
            new TableCell({ children: [new Paragraph('☐')], shading: { fill: 'F0F0F0' } })
          ]
        })
      );
    });
    
    // Crear documento
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            text: 'LISTA DE ASISTENCIA',
            heading: 'Heading1',
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 }
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Nivel: ${nivelNombre || 'Todos'}`, bold: true }),
              new TextRun({ text: '    ' }),
              new TextRun({ text: `Turno: ${turno || 'Todos'}`, bold: true })
            ],
            spacing: { after: 100 }
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Año: ${añoActual}`, bold: true }),
              new TextRun({ text: '    ' }),
              new TextRun({ text: `Fecha: ${fechaActual}`, bold: true })
            ],
            spacing: { after: 200 }
          }),
          new Table({
            rows: filasTabla,
            width: { size: 100, type: WidthType.PERCENTAGE }
          }),
          new Paragraph({
            text: `Total de estudiantes: ${estudiantes.length}`,
            spacing: { before: 400 }
          }),
          new Paragraph({
            text: 'Firma del docente: _________________________',
            spacing: { before: 200 }
          })
        ]
      }]
    });
    
    // Generar nombre de archivo
    const nombreArchivo = `asistencia_${nivelNombre || 'todos'}_${turno || 'todos'}_${añoActual}_${Date.now()}.docx`;
    const rutaArchivo = path.join(DOCUMENTOS_ASISTENCIA_DIR, nombreArchivo);
    
    // Guardar archivo
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(rutaArchivo, buffer);
    
    return {
      rutaArchivo,
      nombreArchivo,
      totalEstudiantes: estudiantes.length,
      nivel: nivelNombre,
      turno: turno,
      año: añoActual
    };
  } catch (error) {
    console.error('Error al generar Word de asistencia:', error);
    throw error;
  }
}

module.exports = {
  generarPDFAsistencia,
  generarWordAsistencia,
  obtenerEstudiantesPorNivelTurno,
  DOCUMENTOS_ASISTENCIA_DIR
};
