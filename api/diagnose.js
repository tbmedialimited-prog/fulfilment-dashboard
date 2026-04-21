const axios = require('axios');
const { mintsoftClient } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};
  const client = mintsoftClient();
  const now = new Date().toISOString();
  const week = new Date(Date.now() - 7*86400000).toISOString();

  // Mintsoft — check how many orders come back for today only
  try {
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const r = await client.get('/Order/List', { params: { DateFrom: todayStart, DateTo: now, pageSize: 100 } });
    const raw = Array.isArray(r.data) ? r.data : [];
    results.mintsoft = {
      ok: true, status: r.status,
      today_count: raw.length,
      sample_order: raw[0] ? { keys: Object.keys(raw[0]).join(', '), OrderStatus: raw[0].OrderStatus, DespatchDate: raw[0].DespatchDate, CourierName: raw[0].CourierName, TrackingNumber: raw[0].TrackingNumber } : null,
    };
  } catch (err) {
    results.mintsoft = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0,300) };
  }

  // DPD GeoPost Meta API
  try {
    const r = await axios.post(
      'https://api.dpdgroup.com/tracking/v2/parcels',
      { language: 'EN', parcelNumbers: ['15976968996843'] },
      { headers: { 'apiKey': process.env.DPD_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 }
    );
    results.dpd = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0, 500) };
  } catch (err) {
    results.dpd = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 300) };
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
    RM_API_KEY:       process.env.RM_API_KEY        ? `set (${process.env.RM_API_KEY.slice(0,6)}…)`        : '✗ MISSING',
    RM_API_SECRET:    process.env.RM_API_SECRET     ? 'set' : '✗ MISSING',
  };

  res.json(results);
};
