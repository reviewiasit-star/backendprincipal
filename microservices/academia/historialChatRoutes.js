const express = require('express');
const router = express.Router();
const pool = require('./config');
const { authMiddleware } = require('../../middleware/auth');
const { obtenerInstancia } = require('./whatsappServiceSingleton');

function soloAdmin(req, res, next) {
  if (!req.user || req.user.rol !== 'Administrador') {
    return res.status(403).json({
      ok: false,
      message: 'Solo administradores pueden ver el historial de chat.'
    });
  }
  next();
}

function etiquetaTutor(info) {
  if (!info) return null;
  const tt = String(info.tipo_telefono || '');
  let nombre = '';
  let apellido = '';
  let tratamiento = 'Sr./Sra.';
  if (tt.startsWith('padre')) {
    nombre = info.nombre_padre || '';
    apellido = info.apellido_padre || '';
    tratamiento = 'Sr.';
  } else if (tt.startsWith('madre')) {
    nombre = info.nombre_madre || '';
    apellido = info.apellido_madre || '';
    tratamiento = 'Sra.';
  } else if (tt.startsWith('autorizado')) {
    nombre = info.nombre_autorizado || '';
    apellido = '';
    tratamiento = 'Sr./Sra.';
  }
  const nomCompleto = [nombre, apellido].filter(Boolean).join(' ').trim();
  const estudiante = [info.nombre_estudiante, info.apellido_paterno].filter(Boolean).join(' ').trim();
  if (nomCompleto && estudiante) {
    return `${tratamiento} ${nomCompleto}, tutor(a) de ${estudiante}`;
  }
  if (nomCompleto) return `${tratamiento} ${nomCompleto}`;
  if (estudiante) return `Tutor(a) de ${estudiante}`;
  return null;
}

router.get('/conversaciones', authMiddleware, soloAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        agg.identificador_externo AS telefono,
        agg.ultimo_mensaje_en AS ultimo_mensaje_en,
        agg.total_mensajes AS total_mensajes,
        (
          SELECT m2.mensaje
          FROM mensajes_conversacion m2
          INNER JOIN sesiones_conversacion s2 ON s2.id = m2.sesion_id
          WHERE s2.identificador_externo = agg.identificador_externo
            AND s2.tipo_sesion = 'whatsapp'
          ORDER BY m2.creado_en DESC
          LIMIT 1
        ) AS ultima_vista_previa
      FROM (
        SELECT 
          s.identificador_externo,
          MAX(m.creado_en) AS ultimo_mensaje_en,
          COUNT(*) AS total_mensajes
        FROM sesiones_conversacion s
        INNER JOIN mensajes_conversacion m ON m.sesion_id = s.id
        WHERE s.tipo_sesion = 'whatsapp'
          AND s.identificador_externo IS NOT NULL
          AND s.identificador_externo != ''
        GROUP BY s.identificador_externo
      ) agg
      ORDER BY agg.ultimo_mensaje_en DESC
      LIMIT 300
    `);

    const wa = obtenerInstancia();
    const conversaciones = await Promise.all(
      rows.map(async (r) => {
        let info = null;
        try {
          info = await wa.buscarRemitenteEnBD(r.telefono, pool);
        } catch (_) {
          info = null;
        }
        return {
          telefono: r.telefono,
          ultimo_mensaje_en: r.ultimo_mensaje_en,
          total_mensajes: Number(r.total_mensajes) || 0,
          ultima_vista_previa: r.ultima_vista_previa
            ? String(r.ultima_vista_previa).slice(0, 160)
            : '',
          etiqueta: etiquetaTutor(info),
          registrado_en_estudiantes: !!info
        };
      })
    );

    res.json({ ok: true, conversaciones });
  } catch (err) {
    console.error('[historial-chat] conversaciones:', err);
    res.status(500).json({ ok: false, message: 'Error al cargar conversaciones' });
  }
});

router.get('/mensajes', authMiddleware, soloAdmin, async (req, res) => {
  try {
    const telefono = typeof req.query.telefono === 'string' ? req.query.telefono.trim() : '';
    if (!telefono) {
      return res.status(400).json({ ok: false, message: 'Parámetro telefono requerido' });
    }

    const [mensajes] = await pool.query(
      `
      SELECT m.id, m.rol, m.mensaje, m.creado_en
      FROM mensajes_conversacion m
      INNER JOIN sesiones_conversacion s ON s.id = m.sesion_id
      WHERE s.identificador_externo = ?
        AND s.tipo_sesion = 'whatsapp'
      ORDER BY m.creado_en ASC
      LIMIT 3000
    `,
      [telefono]
    );

    const wa = obtenerInstancia();
    let info = null;
    try {
      info = await wa.buscarRemitenteEnBD(telefono, pool);
    } catch (_) {
      info = null;
    }

    res.json({
      ok: true,
      telefono,
      etiqueta: etiquetaTutor(info),
      registrado_en_estudiantes: !!info,
      mensajes: mensajes.map((m) => ({
        id: m.id,
        rol: m.rol,
        mensaje: m.mensaje,
        creado_en: m.creado_en
      }))
    });
  } catch (err) {
    console.error('[historial-chat] mensajes:', err);
    res.status(500).json({ ok: false, message: 'Error al cargar mensajes' });
  }
});

module.exports = router;
