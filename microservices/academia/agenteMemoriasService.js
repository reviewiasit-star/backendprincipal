// ===== SERVICIO DE MEMORIAS DEL AGENTE INTELIGENTE =====
// Permite al admin darle "avisos" al agente que este usará para responder preguntas
// Ejemplo: "La cajera no estará hoy" → el agente lo recuerda y lo usa si alguien pregunta

const pool = require('./config');

const TABLA = 'agente_memorias';

async function inicializarTabla() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agente_memorias (
        id INT AUTO_INCREMENT PRIMARY KEY,
        contenido TEXT NOT NULL COMMENT 'La instrucción o aviso que el admin le da al agente',
        tipo ENUM('ausencia','aviso','horario','evento','otro') DEFAULT 'otro',
        keywords VARCHAR(500) COMMENT 'Palabras clave para recuperación rápida (ej: cajera,cajas,caja)',
        fecha_inicio DATETIME DEFAULT CURRENT_TIMESTAMP,
        fecha_fin DATETIME DEFAULT NULL COMMENT 'NULL = sin vencimiento definido',
        activa BOOLEAN DEFAULT TRUE,
        creado_por INT DEFAULT NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_activa (activa),
        INDEX idx_tipo (tipo),
        INDEX idx_fecha_fin (fecha_fin)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error('❌ Error inicializando tabla agente_memorias:', error.message);
  }
}

// Initialize on load (non-blocking)
inicializarTabla().catch(() => {});

async function crearMemoria({ contenido, tipo = 'otro', keywords = '', fecha_fin = null, creado_por = null }) {
  await inicializarTabla();
  const [result] = await pool.query(
    `INSERT INTO agente_memorias (contenido, tipo, keywords, fecha_fin, creado_por) VALUES (?, ?, ?, ?, ?)`,
    [contenido.trim(), tipo, keywords || null, fecha_fin || null, creado_por || null]
  );
  return result.insertId;
}

async function obtenerMemoriasActivas() {
  try {
    await inicializarTabla();
    const [rows] = await pool.query(`
      SELECT id, contenido, tipo, keywords, fecha_inicio, fecha_fin, activa, creado_en
      FROM agente_memorias
      WHERE activa = TRUE
        AND (fecha_fin IS NULL OR fecha_fin > NOW())
      ORDER BY creado_en DESC
    `);
    return rows;
  } catch (e) {
    console.warn('⚠️ Error obteniendo memorias activas:', e.message);
    return [];
  }
}

async function obtenerTodas() {
  try {
    await inicializarTabla();
    const [rows] = await pool.query(`
      SELECT id, contenido, tipo, keywords, fecha_inicio, fecha_fin, activa, creado_en
      FROM agente_memorias
      ORDER BY creado_en DESC
      LIMIT 200
    `);
    return rows;
  } catch (e) {
    return [];
  }
}

async function desactivarMemoria(id) {
  await pool.query(`UPDATE agente_memorias SET activa = FALSE WHERE id = ?`, [id]);
}

async function eliminarMemoria(id) {
  await pool.query(`DELETE FROM agente_memorias WHERE id = ?`, [id]);
}

async function limpiarVencidas() {
  try {
    await pool.query(`UPDATE agente_memorias SET activa = FALSE WHERE fecha_fin IS NOT NULL AND fecha_fin <= NOW() AND activa = TRUE`);
  } catch (e) {
    // non-critical
  }
}

// Run cleanup every hour
setInterval(() => limpiarVencidas(), 60 * 60 * 1000);

// Auto-detect memory type from content
function detectarTipo(texto) {
  const t = texto.toLowerCase();
  if (/no estar[aá]|ausente|viaj|de viaje|no asistir[aá]|no vendr[aá]|no podr[aá]/.test(t)) return 'ausencia';
  if (/horario|hora|turno|entrada|salida/.test(t)) return 'horario';
  if (/evento|acto|ceremonia|reunión|reunion|actividad/.test(t)) return 'evento';
  if (/avisa|inform|anuncia|comunica|aviso|importante/.test(t)) return 'aviso';
  return 'otro';
}

// Extract keywords from content for fast retrieval
function extraerKeywords(texto) {
  const keywords = new Set();
  const t = texto.toLowerCase();

  // Roles/personas
  if (/cajera|caja|cajas/.test(t)) keywords.add('cajera');
  if (/director[ao]/.test(t)) keywords.add('director');
  if (/secretar[iao]/.test(t)) keywords.add('secretaria');
  if (/admin|administrador/.test(t)) keywords.add('admin');
  if (/docente|profesor[ao]|maestro/.test(t)) keywords.add('docente');

  // Topics
  if (/pago|cuota|mensualidad/.test(t)) keywords.add('pagos');
  if (/inscripci[oó]n|matr[íi]cul/.test(t)) keywords.add('inscripcion');
  if (/horario|hora/.test(t)) keywords.add('horario');
  if (/clases/.test(t)) keywords.add('clases');

  return Array.from(keywords).join(',');
}

module.exports = {
  inicializarTabla,
  crearMemoria,
  obtenerMemoriasActivas,
  obtenerTodas,
  desactivarMemoria,
  eliminarMemoria,
  limpiarVencidas,
  detectarTipo,
  extraerKeywords,
};
