const axios = require('axios');
const { mintsoftClient } = require('./_helpers');

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

    // RM: test with a dummy tracking number — 404 means auth worked, 401 means bad creds
    axios.get('https://api.royalmail.net/mailpieces/v2/IV746280456GB/events', {
      headers: {
        'X-IBM-Client-Id':     process.env.RM_API_KEY,
        'X-IBM-Client-Secret': process.env.RM_API_SECRET,
        'X-Accept-RMG-Terms':  'yes',
        'Accept':              'application/json',
      },
      timeout: 6000,
    }).then(() => { checks.royalMail = true; })
      .catch(e => {
        // 404 = tracking number not found but auth OK, 400 = bad request but auth OK
        const s = e.response?.status;
        const noRoute = (e.response?.data?.moreInformation || '').includes('No resources match');
        if ([404, 400].includes(s) || noRoute) checks.royalMail = true;
      }),
  ]);

  res.json({ success: true, connections: checks });
};
