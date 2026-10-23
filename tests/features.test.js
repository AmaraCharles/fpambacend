'use strict';
// Notifications, data quality, system endpoints and API docs.
const request = require('supertest');
const mongoose = require('mongoose');
const { startDb, stopDb, makeUser, login, eventually } = require('./helpers/memoryDb');

let app, admin, adminToken, agent, agentToken;
beforeAll(async () => {
  await startDb();
  app = require('../src/app');
  admin = await makeUser({ role: 'System Admin', division: 'All' });
  adminToken = (await login(app, admin.email)).body.token;
  agent = await makeUser({ role: 'Field Agent', phone: '08031234567' });
  agentToken = (await login(app, agent.email)).body.token;
});
afterAll(stopDb);
const A = t => ({ Authorization: `Bearer ${t}` });

describe('notifications', () => {
  it('approvers are notified of a capture, and the capturer of the decision', async () => {
    const Notification = require('../src/models/Notification');
    const created = await request(app).post('/api/assets').set(A(agentToken))
      .send({ name: 'Notify Test Clinic', type: 'Hospital', coordinates: [3.4, 6.5], state: 'Lagos', mda: 'FMOH' });
    expect(created.status).toBe(201);
    expect(created.body.asset.approvalStatus).toBe('Pending');
    const forAdmin = await eventually(() => Notification.findOne({ user: admin._id, type: 'ASSET_SUBMITTED' }));
    expect(forAdmin).toBeTruthy();

    expect((await request(app).post(`/api/assets/${created.body.asset.assetId}/approve`).set(A(adminToken))).status).toBe(200);
    const forAgent = await eventually(() => Notification.findOne({ user: agent._id, type: 'ASSET_DECIDED' }));
    expect(forAgent.title).toBe('Capture approved');
    expect(forAgent.link).toBe(`/assets/${created.body.asset.assetId}`);

    const list = await request(app).get('/api/notifications').set(A(agentToken));
    expect(list.body.unread).toBe(1);
    await request(app).post(`/api/notifications/${forAgent._id}/read`).set(A(agentToken));
    expect((await request(app).get('/api/notifications').set(A(agentToken))).body.unread).toBe(0);
    // Users only see their own
    expect((await request(app).get('/api/notifications').set(A(agentToken))).body.notifications.every(n => String(n.user) === String(agent._id))).toBe(true);
    await request(app).delete('/api/notifications').set(A(agentToken));
    expect((await request(app).get('/api/notifications').set(A(agentToken))).body.notifications).toHaveLength(0);
  });
});

describe('data quality', () => {
  beforeAll(async () => {
    const assets = mongoose.connection.collection('assets');
    const dk = (n, s, m) => [n, s, m].map(x => x.toLowerCase()).join('|');
    await assets.insertMany([
      { assetId: 'DQ-1', name: 'Federal Secretariat', state: 'Adamawa and Taraba', mda: 'FMW', dupKey: dk('Federal Secretariat', 'Adamawa and Taraba', 'FMW') },
      { assetId: 'DQ-2', name: 'Guest House', state: 'Adamawa and Taraba', mda: 'FMW', dupKey: dk('Guest House', 'Adamawa and Taraba', 'FMW') },
      { assetId: 'DQ-3', name: 'Guest House', state: 'Taraba', mda: 'FMW', dupKey: dk('Guest House', 'Taraba', 'FMW') },
      { assetId: 'DQ-4', name: 'Lagos Annex', state: 'lagos', mda: 'Unknown Ministry X', dupKey: dk('Lagos Annex', 'lagos', 'Unknown Ministry X') },
    ]);
  });

  it('summarises issues with the bad spellings and suggestions', async () => {
    const res = await request(app).get('/api/data-quality/summary').set(A(adminToken));
    expect(res.status).toBe(200);
    const states = Object.fromEntries(res.body.badStates.map(s => [s.value, s]));
    expect(states['Adamawa and Taraba'].count).toBe(2);
    expect(states.lagos.suggestion).toBe('Lagos');
    expect(res.body.badMdas.some(m => m.value === 'Unknown Ministry X')).toBe(true);
  });

  it('field agents cannot see the summary or fix data', async () => {
    expect((await request(app).get('/api/data-quality/summary').set(A(agentToken))).status).toBe(403);
    expect((await request(app).post('/api/data-quality/fix-state').set(A(agentToken)).send({ from: 'lagos', to: 'Lagos' })).status).toBe(403);
  });

  it('renames a state spelling, skipping assets that would become duplicates', async () => {
    const res = await request(app).post('/api/data-quality/fix-state').set(A(adminToken)).send({ from: 'Adamawa and Taraba', to: 'Taraba' });
    expect(res.body).toEqual({ updated: 1, skipped: ['DQ-2'] });
    const a1 = await mongoose.connection.collection('assets').findOne({ assetId: 'DQ-1' });
    expect(a1.state).toBe('Taraba');
    expect(a1.dupKey).toBe('federal secretariat|taraba|fmw');
    expect((await request(app).post('/api/data-quality/fix-state').set(A(adminToken)).send({ from: 'lagos', to: 'Narnia' })).status).toBe(422);
  });

  it('lists assignees for managers only, without MDA Agents', async () => {
    await makeUser({ role: 'MDA Agent', mda: 'FMW', division: null });
    const res = await request(app).get('/api/data-quality/assignees').set(A(adminToken));
    expect(res.body.users.length).toBeGreaterThan(1);
    expect(res.body.users.some(u => u.role === 'MDA Agent')).toBe(false);
    expect((await request(app).get('/api/data-quality/assignees').set(A(agentToken))).status).toBe(403);
  });

  it('assigns fixes, notifies the assignee, and blocks self-verification', async () => {
    const Notification = require('../src/models/Notification');
    const res = await request(app).post('/api/data-quality/assign').set(A(adminToken)).send({ assetIds: ['DQ-4'], userId: String(agent._id), note: 'Fix the MDA' });
    expect(res.body.assigned).toBe(1);
    expect(await eventually(() => Notification.findOne({ user: agent._id, type: 'DATA_FIX_ASSIGNED' }))).toBeTruthy();
    const mine = await request(app).get('/api/data-quality/issues?mine=1').set(A(agentToken));
    expect(mine.body.assets.map(a => a.assetId)).toEqual(['DQ-4']);

    const sup = await makeUser({ role: 'Supervisor', division: 'All' });
    const supToken = (await login(app, sup.email)).body.token;
    await request(app).post('/api/data-quality/assign').set(A(adminToken)).send({ assetIds: ['DQ-1'], userId: String(sup._id) });
    expect((await request(app).post('/api/data-quality/verify').set(A(supToken)).send({ assetIds: ['DQ-1'] })).body).toEqual({ verified: 0, skipped: 1 });
    expect((await request(app).post('/api/data-quality/verify').set(A(adminToken)).send({ assetIds: ['DQ-1'] })).body.verified).toBe(1);
  });
});

describe('system', () => {
  it('public ping reports the database', async () => {
    const res = await request(app).get('/api/system/ping');
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('health is admin-only and reports integrations', async () => {
    expect((await request(app).get('/api/system/health').set(A(agentToken))).status).toBe(403);
    const res = await request(app).get('/api/system/health').set(A(adminToken));
    expect(res.body.integrations).toMatchObject({ email: false, sms: false, antivirus: false });
    expect(res.body.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stores browser errors and lists them for admins', async () => {
    expect((await request(app).post('/api/system/client-errors').send({ message: 'TypeError: x is undefined', url: '/app/assets' })).status).toBe(204);
    const res = await request(app).get('/api/system/errors?source=client').set(A(adminToken));
    expect(res.body.errors[0].message).toMatch(/TypeError/);
  });

  it('backup is a complete Extended JSON export', async () => {
    const res = await request(app).get('/api/system/backup').set(A(adminToken)).buffer(true).parse((r, cb) => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => cb(null, d)); });
    expect(res.status).toBe(200);
    const { BSON } = require('mongodb');
    const data = BSON.EJSON.parse(res.body, { relaxed: false });
    expect(data.collections.assets.length).toBeGreaterThan(3);
    expect(data.collections.users.some(u => u.email === admin.email)).toBe(true);
    expect(data.collections.assets[0]._id).toBeInstanceOf(require('mongodb').ObjectId);
    expect((await request(app).get('/api/system/backup').set(A(agentToken))).status).toBe(403);
  });

  it('serves enums and the API docs', async () => {
    const e = await request(app).get('/api/system/enums').set(A(agentToken));
    expect(e.body.states).toContain('Taraba');
    expect(e.body.conditions).toEqual(['Good', 'Fair', 'Poor', 'Critical']);
    const spec = await request(app).get('/api/docs/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(50);
    const page = await request(app).get('/api/docs');
    expect(page.text).toMatch(/swagger-ui/);
    expect(page.headers['content-security-policy']).toMatch(/cdnjs/);
  });
});
