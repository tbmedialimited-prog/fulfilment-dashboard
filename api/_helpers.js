const axios = require('axios');

// ─── Mintsoft ────────────────────────────────────────────────────────────────
// Auth: Ms-Apikey header. Base: https://api.mintsoft.co.uk/api
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
  const PAGE_SIZE = 100;
  const allOrders = [];
  const seen = new Set();

  // Use POST /Order/Search with pagination — the correct Mintsoft endpoint
  // Falls back to GET /Order/List if search fails
  let useSearch = true;

  for (let page = 1; page <= 20; page++) {
    let pageOrders = [];

    if (useSearch) {
      try {
        const r = await client.post('/Order/Search', {
          OrderDateFrom: dateFrom,
          OrderDateTo:   dateTo,
          PageSize:      PAGE_SIZE,
          PageNumber:    page,
        });
        const raw = r.data?.Orders || r.data?.Result || r.data?.Data || r.data;
        pageOrders = Array.isArray(raw) ? raw : [];
      } catch (err) {
        // Search failed — fall back to GET
        useSearch = false;
      }
    }

    if (!useSearch) {
      try {
        const r = await client.get('/Order/List', {
          params: {
            DateFrom: dateFrom,
            DateTo:   dateTo,
            pageSize: PAGE_SIZE,
            page,
          },
        });
        const raw = r.data?.Orders || r.data?.Result || r.data?.Data || r.data;
        pageOrders = Array.isArray(raw) ? raw : [];
      } catch { break; }
    }

    let newCount = 0;
    for (const o of pageOrders) {
      const id = String(o.ID || o.Id || o.OrderId || o.OrderNumber || '');
      if (!seen.has(id)) {
        seen.add(id);
        allOrders.push(o);
        newCount++;
      }
    }

    // Stop: last page, no new orders, or cap reached
    if (pageOrders.length < PAGE_SIZE || newCount === 0 || allOrders.length >= 2000) break;
  }

  return allOrders;
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

function normaliseOrder(o) {
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

async function fetchDpdStatuses(orders) {
  if (!orders.length) return {};
  const map = {};
  const dpd = axios.create({
    baseURL: 'https://myadmin.dpdlocal.co.uk/esgServer',
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
