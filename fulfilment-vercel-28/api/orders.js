// v10 - per-client pagination with strict client-side date filtering
const axios = require('axios');

const MS = axios.create({
  baseURL: 'https://api.mintsoft.co.uk/api',
  headers: {
    'Ms-Apikey':  process.env.MINTSOFT_API_KEY,
    'Accept':     'application/json',
    'User-Agent': 'FulfilmentExperts-Dashboard/1.0',
  },
  timeout: 20000,
});

function detectCarrier(n=''){
  n=n.toLowerCase();
  if(n.includes('dpd')) return 'DPD Local';
  if(n.includes('royal mail')||n.includes('royalmail')||n.startsWith('rm ')) return 'Royal Mail';
  return n||'Other';
}

function deriveStatus(o){
  const sid = o.OrderStatusId || 0;
  // Mintsoft status IDs: 1=New, 2=Printed, 3=Picked, 4=Packed, 5=Despatched, 6+=post-despatch
  if(sid >= 5) return 'In transit';
  if(o.DespatchDate) return 'In transit';
  if(sid === 0) return 'Processing';
  return 'Processing';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS') return res.status(200).end();

  // The frontend sends correct UTC boundaries based on UK timezone
  // We just use them directly
  const dateFrom = req.query.from || (() => {
    // Default: UK today midnight UTC
    const now = new Date();
    const ukNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const utcNow = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = ukNow - utcNow;
    const ukMidnight = new Date(ukNow.getFullYear(), ukNow.getMonth(), ukNow.getDate());
    return new Date(ukMidnight.getTime() - offsetMs).toISOString();
  })();
  const dateTo = req.query.to || new Date().toISOString();
  const startMs = new Date(dateFrom).getTime();
  const endMs   = new Date(dateTo).getTime();

  try {
    // Fetch client list
    let clientMap={};
    let clientIds=[];
    try{
      const cr=await MS.get('/Client');
      const clients=Array.isArray(cr.data)?cr.data:[];
      clients.forEach(c=>{
        const id=String(c.ID||c.Id||'');
        if(id){
          clientMap[id]=c.Name||c.ClientName||c.CompanyName||id;
          clientIds.push(id);
        }
      });
    }catch{}

    // Fetch per client + one unfiltered pass, all in parallel batches
    // Each returns 100 orders. Per-client gives different subsets.
    const seen=new Set();
    const allOrders=[];

    const fetchTargets=[null,...clientIds]; // null = no client filter

    for(let i=0;i<fetchTargets.length;i+=10){
      const batch=fetchTargets.slice(i,i+10);
      const results=await Promise.all(batch.map(async cid=>{
        try{
          const params={ DateFrom:dateFrom, DateTo:dateTo, pageSize:100 };
          if(cid!==null) params.ClientId=cid;
          const r=await MS.get('/Order/List',{params});
          return Array.isArray(r.data)?r.data:[];
        }catch{return[];}
      }));

      for(const page of results){
        for(const o of page){
          // Strict client-side date filter using UK timezone
          // Mintsoft stores UTC, we compare in UTC milliseconds mapped to UK day boundaries
          const orderMs = new Date(o.OrderDate||0).getTime();
          if(orderMs < startMs || orderMs > endMs) continue;

          const id=String(o.ID||'');
          if(id&&!seen.has(id)){
            seen.add(id);
            allOrders.push(o);
          }
        }
      }

      if(allOrders.length>=10000) break;
    }

    // Normalise
    const orders=allOrders.map(o=>{
      const clientId=String(o.ClientId||'');
      return{
        id:         String(o.ID||''),
        ref:        o.OrderNumber||o.ExternalOrderReference||`ORD-${o.ID}`,
        recipient: [o.FirstName,o.LastName].filter(Boolean).join(' ')||o.CompanyName||'Unknown',
        created:    o.OrderDate||null,
        despatched: o.DespatchDate||null,
        carrier:    detectCarrier(o.CourierServiceName||''),
        tracking:   o.TrackingNumber||null,
        trackingUrl:o.TrackingURL||null,
        status:     deriveStatus(o),
        rawCarrier: o.CourierServiceName||'',
        clientId,
        clientName: clientMap[clientId]||o.CLIENT_CODE||`Client ${clientId}`,
      };
    }).sort((a,b)=>new Date(b.created)-new Date(a.created)); // newest first

    // Client dropdown
    const clients=[...new Map(
      orders.filter(o=>o.clientId).map(o=>[o.clientId,{id:o.clientId,name:o.clientName}])
    ).values()].sort((a,b)=>a.name.localeCompare(b.name));

    res.json({
      success:true,
      count:orders.length,
      clients_fetched:fetchTargets.length,
      date_range:{from:dateFrom,to:dateTo},
      orders,
      clients
    });

  }catch(err){
    res.status(502).json({success:false,error:err.message});
  }
};
