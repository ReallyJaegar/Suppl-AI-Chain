// src/services/erpRouter.js
// Routes a parsed order to the correct ERP connector based on the `target` param.
// Supported targets: 'netsuite', 'quickbooks', 'csv', 'webhook'

import { netsuiteConnector } from '../connectors/netsuite.js';
import { quickbooksConnector } from '../connectors/quickbooks.js';
import { csvConnector } from '../connectors/csv.js';
import { webhookConnector } from '../connectors/webhook.js';
import { logger } from '../utils/logger.js';

const CONNECTORS = {
  netsuite:    netsuiteConnector,
  quickbooks:  quickbooksConnector,
  csv:         csvConnector,
  webhook:     webhookConnector,
};

export const erpRouter = {
  async push(order, target = 'csv') {
    const connector = CONNECTORS[target];

    if (!connector) {
      throw new Error(`Unknown ERP target: ${target}. Valid options: ${Object.keys(CONNECTORS).join(', ')}`);
    }

    logger.info('ERP push initiated', { orderId: order.id, target });

    try {
      const result = await connector.push(order);
      logger.info('ERP push succeeded', { orderId: order.id, target, ref: result.ref });
      return { success: true, target, ...result };
    } catch (err) {
      logger.error('ERP push failed', { orderId: order.id, target, error: err.message });
      return { success: false, target, error: err.message };
    }
  },

  // List available connectors and their configuration status
  status() {
    return Object.entries(CONNECTORS).map(([name, c]) => ({
      name,
      configured: c.isConfigured(),
    }));
  },
};
