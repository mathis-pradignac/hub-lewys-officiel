/* =========================================================
   LEWYS HUB — serveur (logique commune)
   - comptes et mots de passe vérifiés côté serveur
   - données partagées de l'équipe
   Le stockage est injecté (kv) : Netlify Blobs en ligne, mémoire pour les tests.
   kv.get(key) -> { value, etag } | null
   kv.set(key, value, { ifMatch, ifNew }) -> true si écrit, false si conflit
   ========================================================= */
import crypto from 'node:crypto';
import suiviSeed from './seed-suivi.mjs';

const ROLES = ['Administrateur', 'Revenue manager', 'Commercial', 'Communication'];
const APPS = ['budget', 'groupes', 'audit'];
const DEFAULT_ADMIN = { login:'mathis', name:'Mathis Pradignac', title:'Fondateur', password:'Lewys2026!' };
const SESSION_HOURS = 12;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
class HttpError extends Error { constructor(status, msg){ super(msg); this.status = status } }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const clientHash = pw => sha('lewys-salt::' + pw);                       // identique au calcul fait dans le navigateur
const scrypt = (h, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(String(h), salt, 32).toString('hex');
const checkPw = (h, stored) => { const [salt, hex] = String(stored || '').split(':'); if(!salt || !hex) return false;
  const a = Buffer.from(hex, 'hex'), b = crypto.scryptSync(String(h), salt, 32); return a.length === b.length && crypto.timingSafeEqual(a, b) };
const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);
const cleanLogin = v => str(v, 60).trim().toLowerCase();
const pick = (o, keys) => { const r = {}; keys.forEach(k => { if(o && o[k] !== undefined) r[k] = o[k] }); return r };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createApi(kv, opts = {}){
  const fetchImpl = opts.fetch || fetch;
  const getv = async (key, def) => { const r = await kv.get(key); return r ? r.value : def };
  /* lecture-modification-écriture sûre, même si deux personnes enregistrent en même temps */
  async function update(key, fn, init){
    for(let i = 0; i < 6; i++){
      const cur = await kv.get(key); const next = await fn(cur ? structuredClone(cur.value) : structuredClone(init));
      if(next === undefined) return cur ? cur.value : init;
      if(await kv.set(key, next, cur ? { ifMatch:cur.etag } : { ifNew:true })) return next;
    }
    throw new HttpError(409, 'Enregistrement simultané : réessayez.');
  }

  /* ---------- démarrage : premier compte administrateur, données de départ ---------- */
  async function hub(){
    const h = await getv('hub'); if(h) return h;
    return update('hub', cur => cur && cur.users ? undefined : { users:[{ id:'admin1', login:DEFAULT_ADMIN.login, name:DEFAULT_ADMIN.name, title:DEFAULT_ADMIN.title, role:'Administrateur', photo:'', mustChange:true, pw:scrypt(clientHash(DEFAULT_ADMIN.password)) }] }, null);
  }
  async function suivi(){
    const s = await getv('suivi'); if(s) return s;
    return update('suivi', cur => cur && cur.data ? undefined : { v:1, data:structuredClone(suiviSeed) }, null);
  }
  async function secret(){
    let s = await getv('secret'); if(s) return s.k;
    s = await update('secret', cur => cur && cur.k ? undefined : { k:crypto.randomBytes(32).toString('hex') }, null); return s.k;
  }

  /* ---------- sessions ---------- */
  async function makeToken(uid){ const p = Buffer.from(JSON.stringify({ u:uid, e:Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
    return p + '.' + crypto.createHmac('sha256', await secret()).update(p).digest('base64url') }
  async function auth(req){
    const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), [p, sig] = t.split('.');
    if(!p || !sig) throw new HttpError(401, 'Connexion requise.');
    const good = crypto.createHmac('sha256', await secret()).update(p).digest('base64url');
    if(sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) throw new HttpError(401, 'Session invalide.');
    let d; try{ d = JSON.parse(Buffer.from(p, 'base64url').toString()) }catch(e){ throw new HttpError(401, 'Session invalide.') }
    if(!d.e || d.e < Date.now()) throw new HttpError(401, 'Session expirée : reconnectez-vous.');
    const me = (await hub()).users.find(u => u.id === d.u); if(!me) throw new HttpError(401, 'Compte supprimé.');
    return me;
  }
  const isAdmin = u => u.role === 'Administrateur';
  const needAdmin = u => { if(!isAdmin(u)) throw new HttpError(403, 'Réservé à l’administrateur.') };
  const pubUser = u => pick(u, ['id', 'login', 'name', 'title', 'role', 'photo', 'mustChange']);
  const pubHub = (h, me) => Object.assign({}, h, { users:h.users.map(pubUser), tools:isAdmin(me) ? h.tools : (h.tools || []).filter(t => (t.roles || []).includes(me.role)) });

  async function fullState(me){
    const h = await hub(), tr = await getv('tracking', {}), su = await suivi(), notes = await getv('notes/' + me.id, []);
    const mine = {}; Object.keys(tr).forEach(k => { if(isAdmin(me) || k.endsWith('|' + me.id)) mine[k] = tr[k] });
    return { me:me.id, hub:pubHub(h, me), tracking:mine, suivi:{ data:su.data, v:su.v }, notes, now:Date.now() };
  }

  /* ---------- Suivi client : fusion sans écraser le travail des collègues ---------- */
  function mergeSuivi(cur, incoming, me, since, baseV){
    const d = cur.data, admin = isAdmin(me), now = Date.now();
    const su = d.users.find(u => u.hubId === me.id) || d.users.find(u => String(u.login).toLowerCase() === me.login);
    if(admin){ ['hotels', 'settings', 'version'].forEach(k => { if(incoming[k] !== undefined) d[k] = incoming[k] });
      if(Array.isArray(incoming.users) && incoming.users.length) d.users = incoming.users; }
    else { // un membre peut seulement s'inscrire lui-même dans la liste (rattachement à son compte du Hub)
      const mineIn = (incoming.users || []).find(u => u.hubId === me.id);
      if(mineIn){ const ex = d.users.find(u => u.id === mineIn.id); if(ex) ex.hubId = me.id; else d.users.push(Object.assign({}, mineIn, { isAdmin:false })) }
    }
    const myId = (d.users.find(u => u.hubId === me.id) || su || {}).id;
    const own = k => myId && k.split('|')[2] === myId, can = k => admin || own(k);
    const ce = d.entries = d.entries || {}, ie = incoming.entries || {};
    Object.keys(ie).forEach(k => { if(!can(k)) return; const a = ce[k], b = Object.assign({}, ie[k]); delete b._s;
      const a2 = a ? Object.assign({}, a) : null; if(a2) delete a2._s;
      if(a2 && same(a2, b)) return;                                   // inchangé
      if(a && a._s > since && !own(k)) return;                        // modifié entre-temps par son auteur : on garde
      ce[k] = Object.assign(b, { _s:now }) });
    Object.keys(ce).forEach(k => { if(ie[k] || !can(k)) return; if((ce[k]._s || 0) > since) return; delete ce[k] });
    const cs = d.submissions = d.submissions || {}, is = incoming.submissions || {};
    const canS = k => admin || (myId && k.split('|')[0] === myId);
    Object.keys(is).forEach(k => { if(canS(k) && !cs[k]) cs[k] = is[k] });
    if(baseV === cur.v) Object.keys(cs).forEach(k => { if(canS(k) && !is[k]) delete cs[k] });
    cur.v = (cur.v || 0) + 1; return cur;
  }

  /* ---------- Revue de presse : lecture des flux côté serveur ---------- */
  const unCdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  const basicEnt = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
  function parseFeed(xml){
    const out = [], blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
    for(const b of blocks){
      const tag = n => { const m = b.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i')); return m ? unCdata(m[1]) : '' };
      let link = basicEnt(tag('link')); if(!/^https?:/.test(link)){ const m = b.match(/<link[^>]*href=["']([^"']+)["']/i); link = m ? basicEnt(m[1]) : '' }
      if(!/^https?:/.test(link)) continue;
      const content = tag('content:encoded') || tag('content'), desc = tag('description') || tag('summary');
      const html = basicEnt(content + ' ' + desc);
      const m1 = b.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i), m2 = b.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*>/i), m3 = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      let img = m1 ? m1[1] : m2 && /image|\.(jpe?g|png|webp)/i.test(m2[0]) ? m2[1] : m3 ? m3[1] : '';
      img = basicEnt(img); if(!/^https?:/.test(img) || /pixel|1x1|feedburner|gravatar|emoji/i.test(img)) img = '';
      const dt = Date.parse(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date'));
      out.push({ title:str(basicEnt(tag('title')).replace(/<[^>]+>/g, ' '), 300), link, date:isNaN(dt) ? Date.now() : Math.min(dt, Date.now()),
        desc:str(basicEnt(desc || content).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 420), img });
    }
    return out;
  }
  async function getText(url, ms, maxBytes){
    const r = await fetchImpl(url, { signal:AbortSignal.timeout(ms), redirect:'follow', headers:{ 'user-agent':'Mozilla/5.0 (compatible; LewysHub/1.0; revue de presse interne)', accept:'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' } });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    let buf = Buffer.from(await r.arrayBuffer()); if(maxBytes) buf = buf.subarray(0, maxBytes);
    const cs = ((r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || buf.subarray(0, 200).toString('latin1').match(/encoding=["']([\w-]+)["']/i) || [])[1] || 'utf-8';
    try{ return new TextDecoder(cs).decode(buf) }catch(e){ return buf.toString('utf8') }
  }
  async function refreshPress(){
    const feeds = ((await hub()).feeds || []).filter(f => /^https?:/.test(f.url));
    if(!feeds.length) return getv('press', { items:[], at:0 });
    const res = await Promise.allSettled(feeds.map(async f => parseFeed(await getText(f.url, 7000)).slice(0, 25).map(i => Object.assign(i, { cat:f.cat, source:f.name }))));
    const failed = res.map((r, i) => r.status === 'rejected' ? feeds[i].name : null).filter(Boolean);
    const cur = await getv('press', { items:[], at:0 }), known = new Map(cur.items.map(i => [i.link, i]));
    res.forEach(r => { if(r.status === 'fulfilled') r.value.forEach(i => { const o = known.get(i.link); if(!o) known.set(i.link, i); else if(!o.img && i.img) o.img = i.img }) });
    const items = [...known.values()].sort((a, b) => b.date - a.date).slice(0, 2000);
    // photo manquante dans le flux : on lit l'image d'illustration de l'article
    const todo = items.filter(i => !i.img && !i.noImg && !/news\.google\.com/.test(i.link)).slice(0, 8);
    await Promise.allSettled(todo.map(async i => { try{ const h = await getText(i.link, 4000, 250000);
      const m = h.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
      if(m && /^https?:/.test(basicEnt(m[1]))) i.img = basicEnt(m[1]); else i.noImg = true }catch(e){ i.noImg = true } }));
    return update('press', c => ({ items, at:res.some(r => r.status === 'fulfilled') ? Date.now() : (c && c.at) || 0, tried:Date.now(), failed, since:(c && c.since) || Date.now() }), { items:[], at:0 });
  }

  /* ---------- routes ---------- */
  async function handle(req){
    const url = new URL(req.url), parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent), m = req.method;
    const body = async () => { try{ return await req.json() }catch(e){ throw new HttpError(400, 'Requête illisible.') } };
    const [a, b, c, d] = parts;

    if(a === 'ping') return json({ ok:true });

    if(a === 'login' && m === 'POST'){
      const { login, hash } = await body(), lg = cleanLogin(login);
      const fails = await getv('fails', {}), f = fails[lg];
      if(f && f.until > Date.now()) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
      const u = (await hub()).users.find(x => x.login === lg);
      if(!u || !checkPw(hash, u.pw)){
        await update('fails', all => { const x = all[lg] || { n:0 }; x.n++; if(x.n >= 8){ x.until = Date.now() + 5 * 60e3; x.n = 0 } all[lg] = x; return all }, {});
        throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
      }
      if(f) await update('fails', all => { delete all[lg]; return all }, {});
      return json({ token:await makeToken(u.id), state:await fullState(u) });
    }

    const me = await auth(req);

    if(a === 'state' && m === 'GET') return json(await fullState(me));

    if(a === 'hub' && m === 'PUT'){
      needAdmin(me); const inc = (await body()).hub || {};
      const next = await update('hub', cur => {
        const seen = new Set(), users = [];
        for(const u of (inc.users || [])){
          const old = cur.users.find(x => x.id === u.id), lg = cleanLogin(u.login); if(!lg || seen.has(lg)) continue; seen.add(lg);
          const role = ROLES.includes(u.role) ? u.role : (old ? old.role : 'Revenue manager');
          const r = old ? Object.assign({}, old, { login:lg, role }) : { id:str(u.id, 40), login:lg, name:str(u.name), title:str(u.title), role, photo:'', mustChange:true };
          if(old && u.id === me.id) Object.assign(r, { name:str(u.name) || old.name, title:str(u.title), photo:str(u.photo, 400000), mustChange:!!u.mustChange });
          if(u.hash){ r.pw = scrypt(u.hash); if(u.id !== me.id) r.mustChange = true }
          if(r.pw && r.id) users.push(r);
        }
        if(!users.some(u => u.role === 'Administrateur')) throw new HttpError(400, 'Il faut au moins un administrateur.');
        return Object.assign({}, cur, pick(inc, ['tools', 'feeds', 'teamMessage', 'googleClientId', 'trackingRoles', 'toolsVersion', 'feedsVersion', 'modesV8']), { users });
      });
      return json({ hub:pubHub(next, next.users.find(u => u.id === me.id) || me) });
    }

    if(a === 'me' && m === 'PUT'){
      const inc = await body();
      const next = await update('hub', cur => { const u = cur.users.find(x => x.id === me.id); if(!u) throw new HttpError(401, 'Compte supprimé.');
        if(inc.name !== undefined) u.name = str(inc.name) || u.name; if(inc.title !== undefined) u.title = str(inc.title); if(inc.photo !== undefined) u.photo = str(inc.photo, 400000);
        if(inc.hash){ u.pw = scrypt(inc.hash); u.mustChange = false } return cur });
      return json({ user:pubUser(next.users.find(x => x.id === me.id)) });
    }

    if(a === 'tracking' && m === 'PUT'){
      const { day, entry } = await body(); if(!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new HttpError(400, 'Date invalide.');
      const lines = ((entry && entry.lines) || []).slice(0, 80).map(l => ({ hotelId:str(l.hotelId, 80), h:Math.max(0, Math.min(24, +l.h || 0)), note:str(l.note, 120) })).filter(l => l.hotelId && l.h > 0);
      await update('tracking', all => { all[day + '|' + me.id] = { lines, none:!!(entry && entry.none) && !lines.length, ts:Date.now() }; return all }, {});
      return json({ ok:true });
    }

    if(a === 'suivi'){
      if(m === 'GET'){ const s = await suivi(); return json({ data:s.data, v:s.v, now:Date.now() }) }
      if(m === 'PUT'){ const inc = await body(); if(!inc.data || typeof inc.data !== 'object') throw new HttpError(400, 'Données manquantes.');
        await suivi();
        const next = await update('suivi', cur => mergeSuivi(cur, inc.data, me, +inc.since || 0, inc.base));
        return json({ data:next.data, v:next.v, now:Date.now() }) }
    }

    if(a === 'notes' && m === 'PUT'){
      const notes = ((await body()).notes || []).slice(0, 300).map(n => ({ id:str(n.id, 40), text:str(n.text, 300), due:str(n.due, 10), by:n.by === 'mira' ? 'mira' : 'moi', done:!!n.done, ts:+n.ts || Date.now() }));
      await update('notes/' + me.id, () => notes, []); return json({ ok:true });
    }

    /* Budget, Groupes, Audit : documents partagés */
    if(a === 'col'){
      const app = b, coll = c, id = d;
      if(!APPS.includes(app) || !/^[\w-]{1,40}$/.test(coll || '')) throw new HttpError(400, 'Collection inconnue.');
      if(!isAdmin(me) && !((await hub()).tools || []).some(t => String(t.url).startsWith(app + '.html') && (t.roles || []).includes(me.role))) throw new HttpError(403, 'Accès non autorisé à ce module.');
      const key = 'col/' + app + '/' + coll;
      if(m === 'GET'){ const cur = await getv(key, { v:0, docs:{} }); return json(String(cur.v) === url.searchParams.get('v') ? { same:true, v:cur.v } : cur) }
      if(!id || id.length > 200) throw new HttpError(400, 'Document inconnu.');
      if(m === 'PUT'){ const data = (await body()).data; const next = await update(key, cur => { cur.docs[id] = data; cur.v = (cur.v || 0) + 1; return cur }, { v:0, docs:{} }); return json({ v:next.v }) }
      if(m === 'DELETE'){ const next = await update(key, cur => { delete cur.docs[id]; cur.v = (cur.v || 0) + 1; return cur }, { v:0, docs:{} }); return json({ v:next.v }) }
    }

    if(a === 'press'){
      const pub = p => ({ items:p.items || [], at:p.at || 0, failed:p.failed || [], since:p.since || 0 });
      if(m === 'GET') return json(pub(await getv('press', { items:[], at:0 })));
      if(m === 'POST' && b === 'refresh'){ const cur = await getv('press', { items:[], at:0 });
        if(Date.now() - (cur.tried || 0) < 10 * 60e3) return json(pub(cur));   // au plus une actualisation toutes les 10 minutes
        return json(pub(await refreshPress())) }
    }

    throw new HttpError(404, 'Adresse inconnue.');
  }

  const api = async req => { try{ return await handle(req) }catch(e){ if(e instanceof HttpError) return json({ error:e.message }, e.status); console.error(e); return json({ error:'Erreur du serveur.' }, 500) } };
  api.refreshPress = refreshPress;
  return api;
}

/* Stockage en mémoire (tests et développement local) */
export function memoryKv(){
  const m = new Map(); let n = 0;
  return { _m:m,
    async get(k){ const r = m.get(k); return r ? { value:structuredClone(r.value), etag:r.etag } : null },
    async set(k, v, o = {}){ const r = m.get(k); if(o.ifNew && r) return false; if(o.ifMatch && (!r || r.etag !== o.ifMatch)) return false; m.set(k, { value:structuredClone(v), etag:'e' + (++n) }); return true } };
}
