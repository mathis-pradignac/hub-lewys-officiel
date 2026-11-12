/* Toutes les adresses /api/* du Hub */
import { createApi } from '../lib/core.mjs';
import { blobKv } from '../lib/store.mjs';

export default async req => createApi(blobKv())(req);
export const config = { path:'/api/*' };
