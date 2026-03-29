// src/connectors/csv.js
// Exports the order as a CSV file saved to ./data/exports/
// Perfect for customers whose ERP only supports CSV import.

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

const EXPORT_DIR = resolve(process.cwd(), 'data', 'exports');

function toCsv(rows) {
  return rows.map(row =>
    row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
}

export const csvConnector = {
  isConfigured() { return true; }, // Always available

  async push(order) {
    if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { recursive: true });

    const filename = `order-${order.poNumber ?? order.id}-${Date.now()}.csv`;
    const filepath = resolve(EXPORT_DIR, filename);

    const headers = [
      'po_number', 'customer_name', 'customer_email',
      'ship_to', 'requested_delivery', 'payment_terms',
      'sku', 'description', 'quantity', 'unit', 'unit_price', 'total_price',
      'notes', 'issues',
    ];

    const rows = (order.lineItems ?? []).map(item => [
      order.poNumber,
      order.customerName,
      order.customerEmail,
      [order.shipTo?.address, order.shipTo?.city, order.shipTo?.state, order.shipTo?.zip]
        .filter(Boolean).join(', '),
      order.requestedDeliveryDate,
      order.paymentTerms,
      item.mappedSku,
      item.rawDescription,
      item.quantity,
      item.unit,
      item.unitPrice,
      item.totalPrice,
      item.notes,
      (item.issues ?? []).join('; '),
    ]);

    const csv = toCsv([headers, ...rows]);
    writeFileSync(filepath, csv, 'utf-8');

    logger.info('CSV export written', { filepath, rows: rows.length });

    return {
      ref: filename,
      filepath,
      message: `CSV exported: ${filename}`,
    };
  },
};
