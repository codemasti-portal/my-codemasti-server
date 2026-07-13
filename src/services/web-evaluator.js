const cheerio = require("cheerio");
const csstree = require("css-tree");
const { colord, extend } = require("colord");
const namesPlugin = require("colord/plugins/names");

// Enables parsing of named colors ("red", "gray", …) in addition to hex/rgb/hsl.
extend([namesPlugin.default || namesPlugin]);

/** Max bytes per HTML or CSS field. Rejects oversized submissions before parsing. */
const MAX_FIELD_BYTES = 100_000;

const VALID_CHECK_TYPES = new Set([
  "element_exists",
  "element_text",
  "element_attribute",
  "element_count",
  "css_rule_exists",
  "css_property",
]);

/**
 * CSS properties that inherit from parent → child. Subset that matters for grading:
 * if an element has no direct value for one of these, it takes the nearest ancestor's,
 * mirroring how a browser renders (e.g. <li> text color comes from a styled <ul>).
 */
const INHERITED_PROPS = new Set([
  "color", "font", "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform",
  "text-decoration", "white-space", "visibility", "cursor", "direction",
  "list-style", "list-style-type", "list-style-position",
]);

/** Border keywords, used to classify tokens when expanding the `border` shorthand. */
const BORDER_STYLES = new Set([
  "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset",
]);

/** Zero-length values: the unit is optional per CSS spec (0 === 0px === 0em …). */
const ZERO_LENGTH_RE = /^0(px|em|rem|%|vh|vw|vmin|vmax|pt|pc|cm|mm|in|ex|ch|fr)$/;
/** A single numeric token with an optional unit, e.g. "20px", "1.5rem", "-3", "50%". */
const NUMERIC_RE = /^(-?\d*\.?\d+)([a-z%]*)$/;

// ─────────────────────────────────────────────────────────────────────────────
// Value normalization — so equivalent spellings of the SAME value compare equal.
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, trim, and collapse internal whitespace to a single space. */
function normText(raw) {
  return String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Canonicalize a numeric token: 20.0px → 20px, .5 → 0.5, 020 → 20 (unit preserved). */
function normNumber(tok) {
  const m = tok.match(NUMERIC_RE);
  if (!m) return tok;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return tok;
  return String(n) + m[2];
}

/**
 * Canonicalize one value token so equivalent forms compare equal:
 *  - colors: red / #f00 / #ff0000 / rgb(255,0,0) / green → one rgb() form
 *  - zero lengths: 0px / 0em / 0% → "0"
 *  - numbers: 20.0px → 20px
 *  - strips one layer of surrounding quotes ("Arial" → arial)
 * Input is assumed already lowercased/trimmed.
 */
function normToken(tok) {
  if (!tok) return tok;
  let t = tok;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  const c = colord(t);
  if (c.isValid()) return c.toRgbString().replace(/\s+/g, "");
  if (ZERO_LENGTH_RE.test(t)) return "0";
  return normNumber(t);
}

/** Canonicalize a full (possibly multi-token) CSS value, e.g. "0 auto", "1px solid red". */
function normValueTokens(value) {
  return normText(value).split(" ").filter(Boolean).map(normToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shorthand expansion — so a longhand check (background-color) is satisfied by a
// student's shorthand (background), matching what the browser actually computes.
// Each source declaration is expanded into the shorthand itself PLUS its longhands.
// ─────────────────────────────────────────────────────────────────────────────

function splitTokens(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean);
}

function expandDeclaration(property, value) {
  const out = [{ property, value }];
  const p = property;
  const toks = splitTokens(value);

  if (p === "margin" || p === "padding") {
    let t, r, b, l;
    if (toks.length === 1) { t = r = b = l = toks[0]; }
    else if (toks.length === 2) { t = b = toks[0]; r = l = toks[1]; }
    else if (toks.length === 3) { t = toks[0]; r = l = toks[1]; b = toks[2]; }
    else if (toks.length >= 4) { t = toks[0]; r = toks[1]; b = toks[2]; l = toks[3]; }
    if (t !== undefined) {
      out.push(
        { property: `${p}-top`, value: t }, { property: `${p}-right`, value: r },
        { property: `${p}-bottom`, value: b }, { property: `${p}-left`, value: l },
      );
    }
  } else if (/^border(-(top|right|bottom|left))?$/.test(p)) {
    let w, s, col;
    for (const tk of toks) {
      if (BORDER_STYLES.has(tk.toLowerCase())) s = tk;
      else if (colord(tk).isValid()) col = tk;
      else w = tk;
    }
    if (w !== undefined) out.push({ property: `${p}-width`, value: w });
    if (s !== undefined) out.push({ property: `${p}-style`, value: s });
    if (col !== undefined) out.push({ property: `${p}-color`, value: col });
  } else if (p === "background") {
    for (const tk of toks) {
      if (colord(tk).isValid()) { out.push({ property: "background-color", value: tk }); break; }
    }
  } else if (p === "font") {
    const sizeIdx = toks.findIndex((tk) => /^[\d.]+(px|em|rem|%|pt|vw|vh)?(\/[\d.]+\w*)?$/.test(tk));
    if (sizeIdx >= 0) {
      out.push({ property: "font-size", value: toks[sizeIdx].split("/")[0] });
      const fam = toks.slice(sizeIdx + 1).join(" ");
      if (fam) out.push({ property: "font-family", value: fam });
    }
  }
  return out;
}

/** Parse an inline style="" attribute into declarations (with !important flags). */
function parseInlineStyle(styleStr) {
  const out = [];
  String(styleStr || "").split(";").forEach((pair) => {
    const idx = pair.indexOf(":");
    if (idx < 0) return;
    const property = pair.slice(0, idx).trim().toLowerCase();
    let value = pair.slice(idx + 1).trim();
    let important = false;
    if (/!important\s*$/i.test(value)) { important = true; value = value.replace(/!important\s*$/i, "").trim(); }
    if (property && value) {
      for (const ex of expandDeclaration(property, value)) {
        out.push({ property: ex.property.toLowerCase(), value: ex.value, important });
      }
    }
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS parsing → a flat, ordered rule list with per-selector specificity.
// ─────────────────────────────────────────────────────────────────────────────

/** Count specificity [ids, classes/attrs/pseudo-classes, types/pseudo-elements] and flag pseudo-elements. */
function analyzeSelectorNode(selNode) {
  let a = 0, b = 0, c = 0, pseudoEl = false;
  csstree.walk(selNode, (node) => {
    switch (node.type) {
      case "IdSelector": a++; break;
      case "ClassSelector":
      case "AttributeSelector":
      case "PseudoClassSelector": b++; break;
      case "TypeSelector": if (node.name !== "*") c++; break;
      case "PseudoElementSelector": c++; pseudoEl = true; break;
      default: break;
    }
  });
  let text = "";
  try { text = csstree.generate(selNode); } catch { text = ""; }
  return { text, spec: [a, b, c], pseudoEl };
}

/**
 * Parse raw CSS into ordered rules:
 *   { selectors: [{text, spec, pseudoEl}], decls: [{property, value, important, seq}], conditional }
 * `seq` is a document-order counter (later declarations win ties). `conditional` marks
 * rules inside @media/@supports (viewport-dependent — excluded from the resting-state check).
 * Never throws — invalid CSS yields whatever parsed cleanly.
 */
function buildRules(cssStr) {
  const rules = [];
  if (!cssStr.trim()) return rules;
  let ast;
  try { ast = csstree.parse(cssStr, { positions: false, onParseError: () => {} }); }
  catch { return rules; }

  let seq = 0;

  const addRule = (node, conditional) => {
    const selectors = [];
    if (node.prelude && node.prelude.type === "SelectorList") {
      node.prelude.children.forEach((selNode) => {
        const info = analyzeSelectorNode(selNode);
        if (info.text) selectors.push(info);
      });
    } else if (node.prelude) {
      let text = ""; try { text = csstree.generate(node.prelude); } catch { text = ""; }
      if (text) selectors.push({ text, spec: [0, 0, 0], pseudoEl: false });
    }
    if (!selectors.length) return;

    const decls = [];
    if (node.block && node.block.children) {
      node.block.children.forEach((d) => {
        if (d.type !== "Declaration") return;
        let value = ""; try { value = csstree.generate(d.value); } catch { value = ""; }
        const important = !!d.important;
        const property = String(d.property || "").toLowerCase();
        const s = seq++;
        for (const ex of expandDeclaration(property, value)) {
          decls.push({ property: ex.property.toLowerCase(), value: ex.value, important, seq: s });
        }
      });
    }
    rules.push({ selectors, decls, conditional });
  };

  const walkList = (list, conditional) => {
    if (!list) return;
    list.forEach((node) => {
      if (node.type === "Rule") addRule(node, conditional);
      else if (node.type === "Atrule") {
        const name = String(node.name || "").toLowerCase();
        if ((name === "media" || name === "supports") && node.block && node.block.children) {
          walkList(node.block.children, true);
        }
        // @keyframes / @font-face / @import etc. are not element styling — ignore.
      }
    });
  };
  walkList(ast.children, false);
  return rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade resolution — the same winner a browser would pick.
// ─────────────────────────────────────────────────────────────────────────────

/** True if selector text matches this element in the real DOM. Never throws (pseudo-elements, unknown pseudos → false). */
function matchesElement($, el, selectorText) {
  try { return $(el).is(selectorText); } catch { return false; }
}

/** Cascade sort key: !important > inline > higher specificity > later source order. Higher wins. */
function cascadeKey(cand) {
  return [cand.important ? 1 : 0, cand.inline ? 1 : 0, cand.spec[0], cand.spec[1], cand.spec[2], cand.order];
}
function keyGreater(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/** Winning declared value of `property` directly on `el` (matching rules + inline). null if none. */
function declaredValue($, el, rules, property) {
  let winner = null;
  let winnerKey = null;
  const consider = (cand) => {
    const key = cascadeKey(cand);
    if (!winner || keyGreater(key, winnerKey)) { winner = cand; winnerKey = key; }
  };

  const styleAttr = $(el).attr("style");
  if (styleAttr) {
    for (const d of parseInlineStyle(styleAttr)) {
      if (d.property === property) {
        consider({ value: d.value, important: d.important, inline: true, spec: [0, 0, 0], order: Number.MAX_SAFE_INTEGER });
      }
    }
  }

  for (const rule of rules) {
    if (rule.conditional) continue; // @media/@supports — viewport-dependent, not resting state
    let bestSpec = null;
    for (const s of rule.selectors) {
      if (s.pseudoEl) continue; // ::before etc. target a pseudo-element, not this node
      if (matchesElement($, el, s.text)) {
        if (!bestSpec || keyGreater([...s.spec, 0], [...bestSpec, 0])) bestSpec = s.spec;
      }
    }
    if (!bestSpec) continue;
    for (const d of rule.decls) {
      if (d.property === property) {
        consider({ value: d.value, important: d.important, inline: false, spec: bestSpec, order: d.seq });
      }
    }
  }
  return winner ? winner.value : null;
}

/** Computed value of `property` on `el`, following inheritance for inherited properties. */
function computedValue($, el, rules, property) {
  const direct = declaredValue($, el, rules, property);
  if (direct != null) return direct;
  if (INHERITED_PROPS.has(property)) {
    let node = $(el).parent();
    let guard = 0;
    while (node && node.length && node.get(0) && node.get(0).type === "tag" && guard < 100) {
      const v = declaredValue($, node, rules, property);
      if (v != null) return v;
      node = node.parent();
      guard++;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a single DOM/CSS check against the parsed document ($) and parsed CSS rules.
 * Always returns { label, passed, reason? } — never throws.
 *
 * `reason` is shown to STUDENTS: a soft HINT that names the problem but never reveals
 * the answer (expected value/count) or author-only internals (the selector).
 */
function runCheck(test, $, rules) {
  const label = String(test.label || "Check");
  const NOT_SET_UP = "This check isn't set up correctly — ask your instructor.";
  const MISSING_EL = "This element is missing — add it to your HTML.";
  try {
    switch (test.check_type) {
      case "element_exists": {
        const passed = $(test.selector).length > 0;
        return { label, passed, reason: passed ? undefined : MISSING_EL };
      }

      case "element_text": {
        const el = $(test.selector).first();
        if (!el.length) return { label, passed: false, reason: MISSING_EL };
        const needle = String(test.expected_value || "").trim();
        if (!needle) return { label, passed: false, reason: NOT_SET_UP };
        const passed = (el.text() || "").trim().toLowerCase().includes(needle.toLowerCase());
        return { label, passed, reason: passed ? undefined : "The text here isn't right yet — check the wording." };
      }

      case "element_attribute": {
        const el = $(test.selector).first();
        if (!el.length) return { label, passed: false, reason: MISSING_EL };
        const attrName = String(test.attribute_name || "").trim().toLowerCase();
        if (!attrName) return { label, passed: false, reason: NOT_SET_UP };
        const expected = String(test.expected_value || "").trim();
        const present = typeof el.attr(attrName) !== "undefined";
        if (!expected) {
          return { label, passed: present, reason: present ? undefined : "This element is missing an attribute it needs." };
        }
        let passed;
        if (attrName === "class") {
          const classes = (el.attr("class") || "").split(/\s+/).filter(Boolean);
          passed = classes.includes(expected);
        } else {
          passed = (el.attr(attrName) || "").trim() === expected;
        }
        return { label, passed, reason: passed ? undefined : "This element's attribute isn't set correctly yet." };
      }

      case "element_count": {
        const count = $(test.selector).length;
        const expected = Number(test.expected_count || 0);
        const passed = count === expected;
        return { label, passed, reason: passed ? undefined : `Not the right number yet (you have ${count}).` };
      }

      case "css_rule_exists": {
        const sel = String(test.selector || "").trim();
        if (!sel) return { label, passed: false, reason: NOT_SET_UP };
        const el = $(sel).first();
        const HINT = "You haven't styled this yet — add a CSS rule for it.";
        if (!el.length) return { label, passed: false, reason: HINT };
        // Element-aware: does ANY student rule (with declarations) actually apply to this element?
        const styled = rules.some((rule) => {
          if (rule.conditional || !rule.decls.length) return false;
          return rule.selectors.some((s) => !s.pseudoEl && matchesElement($, el, s.text));
        });
        return { label, passed: styled, reason: styled ? undefined : HINT };
      }

      case "css_property": {
        const prop = normText(test.property_name);
        if (!prop) return { label, passed: false, reason: NOT_SET_UP };
        const sel = String(test.selector || "").trim();
        const el = sel ? $(sel).first() : null;
        if (sel && !el.length) return { label, passed: false, reason: MISSING_EL };

        const expectedTokens = normValueTokens(test.expected_value);
        const hasExpected = expectedTokens.join("").length > 0;

        const matchesValue = (node) => {
          const val = computedValue($, node, rules, prop);
          if (val == null) return false;
          if (!hasExpected) return true; // property present is enough when no value is given
          const actual = normValueTokens(val);
          return (
            actual.join(" ") === expectedTokens.join(" ") ||
            (expectedTokens.length === 1 && actual.includes(expectedTokens[0]))
          );
        };

        // With a selector: evaluate the first matched element (consistent with the other
        // element checks). Without one: pass if ANY element ends up with the value.
        const passed = sel ? matchesValue(el) : $("*").toArray().some((n) => matchesValue($(n)));
        return { label, passed, reason: passed ? undefined : "This style isn't set the way it should be yet." };
      }

      default:
        return { label, passed: false, reason: NOT_SET_UP };
    }
  } catch {
    return { label, passed: false, reason: "Couldn't check this one." };
  }
}

/**
 * Evaluate a web (HTML/CSS) submission against an array of dom_tests.
 *
 * @param {object} opts
 * @param {string} opts.html      - Student HTML
 * @param {string} opts.css       - Student CSS
 * @param {Array}  opts.domTests  - Array of domTest documents from AssignmentQuestion
 * @returns {{ results: Array<{label,passed,reason?}>, passed: number, total: number }}
 */
function evaluateWebSubmission({ html, css, domTests }) {
  const htmlStr = String(html || "");
  const cssStr = String(css || "");

  if (htmlStr.length > MAX_FIELD_BYTES || cssStr.length > MAX_FIELD_BYTES) {
    const err = new Error("Submission too large (max 100 KB per field)");
    err.statusCode = 413;
    throw err;
  }

  if (!Array.isArray(domTests) || domTests.length === 0) {
    return { results: [], passed: 0, total: 0 };
  }

  // cheerio parses HTML only — it never executes scripts or fetches resources,
  // so student submissions cannot run code or trigger SSRF during grading.
  const $ = cheerio.load(htmlStr);
  const rules = buildRules(cssStr);

  const results = domTests
    .filter((t) => VALID_CHECK_TYPES.has(t.check_type))
    .map((t) => runCheck(t, $, rules));

  const passed = results.filter((r) => r.passed).length;
  return { results, passed, total: results.length };
}

module.exports = { evaluateWebSubmission };
