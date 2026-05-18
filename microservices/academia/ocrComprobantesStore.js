const pool = require('./config');

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ocr_comprobantes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    numero_remitente VARCHAR(32),
    mimetype VARCHAR(100),
    json_data JSON,
    imagen LONGBLOB,
    estado ENUM('pendiente','revisado') DEFAULT 'pendiente',
    origen VARCHAR(50) DEFAULT 'whatsapp',
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revisado_por INT NULL,
    revisado_en TIMESTAMP NULL,
    observaciones TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(TABLE_SQL);
  tableReady = true;
}

async function guardarOcrComprobante({ numeroRemitente, mimetype, buffer, resultado, origen = 'whatsapp' }) {
  await ensureTable();
  const [res] = await pool.query(
    `INSERT INTO ocr_comprobantes (numero_remitente, mimetype, json_data, imagen, origen)
     VALUES (?, ?, ?, ?, ?)`,
    [numeroRemitente || null, mimetype || null, JSON.stringify(resultado || {}), buffer || null, origen]
  );
  return res.insertId;
}

async function listarOcrComprobantes({ estado = null, limite = 50 }) {
  await ensureTable();
  const params = [];
  let sql = `SELECT id, numero_remitente, mimetype, estado, origen, creado_en, revisado_por, revisado_en, observaciones, json_data
             FROM ocr_comprobantes`;
  if (estado) {
    sql += ' WHERE estado = ?';
    params.push(estado);
  }
  sql += ' ORDER BY creado_en DESC LIMIT ?';
  params.push(Number(limite) || 50);
  const [rows] = await pool.query(sql, params);
  return rows.map(r => ({
    id: r.id,
    numero_remitente: r.numero_remitente,
    mimetype: r.mimetype,
    estado: r.estado,
    origen: r.origen,
    creado_en: r.creado_en,
    revisado_por: r.revisado_por,
    revisado_en: r.revisado_en,
    observaciones: r.observaciones,
    datos: r.json_data
  }));
}

async function obtenerOcrComprobante(id) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, numero_remitente, mimetype, estado, origen, creado_en, revisado_por, revisado_en, observaciones, json_data
     FROM ocr_comprobantes WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows.length ? {
    id: rows[0].id,
    numero_remitente: rows[0].numero_remitente,
    mimetype: rows[0].mimetype,
    estado: rows[0].estado,
    origen: rows[0].origen,
    creado_en: rows[0].creado_en,
    revisado_por: rows[0].revisado_por,
    revisado_en: rows[0].revisado_en,
    observaciones: rows[0].observaciones,
    datos: rows[0].json_data
  } : null;
}

async function obtenerImagenOcr(id) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT mimetype, imagen FROM ocr_comprobantes WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows.length || !rows[0].imagen) return null;
  const base64 = Buffer.from(rows[0].imagen).toString('base64');
  return { mimetype: rows[0].mimetype, base64 };
}

async function marcarRevisado(id, revisadoPor = null, observaciones = null) {
  await ensureTable();
  await pool.query(
    `UPDATE ocr_comprobantes 
     SET estado = 'revisado', revisado_por = ?, revisado_en = NOW(), observaciones = ?
     WHERE id = ?`,
    [revisadoPor, observaciones, id]
  );
}

async function eliminarTodosComprobantes() {
  await ensureTable();
  const [result] = await pool.query(`DELETE FROM ocr_comprobantes`);
  return result.affectedRows;
}

module.exports = {
  ensureTable,
  guardarOcrComprobante,
  listarOcrComprobantes,
  obtenerOcrComprobante,
  obtenerImagenOcr,
  marcarRevisado,
  eliminarTodosComprobantes
};
