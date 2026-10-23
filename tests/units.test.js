'use strict';
const totp = require('../src/utils/totp');
const { normalizeState, NIGERIA_STATES } = require('../src/utils/states');
const { contentProblem } = require('../src/middleware/fileScan');
const sms = require('../src/services/sms');

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 test secret "12345678901234567890" (SHA-1); last 6 of the 8-digit vectors.
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC test vectors', () => {
    expect(totp.totp(secret, 59 * 1000)).toBe('287082');
    expect(totp.totp(secret, 1111111109 * 1000)).toBe('081804');
    expect(totp.totp(secret, 2000000000 * 1000)).toBe('279037');
  });
  it('accepts one step of clock drift, rejects more', () => {
    const now = 1700000000000;
    expect(totp.verifyTotp(secret, totp.totp(secret, now - 30000), now)).toBe(true);
    expect(totp.verifyTotp(secret, totp.totp(secret, now - 90000), now)).toBe(false);
    expect(totp.verifyTotp(secret, 'abc123', now)).toBe(false);
  });
  it('round-trips base32', () => {
    const buf = Buffer.from('any bytes \x00\xff');
    expect(totp.base32Decode(totp.base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe('normalizeState', () => {
  it('maps variants to canonical names', () => {
    expect(normalizeState('lagos')).toBe('Lagos');
    expect(normalizeState('  Akwa-Ibom ')).toBe('Akwa Ibom');
    expect(normalizeState('Abuja')).toBe('FCT');
    expect(normalizeState('Kano State')).toBe('Kano');
    expect(normalizeState('')).toBe('');
  });
  it('rejects non-states', () => {
    expect(normalizeState('Adamawa and Taraba')).toBeNull();
    expect(normalizeState('Atlantis')).toBeNull();
  });
  it('has FCT + 36 states', () => expect(NIGERIA_STATES).toHaveLength(37));
});

describe('upload content check', () => {
  const f = (mimetype, bytes) => ({ mimetype, buffer: Buffer.from(bytes), originalname: 'x' });
  it('accepts real files', () => {
    expect(contentProblem(f('image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBeNull();
    expect(contentProblem(f('application/pdf', [...Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj')]))).toBeNull();
    expect(contentProblem(f('text/csv', [...Buffer.from('a,b\n1,2\n')]))).toBeNull();
  });
  it('rejects disguised executables and mismatched types', () => {
    expect(contentProblem(f('image/jpeg', [0x4d, 0x5a, 0x90, 0x00]))).toMatch(/Executable/);
    expect(contentProblem(f('image/png', [0xff, 0xd8, 0xff]))).toMatch(/don't match/);
    expect(contentProblem(f('text/plain', [0x41, 0x00, 0x42]))).toMatch(/text file/);
  });
  it('rejects PDFs with JavaScript, but not random stream bytes', () => {
    expect(contentProblem(f('application/pdf', [...Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>')]))).toMatch(/scripts/);
    expect(contentProblem(f('application/pdf', [...Buffer.from('%PDF-1.4\n<< /Length 9 >>\nstream\n../JS x..\nendstream')]))).toBeNull();
  });
});

describe('SMS', () => {
  it('normalises Nigerian numbers', () => {
    expect(sms.normalizePhone('0803 123 4567')).toBe('2348031234567');
    expect(sms.normalizePhone('+234 803 123 4567')).toBe('2348031234567');
    expect(sms.normalizePhone('12')).toBeNull();
  });
  it('skips sending when no provider is configured', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(sms.sendSms('08031234567', 'hi')).resolves.toEqual({ sent: false, reason: 'not configured' });
    spy.mockRestore();
  });
  it('calls the Termii API when configured', async () => {
    process.env.SMS_PROVIDER = 'termii'; process.env.TERMII_API_KEY = 'k';
    const calls = [];
    sms._setFetchForTests(async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; });
    await expect(sms.sendSms('08031234567', 'hello')).resolves.toEqual({ sent: true });
    expect(calls[0].url).toMatch(/termii/);
    expect(calls[0].body).toMatchObject({ to: '2348031234567', sms: 'hello', api_key: 'k' });
    delete process.env.SMS_PROVIDER;
  });
});
