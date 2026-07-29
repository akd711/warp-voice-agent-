// Thin fetch wrapper around the Warp freight API (local mock this round).
// Every function here does exactly one HTTP call, with a hard timeout, and either
// returns the parsed JSON body or throws a WarpApiError with a normalized shape.
// No booking function is defined here on purpose — that's the guardrail.

const BASE_URL = (process.env.WARP_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_KEY = process.env.WARP_API_KEY || 'mock';

// Fast endpoints (tracking/events/shipments/invoices/documents) are typically
// 80-400ms in the mock; quote endpoints are deliberately 4-16s. Give quote calls
// a longer ceiling so we don't time out a call the mock was always going to answer.
const DEFAULT_TIMEOUT_MS = 8_000;
const QUOTE_TIMEOUT_MS = 20_000;

export class WarpApiError extends Error {
  constructor(code, message, { status, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'WarpApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function request(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: API_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const code =
        res.status === 404
          ? 'not_found'
          : res.status === 429
            ? 'rate_limited'
            : res.status === 503
              ? 'upstream_unavailable'
              : res.status === 400
                ? 'invalid_format'
                : 'upstream_error';
      throw new WarpApiError(code, parsed.message || `Warp API responded ${res.status}`, {
        status: res.status,
        retryAfterSeconds,
      });
    }

    return { body: parsed, latencyMs };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new WarpApiError('timeout', `Warp API did not respond within ${timeoutMs}ms`, {});
    }
    if (err instanceof WarpApiError) throw err;
    throw new WarpApiError('upstream_error', err.message || 'Warp API request failed', {});
  } finally {
    clearTimeout(timer);
  }
}

export function trackShipments(trackingNumbers) {
  return request('/freights/tracking', { method: 'POST', body: { trackingNumbers } });
}

export function getShipmentEvents(shipmentId) {
  return request(`/freights/events/${encodeURIComponent(shipmentId)}`);
}

export function listShipments({ page = 1, pageSize = 5 } = {}) {
  return request(`/freights/shipments?page=${page}&pageSize=${pageSize}`);
}

export function getFreightQuote(payload) {
  return request('/freights/freight-quote', { method: 'POST', body: payload, timeoutMs: QUOTE_TIMEOUT_MS });
}

export function getInvoice(orderId) {
  return request(`/freights/invoices/${encodeURIComponent(orderId)}`);
}

export function getDocuments(orderId) {
  return request(`/freights/documents/${encodeURIComponent(orderId)}`);
}
