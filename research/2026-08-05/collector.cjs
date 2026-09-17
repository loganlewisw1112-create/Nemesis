// Session-length public-data collector for Kalshi maker Phase 0.
// Read-only public API. Appends JSONL; designed to survive transient failures.
const https=require('https'), fs=require('fs'), path=require('path');
const OUT=__dirname;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SERIES=['KXMLBGAME','KXITFWMATCH','KXCS2GAME','KXMLBTOTAL','KXBTCD'];
function get(u){return new Promise((res,rej)=>{
  const q=https.get(u,{headers:{accept:'application/json','user-agent':'nemesis-research/1.0'}},r=>{
    let b='';r.on('data',c=>b+=c);r.on('end',()=>{
      if(r.statusCode===429)return rej(new Error('429'));
      if(r.statusCode!==200)return rej(new Error('http '+r.statusCode));
      try{res(JSON.parse(b))}catch(e){rej(new Error('badjson'))}});});
  q.on('error',rej);q.setTimeout(25000,()=>q.destroy(new Error('timeout')));});}
async function retry(u,n=3){let l;for(let i=0;i<n;i++){try{return await get(u)}catch(e){l=e;await sleep(1000*(i+1)*(e.message==='429'?4:1))}}throw l}
const seen=new Set(); let seenOrder=[];
function markSeen(id){ seen.add(id); seenOrder.push(id); if(seenOrder.length>400000){const drop=seenOrder.splice(0,100000); for(const d of drop) seen.delete(d);} }
let bookN=0,tradeN=0,errN=0;
async function snapBooks(){
  const rows=[];
  for(const s of SERIES){
    let c='';
    for(let p=0;p<3;p++){
      let d;try{d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${s}&status=open&limit=200${c?`&cursor=${encodeURIComponent(c)}`:''}`)}catch(e){errN++;break}
      for(const m of (d.markets||[])){
        const bid=+m.yes_bid_dollars, ask=+m.yes_ask_dollars;
        if(!(bid>0&&ask<1))continue;
        rows.push({t:Date.now(),tk:m.ticker,ev:m.event_ticker,K:+m.floor_strike,st:m.strike_type,
          bid,ask,bs:+m.yes_bid_size_fp,as:+m.yes_ask_size_fp,ct:m.close_time});
      }
      if(!d.cursor||!(d.markets||[]).length)break;c=d.cursor;await sleep(150);
    }
    await sleep(150);
  }
  if(rows.length){fs.appendFileSync(path.join(OUT,'books.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');bookN+=rows.length;}
}
async function snapTrades(){
  const keep=[];let c='';
  for(let p=0;p<8;p++){
    let d;try{d=await retry(`https://api.elections.kalshi.com/trade-api/v2/markets/trades?limit=1000${c?`&cursor=${encodeURIComponent(c)}`:''}`)}catch(e){errN++;break}
    const t=d.trades||[];let fresh=0;
    for(const x of t){
      if(seen.has(x.trade_id))continue;
      markSeen(x.trade_id);fresh++;
      const s=(x.ticker||'').split('-')[0];
      if(!SERIES.includes(s))continue;
      keep.push({t:new Date(x.created_time).getTime(),tk:x.ticker,p:+x.yes_price_dollars,
        q:+x.count_fp,side:x.taker_book_side,os:x.taker_outcome_side,blk:x.is_block_trade});
    }
    if(fresh===0)break;                 // caught up
    if(!d.cursor||!t.length)break;c=d.cursor;await sleep(100);
  }
  if(keep.length){fs.appendFileSync(path.join(OUT,'trades.jsonl'),keep.map(r=>JSON.stringify(r)).join('\n')+'\n');tradeN+=keep.length;}
}
(async()=>{
  const started=Date.now();
  const DEADLINE=started+10.5*3600*1000;
  console.log('collector start',new Date().toISOString());
  let cycle=0;
  while(Date.now()<DEADLINE){
    cycle++;
    try{ await snapTrades(); await snapBooks(); }
    catch(e){errN++;}
    if(cycle%20===0){
      const msg=`[${new Date().toISOString()}] cycle=${cycle} books=${bookN} trades=${tradeN} errs=${errN}`;
      console.log(msg);
      fs.appendFileSync(path.join(OUT,'collector.log'),msg+'\n');
    }
    await sleep(10000);
  }
  console.log('collector done',bookN,tradeN,errN);
})();
