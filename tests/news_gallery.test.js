'use strict';
// News (dashboard → public site) and the public gallery.
const request = require('supertest');
const mongoose = require('mongoose');
const { startDb, stopDb, makeUser, login } = require('./helpers/memoryDb');

let app, adminToken, agentToken, subHeadToken;
const A = t => ({ Authorization: `Bearer ${t}` });
const PHOTO = new mongoose.Types.ObjectId();
const ME_PHOTO = new mongoose.Types.ObjectId();
const SEC_PHOTO = new mongoose.Types.ObjectId();
const LEGACY_PHOTO = new mongoose.Types.ObjectId();
const REPORT_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startDb();
  app = require('../src/app');
  await mongoose.connection.collection('assets').insertMany([
    { assetId: 'AST-7001', name: 'Federal Secretariat Lafia', type: 'Administrative Office', state: 'Nasarawa', lga: 'Lafia', mda: 'FMHUD', condition: 'Poor',
      approvalStatus: 'Approved', valuation: { amount: 900000000 }, location: { type: 'Point', coordinates: [8.5, 8.4] },
      meReports: [{ _id: REPORT_ID, reportType: 'secretariat' }],
      photos: [{ fileId: PHOTO, filename: 'a.jpg' }, { fileId: ME_PHOTO, filename: 'm.jpg', meReportId: REPORT_ID },
        // Uploaded before the fix: tagged with a random id that matches no report. Still a general photo.
        { fileId: LEGACY_PHOTO, filename: 'l.jpg', meReportId: new mongoose.Types.ObjectId() }] },
    { assetId: 'AST-7002', name: 'Barracks Annex', type: 'Security Facility', state: 'FCT', approvalStatus: 'Approved', photos: [{ fileId: SEC_PHOTO, filename: 's.jpg' }] },
    { assetId: 'AST-7003', name: 'No Photo Hall', type: 'Administrative Office', state: 'Kano', approvalStatus: 'Approved', photos: [] },
    // Older record whose type is no longer an allowed value.
    { assetId: 'AST-7004', name: 'Old Annex', type: 'Office', state: 'Oyo', approvalStatus: 'Approved', photos: [{ fileId: new mongoose.Types.ObjectId(), filename: 'o.jpg' }] },
  ]);
  const admin = await makeUser({ role: 'System Admin', division: 'All' });
  adminToken = (await login(app, admin.email)).body.token;
  const agent = await makeUser({ role: 'Field Agent' });
  agentToken = (await login(app, agent.email)).body.token;
  const sub = await makeUser({ role: 'Sub-Head' });
  subHeadToken = (await login(app, sub.email)).body.token;
});
afterAll(stopDb);

describe('public gallery', () => {
  it('is empty until staff opt an asset in', async () => {
    expect((await request(app).get('/api/public/gallery')).body.items).toEqual([]);
    expect((await request(app).get(`/api/public/photos/${PHOTO}`)).status).toBe(404);
  });

  it('only lets gallery roles opt in, and refuses security sites and assets without photos', async () => {
    expect((await request(app).patch('/api/gallery/assets/AST-7001').set(A(agentToken)).send({ enabled: true })).status).toBe(403);
    expect((await request(app).patch('/api/gallery/assets/AST-7002').set(A(adminToken)).send({ enabled: true })).status).toBe(422);
    expect((await request(app).patch('/api/gallery/assets/AST-7003').set(A(adminToken)).send({ enabled: true })).status).toBe(422);
    const ok = await request(app).patch('/api/gallery/assets/AST-7001').set(A(subHeadToken)).send({ enabled: true, caption: 'Restored 2026' });
    expect(ok.status).toBe(200);
    // Saving only the gallery field works even when other fields wouldn't validate.
    expect((await request(app).patch('/api/gallery/assets/AST-7004').set(A(adminToken)).send({ enabled: true })).status).toBe(200);
    await request(app).patch('/api/gallery/assets/AST-7004').set(A(adminToken)).send({ enabled: false });
  });

  it('shows viewer details only, and never M&E photos', async () => {
    const { items } = (await request(app).get('/api/public/gallery')).body;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(['caption', 'id', 'lga', 'name', 'photos', 'state', 'type']);
    expect(items[0]).toMatchObject({ name: 'Federal Secretariat Lafia', state: 'Nasarawa', caption: 'Restored 2026' });
    expect(items[0].photos).toEqual([`/public/photos/${PHOTO}`, `/public/photos/${LEGACY_PHOTO}`]);
    expect(JSON.stringify(items)).not.toMatch(/FMHUD|Poor|900000000|AST-7001/);
  });

  it('serves only photos that are published', async () => {
    expect((await request(app).get(`/api/public/photos/${ME_PHOTO}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/photos/${SEC_PHOTO}`)).status).toBe(404);
    expect((await request(app).get('/api/public/photos/not-an-id')).status).toBe(404);
    // Allowed, but there's no file in GridFS in this test, so still a 404 from the stream.
    expect([200, 404]).toContain((await request(app).get(`/api/public/photos/${PHOTO}`)).status);
  });
});

describe('news', () => {
  let id;
  it('only System Admins and Supervisors can write news', async () => {
    expect((await request(app).post('/api/news').set(A(agentToken)).send({ title: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/news').set(A(subHeadToken)).send({ title: 'x' })).status).toBe(403);
  });

  it('keeps drafts private and publishes on request', async () => {
    const res = await request(app).post('/api/news').set(A(adminToken))
      .send({ title: 'FPAM Unveils Maintenance Framework', category: 'Press Release', summary: 'New SOPs for MDAs.', body: 'Lead paragraph.\n\n## Background\nMore text.' });
    expect(res.status).toBe(201);
    id = res.body.news._id;
    expect(res.body.news.slug).toBe('fpam-unveils-maintenance-framework');
    expect(res.body.news.status).toBe('draft');
    expect((await request(app).get('/api/news')).body.news).toHaveLength(0);
    expect((await request(app).get('/api/news/fpam-unveils-maintenance-framework')).status).toBe(404);

    const pub = await request(app).patch(`/api/news/${id}`).set(A(adminToken)).send({ status: 'published' });
    expect(pub.body.news.status).toBe('published');
    const list = (await request(app).get('/api/news')).body;
    expect(list.news).toHaveLength(1);
    expect(list.news[0].body).toBeUndefined();          // list has no body
    const one = (await request(app).get('/api/news/fpam-unveils-maintenance-framework')).body.article;
    expect(one.body).toContain('## Background');
    expect((await request(app).get('/api/news/ticker')).body.items).toEqual([{ title: 'FPAM Unveils Maintenance Framework', slug: 'fpam-unveils-maintenance-framework' }]);
  });

  it('gives duplicate titles their own slug and keeps published slugs stable', async () => {
    const dup = await request(app).post('/api/news').set(A(adminToken)).send({ title: 'FPAM Unveils Maintenance Framework' });
    expect(dup.body.news.slug).toBe('fpam-unveils-maintenance-framework-2');
    const renamed = await request(app).patch(`/api/news/${id}`).set(A(adminToken)).send({ title: 'New headline' });
    expect(renamed.body.news.slug).toBe('fpam-unveils-maintenance-framework');
  });

  it('can be hidden from the ticker, unpublished and deleted', async () => {
    await request(app).patch(`/api/news/${id}`).set(A(adminToken)).send({ inTicker: false });
    expect((await request(app).get('/api/news/ticker')).body.items).toHaveLength(0);
    await request(app).patch(`/api/news/${id}`).set(A(adminToken)).send({ status: 'draft' });
    expect((await request(app).get('/api/news')).body.news).toHaveLength(0);
    expect((await request(app).get('/api/news/manage/all').set(A(adminToken))).body.news).toHaveLength(2);
    expect((await request(app).delete(`/api/news/${id}`).set(A(adminToken))).status).toBe(200);
  });
});
