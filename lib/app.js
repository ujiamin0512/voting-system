// Request handler for every /api/* route. Shared by the local server (server.js)
// and the Vercel serverless function (api/index.js).

const crypto = require('crypto');
const store = require('./store');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
// Tokens are signed rather than kept in memory: on Vercel each request may run in a
// different instance, so an in-memory session set would log the admin out at random.
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD + '::voting-app';
const TOKEN_TTL = 12 * 60 * 60 * 1000; // 12 hours

// Identifies the running build. A tab left open across a deploy keeps executing the old
// JavaScript forever, so pages compare this against what they loaded with and refresh.
const BUILD = process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.VERCEL_DEPLOYMENT_ID
  || String(Date.now());

const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('hex');

function issueToken() {
  const expires = Date.now() + TOKEN_TTL;
  return `${expires}.${sign(String(expires))}`;
}

function validToken(token) {
  const [expires, sig] = String(token || '').split('.');
  if (!expires || !sig || Date.now() > +expires) return false;
  const expected = sign(expires);
  return sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------------------------------------------------------------- helpers
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  if (req.body && typeof req.body === 'object') return resolve(req.body); // Vercel pre-parses
  let raw = '';
  req.on('data', c => {
    raw += c;
    if (raw.length > 8e6) { reject(new Error('Image too large — use a smaller photo.')); req.destroy(); }
  });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Bad JSON')); } });
  req.on('error', reject);
});

const cookies = req => Object.fromEntries(
  (req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; })
);
const deviceCookie = id => `vdid=${id}; Path=/; Max-Age=31536000; SameSite=Lax`;

const isAdmin = req => validToken((req.headers.authorization || '').replace(/^Bearer /, ''));
const publicView = c => ({ id: c.id, name: c.name, photo: c.photo });

// ---------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    const { password } = await readBody(req);
    const given = Buffer.from(String(password || ''));
    const real = Buffer.from(ADMIN_PASSWORD);
    const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
    if (!ok) return send(res, 401, { error: 'Wrong password' });
    return send(res, 200, { token: issueToken() });
  }

  // Diagnostics: names only, never values, so it is safe to hit unauthenticated.
  if (p === '/api/health' && m === 'GET') {
    return send(res, 200, {
      ok: store.kind !== 'none',
      storage: store.kind,
      connectionStringFrom: store.urlFrom,
      detail: store.detail || null,
      envVarsPresent: Object.keys(process.env)
        .filter(k => /POSTGRES|DATABASE|NEON|SUPABASE|ADMIN_PASSWORD|SESSION_SECRET/i.test(k))
        .sort(),
      runtime: process.env.VERCEL ? 'vercel' : 'local'
    });
  }

  // ---- public ----
  if (p === '/api/poll' && m === 'GET') {
    const [settings, candidates] = await Promise.all([store.getSettings(), store.listCandidates()]);
    let did = cookies(req).vdid;
    const fresh = !did;
    if (fresh) did = crypto.randomUUID();
    const localId = url.searchParams.get('did');
    const alreadyVoted = settings.oneVotePerDevice && await store.hasVoted([did, localId]);
    return send(res, 200,
      { build: BUILD, settings, candidates: candidates.map(publicView), deviceId: did, alreadyVoted },
      fresh ? { 'Set-Cookie': deviceCookie(did) } : {});
  }

  // Public scoreboard — no login, so it can go on a projector or be shared with voters.
  if (p === '/api/results' && m === 'GET') {
    const [settings, candidates, stats] = await Promise.all([
      store.getSettings(), store.listCandidates(), store.stats()
    ]);
    // Photos are base64 and dominate the payload, so the scoreboard fetches them once
    // (?photos=1) and then polls without them. Sending them every 2s made each poll
    // re-download every image, which is what made the board lag behind.
    const withPhotos = url.searchParams.get('photos') === '1';
    return send(res, 200, {
      build: BUILD,
      title: settings.title,
      open: settings.open,
      ballotCount: stats.ballotCount,
      candidates: candidates.map(c => withPhotos
        ? { id: c.id, name: c.name, photo: c.photo, votes: c.votes }
        : { id: c.id, name: c.name, votes: c.votes })
    });
  }

  if (p === '/api/vote' && m === 'POST') {
    const { choices, deviceId } = await readBody(req);
    const settings = await store.getSettings();
    if (!settings.open) return send(res, 400, { error: 'Voting is closed.' });
    if (!Array.isArray(choices)) return send(res, 400, { error: 'Invalid ballot.' });

    const cookieId = cookies(req).vdid;
    const ids = [cookieId, deviceId].filter(Boolean);
    if (settings.oneVotePerDevice) {
      if (!ids.length) return send(res, 400, { error: 'Cookies are blocked — enable them to vote.' });
      if (await store.hasVoted(ids)) return send(res, 409, { error: 'This device has already voted.' });
    }

    const unique = [...new Set(choices)];
    if (unique.length !== choices.length) return send(res, 400, { error: 'Duplicate selections.' });
    if (unique.length !== settings.votesPerVoter)
      return send(res, 400, { error: `You must select exactly ${settings.votesPerVoter}.` });

    const candidates = await store.listCandidates();
    if (!unique.every(id => candidates.some(c => c.id === id)))
      return send(res, 400, { error: 'Unknown candidate.' });

    const stored = await store.castBallot(unique, ids, settings.oneVotePerDevice);
    if (stored === false) return send(res, 409, { error: 'This device has already voted.' });
    return send(res, 200, { ok: true }, cookieId ? {} : { 'Set-Cookie': deviceCookie(ids[0]) });
  }

  // ---- admin only ----
  if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });

  if (p === '/api/admin/state' && m === 'GET') {
    const [settings, candidates, stats] = await Promise.all([
      store.getSettings(), store.listCandidates(), store.stats()
    ]);
    // PUBLIC_ORIGIN is set locally so the QR points at the LAN IP, not localhost.
    // On Vercel it is unset and the deployment's own domain is used.
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const origin = process.env.PUBLIC_ORIGIN || `${proto}://${req.headers.host}`;
    return send(res, 200, { build: BUILD, settings, candidates, ...stats, storage: store.kind, voteUrl: `${origin}/vote` });
  }

  if (p === '/api/settings' && m === 'PUT') {
    const { votesPerVoter, open, title, oneVotePerDevice } = await readBody(req);
    const patch = {};
    if (votesPerVoter !== undefined) {
      const n = parseInt(votesPerVoter, 10);
      if (!Number.isInteger(n) || n < 1) return send(res, 400, { error: 'Votes must be at least 1.' });
      patch.votesPerVoter = n;
    }
    if (open !== undefined) patch.open = !!open;
    if (oneVotePerDevice !== undefined) patch.oneVotePerDevice = !!oneVotePerDevice;
    if (title !== undefined) patch.title = String(title).slice(0, 120);
    return send(res, 200, await store.setSettings(patch));
  }

  // CREATE
  if (p === '/api/candidates' && m === 'POST') {
    const { name, photo } = await readBody(req);
    if (!name || !String(name).trim()) return send(res, 400, { error: 'Name is required.' });
    const c = { id: crypto.randomUUID(), name: String(name).trim(), photo: photo || '', votes: 0 };
    return send(res, 201, await store.addCandidate(c));
  }

  // READ
  if (p === '/api/candidates' && m === 'GET') return send(res, 200, await store.listCandidates());

  const match = p.match(/^\/api\/candidates\/([\w-]+)$/);
  if (match) {
    const c = await store.getCandidate(match[1]);
    if (!c) return send(res, 404, { error: 'Not found' });

    if (m === 'GET') return send(res, 200, c);

    // UPDATE
    if (m === 'PUT') {
      const { name, photo, votes } = await readBody(req);
      const patch = {};
      if (name !== undefined && String(name).trim()) patch.name = String(name).trim();
      if (photo !== undefined) patch.photo = photo;
      if (votes !== undefined && Number.isInteger(+votes) && +votes >= 0) patch.votes = +votes;
      return send(res, 200, await store.updateCandidate(c.id, patch));
    }

    // DELETE
    if (m === 'DELETE') {
      await store.deleteCandidate(c.id);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/reset' && m === 'POST') {
    await store.resetVotes();
    return send(res, 200, { ok: true });
  }

  // Let everyone vote again without wiping the tally.
  if (p === '/api/unlock-devices' && m === 'POST') {
    await store.clearDevices();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

module.exports = { handleApi, send, store };
