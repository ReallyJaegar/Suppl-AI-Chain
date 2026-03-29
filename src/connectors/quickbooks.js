// src/connectors/quickbooks.js
// Pushes orders to QuickBooks Online as Sales Receipts or Estimates
// using the QBO v3 API with OAuth 2.0.

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const QBO_BASE = `https://quickbooks.api.intuit.com/v3/company/${config.quickbooks.realmId}`;
const SANDBOX_BASE = `https://sandbox-quickbooks.api.intuit.com/v3/company/${config.quickbooks.realmId}`;

const BASE_URL = process.env.NODE_ENV === 'production' ? QBO_BASE : SANDBOX_BASE;

// ─── Token refresh ────────────────────────────────────────

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;

  const credentials = Buffer.from(
    `${config.quickbooks.clientId}:${config.quickbooks.clientSecret}`
  ).toString('base64');

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.quickbooks.refreshToken,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`QBO token refresh failed: ${data.error_description}`);

  accessToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return accessToken;
}

async function qboRequest(method, path, body = null) {
  const token = await getAccessToken();
  const url = `${BASE_URL}${path}?minorversion=65`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`QBO ${method} ${path} failed: ${JSON.stringify(data.Fault)}`);
  return data;
}

// ─── Order → QBO Estimate mapper ─────────────────────────

function mapToQBOEstimate(order) {
  return {
    DocNumber: order.poNumber,
    TxnDate: new Date().toISOString().split('T')[0],
    CustomerRef: { name: order.customerName ?? order.customerEmail ?? 'Unknown' },
    CustomerMemo: { value: `PO: ${order.poNumber} | Imported via Order Intake AI` },
    ShipDate: order.requestedDeliveryDate,
    Line: (order.lineItems ?? []).map((item, i) => ({
      Id: String(i + 1),
      LineNum: i + 1,
      Description: item.rawDescription,
      Amount: item.totalPrice ?? (item.quantity * item.unitPrice),
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { name: item.mappedSku ?? item.rawDescription },
        Qty: item.quantity,
        UnitPrice: item.unitPrice,
      },
    })),
  };
}

// ─── Connector ────────────────────────────────────────────

export const quickbooksConnector = {
  isConfigured() {
    return !!(config.quickbooks.clientId && config.quickbooks.realmId);
  },

  async push(order) {
    if (!this.isConfigured()) {
      throw new Error('QuickBooks credentials not configured');
    }

    const payload = mapToQBOEstimate(order);
    logger.info('QuickBooks: creating estimate', { poNumber: order.poNumber });

    const result = await qboRequest('POST', '/estimate', payload);
    const estimate = result.Estimate;

    logger.info('QuickBooks: estimate created', { id: estimate.Id, docNumber: estimate.DocNumber });

    return {
      ref: estimate.Id,
      docNumber: estimate.DocNumber,
      message: `QuickBooks Estimate created: #${estimate.DocNumber} (ID: ${estimate.Id})`,
    };
  },
};
