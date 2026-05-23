import { describe, expect, it } from "vitest";
import { sanitizeMessageHtml } from "./htmlSanitize";

describe("sanitizeMessageHtml", () => {
  it("strips img src into data-cenmail-src when blocking images", () => {
    const { html, blockedImages } = sanitizeMessageHtml(
      '<img src="https://tracker/pixel.png" alt="x">',
      { allowRemoteImages: false, dark: false },
    );
    expect(blockedImages).toBe(1);
    expect(html).toContain("data-cenmail-src=\"https://tracker/pixel.png\"");
    expect(html).toMatch(/<img[^>]*\bsrc=""/);
    // The tracker URL must only appear inside data-cenmail-src, never src=.
    const occurrences = html.match(/https:\/\/tracker\/pixel\.png/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("preserves data: image src", () => {
    const { html, blockedImages } = sanitizeMessageHtml(
      '<img src="data:image/png;base64,AAAA">',
      { allowRemoteImages: false, dark: false },
    );
    expect(blockedImages).toBe(0);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("preserves cid: image src when no map is supplied", () => {
    const { html, blockedImages } = sanitizeMessageHtml(
      '<img src="cid:abc123">',
      { allowRemoteImages: false, dark: false },
    );
    expect(blockedImages).toBe(0);
    expect(html).toContain('src="cid:abc123"');
  });

  it("rewrites cid: image src to a data: URL via cidMap", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const { html } = sanitizeMessageHtml('<img src="cid:logo">', {
      allowRemoteImages: false,
      dark: false,
      cidMap: { logo: dataUrl },
    });
    expect(html).toContain(`src="${dataUrl}"`);
    expect(html).not.toContain("cid:logo");
  });

  it("removes <base> and <link> tags so remote refs cannot leak", () => {
    const { html } = sanitizeMessageHtml(
      '<base href="https://evil/"><link rel="stylesheet" href="https://evil/x.css"><p>ok</p>',
      { allowRemoteImages: true, dark: false },
    );
    expect(html).not.toMatch(/<base/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).toContain("<p>ok</p>");
  });

  it("does not block when allowRemoteImages is true", () => {
    const { html, blockedImages } = sanitizeMessageHtml(
      '<img src="https://tracker/pixel.png">',
      { allowRemoteImages: true, dark: false },
    );
    expect(blockedImages).toBe(0);
    expect(html).toContain('src="https://tracker/pixel.png"');
  });

  it("counts srcset urls as blocked too", () => {
    const { blockedImages } = sanitizeMessageHtml(
      '<img src="https://a/1.png" srcset="https://a/2.png 2x">',
      { allowRemoteImages: false, dark: false },
    );
    expect(blockedImages).toBe(1);
  });

  it("rewrites anchors to target=_blank with safe rel", () => {
    const { html } = sanitizeMessageHtml(
      '<a href="https://example.com">link</a>',
      { allowRemoteImages: true, dark: false },
    );
    expect(html).toMatch(/target="_blank"/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it("strips javascript: href", () => {
    const { html } = sanitizeMessageHtml(
      '<a href="javascript:alert(1)">x</a>',
      { allowRemoteImages: true, dark: false },
    );
    expect(html).not.toMatch(/javascript:/i);
  });

  it("strips inline event handlers", () => {
    const { html } = sanitizeMessageHtml(
      '<div onclick="alert(1)">x</div>',
      { allowRemoteImages: true, dark: false },
    );
    expect(html).not.toMatch(/onclick/i);
  });

  it("removes <script> elements", () => {
    const { html } = sanitizeMessageHtml(
      '<p>ok</p><script>alert(1)</script>',
      { allowRemoteImages: true, dark: false },
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<p>ok</p>");
  });

  it("removes background-image url() from inline styles when blocking", () => {
    const { html, blockedImages } = sanitizeMessageHtml(
      '<div style="background-image:url(https://t/p.png)">x</div>',
      { allowRemoteImages: false, dark: false },
    );
    expect(blockedImages).toBeGreaterThan(0);
    expect(html).not.toMatch(/url\(\s*https:\/\//);
  });

  it("injects dark-mode style preamble when dark=true", () => {
    const { html } = sanitizeMessageHtml(
      "<p>body</p>",
      { allowRemoteImages: true, dark: true },
    );
    expect(html).toMatch(/color-scheme:\s*dark/);
  });

  it("does not inject dark style when dark=false", () => {
    const { html } = sanitizeMessageHtml("<p>body</p>", {
      allowRemoteImages: true,
      dark: false,
    });
    expect(html).not.toMatch(/color-scheme:\s*dark/);
  });

  it("returns a string for empty input", () => {
    const { html, blockedImages } = sanitizeMessageHtml("", {
      allowRemoteImages: false,
      dark: false,
    });
    expect(typeof html).toBe("string");
    expect(blockedImages).toBe(0);
  });
});
