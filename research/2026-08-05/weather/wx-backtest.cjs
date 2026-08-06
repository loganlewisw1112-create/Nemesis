// Does Kalshi correctly price ALREADY-DETERMINED weather outcomes?
// Daily max temperature is monotonically non-decreasing, so for a "max > T" market the moment
// observed running max exceeds T the outcome is CERTAIN yes. No forecasting required -- this is
// purely whether the market keeps up with a free public observation feed.
const https=require('https'),fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function raw(u,json){return new Promise((res,rej)=>{const q=https.get(u,{headers:{accept:json?'application/json':'text/plain','user-agent':'nemesis-research/1.0'}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode!==200)return rej(new Error('http '+r.statusCode));try{res(json?JSON.parse(b):b)}catch(e){rej(new Error('bad'))}})});q.on('error',rej);q.setTimeout(30000,()=>q.destroy(new Error('t')))})}
async function retry(u,json,n=3){let l;for(let i=0;i<n;i++){try{return await raw(u,json)}catch(e){l=e;await sleep(900*(i+1))}}throw l}
// series -> ASOS station + local tz
const CFG={KXHIGHTSFO:{st:'SFO',tz:'America/Los_Angeles'},KXHIGHTSEA:{st:'SEA',tz:'America/Los_Angeles'},
  KXHIGHAUS:{st:'AUS',tz:'America/Chicago'},KXLOWTPHX:{st:'PHX',tz:'America/Phoenix'},KXLOWTCHI:{st:'ORD',tz:'America/Chicago'}};
const fee=P=>{const raw=0.07*P*(1-P);const cc=Math.ceil(raw*10000-1e-9)/10000;return Math.ceil(cc*100-1e-9)/100;};
const obsCache={};
async function obs(st,tz,y,m,d){
  const k=`${st}-${y}-${m}-${d}`; if(obsCache[k])return obsCache[k];
  const nd=new Date(Date.UTC(y,m-1,d)); nd.setUTCDate(nd.getUTCDate()+1);
  const u=`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${st}&data=tmpf&`
    +`year1=${y}&month1=${m}&day1=${d}&year2=${nd.getUTCFullYear()}&month2=${nd.getUTCMonth()+1}&day2=${nd.getUTCDate()}`
    +`&tz=${encodeURIComponent(tz)}&format=onlycomma`;
  let txt; try{txt=await retry(u,false)}catch(e){obsCache[k]=null;return null}
  const rows=txt.split('\n').slice(1).map(l=>l.split(',')).filter(a=>a.length>=3&&a[2]!=='M'&&a[2]!=='')
    .map(a=>({t:a[1],f:parseFloat(a[2])})).filter(a=>isFinite(a.f));
  obsCache[k]=rows.length?rows:null; return obsCache[k];
}
(async()=>{
  const results=[];let scanned=0,noObs=0,noCandle=0;
  for(const [ser,cfg] of Object.entries(CFG)){
    let mk=[];try{const d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ser}&status=settled&limit=200`,true);mk=d.markets||[]}catch(e){continue}
    // threshold markets only: ticker ends -T<number>, i.e. "max > N"
    const th=mk.filter(m=>/-T\d+(\.\d+)?$/.test(m.ticker)&&(m.result==='yes'||m.result==='no')&&(+m.volume_fp||0)>=10);
    console.log(`${ser}: ${mk.length} settled, ${th.length} threshold markets w/ volume`);
    for(const m of th.slice(0,60)){
      scanned++;
      const T=parseFloat((m.ticker.match(/-T(\d+(?:\.\d+)?)$/)||[])[1]);
      const dm=(m.ticker.match(/-(\d{2})([A-Z]{3})(\d{2})-/)||[]);
      if(!dm.length||!isFinite(T))continue;
      const MON={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
      const y=2000+ +dm[1], mo=MON[dm[2]], da=+dm[3];
      const o=await obs(cfg.st,cfg.tz,y,mo,da); if(!o){noObs++;continue}
      const openTs=Math.floor(new Date(m.open_time).getTime()/1000), closeTs=Math.floor(new Date(m.close_time).getTime()/1000);
      let cd;try{cd=await retry(`https://api.elections.kalshi.com/trade-api/v2/series/${ser}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${openTs}&end_ts=${closeTs}&period_interval=60`,true)}catch(e){noCandle++;continue}
      const cs=(cd.candlesticks||[]).filter(x=>x&&x.yes_bid&&x.yes_ask&&+x.yes_bid.close_dollars>0&&+x.yes_ask.close_dollars<1);
      if(!cs.length){noCandle++;continue}
      // running max from observations, in local time
      let run=-999; const runAt=[];
      for(const r of o){ if(r.f>run)run=r.f; runAt.push({t:new Date(r.t.replace(' ','T')+'Z').getTime()/1000,run}); }
      // for each candle, was the outcome ALREADY certain-yes from observations alone?
      for(const c of cs){
        const ts=c.end_period_ts;
        let rmax=null; for(const r of runAt){ if(r.t<=ts) rmax=r.run; else break; }
        if(rmax==null)continue;
        const certainYes = rmax > T;                 // max can only rise: already resolved YES
        if(!certainYes)continue;
        const ask=+c.yes_ask.close_dollars, bid=+c.yes_bid.close_dollars;
        // buy YES at the ask, hold to settlement (no exit trade, no exit fee)
        const pnl = 1 - ask - fee(ask);
        results.push({ser,tk:m.ticker,T,rmax,ask,bid,res:m.result==='yes'?1:0,pnl,ts});
      }
      await sleep(70);
    }
  }
  fs.writeFileSync('wx-results.json',JSON.stringify(results));
  console.log(`\nscanned=${scanned} noObs=${noObs} noCandle=${noCandle} certain-yes observations=${results.length}`);
  if(!results.length){console.log('no determined-outcome moments found');return}
  const wrong=results.filter(r=>r.res!==1);
  console.log(`sanity: certain-yes moments whose market actually settled NO: ${wrong.length} (should be ~0)`);
  const buyable=results.filter(r=>r.ask<0.99);
  console.log(`\nmoments where outcome was CERTAIN yes but ask < 0.99: ${buyable.length}`);
  if(buyable.length){
    const mean=buyable.reduce((s,r)=>s+r.pnl,0)/buyable.length;
    const asks=buyable.map(r=>r.ask).sort((a,b)=>a-b);
    console.log(`  mean ask ${(asks.reduce((a,b)=>a+b,0)/asks.length).toFixed(3)}  median ask ${asks[Math.floor(asks.length/2)].toFixed(3)}  min ${asks[0].toFixed(3)}`);
    console.log(`  mean P&L per contract, buy-and-hold-to-settlement, net of entry fee: ${(mean*100).toFixed(2)}c`);
    const cheap=buyable.filter(r=>r.ask<0.95);
    console.log(`  of those, ask<0.95: ${cheap.length}, mean P&L ${(cheap.reduce((s,r)=>s+r.pnl,0)/Math.max(cheap.length,1)*100).toFixed(2)}c`);
  }
})();
