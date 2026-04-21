const axios = require('axios');
const { mintsoftClient, getRmToken } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const checks = { mintsoft: false, dpdLocal: false, royalMail: false };

  await Promise.allSettled([
    mintsoftClient().get('/api/Client', { timeout: 6000 })
      .then(() => { checks.mintsoft = true; })
      .catch(() => {}),

    axios.get('https://api.dpdlocal.co.uk/user/', {
      headers: { Authorization: `Bearer ${process.env.DPD_API_KEY}` }, timeout: 6000,
    }).then(() => { checks.dpdLocal = true; })
      .catch(e => { if (e.response?.status !== 401) checks.dpdLocal = true; }),

    getRmToken()
      .then(() => { checks.royalMail = true; })
      .catch(() => {}),
  ]);

  res.json({ success: true, connections: checks });
};
