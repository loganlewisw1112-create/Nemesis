const https=require('https');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function get(u){return new Promise((res,rej)=>{const q=https.get(u,{headers:{accept:'application/json'}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode!==200)return rej(new Error('http '+r.statusCode));try{res(JSON.parse(b))}catch(e){rej(new Error('bad'))}})});q.on('error',rej);q.setTimeout(20000,()=>q.destroy(new Error('t')))})}
async function retry(u,n=3){let l;for(let i=0;i<n;i++){try{return await get(u)}catch(e){l=e;await sleep(800*(i+1))}}throw l}
const SER=['KXHIGHTSFO','KXHIGHTSEA','KXHOBBYTEMP','KXHIGHAUS','KXHIGHOU','KXLOWTCHI','KXLOWTPHX','KXHIGHTNY','KXHIGHTCHI','KXHIGHTMIA','KXHIGHTDEN','KXHIGHTPHIL'];
(async()=>{
  for(const s of SER){
    let open=[],settled=[];
    try{const d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${s}&status=open&limit=200`);open=d.markets||[];}catch(e){}
    try{const d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${s}&status=settled&limit=200`);settled=d.markets||[];}catch(e){}
    if(!open.length&&!settled.length){console.log(`${s.padEnd(14)} -- no markets`);continue}
    const two=open.filter(m=>+m.yes_bid_dollars>0&&+m.yes_ask_dollars<1);
    const spr=two.map(m=>+(+m.yes_ask_dollars-+m.yes_bid_dollars).toFixed(3)).sort((a,b)=>a-b);
    const dep=two.flatMap(m=>[+m.yes_bid_size_fp,+m.yes_ask_size_fp]).filter(x=>x>0).sort((a,b)=>a-b);
    const sv=settled.filter(m=>(+m.volume_fp||0)>=10&&(m.result==='yes'||m.result==='no'));
    const vols=sv.map(m=>+m.volume_fp).sort((a,b)=>a-b);
    console.log(`${s.padEnd(14)} open=${String(open.length).padStart(3)} twoSided=${String(two.length).padStart(3)}`
      +` medSpread=${spr.length?spr[Math.floor(spr.length/2)].toFixed(3):'  -  '}`
      +` medDepth=${dep.length?String(Math.round(dep[Math.floor(dep.length/2)])).padStart(5):'    -'}`
      +` | settledTraded=${String(sv.length).padStart(3)} medVol=${vols.length?String(Math.round(vols[Math.floor(vols.length/2)])).padStart(5):'    -'}`);
    if(open.length&&s==='KXHIGHTSFO'){
      console.log('     sample open markets:');
      for(const m of open.slice(0,6)) console.log(`       ${m.ticker.padEnd(30)} ${String(m.title||'').slice(0,44)} | ${m.yes_sub_title||''} bid=${m.yes_bid_dollars} ask=${m.yes_ask_dollars} close=${m.close_time}`);
    }
    await sleep(200);
  }
})();
