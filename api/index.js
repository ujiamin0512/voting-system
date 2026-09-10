// Vercel serverless entry point. Everything under /api/* is routed here by vercel.json;
// the static pages in public/ are served directly by Vercel's CDN.

const { handleApi, send } = require('../lib/app');

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  try {
    await handleApi(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message || 'Server error' });
  }
};
