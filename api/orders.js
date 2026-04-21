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
    // Fetch client map
    let clientMap={};
    try{
      const cr=await MS.get('/Client');
      (Array.isArray(cr.data)?cr.data:[]).forEach(c=>{
        const id=String(c.ID||c.Id||'');
        if(id) clientMap[id]=c.Name||c.ClientName||c.CompanyName||id;
      });
    }catch{}

    // Mintsoft caps at 100 results and time-chunk filtering doesn't work reliably.
    // Solution: fetch page 1, get the lowest ID, then fetch with MaxId = lowestId-1
    // to get the next 100, repeat until we have all orders in the date range.
    const seen=new Set();
    const allOrders=[];
    let maxId=null; // null = no filter on first request
    let keepGoing=true;
    const startDate=new Date(dateFrom);
    const endDate=new Date(dateTo);

    while(keepGoing){
      try{
        const params={DateFrom:dateFrom,DateTo:dateTo,pageSize:100};
        if(maxId!==null) params.MaxId=maxId;
        const r=await MS.get('/Order/List',{params});
        const page=Array.isArray(r.data)?r.data:[];

        let newCount=0;
        let lowestId=Infinity;
        for(const o of page){
          const id=String(o.ID||'');
          if(id&&!seen.has(id)){
            seen.add(id);
            allOrders.push(o);
            newCount++;
            if(o.ID<lowestId) lowestId=o.ID;
          }
        }

        // Stop if: fewer than 100 results, no new orders, or oldest order is before our range
        if(page.length<100||newCount===0||lowestId===Infinity){
          keepGoing=false;
        } else {
          // Check if oldest order in page is within our date range
          const oldestOrder=page.find(o=>o.ID===lowestId);
          const oldestDate=oldestOrder?new Date(oldestOrder.OrderDate||0):startDate;
          if(oldestDate<startDate){
            keepGoing=false;
          } else {
            maxId=lowestId-1; // fetch next batch below this ID
          }
        }
        if(allOrders.length>=5000) keepGoing=false;
      }catch{keepGoing=false;}
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
      page_count:Math.ceil(allOrders.length/100),
      date_range:{from:dateFrom,to:dateTo},
      orders,
      clients
    });

  }catch(err){
    res.status(502).json({success:false,error:err.message,detail:String(err.response?.data||'').slice(0,300)});
  }
};
