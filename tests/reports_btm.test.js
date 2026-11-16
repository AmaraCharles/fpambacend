'use strict';
// Public QR-scan reports and the Building Training & Maintenance module.
const request = require('supertest');
const mongoose = require('mongoose');
const { startDb, stopDb, makeUser, login, eventually } = require('./helpers/memoryDb');

let app, adminToken, mdaToken, otherMdaToken, btmToken, agentToken, mdaAgent;
const A = t => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await startDb();
  app = require('../src/app');
  await mongoose.connection.collection('assets').insertMany([
    { assetId: 'AST-9001', name: 'Federal Secretariat Lafia', type: 'Office', state: 'Nasarawa', lga: 'Lafia', mda: 'FMHUD', approvalStatus: 'Approved', capturedBy: new mongoose.Types.ObjectId(), maintenanceLogs: [] },
    { assetId: 'AST-9002', name: 'Guest House', type: 'Residential', state: 'Kano', mda: 'FMW', approvalStatus: 'Approved', maintenanceLogs: [] },
  ]);
  const admin = await makeUser({ role: 'System Admin', division: 'All' });
  adminToken = (await login(app, admin.email)).body.token;
  mdaAgent = await makeUser({ role: 'MDA Agent', division: null, mda: 'FMHUD' });
  mdaToken = (await login(app, mdaAgent.email)).body.token;
  const other = await makeUser({ role: 'MDA Agent', division: null, mda: 'FMW' });
  otherMdaToken = (await login(app, other.email)).body.token;
  const btm = await makeUser({ role: 'Field Agent', division: 'Building Training & Maintenance' });
  btmToken = (await login(app, btm.email)).body.token;
  const agent = await makeUser({ role: 'Field Agent', division: 'Assets & Condition' });
  agentToken = (await login(app, agent.email)).body.token;
});
afterAll(stopDb);

describe('public QR-scan reports', () => {
  let reportId;

  it('shows only public fields for a scanned asset, without sign-in', async () => {
    const res = await request(app).get('/api/public/assets/AST-9001');
    expect(res.status).toBe(200);
    expect(res.body.asset).toEqual({ assetId: 'AST-9001', assetCode: null, name: 'Federal Secretariat Lafia', type: 'Office', mda: 'FMHUD', state: 'Nasarawa', lga: 'Lafia' });
    expect(res.body.asset.capturedBy).toBeUndefined();
    expect((await request(app).get('/api/public/assets/NOPE-1')).status).toBe(404);
  });

  it('validates and stores a report, and notifies the MDA', async () => {
    expect((await request(app).post('/api/public/assets/AST-9001/reports').send({ category: 'Bogus', description: 'Something long enough' })).status).toBe(422);
    expect((await request(app).post('/api/public/assets/AST-9001/reports').send({ category: 'Safety hazard', description: 'short' })).status).toBe(422);
    const res = await request(app).post('/api/public/assets/AST-9001/reports')
      .send({ category: 'Safety hazard', severity: 'High', description: 'Exposed wiring by the main stairwell', name: 'Ada', lat: 8.49, lng: 8.52 });
    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^RPT-\d{8}-[0-9A-F]{6}$/);
    const Notification = require('../src/models/Notification');
    const n = await eventually(() => Notification.findOne({ user: mdaAgent._id, type: 'PUBLIC_REPORT' }));
    expect(n.link).toBe('/portal?tab=reports');
  });

  it('drops honeypot submissions without storing them', async () => {
    const PublicReport = require('../src/models/PublicReport');
    const before = await PublicReport.countDocuments();
    const res = await request(app).post('/api/public/assets/AST-9001/reports').send({ category: 'Other', description: 'spam spam spam', website: 'x' });
    expect(res.status).toBe(201);
    expect(await PublicReport.countDocuments()).toBe(before);
  });

  it('scopes the queue to the MDA and lets only allowed users change status', async () => {
    const mine = await request(app).get('/api/reports').set(A(mdaToken));
    expect(mine.body.reports).toHaveLength(1);
    reportId = mine.body.reports[0]._id;
    expect((await request(app).get('/api/reports').set(A(otherMdaToken))).body.reports).toHaveLength(0);
    expect((await request(app).patch(`/api/reports/${reportId}`).set(A(otherMdaToken)).send({ status: 'Acknowledged' })).status).toBe(404);
    expect((await request(app).patch(`/api/reports/${reportId}`).set(A(agentToken)).send({ status: 'Acknowledged' })).status).toBe(403);
    expect((await request(app).patch(`/api/reports/${reportId}`).set(A(mdaToken)).send({ status: 'Resolved' })).status).toBe(422);   // needs a note
    const ok = await request(app).patch(`/api/reports/${reportId}`).set(A(mdaToken)).send({ status: 'Acknowledged', note: 'Electrician booked' });
    expect(ok.status).toBe(200);
    expect(ok.body.report.history.map(h => h.status)).toEqual(['New', 'Acknowledged']);
  });

  it('raises a work order from a report and resolves it on completion', async () => {
    const wo = await request(app).post('/api/btm/work-orders').set(A(btmToken)).send({ reportId, priority: 'Urgent', assignedTo: 'Musa (electrician)' });
    expect(wo.status).toBe(201);
    expect(wo.body.workOrder.assetId).toBe('AST-9001');
    expect((await request(app).post('/api/btm/work-orders').set(A(btmToken)).send({ reportId })).status).toBe(409);
    const done = await request(app).patch(`/api/btm/work-orders/${wo.body.workOrder._id}`).set(A(btmToken))
      .send({ status: 'Completed', completionNote: 'Wiring replaced and trunked', cost: 45000 });
    expect(done.status).toBe(200);
    const report = (await request(app).get('/api/reports').set(A(mdaToken))).body.reports[0];
    expect(report.status).toBe('Resolved');
    const asset = await mongoose.connection.collection('assets').findOne({ assetId: 'AST-9001' });
    expect(asset.maintenanceLogs.at(-1).desc).toContain('Wiring replaced');
    expect(asset.maintenanceLogs.at(-1).cost).toBe(45000);
  });
});

describe('Building Training & Maintenance', () => {
  it('lets staff view but only the division change things', async () => {
    expect((await request(app).get('/api/btm/summary').set(A(agentToken))).status).toBe(200);
    expect((await request(app).get('/api/btm/summary').set(A(mdaToken))).status).toBe(403);
    expect((await request(app).post('/api/btm/plans').set(A(agentToken)).send({ assetId: 'AST-9002', task: 'x', frequency: 'Monthly', nextDue: '2026-12-01' })).status).toBe(403);
  });

  it('completing a planned task moves the plan on', async () => {
    const plan = await request(app).post('/api/btm/plans').set(A(btmToken))
      .send({ assetId: 'AST-9002', task: 'Service standby generator', category: 'Generator & power', frequency: 'Quarterly', nextDue: '2026-11-01' });
    expect(plan.status).toBe(201);
    const s1 = (await request(app).get('/api/btm/summary').set(A(btmToken))).body;
    expect(s1.plans.overdue).toBeGreaterThanOrEqual(1);
    const wo = await request(app).post(`/api/btm/plans/${plan.body.plan._id}/work-order`).set(A(btmToken));
    expect(wo.status).toBe(201);
    expect((await request(app).post(`/api/btm/plans/${plan.body.plan._id}/work-order`).set(A(btmToken))).status).toBe(409);
    expect((await request(app).patch(`/api/btm/work-orders/${wo.body.workOrder._id}`).set(A(btmToken)).send({ status: 'Completed' })).status).toBe(422);
    await request(app).patch(`/api/btm/work-orders/${wo.body.workOrder._id}`).set(A(btmToken)).send({ status: 'Completed', completionNote: 'Oil and filters changed', completedAt: '2026-11-10' });
    const updated = (await request(app).get('/api/btm/plans').set(A(btmToken))).body.plans.find(p => p._id === plan.body.plan._id);
    expect(updated.lastDone.slice(0, 10)).toBe('2026-11-10');
    expect(updated.nextDue.slice(0, 10)).toBe('2027-02-09');   // + 91 days
  });

  it('records training sessions with attendees', async () => {
    const res = await request(app).post('/api/btm/training').set(A(btmToken)).send({
      title: 'Fire safety and extinguisher use', date: '2026-11-12', venue: 'Conference Hall', assetId: 'AST-9001',
      attendees: [{ name: 'A. Bello', organisation: 'FMHUD' }, { name: '' }, { name: 'C. Eze' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.session.attendees).toHaveLength(2);
    expect(res.body.session.assetName).toBe('Federal Secretariat Lafia');
    const s = (await request(app).get('/api/btm/summary').set(A(btmToken))).body;
    expect(s.training.attendeesThisYear).toBe(2);
  });
});
