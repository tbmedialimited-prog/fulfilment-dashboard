const axios = require('axios');
const { mintsoftClient, getRmToken } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};

  // Mintsoft — try multiple endpoints
  for (const path of ['/api/Order/List', '/api/Order', '/api/Client']) {
    try {
      const r = await mintsoftClient().get(path, { params: { pageSize: 1 }, timeout: 8000 });
      results.mintsoft = { ok: true, endpoint: path, status: r.status, sample: JSON.stringify(r.data).slice(0, 300) };
      break;
    } catch (err) {
      results[`mintsoft${path.replace(/\//g,'_')}`] = {
        ok: false, status: err.response?.status,
        body: JSON.stringify(err.response?.data || err.message).slice(0, 200),
      };
    }
  }

  // DPD Local
  try {
    const r = await axios.get('https://api.dpdlocal.co.uk/user/', {
      headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}` }, timeout: 8000,
    });
    results.dpd = { ok: true, status: r.status };
  } catch (err) {
    results.dpd = { ok: err.response?.status !== 401, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 200) };
  }

  // Royal Mail
  try {
    await getRmToken();
    results.royalMail = { ok: true };
  } catch (err) {
    results.royalMail = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 300) };
  }

  // Env vars (masked)
  results.env = {
    MINTSOFT_API_KEY: process.env.MINTSOFT_API_KEY ? `set (${process.env.MINTSOFT_API_KEY.slice(0,6)}…)` : '✗ MISSING',
    DPD_API_KEY:      process.env.DPD_API_KEY      ? `set (${process.env.DPD_API_KEY.slice(0,6)}…)`      : '✗ MISSING',
    RM_API_KEY:       process.env.RM_API_KEY        ? `set (${process.env.RM_API_KEY.slice(0,6)}…)`        : '✗ MISSING',
    RM_CLIENT_ID:     process.env.RM_CLIENT_ID      ? `set (${process.env.RM_CLIENT_ID.slice(0,6)}…)`      : '✗ MISSING',
    RM_CLIENT_SECRET: process.env.RM_CLIENT_SECRET  ? 'set'                                                  : '✗ MISSING',
  };

  res.json(results);
};
