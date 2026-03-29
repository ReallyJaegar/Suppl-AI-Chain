// src/api/orders.js
// REST API for order intake operations.
//
// POST /api/orders/parse      — Parse a raw email/text into structured JSON
// POST /api/orders/parse-file — Parse an uploaded file (PDF, XLSX, CSV)
// GET  /api/orders            — List all processed orders
// GET  /api/orders/:id        — Get a single order
// POST /api/orders/:id/push   — Push order to ERP
// PUT  /api/orders/:id/resolve — Resolve an exception manually

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { extractionService } from '../services/extractionService.js';
import { orderStore } from '../services/orderStore.js';
import { erpRouter } from '../services/erpRouter.js';
import { logger } from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const orderRoutes = Router();

// Multer: accept PDF, XLSX, CSV in memory (max 20MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ─── Validation schemas ───────────────────────────────────

const ParseEmailSchema = z.object({
  from: z.string().email().optional(),
  subject: z.string().optional(),
  date: z.string().optional(),
  body: z.string().min(10, 'Email body too short'),
});

const ResolveSchema = z.object({
  field: z.string(),
  value: z.string(),
});

// ─── POST /api/orders/parse ───────────────────────────────
// Accepts raw email metadata + body as JSON.
// Returns structured order object.

orderRoutes.post('/parse', asyncHandler(async (req, res) => {
  const parsed = ParseEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { from, subject, date, body } = parsed.data;
  const startMs = Date.now();

  logger.info('Parsing order from email', { from, subject });

  const order = await extractionService.parseEmail({
    from,
    subject,
    date: date ?? new Date().toISOString(),
    body,
  });

  order.processingTimeMs = Date.now() - startMs;
  await orderStore.save(order);

  logger.info('Order parsed', {
    id: order.id,
    touchless: order.touchless,
    confidence: order.confidence,
    lineItems: order.lineItems.length,
    processingTimeMs: order.processingTimeMs,
  });

  res.status(201).json(order);
}));

// ─── POST /api/orders/parse-file ─────────────────────────
// Accepts a multipart file upload.
// Extracts text from PDF/XLSX/CSV, then runs extraction.

orderRoutes.post('/parse-file', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const startMs = Date.now();
  logger.info('Parsing order from file', {
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });

  const text = await extractionService.extractTextFromFile(
    req.file.buffer,
    req.file.mimetype,
    req.file.originalname,
  );

  const order = await extractionService.parseEmail({
    from: req.body.from,
    subject: req.body.subject ?? req.file.originalname,
    date: req.body.date ?? new Date().toISOString(),
    body: text,
  });

  order.processingTimeMs = Date.now() - startMs;
  order.sourceFile = req.file.originalname;
  await orderStore.save(order);

  res.status(201).json(order);
}));

// ─── GET /api/orders ─────────────────────────────────────
// Lists orders with optional filters.
// Query params: status (touchless|exception|all), limit, offset

orderRoutes.get('/', asyncHandler(async (req, res) => {
  const { status = 'all', limit = 50, offset = 0 } = req.query;
  const orders = await orderStore.list({ status, limit: +limit, offset: +offset });
  res.json(orders);
}));

// ─── GET /api/orders/:id ──────────────────────────────────
orderRoutes.get('/:id', asyncHandler(async (req, res) => {
  const order = await orderStore.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
}));

// ─── POST /api/orders/:id/push ────────────────────────────
// Pushes order to the configured ERP.
// Body: { target: 'netsuite' | 'quickbooks' | 'csv' | 'webhook' }

orderRoutes.post('/:id/push', asyncHandler(async (req, res) => {
  const order = await orderStore.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const target = req.body.target ?? 'csv';

  logger.info('Pushing order to ERP', { id: order.id, target });

  const result = await erpRouter.push(order, target);

  await orderStore.update(order.id, {
    erpStatus: result.success ? 'pushed' : 'failed',
    erpTarget: target,
    erpRef: result.ref,
    erpPushedAt: new Date().toISOString(),
  });

  res.json(result);
}));

// ─── PUT /api/orders/:id/resolve ─────────────────────────
// Manually resolves a single exception field (e.g. provides FedEx account).
// After resolve, re-evaluates touchless status.

orderRoutes.put('/:id/resolve', asyncHandler(async (req, res) => {
  const schema = ResolveSchema.safeParse(req.body);
  if (!schema.success) return res.status(400).json({ error: schema.error.flatten() });

  const order = await orderStore.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { field, value } = schema.data;
  order[field] = value;

  // Remove the resolved exception from the list
  order.exceptions = order.exceptions.filter(
    e => !e.toLowerCase().includes(field.toLowerCase())
  );
  order.touchless = order.exceptions.length === 0;

  await orderStore.update(order.id, order);

  logger.info('Exception resolved', { id: order.id, field, touchless: order.touchless });
  res.json(order);
}));
