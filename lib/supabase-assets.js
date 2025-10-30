import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'Zarafi';
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_TOKEN;
const SUPABASE_KEY = SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;

const ILLUSTRATION_FOLDERS = {
  '16:9': ['illustrations'],
  '9:16': ['illustrations']
};

const supabaseClient =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
      })
    : null;

const LIST_CACHE_TTL = 5 * 60 * 1000;
const FILE_CACHE_TTL = 5 * 60 * 1000;
const listCache = new Map();
const fileCache = new Map();

function ensureSupabase() {
  if (!supabaseClient) {
    throw new Error('Supabase client is not configured. Check SUPABASE_URL and keys in .env');
  }
  return supabaseClient;
}

function getCached(map, key, ttl) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(map, key, value) {
  map.set(key, { value, timestamp: Date.now() });
}

function normalizePrefix(prefix = '') {
  if (!prefix) return '';
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

async function listFilesRecursive(prefix = '') {
  const cacheKey = `list:${normalizePrefix(prefix)}`;
  const cached = getCached(listCache, cacheKey, LIST_CACHE_TTL);
  if (cached) return cached;

  const client = ensureSupabase();

  const files = [];
  const stack = [normalizePrefix(prefix)];
  while (stack.length) {
    const current = stack.pop();
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data, error } = await client.storage.from(SUPABASE_BUCKET).list(current || undefined, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' }
      });
      if (error) {
        throw new Error(`Failed to list assets under "${current || '/'}": ${error.message}`);
      }
      if (!data || !data.length) break;

      for (const entry of data) {
        const fullPath = current ? `${current}/${entry.name}` : entry.name;
        const isFile = entry.metadata && typeof entry.metadata.size === 'number';
        if (isFile) {
          files.push(fullPath);
        } else {
          stack.push(fullPath);
        }
      }

      if (data.length < limit) break;
      offset += limit;
    }
  }

  setCached(listCache, cacheKey, files);
  return files;
}

async function downloadAsset(path) {
  const cacheKey = `file:${path}`;
  const cached = getCached(fileCache, cacheKey, FILE_CACHE_TTL);
  if (cached) return cached;

  const client = ensureSupabase();
  const { data, error } = await client.storage.from(SUPABASE_BUCKET).download(path);
  if (error) {
    const details =
      error?.message || error?.error_description || error?.statusText || JSON.stringify(error);
    throw new Error(`Failed to download Supabase asset "${path}": ${details}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  setCached(fileCache, cacheKey, buffer);
  return buffer;
}

function chooseByFilename(paths, text) {
  const haystack = (text || '').toLowerCase();
  let bestPath = null;
  let bestScore = -1;

  paths.forEach((path) => {
    const filename = path.split('/').pop() || '';
    const base = filename.replace(/\.[^.]+$/, '').toLowerCase();
    const tokens = base.split(/[\s\-_]+/).filter(Boolean);
    const score = tokens.reduce((acc, token) => (haystack.includes(token) ? acc + 1 : acc), 0);
    if (score > bestScore) {
      bestScore = score;
      bestPath = path;
    }
  });

  if (!bestPath) {
    bestPath = paths[Math.floor(Math.random() * paths.length)];
  }
  return bestPath;
}

async function prepareImageBuffer(buffer, path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'svg' || ext === 'webp' || ext === 'avif' || ext === 'gif') {
    try {
      return await sharp(buffer).png().toBuffer();
    } catch {
      return buffer;
    }
  }
  return buffer;
}

export async function selectIllustrationAsset({ slide, orientation }) {
  const folders = ILLUSTRATION_FOLDERS[orientation] || ILLUSTRATION_FOLDERS['16:9'];
  let candidates = [];
  for (const folder of folders) {
    try {
      const files = await listFilesRecursive(folder);
      if (files.length) {
        candidates = files;
        break;
      }
    } catch (err) {
      // keep trying next folder
    }
  }
  if (!candidates.length) {
    candidates = await listFilesRecursive('illustrations');
  }
  if (!candidates.length) {
    throw new Error('No illustration assets found in Supabase bucket');
  }

  const haystack = `${slide.headline || ''} ${slide.bullets?.join(' ') || ''}`;
  const chosenPath = chooseByFilename(candidates, haystack);
  const buffer = await downloadAsset(chosenPath);
  const prepared = await prepareImageBuffer(buffer, chosenPath);
  return { buffer: prepared, path: chosenPath };
}

