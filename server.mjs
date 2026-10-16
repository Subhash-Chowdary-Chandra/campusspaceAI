import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4174);
const storeFile = path.join(here, 'data', 'store.json');
const [data, sourceHtml, roomRanker] = await Promise.all([
  fs.readFile(path.join(here, 'campus-data.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(here, 'index.html'), 'utf8'),
  fs.readFile(path.join(here, 'room-ranker.json'), 'utf8').then(JSON.parse)
]);
const indexHtml = sourceHtml.replace('__ROOM_RANKER_MODEL_JSON__', JSON.stringify(roomRanker));
await fs.mkdir(path.dirname(storeFile), { recursive: true });
let store;
try { store = JSON.parse(await fs.readFile(storeFile, 'utf8')); }
catch { store = { admin: null, requests: [] }; }
store.requests ||= [];
let writes = Promise.resolve();
const sessions = new Map();
const failedLogins = new Map();
let setupToken = store.admin ? null : randomBytes(24).toString('hex');

function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  const write = writes.then(async () => {
    const temp = `${storeFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, snapshot, { mode: 0o600 });
    await fs.rename(temp, storeFile);
  });
  writes = write.catch(() => {});
  return write;
}
function json(res, code, obj, headers={}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const value = raw.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
}
function adminSession(req) {
  const key = cookie(req, 'cs_admin');
  const expiry = sessions.get(key);
  if (!key || !expiry || expiry < Date.now()) { sessions.delete(key); return false; }
  return true;
}
function setSession(res) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  res.setHeader('set-cookie', `cs_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
}
function clearSession(res) { res.setHeader('set-cookie', 'cs_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); }
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw Object.assign(new Error('Cross-origin request blocked.'), { status: 403 });
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
const clean = (x, max=160) => String(x ?? '').trim().slice(0, max);
const numeric = x => Number(x);
const overlap = (s1,d1,s2,d2) => s1 < s2 + d2 && s2 < s1 + d1;
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)); }
function roomConflict(roomId, date, start, duration, ignoreId='') {
  const wd = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  for (const c of data.schedule) if (c.room_id === roomId && c.weekday === wd && overlap(start,duration,numeric(c.start_hour),numeric(c.duration_hours))) return 'recurring class schedule';
  for (const e of data.events) {
    if (e.room_id !== roomId || e.event_id === ignoreId || String(e.start_time).slice(0,10) !== date) continue;
    const h = Number(String(e.start_time).slice(11,13));
    if (overlap(start,duration,h,numeric(e.duration_hours))) return 'scheduled event';
  }
  for (const r of store.requests) {
    if (r.id === ignoreId || r.roomId !== roomId || r.date !== date || r.status !== 'Approved') continue;
    if (overlap(start,duration,numeric(r.start),numeric(r.duration))) return 'another approved reservation';
  }
  return '';
}
function validateReservation(b) {
  const roomId = clean(b.roomId, 20), date = clean(b.date, 10);
  const start = numeric(b.start), duration = numeric(b.duration), capacity = numeric(b.capacity);
  const room = data.rooms.find(x => x.room_id === roomId);
  if (!room) throw Object.assign(new Error('That room was not found.'), { status: 400 });
  if (!validDate(date) || !Number.isInteger(start) || start < 7 || start > 20 || !Number.isInteger(duration) || duration < 1 || duration > 4) throw Object.assign(new Error('Choose a valid date and time.'), { status: 400 });
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > numeric(room.capacity)) throw Object.assign(new Error('The room does not meet the requested capacity.'), { status: 409 });
  if (b.accessible && room.accessible !== '1') throw Object.assign(new Error('This room is not marked accessible.'), { status: 409 });
  if (b.projector && room.projector !== '1') throw Object.assign(new Error('This room does not have a projector.'), { status: 409 });
  if (b.computers && room.computers !== '1') throw Object.assign(new Error('This room does not have computers.'), { status: 409 });
  const reason = roomConflict(roomId,date,start,duration,b.ignoreId || '');
  if (reason) throw Object.assign(new Error(`Room is unavailable due to ${reason}.`), { status: 409 });
  return { room, roomId, date, start, duration, capacity };
}
function sameOwner(req, token) {
  return /^[a-f0-9]{64}$/i.test(token || '') && (req.clientToken === token);
}
async function handle(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/api/health') return json(res,200,{ ok:true, reservations:store.requests.length });
    if (req.method === 'GET' && req.url === '/api/auth/status') return json(res,200,{ needsSetup:!store.admin, signedIn:adminSession(req) });
    if (req.method === 'GET' && req.url === '/api/availability') return json(res,200,{ reservations:store.requests.filter(x=>x.status==='Approved').map(({roomId,date,start,duration,id})=>({roomId,date,start,duration,id})) });
    if (req.method === 'POST' && req.url === '/api/auth/setup') {
      requireSameOrigin(req);
      if (store.admin || !setupToken) return json(res,409,{ error:'Admin access is already configured.' });
      const b=await readBody(req), email=clean(b.email,160).toLowerCase(), password=String(b.password||'');
      if (b.token !== setupToken) return json(res,401,{ error:'The one-time setup code is incorrect.' });
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || password !== b.confirm) return json(res,400,{ error:'Use a valid email and matching passphrases of at least 12 characters.' });
      const salt=randomBytes(16).toString('hex');
      store.admin={ email, salt, hash:(await scrypt(password,salt,64)).toString('hex') };
      setupToken=null; await persist(); setSession(res);
      return json(res,201,{ ok:true });
    }
    if (req.method === 'POST' && req.url === '/api/auth/login') {
      requireSameOrigin(req);
      const ip=req.socket.remoteAddress||'local', now=Date.now(), hits=(failedLogins.get(ip)||[]).filter(t=>now-t<60_000);
      if (hits.length>=8) return json(res,429,{ error:'Too many attempts. Wait one minute and try again.' });
      const b=await readBody(req), email=clean(b.email,160).toLowerCase(), password=String(b.password||'');
      if (!store.admin || email!==store.admin.email) { hits.push(now);failedLogins.set(ip,hits);return json(res,401,{ error:'Email or passphrase is incorrect.' }); }
      const candidate=await scrypt(password,store.admin.salt,64), expected=Buffer.from(store.admin.hash,'hex');
      if (candidate.length!==expected.length || !timingSafeEqual(candidate,expected)) { hits.push(now);failedLogins.set(ip,hits);return json(res,401,{ error:'Email or passphrase is incorrect.' }); }
      failedLogins.delete(ip);setSession(res);return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && req.url === '/api/auth/logout') { requireSameOrigin(req);sessions.delete(cookie(req,'cs_admin'));clearSession(res);return json(res,200,{ok:true}); }
    if (req.url?.startsWith('/api/requests')) {
      if (req.method === 'GET' && req.url === '/api/requests') {
        if (adminSession(req)) return json(res,200,{ requests:store.requests.map(({clientToken,...x})=>x) });
        const token=req.headers['x-client-token'];
        if (!/^[a-f0-9]{64}$/i.test(token||'')) return json(res,401,{error:'Local request key is missing.'});
        return json(res,200,{requests:store.requests.filter(x=>sameOwner(x,token)).map(({clientToken,...x})=>x)});
      }
      if (req.method === 'POST' && req.url === '/api/requests') {
        requireSameOrigin(req);const token=req.headers['x-client-token'];
        if (!/^[a-f0-9]{64}$/i.test(token||'')) return json(res,400,{error:'Local request key is invalid.'});
        const b=await readBody(req), v=validateReservation(b);
        const name=clean(b.name,80), group=clean(b.group,100), email=clean(b.email,160);
        if (!name || !group || !/^\S+@\S+\.\S+$/.test(email)) return json(res,400,{error:'Enter your name, group, and a valid contact email.'});
        const item={id:`CS-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`,roomId:v.roomId,building:v.room.building,roomType:v.room.room_type,date:v.date,start:v.start,duration:v.duration,capacity:v.capacity,purpose:clean(b.purpose,40),accessible:!!b.accessible,projector:!!b.projector,computers:!!b.computers,name,group,email,status:'Pending',createdAt:new Date().toISOString(),clientToken:token};
        store.requests.unshift(item);await persist();const {clientToken,...publicItem}=item;return json(res,201,{request:publicItem});
      }
      const statusMatch=req.url.match(/^\/api\/requests\/([A-Za-z0-9-]+)\/status$/);
      if (req.method === 'PATCH' && statusMatch) {
        requireSameOrigin(req);if (!adminSession(req)) return json(res,401,{error:'Admin sign-in required.'});
        const b=await readBody(req), next=clean(b.status,20);
        if (!['Approved','Declined'].includes(next)) return json(res,400,{error:'Choose Approved or Declined.'});
        const item=store.requests.find(x=>x.id===statusMatch[1]);if(!item)return json(res,404,{error:'Request not found.'});
        if(next==='Approved')validateReservation({...item,ignoreId:item.id});
        item.status=next;item.reviewedAt=new Date().toISOString();await persist();
        const {clientToken,...publicItem}=item;return json(res,200,{request:publicItem});
      }
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(indexHtml);
    }
    json(res,404,{error:'Not found.'});
  } catch (err) {
    if (err instanceof URIError) return json(res,400,{error:'Invalid request.'});
    console.error(err);
    json(res,err.status||500,{error:err.status?err.message:'The reservation service encountered an error.'});
  }
}
const server=http.createServer((req,res)=>{void handle(req,res);});
server.listen(port,host,()=>{
  console.log(`CampusSpace live demo: http://${host}:${port}`);
  console.log('Reservation records are stored on this computer in data/store.json.');
  if(setupToken)console.log(`One-time admin setup code: ${setupToken}`);
});
