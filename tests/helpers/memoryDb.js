'use strict';
// A throwaway MongoDB per test file (mongodb-memory-server) plus helpers to
// create users and sign in through the real /api/auth/login route.
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

let server;

async function startDb() {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'fpamas_test' });
  // Build unique indexes (e.g. dupKey) before tests rely on them.
  await Promise.all(Object.values(mongoose.models).map(m => m.syncIndexes().catch(() => {})));
}

async function stopDb() {
  await mongoose.disconnect();
  if (server) await server.stop();
}

async function makeUser(fields = {}) {
  const User = require('../../src/models/User');
  const n = Math.random().toString(36).slice(2, 8);
  return User.create({ name: `User ${n}`, email: `u${n}@example.com`, role: 'Field Agent', password: 'Password123', division: 'Assets & Condition', ...fields });
}

async function login(app, email, password = 'Password123') {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res;
}

/** Poll until fn() returns truthy (fire-and-forget side effects like notifications). */
async function eventually(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, 50));
  }
}

module.exports = { startDb, stopDb, makeUser, login, eventually };
