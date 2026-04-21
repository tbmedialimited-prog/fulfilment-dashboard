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

    // Mintsoft pagination using SortOldestFirst + sliding DateFrom window.
    // Fetch oldest 100, advance DateFrom to last order's date, repeat.
    const seen=new Set();
    const allOrders=[];
    let windowStart=dateFrom;
    const windowEnd=dateTo;
    let keepGoing=true;

    while(keepGoing){
      try{
        const r=await MS.get('/Order/List',{
          params:{ DateFrom:windowStart, ToDate:windowEnd, pageSize:100, SortOldestFirst:true }
        });
        const page=Array.isArray(r.data)?r.data:[];

        let newCount=0;
        let latestDate=windowStart;

        for(const o of page){
          const id=String(o.ID||'');
          if(id&&!seen.has(id)){
            seen.add(id);
            allOrders.push(o);
            newCount++;
            // Track the latest OrderDate in this page to advance the window
            if(o.OrderDate && o.OrderDate > latestDate) latestDate=o.OrderDate;
          }
        }

        if(page.length<100||newCount===0){
          // Last page or no new orders
          keepGoing=false;
        } else if(latestDate===windowStart){
          // Date didn't advance - avoid infinite loop
          keepGoing=false;
        } else {
          // Advance window to just after the latest order we saw
          // Add 1ms to avoid re-fetching the boundary order
          const nextStart=new Date(new Date(latestDate).getTime()+1).toISOString();
          windowStart=nextStart;
        }

        if(allOrders.length>=10000) keepGoing=false;
      }catch{ keepGoing=false; }
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
