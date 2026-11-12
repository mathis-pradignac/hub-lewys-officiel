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
  async function sign(obj){ const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return p + '.' + crypto.createHmac('sha256', await secret()).update(p).digest('base64url') }
  async function unsign(t){
    const [p, sig] = String(t || '').split('.');
    if(!p || !sig) throw new HttpError(401, 'Connexion requise.');
    const good = crypto.createHmac('sha256', await secret()).update(p).digest('base64url');
    if(sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) throw new HttpError(401, 'Session invalide.');
    let d; try{ d = JSON.parse(Buffer.from(p, 'base64url').toString()) }catch(e){ throw new HttpError(401, 'Session invalide.') }
    if(!d.e || d.e < Date.now()) throw new HttpError(401, 'Session expirée : reconnectez-vous.');
    return d;
  }
  const makeToken = uid => sign({ u:uid, e:Date.now() + SESSION_HOURS * 3600e3 });
  async function auth(req){
    const d = await unsign((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if(d.p) throw new HttpError(401, 'Session invalide.');   // un jeton de connexion Slack/Notion n'ouvre pas de session
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
    return { me:me.id, hub:pubHub(h, me), tracking:mine, suivi:{ data:su.data, v:su.v }, notes, conn:pubConn(await getv('conn/' + me.id, {}), await getv('integrations', {})), now:Date.now() };
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


  /* =========================================================
     SLACK & NOTION — comptes personnels reliés au Hub
     Les jetons d'accès restent sur le serveur : le navigateur ne les voit jamais.
     ========================================================= */
  const SLACK_SCOPES = 'channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history,users:read,chat:write';
  const pubConn = (c, cfg) => ({ slack:c.slack ? { name:c.slack.name, team:c.slack.team, teamId:c.slack.teamId } : null, notion:c.notion ? { workspace:c.notion.workspace } : null,
    slackReady:!!(cfg.slackClientId && cfg.slackClientSecret), notionReady:!!(cfg.notionClientId && cfg.notionClientSecret) });
  const gone = prov => new HttpError(428, (prov === 'slack' ? 'Slack' : 'Notion') + ' : reconnectez votre compte dans « Mes connexions ».');
  async function token(me, prov){ const c = (await getv('conn/' + me.id, {}))[prov]; if(!c || !c.token) throw gone(prov); return c }
  async function slack(tk, method, params = {}){
    const r = await fetchImpl('https://slack.com/api/' + method, { method:'POST', signal:AbortSignal.timeout(8000), headers:{ authorization:'Bearer ' + tk, 'content-type':'application/x-www-form-urlencoded' }, body:new URLSearchParams(params).toString() });
    const j = await r.json().catch(() => ({ ok:false, error:'réponse illisible' }));
    if(!j.ok){ if(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'token_expired'].includes(j.error)) throw gone('slack'); throw new HttpError(j.error === 'ratelimited' ? 429 : 502, 'Slack : ' + j.error) }
    return j;
  }
  async function notion(tk, path, body){
    const r = await fetchImpl('https://api.notion.com/v1' + path, { method:body ? 'POST' : 'GET', signal:AbortSignal.timeout(8000), headers:{ authorization:'Bearer ' + tk, 'notion-version':'2022-06-28', 'content-type':'application/json' }, body:body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if(!r.ok){ if(r.status === 401) throw gone('notion'); throw new HttpError(r.status === 404 ? 404 : 502, 'Notion : ' + (j.message || r.status)) }
    return j;
  }
  /* ----- Slack : noms des personnes, conversations, messages ----- */
  async function slackUsers(c){
    const key = 'slackusers/' + c.teamId, cur = await getv(key); if(cur && Date.now() - cur.at < 30 * 60e3) return cur.map;
    const map = {}; let cursor = '';
    for(let i = 0; i < 5; i++){ const j = await slack(c.token, 'users.list', Object.assign({ limit:'500' }, cursor ? { cursor } : {}));
      (j.members || []).forEach(u => { map[u.id] = (u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name || u.name });
      cursor = j.response_metadata && j.response_metadata.next_cursor; if(!cursor) break }
    await update(key, () => ({ at:Date.now(), map }), null).catch(() => {}); return map;
  }
  async function slackConvs(c, users){
    const out = []; let cursor = '';
    for(let i = 0; i < 3; i++){ const j = await slack(c.token, 'users.conversations', Object.assign({ types:'public_channel,private_channel,mpim,im', exclude_archived:'true', limit:'200' }, cursor ? { cursor } : {}));
      (j.channels || []).forEach(ch => { if(ch.is_im && ch.user === 'USLACKBOT') return;
        out.push({ id:ch.id, kind:ch.is_im ? 'im' : ch.is_mpim ? 'mpim' : ch.is_private ? 'private' : 'channel',
          name:ch.is_im ? (users[ch.user] || 'Message direct') : ch.is_mpim ? String(ch.name || '').replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').map(n => n).join(', ') : ch.name }) });
      cursor = j.response_metadata && j.response_metadata.next_cursor; if(!cursor) break }
    const rank = { im:0, mpim:1, channel:2, private:2 };
    return out.sort((a, b) => rank[a.kind] - rank[b.kind] || String(a.name).localeCompare(String(b.name), 'fr'));
  }
  const slackText = (t, users) => String(t || '').replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (m, id) => '@' + (users[id] || 'quelqu’un')).replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1').replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '[$2]($1)').replace(/<((?:https?|mailto):[^>]+)>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, '$1**$2**').replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1*$2*');   // gras et italique façon Slack
  const slackMsg = (m, users, meId) => ({ ts:m.ts, user:m.user || m.bot_id || '', name:users[m.user] || m.username || (m.bot_profile && m.bot_profile.name) || 'Application', mine:m.user === meId,
    text:slackText(m.text, users) || (m.files && m.files.length ? '' : (m.attachments && m.attachments[0] && (m.attachments[0].fallback || m.attachments[0].text)) || ''), files:(m.files || []).map(f => f.name || f.title || 'fichier').slice(0, 5), thread:m.reply_count || 0 });
  const keepMsg = m => !m.subtype || ['thread_broadcast', 'file_share', 'bot_message', 'me_message'].includes(m.subtype);
  const batches = async (items, n, fn) => { const out = []; for(let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(x => fn(x).catch(() => null)))); return out };

  /* ----- Notion : texte et blocs simplifiés ----- */
  const rich = a => (a || []).map(t => { let s = t.plain_text || ''; if(!s.trim()) return s; const an = t.annotations || {};
    if(an.code) s = '`' + s + '`'; if(an.bold) s = '**' + s + '**'; if(an.italic) s = '*' + s + '*'; if(t.href && /^https?:/.test(t.href)) s = '[' + s + '](' + t.href + ')'; return s }).join('');
  const plain = a => (a || []).map(t => t.plain_text || '').join('');
  const nTitle = o => o.object === 'database' ? plain(o.title) : plain(((Object.values(o.properties || {}).find(p => p.type === 'title') || {}).title)) ;
  const nItem = o => ({ id:o.id, type:o.object, title:nTitle(o) || 'Sans titre', icon:o.icon && o.icon.type === 'emoji' ? o.icon.emoji : '', url:o.url, edited:o.last_edited_time });
  const nProp = p => { if(!p) return ''; const v = p[p.type];
    switch(p.type){ case 'select': case 'status': return v ? v.name : ''; case 'multi_select': return (v || []).map(x => x.name).join(', '); case 'date': return v ? v.start + (v.end ? ' → ' + v.end : '') : '';
      case 'people': return (v || []).map(x => x.name || '').filter(Boolean).join(', '); case 'number': return v == null ? '' : String(v); case 'checkbox': return v ? 'oui' : 'non';
      case 'rich_text': return plain(v).slice(0, 120); case 'url': case 'email': case 'phone_number': return v || ''; default: return '' } };
  async function nBlocks(tk, id, depth, budget){
    const out = []; let cursor = '';
    for(let i = 0; i < 3 && budget.n > 0; i++){
      const j = await notion(tk, '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : ''));
      for(const b of (j.results || [])){ if(budget.n-- <= 0) break; const d = b[b.type] || {}, x = { t:b.type };
        if(d.rich_text) x.text = rich(d.rich_text);
        if(b.type === 'to_do') x.checked = !!d.checked;
        if(b.type === 'child_page' || b.type === 'child_database'){ x.id = b.id; x.text = d.title || 'Sans titre' }
        if(b.type === 'image' || b.type === 'file' || b.type === 'pdf' || b.type === 'video'){ x.url = (d.external && d.external.url) || (d.file && d.file.url) || ''; x.text = plain(d.caption) }
        if(b.type === 'bookmark' || b.type === 'embed' || b.type === 'link_preview'){ x.url = d.url || ''; x.text = plain(d.caption) }
        if(b.type === 'code') x.lang = d.language || '';
        if(b.type === 'callout') x.icon = d.icon && d.icon.type === 'emoji' ? d.icon.emoji : '';
        if(b.type === 'table_row') x.cells = (d.cells || []).map(rich);
        if(b.has_children && depth > 0 && b.type !== 'child_page' && b.type !== 'child_database') x.children = await nBlocks(tk, b.id, depth - 1, budget).catch(() => []);
        out.push(x) }
      cursor = j.has_more ? j.next_cursor : ''; if(!cursor) break }
    return out;
  }
  const nText = (blocks, ind = '') => blocks.map(b => { const pre = { heading_1:'# ', heading_2:'## ', heading_3:'### ', bulleted_list_item:'- ', numbered_list_item:'1. ', to_do:b.checked ? '[x] ' : '[ ] ', quote:'> ', child_page:'[Sous-page] ', child_database:'[Base de données] ' }[b.t] || '';
    const line = b.t === 'table_row' ? (b.cells || []).join(' | ') : (b.text || b.url || ''); return (line ? ind + pre + line + '\n' : '') + (b.children ? nText(b.children, ind + '  ') : '') }).join('');

  async function appsPublic(parts, url){   // retour de la fenêtre de connexion Slack / Notion (sans session : l'identité est dans le jeton signé)
    const prov = parts[1], page = (ok, msg) => new Response(`<!doctype html><meta charset="utf-8"><title>Lewys Hub</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#F7F7FB;color:#1D1D1B"><div style="text-align:center;max-width:420px;padding:24px"><h2 style="margin:0 0 8px">${ok ? 'Compte connecté' : 'Connexion impossible'}</h2><p style="color:#6B6B73;line-height:1.5">${msg}</p></div><script>try{window.opener&&window.opener.postMessage({lewysHub:'oauth',provider:${JSON.stringify(prov)},ok:${ok ? 'true' : 'false'}},location.origin)}catch(e){}${ok ? 'setTimeout(function(){window.close()},900)' : ''}</script>`, { status:200, headers:{ 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' } });
    try{
      if(url.searchParams.get('error')) return page(false, 'L’autorisation a été refusée ou annulée. Vous pouvez fermer cette fenêtre.');
      const st = await unsign(url.searchParams.get('state')); if(st.p !== prov) throw new Error('état invalide');
      const cfg = await getv('integrations', {}), code = url.searchParams.get('code'), redirect = url.origin + '/api/oauth/' + prov + '/callback'; let c;
      if(prov === 'slack'){
        const r = await fetchImpl('https://slack.com/api/oauth.v2.access', { method:'POST', signal:AbortSignal.timeout(8000), headers:{ 'content-type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ client_id:cfg.slackClientId, client_secret:cfg.slackClientSecret, code, redirect_uri:redirect }).toString() });
        const j = await r.json(); if(!j.ok || !j.authed_user || !j.authed_user.access_token) throw new Error(j.error || 'réponse inattendue');
        c = { token:j.authed_user.access_token, userId:j.authed_user.id, team:(j.team && j.team.name) || 'Slack', teamId:(j.team && j.team.id) || '', name:'' };
        try{ c.name = (await slackUsers(c))[c.userId] || '' }catch(e){}
      } else {
        const r = await fetchImpl('https://api.notion.com/v1/oauth/token', { method:'POST', signal:AbortSignal.timeout(8000), headers:{ 'content-type':'application/json', authorization:'Basic ' + Buffer.from(cfg.notionClientId + ':' + cfg.notionClientSecret).toString('base64') }, body:JSON.stringify({ grant_type:'authorization_code', code, redirect_uri:redirect }) });
        const j = await r.json(); if(!r.ok || !j.access_token) throw new Error(j.error_description || j.error || 'réponse inattendue');
        c = { token:j.access_token, workspace:j.workspace_name || 'Notion' };
      }
      await update('conn/' + st.u, cur => { cur[prov] = c; return cur }, {});
      return page(true, 'Vous pouvez revenir au Hub : cette fenêtre se ferme toute seule.');
    }catch(e){ return page(false, 'Le compte n’a pas pu être relié (' + str(e.message, 120).replace(/[<>&]/g, '') + '). Fermez cette fenêtre et réessayez depuis « Mes connexions ».') }
  }

  async function appsRoutes(me, parts, m, url, body){
    const [a, b, c] = parts;
    if(a === 'integrations' && m === 'PUT'){ needAdmin(me); const inc = await body();
      const next = await update('integrations', cur => { ['slackClientId', 'notionClientId'].forEach(k => { if(inc[k] !== undefined) cur[k] = str(inc[k], 200).trim() });
        ['slackClientSecret', 'notionClientSecret'].forEach(k => { if(inc[k]) cur[k] = str(inc[k], 300).trim() }); return cur }, {});
      return json({ slackClientId:next.slackClientId || '', notionClientId:next.notionClientId || '', slackSecret:!!next.slackClientSecret, notionSecret:!!next.notionClientSecret });
    }
    if(a === 'integrations' && m === 'GET'){ needAdmin(me); const cur = await getv('integrations', {});
      return json({ slackClientId:cur.slackClientId || '', notionClientId:cur.notionClientId || '', slackSecret:!!cur.slackClientSecret, notionSecret:!!cur.notionClientSecret, redirectSlack:url.origin + '/api/oauth/slack/callback', redirectNotion:url.origin + '/api/oauth/notion/callback', slackScopes:SLACK_SCOPES }) }
    if(a === 'oauth' && c === 'start' && m === 'GET'){
      const cfg = await getv('integrations', {}), state = await sign({ u:me.id, p:b, e:Date.now() + 10 * 60e3 }), redirect = url.origin + '/api/oauth/' + b + '/callback';
      if(b === 'slack'){ if(!cfg.slackClientId || !cfg.slackClientSecret) throw new HttpError(400, 'Slack n’est pas encore configuré par l’administrateur.');
        return json({ url:'https://slack.com/oauth/v2/authorize?' + new URLSearchParams({ client_id:cfg.slackClientId, user_scope:SLACK_SCOPES, redirect_uri:redirect, state }) }) }
      if(b === 'notion'){ if(!cfg.notionClientId || !cfg.notionClientSecret) throw new HttpError(400, 'Notion n’est pas encore configuré par l’administrateur.');
        return json({ url:'https://api.notion.com/v1/oauth/authorize?' + new URLSearchParams({ client_id:cfg.notionClientId, response_type:'code', owner:'user', redirect_uri:redirect, state }) }) }
    }
    if(a === 'conn' && m === 'GET') return json(pubConn(await getv('conn/' + me.id, {}), await getv('integrations', {})));
    if(a === 'conn' && m === 'DELETE' && ['slack', 'notion'].includes(b)){ await update('conn/' + me.id, cur => { delete cur[b]; return cur }, {}); return json({ ok:true }) }

    if(a === 'slack'){
      const c0 = await token(me, 'slack'), users = await slackUsers(c0);
      if(b === 'convs' && m === 'GET') return json({ convs:await slackConvs(c0, users), me:c0.userId, teamId:c0.teamId });
      if(b === 'history' && m === 'GET'){ const ch = url.searchParams.get('channel'); if(!/^[A-Z0-9]{6,20}$/.test(ch || '')) throw new HttpError(400, 'Conversation inconnue.');
        const j = await slack(c0.token, 'conversations.history', { channel:ch, limit:'50' });
        return json({ messages:(j.messages || []).filter(keepMsg).map(x => slackMsg(x, users, c0.userId)).reverse() }) }
      if(b === 'send' && m === 'POST'){ const inc = await body(); if(!/^[A-Z0-9]{6,20}$/.test(inc.channel || '') || !String(inc.text || '').trim()) throw new HttpError(400, 'Message vide.');
        const j = await slack(c0.token, 'chat.postMessage', { channel:inc.channel, text:str(inc.text, 4000) }); return json({ ts:j.ts }) }
      if(b === 'feed' && m === 'GET'){   // messages non lus : messages directs d'abord, puis canaux
        const convs = await slackConvs(c0, users), pickd = [...convs.filter(x => x.kind === 'im' || x.kind === 'mpim').slice(0, 20), ...convs.filter(x => x.kind === 'channel' || x.kind === 'private').slice(0, 15)];
        const res = await batches(pickd, 12, async cv => { const info = (await slack(c0.token, 'conversations.info', { channel:cv.id })).channel || {};
          if(info.unread_count_display === 0) return null;
          const last = info.last_read && info.last_read !== '0000000000.000000' ? info.last_read : String(Date.now() / 1000 - 86400);
          if(info.latest && info.latest.ts && info.latest.ts <= last) return null;
          const h = await slack(c0.token, 'conversations.history', { channel:cv.id, oldest:last, limit:'6' });
          const msgs = (h.messages || []).filter(x => keepMsg(x) && x.user !== c0.userId).map(x => slackMsg(x, users, c0.userId)).reverse();
          return msgs.length ? Object.assign({}, cv, { messages:msgs, more:!!h.has_more }) : null });
        return json({ unread:res.filter(Boolean), teamId:c0.teamId, at:Date.now() });
      }
    }

    if(a === 'notion'){
      const c0 = await token(me, 'notion'), id = String(url.searchParams.get('id') || '').replace(/[^0-9a-f-]/gi, '');
      if(b === 'search' && m === 'GET'){ const q = str(url.searchParams.get('q'), 200);
        const j = await notion(c0.token, '/search', Object.assign({ page_size:40, sort:{ direction:'descending', timestamp:'last_edited_time' } }, q ? { query:q } : {}));
        return json({ results:(j.results || []).map(nItem) }) }
      if(b === 'page' && m === 'GET' && id){ const pg = await notion(c0.token, '/pages/' + id), budget = { n:300 }, blocks = await nBlocks(c0.token, id, 2, budget);
        return json(Object.assign(nItem(pg), { blocks, text:str(nText(blocks), 20000), truncated:budget.n <= 0 })) }
      if(b === 'db' && m === 'GET' && id){ const [db, q] = await Promise.all([notion(c0.token, '/databases/' + id), notion(c0.token, '/databases/' + id + '/query', { page_size:60 })]);
        const cols = Object.keys(db.properties || {}).filter(k => db.properties[k].type !== 'title').slice(0, 5);
        return json(Object.assign(nItem(db), { cols, rows:(q.results || []).map(r => Object.assign(nItem(r), { props:cols.map(k => nProp(r.properties[k])) })), more:!!q.has_more })) }
    }
    return null;
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

    if(a === 'oauth' && c === 'callback' && m === 'GET') return appsPublic(parts, url);

    const me = await auth(req);
    { const r = await appsRoutes(me, parts, m, url, body); if(r) return r }

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
