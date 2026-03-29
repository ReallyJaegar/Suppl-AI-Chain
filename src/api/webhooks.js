// src/api/webhooks.js
// Outbound webhook registration and inbound event handling.
//
// POST /webhooks/register  — Register a webhook endpoint to receive order events
// DELETE /webhooks/:id     — Unregister
// GET  /webhooks           — List registered webhooks
// POST /webhooks/test      — Send a test payload to a webhook URL

import { Router } from 'express';
import { createHmac } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const webhookRoutes = Router();

// In-memory store for MVP. Replace with DB persistence in production.
const registeredWebhooks = new Map();

// ─── Register ─────────────────────────────────────────────
webhookRoutes.post('/register', asyncHandler(async (req, res) => {
  const { url, events = ['order.parsed', 'order.pushed', 'order.exception'] } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });

  // Validate the URL is reachable (simple ping)
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
  } catch {
    return res.status(400).json({ error: `Webhook URL not reachable: ${url}` });
  }

  const id = crypto.randomUUID();
  registeredWebhooks.set(id, { id, url, events, createdAt: new Date().toISOString() });

  logger.info('Webhook registered', { id, url, events });
  res.status(201).json({ id, url, events });
}));

// ─── List ─────────────────────────────────────────────────
webhookRoutes.get('/', (req, res) => {
  res.json(Array.from(registeredWebhooks.values()));
});

// ─── Delete ───────────────────────────────────────────────
webhookRoutes.delete('/:id', (req, res) => {
  if (!registeredWebhooks.has(req.params.id)) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  registeredWebhooks.delete(req.params.id);
  res.json({ deleted: true });
});

// ─── Test ─────────────────────────────────────────────────
webhookRoutes.post('/test', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const payload = {
    event: 'order.test',
    timestamp: new Date().toISOString(),
    data: { message: 'This is a test webhook from Order Intake AI' },
  };

  const result = await dispatchWebhook(url, payload);
  res.json(result);
}));

// ─── Internal dispatch function ───────────────────────────
// Call this from other services to fire webhook events.
// Signs the payload with HMAC-SHA256 using WEBHOOK_SECRET.

export async function dispatchEvent(eventName, data) {
  const payload = {
    event: eventName,
    timestamp: new Date().toISOString(),
    data,
  };

  const subscribers = Array.from(registeredWebhooks.values())
    .filter(wh => wh.events.includes(eventName) || wh.events.includes('*'));

  await Promise.allSettled(subscribers.map(wh => dispatchWebhook(wh.url, payload)));
}

async function dispatchWebhook(url, payload) {
  const body = JSON.stringify(payload);
  const signature = config.webhook.secret
    ? createHmac('sha256', config.webhook.secret).update(body).digest('hex')
    : null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature && { 'X-Webhook-Signature': `sha256=${signature}` }),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });

    logger.info('Webhook dispatched', { url, event: payload.event, status: res.status });
    return { success: res.ok, status: res.status };

  } catch (err) {
    logger.error('Webhook dispatch failed', { url, error: err.message });
    return { success: false, error: err.message };
  }
}
