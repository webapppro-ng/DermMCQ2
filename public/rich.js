/*
 * Rich text for question stems and explanations: one allowlist, used by
 *   - the server (sanitize-html) when an administrator saves a question, and
 *   - the browser (DOMPurify) every time rich text is shown or saved in the hosted build.
 *
 * Allowed: paragraphs, line breaks, bold/italic/underline/strike, sub/superscript, two heading levels,
 * bulleted and numbered lists, quotes, code, links (http, https, mailto) and images
 * (https, this app's /media/<id>, the hosted page's /_blob/<id>, or inline png/jpeg/gif/webp).
 * No scripts, styles, event handlers, iframes or SVG.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DermRich = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'h3', 'h4', 'ul', 'ol', 'li',
    'blockquote', 'code', 'pre', 'a', 'img', 'span'];
  const CLASSES = ['ql-align-center', 'ql-align-right', 'ql-align-justify',
    'ql-indent-1', 'ql-indent-2', 'ql-indent-3', 'ql-indent-4', 'ql-indent-5', 'ql-indent-6', 'ql-indent-7', 'ql-indent-8'];
  const HREF = /^(https?:\/\/|mailto:)/i;
  const SRC = /^(https:\/\/|\/media\/\d+$|\/_blob\/[A-Za-z0-9_-]+$|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$)/i;
  const MAX_LENGTH = 3000000; // characters; inline images in the browser-only build count towards this

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Plain text (one point per line, as imported) -> rich text. Several lines become a bulleted list.
  function textToHtml(text, asList) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (asList && lines.length > 1) return '<ul>' + lines.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>';
    return lines.map((l) => `<p>${esc(l)}</p>`).join('');
  }

  // Rich text -> plain text, one block per line. Used for search, previews and question matching.
  function htmlToText(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|h3|h4|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, '&')
      .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  // True when rich text has something to show: text or an image.
  const hasContent = (html) => !!htmlToText(html) || /<img\b/i.test(String(html || ''));

  function nodeSanitizer(sanitizeHtml) {
    return (html) => sanitizeHtml(String(html || ''), {
      allowedTags: TAGS,
      allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], '*': ['class'] },
      allowedClasses: { '*': CLASSES },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowedSchemesByTag: { img: ['https', 'data'] },
      allowProtocolRelative: false,
      exclusiveFilter: (frame) => (frame.tag === 'img' && !SRC.test(frame.attribs.src || ''))
        || (frame.tag === 'a' && frame.attribs.href !== undefined && !HREF.test(frame.attribs.href)),
      transformTags: { a: (tag, attribs) => ({ tagName: 'a', attribs: Object.assign({}, attribs, { target: '_blank', rel: 'noopener noreferrer' }) }) },
      allowedSchemesAppliedToAttributes: ['href', 'src'],
    });
  }

  function browserSanitizer(DOMPurify) {
    const purify = DOMPurify.sanitize ? DOMPurify : DOMPurify(window);
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.hasAttribute('class')) {
        const keep = node.getAttribute('class').split(/\s+/).filter((c) => CLASSES.includes(c));
        if (keep.length) node.setAttribute('class', keep.join(' ')); else node.removeAttribute('class');
      }
      if (node.tagName === 'A') {
        if (!HREF.test(node.getAttribute('href') || '')) node.removeAttribute('href');
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
      if (node.tagName === 'IMG' && !SRC.test(node.getAttribute('src') || '')) node.remove();
    });
    return (html) => purify.sanitize(String(html || ''), {
      ALLOWED_TAGS: TAGS,
      ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'width', 'height', 'class', 'target', 'rel'],
      ALLOWED_URI_REGEXP: /^(https?:|mailto:|\/media\/|\/_blob\/|data:image\/(png|jpeg|gif|webp);base64,)/i,
    });
  }

  // Browser: one DOMPurify-backed sanitizer for the page. Without DOMPurify, rich text is reduced to
  // escaped plain text rather than shown unsanitized.
  let pageSanitizer = null;
  function sanitizeInBrowser(html) {
    if (typeof window === 'undefined' || !window.DOMPurify) return textToHtml(htmlToText(html), false);
    if (!pageSanitizer) pageSanitizer = browserSanitizer(window.DOMPurify);
    return pageSanitizer(html);
  }

  return { TAGS, CLASSES, HREF, SRC, MAX_LENGTH, esc, textToHtml, htmlToText, hasContent, nodeSanitizer, browserSanitizer, sanitizeInBrowser };
});
