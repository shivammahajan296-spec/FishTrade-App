// FishTrade Worker: D1-backed shared SQLite ledger with optimistic locking.
const encoder = new TextEncoder();
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const cookies = request => Object.fromEntries((request.headers.get('cookie') || '').split(';').map(x=>x.trim()).filter(Boolean).map(x=> {let j=x.indexOf('='); return [x.slice(0,j),x.slice(j+1)]}));
async function signature(message, secret) {const key = await  crypto.subtle.importKey(   'raw',   encoder.encode(secret),   { name: 'HMAC', hash: 'SHA-256' },   false,   ['sign'] ); const bits = await crypto.subtle.sign('HMAC',key,encoder.encode(message));return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function authenticated(request, env){const token=cookies(request).fishtrade_session;if(!token)return false;const i=token.indexOf('.');if(i<0)return false;const exp=token.slice(0,i),mac=token.slice(i+1);if(!/^\d{10,}$/.test(exp)||Number(exp)<Date.now()/1000||!env.SESSION_SECRET)return false;const expected=await signature('fishtrade.'+exp,env.SESSION_SECRET);if(expected.length!==mac.length)return false;let diff=0;for(let j=0;j<mac.length;j++)diff |= expected.charCodeAt(j)^mac.charCodeAt(j);return diff===0;}
function sameOrigin(request){const origin=request.headers.get('Origin');return !origin || origin===new URL(request.url).origin;}
function validData(d){if(!d||typeof d!=='object'||!['purchases','sales','contributions','prices'].every(k=>Array.isArray(d[k]) && d[k].length<=10000)||typeof d.extraNotes!=='string'||d.extraNotes.length>15000)return false;
 for(const key of ['purchases','sales','contributions']){const ids=new Set();for(const row of d[key]){if(!row||typeof row!=='object'||typeof row.id!=='string'||row.id.length>100||ids.has(row.id))return false;ids.add(row.id)}}
 for(const row of d.purchases)if(!(row.amount>=0&&Number.isFinite(row.amount))||typeof row.date!=='string')return false;
 for(const row of d.contributions)if(!(row.amount>=0&&Number.isFinite(row.amount)))return false;
 for(const row of d.sales){if(!Array.isArray(row.items)||row.items.length>200||!Number.isFinite(Number(row.collected))||Number(row.collected)<0)return false;for(const item of row.items)if(typeof item.name!=='string'||!Number.isFinite(Number(item.qty))||Number(item.qty)<0||!Number.isFinite(Number(item.rate))||Number(item.rate)<0)return false}
 return d.prices.every(x=>typeof x.name==='string'&&x.name.length<200&&(x.cost==null||Number.isFinite(Number(x.cost))&&Number(x.cost)>=0)&&(x.sell==null||Number.isFinite(Number(x.sell))&&Number(x.sell)>=0));}
export default {async fetch(request,env){const url=new URL(request.url),method=request.method;
 try{
  if(url.pathname.startsWith('/api/')){
   if(!env.DB||!env.APP_PASSWORD||!env.SESSION_SECRET)return json({error:'Server setup incomplete: configure D1 binding and secrets.'},503);
   if(!sameOrigin(request))return json({error:'Cross-origin operation denied'},403);
   if(url.pathname==='/api/login' && method==='POST'){
    const ip=(request.headers.get('CF-Connecting-IP')||'unknown').slice(0,80);const windowStart=Date.now()-15*60*1000;
    const attempt=await env.DB.prepare('SELECT attempts, first_at FROM login_attempts WHERE ip=?').bind(ip).first();
    if(attempt&&attempt.first_at>windowStart&&attempt.attempts>=10)return json({error:'Too many login attempts. Try again later.'},429);
    const body=await request.json().catch(()=>({}));const candidate=String(body.password||'');
    if(!candidate||candidate!==env.APP_PASSWORD){await env.DB.prepare('INSERT INTO login_attempts (ip, attempts, first_at) VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET attempts=CASE WHEN first_at < ? THEN 1 ELSE attempts+1 END, first_at=CASE WHEN first_at < ? THEN ? ELSE first_at END').bind(ip,Date.now(),windowStart,windowStart,Date.now()).run();return json({error:'Incorrect password'},401)}
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip=?').bind(ip).run();
    const expiry=String(Math.floor(Date.now()/1000)+SESSION_SECONDS);const token=expiry+'.'+await signature('fishtrade.'+expiry,env.SESSION_SECRET);
    return json({ok:true},200,{'Set-Cookie':`fishtrade_session=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`});
   }
   if(url.pathname==='/api/logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':'fishtrade_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'});
   if(!await authenticated(request,env))return json({error:'Please sign in to view the shared ledger.'},401);
   if(url.pathname==='/api/state'&&method==='GET'){
    const row=await env.DB.prepare('SELECT revision, data, updated_at FROM ledger WHERE id=1').first();if(!row)return json({error:'Database is empty. Run the seed migration first.'},503);
    return json({revision:row.revision,data:JSON.parse(row.data),updated_at:row.updated_at});
   }
   if(url.pathname==='/api/state'&&method==='PUT'){
    const size=Number(request.headers.get('Content-Length')||0);if(size>750000)return json({error:'Database update exceeds size limit'},413);
    const body=await request.json().catch(()=>null);if(!body||!Number.isInteger(body.revision)||!validData(body.data))return json({error:'Invalid business data'},400);
    const data=JSON.stringify(body.data);if(data.length>750000)return json({error:'Data too large for a single update'},413);
    // Revision check and update happen inside a single atomic SQLite statement.
    const result=await env.DB.prepare("UPDATE ledger SET data=?, revision=revision+1, updated_at=datetime('now') WHERE id=1 AND revision=? RETURNING revision").bind(data,body.revision).first();
    if(!result)return json({error:'The ledger was changed by another partner. Export your unsaved data, then refresh.'},409);
    return json({ok:true,revision:result.revision});
   }
   return json({error:'Route not found'},404);
  }
  if(method!=='GET'&&method!=='HEAD')return new Response('Method Not Allowed',{status:405});
  return env.ASSETS.fetch(request);
 }catch(e){console.error(e);return json({error:'Database or service error. Check Cloudflare Workers logs.'},500)}
}};
