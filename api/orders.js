const { fetchMintsoftOrders, normaliseOrder, enrichOrders } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dateFrom = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
  const dateTo   = req.query.to   || new Date().toISOString();

  try {
    const raw     = await fetchMintsoftOrders(dateFrom, dateTo);
    const normal  = raw.map(normaliseOrder);
    const orders  = await enrichOrders(normal);
    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    const status  = err.response?.status || 502;
    const detail  = JSON.stringify(err.response?.data || err.message).slice(0, 300);
    console.error('[orders]', status, detail);
    res.status(status).json({ success: false, error: `API error ${status}`, detail });
  }
};
