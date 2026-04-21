const axios = require('axios');
const { mintsoftClient, fetchMintsoftClients } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Prove whether 100 is a true cap or just today's order count
  try {
    // Fetch last 30 days - if there are genuinely >100 orders we should see cap behaviour
    const monthAgo = new Date(now - 30*86400000);

    // Test 1: Last 30 days default
    const r1 = await client.get('/Order/List', { params: { DateFrom: monthAgo.toISOString(), DateTo: now.toISOString(), pageSize: 100 } });
    const p1 = Array.isArray(r1.data) ? r1.data : [];
    const ids1 = p1.map(o=>o.ID);
    results.last_30_days = {
      count: p1.length,
      id_range: ids1.length ? `${Math.min(...ids1)}-${Math.max(...ids1)}` : 'empty',
      oldest_order_date: p1.length ? p1[p1.length-1]?.OrderDate : null,
      newest_order_date: p1.length ? p1[0]?.OrderDate : null,
    };

    // Test 2: Try pageSize=500 - if Mintsoft honours it, we get more than 100
    const r2 = await client.get('/Order/List', { params: { DateFrom: monthAgo.toISOString(), DateTo: now.toISOString(), pageSize: 500 } });
    const p2 = Array.isArray(r2.data) ? r2.data : [];
    results.pageSize_500 = { count: p2.length, more_than_100: p2.length > 100 };

    // Test 3: Just yesterday - should have ~330 orders if cap is real
    const yesterday = new Date(now - 86400000);
    const yesterdayStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    const yesterdayEnd = new Date(yesterdayStart.getTime() + 86400000);
    const r3 = await client.get('/Order/List', { params: { DateFrom: yesterdayStart.toISOString(), DateTo: yesterdayEnd.toISOString(), pageSize: 100 } });
    const p3 = Array.isArray(r3.data) ? r3.data : [];
    const ids3 = p3.map(o=>o.ID);
    results.yesterday_full_day = {
      count: p3.length,
      id_range: ids3.length ? `${Math.min(...ids3)}-${Math.max(...ids3)}` : 'empty',
      note: p3.length === 100 ? 'CAPPED AT 100 - confirm with pageSize=500 result' : `Only ${p3.length} orders yesterday - may be accurate`
    };

    // Test 4: pageSize=500 for yesterday
    const r4 = await client.get('/Order/List', { params: { DateFrom: yesterdayStart.toISOString(), DateTo: yesterdayEnd.toISOString(), pageSize: 500 } });
    const p4 = Array.isArray(r4.data) ? r4.data : [];
    results.yesterday_pageSize_500 = {
      count: p4.length,
      proves_cap: p4.length === p3.length ? 'YES - same count with pageSize=500, cap is real' : `NO - got ${p4.length} with 500 vs ${p3.length} with 100`
    };

  } catch(e) { results.cap_test = { error: e.message }; }

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
