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

  // Try large pageSize first — if Mintsoft supports it we get everything in one call.
  // Mintsoft max pageSize appears to be 100; pagination uses "page" or "pageNumber".
  // We deduplicate by order ID as a safety net against any repeated pages.
  const PAGE_SIZE = 100;
  const seen = new Set();
  const allOrders = [];
  let page = 1;
  let workingPath = null;
  const candidatePaths = ['/api/Order/List', '/api/Order'];

  for (;;) {
    let data = null;
    let lastErr;
    const paths = workingPath ? [workingPath] : candidatePaths;

    for (const path of paths) {
      try {
        const r = await client.get(path, {
          params: {
            DateFrom: dateFrom,
            DateTo: dateTo,
            pageSize: PAGE_SIZE,
            page,            // Mintsoft uses "page"
          },
        });
        data = r.data;
        workingPath = path;
        break;
      } catch (err) {
        lastErr = err;
        if (![404, 405].includes(err.response?.status)) throw err;
      }
    }

    if (!data) throw lastErr;

    const raw = data?.Orders || data?.Result || data?.Data || data;
    const pageOrders = Array.isArray(raw) ? raw : [];

    let newThisPage = 0;
    for (const o of pageOrders) {
      const id = String(o.Id || o.OrderId || o.OrderNumber || JSON.stringify(o).slice(0, 40));
      if (!seen.has(id)) {
        seen.add(id);
        allOrders.push(o);
        newThisPage++;
      }
    }

    // Stop conditions:
    // 1. Fewer results than a full page = last page
    // 2. No new unique orders this page = pagination not supported, already have everything
    // 3. Safety cap
    if (pageOrders.length < PAGE_SIZE || newThisPage === 0 || page >= 20) break;
    page++;
  }

  return allOrders;
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

function deriveMintoftStatus(o) {
  // Use Mintsoft order status codes where available
  const s = (o.StatusName || o.Status || o.OrderStatus || '').toLowerCase();
  if (s.includes('despatch') || s.includes('dispatch') || s.includes('shipped') || s.includes('sent')) return 'In transit';
  if (s.includes('deliver')) return 'Delivered';
  if (s.includes('cancel')) return 'Failed';
  if (s.includes('return')) return 'Failed';
  // Fall back to dates
  if (o.DespatchDate || o.DespatchedDate || o.ShippedDate || o.DateDespatched || o.DateShipped) return 'In transit';
  if (o.RequiredDespatchDate || o.AtNewDate) return 'Processing';
  return 'Pending';
}

function normaliseOrder(o) {
  return {
    id:         String(o.Id || o.OrderId || ''),
    ref:        o.ClientOrderReference || o.OrderNumber || o.ExternalOrderReference || o.OrderReference || `ORD-${o.Id}`,
    recipient: [o.FirstName, o.LastName].filter(Boolean).join(' ') || o.CompanyName || o.DeliveryName || o.Name || 'Unknown',
    created:    o.CreatedDate    || o.OrderDate     || o.DateCreated    || null,
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
