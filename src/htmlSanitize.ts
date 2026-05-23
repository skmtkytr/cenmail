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
// img or leave the cid as-is).
function resolveCid(src: string, map: Record<string, string>): string | null {
  const trimmed = src.trim();
  if (!trimmed.toLowerCase().startsWith("cid:")) return null;
  const id = trimmed.slice(4).trim();
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
