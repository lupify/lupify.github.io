// Shared behaviour for every page: theme toggle and scroll reveals.
// The pre-paint theme resolution lives inline in each page's <head>; it has to
// run before first paint, which a deferred script cannot do.
(function () {
  'use strict';

  var root = document.documentElement;

  // Theme changes cross over rather than cut. The transition lives behind an
  // attribute that is only set while a change is in flight: left on, it would
  // put a second's lag on every hover and on the first paint as well.
  var THEME_SHIFT_MS = 1000, shiftTimer = 0;
  function armThemeShift() {
    root.setAttribute('data-theme-shift', '');
    // Read a layout property to flush the style change. Without this the
    // transition and the new colours land in the same recalculation, and the
    // engine has no before-state with a transition on it to interpolate from,
    // so it cuts straight to the end.
    void root.offsetWidth;
    clearTimeout(shiftTimer);
    shiftTimer = setTimeout(function () {
      root.removeAttribute('data-theme-shift');
    }, THEME_SHIFT_MS);
  }

  var theme = document.getElementById('theme-toggle');
  if (theme) {
    theme.addEventListener('click', function () {
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      armThemeShift();
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  // Follow the OS while the visitor hasn't picked a side themselves.
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
      if (!localStorage.getItem('theme')) {
        armThemeShift();
        root.dataset.theme = e.matches ? 'light' : 'dark';
      }
    });
  } catch (e) {}

  // Background focus. background.js watches data-bg-blur, the same way it
  // watches the theme and the pause state.
  var blur = document.getElementById('blur-toggle');
  if (blur) {
    var syncBlur = function () {
      var on = root.dataset.bgBlur !== 'off';
      blur.setAttribute('aria-label',
        on ? 'Sharpen background simulation' : 'Blur background simulation');
    };
    syncBlur();
    new MutationObserver(syncBlur).observe(root,
      { attributes: true, attributeFilter: ['data-bg-blur'] });

    blur.addEventListener('click', function () {
      var next = root.dataset.bgBlur === 'off' ? 'on' : 'off';
      root.dataset.bgBlur = next;
      try { localStorage.setItem('bgBlur', next); } catch (e) {}
    });
  }

  // Background animation toggle. Only present when the simulation is enabled.
  var motion = document.getElementById('motion-toggle');
  if (motion) {
    var syncMotion = function () {
      var on = root.dataset.anim !== 'off';
      motion.setAttribute('aria-label', on ? 'Pause background animation' : 'Play background animation');
    };
    syncMotion();
    motion.addEventListener('click', function () {
      var next = root.dataset.anim === 'off' ? 'on' : 'off';
      root.dataset.anim = next;
      syncMotion();
      try { localStorage.setItem('anim', next); } catch (e) {}
    });
  }

  // Background simulation picker.  The menu shows whichever simulation is
  // actually running, so it reads correctly before it is opened and the native
  // control highlights that entry once it is.  "Random" is an action rather
  // than a state: it shuffles now and clears the stored choice so later loads
  // shuffle too, and the menu then shows whatever came up.
  var simSel = document.getElementById('sim-select');
  if (simSel) {
    var showRunning = function () {
      var running = root.dataset.sim;
      if (running && simSel.value !== running) {
        simSel.value = running;
        if (simSel.selectedIndex < 0) simSel.value = 'random';
      }
    };
    showRunning();
    // background.js writes data-sim once it has chosen and whenever it swaps.
    new MutationObserver(showRunning).observe(root,
      { attributes: true, attributeFilter: ['data-sim'] });

    simSel.addEventListener('change', function () {
      var v = simSel.value;
      try {
        if (v === 'random') {
          localStorage.removeItem('sim');
          // also drop the session's running choice, or "Random" would just be
          // handed back whatever is already on screen
          sessionStorage.removeItem('sim-current');
        } else localStorage.setItem('sim', v);
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('background:sim',
        { detail: v === 'random' ? null : v }));
    });
  }

  // Hairline under the top bar once the page scrolls.
  var topbar = document.getElementById('topbar');
  if (topbar) {
    var onScroll = function () { topbar.dataset.stuck = window.scrollY > 8; };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Reveal on entry.  Re-runnable, because soft navigation swaps in new content.
  var io = null;
  function initReveals() {
    var items = document.querySelectorAll('.reveal:not(.is-in)');
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) { el.classList.add('is-in'); });
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    }
    Array.prototype.forEach.call(items, function (el) { io.observe(el); });
  }
  initReveals();

  // Mark whichever page is showing.  aria-current is the attribute a screen
  // reader announces for this, and the stylesheet hangs off it, so one
  // assignment covers both.  It has to be re-applied after a soft navigation,
  // which swaps the whole nav out.
  function markCurrentPage() {
    // "/" and "/index.html" are the same page; normalise before comparing
    var here = location.pathname.replace(/\/(index\.html)?$/, '/');
    var links = document.querySelectorAll('nav.nav a');
    Array.prototype.forEach.call(links, function (a) {
      var there = new URL(a.href, location.href).pathname.replace(/\/(index\.html)?$/, '/');
      if (there === here) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }
  markCurrentPage();

  // ---- soft navigation ---------------------------------------------------
  //
  // The background canvas and this script live outside <main>, and every page
  // shares the same shell.  So moving between pages can be done by fetching the
  // next one and swapping <main> for its <main>, rather than by loading a whole
  // new document.  The simulation is then never torn down: it carries on
  // mid-stroke across a navigation, which is not something a full page load can
  // do -- there, the only options are to restart it or to serialise the entire
  // field and restore it.
  //
  // Every failure path falls back to an ordinary navigation, so the links work
  // with JavaScript broken, disabled, or offline.
  //
  // A click is never ignored.  An earlier guard skipped the swap while a fetch
  // was already in flight, but the click had already been prevented by then, so
  // the link simply did nothing -- which is what made the buttons look dead.
  // Instead each navigation takes a ticket and a stale response is discarded,
  // so a second click supersedes the first rather than being dropped.
  // ---- analytics ---------------------------------------------------------
  //
  // GoatCounter, loaded from each page's <head>.  Its own script counts the
  // pageview it loads on; everything below is for what happens after, because
  // soft navigation breaks the assumption that a pageview equals a script load
  // -- moving between pages loads nothing, so without this a visit would count
  // as one pageview however much of the site someone read.
  //
  // Both are no-ops if the script is absent or blocked.
  function gc() {
    return window.goatcounter && window.goatcounter.count ? window.goatcounter : null;
  }

  function trackPageview() {
    var g = gc();
    if (!g) return;
    try {
      g.count({ path: location.pathname + location.search, title: document.title,
                event: false });
    } catch (e) {}
  }

  // Outbound links and the CV are worth counting on a page like this: they are
  // what someone does instead of reading on.
  function trackEvent(name) {
    var g = gc();
    if (!g) return;
    try { g.count({ path: name, title: name, event: true }); } catch (e) {}
  }

  var navToken = 0;

  // Over file:// a fetch of a sibling page is blocked as a cross-origin
  // request, so every link would fall back to a full load.  Better to leave the
  // links alone entirely and say why once.
  var canSoftNavigate = location.protocol !== 'file:' && typeof fetch === 'function';
  if (!canSoftNavigate) {
    console.warn('[nav] soft navigation is off (' +
      (location.protocol === 'file:' ? 'opened over file://, not from a server'
                                     : 'fetch unavailable') +
      '), so changing pages will restart the background simulation.');
  }

  // The page currently showing.  Following an in-page link (#section) also
  // fires popstate, and so does going Back between two such links; neither is
  // a page change, and swapping the page for them re-fetched it and scrolled
  // to the top, undoing the jump.
  var shownPath = location.pathname;

  // After a swap, land where the URL says: on its #section if it has one,
  // otherwise at the top.
  function scrollToTarget(url) {
    var hash = new URL(url, location.href).hash;
    var el = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  function swapTo(url, push) {
    var token = ++navToken;
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(function (html) {
        if (token !== navToken) return;          // a later click won't be undone
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var main = doc.querySelector('main'), nav = doc.querySelector('nav.nav');
        var here = document.querySelector('main');
        if (!main || !here) throw new Error('unexpected page shape');
        here.replaceWith(main);
        if (nav) {
          var oldNav = document.querySelector('nav.nav');
          if (oldNav) oldNav.replaceWith(nav);
        }
        if (doc.title) document.title = doc.title;
        if (push) history.pushState({ soft: true }, '', url);
        shownPath = new URL(url, location.href).pathname;
        scrollToTarget(url);
        initReveals();
        markCurrentPage();
        trackPageview();          // the provider's own script only sees the first load
      })
      .catch(function (err) {
        // Last resort only: a full load, which does reset the background.  Say
        // so, because a silent fallback looks exactly like the router not
        // working -- and the commonest cause, opening the files over file://
        // rather than from a server, gives no other clue.
        console.warn('[nav] soft navigation failed, doing a full page load ' +
                     '(this resets the background simulation):', err);
        if (token === navToken) location.href = url;
      });
  }

  // ---- email links copy the address ---------------------------------------
  //
  // A mailto: link hands the visitor to whatever mail client the device has
  // set up, which on many machines is none at all.  Copying the address is
  // the more useful default; a short notice says it happened.  If copying is
  // refused, the link falls back to opening the mail client as before.
  var toast = null, toastTimer = 0;
  function notify(msg) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.setAttribute('role', 'status');      // read out by screen readers
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-shown'); }, 2200);
  }

  // Copy synchronously first: execCommand runs inside the click itself, so it
  // either works or reports failure on the spot, in every browser.  The async
  // Clipboard API is the backup -- on its own it can stall without settling
  // (seen in headless Chrome), which would leave the click doing nothing.
  function copySync(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    var keep = [], sel = window.getSelection();
    for (var i = 0; sel && i < sel.rangeCount; i++) keep.push(sel.getRangeAt(i));
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) {}
    ta.remove();
    if (sel) { sel.removeAllRanges(); keep.forEach(function (r) { sel.addRange(r); }); }
    return ok;
  }

  function copyText(text) {
    if (copySync(text)) return Promise.resolve();
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error('copy refused'));
  }

  // Capture phase, so this runs before the page router below sees the click.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href^="mailto:"]') : null;
    if (!a) return;
    e.preventDefault();
    // A drag that selected part of the address ends in a click too.  Leave
    // that selection for the visitor to copy themselves rather than
    // overwriting it with the whole address.
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && a.contains(sel.anchorNode)) return;
    var addr = decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]);
    copyText(addr).then(function () {
      notify(addr + ' copied to clipboard');
      a.classList.add('is-copied');
      setTimeout(function () { a.classList.remove('is-copied'); }, 2200);
      trackEvent('email copied: ' + addr);
    }, function () {
      location.href = a.href;
    });
  }, true);

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || !a.href) return;

    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }

    // Count what someone leaves for, whether or not the click is intercepted.
    if (url.origin !== location.origin) trackEvent('outbound: ' + url.host + url.pathname);
    else if (/\.pdf$/i.test(url.pathname)) trackEvent('cv: ' + url.pathname);

    if (!canSoftNavigate) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (url.origin !== location.origin) return;
    // Leave in-page anchors and anything that is not one of these pages --
    // the CV is a PDF and should open the way the browser wants to open it.
    if (!/(^|\/)[\w.-]*\.html$|\/$/.test(url.pathname)) return;
    if (url.pathname === location.pathname && url.hash) return;

    e.preventDefault();
    if (url.pathname === location.pathname) { window.scrollTo(0, 0); return; }
    swapTo(url.href, true);
  });

  window.addEventListener('popstate', function () {
    if (location.pathname === shownPath) return;   // same page: the browser scrolls
    swapTo(location.href, false);
  });
})();
