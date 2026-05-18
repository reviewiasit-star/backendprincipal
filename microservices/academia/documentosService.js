// ===== SERVICIO DE PROCESAMIENTO DE DOCUMENTOS PARA EL AGENTE INTELIGENTE =====
// Procesa documentos Word y PDF para extraer texto y almacenarlo en la BD

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const pool = require('./config');

// Directorio para almacenar documentos subidos
const DOCUMENTOS_DIR = path.join(__dirname, 'documentos_agente');

// Crear directorio si no existe
if (!fs.existsSync(DOCUMENTOS_DIR)) {
  fs.mkdirSync(DOCUMENTOS_DIR, { recursive: true });
}

// Inicializar tabla de documentos
async function inicializarTablaDocumentos() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documentos_agente (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        tipo ENUM('reglamento', 'becas', 'inscripcion', 'otros') DEFAULT 'otros',
        formato ENUM('pdf', 'docx', 'txt') NOT NULL,
        ruta_archivo VARCHAR(500) NOT NULL,
        texto_extraido LONGTEXT,
        tamanio_bytes INT,
        activo BOOLEAN DEFAULT TRUE,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tipo (tipo),
        INDEX idx_activo (activo),
        INDEX idx_creado (creado_en)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error('❌ Error al inicializar tabla de documentos:', error);
    throw error;
  }
}

// Inicializar tablas para cache de chunks y embeddings
async function inicializarTablasCache() {
  try {
    // Tabla para chunks de documentos con metadata
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chunks_documentos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        documento_id INT NOT NULL,
        texto LONGTEXT NOT NULL,
        metadata JSON,
        posicion INT DEFAULT 0,
        hash_texto VARCHAR(64),
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (documento_id) REFERENCES documentos_agente(id) ON DELETE CASCADE,
        INDEX idx_documento (documento_id),
        INDEX idx_hash (hash_texto)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Tabla para embeddings precalculados
    await pool.query(`
      CREATE TABLE IF NOT EXISTS embeddings_chunks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chunk_id INT NOT NULL,
        embedding LONGBLOB NOT NULL,
        modelo VARCHAR(100) DEFAULT 'multilingual-e5-base',
        dimension INT DEFAULT 768,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chunk_id) REFERENCES chunks_documentos(id) ON DELETE CASCADE,
        INDEX idx_chunk (chunk_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ Tablas de cache de chunks y embeddings inicializadas');
  } catch (error) {
    console.error('❌ Error al inicializar tablas de cache:', error);
    // No lanzamos error para no bloquear el sistema
  }
}

// Guardar chunks de un documento en la BD
async function guardarChunksDocumento(documentoId, chunks) {
  try {
    await inicializarTablasCache();

    // Eliminar chunks anteriores del documento
    await pool.query('DELETE FROM chunks_documentos WHERE documento_id = ?', [documentoId]);

    // Insertar nuevos chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const texto = typeof chunk === 'object' ? chunk.texto : chunk;
      const metadata = typeof chunk === 'object' ? chunk.metadata : null;

      // Crear hash del texto para verificación rápida
      const crypto = require('crypto');
      const hashTexto = crypto.createHash('md5').update(texto).digest('hex');

      await pool.query(`
        INSERT INTO chunks_documentos (documento_id, texto, metadata, posicion, hash_texto)
        VALUES (?, ?, ?, ?, ?)
      `, [documentoId, texto, metadata ? JSON.stringify(metadata) : null, i, hashTexto]);
    }

    console.log(`✅ ${chunks.length} chunks guardados para documento ID ${documentoId}`);
    return true;
  } catch (error) {
    console.error('❌ Error al guardar chunks:', error);
    return false;
  }
}

// Guardar embeddings de chunks en la BD
async function guardarEmbeddingsChunks(documentoId, embeddings) {
  try {
    await inicializarTablasCache();

    // Obtener chunks del documento
    const [chunks] = await pool.query(
      'SELECT id FROM chunks_documentos WHERE documento_id = ? ORDER BY posicion',
      [documentoId]
    );

    if (chunks.length !== embeddings.length) {
      console.warn(`⚠️ Número de chunks (${chunks.length}) != número de embeddings (${embeddings.length})`);
      return false;
    }

    // Insertar embeddings
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = chunks[i].id;
      const embedding = embeddings[i];

      // Serializar embedding como buffer
      const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

      // Eliminar embedding anterior si existe
      await pool.query('DELETE FROM embeddings_chunks WHERE chunk_id = ?', [chunkId]);

      // Insertar nuevo embedding (dimension puede no existir en esquemas antiguos)
      try {
        await pool.query(`
          INSERT INTO embeddings_chunks (chunk_id, embedding, dimension)
          VALUES (?, ?, ?)
        `, [chunkId, embeddingBuffer, embedding.length]);
      } catch (dimErr) {
        if (dimErr.message && dimErr.message.includes("Unknown column 'dimension'")) {
          await pool.query(`
            INSERT INTO embeddings_chunks (chunk_id, embedding)
            VALUES (?, ?)
          `, [chunkId, embeddingBuffer]);
        } else {
          throw dimErr;
        }
      }
    }

    console.log(`✅ ${embeddings.length} embeddings guardados para documento ID ${documentoId}`);
    return true;
  } catch (error) {
    console.error('❌ Error al guardar embeddings:', error);
    return false;
  }
}

// Obtener chunks y embeddings de la BD
async function obtenerChunksYEmbeddingsCache() {
  try {
    await inicializarTablasCache();

    // Obtener chunks con sus embeddings (solo de documentos activos)
    // Nota: no usamos e.dimension porque esa columna puede no existir
    const [rows] = await pool.query(`
      SELECT 
        c.id as chunk_id,
        c.documento_id,
        c.texto,
        c.metadata,
        c.posicion,
        e.embedding,
        d.nombre as documento_nombre,
        d.tipo as documento_tipo
      FROM chunks_documentos c
      INNER JOIN documentos_agente d ON c.documento_id = d.id
      LEFT JOIN embeddings_chunks e ON c.id = e.chunk_id
      WHERE d.activo = TRUE
      ORDER BY c.documento_id, c.posicion
    `);

    if (rows.length === 0) {
      return null; // No hay cache
    }

    // Procesar resultados
    const chunks = [];
    const metadata = [];
    const embeddings = [];
    let tieneEmbeddings = true;

    for (const row of rows) {
      chunks.push(row.texto);

      // Parsear metadata JSON
      let meta = {};
      try {
        meta = row.metadata ? JSON.parse(row.metadata) : {};
      } catch (e) {
        meta = {};
      }
      meta.documento = row.documento_nombre;
      meta.tipo = row.documento_tipo;
      metadata.push(meta);

      // Deserializar embedding (Buffer de MySQL puede tener byteOffset no alineado a 4)
      if (row.embedding && row.embedding.length > 0) {
        const rawBuf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding);
        const dimension = Math.floor(rawBuf.length / 4);
        const floatArray = new Float32Array(dimension);
        for (let i = 0; i < dimension; i++) {
          floatArray[i] = rawBuf.readFloatLE(i * 4);
        }
        embeddings.push(Array.from(floatArray));
      } else {
        tieneEmbeddings = false;
      }
    }

    console.log(`📦 [Cache] Cargados ${chunks.length} chunks desde BD`);

    return {
      chunks,
      metadata,
      embeddings: tieneEmbeddings ? embeddings : null
    };
  } catch (error) {
    console.error('❌ Error al obtener cache:', error);
    return null;
  }
}

// Verificar si los chunks de un documento están en cache
async function verificarCacheDocumento(documentoId) {
  try {
    const [rows] = await pool.query(
      'SELECT COUNT(*) as count FROM chunks_documentos WHERE documento_id = ?',
      [documentoId]
    );
    return rows[0].count > 0;
  } catch (error) {
    return false;
  }
}

// Procesar archivo PDF
async function procesarPDF(rutaArchivo) {
  try {
    const dataBuffer = fs.readFileSync(rutaArchivo);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    console.error('Error al procesar PDF:', error);
    throw new Error(`Error al procesar PDF: ${error.message}`);
  }
}

// Procesar archivo Word (DOCX)
async function procesarDOCX(rutaArchivo) {
  try {
    const result = await mammoth.extractRawText({ path: rutaArchivo });
    return result.value;
  } catch (error) {
    console.error('Error al procesar DOCX:', error);
    throw new Error(`Error al procesar Word: ${error.message}`);
  }
}

// Procesar archivo de texto
async function procesarTXT(rutaArchivo) {
  try {
    return fs.readFileSync(rutaArchivo, 'utf-8');
  } catch (error) {
    console.error('Error al procesar TXT:', error);
    throw new Error(`Error al procesar texto: ${error.message}`);
  }
}

// Guardar documento en el sistema
async function guardarDocumento(archivo, tipo, usuarioId) {
  await inicializarTablaDocumentos();

  // Evitar duplicados: si ya existe un documento activo con el mismo nombre, rechazar
  const [existentes] = await pool.query(
    'SELECT id FROM documentos_agente WHERE nombre = ? AND activo = 1 LIMIT 1',
    [archivo.originalname]
  );
  if (existentes && existentes.length > 0) {
    throw new Error(`Ya existe un documento activo con el nombre "${archivo.originalname}". Desactiva o elimina el existente antes de subir uno nuevo.`);
  }

  const extension = path.extname(archivo.originalname).toLowerCase();
  const nombreArchivo = `${Date.now()}-${archivo.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const rutaArchivo = path.join(DOCUMENTOS_DIR, nombreArchivo);

  // Guardar archivo en disco
  fs.writeFileSync(rutaArchivo, archivo.buffer);

  // Determinar formato
  let formato = 'txt';
  if (extension === '.pdf') formato = 'pdf';
  else if (extension === '.docx' || extension === '.doc') formato = 'docx';
  else if (extension === '.txt') formato = 'txt';
  else {
    throw new Error(`Formato no soportado: ${extension}`);
  }

  // Extraer texto según el formato
  let textoExtraido = '';
  try {
    if (formato === 'pdf') {
      textoExtraido = await procesarPDF(rutaArchivo);
    } else if (formato === 'docx') {
      textoExtraido = await procesarDOCX(rutaArchivo);
    } else if (formato === 'txt') {
      textoExtraido = await procesarTXT(rutaArchivo);
    }
  } catch (error) {
    // Si falla la extracción, eliminar el archivo y lanzar error
    fs.unlinkSync(rutaArchivo);
    throw error;
  }

  // Guardar en base de datos
  const [result] = await pool.query(`
    INSERT INTO documentos_agente 
    (nombre, tipo, formato, ruta_archivo, texto_extraido, tamanio_bytes, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    archivo.originalname,
    tipo || 'otros',
    formato,
    rutaArchivo,
    textoExtraido,
    archivo.size,
    usuarioId
  ]);

  return {
    id: result.insertId,
    nombre: archivo.originalname,
    tipo: tipo || 'otros',
    formato,
    tamanio_bytes: archivo.size,
    texto_extraido: textoExtraido.substring(0, 200) + '...', // Preview
    texto_completo: textoExtraido // Para generar chunks y embeddings
  };
}

// Obtener todos los documentos activos
async function obtenerDocumentos(activos = true) {
  await inicializarTablaDocumentos();

  const query = activos
    ? `SELECT * FROM documentos_agente WHERE activo = TRUE ORDER BY creado_en DESC`
    : `SELECT * FROM documentos_agente ORDER BY creado_en DESC`;

  const [documentos] = await pool.query(query);
  return documentos;
}

// Obtener documento por ID
async function obtenerDocumentoPorId(id) {
  await inicializarTablaDocumentos();

  const [documentos] = await pool.query(
    `SELECT * FROM documentos_agente WHERE id = ?`,
    [id]
  );

  return documentos.length > 0 ? documentos[0] : null;
}

// Eliminar documento (marcar como inactivo o eliminar físicamente)
async function eliminarDocumento(id, eliminarFisico = false) {
  await inicializarTablaDocumentos();

  const documento = await obtenerDocumentoPorId(id);
  if (!documento) {
    throw new Error('Documento no encontrado');
  }

  if (eliminarFisico) {
    // Eliminar archivo físico
    if (fs.existsSync(documento.ruta_archivo)) {
      fs.unlinkSync(documento.ruta_archivo);
    }
    // Eliminar de BD
    await pool.query(`DELETE FROM documentos_agente WHERE id = ?`, [id]);
  } else {
    // Solo marcar como inactivo
    await pool.query(`UPDATE documentos_agente SET activo = FALSE WHERE id = ?`, [id]);
  }

  return { success: true };
}

// Activar documento
async function activarDocumento(id) {
  await inicializarTablaDocumentos();

  await pool.query(`UPDATE documentos_agente SET activo = TRUE WHERE id = ?`, [id]);
  return { success: true };
}

// Obtener chunks de un documento (para visualización en el panel)
async function obtenerChunksPorDocumento(documentoId) {
  await inicializarTablasCache();

  const [rows] = await pool.query(
    `SELECT id, documento_id, texto, metadata, posicion 
     FROM chunks_documentos 
     WHERE documento_id = ? 
     ORDER BY posicion`,
    [documentoId]
  );

  return rows.map((row) => {
    let meta = {};
    try {
      meta = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
    } catch (e) {
      meta = {};
    }
    return {
      id: row.id,
      documento_id: row.documento_id,
      texto: row.texto,
      metadata: meta,
      posicion: row.posicion
    };
  });
}

// Obtener todos los textos de documentos activos para el agente
async function obtenerTextosDocumentosActivos() {
  await inicializarTablaDocumentos();

  const [documentos] = await pool.query(`
    SELECT id, nombre, tipo, texto_extraido 
    FROM documentos_agente 
    WHERE activo = TRUE 
    ORDER BY tipo, nombre
  `);

  return documentos;
}

module.exports = {
  inicializarTablaDocumentos,
  inicializarTablasCache,
  guardarDocumento,
  obtenerDocumentos,
  obtenerDocumentoPorId,
  obtenerChunksPorDocumento,
  eliminarDocumento,
  activarDocumento,
  obtenerTextosDocumentosActivos,
  guardarChunksDocumento,
  guardarEmbeddingsChunks,
  obtenerChunksYEmbeddingsCache,
  verificarCacheDocumento,
  procesarPDF,
  procesarDOCX,
  procesarTXT
};

