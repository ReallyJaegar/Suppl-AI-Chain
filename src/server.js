// src/server.js
// Main Express server. Wires up middleware, routes, and starts the inbox poller.

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { orderRoutes } from './api/orders.js';
import { authRoutes } from './api/auth.js';
import { webhookRoutes } from './api/webhooks.js';
import { startInboxPoller } from './services/inboxPoller.js';
import { logger } from './utils/logger.js';

const app = express();

// ─── Security middleware ──────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ─── CORS (dev permissive, lock down in prod) ─────────────
app.use((req, res, next) => {
  const origin = config.env === 'production'
    ? process.env.ALLOWED_ORIGIN
    : '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Routes ───────────────────────────────────────────────
app.use('/api/orders', orderRoutes);
app.use('/auth', authRoutes);
app.use('/webhooks', webhookRoutes);

// ─── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    env: config.env,
    timestamp: new Date().toISOString(),
  });
});

// ─── Global error handler ─────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(config.env === 'development' && { stack: err.stack }),
  });
});

// ─── Start ────────────────────────────────────────────────
app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port} [${config.env}]`);

  // Start inbox polling if credentials are configured
  if (config.gmail.refreshToken || config.outlook.clientId) {
    startInboxPoller();
    logger.info('Inbox poller started');
  } else {
    logger.warn('No inbox credentials found — poller disabled');
  }
});

export default app;
