const axios = require('axios');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const tracking = req.query.t || '15976968996843';

  const results = {};

  // Test 1: Bearer token on tracking endpoint
  try {
    const r = await axios.get(
      `https://api.dpdlocal.co.uk/shipping/shipment/${tracking}/trackingEvents`,
      { headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}`, Accept: 'application/json' }, timeout: 8000 }
    );
    results.bearer_tracking = { ok: true, status: r.status, data: r.data };
  } catch (err) {
    results.bearer_tracking = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 400) };
  }

  // Test 2: Bearer token on parcel endpoint (alternative)
  try {
    const r = await axios.get(
      `https://api.dpdlocal.co.uk/shipping/parcel/${tracking}/trackingEvents`,
      { headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}`, Accept: 'application/json' }, timeout: 8000 }
    );
    results.bearer_parcel = { ok: true, status: r.status, data: r.data };
  } catch (err) {
    results.bearer_parcel = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 400) };
  }

  // Test 3: Login first with username/password, then track
  try {
    const loginResp = await axios.get('https://api.dpdlocal.co.uk/user/?action=login', {
      auth: {
        username: `${process.env.DPD_USERNAME}/${process.env.DPD_ACCOUNT_NUMBER}`,
        password: process.env.DPD_PASSWORD,
      },
      headers: { Accept: 'application/json' },
      timeout: 8000,
    });
    const token = loginResp.data?.data?.token;
    results.login_token = { ok: !!token, token: token ? token.slice(0,10)+'…' : null, full_response: JSON.stringify(loginResp.data).slice(0,200) };

    if (token) {
      const r = await axios.get(
        `https://api.dpdlocal.co.uk/shipping/shipment/${tracking}/trackingEvents`,
        { headers: { Authorization: `Basic ${token}`, Accept: 'application/json' }, timeout: 8000 }
      );
      results.login_then_track = { ok: true, status: r.status, data: r.data };
    }
  } catch (err) {
    results.login_then_track = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 400) };
  }

  // Test 4: Try the public DPD tracking page API
  try {
    const r = await axios.get(
      `https://track.dpdlocal.co.uk/api/tracking/${tracking}`,
      { headers: { Accept: 'application/json' }, timeout: 8000 }
    );
    results.public_track = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0, 400) };
  } catch (err) {
    results.public_track = { ok: false, status: err.response?.status, body: JSON.stringify(err.response?.data || err.message).slice(0, 200) };
  }

  results.env = {
    DPD_API_KEY:        process.env.DPD_API_KEY        ? `set (${process.env.DPD_API_KEY.slice(0,6)}…)`        : '✗ MISSING',
    DPD_USERNAME:       process.env.DPD_USERNAME        ? `set (${process.env.DPD_USERNAME.slice(0,6)}…)`        : '✗ MISSING',
    DPD_ACCOUNT_NUMBER: process.env.DPD_ACCOUNT_NUMBER  || '✗ MISSING',
  };

  res.json(results);
};
