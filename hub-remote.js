/* =========================================================
   LEWYS HUB — liaison avec le serveur (données partagées de l'équipe)
   En ligne (Netlify) : comptes, droits, heures, Suivi client, Budget, Groupes,
   Audit et revue de presse sont enregistrés sur le serveur et partagés.
   Hors ligne (fichier ouvert sur un poste) : le Hub reste en mode local.
   ========================================================= */
const Remote = {
  on:false, token:null, suiviV:null, suiviAt:0, TK:'lewysHub.token',
  async ping(){
    if(!/^https?:$/.test(location.protocol)) return false;
    try{ const r = await fetch('/api/ping', { cache:'no-store' }); const j = await r.json(); this.on = !!(r.ok && j.ok) }catch(e){ this.on = false }
    if(this.on){ try{ this.token = sessionStorage.getItem(this.TK) }catch(e){} }
    return this.on;
  },
  async req(method, path, body){
    const h = { 'content-type':'application/json' }; if(this.token) h.authorization = 'Bearer ' + this.token;
    let r; try{ r = await fetch('/api' + path, { method, headers:h, cache:'no-store', body: body !== undefined ? JSON.stringify(body) : undefined }) }
    catch(e){ throw new Error('Serveur injoignable. Vérifiez votre connexion internet.') }
    let j = {}; try{ j = await r.json() }catch(e){}
    if(r.status === 401 && this.token && path !== '/login'){ this.token = null; try{ sessionStorage.removeItem(this.TK) }catch(e){} if(ME){ toast('Session expirée : reconnectez-vous.'); logout() } }
    if(!r.ok){ const e = new Error(j.error || 'Erreur ' + r.status); e.status = r.status; throw e }
    return j;
  },
  /* Place les données reçues du serveur dans le Hub */
  apply(st){
    DB = Object.assign({ users:[], tools:[], feeds:[] }, st.hub, { tracking:st.tracking || {} });
    ME = DB.users.find(u => u.id === st.me) || null;
    if(st.suivi) this.cacheSuivi(st.suivi, st.now);
    if(ME && Array.isArray(st.notes)){ const a = UStore.all(); a.notes = st.notes; try{ localStorage.setItem(UStore.key(), JSON.stringify(a)) }catch(e){} }
  },
  cacheSuivi(s, now){ try{ localStorage.setItem(Suivi.KEY, JSON.stringify(s.data)) }catch(e){} this.suiviV = s.v; this.suiviAt = now || Date.now() },
  async login(login, hash){ const r = await this.req('POST', '/login', { login, hash }); this.token = r.token; try{ sessionStorage.setItem(this.TK, r.token) }catch(e){} this.apply(r.state); this.afterLoad() },
  async resume(){ if(!this.token) return false; try{ this.apply(await this.req('GET', '/state')); this.afterLoad(); return !!ME }catch(e){ return false } },
  /* Premier démarrage et mises à jour de la liste d'outils : faits par l'administrateur */
  afterLoad(){
    if(!ME || !isAdmin()) return;
    if(!DB.tools || !DB.tools.length){ DB.tools = DEFAULT_TOOLS.map(t => Object.assign({ id:uid() }, t)); DB.feeds = DEFAULT_FEEDS.map(f => Object.assign({ id:uid() }, f)); DB.teamMessage = DB.teamMessage || ''; DB.toolsVersion = TOOLS_VERSION; DB.feedsVersion = FEEDS_VERSION; DB.modesV8 = true; save() }
    else migrateDB();
  },
  logout(){ this.token = null; try{ sessionStorage.removeItem(this.TK) }catch(e){} clearTimeout(this._t) },
  /* Enregistrement (appelé par save()) */
  queueSave(){ this.dirty = true; clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 250) },
  async flush(){
    if(!ME || !this.dirty) return; this.dirty = false;
    try{
      if(isAdmin()){ const hub = Object.assign({}, DB); delete hub.tracking; await this.req('PUT', '/hub', { hub }) }
      else await this.req('PUT', '/me', { name:ME.name, title:ME.title, photo:ME.photo, hash:ME.hash });
      DB.users.forEach(u => { delete u.hash });
    }catch(e){ toast('Enregistrement impossible : ' + e.message) }
  },
  putTracking(day, entry){ return this.req('PUT', '/tracking', { day, entry }).catch(e => toast('Heures non enregistrées : ' + e.message)) },
  putNotes(notes){ clearTimeout(this._n); this._n = setTimeout(() => this.req('PUT', '/notes', { notes }).catch(() => {}), 300) },
  async getSuivi(){ const r = await this.req('GET', '/suivi'); this.cacheSuivi(r, r.now); return r.data },
  async putSuivi(data){ const r = await this.req('PUT', '/suivi', { data, base:this.suiviV, since:this.suiviAt }); this.cacheSuivi(r, r.now); return r.data },
  /* Avant d'afficher l'administration : recharge les données si un collègue a changé quelque chose */
  async freshen(){
    if(!ME || this.dirty) return false;
    try{ const st = await this.req('GET', '/state'); if(this.dirty || !ME) return false;
      const cur = Object.assign({}, DB); delete cur.tracking;
      if(JSON.stringify(cur) === JSON.stringify(st.hub) && JSON.stringify(DB.tracking || {}) === JSON.stringify(st.tracking || {})) return false;
      this.apply(st); if(!ME){ logout(); return false } Shell.refresh(); return true }catch(e){ return false }
  },
  /* Récupère régulièrement les changements faits par les collègues */
  async pull(){
    if(!ME || this.dirty || document.hidden || document.getElementById('modalSlot').innerHTML || location.hash.startsWith('#/admin')) return;
    try{ const st = await this.req('GET', '/state'); if(this.dirty || !ME) return; this.apply(st); if(!ME) return logout(); Shell.refresh(); if(document.getElementById('homeTracking') && !document.querySelector('#homeTracking :focus')) Tracking.renderHome() }catch(e){}
  },

  /* Base partagée pour Budget, Groupes et Audit (même interface que celle qu'ils utilisaient dans Claude) */
  db(app, alive){
    const cols = {};
    const col = name => cols[name] || (cols[name] = { v:null, docs:{}, subs:[], loaded:null });
    const mkDoc = (c, id) => ({ id, exists:true, data:() => JSON.parse(JSON.stringify(c.docs[id])) });
    const snap = (c, s) => { const q = s && s.q; let ids = Object.keys(c.docs);
      if(q && q.order) ids.sort((a, b) => { const x = c.docs[a][q.order], y = c.docs[b][q.order]; return (x > y ? 1 : x < y ? -1 : 0) * (q.dir === 'desc' ? -1 : 1) });
      if(q && q.limit) ids = ids.slice(0, q.limit);
      const docs = ids.map(id => mkDoc(c, id)), prev = (s && s.prev) || {}, now = {}, changes = [];
      ids.forEach(id => { now[id] = JSON.stringify(c.docs[id]); if(!(id in prev)) changes.push({ type:'added', doc:mkDoc(c, id) }); else if(prev[id] !== now[id]) changes.push({ type:'modified', doc:mkDoc(c, id) }) });
      Object.keys(prev).forEach(id => { if(!(id in now)){ const old = JSON.parse(prev[id]); changes.push({ type:'removed', doc:{ id, exists:false, data:() => old } }) } });
      if(s) s.prev = now;
      return { docs, size:docs.length, empty:!docs.length, metadata:{ fromCache:false, hasPendingWrites:false }, forEach:f => docs.forEach(f), docChanges:() => changes } };
    const fire = c => c.subs.forEach(s => { try{ s.cb(snap(c, s)) }catch(e){ console.error(e) } });
    const load = async (name, force) => { const c = col(name);
      const r = await this.req('GET', '/col/' + app + '/' + encodeURIComponent(name) + (c.v != null && !force ? '?v=' + c.v : ''));
      if(!r.same){ c.docs = r.docs || {}; c.v = r.v; return true } return false };
    const timer = setInterval(async () => { if(!alive()){ clearInterval(timer); return } if(document.hidden) return;
      for(const name in cols){ const c = cols[name]; if(!c.subs.length) continue; try{ if(await load(name)) fire(c) }catch(e){} } }, 15000);
    const query = (name, q) => ({
      orderBy:(f, dir) => query(name, Object.assign({}, q, { order:f, dir:dir || 'asc' })),
      limit:n => query(name, Object.assign({}, q, { limit:n })),
      onSnapshot:(cb, err) => { const c = col(name), s = { cb, q }; c.subs.push(s);
        load(name, true).then(() => cb(snap(c, s))).catch(e => err && err({ code:e.status === 403 ? 'permission_denied' : 'unavailable', message:e.message }));
        return () => { c.subs = c.subs.filter(x => x !== s) } },
      doc:id => ({
        set:async data => { const c = col(name); data = JSON.parse(JSON.stringify(data)); c.docs[id] = data; fire(c);
          try{ const r = await this.req('PUT', '/col/' + app + '/' + encodeURIComponent(name) + '/' + encodeURIComponent(id), { data }); if(r.v === c.v + 1) c.v = r.v }catch(e){ throw { code:'unavailable', message:e.message } } },
        delete:async () => { const c = col(name); delete c.docs[id]; fire(c);
          try{ const r = await this.req('DELETE', '/col/' + app + '/' + encodeURIComponent(name) + '/' + encodeURIComponent(id)); if(r.v === c.v + 1) c.v = r.v }catch(e){ throw { code:'unavailable', message:e.message } } },
        get:async () => { const c = col(name); await load(name).catch(() => {}); const d = c.docs[id]; return { id, exists:d !== undefined, data:() => d === undefined ? undefined : JSON.parse(JSON.stringify(d)) } }
      })
    });
    return { collection:name => query(name, null) };
  }
};
