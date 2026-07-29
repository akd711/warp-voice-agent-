// Pure, network-free display/shaping helpers. Single source of truth for the
// {ok, code, message} envelope every tool hands back to the model, and for turning
// raw mock data into something safe and pleasant to read aloud.

export function ok(fields) {
  return { ok: true, ...fields };
}

export function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

export function fromWarpApiError(err) {
  return fail(err.code, err.message, err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {});
}

export function humanizeStatus(status) {
  if (!status) return 'unknown';
  return String(status).replace(/_/g, ' ');
}

// Server computes relative time so the model never has to do date math (and never
// invents "a few minutes ago" when it doesn't actually know).
export function relativeTime(iso) {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `about ${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `about ${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `about ${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

export function roundUsd(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

// The mock has one option with transitTime: 0 and no serviceLevel — a sentinel for
// "not available," never a real same-day ETA. Never speak a fabricated ETA from it.
export function transitDaysLabel(transitTimeSeconds) {
  if (!transitTimeSeconds || transitTimeSeconds <= 0) return null;
  const days = Math.round(transitTimeSeconds / 86_400);
  return days <= 0 ? null : `${days} day${days === 1 ? '' : 's'}`;
}

// Loosened deliberately: STT of a spoken dash-separated code is messy ("S 1001 in",
// "S-1001-I-N"), and normalizeIdCandidate() below already repairs the common cases.
// This check exists only to catch input that couldn't plausibly be this kind of ID
// at all — everything else should reach the real API and let its own not_found
// response (which the agent already handles gracefully) be the source of truth,
// rather than a client-side format gate silently blocking near-misses.
const ID_SHAPES = {
  trackingNumber: /^S-\d{2,6}(-[A-Z]{1,6})?$/i,
  shipmentId: /^SH-\d{2,6}$/i,
  orderId: /^O-\d{2,6}$/i,
};

export function looksLikeValidId(kind, value) {
  const pattern = ID_SHAPES[kind];
  if (!pattern) return true;
  return pattern.test(String(value || '').trim());
}

// Repairs the common ways speech-to-text mangles a spoken ID like "S-1001-IN":
// stray punctuation, spaces instead of dashes, a missing dash after the letter
// prefix, and a short suffix spelled out as separate letters ("I-N" -> "IN").
export function normalizeIdCandidate(raw) {
  if (!raw) return '';
  let t = String(raw).trim().toUpperCase();
  t = t.replace(/[.,]/g, '');
  t = t.replace(/^([A-Z]+)\s*(\d)/, '$1-$2'); // "S1001" / "S 1001" -> "S-1001"
  t = t.replace(/\s+/g, '-');
  t = t.replace(/-{2,}/g, '-');

  const parts = t.split('-');
  while (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    const canMerge = /^[A-Z]$/.test(last) && /^[A-Z]{1,4}$/.test(prev);
    if (!canMerge) break;
    parts[parts.length - 2] = prev + last;
    parts.pop();
  }
  return parts.join('-');
}

// "O" (as in "O-1002") and the digit zero are spoken identically, so STT commonly
// transcribes an order ID as pure digits ("01002") with no letter at all —
// normalizeIdCandidate can't recover a prefix that was never there to begin with.
// Order numbers in this system are always 4 digits, so a leading zero on an
// all-digit candidate is a strong, narrow signal it's really a misheard "O-".
export function repairMisheardOrderId(candidate) {
  const m = /^0-?(\d{3,6})$/.exec(candidate);
  return m ? `O-${m[1]}` : candidate;
}

// Sort cheapest-first (the mock returns options unsorted), default a missing
// serviceLevel, and cap to the top N for voice brevity. Returns both the trimmed
// list to speak and the full sorted list for logging.
export function normalizeQuoteOptions(rawOptions, { limit = 3 } = {}) {
  const sorted = [...rawOptions]
    .map((opt) => {
      const serviceLevelWasDefaulted = !opt.serviceLevel;
      return {
        carrierName: opt.carrierName || opt.carrierCode || 'Unknown carrier',
        rate: roundUsd(opt.rate),
        serviceLevel: opt.serviceLevel || 'STANDARD',
        serviceLevelWasDefaulted,
        transitDays: transitDaysLabel(opt.transitTime),
      };
    })
    .filter((opt) => typeof opt.rate === 'number')
    .sort((a, b) => a.rate - b.rate);

  return {
    cheapestOptions: sorted.slice(0, limit),
    totalOptions: sorted.length,
  };
}

export function humanizeDocType(type) {
  if (type === 'bol') return 'Bill of Lading';
  if (type === 'pod') return 'Proof of Delivery';
  return type;
}
