// The 6 read-only Warp tools: schema + handler side by side, so they can never drift
// apart. `llm.js` sends the schemas to OpenAI; `ws/session.js` dispatches by name to
// the handler. No booking tool is defined here — that omission is the guardrail.

import * as client from '../warp/client.js';
import {
  ok,
  fail,
  fromWarpApiError,
  humanizeStatus,
  humanizeDocType,
  relativeTime,
  roundUsd,
  looksLikeValidId,
  normalizeIdCandidate,
  normalizeQuoteOptions,
} from '../warp/normalize.js';

const isValidZip = (z) => /^\d{5}$/.test(String(z || '').trim());

export const tools = [
  {
    name: 'track_shipment',
    description:
      "Look up live status and location for one or more tracking numbers (shape like S-1001-IN). Use this whenever the caller asks where a shipment is.",
    parameters: {
      type: 'object',
      properties: {
        trackingNumbers: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
          description: 'One or more tracking numbers, e.g. ["S-1001-IN"]',
        },
      },
      required: ['trackingNumbers'],
    },
    async handler({ trackingNumbers }) {
      if (!Array.isArray(trackingNumbers) || trackingNumbers.length === 0) {
        return fail('invalid_format', 'I need at least one tracking number to look that up.');
      }
      const normalized = trackingNumbers.map((n) => normalizeIdCandidate(n));
      const validNumbers = normalized.filter((n) => looksLikeValidId('trackingNumber', n));
      if (validNumbers.length === 0) {
        return fail(
          'invalid_format',
          `"${trackingNumbers[0]}" doesn't look like a tracking number I recognize — they're usually shaped like S-1001-IN. Could you repeat it?`,
        );
      }
      try {
        const { body } = await client.trackShipments(validNumbers);
        const results = body.map((item) => {
          if (item.error === 'not_found') {
            return { trackingNumber: item.trackingNumber, ok: false, code: 'not_found' };
          }
          return {
            trackingNumber: item.trackingNumber,
            ok: true,
            status: humanizeStatus(item.statusInfo?.status),
            statusUpdated: relativeTime(item.statusInfo?.lastUpdated),
            location: item.location ? `${item.location.city}, ${item.location.state}` : 'not available',
            shipmentId: item.shipmentId,
            orderId: item.orderId,
            orderNumber: item.orderNumber,
          };
        });
        return ok({ results });
      } catch (err) {
        return fromWarpApiError(err);
      }
    },
  },

  {
    name: 'get_shipment_events',
    description:
      'Get the event timeline (order received, picked up, in transit, delivered, etc) for a shipment. Requires a shipment ID (shape like SH-1001), not a tracking number — get one from track_shipment first if you only have the tracking number.',
    parameters: {
      type: 'object',
      properties: {
        shipmentId: { type: 'string', description: 'Shipment ID, e.g. SH-1001' },
      },
      required: ['shipmentId'],
    },
    async handler({ shipmentId }) {
      const normalized = normalizeIdCandidate(shipmentId);
      if (!looksLikeValidId('shipmentId', normalized)) {
        return fail('invalid_format', `"${shipmentId}" doesn't look like a shipment ID — they're usually shaped like SH-1001.`);
      }
      try {
        const { body } = await client.getShipmentEvents(normalized);
        const all = body.data || [];
        const recent = all.slice(-5).map((e) => ({
          message: e.message,
          when: relativeTime(e.when),
        }));
        return ok({ events: recent, totalEvents: all.length, truncated: all.length > recent.length });
      } catch (err) {
        return fromWarpApiError(err);
      }
    },
  },

  {
    name: 'list_shipments',
    description: "List the account's recent shipments. Use when the caller doesn't have a tracking number handy and wants an overview.",
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, description: 'Page number, defaults to 1' },
        pageSize: { type: 'integer', minimum: 1, maximum: 7, description: 'Results per page, defaults to 5' },
      },
    },
    async handler({ page, pageSize } = {}) {
      try {
        const { body } = await client.listShipments({ page, pageSize });
        const shipments = (body.data || []).map((s) => ({
          trackingNumber: s.trackingNumber,
          orderId: s.orderId,
          status: humanizeStatus(s.status),
          from: `${s.pickup?.city}, ${s.pickup?.state}`,
          to: `${s.delivery?.city}, ${s.delivery?.state}`,
          created: relativeTime(s.createDate),
        }));
        return ok({ shipments, total: body.total, page: body.page, pageSize: body.pageSize });
      } catch (err) {
        return fromWarpApiError(err);
      }
    },
  },

  {
    name: 'get_shipping_quote',
    description:
      "Get a real shipping rate for a lane (pickup ZIP to delivery ZIP). This can take up to ~15 seconds and can occasionally fail because the carrier rating system is briefly busy — that's expected, not a bug: report the failure honestly and only try again if the caller asks you to, don't call this tool twice in a row on your own.",
    parameters: {
      type: 'object',
      properties: {
        pickupZip: { type: 'string', description: '5-digit pickup ZIP code' },
        deliveryZip: { type: 'string', description: '5-digit delivery ZIP code' },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD; use today\'s date if the caller does not give one' },
        items: {
          type: 'array',
          description: 'Optional. If the caller does not describe the freight, omit this and a generic single-pallet shipment will be quoted.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'integer' },
              weightLbs: { type: 'number' },
            },
          },
        },
      },
      required: ['pickupZip', 'deliveryZip', 'pickupDate'],
    },
    async handler({ pickupZip, deliveryZip, pickupDate, items }) {
      if (!isValidZip(pickupZip) || !isValidZip(deliveryZip)) {
        return fail('invalid_format', 'I need valid 5-digit ZIP codes for both pickup and delivery to get a rate.');
      }
      const listItems =
        Array.isArray(items) && items.length > 0
          ? items.map((i) => ({ description: i.description || 'freight', quantity: i.quantity || 1, weightLbs: i.weightLbs || 500 }))
          : [{ description: 'pallet', quantity: 1, weightLbs: 500 }];

      try {
        const { body } = await client.getFreightQuote({
          pickupDate,
          pickupInfo: { zipcode: pickupZip },
          deliveryInfo: { zipcode: deliveryZip },
          listItems,
        });
        const options = body.options || [];
        if (options.length === 0) {
          return ok({ cheapestOptions: [], totalOptions: 0, noRatesForLane: true });
        }
        const { cheapestOptions, totalOptions } = normalizeQuoteOptions(options, { limit: 3 });
        return ok({ cheapestOptions, totalOptions, noRatesForLane: false });
      } catch (err) {
        return fromWarpApiError(err);
      }
    },
  },

  {
    name: 'get_invoice',
    description: "Get the invoice total and cost breakdown for an order. Requires an order ID (shape like O-1001), not a tracking number.",
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Order ID, e.g. O-1001' },
      },
      required: ['orderId'],
    },
    async handler({ orderId }) {
      const normalized = normalizeIdCandidate(orderId);
      if (!looksLikeValidId('orderId', normalized)) {
        return fail('invalid_format', `"${orderId}" doesn't look like an order ID — they're usually shaped like O-1001.`);
      }
      try {
        const { body } = await client.getInvoice(normalized);
        return ok({
          orderId: body.orderId,
          orderNumber: body.orderNumber,
          status: humanizeStatus(body.status),
          grandTotal: roundUsd(body.grandTotal),
          transitCost: roundUsd(body.transitCost),
          fuelCost: roundUsd(body.fuelCost),
          volumeDiscount: roundUsd(body.volumeDiscount),
          serviceOptions: (body.serviceOptions || []).map((s) => ({ name: s.name, amount: roundUsd(s.amount) })),
        });
      } catch (err) {
        return fromWarpApiError(err);
      }
    },
  },

  {
    name: 'get_documents',
    description: "Get document links (Bill of Lading / Proof of Delivery) for an order. Requires an order ID (shape like O-1001).",
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Order ID, e.g. O-1002' },
      },
      required: ['orderId'],
    },
    async handler({ orderId }) {
      const normalized = normalizeIdCandidate(orderId);
      if (!looksLikeValidId('orderId', normalized)) {
        return fail('invalid_format', `"${orderId}" doesn't look like an order ID — they're usually shaped like O-1001.`);
      }
      try {
        const { body } = await client.getDocuments(normalized);
        const documents = (body.data || []).map((d) => ({ type: humanizeDocType(d.type), url: d.url }));
        return ok({ documents });
      } catch (err) {
        return fromWarpApiError(err);
      }
    },
  },
];

export function toOpenAiTools() {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function runTool(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail('unknown_tool', `No such tool: ${name}`);
  return tool.handler(args || {});
}
