'use strict';
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { corsOrigin } = require('../config/origins');

let _io = null;

function initRealtime(server) {
  const { Server } = require('socket.io');
  _io = new Server(server, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  });

  // Auth middleware
  _io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET);
      if (payload.purpose) return next(new Error('Invalid token'));
      // Same session rules as the HTTP API: active user, current token version.
      const User = require('../models/User');
      const user = await User.findById(payload.sub, { isActive: 1, tokenVersion: 1, role: 1 }).lean();
      if (!user || !user.isActive || (payload.tv || 0) !== (user.tokenVersion || 0)) return next(new Error('Session ended'));
      socket.userId = payload.sub;
      socket.role   = user.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  _io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    if (socket.role === 'System Admin' || socket.role === 'GIS Analyst') {
      socket.join('dashboard');
    }
    socket.on('disconnect', () => {});
  });

  return _io;
}

function getIO() { return _io; }

// Helper emitters
function emitNewAsset(asset) {
  _io?.to('dashboard').emit('asset:created', {
    assetId: asset.assetId, name: asset.name, type: asset.type, state: asset.state,
  });
}

function emitJobProgress(userId, jobId, progress) {
  _io?.to(`user:${userId}`).emit('job:progress', { jobId, progress });
}

function emitJobComplete(userId, jobId, result) {
  _io?.to(`user:${userId}`).emit('job:complete', { jobId, result });
}

module.exports = { initRealtime, getIO, emitNewAsset, emitJobProgress, emitJobComplete };
