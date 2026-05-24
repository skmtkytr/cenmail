export type SanitizeOptions = {
  allowRemoteImages: boolean;
  dark: boolean;
  /// Map of `Content-Id` (without the surrounding `<>`) to a `data:` URL
  /// containing the attachment bytes. Used to inline `cid:` images that
  /// would otherwise show as broken placeholders.
  cidMap?: Record<string, string>;
};

export type SanitizeResult = {
  html: string;
  blockedImages: number;
};

const DARK_STYLE = `
  :root { color-scheme: dark; }
  html, body {
    background: #1a1a1a !important;
    color: #f3f4f6 !important;
  }
  a { color: #60a5fa !important; }
`;

// Schemes that don't fetch from the network and are safe to render.
function isLocalImageSrc(src: string): boolean {
  const trimmed = src.trim().toLowerCase();
  return trimmed.startsWith("data:") || trimmed.startsWith("cid:");
}

// Resolve a single `cid:` reference using the supplied map. Returns the
// resolved data: URL if found, else null (caller decides whether to drop the
// img or leave the cid as-is). The lookup is case-insensitive because mail
// producers freely mix case between body refs and Content-Id headers.
function resolveCid(src: string, map: Record<string, string>): string | null {
  const trimmed = src.trim();
  if (!trimmed.toLowerCase().startsWith("cid:")) return null;
  const id = trimmed.slice(4).trim().toLowerCase();
  return map[id] ?? null;
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith("javascript:")) return false;
  if (trimmed.startsWith("vbscript:")) return false;
  return true;
}

export function sanitizeMessageHtml(
  html: string,
  opts: SanitizeOptions,
): SanitizeResult {
  if (typeof DOMParser === "undefined") {
    return { html: "", blockedImages: 0 };
  }
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    "text/html",
  );

  // Drop scripts entirely. `<base>` is also pulled out because it can rewrite
  // relative URLs to point at an attacker's origin; `<link>` and `<style>`
  // can pull remote resources via @import or url() during render.
  doc
    .querySelectorAll(
      "script, noscript, meta[http-equiv], iframe, object, embed, base, link",
    )
    .forEach((el) => el.remove());

  // Strip every on* event handler.
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    }
  });

  let blocked = 0;
  const cidMap = opts.cidMap ?? {};

  // Step 1: resolve any `cid:` images we have data for. Runs whether or not
  // remote images are allowed since CIDs are part of the message itself.
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const resolved = resolveCid(src, cidMap);
    if (resolved) img.setAttribute("src", resolved);
  });

  if (!opts.allowRemoteImages) {
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      const srcset = img.getAttribute("srcset") ?? "";
      let hasRemote = false;
      if (src && !isLocalImageSrc(src) && !src.startsWith("data:")) {
        img.setAttribute("data-cenmail-src", src);
        img.setAttribute("src", "");
        hasRemote = true;
      }
      if (srcset) {
        img.setAttribute("data-cenmail-srcset", srcset);
        img.removeAttribute("srcset");
        hasRemote = true;
      }
      if (hasRemote) blocked += 1;
    });

    // Strip remote url() in inline styles (background-image, etc.).
    doc.querySelectorAll("[style]").forEach((el) => {
      const style = el.getAttribute("style") ?? "";
      const next = style.replace(
        /url\(\s*(['"]?)(https?:|\/\/)[^)]*\)/gi,
        "none",
      );
      if (next !== style) {
        el.setAttribute("style", next);
        blocked += 1;
      }
    });

    // <style> element bodies were a known leak: @import and url(http…) load
    // remote resources during render with no user gesture, leaking the fact
    // that the user opened the message. Strip those rules but keep the
    // surrounding stylesheet so legitimate inline layout still works.
    doc.querySelectorAll("style").forEach((el) => {
      const css = el.textContent ?? "";
      if (!css) return;
      const next = css
        .replace(/@import[^;}]*[;}]/gi, "")
        .replace(/url\(\s*(['"]?)(https?:|\/\/)[^)]*\)/gi, "none");
      if (next !== css) {
        el.textContent = next;
        blocked += 1;
      }
    });
  }

  // Rewrite anchors: drop javascript:/vbscript:, force target=_blank + safe rel.
  doc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href && !isSafeHref(href)) {
      a.removeAttribute("href");
      return;
    }
    if (href) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });

  // Inject dark-mode preamble.
  if (opts.dark) {
    const style = doc.createElement("style");
    style.textContent = DARK_STYLE;
    doc.head.appendChild(style);
  }

  // Click intercept: the iframe runs in an opaque-origin sandbox (no
  // allow-same-origin), so it can't reach the host. It can still
  // postMessage, which the App listens for and routes through the Tauri
  // opener plugin. Without this links would silently no-op because
  // target="_blank" inside a sandboxed iframe isn't honored by the
  // platform webview.
  const intercept = doc.createElement("script");
  intercept.textContent = LINK_INTERCEPT_SCRIPT;
  doc.body.appendChild(intercept);

  return {
    html: `<!doctype html>${doc.documentElement.outerHTML}`,
    blockedImages: blocked,
  };
}

// Injected into the message-body iframe alongside the sanitized HTML.
// Runs in an opaque-origin sandbox; can only talk to the host via
// postMessage. Two responsibilities:
//   1. Forward link clicks so the OS browser handles them.
//   2. Vimium-like keyboard nav while the iframe has focus
//      (f = link hints, j/k = scroll, gg/G = top/bottom, Esc = return).
// Because cross-origin keydowns don't bubble to the host document, the
// host's own keybinds keep working when the user is in the message
// list / preview chrome — and these only fire when the iframe itself
// is focused (typically via clicking inside the message body).
const LINK_INTERCEPT_SCRIPT = `
(function () {
  // ---- Click forward ------------------------------------------------
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t.nodeType === 1 && t.tagName !== 'A') t = t.parentNode;
    if (!t || t.tagName !== 'A') return;
    var href = t.getAttribute('href');
    if (!href) return;
    var lower = href.toLowerCase();
    if (lower.indexOf('javascript:') === 0 || lower.indexOf('vbscript:') === 0) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    try {
      parent.postMessage({ type: 'cenmail:open', href: t.href || href }, '*');
    } catch (err) {}
  }, true);

  // ---- Vimium-like keyboard nav ------------------------------------
  var LABEL_CHARS = 'asdfghjkl'.split('');
  var hintMode = false;
  var hints = [];
  var typed = '';
  var lastG = 0;
  var SCROLL_STEP = 60;

  function genLabels(n) {
    var out = [];
    if (n <= LABEL_CHARS.length) {
      for (var i = 0; i < n; i++) out.push(LABEL_CHARS[i]);
      return out;
    }
    for (var i = 0; i < LABEL_CHARS.length; i++) {
      for (var j = 0; j < LABEL_CHARS.length; j++) {
        out.push(LABEL_CHARS[i] + LABEL_CHARS[j]);
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  function clearHints() {
    for (var i = 0; i < hints.length; i++) hints[i].marker.remove();
    hints = [];
    typed = '';
    hintMode = false;
  }

  function showHints() {
    if (hintMode) return;
    var anchors = document.querySelectorAll('a[href]');
    var visible = [];
    for (var i = 0; i < anchors.length; i++) {
      var r = anchors[i].getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.right < 0 || r.left > window.innerWidth) continue;
      if (r.width === 0 && r.height === 0) continue;
      visible.push({ el: anchors[i], rect: r });
    }
    if (visible.length === 0) return;
    var labels = genLabels(visible.length);
    for (var i = 0; i < visible.length; i++) {
      var v = visible[i];
      var m = document.createElement('div');
      m.textContent = labels[i].toUpperCase();
      // !important across the board so the email's own stylesheet
      // can't drag the marker out of view via cascade.
      // Position in document coords (rect is viewport-relative; add the
      // current scroll offset) and use absolute, not fixed, so the
      // marker scrolls along with its anchor instead of staying pinned
      // to the viewport when the user moves through the message.
      var docX = v.rect.left + (window.scrollX || window.pageXOffset || 0);
      var docY = v.rect.top + (window.scrollY || window.pageYOffset || 0);
      var s = m.style;
      s.setProperty('position', 'absolute', 'important');
      s.setProperty('left', docX + 'px', 'important');
      s.setProperty('top', docY + 'px', 'important');
      s.setProperty('background', '#fef08a', 'important');
      s.setProperty('color', '#111', 'important');
      s.setProperty('border', '1px solid #b45309', 'important');
      s.setProperty('border-radius', '2px', 'important');
      s.setProperty('padding', '0 3px', 'important');
      s.setProperty('font', 'bold 11px/1.4 monospace', 'important');
      s.setProperty('z-index', '2147483647', 'important');
      s.setProperty('pointer-events', 'none', 'important');
      s.setProperty('box-shadow', '0 1px 2px rgba(0,0,0,.3)', 'important');
      document.body.appendChild(m);
      hints.push({ el: v.el, label: labels[i], marker: m });
    }
    hintMode = true;
    typed = '';
  }

  function activateLabel(label) {
    for (var i = 0; i < hints.length; i++) {
      if (hints[i].label !== label) continue;
      var a = hints[i].el;
      var href = a.getAttribute('href');
      clearHints();
      if (href) {
        var lower = href.toLowerCase();
        if (lower.indexOf('javascript:') !== 0 && lower.indexOf('vbscript:') !== 0) {
          try {
            parent.postMessage({ type: 'cenmail:open', href: a.href || href }, '*');
          } catch (err) {}
        }
      }
      return;
    }
  }

  document.addEventListener('keydown', function (e) {
    if (hintMode) {
      if (e.key === 'Escape') { e.preventDefault(); clearHints(); return; }
      if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        e.preventDefault();
        typed += e.key.toLowerCase();
        var prefixCount = 0;
        var exact = -1;
        for (var i = 0; i < hints.length; i++) {
          var match = hints[i].label.indexOf(typed) === 0;
          hints[i].marker.style.setProperty(
            'opacity', match ? '1' : '0.25', 'important'
          );
          if (match) {
            prefixCount++;
            if (hints[i].label === typed) exact = i;
          }
        }
        if (prefixCount === 0) { clearHints(); return; }
        if (exact >= 0 && prefixCount === 1) activateLabel(typed);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tgt = e.target;
    if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
    if (tgt && tgt.isContentEditable) return;
    if (e.key === 'f') { e.preventDefault(); showHints(); return; }
    if (e.key === 'j') { e.preventDefault(); window.scrollBy(0, SCROLL_STEP); return; }
    if (e.key === 'k') { e.preventDefault(); window.scrollBy(0, -SCROLL_STEP); return; }
    if (e.key === 'd') { e.preventDefault(); window.scrollBy(0, Math.floor(window.innerHeight / 2)); return; }
    if (e.key === 'u') { e.preventDefault(); window.scrollBy(0, -Math.floor(window.innerHeight / 2)); return; }
    if (e.key === 'G') {
      e.preventDefault();
      window.scrollTo(0, document.documentElement.scrollHeight);
      return;
    }
    if (e.key === 'g') {
      // gg = top, dispatched as two presses within 500 ms.
      var now = Date.now();
      if (now - lastG < 500) {
        e.preventDefault();
        window.scrollTo(0, 0);
        lastG = 0;
      } else {
        lastG = now;
      }
      return;
    }
    if (e.key === 'Escape') {
      // Hand focus back to the host so its own keybinds (j/k message
      // nav etc.) resume firing. The host listens for cenmail:blur and
      // calls iframe.blur() on the platform side.
      e.preventDefault();
      try { parent.postMessage({ type: 'cenmail:blur' }, '*'); } catch (err) {}
      return;
    }
  }, true);
})();
`;
