const axios = require('axios');
const { mintsoftClient, fetchMintsoftClients } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Test 1: Page 1 (newest 100 orders today)
  try {
    const r1 = await client.get('/Order/List', {
      params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100 }
    });
    const page1 = Array.isArray(r1.data) ? r1.data : [];
    const lowestId = page1.reduce((min,o)=>Math.min(min,o.ID||Infinity),Infinity);
    results.page1 = { count: page1.length, lowest_id: lowestId, highest_id: page1[0]?.ID };

    // Test MaxId param - fetch page 2 using lowest ID from page 1
    if(lowestId < Infinity) {
      try {
        const r2 = await client.get('/Order/List', {
          params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100, MaxId: lowestId - 1 }
        });
        const page2 = Array.isArray(r2.data) ? r2.data : [];
        results.page2_with_MaxId = { count: page2.length, lowest_id: page2.reduce((m,o)=>Math.min(m,o.ID||Infinity),Infinity), highest_id: page2[0]?.ID };
        results.MaxId_pagination_works = page2.length > 0 && (page2[0]?.ID||0) < lowestId;
      } catch(e) { results.page2_with_MaxId = { error: e.message }; }

      // Also test with lowercase maxId
      try {
        const r3 = await client.get('/Order/List', {
          params: { DateFrom: todayStart.toISOString(), DateTo: now.toISOString(), pageSize: 100, maxId: lowestId - 1 }
        });
        const page3 = Array.isArray(r3.data) ? r3.data : [];
        results.page2_with_lowercase_maxId = { count: page3.length, highest_id: page3[0]?.ID };
      } catch(e) { results.page2_with_lowercase_maxId = { error: e.message }; }
    }
  } catch(e) { results.page1 = { error: e.message }; }

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
