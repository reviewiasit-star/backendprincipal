const express = require('express');
const pool = require('./config');

const ESTADOS_INSCRIPCION_VALIDOS = "('activo','concluido')";

/**
 * Normaliza valores de query string para detectar booleanos
 */
const normalizarValorBooleano = (valor) => {
  if (valor === undefined || valor === null) return null;
  const normalizado = valor
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const opcionesVerdaderas = ['1', 'true', 'si', 'inscrito', 'activo'];
  const opcionesFalsas = ['0', 'false', 'no', 'noinscrito', 'no-inscrito', 'sin', 'sininscripcion', 'sin-inscripcion'];

  if (opcionesVerdaderas.includes(normalizado)) return true;
  if (opcionesFalsas.includes(normalizado)) return false;
  return null;
};

/**
 * Construye y ejecuta la consulta contra la vista vista_inscripciones_resumen
 */
async function obtenerEstudiantesDesdeVista({
  anio,
  nivel_id,
  curso_id,
  bloque_id,
  turno
}) {
  const condiciones = ['vir.anio = ?'];
  const params = [anio];

  if (nivel_id) {
    condiciones.push('vir.nivel_id = ?');
    params.push(parseInt(nivel_id, 10));
  }

  if (curso_id) {
    condiciones.push('vir.curso_id = ?');
    params.push(parseInt(curso_id, 10));
  }

  if (bloque_id) {
    condiciones.push('vir.bloque_id = ?');
    params.push(parseInt(bloque_id, 10));
  }

  if (turno) {
    condiciones.push('LOWER(TRIM(COALESCE(NULLIF(c.turno, ""), vir.turno, ""))) = ?');
    params.push(turno.toString().trim().toLowerCase());
  }

  const query = `
    SELECT 
      vir.inscripcion_id,
      vir.anio,
      e.id AS estudiante_id,
      e.nombre,
      e.apellido_paterno,
      e.apellido_materno,
      e.ci_estudiante,
      e.codigo_estudiante,
      COALESCE(NULLIF(TRIM(c.turno), ''), vir.turno) AS turno,
      vir.nivel_id,
      vir.nivel_nombre,
      vir.curso_id,
      vir.curso_nombre,
      vir.bloque_id,
      vir.bloque_nombre,
      vir.estado AS estado_inscripcion
    FROM vista_inscripciones_resumen vir
    JOIN estudiantes e ON e.id = vir.estudiante_id
    LEFT JOIN curso c ON c.id = vir.curso_id
    WHERE ${condiciones.join(' AND ')}
    ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre
  `;

  const [rows] = await pool.query(query, params);
  return rows.map((row) => ({
    id: row.inscripcion_id,
    estudiante_id: row.estudiante_id,
    nombre: row.nombre,
    apellido_paterno: row.apellido_paterno,
    apellido_materno: row.apellido_materno,
    ci_estudiante: row.ci_estudiante,
    codigo_estudiante: row.codigo_estudiante,
    turno: row.turno || 'Sin turno',
    nivel_id: row.nivel_id,
    nivel_nombre: row.nivel_nombre || 'Sin nivel',
    curso_id: row.curso_id,
    curso_nombre: row.curso_nombre || 'Sin curso',
    bloque_id: row.bloque_id,
    bloque_nombre: row.bloque_nombre || 'Sin bloque',
    estado_inscripcion: row.estado_inscripcion || 'Sin inscripción'
  }));
}

/**
 * Obtiene estudiantes que no tienen inscripción para un año determinado
 */
async function obtenerEstudiantesSinInscripcion(anio) {
  const query = `
    SELECT 
      NULL AS inscripcion_id,
      e.id AS estudiante_id,
      e.nombre,
      e.apellido_paterno,
      e.apellido_materno,
      e.ci_estudiante,
      e.codigo_estudiante
    FROM estudiantes e
    WHERE e.estado_id = 1
      AND NOT EXISTS (
        SELECT 1
        FROM inscripciones i
        WHERE i.estudiante_id = e.id
          AND i.estado IN ${ESTADOS_INSCRIPCION_VALIDOS}
          AND (
            (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
            OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
          )
      )
    ORDER BY e.apellido_paterno, e.apellido_materno, e.nombre
  `;

  const [rows] = await pool.query(query, [anio, anio]);
  return rows.map((row) => ({
    id: null,
    estudiante_id: row.estudiante_id,
    nombre: row.nombre,
    apellido_paterno: row.apellido_paterno,
    apellido_materno: row.apellido_materno,
    ci_estudiante: row.ci_estudiante,
    codigo_estudiante: row.codigo_estudiante,
    turno: 'Sin turno',
    nivel_id: null,
    nivel_nombre: 'Sin nivel',
    curso_id: null,
    curso_nombre: 'Sin curso',
    bloque_id: null,
    bloque_nombre: 'Sin bloque',
    estado_inscripcion: 'Sin inscripción'
  }));
}

function reporteInscripcionRoutes(app, authMiddleware) {
  // Obtener total de estudiantes registrados en el sistema
  app.get('/api/reportes-inscripcion/total-estudiantes', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(*) AS count
        FROM estudiantes e
        WHERE e.estado_id = 1
      `);
      res.json({ ok: true, count: rows[0]?.count || 0 });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener total de estudiantes', error: error.message });
    }
  });

  // Inscripciones registradas para un año de gestión (activas o concluidas)
  app.get('/api/reportes-inscripcion/inscripciones-count', authMiddleware, async (req, res) => {
    try {
      const anioNum = parseInt(req.query.anio, 10) || new Date().getFullYear();
      const [rows] = await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM inscripciones i
        WHERE i.estado IN ${ESTADOS_INSCRIPCION_VALIDOS}
          AND (
            (i.gestion_academica IS NOT NULL AND i.gestion_academica = ?)
            OR (i.gestion_academica IS NULL AND YEAR(i.fecha_inscripcion) = ?)
          )
      `,
        [anioNum, anioNum]
      );
      res.json({ ok: true, count: rows[0]?.count || 0, anio: anioNum });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener cantidad de inscripciones',
        error: error.message
      });
    }
  });

  // Estudiantes distintos con al menos un servicio adicional (no anulado), opcional por año del servicio
  app.get('/api/reportes-inscripcion/estudiantes-con-servicios-count', authMiddleware, async (req, res) => {
    try {
      const anioQ = req.query.anio;
      const anioNum = anioQ !== undefined && anioQ !== '' && anioQ !== 'todos' ? parseInt(anioQ, 10) : null;
      let query = `
        SELECT COUNT(DISTINCT se.estudiante_id) AS count
        FROM servicios_estudiante se
        WHERE se.estado IN ('activo', 'concluido')
      `;
      const params = [];
      if (anioNum !== null && !Number.isNaN(anioNum)) {
        query += ' AND se.anio = ?';
        params.push(anioNum);
      }
      const [rows] = await pool.query(query, params);
      res.json({ ok: true, count: rows[0]?.count || 0, anio: anioNum });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiantes con servicios',
        error: error.message
      });
    }
  });

  // Obtener estudiantes con filtros para reportes
  app.get('/api/reportes-inscripcion/estudiantes', authMiddleware, async (req, res) => {
    try {
      const { turno, nivel_id, curso_id, bloque_id, anio, inscrito } = req.query;
      const anioNum = parseInt(anio, 10) || new Date().getFullYear();

      const filtrarPorInscrito = normalizarValorBooleano(inscrito);
      const filtrosInscripcionAplicados = Boolean(
        nivel_id || curso_id || bloque_id || turno
      );
      const incluirSinInscripcion = filtrarPorInscrito === null && !filtrosInscripcionAplicados;

      let resultado = [];

      if (filtrarPorInscrito !== false) {
        const inscriptos = await obtenerEstudiantesDesdeVista({
          anio: anioNum,
          nivel_id,
          curso_id,
          bloque_id,
          turno
        });
        resultado = inscriptos;
      }

      if (filtrarPorInscrito === false || incluirSinInscripcion) {
        const sinInscripcion = await obtenerEstudiantesSinInscripcion(anioNum);
        if (filtrarPorInscrito === false) {
          resultado = sinInscripcion;
        } else {
          resultado = [...resultado, ...sinInscripcion];
        }
      }

      res.json(resultado);
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener estudiantes para reporte', 
        error: error.message 
      });
    }
  });
}

module.exports = reporteInscripcionRoutes;

