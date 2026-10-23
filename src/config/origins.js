'use strict';
// Sites allowed to call the API from a browser — shared by Express CORS and socket.io.
const env = require('./env');

const ALLOWED = ['https://fpam.vercel.app', 'https://fpam.fmhud.gov.ng'];

function isAllowedOrigin(origin) {
  return !origin
    || origin === env.CLIENT_URL
    || ALLOWED.includes(origin)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** For cors()/socket.io's `origin` option. */
const corsOrigin = (origin, cb) => cb(null, isAllowedOrigin(origin));

module.exports = { isAllowedOrigin, corsOrigin };
