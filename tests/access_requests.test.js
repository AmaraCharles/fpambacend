'use strict';
// "Request access" from the public site, reviewed by System Admins.
const request = require('supertest');
const { startDb, stopDb, makeUser, login, eventually } = require('./helpers/memoryDb');

let app, admin, adminToken, supToken;
const A = t => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await startDb();
  app = require('../src/app');
  admin = await makeUser({ role: 'System Admin', division: 'All' });
  adminToken = (await login(app, admin.email)).body.token;
  const sup = await makeUser({ role: 'Supervisor', division: 'All' });
  supToken = (await login(app, sup.email)).body.token;
});
afterAll(stopDb);

const send = body => request(app).post('/api/access-requests').send(body);

describe('access requests', () => {
  it('validates, stores once per email and notifies System Admins', async () => {
    expect((await send({ name: 'Ngozi', email: 'bad', organisation: 'FMW' })).status).toBe(422);
    expect((await send({ name: 'Ngozi', email: 'ngozi@works.gov.ng' })).status).toBe(422);
    expect((await send({ name: 'Ngozi Adamu', email: 'Ngozi@Works.gov.ng', organisation: 'Federal Ministry of Works', requestedRole: 'GIS Analyst', reason: 'Mapping' })).status).toBe(201);
    expect((await send({ name: 'Ngozi Adamu', email: 'ngozi@works.gov.ng', organisation: 'FMW' })).status).toBe(201);   // duplicate: same answer, not stored
    const AccessRequest = require('../src/models/AccessRequest');
    expect(await AccessRequest.countDocuments()).toBe(1);
    const Notification = require('../src/models/Notification');
    expect(await eventually(() => Notification.findOne({ user: admin._id, type: 'ACCESS_REQUESTED' }))).toBeTruthy();
  });

  it('gives the same answer for an existing account, without storing anything', async () => {
    const AccessRequest = require('../src/models/AccessRequest');
    expect((await send({ name: 'Admin', email: admin.email, organisation: 'FPAM' })).status).toBe(201);
    expect(await AccessRequest.countDocuments()).toBe(1);
  });

  it('drops honeypot submissions', async () => {
    const AccessRequest = require('../src/models/AccessRequest');
    expect((await send({ name: 'Bot', email: 'bot@x.com', organisation: 'X', website: 'http://spam' })).status).toBe(201);
    expect(await AccessRequest.countDocuments()).toBe(1);
  });

  it('is reviewed only by System Admins; approval needs the account to exist', async () => {
    expect((await request(app).get('/api/access-requests').set(A(supToken))).status).toBe(403);
    expect((await request(app).get('/api/access-requests')).status).toBe(401);
    const list = (await request(app).get('/api/access-requests').set(A(adminToken))).body;
    expect(list.counts.pending).toBe(1);
    const r = list.requests[0];
    expect(r).toMatchObject({ email: 'ngozi@works.gov.ng', requestedRole: 'GIS Analyst', status: 'pending' });

    expect((await request(app).patch(`/api/access-requests/${r._id}`).set(A(adminToken)).send({ status: 'approved' })).status).toBe(422);
    await makeUser({ name: 'Ngozi Adamu', email: 'ngozi@works.gov.ng', role: 'GIS Analyst' });
    const ok = await request(app).patch(`/api/access-requests/${r._id}`).set(A(adminToken)).send({ status: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body.request.userId).toBeTruthy();
    expect((await request(app).patch(`/api/access-requests/${r._id}`).set(A(adminToken)).send({ status: 'declined', note: 'x' })).status).toBe(409);
  });

  it('needs a reason to decline', async () => {
    await send({ name: 'Bala', email: 'bala@example.ng', organisation: 'Unknown' });
    const r = (await request(app).get('/api/access-requests?status=pending').set(A(adminToken))).body.requests[0];
    expect((await request(app).patch(`/api/access-requests/${r._id}`).set(A(adminToken)).send({ status: 'declined' })).status).toBe(422);
    const ok = await request(app).patch(`/api/access-requests/${r._id}`).set(A(adminToken)).send({ status: 'declined', note: 'Not an MDA employee' });
    expect(ok.body.request).toMatchObject({ status: 'declined', note: 'Not an MDA employee' });
  });
});
