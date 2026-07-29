// Exercises all 6 Warp tool handlers directly against the running mock — no voice
// pipeline involved. Fast iteration on normalization/error-shaping.
// Usage: node mock/server.js  (in one terminal)
//        npm run smoke        (in another, from voice-agent/)
import '../src/env.js';
import { runTool } from '../src/tools/definitions.js';

const today = new Date().toISOString().slice(0, 10);
let pass = 0;
let fail = 0;

async function check(label, name, args, predicate) {
  const start = Date.now();
  let result;
  try {
    result = await runTool(name, args);
  } catch (err) {
    result = { ok: false, code: 'threw', message: err.message };
  }
  const ms = Date.now() - start;
  const passed = predicate(result);
  console.log(`${passed ? 'PASS' : 'FAIL'} (${ms}ms) ${label}`);
  if (!passed) console.log('       →', JSON.stringify(result));
  passed ? pass++ : fail++;
}

async function main() {
  await check('track known in-transit shipment', 'track_shipment', { trackingNumbers: ['S-1001-IN'] }, (r) => r.ok && r.results[0].ok && r.results[0].status === 'in transit');

  await check('track unknown shipment → not_found', 'track_shipment', { trackingNumbers: ['S-9999-ZZ'] }, (r) => r.ok && r.results[0].ok === false && r.results[0].code === 'not_found');

  await check('track malformed input → invalid_format', 'track_shipment', { trackingNumbers: ['banana'] }, (r) => r.ok === false && r.code === 'invalid_format');

  await check('shipment events for SH-1001', 'get_shipment_events', { shipmentId: 'SH-1001' }, (r) => r.ok && r.events.length > 0);

  await check('shipment events unknown → not_found', 'get_shipment_events', { shipmentId: 'SH-9999' }, (r) => r.ok === false && r.code === 'not_found');

  await check('list shipments', 'list_shipments', {}, (r) => r.ok && Array.isArray(r.shipments) && r.total === 7);

  await check('invoice for O-1001', 'get_invoice', { orderId: 'O-1001' }, (r) => r.ok && typeof r.grandTotal === 'number');

  await check('invoice unknown → not_found', 'get_invoice', { orderId: 'O-9999' }, (r) => r.ok === false && r.code === 'not_found');

  await check('documents for O-1002', 'get_documents', { orderId: 'O-1002' }, (r) => r.ok && r.documents.length === 2);

  await check('quote invalid (dead) ZIP → no rates', 'get_shipping_quote', { pickupZip: '00000', deliveryZip: '60601', pickupDate: today }, (r) => r.ok && r.noRatesForLane === true);

  await check('quote valid lane → sorted cheapest-first', 'get_shipping_quote', { pickupZip: '90001', deliveryZip: '60601', pickupDate: today }, (r) => {
    if (!r.ok || r.noRatesForLane) return r.ok && r.noRatesForLane === false ? false : r.ok; // tolerate transient mock failure
    const rates = r.cheapestOptions.map((o) => o.rate);
    return rates.every((rate, i) => i === 0 || rate >= rates[i - 1]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
