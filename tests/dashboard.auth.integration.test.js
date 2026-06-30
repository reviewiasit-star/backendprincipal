const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { configurarRutasUsuarios } = require('../microservices/academia/Usuarios');
const { authMiddleware, JWT_SECRET: JWT_SECRET_TEST } = require('../middleware/auth');

function createApp(poolMock) {
  const app = express();
  app.use(express.json());
  configurarRutasUsuarios(app, poolMock, authMiddleware);
  return app;
}

describe('Integracion seguridad dashboard: GET /api/dashboard/usuarios-count', () => {
  test('debe rechazar acceso sin token', async () => {
    const poolMock = { query: jest.fn() };
    const app = createApp(poolMock);

    const response = await request(app).get('/api/dashboard/usuarios-count');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      message: 'Token de acceso requerido',
    });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  test('debe rechazar acceso con token invalido', async () => {
    const poolMock = { query: jest.fn() };
    const app = createApp(poolMock);

    const response = await request(app)
      .get('/api/dashboard/usuarios-count')
      .set('Authorization', 'Bearer token-invalido');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      message: 'Token inválido',
    });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  test('debe rechazar acceso con token expirado', async () => {
    const poolMock = { query: jest.fn() };
    const app = createApp(poolMock);
    const tokenExpirado = jwt.sign(
      { id: 1, usuario: 'admin', rol: 'Administrador', rol_id: 1 },
      JWT_SECRET_TEST,
      { expiresIn: -1 }
    );

    const response = await request(app)
      .get('/api/dashboard/usuarios-count')
      .set('Authorization', `Bearer ${tokenExpirado}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      message: 'Token expirado',
    });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  test('debe permitir acceso con token valido y retornar count', async () => {
    const poolMock = {
      query: jest.fn().mockResolvedValue([[{ count: 12 }]]),
    };
    const app = createApp(poolMock);
    const tokenValido = jwt.sign(
      { id: 1, usuario: 'admin', rol: 'Administrador', rol_id: 1 },
      JWT_SECRET_TEST,
      { expiresIn: '1h' }
    );

    const response = await request(app)
      .get('/api/dashboard/usuarios-count')
      .set('Authorization', `Bearer ${tokenValido}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      count: 12,
    });
    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });
});
