export type SanitizeOptions = {
  allowRemoteImages: boolean;
  dark: boolean;
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

  // Drop scripts entirely.
  doc.querySelectorAll("script, noscript, meta[http-equiv], iframe, object, embed").forEach(
    (el) => el.remove(),
  );

  // Strip every on* event handler.
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    }
  });

  let blocked = 0;

  if (!opts.allowRemoteImages) {
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      const srcset = img.getAttribute("srcset") ?? "";
      let hasRemote = false;
      if (src && !isLocalImageSrc(src)) {
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

  return {
    html: `<!doctype html>${doc.documentElement.outerHTML}`,
    blockedImages: blocked,
  };
}
