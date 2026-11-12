/* Serveur de test local : `npm run dev` puis http://localhost:8888 (données en mémoire, perdues à l'arrêt) */
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createApi, memoryKv } from './netlify/lib/core.mjs';
const api = createApi(memoryKv()), root = path.resolve('public'), port = +process.env.PORT || 8888;
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json' };
http.createServer(async (req, res) => {
  if(req.url.startsWith('/api/')){
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await api(new Request('http://localhost' + req.url, { method:req.method, headers:req.headers, body:['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0])); if(f.endsWith(path.sep) || f === root) f = path.join(root, 'index.html');
  if(!f.startsWith(root) || !fs.existsSync(f)){ res.writeHead(404); res.end('Introuvable'); return }
  res.writeHead(200, { 'content-type':types[path.extname(f)] || 'application/octet-stream', 'cache-control':'no-cache' }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('Lewys Hub : http://localhost:' + port));
