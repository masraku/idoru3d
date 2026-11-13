#!/usr/bin/env node
/**
 * Sinkronkan daftar member JKT48 dari sumber resmi ke jkt48-members.js.
 *
 *   node sync-jkt48.mjs                      # ambil dari API resmi, tulis file
 *   node sync-jkt48.mjs --dry-run            # hanya tampilkan apa yang akan berubah
 *   node sync-jkt48.mjs --from-file data.json
 *       pakai file JSON hasil simpan dari https://jkt48.com/api/v1/members?lang=id
 *       (untuk saat situsnya menolak permintaan dari Node)
 *   node sync-jkt48.mjs --force              # tetap jalan walau jumlah member turun drastis
 *
 * Sumber: API JSON publik yang dipakai halaman https://jkt48.com/member.
 * Yang diambil: ID resmi, nama, nama panggilan, tim, URL profil, dan URL foto.
 *
 * Aman dijalankan berulang: member yang ada diperbarui, yang baru ditambahkan,
 * dan yang hilang dari daftar resmi ditandai `active: false` (tidak dihapus).
 * Tidak ada daftar nama yang ditulis tetap di sini; jumlah member mengikuti sumber.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const API_URL = 'https://jkt48.com/api/v1/members?lang=id';
export const PROFILE_BASE = 'https://jkt48.com/member/detail?member=';
export const PHOTO_BASE = 'https://wsrv.nl/?url=https://jkt48.com/api/v1/storages/media/jkt48-member/';
export const TEAM_ORDER = ['LOVE', 'DREAM', 'PASSION', 'TRAINEE'];
const OUT_FILE = fileURLToPath(new URL('./jkt48-members.js', import.meta.url));
const PREFIX = 'window.JKT48_MEMBERS=';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Buat handle foto dari nama member: "Abigail Rachel" → "abigail_rachel" */
export function photoHandle(name) {
  return clean(name).toLowerCase().replace(/\s+/g, '_');
}

/** Buat URL foto lengkap dari handle. */
export function photoUrl(name) {
  return PHOTO_BASE + photoHandle(name) + '.jpg';
}

export function profileSlug(name, id) {
  const base = clean(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base}-${id}`;
}

/** Terima badan respons API ({data: [...]}) atau array langsung. */
export function parseRemote(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) throw new Error('Format data sumber tidak dikenali: tidak ada array member.');

  const seen = new Set();
  const members = [];
  for (const row of rows) {
    const name = clean(row?.name);
    const rawId = row?.jkt48_member_id;
    if (!name || rawId === undefined || rawId === null || rawId === '') continue;
    const id = String(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    members.push({
      id,
      name,
      nickname: clean(row.nickname) || null,
      team: clean(row.type).toUpperCase() || null,
      profileUrl: PROFILE_BASE + profileSlug(name, id),
      photoUrl: photoUrl(name),
    });
  }
  if (members.length === 0) {
    throw new Error('Sumber mengembalikan 0 member. Dibatalkan supaya tidak menonaktifkan semua member.');
  }
  return members;
}

/** Gabungkan daftar resmi dengan isi file sebelumnya. Tidak menulis apa pun. */
export function merge(previous, remote, today) {
  const prevById = new Map(previous.map((m) => [String(m.id), m]));
  const report = { added: [], updated: [], reactivated: [], deactivated: [], unchanged: 0 };
  const members = [];

  for (const m of remote) {
    const prev = prevById.get(m.id);
    prevById.delete(m.id);
    if (!prev) {
      members.push({ ...m, active: true, addedAt: today });
      report.added.push(m.name);
      continue;
    }
    const changed = ['name', 'nickname', 'team', 'profileUrl', 'photoUrl'].filter((k) => (prev[k] ?? null) !== (m[k] ?? null));
    const next = { ...prev, ...m, active: true };
    delete next.inactiveSince;
    if (prev.active === false) report.reactivated.push(m.name);
    else if (changed.length > 0) report.updated.push(`${m.name}: ${changed.join(', ')}`);
    else report.unchanged += 1;
    members.push(next);
  }

  for (const prev of prevById.values()) {
    if (prev.active !== false) report.deactivated.push(prev.name);
    members.push({ ...prev, active: false, inactiveSince: prev.inactiveSince || today });
  }

  members.sort((a, b) => a.name.localeCompare(b.name, 'id'));
  return { members, report };
}

async function readPrevious() {
  let text;
  try {
    text = await readFile(OUT_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const start = text.indexOf(PREFIX);
  if (start < 0) throw new Error('jkt48-members.js ada tetapi isinya tidak dikenali. Periksa dulu sebelum menimpa.');
  const json = text.slice(start + PREFIX.length).trim().replace(/;$/, '');
  const data = JSON.parse(json);
  return Array.isArray(data.members) ? data.members : [];
}

function serialize(members, syncedAt) {
  const lines = members.map((m) => JSON.stringify(m)).join(',\n');
  return (
    '/* Dibuat otomatis oleh sync-jkt48.mjs dari daftar resmi JKT48. Jangan diedit manual. */\n' +
    `${PREFIX}{"source":"https://jkt48.com/member","syncedAt":${JSON.stringify(syncedAt)},"members":[\n${lines}\n]};\n`
  );
}

async function fetchRemote() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(API_URL, {
      headers: { accept: 'application/json', 'accept-language': 'id' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Sumber menolak permintaan (HTTP ${res.status}).`);
    return parseRemote(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, fromFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--from-file') args.fromFile = argv[++i];
    else throw new Error(`Opsi tidak dikenal: ${argv[i]}`);
  }
  return args;
}

function printList(title, rows) {
  console.log(`${title} (${rows.length})`);
  for (const row of rows) console.log(`  - ${row}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let remote;
  if (args.fromFile) {
    remote = parseRemote(JSON.parse(await readFile(args.fromFile, 'utf8')));
    console.log(`Sumber: file ${args.fromFile}`);
  } else {
    try {
      remote = await fetchRemote();
    } catch (error) {
      throw new Error(
        `${error.message}\nKalau situsnya menolak permintaan dari Node, buka ${API_URL} di browser, ` +
          'simpan isinya sebagai file .json, lalu jalankan lagi dengan --from-file <path>.'
      );
    }
    console.log(`Sumber: ${API_URL}`);
  }

  const perTeam = {};
  for (const m of remote) perTeam[m.team || 'LAINNYA'] = (perTeam[m.team || 'LAINNYA'] || 0) + 1;
  const teams = [...TEAM_ORDER, ...Object.keys(perTeam).filter((t) => !TEAM_ORDER.includes(t))].filter((t) => perTeam[t]);
  console.log(`Member di sumber resmi: ${remote.length} (${teams.map((t) => `${t} ${perTeam[t]}`).join(', ')})`);

  const previous = await readPrevious();
  const previousActive = previous.filter((m) => m.active !== false).length;
  console.log(`Member di jkt48-members.js sekarang: ${previous.length} (${previousActive} aktif)\n`);

  if (!args.force && previousActive >= 10 && remote.length < previousActive / 2) {
    throw new Error(
      `Sumber hanya mengembalikan ${remote.length} member, padahal ${previousActive} aktif tercatat. ` +
        'Kemungkinan respons tidak lengkap. Jalankan dengan --force kalau ini memang benar.'
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const { members, report } = merge(previous, remote, today);

  printList('Ditambahkan', report.added);
  printList('Diperbarui', report.updated);
  printList('Aktif kembali', report.reactivated);
  printList('Ditandai nonaktif', report.deactivated);
  console.log(`Tidak berubah (${report.unchanged})`);

  if (args.dryRun) {
    console.log('\nDry-run: file tidak ditulis.');
    return;
  }
  await writeFile(OUT_FILE, serialize(members, today), 'utf8');
  console.log(`\nDitulis: jkt48-members.js (${members.length} member, ${members.filter((m) => m.active).length} aktif).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\nSinkronisasi gagal: ${error.message}`);
    process.exitCode = 1;
  });
}
