/* =========================================================
   LEWYS HUB — Slack et Notion
   Chaque personne relie son propre compte. Les accès restent sur le serveur du Hub.
   - Slack : lire ses conversations et y répondre depuis le Hub, notifications des nouveaux messages.
   - Notion : parcourir et lire ses pages dans le Hub (lecture seule).
   Mira peut LIRE Slack et Notion ; elle ne peut rien y écrire.
   ========================================================= */
const APP_ICON = { slack:'https://www.google.com/s2/favicons?domain=slack.com&sz=64', notion:'https://www.google.com/s2/favicons?domain=notion.so&sz=64' };
const mdInline = t => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  .replace(/\[([^\]]+)\]\(((?:https?|mailto):[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>').replace(/\n/g, '<br>');

const plainMd = t => String(t || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|`/g, '');   // aperçus : texte sans mise en forme
const Apps = {
  conn(){ return (Remote.on && Remote.conn) || {} },
  slackOn(){ return !!this.conn().slack }, notionOn(){ return !!this.conn().notion },
  async refresh(){ try{ Remote.conn = await Remote.req('GET', '/conn') }catch(e){} return this.conn() },
  /* Ouvre la fenêtre d'autorisation Slack ou Notion (au clic), puis attend son retour */
  async connect(prov){
    const w = window.open('about:blank', 'lewysHubOAuth', 'width=620,height=760');
    if(!w) throw new Error('La fenêtre de connexion a été bloquée par le navigateur : autorisez les fenêtres pour le Hub.');
    try{ w.location.href = (await Remote.req('GET', '/oauth/' + prov + '/start')).url }catch(e){ w.close(); throw e }
    await new Promise(res => { const done = () => { removeEventListener('message', on); clearInterval(t); res() };
      const on = e => { if(e.origin === location.origin && e.data && e.data.lewysHub === 'oauth') done() };
      const t = setInterval(() => { if(w.closed) done() }, 700); addEventListener('message', on) });
    const c = await this.refresh(); if(!c[prov]) throw new Error('Le compte n’a pas été relié.');
    if(prov === 'slack') SlackMod.start();
  },
  async disconnect(prov){ await Remote.req('DELETE', '/conn/' + prov); await this.refresh(); if(prov === 'slack') SlackMod.stop() },
  lost(e){ if(e && e.status === 428){ this.refresh().then(() => { Shell.refresh() }) } },

  /* Bloc ajouté à « Mes connexions » */
  connHTML(){
    const c = this.conn(), row = (prov, name, sub, on, label, ready) => `<div class="conn">
      <div class="conn-h"><span class="conn-logo"><img src="${APP_ICON[prov]}" alt=""></span><div><b>${name}</b><small>${sub}</small></div><span class="dotchip ${on ? 'ok' : 'off'}">${on ? 'Connecté' : 'Non connecté'}</span></div>
      ${on ? `<p class="note" style="margin:10px 0">${label}</p><button class="btn danger" type="button" data-appoff="${prov}">Déconnecter ${name}</button>`
        : !Remote.on ? `<p class="note">Disponible une fois le Hub en ligne.</p>`
        : !ready ? `<p class="note">${isAdmin() ? `Renseignez d’abord les identifiants ${name} dans <a href="#/admin/connexions" data-appcfg>Administration → Connexions</a>.` : `${name} n’est pas encore activé : demandez à votre administrateur.`}</p>`
        : `<button class="btn" type="button" data-appon="${prov}">Connecter mon compte ${name}</button>`}
      <div class="err" data-apperr="${prov}"></div></div>`;
    return row('slack', 'Slack', 'Vos conversations dans le Hub, avec les notifications', !!c.slack, c.slack ? `Compte : <b>${esc(c.slack.name || 'vous')}</b> · espace ${esc(c.slack.team)}` : '', c.slackReady)
      + row('notion', 'Notion', 'Lu par Mira pour ses réponses et le point du jour (lecture seule)', !!c.notion, c.notion ? `Espace : <b>${esc(c.notion.workspace)}</b>` : '', c.notionReady);
  },
  wireConn(root, redraw){
    root.querySelectorAll('[data-appcfg]').forEach(a => a.onclick = closeModal);
    root.querySelectorAll('[data-appon]').forEach(b => b.onclick = async () => { const p = b.dataset.appon, er = root.querySelector(`[data-apperr="${p}"]`); er.textContent = '';
      try{ await this.connect(p); toast((p === 'slack' ? 'Slack' : 'Notion') + ' est connecté'); redraw(); route() }catch(e){ er.textContent = e.message } });
    root.querySelectorAll('[data-appoff]').forEach(b => b.onclick = async () => { try{ await this.disconnect(b.dataset.appoff) }catch(e){} redraw(); route() });
  },
  cta(prov, text){ const name = prov === 'slack' ? 'Slack' : 'Notion', c = this.conn(), ready = prov === 'slack' ? c.slackReady : c.notionReady;
    return `<div class="gcta"><img src="${APP_ICON[prov]}" alt="" style="width:24px;height:24px"><div><b>Connectez votre compte ${name}</b><span>${!Remote.on ? 'Disponible une fois le Hub en ligne.' : ready ? text : isAdmin() ? 'Renseignez d’abord les identifiants dans Administration → Connexions.' : 'Pas encore activé : demandez à votre administrateur.'}</span></div>${Remote.on ? '<button class="btn sm" data-openconn>Mes connexions</button>' : ''}</div>` },
  /* Contexte ajouté au point du jour de Mira */
  async briefContext(){
    const out = {};
    if(this.slackOn()) out.slack_non_lus = SlackMod.unread.map(u => ({ conversation:u.name, messages:u.messages.slice(-3).map(m => m.name + ' : ' + m.text.slice(0, 160)) }));
    if(this.notionOn()){ try{ const r = await Remote.req('GET', '/notion/search'); out.notion_pages_modifiees_recemment = r.results.filter(x => Date.now() - new Date(x.edited) < 3 * 864e5).slice(0, 12).map(x => ({ titre:x.title, modifie:x.edited })) }catch(e){} }
    return out;
  }
};

/* =========================================================
   SLACK
   ========================================================= */
const SlackMod = {
  convs:null, teamId:'', cur:null, msgs:[], unread:[], known:new Set(), first:true, _t:null, _c:null,
  seen(){ return UStore.get('slackSeen', {}) },
  setSeen(id, ts){ const s = this.seen(); if(!s[id] || ts > s[id]){ s[id] = ts; UStore.set('slackSeen', s) } },
  start(){ this.stop(); if(!Apps.slackOn()) return; this.first = true; this.known = new Set(); this.poll(); this._t = setInterval(() => this.poll(), 75000) },
  stop(){ clearInterval(this._t); clearInterval(this._c); this._t = this._c = null; this.unread = []; this.convs = null; this.cur = null; const n = document.getElementById('notifs'); if(n) n.innerHTML = '' },
  count(){ return this.unread.reduce((s, u) => s + u.messages.length, 0) },
  async poll(){
    if(!Apps.slackOn() || document.hidden) return;
    let r; try{ r = await Remote.req('GET', '/slack/feed') }catch(e){ Apps.lost(e); this.error = e.message; this.first = false; this.renderHome(); return }
    this.error = (r.errors && r.errors.length) ? r.errors.join(' · ') : ''; this.checked = r.checked; this.total = r.total;
    this.teamId = r.teamId || this.teamId; const seen = this.seen();
    this.unread = (r.unread || []).map(u => Object.assign({}, u, { messages:u.messages.filter(m => !(seen[u.id] && m.ts <= seen[u.id])) })).filter(u => u.messages.length && u.id !== this.openId());
    // on prévient une seule fois par message, et jamais pour ceux déjà en attente à la connexion
    this.unread.forEach(u => u.messages.forEach(m => { const k = u.id + '|' + m.ts; if(this.known.has(k)) return; this.known.add(k); if(!this.first) this.notify(u, m) })); this.first = false;
    Shell.refresh(); this.renderHome(); if(location.hash.startsWith('#/slack')) this.paintList();
  },
  openId(){ return location.hash.startsWith('#/slack') && this.cur ? this.cur.id : null },
  notify(u, m){
    const box = document.getElementById('notifs'); if(!box) return;
    const el = document.createElement('button'); el.className = 'notif';
    el.innerHTML = `<img src="${APP_ICON.slack}" alt=""><span><b>${esc(m.name)}${u.kind === 'im' ? '' : ' · ' + esc((u.kind === 'mpim' ? '' : '#') + u.name)}</b><span>${esc(plainMd(m.text).slice(0, 140) || (m.files.length ? 'Fichier partagé' : 'Nouveau message'))}</span></span><i aria-label="Fermer">${ic('x')}</i>`;
    el.onclick = e => { el.remove(); if(!e.target.closest('i')) location.hash = '#/slack/' + u.id };
    box.appendChild(el); while(box.children.length > 4) box.firstChild.remove(); setTimeout(() => el.remove(), 12000);
  },
  label(c){ return c.kind === 'im' || c.kind === 'mpim' ? esc(c.name) : (c.kind === 'private' ? ic('lock') : '<i class="hash">#</i>') + esc(c.name) },
  renderHome(){
    const el = document.getElementById('homeSlack'); if(!el) return;
    if(!Apps.slackOn()){ el.innerHTML = ''; return }
    el.innerHTML = `<div class="card infos"><div class="sec-head"><div><div class="eyebrow">Slack</div><h2>Messages non lus</h2></div><a class="btn ghost sm" href="#/slack">Ouvrir Slack</a></div>
      ${this.unread.length ? this.unread.slice(0, 6).map(u => { const m = u.messages[u.messages.length - 1];
        return `<a class="ml" href="#/slack/${u.id}"><span class="ml-av">${esc(initials(u.kind === 'im' ? u.name : m.name))}</span><span class="ml-b"><b>${this.label(u)}</b><span>${u.kind === 'im' ? '' : esc(m.name) + ' : '}${esc(plainMd(m.text).slice(0, 120) || 'Fichier partagé')}</span></span><em class="sl-n">${u.messages.length}${u.more ? '+' : ''}</em></a>` }).join('')
      : `<p class="quiet">${this.first ? 'Chargement…' : 'Aucun nouveau message.'}</p>`}
      ${this.error ? `<p class="note" style="margin:10px 0 0;color:var(--danger)">Slack n’a pas pu être consulté entièrement : ${esc(this.error)}</p>` : ''}</div>`;
  },
  async renderPage(id){
    Shell.head('Messagerie', 'Slack', Apps.slackOn() ? 'Espace ' + Apps.conn().slack.team + ' · vos conversations, sans quitter le Hub.' : 'Vos conversations Slack dans le Hub.', Apps.slackOn() && this.teamId ? `<a class="btn white sm" href="https://app.slack.com/client/${esc(this.teamId)}" target="_blank" rel="noopener">Ouvrir Slack ${ic('ext')}</a>` : '');
    const slot = document.getElementById('pageSlot'); clearInterval(this._c);
    if(!Apps.slackOn()){ slot.innerHTML = `<main class="wrap mod"><div class="card pad">${Apps.cta('slack', 'Pour lire vos conversations et y répondre depuis le Hub.')}</div><p class="note" style="margin-top:14px">Slack n’autorise pas l’affichage de son application à l’intérieur d’un autre site : le Hub affiche donc vos conversations lui-même, à partir de votre compte.</p></main>`;
      slot.querySelectorAll('[data-openconn]').forEach(b => b.onclick = () => Connexions.open()); return }
    slot.innerHTML = `<main class="sl"><aside class="sl-list" id="slList"><div class="empty"><span class="dots"><i></i><i></i><i></i></span></div></aside>
      <section class="sl-main" id="slMain"><div class="empty" style="margin:auto">Choisissez une conversation.</div></section></main>`;
    try{ if(!this.convs){ const r = await Remote.req('GET', '/slack/convs'); this.convs = r.convs; this.teamId = r.teamId } }
    catch(e){ Apps.lost(e); document.getElementById('slList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    if(!location.hash.startsWith('#/slack')) return;
    this.cur = this.convs.find(c => c.id === id) || (id ? null : (this.unread[0] && this.convs.find(c => c.id === this.unread[0].id)) || this.convs[0]) || null;
    this.paintList(); if(this.cur) this.openConv();
  },
  paintList(){
    const el = document.getElementById('slList'); if(!el || !this.convs) return;
    const un = {}; this.unread.forEach(u => un[u.id] = u.messages.length);
    const grp = (title, list) => list.length ? `<h4>${title}</h4>` + list.map(c => `<a class="sl-c ${this.cur && this.cur.id === c.id ? 'on' : ''} ${un[c.id] ? 'un' : ''}" href="#/slack/${c.id}"><span>${this.label(c)}</span>${un[c.id] ? `<em>${un[c.id]}</em>` : ''}</a>`).join('') : '';
    el.innerHTML = grp('Messages directs', this.convs.filter(c => c.kind === 'im' || c.kind === 'mpim')) + grp('Canaux', this.convs.filter(c => c.kind === 'channel' || c.kind === 'private')) || '<div class="empty">Aucune conversation.</div>';
  },
  async openConv(){
    const c = this.cur, el = document.getElementById('slMain');
    el.innerHTML = `<div class="sl-head"><b>${this.label(c)}</b><span class="spacer"></span><button class="btn ghost sm" id="slAsk">${ic('spark')} Demander à Mira</button><a class="btn ghost sm" href="https://app.slack.com/client/${esc(this.teamId)}/${esc(c.id)}" target="_blank" rel="noopener">Dans Slack ${ic('ext')}</a></div>
      <div class="sl-msgs" id="slMsgs"><div class="empty"><span class="dots"><i></i><i></i><i></i></span></div></div>
      <form class="sl-form" id="slForm"><textarea id="slInput" rows="1" placeholder="Écrire dans ${esc(c.name)}…"></textarea><button class="mira-send" title="Envoyer">${ic('send')}</button></form>`;
    document.getElementById('slAsk').onclick = () => Mira.open('Résume-moi cette conversation Slack et dis-moi ce que je dois faire : ');
    const inp = document.getElementById('slInput');
    inp.onkeydown = e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('slForm').requestSubmit() } };
    document.getElementById('slForm').onsubmit = async e => { e.preventDefault(); const text = inp.value.trim(); if(!text) return; inp.disabled = true;
      try{ await Remote.req('POST', '/slack/send', { channel:c.id, text }); inp.value = ''; await this.loadMsgs(true) }catch(err){ toast('Message non envoyé : ' + err.message); Apps.lost(err) }
      inp.disabled = false; inp.focus() };
    await this.loadMsgs(true);
    clearInterval(this._c); this._c = setInterval(() => { if(this.openId() === c.id && !document.hidden) this.loadMsgs(false); else if(!location.hash.startsWith('#/slack')) clearInterval(this._c) }, 15000);
  },
  async loadMsgs(scroll){
    const c = this.cur, box = document.getElementById('slMsgs'); if(!c || !box) return;
    let r; try{ r = await Remote.req('GET', '/slack/history?channel=' + encodeURIComponent(c.id)) }catch(e){ Apps.lost(e); if(scroll) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    if(this.cur !== c || !box.isConnected) return;
    const sig = r.messages.length + ':' + (r.messages.length ? r.messages[r.messages.length - 1].ts : ''); if(!scroll && sig === this._sig) return; this._sig = sig;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80; let day = '';
    box.innerHTML = r.messages.map(m => { const d = new Date(+m.ts * 1000), dk = d.toDateString(), sep = dk !== day ? `<div class="sl-day"><span>${sameDay(d, new Date()) ? 'Aujourd’hui' : d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' })}</span></div>` : ''; day = dk;
      return sep + `<div class="sl-m ${m.mine ? 'mine' : ''}"><span class="ml-av">${esc(initials(m.name))}</span><div><p class="sl-who"><b>${esc(m.name)}</b><time>${d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' })}</time></p><div class="sl-t">${mdInline(m.text)}${m.files.map(f => `<span class="sl-f">${ic('file')} ${esc(f)}</span>`).join('')}${m.thread ? `<span class="sl-th">${m.thread} réponse${m.thread > 1 ? 's' : ''} dans le fil</span>` : ''}</div></div></div>` }).join('') || '<div class="empty">Aucun message pour le moment.</div>';
    if(scroll || near) box.scrollTop = box.scrollHeight;
    if(r.messages.length){ this.setSeen(c.id, r.messages[r.messages.length - 1].ts); this.unread = this.unread.filter(u => u.id !== c.id); this.paintList(); Shell.refresh() }
  }
};

/* =========================================================
   NOTION (lecture seule)
   ========================================================= */
const NotionMod = {
  stack:[], q:'',
  async renderPage(){
    const on = Apps.notionOn(), top = this.stack[this.stack.length - 1];
    Shell.head('Base de connaissances', 'Notion', on ? 'Espace ' + Apps.conn().notion.workspace + ' · consultation dans le Hub.' : 'Vos pages Notion dans le Hub.', top && top.url ? `<a class="btn white sm" href="${esc(top.url)}" target="_blank" rel="noopener">Modifier dans Notion ${ic('ext')}</a>` : '');
    const slot = document.getElementById('pageSlot');
    if(!on){ slot.innerHTML = `<main class="wrap mod"><div class="card pad">${Apps.cta('notion', 'Pour parcourir vos pages dans le Hub et laisser Mira les lire.')}</div><p class="note" style="margin-top:14px">Notion n’autorise pas l’affichage de son application à l’intérieur d’un autre site : le Hub affiche donc vos pages lui-même, en lecture. Pour modifier une page, un bouton l’ouvre dans Notion.</p></main>`;
      slot.querySelectorAll('[data-openconn]').forEach(b => b.onclick = () => Connexions.open()); return }
    if(!top) return this.list(slot);
    slot.innerHTML = `<main class="wrap mod"><div class="card nt-page"><div class="dr-crumb"><a href="#" data-nb="-1">Notion</a>${this.stack.map((s, i) => ic('chev') + (i === this.stack.length - 1 ? `<b>${esc(s.title)}</b>` : `<a href="#" data-nb="${i}">${esc(s.title)}</a>`)).join('')}</div><div id="ntBody"><div class="empty"><span class="dots"><i></i><i></i><i></i></span> Chargement…</div></div></div></main>`;
    slot.querySelectorAll('[data-nb]').forEach(a => a.onclick = e => { e.preventDefault(); this.stack = this.stack.slice(0, +a.dataset.nb + 1); this.renderPage() });
    let r; try{ r = await Remote.req('GET', '/notion/' + (top.type === 'database' ? 'db' : 'page') + '?id=' + encodeURIComponent(top.id)) }
    catch(e){ Apps.lost(e); const b = document.getElementById('ntBody'); if(b) b.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    const body = document.getElementById('ntBody'); if(!body || this.stack[this.stack.length - 1] !== top) return;
    if(!top.url && r.url){ top.url = r.url; top.title = r.title; return this.renderPage() }
    body.innerHTML = `<h1 class="nt-title">${r.icon ? `<span>${esc(r.icon)}</span>` : ''}${esc(r.title)}</h1><p class="small">Modifié le ${new Date(r.edited).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' })} · <a href="#" id="ntAsk">Demander à Mira</a></p>` +
      (top.type === 'database' ? this.dbHTML(r) : `<div class="nt-doc">${this.blocks(r.blocks) || '<p class="quiet">Cette page est vide.</p>'}</div>${r.truncated ? '<p class="note">Page très longue : seul le début est affiché. Ouvrez-la dans Notion pour la suite.</p>' : ''}`);
    document.getElementById('ntAsk').onclick = e => { e.preventDefault(); Mira.open('À partir de cette page Notion : ') };
    body.querySelectorAll('[data-nid]').forEach(a => a.onclick = e => { e.preventDefault(); this.stack.push({ id:a.dataset.nid, type:a.dataset.nt, title:a.dataset.ntitle || 'Page' }); this.renderPage(); window.scrollTo(0, 0) });
  },
  async list(slot){
    slot.innerHTML = `<main class="wrap mod"><div class="card dr"><div class="dr-top"><b style="color:var(--nuit)">${this.q ? 'Résultats' : 'Pages modifiées récemment'}</b><label class="pr-search">${ic('search')}<input id="ntQ" type="search" placeholder="Rechercher dans Notion…" value="${esc(this.q)}"></label></div>
      <div id="ntList"><div class="empty"><span class="dots"><i></i><i></i><i></i></span> Chargement…</div></div></div>
      <p class="note lock">${ic('lock')} <span>Lecture seule : le Hub et Mira consultent vos pages sans jamais les modifier. Seules les pages que vous avez partagées avec le Hub lors de la connexion sont visibles.</span></p></main>`;
    const q = document.getElementById('ntQ'); q.onkeydown = e => { if(e.key === 'Enter'){ this.q = q.value.trim(); this.renderPage() } }; q.onsearch = () => { if(!q.value && this.q){ this.q = ''; this.renderPage() } };
    let r; try{ r = await Remote.req('GET', '/notion/search' + (this.q ? '?q=' + encodeURIComponent(this.q) : '')) }catch(e){ Apps.lost(e); const l = document.getElementById('ntList'); if(l) l.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    const l = document.getElementById('ntList'); if(!l) return;
    l.innerHTML = r.results.length ? `<div class="dr-rows">${r.results.map(x => `<button class="dr-row nt-row" data-nid="${esc(x.id)}" data-nt="${x.type}" data-ntitle="${esc(x.title)}" data-nurl="${esc(x.url || '')}"><span class="nt-ic">${x.icon ? esc(x.icon) : ic(x.type === 'database' ? 'reports' : 'file')}</span><b>${esc(x.title)}</b><span>${x.type === 'database' ? 'Base de données' : 'Page'}</span><time>${new Date(x.edited).toLocaleDateString('fr-FR', { day:'numeric', month:'short', year:'numeric' })}</time></button>`).join('')}</div>` : '<div class="empty">Aucune page trouvée. Vérifiez que les pages sont bien partagées avec le Hub dans Notion.</div>';
    l.querySelectorAll('[data-nid]').forEach(b => b.onclick = () => { this.stack = [{ id:b.dataset.nid, type:b.dataset.nt, title:b.dataset.ntitle, url:b.dataset.nurl }]; this.renderPage() });
  },
  dbHTML(r){ return `<div class="scroll-x"><table class="t"><thead><tr><th>Nom</th>${r.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.rows.map(x => `<tr><td><a href="#" data-nid="${esc(x.id)}" data-nt="page" data-ntitle="${esc(x.title)}"><b>${x.icon ? esc(x.icon) + ' ' : ''}${esc(x.title)}</b></a></td>${x.props.map(p => `<td>${esc(p)}</td>`).join('')}</tr>`).join('') || `<tr><td class="quiet">Aucune ligne.</td></tr>`}</tbody></table></div>${r.more ? '<p class="note">Seules les 60 premières lignes sont affichées.</p>' : ''}` },
  blocks(list){
    let out = '', open = '';
    const close = () => { if(open){ out += '</' + open + '>'; open = '' } };
    (list || []).forEach(b => {
      const kids = b.children ? this.blocks(b.children) : '', t = mdInline(b.text || '');
      const li = b.t === 'bulleted_list_item' ? 'ul' : b.t === 'numbered_list_item' ? 'ol' : '';
      if(li){ if(open !== li){ close(); out += '<' + li + '>'; open = li } out += `<li>${t}${kids}</li>`; return }
      close();
      switch(b.t){
        case 'heading_1': out += `<h2>${t}</h2>${kids}`; break; case 'heading_2': out += `<h3>${t}</h3>${kids}`; break; case 'heading_3': out += `<h4>${t}</h4>${kids}`; break;
        case 'paragraph': out += (t ? `<p>${t}</p>` : '<p class="nt-sp"></p>') + (kids ? `<div class="nt-in">${kids}</div>` : ''); break;
        case 'to_do': out += `<p class="nt-todo ${b.checked ? 'ok' : ''}"><i>${b.checked ? ic('check') : ''}</i><span>${t}</span></p>${kids ? `<div class="nt-in">${kids}</div>` : ''}`; break;
        case 'toggle': out += `<details><summary>${t}</summary><div class="nt-in">${kids}</div></details>`; break;
        case 'quote': out += `<blockquote>${t}${kids}</blockquote>`; break;
        case 'callout': out += `<div class="nt-call"><span>${esc(b.icon || '💡')}</span><div>${t}${kids}</div></div>`; break;
        case 'code': out += `<pre><code>${esc(String(b.text || '').replace(/^`|`$/g, ''))}</code></pre>`; break;
        case 'divider': out += '<hr>'; break;
        case 'image': out += b.url ? `<figure><img src="${esc(b.url)}" alt="" loading="lazy">${b.text ? `<figcaption>${esc(b.text)}</figcaption>` : ''}</figure>` : ''; break;
        case 'bookmark': case 'embed': case 'link_preview': case 'file': case 'pdf': case 'video': out += b.url ? `<p><a class="nt-link" href="${esc(b.url)}" target="_blank" rel="noopener">${ic('ext')} ${esc(b.text || b.url)}</a></p>` : ''; break;
        case 'child_page': case 'child_database': out += `<p><a class="nt-sub" href="#" data-nid="${esc(b.id)}" data-nt="${b.t === 'child_database' ? 'database' : 'page'}" data-ntitle="${esc(b.text)}">${ic(b.t === 'child_database' ? 'reports' : 'file')} ${esc(b.text)}</a></p>`; break;
        case 'table': out += `<div class="scroll-x"><table class="t">${(b.children || []).map(r => `<tr>${(r.cells || []).map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</table></div>`; break;
        case 'column_list': case 'column': case 'synced_block': out += kids; break;
        default: if(t || kids) out += `<p>${t}</p>${kids}`;
      }
    });
    close(); return out;
  }
};

/* =========================================================
   Mira : outils de LECTURE Slack et Notion
   ========================================================= */
Mira.TOOLS.push(
  { name:'slack_non_lus', description:'Liste les messages Slack non lus de l’utilisateur (messages directs et canaux), en lecture seule.', input_schema:{ type:'object', properties:{} } },
  { name:'slack_conversations', description:'Liste les conversations Slack de l’utilisateur (canaux et messages directs) avec leur identifiant.', input_schema:{ type:'object', properties:{} } },
  { name:'slack_lire_conversation', description:'Lit les 50 derniers messages d’une conversation Slack à partir de son identifiant (lecture seule).', input_schema:{ type:'object', properties:{ id:{ type:'string' } }, required:['id'] } },
  { name:'notion_rechercher', description:'Recherche des pages et bases de données dans le Notion de l’utilisateur (lecture seule). Requête vide = pages modifiées récemment.', input_schema:{ type:'object', properties:{ requete:{ type:'string' } } } },
  { name:'notion_lire', description:'Lit le contenu d’une page Notion à partir de son identifiant (lecture seule). Pour une base de données, indiquer type = "database".', input_schema:{ type:'object', properties:{ id:{ type:'string' }, type:{ type:'string', enum:['page', 'database'] } }, required:['id'] } }
);
Object.assign(Mira.LABELS, { slack_non_lus:'Lecture de vos messages Slack…', slack_conversations:'Consultation de Slack…', slack_lire_conversation:'Lecture d’une conversation Slack…', notion_rechercher:'Recherche dans Notion…', notion_lire:'Lecture d’une page Notion…' });
Mira.toolAllowed = t => /^(gmail|drive|agenda)_/.test(t.name) ? Google.ready() : /^slack_/.test(t.name) ? Apps.slackOn() : /^notion_/.test(t.name) ? Apps.notionOn() : true;
(function(){
  const exec0 = Mira.exec, sys0 = Mira.system;
  Mira.exec = async (name, a) => {
    switch(name){
      case 'slack_non_lus': return (await Remote.req('GET', '/slack/feed')).unread.map(u => ({ conversation:u.name, id:u.id, messages:u.messages.map(m => ({ de:m.name, heure:new Date(+m.ts * 1000).toISOString(), texte:m.text })) }));
      case 'slack_conversations': return (await Remote.req('GET', '/slack/convs')).convs;
      case 'slack_lire_conversation': return (await Remote.req('GET', '/slack/history?channel=' + encodeURIComponent(a.id))).messages.map(m => ({ de:m.name, heure:new Date(+m.ts * 1000).toISOString(), texte:m.text, fichiers:m.files }));
      case 'notion_rechercher': return (await Remote.req('GET', '/notion/search' + (a.requete ? '?q=' + encodeURIComponent(a.requete) : ''))).results;
      case 'notion_lire': { const r = await Remote.req('GET', '/notion/' + (a.type === 'database' ? 'db' : 'page') + '?id=' + encodeURIComponent(a.id));
        return a.type === 'database' ? { titre:r.title, colonnes:r.cols, lignes:r.rows.map(x => ({ id:x.id, nom:x.title, valeurs:x.props })) } : { titre:r.title, lien:r.url, modifie:r.edited, texte:r.text } }
    }
    return exec0(name, a);
  };
  Mira.system = function(){ const s = Apps.slackOn(), n = Apps.notionOn();
    return sys0.call(this) + '\n\nAutres sources : ' + (s ? 'son Slack est connecté (lecture des conversations).' : 'Slack non connecté.') + ' ' + (n ? 'Son Notion est connecté (recherche et lecture des pages) : pense à y chercher les procédures, fiches clients et comptes rendus.' : 'Notion non connecté.') + ' Tu ne peux ni envoyer de message Slack ni modifier une page Notion.' };
})();

/* Administration : identifiants Slack et Notion (saisis une fois par l'administrateur) */
async function adminApps(){
  const el = document.getElementById('adminApps'); if(!el) return;
  if(!Remote.on){ el.innerHTML = '<h2 style="font-size:20px;margin-top:28px">Slack et Notion</h2><p class="note">Disponible une fois le Hub en ligne.</p>'; return }
  let c; try{ c = await Remote.req('GET', '/integrations') }catch(e){ el.innerHTML = `<p class="note">${esc(e.message)}</p>`; return }
  const f = (id, label, val, ph, pw) => `<div><label class="lbl">${label}</label><input class="input" id="${id}" ${pw ? 'type="password" autocomplete="off"' : ''} value="${esc(val)}" placeholder="${ph}"></div>`;
  el.innerHTML = `<h2 style="font-size:20px;margin-top:28px">Slack</h2>
    <p class="note">Pour que chacun relie son compte Slack, créez une application Slack interne, une seule fois.</p>
    <div class="row2">${f('slId', 'Client ID', c.slackClientId, '1234567890.1234567890')}${f('slSec', 'Client Secret', '', c.slackSecret ? 'Déjà enregistré — laisser vide pour le conserver' : 'Collez le Client Secret', true)}</div>
    <details class="howto"><summary>Comment créer l’application Slack (10 minutes)</summary><ol>
      <li>Ouvrez <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> → « Create New App » → « From scratch », nom « Lewys Hub », dans votre espace Slack.</li>
      <li>Menu « OAuth & Permissions » → « Redirect URLs » : ajoutez <code>${esc(c.redirectSlack)}</code> puis « Save URLs ».</li>
      <li>Plus bas, dans « <b>User</b> Token Scopes », ajoutez : <code>${esc(c.slackScopes.split(',').join(', '))}</code></li>
      <li>Menu « Basic Information » : copiez « Client ID » et « Client Secret » et collez-les ci-dessus.</li></ol></details>
    <h2 style="font-size:20px;margin-top:28px">Notion</h2>
    <p class="note">Notion n’est pas affiché dans le Hub : il sert uniquement de source à Mira, qui peut y chercher et y lire (jamais modifier). Pour que chacun relie son Notion, créez une intégration Notion publique, une seule fois.</p>
    <div class="row2">${f('noId', 'OAuth client ID', c.notionClientId, 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}${f('noSec', 'OAuth client secret', '', c.notionSecret ? 'Déjà enregistré — laisser vide pour le conserver' : 'Collez le client secret', true)}</div>
    <details class="howto"><summary>Comment créer l’intégration Notion (10 minutes)</summary><ol>
      <li>Ouvrez <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener">notion.so/profile/integrations</a> → « New integration », nom « Lewys Hub », type <b>Public</b>.</li>
      <li>Dans « Capabilities », cochez uniquement <b>Read content</b> (aucun droit de modification).</li>
      <li>Dans « Redirect URIs », ajoutez <code>${esc(c.redirectNotion)}</code></li>
      <li>Copiez « OAuth client ID » et « OAuth client secret » et collez-les ci-dessus.</li></ol></details>
    <div style="margin-top:14px"><button class="btn" id="appsSave">Enregistrer Slack et Notion</button></div>
    <p class="note lock" style="margin-top:14px">${ic('lock')} <span>Les « secrets » sont conservés sur le serveur du Hub et ne sont plus jamais affichés. Mira peut lire Slack et Notion, jamais y écrire. Dans Slack, c’est vous qui envoyez vos messages depuis le Hub.</span></p>`;
  document.getElementById('appsSave').onclick = async () => { const v = i => document.getElementById(i).value.trim();
    try{ await Remote.req('PUT', '/integrations', { slackClientId:v('slId'), slackClientSecret:v('slSec'), notionClientId:v('noId'), notionClientSecret:v('noSec') }); await Apps.refresh(); toast('Identifiants enregistrés'); adminApps() }catch(e){ toast(e.message) } };
}
