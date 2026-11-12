/* Stockage en ligne : Netlify Blobs (inclus dans Netlify, aucun compte supplémentaire) */
import { getStore } from '@netlify/blobs';

export function blobKv(){
  const s = getStore({ name:'lewys-hub', consistency:'strong' });
  return {
    async get(key){ const r = await s.getWithMetadata(key, { type:'json' }); return r && r.data != null ? { value:r.data, etag:r.etag } : null },
    async set(key, value, o = {}){
      const opt = {}; if(o.ifMatch) opt.onlyIfMatch = o.ifMatch; if(o.ifNew) opt.onlyIfNew = true;
      const r = await s.setJSON(key, value, opt); return !r || r.modified !== false;
    }
  };
}
