// Smoke tests against a running local server (file backend).
//   node server.js        # in one terminal
//   node test.js          # in another
//
// Covers the paths a real browser exercises, which is where the device-lock bug hid:
// curl sends no cookie, so it never reproduced what phones actually send.

const BASE = process.env.TEST_URL || 'http://localhost:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : ' -> ' + detail}`);
  ok ? pass++ : fail++;
};

const api = async (path, { method = 'GET', body, token, cookie } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = `vdid=${cookie}`;
  const r = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

(async () => {
  console.log(`Testing ${BASE}\n`);

  const login = await api('/api/login', { method: 'POST', body: { password: PASSWORD } });
  check('admin can log in', login.status === 200, JSON.stringify(login.data));
  const token = login.data.token;

  const wrong = await api('/api/login', { method: 'POST', body: { password: 'not-the-password' } });
  check('wrong password rejected', wrong.status === 401);

  const names = ['T1', 'T2', 'T3'];
  const ids = [];
  for (const name of names) {
    const r = await api('/api/candidates', { method: 'POST', body: { name }, token });
    ids.push(r.data.id);
  }
  check('candidates created', ids.every(Boolean));

  await api('/api/settings', { method: 'PUT', body: { votesPerVoter: 2, open: true, oneVotePerDevice: true }, token });

  // The regression this file exists for: a browser sends the same id as both the
  // cookie and the JSON body, and that must count as ONE device, not a repeat vote.
  const sameId = crypto.randomUUID();
  const browserVote = await api('/api/vote', {
    method: 'POST', body: { choices: [ids[0], ids[1]], deviceId: sameId }, cookie: sameId
  });
  check('browser vote accepted (cookie id === body id)',
    browserVote.status === 200, `${browserVote.status} ${JSON.stringify(browserVote.data)}`);

  const board = await api('/api/results');
  check('vote reached the public scoreboard',
    board.data.ballotCount === 1 && board.data.candidates.find(c => c.id === ids[0]).votes === 1,
    JSON.stringify(board.data.candidates.map(c => c.name + ':' + c.votes)));

  const repeat = await api('/api/vote', {
    method: 'POST', body: { choices: [ids[0], ids[2]], deviceId: sameId }, cookie: sameId
  });
  check('same device blocked on second vote', repeat.status === 409);

  const other = crypto.randomUUID();
  const second = await api('/api/vote', {
    method: 'POST', body: { choices: [ids[2], ids[1]], deviceId: other }, cookie: other
  });
  check('a different device can still vote', second.status === 200);

  const state = await api('/api/admin/state', { token });
  check('one lock recorded per device, not two',
    state.data.lockedDevices === 2, `lockedDevices=${state.data.lockedDevices} for 2 ballots`);

  const wrongCount = await api('/api/vote', {
    method: 'POST', body: { choices: [ids[0]], deviceId: crypto.randomUUID() }
  });
  check('wrong number of choices rejected', wrongCount.status === 400);

  const dupes = await api('/api/vote', {
    method: 'POST', body: { choices: [ids[0], ids[0]], deviceId: crypto.randomUUID() }
  });
  check('duplicate choices rejected', dupes.status === 400);

  check('admin routes need a token', (await api('/api/admin/state')).status === 401);
  check('public scoreboard needs no token', (await api('/api/results')).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
