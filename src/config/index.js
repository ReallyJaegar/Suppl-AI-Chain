// src/config/index.js
// Loads and validates all environment variables at startup.
// Fail fast: if a required key is missing, the server won't start.

import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (key && rest.length && !process.env[key]) {
        process.env[key] = rest.join('=');
      }
    }
  } catch {
    // .env not found — rely on real environment variables (prod)
  }
}

loadEnv();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, fallback = null) {
  return process.env[key] ?? fallback;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
  },

  gmail: {
    clientId: optional('GMAIL_CLIENT_ID'),
    clientSecret: optional('GMAIL_CLIENT_SECRET'),
    redirectUri: optional('GMAIL_REDIRECT_URI'),
    refreshToken: optional('GMAIL_REFRESH_TOKEN'),
  },

  outlook: {
    clientId: optional('OUTLOOK_CLIENT_ID'),
    clientSecret: optional('OUTLOOK_CLIENT_SECRET'),
    tenantId: optional('OUTLOOK_TENANT_ID'),
    redirectUri: optional('OUTLOOK_REDIRECT_URI'),
  },

  netsuite: {
    accountId: optional('NETSUITE_ACCOUNT_ID'),
    consumerKey: optional('NETSUITE_CONSUMER_KEY'),
    consumerSecret: optional('NETSUITE_CONSUMER_SECRET'),
    tokenId: optional('NETSUITE_TOKEN_ID'),
    tokenSecret: optional('NETSUITE_TOKEN_SECRET'),
  },

  quickbooks: {
    clientId: optional('QUICKBOOKS_CLIENT_ID'),
    clientSecret: optional('QUICKBOOKS_CLIENT_SECRET'),
    realmId: optional('QUICKBOOKS_REALM_ID'),
    refreshToken: optional('QUICKBOOKS_REFRESH_TOKEN'),
  },

  webhook: {
    secret: optional('WEBHOOK_SECRET'),
  },

  db: {
    url: optional('DATABASE_URL', './data/orders.db'),
  },
};
