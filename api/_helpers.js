const axios = require('axios');

// ─── Mintsoft ────────────────────────────────────────────────────────────────
// Confirmed field names from API: ClientId, OrderStatusId, DespatchDate,
// TrackingNumber, CourierServiceName, CourierServiceId, OrderNumber, ID
// Hard cap: 100 orders per request. Fix: 6-hour time chunks.

function mintsoftClient() {
  return axios.create({
    baseURL: 'https://api.mintsoft.co.uk/api',
    headers: {
      'Ms-Apikey':    process.env.MINTSOFT_API_KEY,
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

// Mintsoft order status IDs (from GET /api/Order/Statuses)
// Common: 1=NEW, 2=PRINTED, 3=PICKED, 4=PACKED, 5=DESPATCHED, 6=CANCELLED
// We map by DespatchDate as the most reliable signal
function deriveMintoftStatus(o) {
  const sid = o.OrderStatusId;
  if (sid === 5 || sid === 6  || (o.DespatchDate && sid > 2)) return 'In transit';
  if (sid === 7 || sid === 8)  return 'Delivered';
  if (sid === 9 || sid === 10) return 'Failed';
  if (o.DespatchDate)          return 'In transit';
  if (sid <= 2)                return 'Processing';
  return 'Processing';
}

function detectCarrier(name = '') {
  const n = name.toLowerCase();
  if (n.includes('dpd'))                                                          return 'DPD Local';
  if (n.includes('royal mail') || n.includes('royalmail') || n.startsWith('rm ')) return 'Royal Mail';
  return name || 'Other';
}

function normaliseOrder(o, clientMap = {}) {
  const clientId = String(o.ClientId || '');
  return {
    id:         String(o.ID || ''),
    ref:        o.OrderNumber || o.ExternalOrderReference || `ORD-${o.ID}`,
    recipient: [o.FirstName, o.LastName].filter(Boolean).join(' ') || o.CompanyName || 'Unknown',
    created:    o.OrderDate   || null,
    despatched: o.DespatchDate || null,
    carrier:    detectCarrier(o.CourierServiceName || ''),
    tracking:   o.TrackingNumber || null,
    trackingUrl: o.TrackingURL || null,
    status:     deriveMintoftStatus(o),
    rawCarrier: o.CourierServiceName || '',
    clientId,
    clientName: clientMap[clientId] || o.CLIENT_CODE || `Client ${clientId}`,
    orderStatusId: o.OrderStatusId,
  };
}

async function fetchMintsoftOrders(dateFrom, dateTo) {
  const client = mintsoftClient();
  const CHUNK_MS = 6 * 60 * 60 * 1000; // 6-hour chunks

  const chunks = [];
  let cursor = new Date(dateFrom);
  const end = new Date(dateTo);
  while (cursor < end) {
    chunks.push({
      from: cursor.toISOString(),
      to:   new Date(Math.min(cursor.getTime() + CHUNK_MS, end.getTime())).toISOString(),
    });
    cursor = new Date(cursor.getTime() + CHUNK_MS);
  }

  const allOrders = [];
  const seen = new Set();
  const CONCURRENCY = 10;

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ from, to }) => {
      try {
        const r = await client.get('/Order/List', {
          params: { DateFrom: from, DateTo: to, pageSize: 100 },
        });
        return Array.isArray(r.data) ? r.data : [];
      } catch { return []; }
    }));
    for (const page of results) {
      for (const o of page) {
        const id = String(o.ID || o.OrderNumber || '');
        if (id && !seen.has(id)) { seen.add(id); allOrders.push(o); }
      }
    }
  }

  return allOrders;
}

async function fetchMintsoftClients() {
  try {
    const r = await mintsoftClient().get('/Client');
    const raw = Array.isArray(r.data) ? r.data : [];
    const map = {};
    for (const c of raw) {
      const id = String(c.ID || c.Id || c.ClientId || '');
      if (id) map[id] = c.Name || c.ClientName || c.CompanyName || id;
    }
    return map;
  } catch { return {}; }
}

// ─── Enrich with carrier tracking ────────────────────────────────────────────
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
    status: statusMap[o.tracking] ?? o.status,
  }));
}

// ─── DPD Local tracking ──────────────────────────────────────────────────────
// DPD Local uses username/password login to get a session token, then
// uses that token to query tracking events per shipment.
// Credentials: DPD_USERNAME (email), DPD_PASSWORD, DPD_ACCOUNT_NUMBER

let _dpdToken = null;
let _dpdTokenExpiry = null;

async function getDpdToken() {
  if (_dpdToken && _dpdTokenExpiry && Date.now() < _dpdTokenExpiry) return _dpdToken;
  const r = await axios.get('https://api.dpdlocal.co.uk/user/?action=login', {
    auth: {
      username: `${process.env.DPD_USERNAME}/${process.env.DPD_ACCOUNT_NUMBER}`,
      password: process.env.DPD_PASSWORD,
    },
    headers: { Accept: 'application/json' },
    timeout: 8000,
  });
  const token = r.data?.data?.token;
  if (!token) throw new Error('DPD login failed');
  _dpdToken = token;
  _dpdTokenExpiry = Date.now() + 55 * 60 * 1000;
  return token;
}

async function fetchDpdStatuses(orders) {
  if (!orders.length) return {};
  const map = {};
  try {
    const token = await getDpdToken();
    await Promise.all(orders.map(async o => {
      try {
        const r = await axios.get(
          `https://api.dpdlocal.co.uk/shipping/shipment/${o.tracking}/trackingEvents`,
          { headers: { Authorization: `Basic ${token}`, Accept: 'application/json' }, timeout: 8000 }
        );
        const events = r.data?.data?.shipmentTrackingEvents || [];
        if (!events.length) { map[o.tracking] = 'In transit'; return; }
        const latest = events[events.length - 1];
        const code = (latest.eventCode || '').toUpperCase();
        const desc = (latest.description || '').toLowerCase();
        if (code === 'DEL' || desc.includes('delivered')) map[o.tracking] = 'Delivered';
        else if (code === 'DEX' || desc.includes('failed')) map[o.tracking] = 'Failed';
        else map[o.tracking] = 'In transit';
      } catch { map[o.tracking] = 'In transit'; }
    }));
  } catch (err) {
    console.warn('[DPD] auth failed:', err.message);
    for (const o of orders) map[o.tracking] = 'In transit';
  }
  return map;
}

// ─── Royal Mail ───────────────────────────────────────────────────────────────
async function fetchRmStatuses(orders) {
  if (!orders.length) return {};
  const map = {};
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

async function getRmToken() { return null; }

module.exports = { mintsoftClient, fetchMintsoftOrders, fetchMintsoftClients, getRmToken, normaliseOrder, enrichOrders };
