const axios = require('axios');
const { mintsoftClient } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date().toISOString();
  const week = new Date(Date.now() - 7*86400000).toISOString();

  // Mintsoft POST /Order/Search
  try {
    const r = await client.post('/Order/Search', { OrderDateFrom: week, OrderDateTo: now, PageSize: 5, PageNumber: 1 });
    const raw = r.data?.Orders || r.data?.Result || r.data?.Data || r.data;
    results.mintsoft_search = {
      ok: true, status: r.status,
      top_level_keys: Object.keys(r.data || {}).join(', '),
      count: Array.isArray(raw) ? raw.length : 'not array',
      sample: JSON.stringify(raw).slice(0, 400),
    };
  } catch (err) {
    results.mintsoft_search = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0,300) };
  }

  // Mintsoft GET /Order/List fallback
  try {
    const r = await client.get('/Order/List', { params: { DateFrom: week, DateTo: now, pageSize: 5 } });
    const raw = r.data?.Orders || r.data?.Result || r.data?.Data || r.data;
    results.mintsoft_list = {
      ok: true, status: r.status,
      top_level_keys: Object.keys(r.data || {}).join(', '),
      count: Array.isArray(raw) ? raw.length : 'not array',
    };
  } catch (err) {
    results.mintsoft_list = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0,200) };
  }

  // DPD
  try {
    const r = await axios.get('https://myadmin.dpdlocal.co.uk/esgServer/shipping/shipment/15976968996843/trackingEvents', {
      headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}`, Accept: 'application/json' },
      timeout: 8000,
    });
    results.dpd = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0,300) };
  } catch (err) {
    results.dpd = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0,300) };
  }

  // Royal Mail
  try {
    const r = await axios.get('https://api.royalmail.net/mailpieces/v2/IV746280456GB/events', {
      headers: { 'X-IBM-Client-Id': process.env.RM_API_KEY, 'X-IBM-Client-Secret': process.env.RM_API_SECRET, 'X-Accept-RMG-Terms': 'yes', Accept: 'application/json' },
      timeout: 8000,
    });
    results.royalMail = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0,300) };
  } catch (err) {
    results.royalMail = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0,300) };
  }

  results.env = {
    MINTSOFT_API_KEY: process.env.MINTSOFT_API_KEY ? `set (${process.env.MINTSOFT_API_KEY.slice(0,6)}…)` : '✗ MISSING',
    DPD_API_KEY:      process.env.DPD_API_KEY      ? `set (${process.env.DPD_API_KEY.slice(0,6)}…)`      : '✗ MISSING',
    DPD_USERNAME:     process.env.DPD_USERNAME      ? 'set' : '✗ MISSING',
    DPD_PASSWORD:     process.env.DPD_PASSWORD      ? 'set' : '✗ MISSING',
    RM_API_KEY:       process.env.RM_API_KEY        ? `set (${process.env.RM_API_KEY.slice(0,6)}…)`        : '✗ MISSING',
    RM_API_SECRET:    process.env.RM_API_SECRET     ? 'set' : '✗ MISSING',
  };

  res.json(results);
};
