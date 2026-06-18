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

/** Zero-length values: the unit is optional per CSS spec (0 === 0px === 0em …). */
const ZERO_LENGTH_RE = /^0(px|em|rem|%|vh|vw|vmin|vmax|pt|pc|cm|mm|in|ex|ch)$/;

/** Lowercase, trim, and collapse internal whitespace to a single space. */
function normalize(raw) {
  return String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Canonicalize a CSS selector so equivalent spellings match.
 * css-tree normalises combinator whitespace (".a > .b" -> ".a>.b"); we run the
 * check's target selector through the same generator so author and student agree.
 */
function canonSelector(sel) {
  const s = String(sel || "").trim();
  if (!s) return "";
  try {
    return csstree.generate(csstree.parse(s, { context: "selectorList" })).toLowerCase();
  } catch {
    return normalize(s);
  }
}

/**
 * Canonicalize a single CSS value token so equivalent forms compare equal:
 *  - colors: red / #f00 / #ff0000 / rgb(255,0,0) / hsl(0,100%,50%) -> "rgb(255,0,0)"
 *  - zero lengths: 0px / 0em / 0% -> "0"
 * Anything else (keywords like flex/bold/center, sizes like 16px) passes through unchanged.
 * Input is assumed already lowercased/trimmed.
 */
function normValueToken(tok) {
  if (!tok) return tok;
  const c = colord(tok);
  if (c.isValid()) return c.toRgbString().replace(/\s+/g, "");
  if (ZERO_LENGTH_RE.test(tok)) return "0";
  return tok;
}

/** Canonicalize a full (possibly multi-token) CSS value, e.g. "0 auto", "1px solid red". */
function normValue(value) {
  return normalize(value).split(" ").filter(Boolean).map(normValueToken);
}

/**
 * Parse raw CSS into a flat list of rules: each { selectors: string[], declarations: [{property, value}] }.
 * Selectors and properties are normalised for reliable comparison. Never throws — invalid CSS yields [].
 *
 * This replaces the previous substring matching, which produced false positives
 * (e.g. "color:red" matched inside "background-color:red") and could not scope a
 * property to a specific selector.
 */
function parseCssRules(cssStr) {
  const rules = [];
  if (!cssStr.trim()) return rules;
  let ast;
  try {
    ast = csstree.parse(cssStr, { positions: false, onParseError: () => {} });
  } catch {
    return rules;
  }

  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      // prelude is a SelectorList (or Raw for unparseable selectors).
      let selectors = [];
      try {
        const preludeText = csstree.generate(node.prelude);
        selectors = preludeText.split(",").map((s) => canonSelector(s)).filter(Boolean);
      } catch {
        selectors = [];
      }

      const declarations = [];
      if (node.block && node.block.children) {
        node.block.children.forEach((decl) => {
          if (decl.type !== "Declaration") return;
          let value = "";
          try {
            value = normalize(csstree.generate(decl.value));
          } catch {
            value = "";
          }
          declarations.push({ property: normalize(decl.property), value });
        });
      }

      rules.push({ selectors, declarations });
    },
  });

  return rules;
}

/**
 * Run a single DOM/CSS check against the parsed document ($) and parsed CSS rules.
 * Always returns { label, passed, reason? } — never throws.
 *
 * IMPORTANT: `reason` is shown to STUDENTS. It must be a soft HINT that names the
 * problem but NEVER reveals the answer (expected value/count) or hidden internals
 * (the selector / expected_value are author-only). The student's own current value
 * (e.g. their element count) is fine to show — it's their code, not the answer.
 */
function runCheck(test, $, cssRules) {
  const label = String(test.label || "Check");
  // Author-config problems (shouldn't reach students if the editor lint is heeded).
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
        // Empty expected value ⇒ "attribute exists" check (any value, incl. boolean attrs).
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
        // Showing the student's OWN count is fine; the target is the answer, so it's hidden.
        return { label, passed, reason: passed ? undefined : `Not the right number yet (you have ${count}).` };
      }

      case "css_rule_exists": {
        const target = canonSelector(test.selector);
        if (!target) return { label, passed: false, reason: NOT_SET_UP };
        const found = cssRules.some((r) => r.selectors.includes(target));
        return { label, passed: found, reason: found ? undefined : "You haven't styled this yet — add a CSS rule for it." };
      }

      case "css_property": {
        const prop = normalize(test.property_name);
        if (!prop) return { label, passed: false, reason: NOT_SET_UP };
        // Optional scoping: if the check carries a selector, only inspect matching rules.
        const scope = canonSelector(test.selector);
        const candidateRules = scope
          ? cssRules.filter((r) => r.selectors.includes(scope))
          : cssRules;

        // Value matching is equivalence-aware: colors and zero-lengths are canonicalized
        // so red / #f00 / rgb(255,0,0) all match, and 0 === 0px.
        const expectedTokens = normValue(test.expected_value);
        const hasExpected = expectedTokens.join("").length > 0;

        const passed = candidateRules.some((r) =>
          r.declarations.some((d) => {
            if (d.property !== prop) return false; // exact property token — no substring false positives
            if (!hasExpected) return true;         // property present is enough when no value given
            const actualTokens = normValue(d.value);
            return (
              actualTokens.join(" ") === expectedTokens.join(" ") ||
              (expectedTokens.length === 1 && actualTokens.includes(expectedTokens[0]))
            );
          })
        );
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
  const cssRules = parseCssRules(cssStr);

  const results = domTests
    .filter((t) => VALID_CHECK_TYPES.has(t.check_type))
    .map((t) => runCheck(t, $, cssRules));

  const passed = results.filter((r) => r.passed).length;
  return { results, passed, total: results.length };
}

module.exports = { evaluateWebSubmission };
