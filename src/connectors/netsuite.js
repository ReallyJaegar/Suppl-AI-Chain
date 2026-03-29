// src/connectors/netsuite.js
// Pushes orders to NetSuite via REST API using OAuth 1.0a Token-Based Authentication (TBA).
// NetSuite REST API docs: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1544366192.html

import { createHmac, randomBytes } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const BASE_URL = `https://${config.netsuite.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;

// ─── OAuth 1.0a TBA header builder ────────────────────────

function buildAuthHeader(method, url) {
  const {
    accountId,
    consumerKey,
    consumerSecret,
    tokenId,
    tokenSecret,
  } = config.netsuite;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        timestamp,
    oauth_token:            tokenId,
    oauth_version:          '1.0',
  });

  // Build base string
  const sortedParams = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature  = createHmac('sha256', signingKey).update(baseString).digest('base64');

  return [
    'OAuth realm="' + accountId + '"',
    'oauth_consumer_key="' + consumerKey + '"',
    'oauth_token="' + tokenId + '"',
    'oauth_signature_method="HMAC-SHA256"',
    'oauth_timestamp="' + timestamp + '"',
    'oauth_nonce="' + nonce + '"',
    'oauth_version="1.0"',
    'oauth_signature="' + encodeURIComponent(signature) + '"',
  ].join(', ');
}

async function netsuiteRequest(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const authHeader = buildAuthHeader(method, url);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'respond-async',
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NetSuite ${method} ${path} failed (${res.status}): ${err}`);
  }

  // 204 No Content on successful POST
  if (res.status === 204 || res.status === 201) {
    const location = res.headers.get('location');
    return { location };
  }

  return res.json();
}

// ─── Order → NetSuite Sales Order mapper ─────────────────

function mapToNetSuiteOrder(order) {
  return {
    // NetSuite field names — adjust to match your account's custom fields
    entity: { id: order.customerEmail }, // You'd normally look up the customer internal ID
    tranDate: order.requestedDeliveryDate ?? new Date().toISOString().split('T')[0],
    otherRefNum: order.poNumber,
    memo: `Imported via Order Intake AI — ${order.parsedAt}`,
    shipDate: order.requestedDeliveryDate,
    item: {
      items: (order.lineItems ?? []).map(item => ({
        item: { id: item.mappedSku },
        quantity: item.quantity,
        rate: item.unitPrice,
        amount: item.totalPrice,
        description: item.rawDescription,
      })),
    },
  };
}

// ─── Connector ────────────────────────────────────────────

export const netsuiteConnector = {
  isConfigured() {
    return !!(config.netsuite.accountId && config.netsuite.consumerKey);
  },

  async push(order) {
    if (!this.isConfigured()) {
      throw new Error('NetSuite credentials not configured');
    }

    const payload = mapToNetSuiteOrder(order);
    logger.info('NetSuite: creating sales order', { poNumber: order.poNumber });

    const result = await netsuiteRequest('POST', '/salesOrder', payload);

    // Extract the new NetSuite internal ID from the Location header
    const internalId = result.location?.split('/').pop();
    logger.info('NetSuite: sales order created', { internalId });

    return {
      ref: internalId,
      url: result.location,
      message: `NetSuite Sales Order created: ${internalId}`,
    };
  },
};
