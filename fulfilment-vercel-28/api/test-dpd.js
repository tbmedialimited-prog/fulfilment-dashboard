const axios = require('axios');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const tracking = req.query.t || '15976968996843';
  const results = {};

  // The esgServer prefix tells us the real base is myadmin.dpdlocal.co.uk/esgServer
  const bases = [
    'https://myadmin.dpdlocal.co.uk/esgServer',
    'https://api.dpdlocal.co.uk/esgServer',
  ];

  for (const base of bases) {
    // Test login first
    try {
      const loginResp = await axios.get(`${base}/user/?action=login`, {
        auth: {
          username: `${process.env.DPD_USERNAME}/${process.env.DPD_ACCOUNT_NUMBER}`,
          password: process.env.DPD_PASSWORD,
        },
        headers: { Accept: 'application/json' },
        timeout: 8000,
      });
      const token = loginResp.data?.data?.token;
      results[`login_${base}`] = { ok: !!token, token: token ? token.slice(0,10)+'…' : null, response: JSON.stringify(loginResp.data).slice(0, 300) };

      if (token) {
        // Try tracking with session token
        try {
          const r = await axios.get(`${base}/shipping/shipment/${tracking}/trackingEvents`, {
            headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
            timeout: 8000,
          });
          results[`track_${base}`] = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0, 500) };
        } catch (e) {
          results[`track_${base}`] = { ok: false, status: e.response?.status, body: JSON.stringify(e.response?.data || e.message).slice(0, 300) };
        }
      }
    } catch (err) {
      results[`login_${base}`] = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 300) };
    }
  }

  // Also try the Bearer API key directly on esgServer
  try {
    const r = await axios.get(`https://myadmin.dpdlocal.co.uk/esgServer/shipping/shipment/${tracking}/trackingEvents`, {
      headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}`, Accept: 'application/json' },
      timeout: 8000,
    });
    results.bearer_esgServer = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0, 500) };
  } catch (err) {
    results.bearer_esgServer = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 300) };
  }

  results.env = {
    DPD_API_KEY:        process.env.DPD_API_KEY        ? `set (${process.env.DPD_API_KEY.slice(0,6)}…)` : '✗ MISSING',
    DPD_USERNAME:       process.env.DPD_USERNAME        ? `set` : '✗ MISSING',
    DPD_PASSWORD:       process.env.DPD_PASSWORD        ? 'set' : '✗ MISSING',
    DPD_ACCOUNT_NUMBER: process.env.DPD_ACCOUNT_NUMBER  || '✗ MISSING',
  };

  res.json(results);
};
