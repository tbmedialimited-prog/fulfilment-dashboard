const axios = require('axios');
const { mintsoftClient, fetchMintsoftClients } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Test SortOldestFirst pagination - confirmed by Mintsoft support
  try {
    const weekAgo = new Date(now - 7*86400000);

    // Page 1 - oldest 100
    const r1 = await client.get('/Order/List', {
      params: { DateFrom: weekAgo.toISOString(), ToDate: now.toISOString(), pageSize: 100, SortOldestFirst: true }
    });
    const p1 = Array.isArray(r1.data) ? r1.data : [];
    const ids1 = p1.map(o=>o.ID);
    const latestDate1 = p1.reduce((max,o) => o.OrderDate > max ? o.OrderDate : max, '');
    results.page1_oldest = {
      count: p1.length,
      id_range: ids1.length ? `${Math.min(...ids1)}-${Math.max(...ids1)}` : 'empty',
      latest_date: latestDate1
    };

    // Page 2 - advance window past latest date from page 1
    if(latestDate1) {
      const nextStart = new Date(new Date(latestDate1).getTime()+1).toISOString();
      const r2 = await client.get('/Order/List', {
        params: { DateFrom: nextStart, ToDate: now.toISOString(), pageSize: 100, SortOldestFirst: true }
      });
      const p2 = Array.isArray(r2.data) ? r2.data : [];
      const ids2 = p2.map(o=>o.ID);
      results.page2_oldest = {
        count: p2.length,
        id_range: ids2.length ? `${Math.min(...ids2)}-${Math.max(...ids2)}` : 'empty',
        different_from_page1: !ids1.includes(ids2[0])
      };
      results.pagination_works = p2.length > 0 && !ids1.includes(p2[0]?.ID);
    }

  } catch(e) { results.sort_oldest_test = { error: e.message }; }

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
