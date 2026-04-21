const axios = require('axios');
const { mintsoftClient } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = {};

  // Mintsoft
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

  // Royal Mail — direct header auth, no OAuth
  try {
    const r = await axios.get('https://api.royalmail.net/mailpieces/v2/TEST123456GB/events', {
      headers: {
        'X-IBM-Client-Id':     process.env.RM_API_KEY,
        'X-IBM-Client-Secret': process.env.RM_API_SECRET,
        'X-Accept-RMG-Terms':  'yes',
        'Accept':              'application/json',
      },
      timeout: 8000,
    });
    results.royalMail = { ok: true, status: r.status };
  } catch (err) {
    const s = err.response?.status;
    // 404/400 = auth worked, tracking number just not found
    results.royalMail = {
      ok: [404, 400].includes(s),
      status: s,
      body: JSON.stringify(err.response?.data || err.message).slice(0, 300),
    };
  }

  // Env vars
  results.env = {
    MINTSOFT_API_KEY: process.env.MINTSOFT_API_KEY ? `set (${process.env.MINTSOFT_API_KEY.slice(0,6)}…)` : '✗ MISSING',
    DPD_API_KEY:      process.env.DPD_API_KEY      ? `set (${process.env.DPD_API_KEY.slice(0,6)}…)`      : '✗ MISSING',
    RM_API_KEY:       process.env.RM_API_KEY        ? `set (${process.env.RM_API_KEY.slice(0,6)}…)`        : '✗ MISSING',
    RM_API_SECRET:    process.env.RM_API_SECRET     ? 'set'                                                  : '✗ MISSING',
    RM_CLIENT_ID:     process.env.RM_CLIENT_ID      ? `set (${process.env.RM_CLIENT_ID.slice(0,6)}…)`      : '✗ MISSING (not needed for tracking)',
    RM_CLIENT_SECRET: process.env.RM_CLIENT_SECRET  ? 'set'                                                  : '✗ MISSING (not needed for tracking)',
  };

  res.json(results);
};
