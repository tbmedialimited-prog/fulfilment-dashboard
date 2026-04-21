const axios = require('axios');

// ─── Mintsoft ────────────────────────────────────────────────────────────────
// Auth: ms-apikey header (UUID key from /api/Auth endpoint)
// The key is static (24hr expiry by default, can be made permanent in Mintsoft settings)
function mintsoftClient() {
  return axios.create({
    baseURL: 'https://api.mintsoft.co.uk',
    headers: {
      'ms-apikey':     process.env.MINTSOFT_API_KEY,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    timeout: 15000,
  });
}

async function fetchMintsoftOrders(dateFrom, dateTo) {
  const client = mintsoftClient();
  const attempts = [
    { path: '/api/Order/List', params: { DateFrom: dateFrom, DateTo: dateTo, pageSize: 500 } },
    { path: '/api/Order',      params: { DateFrom: dateFrom, DateTo: dateTo, pageSize: 500 } },
    { path: '/api/Order',      params: { dateFrom, dateTo, pageSize: 500 } },
  ];

  let lastErr;
  for (const { path, params } of attempts) {
    try {
      const r = await client.get(path, { params });
      const raw = r.data?.Orders || r.data?.Result || r.data?.Data || r.data;
      return Array.isArray(raw) ? raw : [];
    } catch (err) {
      lastErr = err;
      if (![401, 403, 404, 405].includes(err.response?.status)) throw err;
    }
  }
  throw lastErr;
}

// ─── Royal Mail: no OAuth needed ─────────────────────────────────────────────
// RM Tracking API v2 authenticates via X-IBM-Client-Id and X-IBM-Client-Secret
// headers directly on each request — no token step required.
async function getRmToken() {
  return null; // not used — kept for health check compatibility
}

// ─── Carrier helpers ─────────────────────────────────────────────────────────
function detectCarrier(name = '') {
  const n = name.toLowerCase();
  if (n.includes('dpd'))                                                        return 'DPD Local';
  if (n.includes('royal mail') || n.includes('royalmail') || n.startsWith('rm ')) return 'Royal Mail';
  return name || 'Other';
}

function normaliseOrder(o) {
  return {
    id:         String(o.Id || o.OrderId || ''),
    ref:        o.ClientOrderReference || o.OrderNumber || o.ExternalOrderReference || o.OrderReference || `ORD-${o.Id}`,
    recipient: [o.FirstName, o.LastName].filter(Boolean).join(' ') || o.CompanyName || o.DeliveryName || o.Name || 'Unknown',
    created:    o.CreatedDate    || o.OrderDate     || o.DateCreated    || null,
    despatched: o.DespatchedDate || o.ShippedDate   || o.DateDespatched || o.DateShipped || null,
    carrier:    detectCarrier(o.CourierName || o.ServiceName || o.ShippingMethod || o.Courier || ''),
    tracking:   o.TrackingNumber || o.CourierConsignmentNumber || o.ConsignmentNumber || o.TrackingRef || null,
    status:     'Pending',
    rawCarrier: o.CourierName || o.ServiceName || o.Courier || '',
  };
}

async function enrichOrders(orders) {
  const dpdOrders = orders.filter(o => o.carrier === 'DPD Local' && o.tracking);
  const rmOrders  = orders.filter(o => o.carrier === 'Royal Mail' && o.tracking);

  const [dpdRes, rmRes] = await Promise.allSettled([
    fetchDpdStatuses(dpdOrders),
    fetchRmStatuses(rmOrders),
  ]);

  const statusMap = {};
  if (dpdRes.status === 'fulfilled') Object.assign(statusMap, dpdRes.value);
  if (rmRes.status  === 'fulfilled') Object.assign(statusMap, rmRes.value);

  return orders.map(o => ({
    ...o,
    status: statusMap[o.tracking] ?? (o.despatched ? 'In transit' : 'Processing'),
  }));
}

async function fetchDpdStatuses(orders) {
  if (!orders.length) return {};
  const map = {};
  const dpd = axios.create({
    baseURL: 'https://api.dpdlocal.co.uk',
    headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}`, Accept: 'application/json' },
    timeout: 8000,
  });
  await Promise.all(orders.map(async o => {
    try {
      const r = await dpd.get(`/shipping/shipment/${o.tracking}/trackingEvents`);
      const events = r.data?.data?.shipmentTrackingEvents || [];
      if (!events.length) { map[o.tracking] = 'In transit'; return; }
      const { eventCode = '', description = '' } = events[events.length - 1];
      if (eventCode.toUpperCase() === 'DEL' || description.toLowerCase().includes('delivered')) map[o.tracking] = 'Delivered';
      else if (eventCode.toUpperCase() === 'DEX' || description.toLowerCase().includes('failed')) map[o.tracking] = 'Failed';
      else map[o.tracking] = 'In transit';
    } catch { map[o.tracking] = 'In transit'; }
  }));
  return map;
}

async function fetchRmStatuses(orders) {
  if (!orders.length) return {};
  const map = {};
  // Royal Mail Tracking API v2: authenticate with X-IBM-Client-Id + X-IBM-Client-Secret headers
  // No OAuth2 token step — credentials go directly on each request
  await Promise.all(orders.map(async o => {
    try {
      const r = await axios.get(`https://api.royalmail.net/mailpieces/v2/${o.tracking}/events`, {
        headers: {
          'X-IBM-Client-Id':     process.env.RM_API_KEY,
          'X-IBM-Client-Secret': process.env.RM_API_SECRET,
          'X-Accept-RMG-Terms':  'yes',
          'Accept':              'application/json',
        },
        timeout: 8000,
      });
      const s = (r.data?.mailPieces?.[0]?.summary?.status || '').toUpperCase();
      if      (s.includes('DELIVERED'))                            map[o.tracking] = 'Delivered';
      else if (s.includes('FAILED') || s.includes('RETURN'))      map[o.tracking] = 'Failed';
      else if (s.includes('TRANSIT') || s.includes('DESPATCHED')) map[o.tracking] = 'In transit';
      else                                                          map[o.tracking] = 'Processing';
    } catch { map[o.tracking] = 'In transit'; }
  }));
  return map;
}

module.exports = { mintsoftClient, fetchMintsoftOrders, getRmToken, detectCarrier, normaliseOrder, enrichOrders };
