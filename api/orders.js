const { fetchMintsoftOrders, fetchMintsoftClients, normaliseOrder, enrichOrders } = require('./_helpers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dateFrom = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
  const dateTo   = req.query.to   || new Date().toISOString();

  try {
    // Fetch orders and client list in parallel
    const [raw, clientMap] = await Promise.all([
      fetchMintsoftOrders(dateFrom, dateTo),
      fetchMintsoftClients(),
    ]);

    const normal  = raw.map(o => normaliseOrder(o, clientMap));
    const orders  = await enrichOrders(normal);

    // Build unique client list for frontend filter dropdown
    const clients = [...new Map(
      orders.filter(o => o.clientId).map(o => [o.clientId, { id: o.clientId, name: o.clientName }])
    ).values()].sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      success: true,
      count: orders.length,
      chunk_count: Math.ceil((new Date(dateTo) - new Date(dateFrom)) / (6 * 60 * 60 * 1000)),
      date_range: { from: dateFrom, to: dateTo },
      orders,
      clients
    });
  } catch (err) {
    const status = err.response?.status || 502;
    const detail = JSON.stringify(err.response?.data || err.message).slice(0, 300);
    console.error('[orders]', status, detail);
    res.status(status).json({ success: false, error: `API error ${status}`, detail });
  }
};
