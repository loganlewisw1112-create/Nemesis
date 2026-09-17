// Tail calibration: is the ILLIQUID/untested part of Kalshi mispriced, and does any
// mispricing exceed the round-trip cost? Stratified sample across categories, since
// 12,493 non-MVE series is too many to probe exhaustively.
const https=require('https'),fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function get(u){return new Promise((res,rej)=>{const q=https.get(u,{headers:{accept:'application/json'}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode===429)return rej(new Error('429'));if(r.statusCode!==200)return rej(new Error('http '+r.statusCode));try{res(JSON.parse(b))}catch(e){rej(new Error('badjson'))}})});q.on('error',rej);q.setTimeout(20000,()=>q.destroy(new Error('timeout')))})}
async function retry(u,n=2){let l;for(let i=0;i<n;i++){try{return await get(u)}catch(e){l=e;await sleep((e.message==='429'?2500:500)*(i+1))}}throw l}
const fee=P=>{const raw=0.07*P*(1-P);const cc=Math.ceil(raw*10000-1e-9)/10000;return Math.ceil(cc*100-1e-9)/100;};
const ALREADY=new Set(['KXBTCD','KXETHD','KXINXU','KXNASDAQ100U','KXITFMATCH','KXITFWMATCH','KXATPMATCH','KXCS2GAME','KXMLBGAME','KXMLBTOTAL','KXCLUBFGAME','KXUCLWGAME','KXBTC15M','KXETH15M']);
(async()=>{
  const all=JSON.parse(fs.readFileSync('tail-series.json','utf8'))
    .filter(s=>s.ticker&&!s.ticker.startsWith('KXMVE')&&!ALREADY.has(s.ticker));
  // stratified sample: proportional to category size, capped
  const byCat={};for(const s of all)(byCat[s.category||'?']=byCat[s.category||'?']||[]).push(s);
  const PER_CAT=34;
  const sample=[];
  for(const [cat,arr] of Object.entries(byCat)){
    // deterministic spread through the list rather than random, for reproducibility
    const step=Math.max(1,Math.floor(arr.length/PER_CAT));
    for(let i=0;i<arr.length&&sample.filter(x=>x.category===cat).length<PER_CAT;i+=step) sample.push(arr[i]);
  }
  console.log(`sampling ${sample.length} series across ${Object.keys(byCat).length} categories`);

  // Phase A: which sampled series have genuinely traded settled markets?
  const withTrading=[];
  for(let i=0;i<sample.length;i++){
    const s=sample[i];
    let d;try{d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${s.ticker}&status=settled&limit=100`)}catch(e){continue}
    const m=(d.markets||[]).filter(x=>(x.result==='yes'||x.result==='no')&&(+x.volume_fp||0)>=10&&x.open_time&&x.close_time);
    if(m.length>=3) withTrading.push({s,markets:m});
    if(i%50===0){process.stdout.write(`[${i}/${sample.length} hits=${withTrading.length}]`);}
    await sleep(70);
  }
  console.log(`\nseries with >=3 traded settled markets: ${withTrading.length}`);
  fs.writeFileSync('tail-withtrading.json',JSON.stringify(withTrading.map(x=>({t:x.s.ticker,cat:x.s.category,n:x.markets.length}))));

  // Phase B: candlestick price at 50% of life for a sample of markets per series
  const rows=[];let fail=0;
  for(const {s,markets} of withTrading){
    const pick=markets.slice(0,14);
    for(const m of pick){
      const openTs=Math.floor(new Date(m.open_time).getTime()/1000);
      const closeTs=Math.floor(new Date(m.close_time).getTime()/1000);
      const life=closeTs-openTs; if(life<300)continue;
      const interval=life>6*3600?60:1;
      let d;
      try{d=await retry(`https://api.elections.kalshi.com/trade-api/v2/series/${s.ticker}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${openTs}&end_ts=${closeTs}&period_interval=${interval}`);}
      catch(e){fail++;continue}
      const cs=(d.candlesticks||[]).filter(x=>x&&x.yes_bid&&x.yes_ask&&+x.yes_bid.close_dollars>0&&+x.yes_ask.close_dollars<1);
      if(cs.length<2){fail++;continue}
      const target=openTs+life*0.5;
      let pk=null;for(const x of cs){if(x.end_period_ts<=target)pk=x;}
      if(!pk)pk=cs[0];
      const bid=+pk.yes_bid.close_dollars,ask=+pk.yes_ask.close_dollars;
      if(!(bid>0&&ask<1&&ask>=bid))continue;
      rows.push({ser:s.ticker,cat:s.category,tk:m.ticker,bid,ask,mid:(bid+ask)/2,
        res:m.result==='yes'?1:0,vol:+m.volume_fp});
      await sleep(60);
    }
    process.stdout.write('.');
  }
  fs.writeFileSync('tail-rows.json',JSON.stringify(rows));
  console.log(`\nrows: ${rows.length}  failed: ${fail}`);
})();
