const axios = require('axios');
const { mintsoftClient, fetchMintsoftClients } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Test pagination approaches
  try {
    // 1. Default - newest 100
    const r1 = await client.get('/Order/List', { params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100 } });
    const page1 = Array.isArray(r1.data) ? r1.data : [];
    const ids1 = page1.map(o=>o.ID);
    results.page1 = { count: page1.length, id_range: `${Math.min(...ids1)} - ${Math.max(...ids1)}` };

    // 2. Try SortOrder=ASC to get oldest first
    const r2 = await client.get('/Order/List', { params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100, SortOrder: 'ASC' } });
    const page2 = Array.isArray(r2.data) ? r2.data : [];
    const ids2 = page2.map(o=>o.ID);
    results.sort_asc = { count: page2.length, id_range: `${Math.min(...ids2)} - ${Math.max(...ids2)}`, different_from_page1: page2[0]?.ID !== page1[0]?.ID };

    // 3. Try OrderStatusId filter - get all despatched orders (status 5)
    const r3 = await client.get('/Order/List', { params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100, OrderStatusId: 5 } });
    const page3 = Array.isArray(r3.data) ? r3.data : [];
    results.status_5_despatched = { count: page3.length };

    // 4. Try OrderStatusId=1 (new orders)
    const r4 = await client.get('/Order/List', { params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100, OrderStatusId: 1 } });
    const page4 = Array.isArray(r4.data) ? r4.data : [];
    results.status_1_new = { count: page4.length };

    // 5. Try a week with SortOrder ASC  
    const weekAgo = new Date(now - 7*86400000);
    const r5 = await client.get('/Order/List', { params: { DateFrom: weekAgo.toISOString(), DateTo: now.toISOString(), pageSize: 100, SortOrder: 'ASC' } });
    const page5 = Array.isArray(r5.data) ? r5.data : [];
    const ids5 = page5.map(o=>o.ID);
    results.week_sort_asc = { count: page5.length, id_range: ids5.length ? `${Math.min(...ids5)} - ${Math.max(...ids5)}` : 'empty' };

    // Are ASC and DESC returning different orders for the week?
    const r6 = await client.get('/Order/List', { params: { DateFrom: weekAgo.toISOString(), DateTo: now.toISOString(), pageSize: 100 } });
    const page6 = Array.isArray(r6.data) ? r6.data : [];
    const ids6 = page6.map(o=>o.ID);
    results.week_default = { count: page6.length, id_range: ids6.length ? `${Math.min(...ids6)} - ${Math.max(...ids6)}` : 'empty' };
    results.asc_gives_different_orders = page5[0]?.ID !== page6[0]?.ID;

  } catch(e) { results.pagination_tests = { error: e.message }; }

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
