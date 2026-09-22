// Cover tile for a game entry: the uploaded cover image, or a generated poster
// (deterministic gradient from the title + big title text) when there is none.
// Shared by the library page, the projector and the vote page.
window.coverTile = (c, cls = 'cover') => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const title = c.game || c.name || '';
  if (c.photo) return `<div class="${cls}"><img src="${esc(c.photo)}" alt=""><div class="cap">${esc(title)}</div></div>`;
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<div class="${cls} gen" style="--h:${h}"><div class="big">${esc(title)}</div></div>`;
};
