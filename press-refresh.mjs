/* Tâche planifiée : met à jour la revue de presse toutes les heures */
import { createApi } from '../lib/core.mjs';
import { blobKv } from '../lib/store.mjs';

export default async () => { await createApi(blobKv()).refreshPress(); return new Response('ok') };
export const config = { schedule:'@hourly' };
