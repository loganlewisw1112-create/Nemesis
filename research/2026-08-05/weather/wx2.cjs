// v2. Three bugs fixed, each caught by the settle-mismatch sanity check:
//  (1) ASOS was requested in local time but parsed as UTC -> running max off by hours.
//      Now requested in UTC with an explicit per-station August offset for day boundaries.
//  (2) max-monotonicity logic was applied to daily-MINIMUM series. Min is non-INcreasing.
//  (3) the -T prefix is NOT directional: -T79 is "80 or above", -T72 is "71 or below".
//      Direction now read from yes_sub_title, never inferred from the ticker.
const https=require('https'),fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function raw(u,json){return new Promise((res,rej)=>{const q=https.get(u,{headers:{accept:json?'application/json':'text/plain','user-agent':'nemesis-research/1.0'}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode!==200)return rej(new Error('http '+r.statusCode));try{res(json?JSON.parse(b):b)}catch(e){rej(new Error('bad'))}})});q.on('error',rej);q.setTimeout(30000,()=>q.destroy(new Error('t')))})}
async function retry(u,json,n=3){let l;for(let i=0;i<n;i++){try{return await raw(u,json)}catch(e){l=e;await sleep(900*(i+1))}}throw l}
// August 2026 UTC offsets (hours). Phoenix does not observe DST.
const CFG={KXHIGHTSFO:{st:'SFO',off:-7,kind:'max'},KXHIGHTSEA:{st:'SEA',off:-7,kind:'max'},
  KXHIGHAUS:{st:'AUS',off:-5,kind:'max'},KXLOWTPHX:{st:'PHX',off:-7,kind:'min'},KXLOWTCHI:{st:'ORD',off:-5,kind:'min'}};
const fee=P=>{const r=0.07*P*(1-P);const cc=Math.ceil(r*10000-1e-9)/10000;return Math.ceil(cc*100-1e-9)/100;};
const cache={};
async function obs(st,off,y,m,d){
  const k=`${st}-${y}-${m}-${d}`; if(k in cache)return cache[k];
  // local day [00:00,24:00) expressed in UTC
  const startUtc=Date.UTC(y,m-1,d,-off,0,0), endUtc=startUtc+86400000;
  const s=new Date(startUtc), e=new Date(endUtc+3600000);
  const u=`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${st}&data=tmpf`
   +`&year1=${s.getUTCFullYear()}&month1=${s.getUTCMonth()+1}&day1=${s.getUTCDate()}&hour1=${s.getUTCHours()}`
   +`&year2=${e.getUTCFullYear()}&month2=${e.getUTCMonth()+1}&day2=${e.getUTCDate()}&hour2=${e.getUTCHours()}`
   +`&tz=UTC&format=onlycomma`;
  let txt;try{txt=await retry(u,false)}catch(err){cache[k]=null;return null}
  const rows=txt.split('\n').slice(1).map(l=>l.split(',')).filter(a=>a.length>=3&&a[2]!=='M'&&a[2]!=='')
    .map(a=>({ts:Date.parse(a[1].replace(' ','T')+'Z')/1000,f:parseFloat(a[2])}))
    .filter(a=>isFinite(a.f)&&isFinite(a.ts)&&a.ts*1000>=startUtc&&a.ts*1000<endUtc)
    .sort((a,b)=>a.ts-b.ts);
  cache[k]=rows.length?rows:null; return cache[k];
}
(async()=>{
  const out=[];let scanned=0,skipDir=0,noObs=0,noCandle=0;
  for(const [ser,cfg] of Object.entries(CFG)){
    let mk=[];try{const d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ser}&status=settled&limit=200`,true);mk=d.markets||[]}catch(e){continue}
    const th=mk.filter(m=>/-T\d+(\.\d+)?$/.test(m.ticker)&&(m.result==='yes'||m.result==='no')&&(+m.volume_fp||0)>=10);
    for(const m of th.slice(0,55)){
      scanned++;
      const sub=String(m.yes_sub_title||'');
      const above=/above/i.test(sub), below=/below/i.test(sub);
      if(above===below){skipDir++;continue}                    // ambiguous -> skip, never guess
      const N=parseFloat((sub.match(/(-?\d+(?:\.\d+)?)/)||[])[1]);
      const dm=m.ticker.match(/-(\d{2})([A-Z]{3})(\d{2})-/); if(!dm||!isFinite(N))continue;
      const MON={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
      const o=await obs(cfg.st,cfg.off,2000+ +dm[1],MON[dm[2]],+dm[3]); if(!o){noObs++;continue}
      let cd;try{cd=await retry(`https://api.elections.kalshi.com/trade-api/v2/series/${ser}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${Math.floor(new Date(m.open_time)/1000)}&end_ts=${Math.floor(new Date(m.close_time)/1000)}&period_interval=60`,true)}catch(e){noCandle++;continue}
      const cs=(cd.candlesticks||[]).filter(x=>x&&x.yes_bid&&x.yes_ask&&+x.yes_bid.close_dollars>0&&+x.yes_ask.close_dollars<1);
      if(!cs.length){noCandle++;continue}
      // running extreme, correct direction
      const run=[];let cur=cfg.kind==='max'?-999:999;
      for(const r of o){cur=cfg.kind==='max'?Math.max(cur,r.f):Math.min(cur,r.f);run.push({ts:r.ts,cur});}
      const settledYes=m.result==='yes'?1:0;
      for(const c of cs){
        let x=null;for(const r of run){if(r.ts<=c.end_period_ts)x=r.cur;else break;}
        if(x==null)continue;
        // Determined purely by monotonicity of the running extreme:
        let determined=null;
        if(cfg.kind==='max'&&above) determined = x>=N ? 1 : null;      // max can only rise
        if(cfg.kind==='max'&&below) determined = x>N  ? 0 : null;      // already too hot
        if(cfg.kind==='min'&&below) determined = x<=N ? 1 : null;      // min can only fall
        if(cfg.kind==='min'&&above) determined = x<N  ? 0 : null;      // already too cold
        if(determined==null)continue;
        const ask=+c.yes_ask.close_dollars, bid=+c.yes_bid.close_dollars;
        // determined YES -> buy YES at ask; determined NO -> buy NO at (1-bid). Hold to settle.
        const entry = determined===1 ? ask : 1-bid;
        const pnl = 1 - entry - fee(entry);
        out.push({ser,tk:m.ticker,kind:cfg.kind,dir:above?'above':'below',N,x,determined,settledYes,entry,pnl});
      }
      await sleep(70);
    }
    console.log(`${ser} done`);
  }
  fs.writeFileSync('wx2-results.json',JSON.stringify(out));
  const wrong=out.filter(r=>r.determined!==r.settledYes);
  console.log(`\nscanned=${scanned} ambiguousSkipped=${skipDir} noObs=${noObs} noCandle=${noCandle}`);
  console.log(`determined moments: ${out.length}`);
  console.log(`SANITY -- determined outcome disagreed with actual settlement: ${wrong.length} (${(100*wrong.length/Math.max(out.length,1)).toFixed(1)}%)  [must be ~0]`);
  if(wrong.length/Math.max(out.length,1)>0.02){console.log('>>> STILL BROKEN: not reporting P&L.');
    const s={};for(const r of wrong.slice(0,2000))s[`${r.ser} ${r.kind}/${r.dir}`]=(s[`${r.ser} ${r.kind}/${r.dir}`]||0)+1;
    console.log('mismatches by series/type:',JSON.stringify(s,null,1));return;}
  const buy=out.filter(r=>r.entry<0.99);
  console.log(`\nmispriced-determined moments (entry<0.99): ${buy.length}`);
  if(buy.length){const mean=buy.reduce((s,r)=>s+r.pnl,0)/buy.length;
    const e=buy.map(r=>r.entry).sort((a,b)=>a-b);
    console.log(`  mean entry ${(e.reduce((a,b)=>a+b,0)/e.length).toFixed(3)}  median ${e[Math.floor(e.length/2)].toFixed(3)}`);
    console.log(`  mean P&L per contract (hold to settlement, net entry fee): ${(mean*100).toFixed(2)}c`);}
})();
