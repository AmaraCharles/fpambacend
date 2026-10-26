'use strict';
// Sign-in, two-step sign-in, session revocation and upload checks, against
// the real app and an in-memory database.
const request = require('supertest');
const { startDb, stopDb, makeUser, login } = require('./helpers/memoryDb');
const totp = require('../src/utils/totp');

let app;
beforeAll(async () => { await startDb(); app = require('../src/app'); });
afterAll(stopDb);

describe('sessions', () => {
  it('logs in and rejects a wrong password', async () => {
    const u = await makeUser();
    expect((await login(app, u.email, 'nope-nope')).status).toBe(401);
    const res = await login(app, u.email);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.password).toBeUndefined();
  });

  it('change-password ends other sessions but keeps this one with a fresh token', async () => {
    const u = await makeUser();
    const other = (await login(app, u.email)).body.token;
    const mine = (await login(app, u.email)).body.token;
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${mine}`)
      .send({ currentPassword: 'Password123', newPassword: 'NewPassword456' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${other}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
  });

  it('sign out everywhere revokes every token', async () => {
    const u = await makeUser();
    const t = (await login(app, u.email)).body.token;
    expect((await request(app).post('/api/auth/logout-all').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${t}`);
    expect(me.status).toBe(401);
    expect(me.body.error).toMatch(/session has ended/);
  });

  it('deactivating a user ends their sessions', async () => {
    const admin = await makeUser({ role: 'System Admin', division: 'All' });
    const u = await makeUser();
    const at = (await login(app, admin.email)).body.token;
    const ut = (await login(app, u.email)).body.token;
    expect((await request(app).delete(`/api/users/${u._id}`).set('Authorization', `Bearer ${at}`)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${ut}`)).status).toBe(401);
  });
});

describe('two-step sign-in', () => {
  it('sets up, requires a code at login, accepts a recovery code once, and can be reset by an admin', async () => {
    const u = await makeUser({ role: 'Supervisor', division: 'All' });
    const t = (await login(app, u.email)).body.token;
    const auth = { Authorization: `Bearer ${t}` };

    const setup = await request(app).post('/api/auth/mfa/setup').set(auth);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/FPAMAS/);
    expect((await request(app).post('/api/auth/mfa/enable').set(auth).send({ code: '000000' })).status).toBe(400);
    const enabled = await request(app).post('/api/auth/mfa/enable').set(auth).send({ code: totp.totp(setup.body.secret) });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(8);

    // Password alone no longer signs in
    const step1 = await login(app, u.email);
    expect(step1.body).toMatchObject({ mfaRequired: true });
    expect(step1.body.token).toBeUndefined();
    // The half-way token can't call the API
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${step1.body.mfaToken}`)).status).toBe(401);
    expect((await request(app).post('/api/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '123456' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: totp.totp(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mfa).toEqual(expect.objectContaining({ enabled: true }));
    expect(JSON.stringify(ok.body.user)).not.toMatch(/secret|recovery/i);

    // Recovery code: works once
    const rc = enabled.body.recoveryCodes[0];
    const a = await login(app, u.email);
    expect((await request(app).post('/api/auth/mfa/verify').send({ mfaToken: a.body.mfaToken, code: rc })).status).toBe(200);
    const b = await login(app, u.email);
    expect((await request(app).post('/api/auth/mfa/verify').send({ mfaToken: b.body.mfaToken, code: rc })).status).toBe(401);

    // Admin reset for a lost phone
    const admin = await makeUser({ role: 'System Admin', division: 'All' });
    const at = (await login(app, admin.email)).body.token;
    expect((await request(app).post(`/api/users/${u._id}/reset-mfa`).set('Authorization', `Bearer ${at}`)).status).toBe(200);
    expect((await login(app, u.email)).body.token).toBeTruthy();
  });
});

describe('required two-step sign-in', () => {
  afterAll(() => { process.env.MFA_REQUIRED_ROLES = 'none'; });
  it('blocks the API for required roles until two-step sign-in is on', async () => {
    process.env.MFA_REQUIRED_ROLES = 'System Admin,Supervisor';
    const sup = await makeUser({ role: 'Supervisor', division: 'All' });
    const field = await makeUser();
    const res = await login(app, sup.email);
    expect(res.body.user.mfaSetupRequired).toBe(true);
    const auth = { Authorization: `Bearer ${res.body.token}` };
    const blocked = await request(app).get('/api/assets').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_SETUP_REQUIRED');
    expect((await request(app).get('/api/auth/me').set(auth)).body.user.mfaSetupRequired).toBe(true);
    // Field agents aren't affected
    const ft = (await login(app, field.email)).body.token;
    expect((await request(app).get('/api/assets').set('Authorization', `Bearer ${ft}`)).status).toBe(200);
    // Setting it up (allowed while blocked) unblocks the API
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth);
    expect((await request(app).post('/api/auth/mfa/enable').set(auth).send({ code: totp.totp(setup.body.secret) })).status).toBe(200);
    expect((await request(app).get('/api/assets').set(auth)).status).toBe(200);
  });
});

describe('uploads and states', () => {
  let token, assetId;
  beforeAll(async () => {
    const admin = await makeUser({ role: 'System Admin', division: 'All' });
    token = (await login(app, admin.email)).body.token;
  });

  it('normalises state spellings and rejects unknown states', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const bad = await request(app).post('/api/assets').set(auth).send({ name: 'Bad State Office', type: 'Administrative Office', coordinates: [7.4, 9.0], state: 'Adamawa and Taraba', mda: 'FMW' });
    expect(bad.status).toBe(422);
    const good = await request(app).post('/api/assets').set(auth).send({ name: 'Good State Office', type: 'Administrative Office', coordinates: [7.4, 9.0], state: 'abuja', mda: 'FMW' });
    expect(good.status).toBe(201);
    expect(good.body.asset.state).toBe('FCT');
    assetId = good.body.asset.assetId;
  });

  it('rejects a disguised executable photo before storing it', async () => {
    const res = await request(app).post(`/api/assets/${assetId}/photos`).set('Authorization', `Bearer ${token}`)
      .attach('photo', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]), { filename: 'holiday.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Executable/);
  });
});
