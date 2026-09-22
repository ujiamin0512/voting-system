// Cover tile for a game entry, in order of preference:
//   1. the uploaded cover image
//   2. the link's own preview image (og:image, fetched by the server on submit)
//   3. a dark tile with a big game-controller icon
// Shared by the projector and the vote page. If a preview image fails to load the
// tile swaps itself for the icon version.
(() => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const iconTile = (title, cls) =>
    `<div class="${cls} gen"><div class="ico">🎮</div><div class="big">${esc(title)}</div></div>`;

  window.coverTile = (c, cls = 'cover') => {
    const title = c.game || c.name || '';
    const src = c.photo || c.preview;
    if (!src) return iconTile(title, cls);
    return `<div class="${cls}" data-title="${esc(title)}" data-cls="${esc(cls)}">` +
      `<img src="${esc(src)}" alt="" onerror="coverFail(this)"><div class="cap">${esc(title)}</div></div>`;
  };
  window.coverFail = img => {
    const box = img.parentNode;
    box.outerHTML = iconTile(box.dataset.title, box.dataset.cls);
  };
})();
