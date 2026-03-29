// src/connectors/webhook.js
// Posts the structured order JSON to a configured webhook URL.
// Works with Zapier, Make, n8n, or any custom HTTP endpoint.
// This is the universal "no-code ERP integration" path.

import { createHmac } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const WEBHOOK_URL = process.env.ERP_WEBHOOK_URL;

export const webhookConnector = {
  isConfigured() {
    return !!WEBHOOK_URL;
  },

  async push(order) {
    if (!WEBHOOK_URL) {
      throw new Error('ERP_WEBHOOK_URL not configured. Set this env var to a Zapier/Make webhook URL.');
    }

    const payload = {
      event: 'order.ready_for_erp',
      timestamp: new Date().toISOString(),
      order: {
        id:                    order.id,
        poNumber:              order.poNumber,
        customerName:          order.customerName,
        customerEmail:         order.customerEmail,
        shipTo:                order.shipTo,
        requestedDeliveryDate: order.requestedDeliveryDate,
        paymentTerms:          order.paymentTerms,
        currency:              order.currency ?? 'USD',
        orderTotal:            order.orderTotal,
        lineItems:             order.lineItems,
        touchless:             order.touchless,
        parsedAt:              order.parsedAt,
      },
    };

    const body = JSON.stringify(payload);
    const signature = config.webhook.secret
      ? `sha256=${createHmac('sha256', config.webhook.secret).update(body).digest('hex')}`
      : null;

    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature && { 'X-Webhook-Signature': signature }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Webhook returned ${res.status}: ${text}`);
    }

    logger.info('Webhook push succeeded', { url: WEBHOOK_URL, status: res.status });

    return {
      ref: `webhook-${Date.now()}`,
      message: `Order posted to webhook (status ${res.status})`,
    };
  },
};
