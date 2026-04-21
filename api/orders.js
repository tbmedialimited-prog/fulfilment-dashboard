// v8 - full chunk pagination inline, no _helpers dependency for fetching
const axios = require('axios');

const MS = axios.create({
  baseURL: 'https://api.mintsoft.co.uk/api',
  headers: { 'Ms-Apikey': process.env.MINTSOFT_API_KEY, Accept: 'application/json' },
  timeout: 20000,
});

function detectCarrier(n=''){
  n=n.toLowerCase();
  if(n.includes('dpd')) return 'DPD Local';
  if(n.includes('royal mail')||n.includes('royalmail')||n.startsWith('rm ')) return 'Royal Mail';
  return n||'Other';
}
function deriveStatus(o){
  if(o.DespatchDate) return 'In transit';
  const sid=o.OrderStatusId||0;
  if(sid>=5) return 'In transit';
  return 'Processing';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS') return res.status(200).end();

  const dateFrom = req.query.from || new Date(Date.now()-7*86400000).toISOString();
  const dateTo   = req.query.to   || new Date().toISOString();

  try {
    // Build 6-hour chunks
    const CHUNK = 6*60*60*1000;
    const chunks=[];
    let cur=new Date(dateFrom);
    const end=new Date(dateTo);
    while(cur<end){
      chunks.push({ from:cur.toISOString(), to:new Date(Math.min(cur.getTime()+CHUNK,end.getTime())).toISOString() });
      cur=new Date(cur.getTime()+CHUNK);
    }

    // Fetch client map
    let clientMap={};
    try{
      const cr=await MS.get('/Client');
      (Array.isArray(cr.data)?cr.data:[]).forEach(c=>{
        const id=String(c.ID||c.Id||'');
        if(id) clientMap[id]=c.Name||c.ClientName||c.CompanyName||id;
      });
    }catch{}

    // Fetch all chunks in batches of 10
    const seen=new Set();
    const allOrders=[];
    for(let i=0;i<chunks.length;i+=10){
      const batch=chunks.slice(i,i+10);
      const results=await Promise.all(batch.map(async({from,to})=>{
        try{
          const r=await MS.get('/Order/List',{params:{DateFrom:from,DateTo:to,pageSize:100}});
          return Array.isArray(r.data)?r.data:[];
        }catch{return[];}
      }));
      for(const page of results){
        for(const o of page){
          const id=String(o.ID||o.OrderNumber||'');
          if(id&&!seen.has(id)){seen.add(id);allOrders.push(o);}
        }
      }
    }

    // Normalise
    const orders=allOrders.map(o=>{
      const clientId=String(o.ClientId||'');
      return{
        id:       String(o.ID||''),
        ref:      o.OrderNumber||o.ExternalOrderReference||`ORD-${o.ID}`,
        recipient:[o.FirstName,o.LastName].filter(Boolean).join(' ')||o.CompanyName||'Unknown',
        created:  o.OrderDate||null,
        despatched:o.DespatchDate||null,
        carrier:  detectCarrier(o.CourierServiceName||''),
        tracking: o.TrackingNumber||null,
        trackingUrl:o.TrackingURL||null,
        status:   deriveStatus(o),
        rawCarrier:o.CourierServiceName||'',
        clientId,
        clientName:clientMap[clientId]||o.CLIENT_CODE||`Client ${clientId}`,
      };
    });

    // Client list for dropdown
    const clients=[...new Map(
      orders.filter(o=>o.clientId).map(o=>[o.clientId,{id:o.clientId,name:o.clientName}])
    ).values()].sort((a,b)=>a.name.localeCompare(b.name));

    res.json({
      success:true,
      count:orders.length,
      chunk_count:chunks.length,
      date_range:{from:dateFrom,to:dateTo},
      orders,
      clients
    });

  }catch(err){
    res.status(502).json({success:false,error:err.message,detail:String(err.response?.data||'').slice(0,300)});
  }
};
