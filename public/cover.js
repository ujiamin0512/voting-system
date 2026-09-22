// Cover tile for a game entry: the uploaded cover image, or a dark tile with a big
// game icon (picked deterministically from the title) and the title when there is none.
// Shared by the library page, the projector and the vote page.
window.coverTile = (c, cls = 'cover') => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const title = c.game || c.name || '';
  if (c.photo) return `<div class="${cls}"><img src="${esc(c.photo)}" alt=""><div class="cap">${esc(title)}</div></div>`;
  const icons = ['🎮', '🕹️', '👾', '🎯', '🚀', '🧩', '🐉', '⚔️', '🏎️', '🛸'];
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return `<div class="${cls} gen"><div class="ico">${icons[h % icons.length]}</div><div class="big">${esc(title)}</div></div>`;
};
