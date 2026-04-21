const axios = require('axios');
const { mintsoftClient, fetchMintsoftClients } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Test all possible pagination workarounds
  try {
    const weekAgo = new Date(now - 7*86400000);

    // 1. ClientId filter - does fetching per client give different orders?
    const clientR = await client.get('/Client');
    const allClients = Array.isArray(clientR.data) ? clientR.data : [];
    const testClients = allClients.slice(0, 5);
    const clientIds = new Set();
    for (const c of testClients) {
      const r = await client.get('/Order/List', { params: { DateFrom: weekAgo.toISOString(), DateTo: now.toISOString(), pageSize: 100, ClientId: c.ID || c.Id } });
      (Array.isArray(r.data) ? r.data : []).forEach(o => clientIds.add(o.ID));
    }
    const defaultR = await client.get('/Order/List', { params: { DateFrom: weekAgo.toISOString(), DateTo: now.toISOString(), pageSize: 100 } });
    const defaultIds = new Set((Array.isArray(defaultR.data) ? defaultR.data : []).map(o => o.ID));
    results.client_filter = {
      unique_across_5_clients: clientIds.size,
      default_count: defaultIds.size,
      works: clientIds.size > defaultIds.size
    };

    // 2. WarehouseId filter
    const whR = await client.get('/Warehouse').catch(() => ({ data: [] }));
    const warehouses = Array.isArray(whR.data) ? whR.data : [];
    results.warehouses_found = warehouses.length;
    if (warehouses.length > 0) {
      const wR = await client.get('/Order/List', { params: { DateFrom: weekAgo.toISOString(), DateTo: now.toISOString(), pageSize: 100, WarehouseId: warehouses[0].ID } });
      const wOrders = Array.isArray(wR.data) ? wR.data : [];
      results.warehouse_filter = { count: wOrders.length, different: wOrders[0]?.ID !== [...defaultIds][0] };
    }

    // 3. LastUpdated filter - try fetching orders updated in last hour, then last 2 hours etc
    const oneHourAgo = new Date(now - 3600000);
    const lR = await client.get('/Order/List', { params: { LastUpdatedFrom: oneHourAgo.toISOString(), pageSize: 100 } });
    const lOrders = Array.isArray(lR.data) ? lR.data : [];
    results.lastUpdated_filter = { count: lOrders.length, sample_id: lOrders[0]?.ID };

    // 4. AtNewDate filter (the AtNewDate field exists in responses)
    const anR = await client.get('/Order/List', { params: { AtNewDateFrom: weekAgo.toISOString(), AtNewDateTo: now.toISOString(), pageSize: 100 } });
    const anOrders = Array.isArray(anR.data) ? anR.data : [];
    results.atNewDate_filter = { count: anOrders.length, different: anOrders[0]?.ID !== [...defaultIds][0] };

  } catch(e) { results.workaround_tests = { error: e.message }; }

  // Test 6: Client list
  try {
    const clientMap = await fetchMintsoftClients();
    results.clients = { count: Object.keys(clientMap).length, sample: JSON.stringify(clientMap).slice(0, 200) };
  } catch(e) { results.clients = { error: e.message }; }

  // Test 7: DPD Local - login then track
  try {
    const loginR = await axios.get('https://myadmin.dpdlocal.co.uk/esgServer/user/?action=login', {
      auth: {
        username: `${process.env.DPD_USERNAME}/${process.env.DPD_ACCOUNT_NUMBER}`,
        password: process.env.DPD_PASSWORD,
      },
      headers: { Accept: 'application/json' },
      timeout: 8000,
    });
    const token = loginR.data?.data?.token;
    results.dpd_login = { ok: !!token, token: token ? token.slice(0,10)+'...' : null, response: JSON.stringify(loginR.data).slice(0,200) };

    if (token) {
      const trackR = await axios.get('https://myadmin.dpdlocal.co.uk/esgServer/shipping/shipment/15976968996843/trackingEvents', {
        headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
        timeout: 8000,
      });
      results.dpd_track = { ok: true, status: trackR.status, data: JSON.stringify(trackR.data).slice(0,300) };
    }
  } catch(e) {
    results.dpd_login = { ok: false, status: e.response?.status, body: JSON.stringify(e.response?.data||e.message).slice(0,300) };
  }

  results.dpd_env = {
    DPD_USERNAME:       process.env.DPD_USERNAME       ? 'set' : '✗ MISSING',
    DPD_PASSWORD:       process.env.DPD_PASSWORD       ? 'set' : '✗ MISSING',
    DPD_ACCOUNT_NUMBER: process.env.DPD_ACCOUNT_NUMBER || '✗ MISSING',
  };

  // Test 8: Royal Mail
  try {
    const r = await axios.get('https://api.royalmail.net/mailpieces/v2/IV746280456GB/events', {
      headers: { 'X-IBM-Client-Id': process.env.RM_API_KEY, 'X-IBM-Client-Secret': process.env.RM_API_SECRET, 'X-Accept-RMG-Terms': 'yes', Accept: 'application/json' },
      timeout: 8000,
    });
    results.royalMail = { ok: true, data: JSON.stringify(r.data).slice(0,300) };
  } catch(e) { results.royalMail = { ok: false, status: e.response?.status, body: JSON.stringify(e.response?.data||e.message).slice(0,300) }; }

  results.env = {
    MINTSOFT_API_KEY: process.env.MINTSOFT_API_KEY ? `set (${process.env.MINTSOFT_API_KEY.slice(0,6)}…)` : '✗ MISSING',
    DPD_API_KEY:      process.env.DPD_API_KEY      ? `set (${process.env.DPD_API_KEY.slice(0,6)}…)`      : '✗ MISSING',
    RM_API_KEY:       process.env.RM_API_KEY        ? `set (${process.env.RM_API_KEY.slice(0,6)}…)`        : '✗ MISSING',
    RM_API_SECRET:    process.env.RM_API_SECRET     ? 'set' : '✗ MISSING',
  };

  res.json(results);
};
