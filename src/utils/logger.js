// src/utils/logger.js
// Lightweight structured logger. Outputs JSON in production, pretty-prints in dev.

import { config } from '../config/index.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 2;

function log(level, message, meta = {}) {
  if (LEVELS[level] > CURRENT_LEVEL) return;

  const entry = {
    ts:      new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  if (config.env === 'production') {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const color = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' }[level];
    const reset = '\x1b[0m';
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    console.log(`${color}[${level.toUpperCase()}]${reset} ${entry.ts} ${message}${metaStr}`);
  }
}

export const logger = {
  error: (msg, meta) => log('error', msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
};
