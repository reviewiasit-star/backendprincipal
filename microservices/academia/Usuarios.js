const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const SALT_ROUNDS = 10;

const { JWT_SECRET, JWT_EXPIRES_IN, SMTP_USER, SMTP_PASS } = require('./appConfig');




// Función para configurar las rutas de gestión de usuarios
function configurarRutasUsuarios(app, pool, authMiddleware) {

  // ===== LOGICA DE USUARIOS =====

  // Listar todos los usuarios
  app.get('/api/usuarios', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT u.id, u.usuario, u.nombre_completo AS nombre, u.correo, r.nombre AS rol, u.rol_id
        FROM usuarios u
        LEFT JOIN roles r ON u.rol_id = r.id
        ORDER BY u.nombre_completo
      `);
      res.json(rows);
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener usuarios', 
        error: error.message 
      });
    }
  });

  // Crear usuario
  app.post('/api/usuarios', authMiddleware, async (req, res) => {
    try {
      const { usuario, password, nombre, rol_id, correo } = req.body;
      
      // Validar datos requeridos
      if (!usuario || !password || !nombre || !rol_id) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Todos los campos son requeridos: usuario, password, nombre, rol_id' 
        });
      }

      // Verificar si el usuario ya existe
      const [existingUser] = await pool.query(
        'SELECT id FROM usuarios WHERE usuario = ?', 
        [usuario]
      );

      if (existingUser.length > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El nombre de usuario ya existe' 
        });
      }

      // Crear el usuario con contraseña hasheada
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      const [result] = await pool.query(
        'INSERT INTO usuarios (usuario, password, nombre_completo, rol_id, correo) VALUES (?, ?, ?, ?, ?)',
        [usuario, hashedPassword, nombre, rol_id, correo || null]
      );

      res.json({ 
        ok: true, 
        id: result.insertId,
        message: 'Usuario creado exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al crear usuario', 
        error: error.message 
      });
    }
  });

  // Actualizar usuario
  app.put('/api/usuarios/:id', authMiddleware, async (req, res) => {
    try {
      const { usuario, password, nombre, rol_id, correo } = req.body;
      
      // Verificar si el usuario existe
      const [existingUser] = await pool.query(
        'SELECT id FROM usuarios WHERE id = ?', 
        [req.params.id]
      );

      if (existingUser.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          message: 'Usuario no encontrado' 
        });
      }

      // Verificar si el nombre de usuario ya existe (excluyendo el usuario actual)
      const [duplicateUser] = await pool.query(
        'SELECT id FROM usuarios WHERE usuario = ? AND id != ?', 
        [usuario, req.params.id]
      );

      if (duplicateUser.length > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El nombre de usuario ya existe' 
        });
      }

      // Determinar contraseña a guardar: mantener actual si no se envía, o hashear nueva si se envía
      let newPassword = null;
      if (password && password.trim() !== '') {
        if (password.startsWith('$2a$') || password.startsWith('$2b$') || password.startsWith('$2y$')) {
          newPassword = password;
        } else {
          newPassword = await bcrypt.hash(password, SALT_ROUNDS);
        }
      } else {
        const [curr] = await pool.query('SELECT password FROM usuarios WHERE id = ?', [req.params.id]);
        newPassword = curr.length ? curr[0].password : null;
      }

      await pool.query(
        'UPDATE usuarios SET usuario=?, password=?, nombre_completo=?, rol_id=?, correo=? WHERE id=?',
        [usuario, newPassword, nombre, rol_id, correo || null, req.params.id]
      );
      
      res.json({ 
        ok: true,
        message: 'Usuario actualizado exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al actualizar usuario', 
        error: error.message 
      });
    }
  });

  // Eliminar usuario
  app.delete('/api/usuarios/:id', authMiddleware, async (req, res) => {
    try {
      // Verificar si el usuario existe
      const [existingUser] = await pool.query(
        'SELECT id FROM usuarios WHERE id = ?', 
        [req.params.id]
      );

      if (existingUser.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          message: 'Usuario no encontrado' 
        });
      }

      // No permitir eliminar el propio usuario
      if (req.user.id == req.params.id) {
        return res.status(400).json({ 
          ok: false, 
          message: 'No puedes eliminar tu propio usuario' 
        });
      }

      await pool.query('DELETE FROM usuarios WHERE id = ?', [req.params.id]);
      
      res.json({ 
        ok: true,
        message: 'Usuario eliminado exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al eliminar usuario', 
        error: error.message 
      });
    }
  });

  // ===== ENDPOINTS PARA AUTENTICACIÓN =====

  // Login
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { usuario, password } = req.body;
      if (!usuario || !password) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Usuario y contraseña son requeridos' 
        });
      }
      const [rows] = await pool.query(`
        SELECT u.id, u.usuario, u.password, u.nombre_completo AS nombre, u.correo, u.rol_id, r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.rol_id = r.id
        WHERE u.usuario = ?
      `, [usuario]);

      if (rows.length === 0) {
        return res.status(401).json({ 
          ok: false, 
          message: 'Credenciales incorrectas' 
        });
      }

      const user = rows[0];
      const passwordMatches = await bcrypt.compare(password, user.password);
      if (!passwordMatches) {
        return res.status(401).json({ ok: false, message: 'Credenciales incorrectas' });
      }

      // Verificar que el usuario tenga un rol permitido para acceder
      // Permitidos: Administrador, Director, Secretaria, Cajero
      const allowedRoles = ['Administrador', 'Director', 'Tienda', 'Secretaria', 'Cajero'];
      if (!allowedRoles.includes(user.rol)) {
        return res.status(403).json({ 
          ok: false, 
          message: 'No tienes permisos para acceder al sistema' 
        });
      }

      // Generar token JWT
      const token = jwt.sign(
        { 
          id: user.id, 
          usuario: user.usuario, 
          nombre: user.nombre, 
          rol: user.rol,
          rol_id: user.rol_id 
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      res.json({
        ok: true,
        token,
        user: {
          id: user.id,
          usuario: user.usuario,
          nombre: user.nombre,
          nombre_completo: user.nombre,
          correo: user.correo,
          rol: user.rol,
          rol_id: user.rol_id
        }
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error en el servidor', 
        error: error.message 
      });
    }
  });

  // Verificar token
  app.get('/api/auth/verify', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          ok: false,
          message: 'Token de acceso requerido'
        });
      }

      const token = authHeader.substring(7);

      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Verificar que el usuario aún existe en la base de datos
        const [rows] = await pool.query(`
          SELECT u.id, u.usuario, u.nombre_completo AS nombre, u.correo, u.rol_id, r.nombre AS rol
          FROM usuarios u
          LEFT JOIN roles r ON u.rol_id = r.id
          WHERE u.id = ?
        `, [decoded.id]);

        if (rows.length === 0) {
          return res.status(401).json({
            ok: false,
            message: 'Usuario no encontrado'
          });
        }

        const user = rows[0];

        res.json({
          ok: true,
          user: {
            id: user.id,
            usuario: user.usuario,
            nombre: user.nombre,
            nombre_completo: user.nombre,
            correo: user.correo,
            rol: user.rol,
            rol_id: user.rol_id
          }
        });
      } catch (jwtError) {
        return res.status(401).json({
          ok: false,
          message: 'Token inválido'
        });
      }
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error en el servidor',
        error: error.message
      });
    }
  });

  // Obtener perfil del usuario actual
  app.get('/api/auth/perfil', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT u.id, u.usuario, u.nombre_completo, u.correo, u.rol_id, r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.rol_id = r.id
        WHERE u.id = ?
      `, [req.user.id]);

      if (rows.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          message: 'Usuario no encontrado' 
        });
      }

      res.json({ 
        ok: true,
        user: rows[0]
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener perfil', 
        error: error.message 
      });
    }
  });

  // Actualizar perfil del usuario actual (usuario, nombre_completo, correo)
  app.put('/api/auth/perfil', authMiddleware, async (req, res) => {
    try {
      const { usuario, nombre_completo, correo } = req.body;

      const usuarioTrim = (usuario || '').trim();
      const nombreTrim = (nombre_completo || '').trim();

      if (!usuarioTrim) {
        return res.status(400).json({
          ok: false,
          message: 'El nombre de usuario es requerido'
        });
      }

      if (!nombreTrim) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El nombre completo es requerido' 
        });
      }

      const [duplicado] = await pool.query(
        'SELECT id FROM usuarios WHERE usuario = ? AND id != ?',
        [usuarioTrim, req.user.id]
      );
      if (duplicado.length > 0) {
        return res.status(400).json({
          ok: false,
          message: 'Ese nombre de usuario ya está en uso'
        });
      }

      await pool.query(
        'UPDATE usuarios SET usuario = ?, nombre_completo = ?, correo = ? WHERE id = ?',
        [usuarioTrim, nombreTrim, correo ? String(correo).trim() || null : null, req.user.id]
      );

      const [rows] = await pool.query(`
        SELECT u.id, u.usuario, u.nombre_completo, u.correo, u.rol_id, r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.rol_id = r.id
        WHERE u.id = ?
      `, [req.user.id]);

      const u = rows[0];
      const token = jwt.sign(
        {
          id: u.id,
          usuario: u.usuario,
          nombre: u.nombre_completo,
          rol: u.rol,
          rol_id: u.rol_id
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      res.json({ 
        ok: true,
        message: 'Perfil actualizado exitosamente',
        token,
        user: {
          id: u.id,
          usuario: u.usuario,
          nombre: u.nombre_completo,
          nombre_completo: u.nombre_completo,
          correo: u.correo,
          rol: u.rol,
          rol_id: u.rol_id
        }
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al actualizar perfil', 
        error: error.message 
      });
    }
  });

  // Cambiar contraseña
  app.put('/api/auth/cambiar-password', authMiddleware, async (req, res) => {
    try {
      const { password_actual, password_nueva } = req.body;

      if (!password_actual || !password_nueva) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Contraseña actual y nueva son requeridas' 
        });
      }

      // Verificar contraseña actual con bcrypt
      const [rows] = await pool.query(
        'SELECT id, password FROM usuarios WHERE id = ?',
        [req.user.id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
      }
      const matches = await bcrypt.compare(password_actual, rows[0].password);
      if (!matches) {
        return res.status(400).json({ ok: false, message: 'Contraseña actual incorrecta' });
      }

      // Actualizar contraseña hasheada
      const hashedNew = await bcrypt.hash(password_nueva, SALT_ROUNDS);
      await pool.query(
        'UPDATE usuarios SET password = ? WHERE id = ?',
        [hashedNew, req.user.id]
      );

      res.json({ 
        ok: true,
        message: 'Contraseña actualizada exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al cambiar contraseña', 
        error: error.message 
      });
    }
  });

  // Solicitar recuperación de contraseña (usuario o correo)
  // Nuevo comportamiento: auto-restablecer y enviar la nueva contraseña por correo
  app.post('/api/auth/recuperar', async (req, res) => {
    try {
      const { usuario, correo } = req.body;
      if (!usuario && !correo) {
        return res.status(400).json({ ok: false, message: 'Debe proporcionar usuario o correo' });
      }

      const params = [];
      let where = '';
      if (usuario) { where = 'u.usuario = ?'; params.push(usuario); }
      else { where = 'u.correo = ?'; params.push(correo); }

      const [rows] = await pool.query(
        `SELECT u.id, u.usuario, u.correo FROM usuarios u WHERE ${where} LIMIT 1`,
        params
      );

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
      }

      const user = rows[0];
      if (!user.correo) {
        return res.status(400).json({ ok: false, message: 'El usuario no tiene correo registrado. No se puede enviar la nueva contraseña.' });
      }

      // Generar nueva contraseña aleatoria
      const crypto = require('crypto');
      const nuevaPassword = crypto.randomBytes(6).toString('hex'); // 12 caracteres hex

      // Resolver credenciales SMTP: ENV o archivo api.txt (normalizado sin espacios)
      const fs = require('fs');
      const path = require('path');
      const readApiPass = () => {
        const candidates = [
          path.resolve(process.cwd(), '..', 'api.txt'),
          path.resolve(process.cwd(), 'api.txt'),
          path.resolve(__dirname, '../../../api.txt'),
          path.resolve(__dirname, '../../api.txt'),
        ];
        for (const p of candidates) {
          try {
            if (fs.existsSync(p)) {
              const raw = fs.readFileSync(p, 'utf8');
              return (raw || '').replace(/\s+/g, '');
            }
          } catch (_) {}
        }
        return null;
      };

      const smtpUser = SMTP_USER;
      const smtpPass = SMTP_PASS || readApiPass();
      if (!smtpPass) {
        return res.status(400).json({ ok: false, message: 'No se puede enviar la nueva contraseña. Falta configuración SMTP.' });
      }

      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: smtpUser,
            pass: smtpPass
          }
        });

        const asunto = 'Nueva contraseña generada - Unidad Educativa';
        const html = `
          <p>Hola ${user.usuario},</p>
          <p>Se ha generado automáticamente una nueva contraseña para tu cuenta.</p>
          <p><strong>Usuario (credencial):</strong> ${user.usuario}</p>
          <p><strong>Nueva contraseña:</strong> ${nuevaPassword}</p>
          <p>Por tu seguridad, inicia sesión y cámbiala inmediatamente desde tu perfil.</p>
          <hr/>
          <p>Si no solicitaste este cambio, por favor contacta al administrador.</p>
        `;

        await transporter.sendMail({
          from: smtpUser,
          to: user.correo,
          subject: asunto,
          html
        });

        // Solo si el correo fue enviado, actualizamos la contraseña (hasheada)
        const hashedNew = await bcrypt.hash(nuevaPassword, SALT_ROUNDS);
        await pool.query(
          'UPDATE usuarios SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?',
          [hashedNew, user.id]
        );

        return res.json({ ok: true, message: 'Contraseña generada y enviada al correo.' });
      } catch (mailError) {
        console.warn('Error al enviar correo de auto-restablecimiento:', mailError.message);
        return res.status(500).json({ ok: false, message: 'No se pudo enviar el correo con la nueva contraseña.', error: mailError.message });
      }
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error en recuperación', error: error.message });
    }
  });

  // Restablecer contraseña con token
  app.post('/api/auth/restablecer', async (req, res) => {
    try {
      const { token, nueva_password } = req.body;
      if (!token || !nueva_password) {
        return res.status(400).json({ ok: false, message: 'Token y nueva contraseña son requeridos' });
      }

      const [rows] = await pool.query(
        'SELECT id FROM usuarios WHERE reset_token = ? AND reset_expires > NOW() LIMIT 1',
        [token]
      );

      if (rows.length === 0) {
        return res.status(400).json({ ok: false, message: 'Token inválido o expirado' });
      }

      const userId = rows[0].id;
      const hashedNew = await bcrypt.hash(nueva_password, SALT_ROUNDS);
      await pool.query(
        'UPDATE usuarios SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?',
        [hashedNew, userId]
      );

      res.json({ ok: true, message: 'Contraseña restablecida exitosamente' });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al restablecer contraseña', error: error.message });
    }
  });

  // Administrador: migrar contraseñas en texto plano a bcrypt
  app.post('/api/admin/hash-passwords', authMiddleware, async (req, res) => {
    try {
      if (!req.user || req.user.rol !== 'Administrador') {
        return res.status(403).json({ ok: false, message: 'No autorizado' });
      }
      const [users] = await pool.query('SELECT id, password FROM usuarios');
      let updated = 0;
      for (const u of users) {
        const pwd = u.password || '';
        if (!(pwd.startsWith('$2a$') || pwd.startsWith('$2b$') || pwd.startsWith('$2y$'))) {
          const hashed = await bcrypt.hash(pwd, SALT_ROUNDS);
          await pool.query('UPDATE usuarios SET password = ? WHERE id = ?', [hashed, u.id]);
          updated++;
        }
      }
      res.json({ ok: true, message: 'Contraseñas migradas', updated });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al migrar contraseñas', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA GESTIÓN DE ROLES =====

  // Listar todos los roles
  app.get('/api/roles', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM roles ORDER BY nombre');
      res.json(rows);
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener roles', 
        error: error.message 
      });
    }
  });

  // Crear rol
  app.post('/api/roles', authMiddleware, async (req, res) => {
    try {
      const { nombre, descripcion } = req.body;
      
      if (!nombre) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El nombre del rol es requerido' 
        });
      }

      // Verificar si el rol ya existe
      const [existingRole] = await pool.query(
        'SELECT id FROM roles WHERE nombre = ?', 
        [nombre]
      );

      if (existingRole.length > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El rol ya existe' 
        });
      }

      const [result] = await pool.query(
        'INSERT INTO roles (nombre, descripcion) VALUES (?, ?)',
        [nombre, descripcion]
      );

      res.json({ 
        ok: true, 
        id: result.insertId,
        message: 'Rol creado exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al crear rol', 
        error: error.message 
      });
    }
  });

  // Actualizar rol
  app.put('/api/roles/:id', authMiddleware, async (req, res) => {
    try {
      const { nombre, descripcion } = req.body;
      
      if (!nombre) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El nombre del rol es requerido' 
        });
      }

      // Verificar si el rol existe
      const [existingRole] = await pool.query(
        'SELECT id FROM roles WHERE id = ?', 
        [req.params.id]
      );

      if (existingRole.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          message: 'Rol no encontrado' 
        });
      }

      // Verificar si el nombre ya existe (excluyendo el rol actual)
      const [duplicateRole] = await pool.query(
        'SELECT id FROM roles WHERE nombre = ? AND id != ?', 
        [nombre, req.params.id]
      );

      if (duplicateRole.length > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'El nombre del rol ya existe' 
        });
      }

      await pool.query(
        'UPDATE roles SET nombre = ?, descripcion = ? WHERE id = ?',
        [nombre, descripcion, req.params.id]
      );

      res.json({ 
        ok: true,
        message: 'Rol actualizado exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al actualizar rol', 
        error: error.message 
      });
    }
  });

  // Eliminar rol
  app.delete('/api/roles/:id', authMiddleware, async (req, res) => {
    try {
      // Verificar si el rol existe
      const [existingRole] = await pool.query(
        'SELECT id FROM roles WHERE id = ?', 
        [req.params.id]
      );

      if (existingRole.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          message: 'Rol no encontrado' 
        });
      }

      // Verificar si hay usuarios con este rol
      const [usersWithRole] = await pool.query(
        'SELECT COUNT(*) as count FROM usuarios WHERE rol_id = ?', 
        [req.params.id]
      );

      if (usersWithRole[0].count > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'No se puede eliminar el rol porque hay usuarios asignados a él' 
        });
      }

      await pool.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
      
      res.json({ 
        ok: true,
        message: 'Rol eliminado exitosamente'
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al eliminar rol', 
        error: error.message 
      });
    }
  });

  // ===== ENDPOINTS PARA DASHBOARD =====

  // Obtener cantidad de estudiantes inscritos
  app.get('/api/dashboard/estudiantes-count', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(DISTINCT e.id) as count
        FROM estudiantes e
        INNER JOIN inscripciones i ON e.id = i.estudiante_id
        WHERE i.estado = 'activo'
      `);
      
      res.json({
        ok: true,
        count: rows[0].count
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener cantidad de estudiantes', 
        error: error.message 
      });
    }
  });

  // Obtener cantidad de compromisos registrados
  app.get('/api/dashboard/compromisos-count', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(*) as count
        FROM compromiso_economico
        WHERE estado_compromiso = 'activo'
      `);
      
      res.json({
        ok: true,
        count: rows[0].count
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener cantidad de compromisos', 
        error: error.message 
      });
    }
  });

  // Obtener cantidad de usuarios
  app.get('/api/dashboard/usuarios-count', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(*) as count
        FROM usuarios
      `);
      
      res.json({
        ok: true,
        count: rows[0].count
      });
    } catch (error) {
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener cantidad de usuarios', 
        error: error.message 
      });
    }
  });

  // Obtener cantidad de estudiantes registrados sin inscripción activa
  app.get('/api/dashboard/estudiantes-sin-inscripcion-count', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(*) AS count
        FROM estudiantes e
        WHERE e.estado_id = 1
          AND NOT EXISTS (
            SELECT 1
            FROM inscripciones i
            WHERE i.estudiante_id = e.id
              AND i.estado = 'activo'
          )
      `);

      res.json({
        ok: true,
        count: rows[0]?.count || 0
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiantes sin inscripción activa',
        error: error.message
      });
    }
  });

  // Obtener cantidad de estudiantes con turno mañana (inscripción activa)
  app.get('/api/dashboard/estudiantes-turno-manana-count', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(DISTINCT e.id) AS count
        FROM inscripciones i
        INNER JOIN estudiantes e ON e.id = i.estudiante_id
        LEFT JOIN curso c ON c.id = i.curso_id
        WHERE e.estado_id = 1
          AND i.estado = 'activo'
          AND LOWER(REPLACE(COALESCE(NULLIF(TRIM(c.turno), ''), TRIM(i.turno), ''), 'ñ', 'n')) = 'manana'
      `);

      res.json({
        ok: true,
        count: rows[0]?.count || 0
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiantes de turno mañana',
        error: error.message
      });
    }
  });

  // Obtener cantidad de estudiantes con turno tarde (inscripción activa)
  app.get('/api/dashboard/estudiantes-turno-tarde-count', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(DISTINCT e.id) AS count
        FROM inscripciones i
        INNER JOIN estudiantes e ON e.id = i.estudiante_id
        LEFT JOIN curso c ON c.id = i.curso_id
        WHERE e.estado_id = 1
          AND i.estado = 'activo'
          AND LOWER(TRIM(COALESCE(NULLIF(c.turno, ''), i.turno, ''))) = 'tarde'
      `);

      res.json({
        ok: true,
        count: rows[0]?.count || 0
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: 'Error al obtener estudiantes de turno tarde',
        error: error.message
      });
    }
  });

  // Obtener pagos pendientes para el dashboard
  app.get('/api/dashboard/pagos-pendientes', authMiddleware, async (req, res) => {
    try {
      const { 
        anio = 2025, 
        mes = new Date().getMonth() + 1, // Mes actual por defecto
        todos_los_meses = false // Parámetro para mostrar todos los meses
      } = req.query;
      
      let query = `
        SELECT 
          pm.id,
          pm.mes,
          pm.anio,
          pm.nombre_mes,
          pm.monto_esperado,
          pm.monto_pagado,
          pm.monto_pendiente as saldo_pendiente,
          pm.fecha_vencimiento,
          pm.estado,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          ce.id as compromiso_id,
          n.nombre as nivel_nombre,
          c.nombre as curso_nombre,
          b.descripcion as bloque_nombre
        FROM pagos_mensuales pm
        JOIN compromiso_economico ce ON pm.id_compromiso = ce.id
        JOIN estudiantes e ON ce.id_estudiante = e.id
        LEFT JOIN inscripciones i ON ce.inscripcion_id = i.id
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        LEFT JOIN bloque b ON i.bloque_id = b.id
        WHERE pm.estado = 'pendiente' 
          AND pm.monto_pendiente > 0
          AND pm.anio = ?
      `;
      
      const params = [parseInt(anio)];
      
      // Si no se quieren todos los meses, filtrar por mes específico
      if (todos_los_meses !== 'true') {
        query += ' AND pm.mes = ?';
        params.push(parseInt(mes));
      }
      
      query += ' ORDER BY pm.fecha_vencimiento ASC, e.nombre ASC';
      
      const [rows] = await pool.execute(query, params);
      
      res.json({
        ok: true,
        pagos: rows,
        filtros: {
          anio: parseInt(anio),
          mes: todos_los_meses === 'true' ? null : parseInt(mes),
          todos_los_meses: todos_los_meses === 'true'
        }
      });
    } catch (error) {
      console.error('Error al obtener pagos pendientes:', error);
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener pagos pendientes', 
        error: error.message 
      });
    }
  });

  // ===== ENDPOINT ADMIN: LIMPIAR DATOS (EXCEPTO USUARIOS, ROLES Y ESTADOS_ESTUDIANTE) =====
  app.post('/api/admin/limpiar-datos', authMiddleware, async (req, res) => {
    try {
      // Solo Administrador puede ejecutar esta acción
      if (!req.user || req.user.rol !== 'Administrador') {
        return res.status(403).json({ ok: false, message: 'Acceso denegado' });
      }

      // Listado de tablas a limpiar según base actual
      // IMPORTANTE: NO incluir 'roles', 'usuarios', 'estados_estudiante', 'bloque', 'nivel', 'curso', 'becas' (se preservan).
      // Orden: primero tablas dependientes (con foreign keys), luego independientes
      const tablesToTruncate = [
        // Cache y documentos del agente inteligente
        'embeddings_chunks',       // Depende de chunks_documentos
        'chunks_documentos',       // Depende de documentos_agente
        'mensajes_conversacion',   // Depende de sesiones_conversacion
        'sesiones_conversacion',
        'documentos_agente',
        // Datos operativos y registros auxiliares
        'consultas_comprobantes',
        'ocr_comprobantes',
        'pagos_realizados',
        'pagos_mensuales',
        'servicios_estudiante',
        'ingresos',
        'inscripciones',
        'compromiso_economico',
        'estudiantes',
        'servicios',
        'contacto_aviso',
      ];

      // Desactivar llaves foráneas, truncar y reactivar
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      
      // Truncar cada tabla (TRUNCATE resetea auto-increment a 0)
      for (const tableName of tablesToTruncate) {
        try {
          await pool.query(`TRUNCATE TABLE \`${tableName}\``);
          console.log(`✅ Tabla ${tableName} limpiada`);
        } catch (error) {
          // Si la tabla no existe, continuar con las demás
          if (error.code === 'ER_NO_SUCH_TABLE') {
            console.log(`⚠️  Tabla ${tableName} no existe, omitiendo...`);
          } else {
            throw error; // Re-lanzar otros errores
          }
        }
      }
      
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');

      // Asegurar estados básicos del estudiante (por si una limpieza anterior los eliminó)
      const [estadoCountRows] = await pool.query('SELECT COUNT(*) AS c FROM estados_estudiante');
      const estadoCount = estadoCountRows?.[0]?.c || 0;
      if (estadoCount === 0) {
        await pool.query('SET FOREIGN_KEY_CHECKS = 0');
        await pool.query(`INSERT INTO estados_estudiante (id, nombre, descripcion) VALUES
          (1,'Activo','Estudiante activo en el sistema'),
          (2,'Inactivo','Estudiante inactivo'),
          (3,'Egresado','Estudiante que ha egresado'),
          (4,'Retirado','Estudiante retirado del sistema')`);
        await pool.query('SET FOREIGN_KEY_CHECKS = 1');
      }

      res.json({
        ok: true,
        message: 'Datos eliminados. Bloques, niveles, cursos y becas SE PRESERVARON. Los auto-increment fueron reseteados a 0.',
        tablas_limpiadas: tablesToTruncate,
        preservado: ['usuarios', 'roles', 'estados_estudiante', 'bloque', 'nivel', 'curso', 'becas'],
        agente_inteligente_limpiado: ['documentos_agente', 'chunks_documentos', 'embeddings_chunks', 'sesiones_conversacion', 'mensajes_conversacion']
      });
    } catch (error) {
      try { await pool.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (_) {}
      res.status(500).json({ ok: false, message: 'Error al limpiar datos', error: error.message });
    }
  });

  // ===== ENDPOINT ADMIN: LIMPIAR SOLO SERVICIOS ADQUIRIDOS E INGRESOS ASOCIADOS =====
  app.post('/api/admin/limpiar-servicios', authMiddleware, async (req, res) => {
    try {
      // Solo Administrador
      if (!req.user || req.user.rol !== 'Administrador') {
        return res.status(403).json({ ok: false, message: 'Acceso denegado' });
      }

      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      // Borrar ingresos de servicios primero para no dejar huérfanos
      await pool.query("DELETE FROM ingresos WHERE tipo = 'servicios_estudiante'");
      // Luego limpiar servicios adquiridos
      await pool.query('TRUNCATE TABLE `servicios_estudiante`');
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');

      res.json({ ok: true, message: 'Servicios adquiridos e ingresos asociados eliminados.' });
    } catch (error) {
      try { await pool.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (_) {}
      res.status(500).json({ ok: false, message: 'Error al limpiar servicios', error: error.message });
    }
  });

}

module.exports = { configurarRutasUsuarios };