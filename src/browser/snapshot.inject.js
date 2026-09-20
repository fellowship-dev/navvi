// @ts-nocheck
/*
 * Navvi in-page snapshot (U4). Plain script, no imports: src/browser/snapshot.ts
 * reads this file as text and evaluates it once per page. It installs
 * `window.__navvi` with `controls(opts)` and `candidates(opts)`.
 *
 * Ideas ported from jev-ultrafast/snapshot.js (MIT, TypeSafe: element table
 * with roles, accessible names, scope text, occlusion hit test, `safe()` input
 * filter) and jevscrape.py (candidate groups by child tag+class signature,
 * own-text leaves with relative paths). Nothing is vendored.
 *
 * Invariants:
 * - Every candidate is code-enumerated; the chooser only picks ids (R7).
 * - Password, file and hidden inputs are never typeable targets (R24).
 * - The control filter mirrors src/browser/policy.ts `allowedControl` (R38);
 *   tests assert NAVVI_DENY_LIST equals DENY_LIST there.
 * - Ids are stable across calls within a page (WeakMap identity).
 */
(() => {
  if (window.__navvi) return true;

  // Keep in sync with DENY_LIST in src/browser/policy.ts (checked by tests/snapshot.test.ts).
  var NAVVI_DENY_LIST = [
    "delete", "remove", "buy", "purchase", "checkout", "check out", "pay", "confirm", "order", "send", "post",
    "publish", "subscribe", "unsubscribe", "sign out", "signout", "log out", "logout", "follow", "report",
    "eliminar", "borrar", "quitar", "comprar", "pagar", "confirmar", "pedir", "enviar", "publicar", "suscribir",
    "suscribirse", "desuscribir", "desuscribirse", "cerrar sesión", "seguir", "reportar", "denunciar"
  ];
  var PAYMENT_PATTERNS = [/^cc-/i, /card/i, /cvv/i, /cvc/i, /\bcc\b/i, /credit/i, /iban/i, /tarjeta/i];
  var DEFAULT_CAPS = { minGroupItems: 4, maxGroups: 20, maxLeaves: 80, maxLinks: 60, maxControls: 150 };
  var SAMPLE_TEXT_CHARS = 140;
  var LEAF_TEXT_CHARS = 120;
  var SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK", "BR", "HR", "OPTION", "IFRAME", "PATH", "TITLE"]);
  var NOISE_SELECTOR = "header, footer, nav, aside, [role=\"navigation\"], [role=\"banner\"], [role=\"contentinfo\"]";
  var CONTROL_ROLES = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
  var CONTROL_SELECTOR = "a[href],button,input,textarea,select,summary,[contenteditable=\"true\"]," + CONTROL_ROLES.map((r) => "[role=\"" + r + "\"]").join(",");

  // ------------------------------------------------------------ identity
  var cache = window.__navviCache || (window.__navviCache = { ids: new WeakMap(), keys: new Map(), next: 1 });
  function identity(el) {
    var id = cache.ids.get(el);
    if (!id) { id = cache.next++; cache.ids.set(el, id); }
    return id;
  }
  function keyId(prefix, key) {
    var full = prefix + "|" + key;
    var id = cache.keys.get(full);
    if (!id) { id = prefix + cache.next++; cache.keys.set(full, id); }
    return id;
  }

  // ------------------------------------------------------------ text
  function squash(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function normalize(text) {
    return squash(String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
  }
  function ownText(el) {
    var s = "";
    for (var n of el.childNodes) if (n.nodeType === 3) s += n.textContent + " ";
    return squash(s).slice(0, LEAF_TEXT_CHARS);
  }
  function fullText(el, n) {
    var t = el.innerText != null ? el.innerText : el.textContent;
    return squash(t).slice(0, n || 400);
  }
  function esc(s) { return CSS.escape(s); }

  // ------------------------------------------------------------ visibility
  function visible(el) {
    if (!el || !el.isConnected || el.nodeType !== 1) return false;
    if (el.closest("[aria-hidden=\"true\"],[inert]")) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function skippable(el) { return SKIP_TAGS.has(el.tagName.toUpperCase()); }

  // ------------------------------------------------------------ classes and selectors (KTD6)
  function isStableClass(c) {
    if (!c || c.length > 40) return false;
    if (/^(css|sc|jsx|emotion|chakra|styled|svelte|astro|nuxt)-/i.test(c)) return false;
    if (/^_/.test(c)) return false;
    if (/^[a-f0-9]{5,}$/i.test(c)) return false;
    var m = /[-_]([A-Za-z0-9]{5,})$/.exec(c);
    if (m && /\d/.test(m[1])) return false;
    if (!/[-_]/.test(c) && c.length >= 6 && (c.match(/\d/g) || []).length >= 2) return false;
    return true;
  }
  function stableClasses(el) {
    var out = [];
    for (var c of el.classList) if (isStableClass(c) && out.indexOf(c) < 0) out.push(c);
    return out;
  }
  function segment(el) {
    var tag = el.localName;
    var classes = stableClasses(el).slice(0, 3);
    return classes.length ? tag + "." + classes.map(esc).join(".") : tag;
  }
  function signature(el) {
    return el.localName + "." + stableClasses(el).sort().join(".");
  }
  function elementChildren(el) {
    var out = [];
    for (var k of el.children) if (!skippable(k)) out.push(k);
    return out;
  }
  function unique(root, sel, el) {
    var m;
    try { m = root.querySelectorAll(sel); } catch (e) { return false; }
    return m.length === 1 && m[0] === el;
  }
  function isStableId(id) {
    return id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && isStableClass(id);
  }
  /**
   * Shortest selector, relative to `root`, that resolves to `el` and only `el`
   * (`root.querySelectorAll`). Order: stable id, data-testid, own tag+classes,
   * a stable ancestor + own segment, then the full `:scope >` path with
   * `:nth-of-type` only where siblings are ambiguous.
   */
  function selectorFor(el, root) {
    if (el === root) return ":scope";
    if (isStableId(el.id)) {
      var byId = "#" + esc(el.id);
      if (unique(root, byId, el)) return byId;
    }
    var own = segment(el);
    var tries = [];
    var testId = el.getAttribute("data-testid");
    if (testId) tries.push(el.localName + "[data-testid=\"" + testId.replace(/"/g, "\\\"") + "\"]");
    tries.push(own);
    for (var a = el.parentElement; a && a !== root; a = a.parentElement) {
      var ctx = isStableId(a.id) ? "#" + esc(a.id) : segment(a);
      if (ctx !== a.localName) {
        tries.push(ctx + " > " + own);
        tries.push(ctx + " " + own);
        break;
      }
    }
    for (var t of tries) if (unique(root, t, el)) return t;
    var parts = [];
    for (var e = el; e && e !== root; e = e.parentElement) {
      var s = segment(e);
      var parent = e.parentElement;
      if (parent) {
        var sameTag = [];
        for (var k of parent.children) if (k.localName === e.localName) sameTag.push(k);
        if (sameTag.length > 1) s += ":nth-of-type(" + (sameTag.indexOf(e) + 1) + ")";
      }
      parts.unshift(s);
      if (!parent) break;
    }
    return ":scope > " + parts.join(" > ");
  }
  function pathFor(el, root) {
    if (el === root) return ":scope";
    var parts = [];
    for (var e = el; e && e !== root; e = e.parentElement) parts.unshift(segment(e));
    return parts.join("/");
  }

  // ------------------------------------------------------------ shapes and labels
  var MONTHS = "(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|" +
    "ene|enero|febrero|marzo|abr|abril|mayo|junio|julio|ago|agosto|septiembre|octubre|noviembre|dic|diciembre)\\.?";
  var MONTH_DAY_RE = new RegExp("\\b" + MONTHS + "\\b \\d{1,2}(,? \\d{4})?\\b", "i");
  var DAY_MONTH_RE = new RegExp("\\b\\d{1,2} (de )?" + MONTHS + "\\b( (de )?\\d{4})?\\b", "i");
  function shapeOf(text, attr) {
    if (attr === "href" || attr === "src") return "url";
    if (attr === "datetime") return "date";
    var t = squash(text);
    if (/^https?:\/\/\S+$/i.test(t)) return "url";
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return "date";
    if (/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t)) return "date";
    if (MONTH_DAY_RE.test(t)) return "date";
    if (DAY_MONTH_RE.test(t)) return "date";
    if (/\b\d+ (seconds?|minutes?|hours?|days?|weeks?|months?|years?) ago\b/i.test(t) || /^hace \d+ /i.test(t)) return "date";
    if (/(^|[\s(])(\$|€|£|US\$|R\$|CLP|USD|EUR|MXN|ARS|COP|PEN|BRL)\s?\d/i.test(t) || /\d\s?(€|£|CLP|USD|EUR|MXN|ARS|pesos)\b/i.test(t)) return "money";
    if (/^[-+]?\d{1,3}([.,]\d{3})*$/.test(t) || /^[-+]?\d+$/.test(t)) return "int";
    return "text";
  }
  function labelFor(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return squash(aria).slice(0, 40);
    var prev = el.previousElementSibling;
    if (prev && !skippable(prev)) {
      var t = fullText(prev, 60);
      if (t && t.length <= 40 && shapeOf(t) === "text") return t;
    }
    var parent = el.parentElement;
    if (parent) {
      var own = ownText(parent);
      if (own && own.length <= 40 && shapeOf(own) === "text") return own;
      if (parent.localName === "dd" && parent.previousElementSibling && parent.previousElementSibling.localName === "dt") {
        return fullText(parent.previousElementSibling, 40);
      }
    }
    var cell = el.closest("td");
    if (cell && cell.parentElement) {
      var idx = Array.prototype.indexOf.call(cell.parentElement.children, cell);
      var table = cell.closest("table");
      var head = table && table.querySelector("thead tr, tr");
      var th = head && head.children[idx];
      if (th && th.localName === "th") return fullText(th, 40);
    }
    return "";
  }

  // ------------------------------------------------------------ groups (KTD5)
  /** Total length of the (at most three) 400-char sample texts. */
  function textSum(fullTexts) {
    var sum = 0;
    for (var t of fullTexts) sum += t.length;
    return sum;
  }
  /** Rank: many items help logarithmically; the shortest of the first three sample texts must carry content. */
  function groupScore(count, texts) {
    var shortest = 1e9;
    for (var t of texts) shortest = Math.min(shortest, t.length);
    return Math.log2(count + 1) * Math.min(shortest === 1e9 ? 0 : shortest, 200);
  }
  function identicalTexts(texts) {
    var set = new Set(texts.map(normalize));
    return set.size === 1;
  }
  function periodOf(kids, min) {
    var sigs = kids.map(signature);
    for (var p = 2; p <= 4; p++) {
      var full = Math.floor(sigs.length / p);
      if (full < min) continue;
      var pattern = sigs.slice(0, p);
      if (new Set(pattern).size === 1) continue;
      var ok = true;
      for (var i = 0; i < full * p; i++) if (sigs[i] !== pattern[i % p]) { ok = false; break; }
      if (!ok) continue;
      var anchorIdx = -1;
      for (var j = 0; j < p; j++) if (pattern.indexOf(pattern[j]) === j && pattern.lastIndexOf(pattern[j]) === j) { anchorIdx = j; break; }
      if (anchorIdx < 0) continue;
      return { span: p, anchorSig: pattern[anchorIdx], offset: anchorIdx };
    }
    return null;
  }
  function rowsFor(anchor, span) {
    var rows = [anchor];
    var s = anchor;
    for (var i = 1; i < span; i++) {
      s = s.nextElementSibling;
      if (!s) break;
      rows.push(s);
    }
    return rows;
  }
  function itemText(rows, n) {
    return rows.map((r) => fullText(r, n)).filter(Boolean).join(" | ").slice(0, n);
  }
  function groupCandidates(opts) {
    var min = opts.minGroupItems;
    var root = document.documentElement;
    var found = [];
    for (var parent of document.body.querySelectorAll("*")) {
      if (skippable(parent) || parent.closest("script,style,noscript,template,svg")) continue;
      var kids = elementChildren(parent);
      if (kids.length < min) continue;
      var counts = new Map();
      for (var k of kids) { var sg = signature(k); counts.set(sg, (counts.get(sg) || 0) + 1); }
      var best = null, n = 0;
      for (var entry of counts) if (entry[1] > n) { best = entry[0]; n = entry[1]; }
      if (n >= min) {
        var items = kids.filter((c) => signature(c) === best);
        // One innerText per sample item: the 140-char sample and the 30-char floor both derive from the 400-char text.
        var fullTexts = items.slice(0, 3).map((c) => fullText(c, 400));
        var texts = fullTexts.map((t) => t.slice(0, SAMPLE_TEXT_CHARS));
        if (textSum(fullTexts) >= 30 && !identicalTexts(texts) && visible(items[0])) {
          found.push({
            id: keyId("g", identity(parent) + "|" + best),
            parent: parent,
            selector: selectorFor(parent, root),
            itemSelector: segment(items[0]),
            itemCount: items.length,
            sampleTexts: texts,
            sig: best,
            score: groupScore(items.length, fullTexts),
          });
        }
      }
      if (kids.length >= 2 * min) {
        var period = periodOf(kids, min);
        if (period) {
          var anchors = kids.filter((c) => signature(c) === period.anchorSig);
          var fullSamples = anchors.slice(0, 3).map((a) => itemText(rowsFor(a, period.span), 400));
          var samples = fullSamples.map((t) => t.slice(0, SAMPLE_TEXT_CHARS));
          if (anchors.length >= min && samples.join("").length >= 30 && !identicalTexts(samples) && visible(anchors[0])) {
            var parentSel = selectorFor(parent, root);
            var anchorSeg = segment(anchors[0]);
            found.push({
              id: keyId("g", identity(parent) + "|rows|" + period.anchorSig + "|" + period.span),
              parent: parent,
              selector: parentSel,
              itemSelector: anchorSeg,
              itemCount: anchors.length,
              sampleTexts: samples,
              anchorPlusRows: { anchorSelector: parentSel + " > " + anchorSeg, span: period.span },
              sig: "rows:" + period.anchorSig + ":" + period.span,
              score: groupScore(anchors.length, fullSamples),
            });
          }
        }
      }
    }
    found.sort((a, b) => b.score - a.score);
    var seen = new Set(), out = [];
    for (var g of found) {
      var key = g.sig + "|" + g.itemCount;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(g);
      if (out.length >= opts.maxGroups) break;
    }
    return out;
  }

  // ------------------------------------------------------------ leaves
  /** Own-text elements plus href/src/datetime attributes under `row`; selectors relative to `selectorRoot`, paths to `pathRoot`. */
  function collectLeaves(row, selectorRoot, pathRoot, prefix, sink) {
    var walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => {
        if (skippable(el) || el.localName === "input" || el.localName === "select" || el.localName === "textarea") return NodeFilter.FILTER_REJECT;
        if (!visible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var el = row;
    var skipRoot = null;
    while (el) {
      if (skipRoot && skipRoot !== el && skipRoot.contains(el)) { el = walker.nextNode(); continue; }
      var path = prefix + pathFor(el, pathRoot);
      var own = ownText(el);
      if (own) sink.push({ el: el, leaf: leaf(el, null, own, path, selectorRoot) });
      else {
        // A short inline container made only of text fragments (a price split into currency, integer and
        // decimals, a date split into parts) is one composite candidate with its joined text; the fragments
        // themselves are meaningless alone and are not offered.
        var joined = fragmentText(el);
        if (joined) { sink.push({ el: el, leaf: leaf(el, null, joined, path, selectorRoot) }); skipRoot = el; }
      }
      if (el.localName === "a" && el.getAttribute("href")) sink.push({ el: el, leaf: leaf(el, "href", squash(el.getAttribute("href")).slice(0, LEAF_TEXT_CHARS), path + "/@href", selectorRoot) });
      if (el.localName === "img" && el.getAttribute("src")) sink.push({ el: el, leaf: leaf(el, "src", squash(el.getAttribute("src")).slice(0, LEAF_TEXT_CHARS), path + "/@src", selectorRoot) });
      if (el.localName === "time" && el.getAttribute("datetime")) sink.push({ el: el, leaf: leaf(el, "datetime", squash(el.getAttribute("datetime")), path + "/@datetime", selectorRoot) });
      el = walker.nextNode();
    }
  }
  var FRAGMENT_TAGS = new Set(["span", "b", "i", "em", "strong", "sup", "sub", "small", "bdi", "abbr"]);
  var FRAGMENT_TEXT_CHARS = 40;
  var FRAGMENT_PART_CHARS = 6;
  /** Joined text of an element whose children are two or more visible inline text fragments and nothing else. */
  function fragmentText(el) {
    if (!FRAGMENT_TAGS.has(el.localName) && el.localName !== "div" && el.localName !== "p" && el.localName !== "td") return "";
    var kids = Array.from(el.children);
    if (kids.length < 2 || kids.length > 8) return "";
    for (var k of kids) {
      if (!FRAGMENT_TAGS.has(k.localName) || k.children.length > 0 || !visible(k)) return "";
      // Each fragment must be meaningless on its own: a currency sign, digits, a separator, a short unit code.
      var part = squash(k.textContent || "");
      if (part.length > FRAGMENT_PART_CHARS || !/^(?:[^A-Za-z\u00C0-\u024F]+|[A-Za-z]{1,3})$/.test(part)) return "";
    }
    var text = squash(el.textContent || "");
    if (!text || text.length > FRAGMENT_TEXT_CHARS) return "";
    return text;
  }
  function leaf(el, attr, text, path, selectorRoot) {
    var out = {
      id: "l" + identity(el) + (attr ? "@" + attr : ""),
      path: path,
      selector: selectorFor(el, selectorRoot),
      text: text,
      label: labelFor(el),
      shape: shapeOf(text, attr),
    };
    if (attr) out.attr = attr;
    return out;
  }
  /** Document leaves: main content first, header/nav/footer/aside noise after, then the cap. */
  function documentLeaves(max) {
    var all = [];
    collectLeaves(document.body, document.documentElement, document.body, "", all);
    var main = [], noise = [];
    for (var entry of all) (entry.el.closest(NOISE_SELECTOR) ? noise : main).push(entry.leaf);
    return main.concat(noise).slice(0, max);
  }

  // ------------------------------------------------------------ links
  function sameSite(href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return false; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    var a = u.hostname.toLowerCase(), b = location.hostname.toLowerCase();
    if (a === b) return true;
    var tail = (h) => h.split(".").slice(-2).join(".");
    return !/^\d+(\.\d+){3}$/.test(a) && !/^\d+(\.\d+){3}$/.test(b) && tail(a) === tail(b);
  }
  /** Position among siblings with the same signature, so `hide` and `comments` links in one span stay apart. */
  function siblingIndex(el) {
    var sig = signature(el), i = 0;
    for (var k of el.parentElement ? el.parentElement.children : []) {
      if (k === el) return i;
      if (signature(k) === sig) i++;
    }
    return i;
  }
  function depthMap(el) {
    var m = new Map(), d = 0;
    for (var e = el; e; e = e.parentElement) m.set(e, d++);
    return m;
  }
  function distance(fromMap, to) {
    var d = 0;
    for (var e = to; e; e = e.parentElement, d++) if (fromMap.has(e)) return fromMap.get(e) + d;
    return 1e6;
  }
  /**
   * Visible, named, on-domain anchors. Inside the top group, anchors that share
   * a path relative to the group parent (every item's detail link) collapse
   * into one entry with a count. Sorted nearest to the group first.
   */
  function linkCandidates(scope, group, max) {
    var groupMap = group ? depthMap(group.parent) : null;
    var seen = new Map(), out = [], i = 0;
    for (var a of scope.querySelectorAll("a[href]")) {
      var raw = a.getAttribute("href") || "";
      if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw) || !visible(a) || !sameSite(raw)) continue;
      var href = new URL(raw, location.href).href;
      var text = accessibleName(a).slice(0, 60);
      if (!text) continue;
      var inGroup = group && group.parent !== a && group.parent.contains(a);
      var key = inGroup ? "path:" + pathFor(a, group.parent) + "#" + siblingIndex(a) : href + "|" + text;
      var existing = seen.get(key);
      if (existing) { existing.count++; continue; }
      var entry = { id: "k" + identity(a), selector: selectorFor(a, document.documentElement), text: text, href: href, count: 1, order: i++, dist: groupMap ? distance(groupMap, a) : 0 };
      seen.set(key, entry);
      out.push(entry);
    }
    out.sort((x, y) => x.dist - y.dist || x.order - y.order);
    return out.slice(0, max).map((l) => ({ id: l.id, selector: l.selector, text: l.text, href: l.href, count: l.count }));
  }

  // ------------------------------------------------------------ candidates entry point
  /**
   * Document mode: groups, document leaves and on-domain links (nearest to the
   * top group first). Item mode (`within` = selector of the item anchors,
   * `itemIndex`, optional `span` for anchor-plus-rows): leaves of that one item,
   * with paths relative to the anchor (`+1/...` for the following rows) and
   * selectors relative to each row.
   */
  function candidates(input) {
    var opts = Object.assign({}, DEFAULT_CAPS, input || {});
    if (opts.within) {
      var anchors = document.querySelectorAll(opts.within);
      var anchor = anchors[opts.itemIndex || 0];
      if (!anchor) return { groups: [], leaves: [], links: [] };
      var rows = rowsFor(anchor, opts.span || 1);
      var entries = [];
      rows.forEach((row, r) => collectLeaves(row, row, row, r ? "+" + r + "/" : "", entries));
      var links = [];
      for (var row of rows) links = links.concat(linkCandidates(row, null, opts.maxLinks));
      return { groups: [], leaves: entries.map((e) => e.leaf).slice(0, opts.maxLeaves), links: links.slice(0, opts.maxLinks) };
    }
    var groups = groupCandidates(opts);
    var top = groups[0] || null;
    return {
      groups: groups.map((g) => {
        var out = { id: g.id, selector: g.selector, itemSelector: g.itemSelector, itemCount: g.itemCount, sampleTexts: g.sampleTexts };
        if (g.anchorPlusRows) out.anchorPlusRows = g.anchorPlusRows;
        return out;
      }),
      leaves: documentLeaves(opts.maxLeaves),
      links: linkCandidates(document, top, opts.maxLinks),
    };
  }

  /** Resolves one leaf selector the way replay does: `:scope` is the row itself; rows are tried in order. */
  function resolveLeaf(input) {
    var rows;
    if (input.within) {
      var anchor = document.querySelectorAll(input.within)[input.itemIndex || 0];
      if (!anchor) return null;
      rows = rowsFor(anchor, input.span || 1);
    } else {
      rows = [document.documentElement];
    }
    for (var row of rows) {
      var el = null;
      try { el = row.matches(input.selector) ? row : row.querySelector(input.selector); } catch (e) { return null; }
      if (!el) continue;
      if (input.attr) return squash(el.getAttribute(input.attr));
      return ownText(el) || fullText(el, LEAF_TEXT_CHARS);
    }
    return null;
  }

  // ------------------------------------------------------------ controls (R24, R38)
  function accessibleName(e, seen) {
    seen = seen || new Set();
    if (!e || seen.has(e)) return "";
    seen.add(e);
    var referenced = (e.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => accessibleName(document.getElementById(id), seen)).filter(Boolean).join(" ");
    return squash(
      referenced || e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => accessibleName(l, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") || e.getAttribute("alt") ||
      (e.tagName === "INPUT" ? "" : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" ? accessibleName(n, seen) : "").join(" ").trim()) ||
      e.getAttribute("title") || e.getAttribute("placeholder") || "",
    );
  }
  function roleOf(e) {
    var explicit = e.getAttribute("role");
    if (CONTROL_ROLES.includes(explicit)) return explicit;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return "link";
    if (e.tagName === "SELECT") return "combobox";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      var t = (e.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "search") return "searchbox";
      if (t === "number") return "spinbutton";
      if (["text", "email", "url", "tel", "password", "date", "datetime-local", "month", "week", "time"].includes(t)) return "textbox";
    }
    return null;
  }
  var DENY_PATTERNS = NAVVI_DENY_LIST.map((term) => ({ term: term, pattern: new RegExp("(^|[^\\p{L}\\p{N}])" + normalize(term) + "([^\\p{L}\\p{N}]|$)", "u") }));
  function deniedName(name) {
    var text = normalize(name);
    if (!text) return null;
    for (var d of DENY_PATTERNS) if (d.pattern.test(text)) return d.term;
    return null;
  }
  function matchesAny(value, patterns) { return value != null && value !== "" && patterns.some((p) => p.test(value)); }
  function isPaymentInput(e) {
    return matchesAny(e.getAttribute("autocomplete"), PAYMENT_PATTERNS) || matchesAny(e.getAttribute("name"), PAYMENT_PATTERNS);
  }
  function isTextLike(e) {
    if (e.localName === "textarea") return true;
    if (e.localName !== "input") return false;
    var t = (e.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "number"].includes(t);
  }
  /** `memo`: per-form cache for one controls() call (a form's info is the same for every control in it). Each control gets its own copy. */
  function formInfo(form, memo) {
    if (!form) return null;
    var info = memo && memo.get(form);
    if (!info) {
      info = computeFormInfo(form);
      if (memo) memo.set(form, info);
    }
    return Object.assign({}, info);
  }
  function computeFormInfo(form) {
    var hasTypedText = false, hasPasswordField = false, hasPaymentField = false;
    for (var e of form.querySelectorAll("input,textarea")) {
      var t = (e.getAttribute("type") || "text").toLowerCase();
      if (t === "password") hasPasswordField = true;
      if (isPaymentInput(e)) hasPaymentField = true;
      if (isTextLike(e) && e.value !== "" && e.value !== e.defaultValue) hasTypedText = true;
    }
    return {
      method: (form.getAttribute("method") || "get").toLowerCase(),
      action: form.getAttribute("action") || "",
      hasTypedText: hasTypedText,
      hasPasswordField: hasPasswordField,
      hasPaymentField: hasPaymentField,
    };
  }
  function isSubmitControl(c) {
    if (!c.form) return false;
    var type = c.inputType;
    if (type === "submit" || type === "image") return true;
    return c.tag === "button" && (type === undefined || type === "submit");
  }
  /** Mirror of policy.ts allowedControl: same order, same reasons. */
  function allowedControl(c, profile, allowMutations) {
    var inputType = c.inputType;
    if (inputType === "password") return { allowed: false, reason: "password" };
    if (inputType === "file") return { allowed: false, reason: "file" };
    if (inputType === "hidden") return { allowed: false, reason: "hidden" };
    if (matchesAny(c.autocomplete, PAYMENT_PATTERNS) || matchesAny(c.nameAttr, PAYMENT_PATTERNS)) return { allowed: false, reason: "payment" };
    if (c.form && c.form.hasPaymentField && isSubmitControl(c)) return { allowed: false, reason: "payment-form" };
    if (profile === "store" && isSubmitControl(c) && c.form) {
      if (c.form.method === "post" && !(c.form.hasTypedText && !c.form.hasPasswordField)) return { allowed: false, reason: "store-post" };
    }
    var term = deniedName(c.name);
    if (term) {
      var name = normalize(c.name);
      var ok = profile === "local" && allowMutations.some((entry) => normalize(entry) === normalize(term) || normalize(entry) === name);
      if (ok) return { allowed: true };
      return { allowed: false, reason: "deny:" + term };
    }
    return { allowed: true };
  }
  function scopeText(e) {
    var scope = e.closest("form,dialog,[role=\"dialog\"],article,li,tr,[role=\"row\"]") || e.parentElement;
    return scope ? fullText(scope, 120) : "";
  }
  function hitTest(e) {
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      e.scrollIntoView({ block: "center", inline: "center" });
      r = e.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    }
    var hit = document.elementFromPoint(x, y);
    return !!hit && (hit === e || e.contains(hit));
  }
  function controls(input) {
    var opts = input || {};
    var profile = opts.profile === "local" ? "local" : "store";
    var allowMutations = Array.isArray(opts.allowMutations) ? opts.allowMutations : [];
    var out = [];
    var forms = new Map();
    var scrollX0 = window.scrollX, scrollY0 = window.scrollY;
    for (var e of document.querySelectorAll(CONTROL_SELECTOR)) {
      if (!visible(e)) continue;
      if (out.length >= (opts.maxControls || DEFAULT_CAPS.maxControls)) break;
      var role = roleOf(e);
      if (!role) continue;
      if (role === "gridcell" && e.querySelector("button,[role=\"button\"]")) continue;
      var tag = e.localName;
      var typeAttr = e.getAttribute("type");
      var inputType = tag === "input" ? (typeAttr || "text").toLowerCase() : (tag === "button" && typeAttr ? typeAttr.toLowerCase() : undefined);
      var disabled = e.matches(":disabled") || !!e.closest("[aria-disabled=\"true\"]");
      var control = {
        id: "c" + identity(e),
        role: role,
        name: accessibleName(e) || role,
        tag: tag,
        inputType: inputType,
        value: inputType === "password" ? "" : ("value" in e && tag !== "button" ? String(e.value).slice(0, 80) : (e.isContentEditable ? fullText(e, 80) : "")),
        checked: inputType === "checkbox" || inputType === "radio" ? !!e.checked : (e.getAttribute("aria-checked") === "true" ? true : undefined),
        disabled: disabled,
        visible: true,
        clickable: !disabled && hitTest(e),
        scope: scopeText(e),
        form: formInfo(e.form || e.closest("form"), forms),
        autocomplete: e.getAttribute("autocomplete") || undefined,
        nameAttr: e.getAttribute("name") || undefined,
        idAttr: e.id || undefined,
        secretCapable: inputType === "password",
        href: tag === "a" ? e.href : undefined,
      };
      var decision = allowedControl(control, profile, allowMutations);
      if (!decision.allowed && decision.reason !== "password") continue;
      out.push(control);
    }
    if (window.scrollX !== scrollX0 || window.scrollY !== scrollY0) window.scrollTo(scrollX0, scrollY0);
    var max = opts.maxControls || DEFAULT_CAPS.maxControls;
    return out.length > max ? out.slice(0, max) : out;
  }

  // ------------------------------------------------------------ freshness
  function freshness() {
    var values = [];
    for (var e of document.querySelectorAll("input,textarea,select")) {
      var t = (e.getAttribute("type") || "text").toLowerCase();
      if (t === "password" || t === "file" || t === "hidden") continue;
      values.push([identity(e), String(e.value), !!e.checked]);
    }
    return { url: location.href, text: document.body ? fullText(document.body, 20000) : "", values: values };
  }

  window.__navvi = {
    controls: controls,
    candidates: candidates,
    resolveLeaf: resolveLeaf,
    freshness: freshness,
    DEFAULT_CAPS: DEFAULT_CAPS,
  };
  return true;
})();
