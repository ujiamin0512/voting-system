// Detects when the server is running a newer build than the one this tab loaded.
//
// A browser tab keeps executing whatever JavaScript it loaded, forever. After a deploy an
// open tab can therefore keep calling endpoints that changed or disappeared, and it looks
// to the user like the app has silently stopped working. Every API response carries a
// `build` value; pages feed it to this helper and decide what to do about a mismatch.
window.buildWatch = (() => {
  let loadedBuild = null;
  let handled = false;

  return {
    // Returns true the first time the server build differs from the one seen at load.
    changed(build) {
      if (!build) return false;
      if (loadedBuild === null) { loadedBuild = build; return false; }
      if (build === loadedBuild || handled) return false;
      handled = true;
      return true;
    },

    // Cache-busting reload: a plain reload can be served from the browser cache.
    reload() {
      const u = new URL(location.href);
      u.searchParams.set('v', Date.now());
      location.replace(u.toString());
    }
  };
})();
