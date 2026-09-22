// Storage layer with two interchangeable backends.
//
//   DATABASE_URL set  -> Postgres (Neon / Vercel Postgres / Supabase). Used on Vercel,
//                        where the filesystem is ephemeral and per-request.
//   DATABASE_URL unset -> data.json next to the project. Used for local development.
//
// Both backends expose the same async API, so the request handler never knows which is live.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  votesPerVoter: 1,
  open: true,
  title: 'Vote for your favourite',
  oneVotePerDevice: true,
  // What participants submit and what the ballot shows: 'pictures' (name + photo)
  // or 'links' (name + game name + URL, shown as a QR code to scan and play).
  mode: 'pictures',
  submissionsOpen: true
};

// ---------------------------------------------------------------- file backend
function fileStore() {
  const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data.json');
  const empty = { settings: { ...DEFAULT_SETTINGS }, candidates: [], ballots: [], voted: [] };

  let db = empty;
  if (fs.existsSync(DATA_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = {
        ...empty,
        ...saved,
        settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) }
      };
      if (!Array.isArray(db.voted)) db.voted = [];
    } catch { db = empty; }
  }
  const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

  return {
    kind: 'file',
    async init() {},
    async getSettings() { return db.settings; },
    async setSettings(patch) { Object.assign(db.settings, patch); save(); return db.settings; },

    async listCandidates() { return db.candidates; },
    async getCandidate(id) { return db.candidates.find(c => c.id === id) || null; },
    async addCandidate(c) { db.candidates.push(c); save(); return c; },
    async findCandidateByDevice(ids) {
      const clean = ids.filter(Boolean);
      return db.candidates.find(c => c.device && clean.includes(c.device)) || null;
    },
    async updateCandidate(id, patch) {
      const c = db.candidates.find(x => x.id === id);
      if (!c) return null;
      Object.assign(c, patch);
      save();
      return c;
    },
    async deleteCandidate(id) {
      db.candidates = db.candidates.filter(c => c.id !== id);
      db.ballots = db.ballots.map(b => ({ ...b, choices: b.choices.filter(x => x !== id) }));
      save();
    },

    async hasVoted(ids) { return ids.some(id => id && db.voted.includes(id)); },
    async castBallot(choices, ids, lock) {
      choices.forEach(id => { db.candidates.find(c => c.id === id).votes++; });
      db.ballots.push({ id: crypto.randomUUID(), at: Date.now(), choices, device: ids[0] || null });
      if (lock) db.voted.push(...new Set(ids.filter(id => id && !db.voted.includes(id))));
      save();
    },

    async stats() { return { ballotCount: db.ballots.length, lockedDevices: db.voted.length }; },
    async resetVotes() {
      db.candidates.forEach(c => { c.votes = 0; });
      db.ballots = [];
      db.voted = [];
      save();
    },
    async clearDevices() { db.voted = []; save(); }
  };
}

// ------------------------------------------------------------ postgres backend
function pgStore(url) {
  const { Pool } = require('pg');
  // Neon / Supabase / Vercel Postgres all terminate TLS with certs Node does not
  // ship a root for; the connection is still encrypted.
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  const q = (text, params) => pool.query(text, params);
  const row = async (text, params) => (await q(text, params)).rows[0] || null;

  let ready;
  const init = () => (ready ||= (async () => {
    await q(`CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      votes_per_voter INT NOT NULL DEFAULT 1,
      is_open BOOLEAN NOT NULL DEFAULT TRUE,
      title TEXT NOT NULL DEFAULT 'Vote for your favourite',
      one_vote_per_device BOOLEAN NOT NULL DEFAULT TRUE,
      mode TEXT NOT NULL DEFAULT 'pictures',
      submissions_open BOOLEAN NOT NULL DEFAULT TRUE
    )`);
    await q(`CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      photo TEXT NOT NULL DEFAULT '',
      votes INT NOT NULL DEFAULT 0,
      game TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      device TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Databases created before link voting existed lack these columns.
    await q(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'pictures'`);
    await q(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS submissions_open BOOLEAN NOT NULL DEFAULT TRUE`);
    await q(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT ''`);
    await q(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS link TEXT NOT NULL DEFAULT ''`);
    await q(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS device TEXT`);
    await q(`CREATE TABLE IF NOT EXISTS ballots (
      id TEXT PRIMARY KEY,
      cast_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      choices TEXT[] NOT NULL,
      device TEXT
    )`);
    // Primary key doubles as the duplicate-vote guard: a second INSERT of the
    // same device id fails, so two simultaneous requests cannot both slip through.
    await q(`CREATE TABLE IF NOT EXISTS voted_devices (
      id TEXT PRIMARY KEY,
      voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  })());

  const toSettings = r => ({
    votesPerVoter: r.votes_per_voter,
    open: r.is_open,
    title: r.title,
    oneVotePerDevice: r.one_vote_per_device,
    mode: r.mode,
    submissionsOpen: r.submissions_open
  });
  const toCandidate = r => ({
    id: r.id, name: r.name, photo: r.photo, votes: r.votes,
    game: r.game, link: r.link, device: r.device
  });

  return {
    kind: 'postgres',
    init,

    async getSettings() {
      await init();
      return toSettings(await row(`SELECT * FROM settings WHERE id = 1`));
    },
    async setSettings(patch) {
      await init();
      const cols = {
        votesPerVoter: 'votes_per_voter',
        open: 'is_open',
        title: 'title',
        oneVotePerDevice: 'one_vote_per_device',
        mode: 'mode',
        submissionsOpen: 'submissions_open'
      };
      const sets = [], vals = [];
      for (const [key, col] of Object.entries(cols)) {
        if (patch[key] !== undefined) { vals.push(patch[key]); sets.push(`${col} = $${vals.length}`); }
      }
      if (!sets.length) return this.getSettings();
      return toSettings(await row(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`, vals));
    },

    async listCandidates() {
      await init();
      const { rows } = await q(`SELECT * FROM candidates ORDER BY created_at`);
      return rows.map(toCandidate);
    },
    async getCandidate(id) {
      await init();
      const r = await row(`SELECT * FROM candidates WHERE id = $1`, [id]);
      return r && toCandidate(r);
    },
    async addCandidate(c) {
      await init();
      await q(`INSERT INTO candidates (id, name, photo, votes, game, link, device)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [c.id, c.name, c.photo, c.votes, c.game || '', c.link || '', c.device || null]);
      return c;
    },
    async findCandidateByDevice(ids) {
      await init();
      const clean = ids.filter(Boolean);
      if (!clean.length) return null;
      const r = await row(`SELECT * FROM candidates WHERE device = ANY($1::text[]) ORDER BY created_at LIMIT 1`, [clean]);
      return r && toCandidate(r);
    },
    async updateCandidate(id, patch) {
      await init();
      const cols = { name: 'name', photo: 'photo', votes: 'votes', game: 'game', link: 'link' };
      const sets = [], vals = [];
      for (const [key, col] of Object.entries(cols)) {
        if (patch[key] !== undefined) { vals.push(patch[key]); sets.push(`${col} = $${vals.length}`); }
      }
      if (!sets.length) return this.getCandidate(id);
      vals.push(id);
      const r = await row(`UPDATE candidates SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
      return r && toCandidate(r);
    },
    async deleteCandidate(id) {
      await init();
      await q(`DELETE FROM candidates WHERE id = $1`, [id]);
      await q(`UPDATE ballots SET choices = array_remove(choices, $1)`, [id]);
    },

    async hasVoted(ids) {
      await init();
      const clean = ids.filter(Boolean);
      if (!clean.length) return false;
      const r = await row(`SELECT 1 FROM voted_devices WHERE id = ANY($1::text[]) LIMIT 1`, [clean]);
      return !!r;
    },
    async castBallot(choices, ids, lock, attempt = 0) {
      await init();
      const client = await pool.connect();
      let released = false;
      const release = () => { if (!released) { released = true; client.release(); } };
      try {
        await client.query('BEGIN');
        if (lock) {
          // Deduplicated defensively: the same id arriving twice in one ballot must not
          // collide with its own insert and be mistaken for a repeat vote.
          for (const id of [...new Set(ids.filter(Boolean))]) {
            const r = await client.query(
              `INSERT INTO voted_devices (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [id]);
            if (!r.rowCount) { await client.query('ROLLBACK'); return false; }
          }
        }
        // One statement per row, in a fixed order. `WHERE id = ANY(...)` locks the rows in
        // whatever order the planner picks, so two ballots choosing the same candidates in
        // opposite orders deadlocked each other under load. Sorting gives every transaction
        // the same lock order, which makes that impossible.
        for (const id of [...choices].sort()) {
          await client.query(`UPDATE candidates SET votes = votes + 1 WHERE id = $1`, [id]);
        }
        await client.query(`INSERT INTO ballots (id, choices, device) VALUES ($1, $2, $3)`,
          [crypto.randomUUID(), choices, ids[0] || null]);
        await client.query('COMMIT');
        return true;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // 40P01 deadlock, 40001 serialization failure: transient under load, and the
        // rollback means nothing was recorded, so retrying is safe.
        if ((e.code === '40P01' || e.code === '40001') && attempt < 3) {
          release();
          await new Promise(r => setTimeout(r, 40 * (attempt + 1) + Math.random() * 40));
          return this.castBallot(choices, ids, lock, attempt + 1);
        }
        throw e;
      } finally {
        release();
      }
    },

    async stats() {
      await init();
      const r = await row(`SELECT
        (SELECT COUNT(*) FROM ballots) AS ballots,
        (SELECT COUNT(*) FROM voted_devices) AS devices`);
      return { ballotCount: +r.ballots, lockedDevices: +r.devices };
    },
    async resetVotes() {
      await init();
      await q(`UPDATE candidates SET votes = 0`);
      await q(`DELETE FROM ballots`);
      await q(`DELETE FROM voted_devices`);
    },
    async clearDevices() {
      await init();
      await q(`DELETE FROM voted_devices`);
    }
  };
}

// ------------------------------------------------------------ backend selection
// Providers name the connection string differently: the Neon and Vercel Postgres
// integrations set DATABASE_URL and POSTGRES_URL, Supabase hands you a plain
// DATABASE_URL, and some setups prefix everything.
const URL_VARS = [
  'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING',
  'DATABASE_POSTGRES_URL', 'NEON_DATABASE_URL', 'STORAGE_URL'
];

function findUrl() {
  for (const name of URL_VARS) {
    const v = process.env[name];
    if (v && /^postgres(ql)?:\/\//.test(v)) return { url: v, from: name };
  }
  // Last resort: any env var that looks like a Postgres connection string.
  for (const [name, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && /^postgres(ql)?:\/\/\S+@\S+/.test(v)) return { url: v, from: name };
  }
  return null;
}

const SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Serverless filesystems are read-only, so falling back to data.json there produces a
// confusing EROFS on the first write. Fail with instructions instead.
function noDatabaseStore() {
  const message =
    'No database connected. In Vercel: Storage → Create Database → Neon → Connect ' +
    'to this project (Production, Preview and Development), then Deployments → Redeploy.';
  const fail = async () => { throw Object.assign(new Error(message), { statusCode: 503 }); };
  return {
    kind: 'none',
    detail: message,
    init: fail,
    getSettings: async () => ({ ...DEFAULT_SETTINGS, open: false }),
    listCandidates: async () => [],
    stats: async () => ({ ballotCount: 0, lockedDevices: 0 }),
    hasVoted: async () => false,
    findCandidateByDevice: async () => null,
    getCandidate: fail, addCandidate: fail, updateCandidate: fail, deleteCandidate: fail,
    setSettings: fail, castBallot: fail, resetVotes: fail, clearDevices: fail
  };
}

const found = findUrl();
module.exports = found ? pgStore(found.url)
  : SERVERLESS ? noDatabaseStore()
  : fileStore();
module.exports.urlFrom = found ? found.from : null;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
