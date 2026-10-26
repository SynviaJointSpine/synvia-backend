const {createHash,createHmac}=require('node:crypto');
const AUTH_URL='https://tuxqiqqwqahnrpflpfug.supabase.co/auth/v1/user';
const PUBLIC_KEY='sb_publishable_InpeStVGNbeYfmHQnoJD4A_CT_kIbTH';
function installRevenueSheet(app,env=process.env,fetcher=fetch){
  let cache=null, pending=null;
  app.post('/revenue/sheet-live',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      const authorization=req.get('authorization')||'';
      if(!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) return res.status(401).json({error:'Sign in to SYNVIA OS'});
      const auth=await fetcher(AUTH_URL,{headers:{authorization,apikey:PUBLIC_KEY},signal:AbortSignal.timeout(10000)});
      if(!auth.ok) return res.status(401).json({error:'Sign in to SYNVIA OS'});
      const user=await auth.json();
      if(!user.id) return res.status(401).json({error:'Sign in to SYNVIA OS'});
      if(cache && Date.now()-Date.parse(cache.fetched_at)<45000) return res.json(cache);
      if(!pending) pending=(async()=>{
        const payload=JSON.stringify({operation:'revenue_read'}),issuedAt=Math.floor(Date.now()/1000);
        const signature=createHmac('sha256',env.GMAIL_INTAKE_WEBHOOK_SECRET).update(issuedAt+'\n'+createHash('sha256').update(payload).digest('hex')).digest('hex');
        const response=await fetcher(env.GMAIL_INTAKE_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issuedAt,payload,signature}),signal:AbortSignal.timeout(40000)});
        const data=await response.json();
        if(!response.ok || !data.success || !Array.isArray(data.rows)||!Array.isArray(data.tabs)||!data.tabs.length||!Number.isFinite(Date.parse(data.fetched_at))) throw Error('Spreadsheet connection needs review');
        cache=data;return data;
      })().finally(()=>{pending=null;});
      res.json(await pending);
    }catch(e){res.status(503).json({error:'Spreadsheet sync unavailable. Your last successful data is preserved.'});}
  });
}
module.exports={installRevenueSheet};
