const axios = require('axios');
const { mintsoftClient, fetchMintsoftClients } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Test 1: Full day in one request (proves 100 cap)
  try {
    const r = await client.get('/Order/List', {
      params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100 }
    });
    results.today_single_request = { count: Array.isArray(r.data) ? r.data.length : 0 };
  } catch(e) { results.today_single_request = { error: e.message }; }

  // Test 2: First 6 hours of today
  const chunk1End = new Date(todayStart.getTime() + 6*3600000);
  try {
    const r = await client.get('/Order/List', {
      params: { DateFrom: todayStart.toISOString(), DateTo: chunk1End.toISOString(), pageSize: 100 }
    });
    results.today_chunk1_0to6am = { count: Array.isArray(r.data) ? r.data.length : 0 };
  } catch(e) { results.today_chunk1_0to6am = { error: e.message }; }

  // Test 3: Second 6 hours of today
  try {
    const r = await client.get('/Order/List', {
      params: { DateFrom: chunk1End.toISOString(), DateTo: new Date(todayStart.getTime() + 12*3600000).toISOString(), pageSize: 100 }
    });
    results.today_chunk2_6to12pm = { count: Array.isArray(r.data) ? r.data.length : 0 };
  } catch(e) { results.today_chunk2_6to12pm = { error: e.message }; }

  // Test 4: Third 6 hours
  try {
    const r = await client.get('/Order/List', {
      params: { DateFrom: new Date(todayStart.getTime() + 12*3600000).toISOString(), DateTo: new Date(todayStart.getTime() + 18*3600000).toISOString(), pageSize: 100 }
    });
    results.today_chunk3_12to6pm = { count: Array.isArray(r.data) ? r.data.length : 0 };
  } catch(e) { results.today_chunk3_12to6pm = { error: e.message }; }

  // Test 5: Fourth 6 hours
  try {
    const r = await client.get('/Order/List', {
      params: { DateFrom: new Date(todayStart.getTime() + 18*3600000).toISOString(), DateTo: now.toISOString(), pageSize: 100 }
    });
    results.today_chunk4_6pmtonow = { count: Array.isArray(r.data) ? r.data.length : 0 };
  } catch(e) { results.today_chunk4_6pmtonow = { error: e.message }; }

  const chunkTotal = (results.today_chunk1_0to6am?.count||0) +
                     (results.today_chunk2_6to12pm?.count||0) +
                     (results.today_chunk3_12to6pm?.count||0) +
                     (results.today_chunk4_6pmtonow?.count||0);
  results.today_chunk_total = chunkTotal;
  results.pagination_working = chunkTotal > (results.today_single_request?.count || 100);

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
