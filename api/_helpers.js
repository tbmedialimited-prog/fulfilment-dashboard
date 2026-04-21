const axios = require('axios');

// ─── Mintsoft ────────────────────────────────────────────────────────────────
function mintsoftClient() {
  return axios.create({
    baseURL: 'https://api.mintsoft.co.uk/api',
    headers: {
      'Ms-Apikey':     process.env.MINTSOFT_API_KEY,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    timeout: 20000,
  });
}

async function fetchMintsoftOrders(dateFrom, dateTo) {
  const client = mintsoftClient();

  // Mintsoft hard-caps at 100 orders per request with no server pagination.
  // Fix: split into 6-hour chunks (at 330 orders/day each chunk averages ~80).
  const CHUNK_MS = 6 * 60 * 60 * 1000;
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

  // Fetch in parallel batches of 10
  const CONCURRENCY = 10;
  const allOrders = [];
  const seen = new Set();

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
        const id = String(o.ID || o.Id || o.OrderId || o.OrderNumber || '');
        if (id && !seen.has(id)) { seen.add(id); allOrders.push(o); }
      }
    }
  }

  return allOrders;
}

// Fetch client name lookup table from Mintsoft
async function fetchMintsoftClients() {
  try {
    const client = mintsoftClient();
    const r = await client.get('/Client');
    const raw = Array.isArray(r.data) ? r.data : [];
    const map = {};
    for (const c of raw) {
      const id = c.ID || c.Id || c.ClientId;
      if (id) map[String(id)] = c.Name || c.ClientName || c.CompanyName || `Client ${id}`;
    }
    return map;
  } catch { return {}; }
}

// ─── Royal Mail ───────────────────────────────────────────────────────────────
async function getRmToken() { return null; }

// ─── Carrier helpers ──────────────────────────────────────────────────────────
function detectCarrier(name = '') {
  const n = name.toLowerCase();
  if (n.includes('dpd')) return 'DPD Local';
  if (n.includes('royal mail') || n.includes('royalmail') || n.startsWith('rm ')) return 'Royal Mail';
  return name || 'Other';
}

function deriveMintoftStatus(o) {
  const s = (o.OrderStatus || o.StatusName || o.Status || '').toLowerCase();
  if (s.includes('despatch') || s.includes('dispatch') || s.includes('shipped') || s.includes('sent')) return 'In transit';
  if (s.includes('deliver')) return 'Delivered';
  if (s.includes('cancel') || s.includes('return')) return 'Failed';
  if (o.DespatchDate || o.DespatchedDate || o.ShippedDate || o.DateDespatched || o.DateShipped) return 'In transit';
  return 'Processing';
}

function normaliseOrder(o, clientMap = {}) {
  const clientId = String(o.ClientId || o.ClientID || o.ClientID || '');
  return {
    id:         String(o.ID || o.Id || o.OrderId || ''),
    ref:        o.ClientOrderReference || o.OrderNumber || o.ExternalOrderReference || o.OrderReference || `ORD-${o.ID || o.Id}`,
    recipient: [o.FirstName, o.LastName].filter(Boolean).join(' ') || o.CustomerName || o.CompanyName || o.DeliveryName || 'Unknown',
    created:    o.OrderDate  || o.CreatedDate  || o.DateCreated  || null,
    despatched: o.DespatchDate || o.DespatchedDate || o.ShippedDate || o.DateDespatched || o.DateShipped || null,
    carrier:    detectCarrier(o.CourierName || o.ServiceName || o.ShippingMethod || o.Courier || ''),
    tracking:   o.TrackingNumber || o.CourierConsignmentNumber || o.ConsignmentNumber || o.TrackingRef || null,
    status:     deriveMintoftStatus(o),
    rawCarrier: o.CourierName || o.ServiceName || o.Courier || '',
    clientId,
    clientName: clientMap[clientId] || o.ClientName || o.CLIENT_CODE || clientId || 'Unknown',
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
    status: statusMap[o.tracking] ?? o.status,
  }));
}

// ─── DPD GeoPost Meta API ─────────────────────────────────────────────────────
async function fetchDpdStatuses(orders) {
  if (!orders.length) return {};
  const map = {};
  const BATCH = 100;
  const trackingNos = orders.map(o => o.tracking);

  for (let i = 0; i < trackingNos.length; i += BATCH) {
    const batch = trackingNos.slice(i, i + BATCH);
    try {
      const r = await axios.post(
        'https://api.dpdgroup.com/tracking/v2/parcels',
        { language: 'EN', parcelNumbers: batch },
        {
          headers: { 'apiKey': process.env.DPD_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
          timeout: 10000,
        }
      );
      for (const parcel of (Array.isArray(r.data) ? r.data : [])) {
        if (!parcel.parcelNumber) continue;
        const events = parcel.parcelEvents || [];
        if (!events.length) { map[parcel.parcelNumber] = 'In transit'; continue; }
        const latest = events[0];
        const family = (latest.statusFamilyLabel || '').toUpperCase();
        if (family === 'DELIVERED') map[parcel.parcelNumber] = 'Delivered';
        else if (family.includes('RETURN') || family.includes('EXCEPTION')) map[parcel.parcelNumber] = 'Failed';
        else map[parcel.parcelNumber] = 'In transit';
      }
    } catch { for (const t of batch) map[t] = 'In transit'; }
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

module.exports = { mintsoftClient, fetchMintsoftOrders, fetchMintsoftClients, getRmToken, detectCarrier, normaliseOrder, enrichOrders };
