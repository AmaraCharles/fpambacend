'use strict';
const request = require('supertest');

const { startDb, stopDb } = require('./helpers/memoryDb');

// Smoke tests against an in-memory MongoDB (see tests/helpers/memoryDb.js).
let app;

beforeAll(async () => {
  await startDb();
  app = require('../src/app');
});
afterAll(stopDb);

describe('Health check', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Auth — login', () => {
  it('returns 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns 422 for missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(422);
  });
});

describe('Assets — unauthenticated', () => {
  it('GET /api/assets returns 401 without token', async () => {
    const res = await request(app).get('/api/assets');
    expect(res.status).toBe(401);
  });
});

describe('Auth — password self-service (input checks)', () => {
  it('forgot-password answers generically without an email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/);
  });

  it('reset-password needs a token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ password: 'longenough' });
    expect(res.status).toBe(400);
  });

  it('reset-password rejects short passwords', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'abc', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('change-password requires sign-in', async () => {
    const res = await request(app).post('/api/auth/change-password').send({});
    expect(res.status).toBe(401);
  });
});
