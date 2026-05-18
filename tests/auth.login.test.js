const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { configurarRutasUsuarios } = require('../microservices/academia/Usuarios');
const { authMiddleware } = require('../middleware/auth');
const JWT_SECRET_TEST = process.env.JWT_SECRET || 'tu_clave_secreta_super_segura_2024';

function createTestApp(poolMock, middleware = authMiddleware) {
  const app = express();
  app.use(express.json());

  configurarRutasUsuarios(app, poolMock, middleware);

  return app;
}

describe('POST /api/auth/login', () => {
  test('debe rechazar cuando faltan usuario o password', async () => {
    const poolMock = { query: jest.fn() };
    const app = createTestApp(poolMock);

    const response = await request(app).post('/api/auth/login').send({ usuario: 'admin' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      message: 'Usuario y contraseña son requeridos',
    });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  test('debe rechazar credenciales invalidas', async () => {
    const poolMock = {
      query: jest.fn().mockResolvedValue([[]]),
    };
    const app = createTestApp(poolMock);

    const response = await request(app).post('/api/auth/login').send({
      usuario: 'usuario_inexistente',
      password: '123456',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      message: 'Credenciales incorrectas',
    });
    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });

  test('debe permitir login con credenciales validas y retornar token', async () => {
    const passwordPlano = '123456';
    const passwordHash = await bcrypt.hash(passwordPlano, 10);
    const usuarioDB = {
      id: 1,
      usuario: 'admin',
      password: passwordHash,
      nombre: 'Administrador General',
      correo: 'admin@demo.com',
      rol_id: 1,
      rol: 'Administrador',
    };

    const poolMock = {
      query: jest.fn().mockResolvedValue([[usuarioDB]]),
    };
    const app = createTestApp(poolMock);

    const response = await request(app).post('/api/auth/login').send({
      usuario: 'admin',
      password: passwordPlano,
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.token).toBe('string');
    expect(response.body.user).toMatchObject({
      id: 1,
      usuario: 'admin',
      nombre: 'Administrador General',
      rol: 'Administrador',
      rol_id: 1,
    });
    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/auth/verify', () => {
  test('debe rechazar cuando no se envia token', async () => {
    const poolMock = { query: jest.fn() };
    const app = createTestApp(poolMock);

    const response = await request(app).get('/api/auth/verify');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      message: 'Token de acceso requerido',
    });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  test('debe rechazar cuando el token es invalido', async () => {
    const poolMock = { query: jest.fn() };
    const app = createTestApp(poolMock);

    const response = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', 'Bearer token-invalido');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      message: 'Token inválido',
    });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  test('debe validar token correcto y retornar datos del usuario', async () => {
    const tokenValido = jwt.sign(
      { id: 1, usuario: 'admin', rol: 'Administrador', rol_id: 1 },
      JWT_SECRET_TEST,
      { expiresIn: '1h' }
    );
    const usuarioDB = {
      id: 1,
      usuario: 'admin',
      nombre: 'Administrador General',
      correo: 'admin@demo.com',
      rol: 'Administrador',
      rol_id: 1,
    };
    const poolMock = {
      query: jest.fn().mockResolvedValue([[usuarioDB]]),
    };
    const app = createTestApp(poolMock);

    const response = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', `Bearer ${tokenValido}`);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.user).toMatchObject({
      id: 1,
      usuario: 'admin',
      nombre: 'Administrador General',
      rol: 'Administrador',
      rol_id: 1,
    });
    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });
});

describe('Integracion admin: login + endpoint protegido de negocio', () => {
  test('debe autenticar admin y permitir consultar usuarios-count con token valido', async () => {
    const credencialesAdmin = { usuario: 'admin', password: '4321' };
    const passwordHash = await bcrypt.hash(credencialesAdmin.password, 10);
    const usuarioAdmin = {
      id: 1,
      usuario: 'admin',
      password: passwordHash,
      nombre: 'Administrador Principal',
      correo: 'admin@demo.com',
      rol_id: 1,
      rol: 'Administrador',
    };

    const poolMock = {
      query: jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WHERE u.usuario = ?')) {
          return Promise.resolve([[usuarioAdmin]]);
        }
        if (typeof sql === 'string' && sql.includes('FROM usuarios')) {
          return Promise.resolve([[{ count: 12 }]]);
        }
        return Promise.resolve([[]]);
      }),
    };

    const app = createTestApp(poolMock);

    const loginResponse = await request(app).post('/api/auth/login').send(credencialesAdmin);

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.ok).toBe(true);
    expect(typeof loginResponse.body.token).toBe('string');
    expect(loginResponse.body.user.rol).toBe('Administrador');

    const dashboardResponse = await request(app)
      .get('/api/dashboard/usuarios-count')
      .set('Authorization', `Bearer ${loginResponse.body.token}`);

    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.body).toEqual({
      ok: true,
      count: 12,
    });
    expect(poolMock.query).toHaveBeenCalledTimes(2);
  });
});
