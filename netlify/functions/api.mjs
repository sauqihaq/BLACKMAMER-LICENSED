import { getStore } from '@netlify/blobs';
import { handle } from './lib/core.mjs';

// Semua request /api/* masuk ke sini. Data disimpan di Netlify Blobs (strong consistency
// supaya perintah dari panel langsung kebaca server game, bukan versi lama).
export default async (req, context) => {
  const store = getStore({ name: 'indo-kontrol', consistency: 'strong' });
  return handle(req, { store, env: process.env, ip: context.ip });
};

export const config = { path: '/api/*' };
