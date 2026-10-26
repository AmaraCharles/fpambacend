// Runs before every test file: test-only settings, never the real database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : 'test-secret-must-be-at-least-32-characters';
// Placeholder so config validation passes; integration tests connect to their
// own in-memory MongoDB (tests/helpers/memoryDb.js) instead.
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/not-used-in-tests';
delete process.env.SMTP_HOST;
delete process.env.SMS_PROVIDER;
delete process.env.CLAMAV_HOST;
// Most tests use admin/supervisor accounts without two-step sign-in; the
// enforcement test switches this on explicitly.
process.env.MFA_REQUIRED_ROLES = 'none';
