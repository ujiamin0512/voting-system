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

  // ---- participant submissions (links mode) ----
  await api('/api/settings', { method: 'PUT', body: { mode: 'links', submissionsOpen: true }, token });
  const before = (await api('/api/results')).data.candidates.length;
  const phone = crypto.randomUUID();
  const sub = await api('/api/submit', {
    method: 'POST', body: { name: 'Ann', game: 'Snake', link: 'https://example.com/snake', deviceId: phone }, cookie: phone
  });
  check('participant can submit a game link', sub.status === 201 && sub.data.link === 'https://example.com/snake',
    `${sub.status} ${JSON.stringify(sub.data)}`);
  const again = await api('/api/submit', {
    method: 'POST', body: { name: 'Ann', game: 'Snake II', link: 'https://example.com/snake2', deviceId: phone }, cookie: phone
  });
  const afterList = (await api('/api/results')).data.candidates;
  check('same device edits its entry instead of adding one',
    again.status === 200 && again.data.id === sub.data.id && afterList.length === before + 1
      && afterList.find(c => c.id === sub.data.id).game === 'Snake II',
    `${again.status} count ${afterList.length}`);
  const mine = await api('/api/poll?did=' + phone, { cookie: phone });
  check("poll returns the device's own entry", mine.data.mine && mine.data.mine.id === sub.data.id);
  const badUrl = await api('/api/submit', {
    method: 'POST', body: { name: 'Bob', game: 'X', link: 'not a url', deviceId: crypto.randomUUID() }
  });
  check('bad link rejected', badUrl.status === 400);
  const noGame = await api('/api/submit', {
    method: 'POST', body: { name: 'Bob', game: '', link: 'https://x.y', deviceId: crypto.randomUUID() }
  });
  check('missing game name rejected', noGame.status === 400);
  const voter = crypto.randomUUID();
  const linkVote = await api('/api/vote', {
    method: 'POST', body: { choices: [sub.data.id, ids[0]], deviceId: voter }, cookie: voter
  });
  check('link entries can be voted for', linkVote.status === 200, JSON.stringify(linkVote.data));
  const res = await api('/api/results');
  check('results carry mode, submit URL and game fields',
    res.data.mode === 'links' && /\/submit$/.test(res.data.submitUrl)
      && res.data.candidates.find(c => c.id === sub.data.id).link === 'https://example.com/snake2');
  const adminList = await api('/api/admin/state', { token });
  check('admin sees who was submitted from a phone',
    adminList.data.candidates.find(c => c.id === sub.data.id).submitted === true);
  await api('/api/settings', { method: 'PUT', body: { submissionsOpen: false }, token });
  const closed = await api('/api/submit', {
    method: 'POST', body: { name: 'C', game: 'G', link: 'https://x.y', deviceId: crypto.randomUUID() }
  });
  check('submissions can be closed', closed.status === 400);
  const badMode = await api('/api/settings', { method: 'PUT', body: { mode: 'videos' }, token });
  check('unknown mode rejected', badMode.status === 400);

  // ---- pictures mode submission ----
  await api('/api/settings', { method: 'PUT', body: { mode: 'pictures', submissionsOpen: true }, token });
  const phone2 = crypto.randomUUID();
  const noPhoto = await api('/api/submit', { method: 'POST', body: { name: 'Dee', deviceId: phone2 }, cookie: phone2 });
  check('pictures mode requires a photo', noPhoto.status === 400);
  const withPhoto = await api('/api/submit', {
    method: 'POST', body: { name: 'Dee', photo: 'data:image/png;base64,iVBORw0KGgo=', deviceId: phone2 }, cookie: phone2
  });
  check('participant can submit a photo', withPhoto.status === 201 && withPhoto.data.photo.startsWith('data:image/'));

  check('admin routes need a token', (await api('/api/admin/state')).status === 401);
  check('public scoreboard needs no token', (await api('/api/results')).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
