// Local development server: serves public/ and delegates /api/* to the shared handler.
// On Vercel this file is not used — api/index.js runs the same handler instead.
// Run: node server.js   (or npm start)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { handleApi, send, store } = require('./lib/app');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function lanAddress() {
  if (process.env.HOST_IP) return process.env.HOST_IP;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) found.push({ name, ip: ni.address });
    }
  }
  // Virtual adapters (VirtualBox/VMware/Hyper-V) are usually unreachable from phones.
  const real = found.filter(f =>
    !/virtual|vmware|vethernet|hyper-v|loopback/i.test(f.name) && !f.ip.startsWith('192.168.56.'));
  return (real[0] || found[0] || {}).ip || 'localhost';
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'admin.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// Make the admin QR point at this machine's LAN address so phones can reach it.
process.env.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://${lanAddress()}:${PORT}`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/vote') return serveStatic(res, '/vote.html');
    if (url.pathname === '/results') return serveStatic(res, '/results.html');
    serveStatic(res, url.pathname);
  } catch (e) {
    send(res, e.statusCode || 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`\n  Voting system running  (storage: ${store.kind})`);
  console.log(`  Admin   : http://localhost:${PORT}/`);
  console.log(`  Voting  : http://${lanAddress()}:${PORT}/vote`);
  console.log(`  Password: ${process.env.ADMIN_PASSWORD || 'admin123'}\n`);
});
