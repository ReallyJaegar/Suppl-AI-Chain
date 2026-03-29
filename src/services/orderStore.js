// src/services/orderStore.js
// Simple file-based order persistence for MVP.
// Drop-in replace with a real DB (Postgres, SQLite) when you're ready to scale.
//
// All orders are stored as a JSON array in ./data/orders.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

const DATA_DIR  = resolve(process.cwd(), 'data');
const DATA_FILE = resolve(DATA_DIR, 'orders.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function persistAll(orders) {
  ensureDataDir();
  writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

export const orderStore = {
  async save(order) {
    const orders = loadAll();
    orders.unshift(order); // newest first
    persistAll(orders);
    logger.info('Order saved', { id: order.id, status: order.status });
    return order;
  },

  async get(id) {
    const orders = loadAll();
    return orders.find(o => o.id === id) ?? null;
  },

  async list({ status = 'all', limit = 50, offset = 0 } = {}) {
    const orders = loadAll();
    const filtered = status === 'all'
      ? orders
      : orders.filter(o => o.status === status);
    return {
      total: filtered.length,
      orders: filtered.slice(offset, offset + limit),
    };
  },

  async update(id, patch) {
    const orders = loadAll();
    const idx = orders.findIndex(o => o.id === id);
    if (idx === -1) throw new Error(`Order not found: ${id}`);
    orders[idx] = { ...orders[idx], ...patch, updatedAt: new Date().toISOString() };
    persistAll(orders);
    return orders[idx];
  },

  async delete(id) {
    const orders = loadAll();
    const filtered = orders.filter(o => o.id !== id);
    persistAll(filtered);
  },

  async stats() {
    const orders = loadAll();
    const total        = orders.length;
    const touchless    = orders.filter(o => o.status === 'touchless').length;
    const exception    = orders.filter(o => o.status === 'exception').length;
    const pushed       = orders.filter(o => o.erpStatus === 'pushed').length;
    const avgConf      = total > 0 ? orders.reduce((s, o) => s + (o.confidence ?? 0), 0) / total : 0;
    const avgProcMs    = total > 0 ? orders.reduce((s, o) => s + (o.processingTimeMs ?? 0), 0) / total : 0;

    return {
      total,
      touchless,
      touchlessRate: total > 0 ? (touchless / total * 100).toFixed(1) + '%' : '0%',
      exception,
      pushed,
      avgConfidence: parseFloat(avgConf.toFixed(3)),
      avgProcessingMs: Math.round(avgProcMs),
    };
  },
};
