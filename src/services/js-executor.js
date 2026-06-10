const { spawn } = require("child_process");

// Block access to Node.js internals and host system
const BLOCKED_JS_PATTERNS = [
  /\brequire\s*\(/i,
  /\bimport\s*\(/i,           // dynamic import()
  /\bimport\s+/i,             // static import (ESM)
  /process\s*\.\s*(env|exit|kill|send|binding|dlopen|abort|chdir|cwd|setuid|setgid)/i,
  /\bchild_process\b/i,
  /\bworker_threads\b/i,
  /\bfs\b\s*[\.\[]/i,
  /\bnet\b\s*[\.\[]/i,
  /\bhttp\b\s*[\.\[]/i,
  /\bhttps\b\s*[\.\[]/i,
  /\bos\b\s*[\.\[]/i,
  /\bcrypto\b\s*[\.\[]/i,
  /\bdns\b\s*[\.\[]/i,
  /\bpath\b\s*[\.\[]/i,
  /new\s+Function\s*\(/i,
  /\beval\s*\(/i,
  /\bWebAssembly\b/i,
];

function stripJsComments(code) {
  return String(code || "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function validateJsCode(code) {
  const clean = stripJsComments(code);
  for (const pattern of BLOCKED_JS_PATTERNS) {
    if (pattern.test(clean)) {
      return { safe: false, error: "Security Error: blocked pattern detected in code." };
    }
  }
  return { safe: true, error: "" };
}

function buildWrappedJsCode(userCode, stdin, executionMode) {
  const stdinLiteral = JSON.stringify(String(stdin || ""));

  // input() / readline() preamble
  const inputPreamble = `
const __lines = ${stdinLiteral}.split("\\n");
let __lineIdx = 0;
function readline() { return __lines[__lineIdx++] ?? ""; }
function input(_prompt) { return __lines[__lineIdx++] ?? ""; }
`;

  // Output capture preamble
  const outputPreamble = `
const __output = [];
let __printCount = 0;
const __MAX_PRINTS = 10000;
console.log = (...args) => {
  if (++__printCount <= __MAX_PRINTS) {
    __output.push(args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  }
};
console.error = (...args) => {
  process.stderr.write(args.map(String).join(" ") + "\\n");
};
console.warn = console.error;
`;

  // For function_only mode, wrap user code to call solve(input)
  let mainCode = String(userCode || "");
  if (String(executionMode || "full_program") === "function_only") {
    mainCode = `
${userCode}

(function() {
  const __input = __lines.join("\\n");
  let __result;
  try {
    __result = solve(__input);
  } catch(_e1) {
    const __first = __input.trim().split("\\n")[0].trim();
    let __arg = __first;
    try { __arg = Number(__first); if (isNaN(__arg)) __arg = __first; } catch(_e) {}
    try { __arg = JSON.parse(__first); } catch(_e) { __arg = __first; }
    try {
      __result = solve(__arg);
    } catch(_e2) {
      __result = solve();
    }
  }
  if (__result !== undefined && __result !== null) console.log(__result);
})();
`;
  }

  return `
${inputPreamble}
${outputPreamble}
(async () => {
  try {
    ${mainCode}
  } catch(e) {
    process.stderr.write((e && e.message ? e.message : String(e)) + "\\n");
    process.stdout.write(__output.join("\\n") + (__output.length ? "\\n" : ""));
    process.exit(1);
  }
  process.stdout.write(__output.join("\\n") + (__output.length ? "\\n" : ""));
})();
`;
}

function executeJsCode({ code, stdin = "", timeoutMs = 5000, executionMode = "full_program" }) {
  return new Promise((resolve) => {
    const validation = validateJsCode(code);
    if (!validation.safe) {
      resolve({
        success: false,
        output: "",
        error: validation.error,
        execution_time: 0,
        return_code: -1,
      });
      return;
    }

    const wrappedCode = buildWrappedJsCode(code, stdin, executionMode);
    const startedAt = Date.now();

    const child = spawn(process.execPath, ["--eval", wrappedCode], {
      windowsHide: true,
      env: {}, // no env vars — prevents access to server secrets
    });

    let stdout = "";
    let stderr = "";
    const maxBuffer = 1024 * 1024; // 1 MB
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* no-op */ }
    }, Math.max(1, timeoutMs));

    child.stdout.on("data", (buf) => {
      stdout += String(buf);
      if (stdout.length > maxBuffer) stdout = stdout.slice(0, maxBuffer);
    });

    child.stderr.on("data", (buf) => {
      stderr += String(buf);
      if (stderr.length > maxBuffer) stderr = stderr.slice(0, maxBuffer);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        output: "",
        error: `Execution error: ${err.message || "failed to start node"}`,
        execution_time: (Date.now() - startedAt) / 1000,
        return_code: -1,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          success: false,
          output: stdout,
          error: "Execution timeout (>5 seconds)",
          execution_time: 5,
          return_code: -1,
        });
        return;
      }
      resolve({
        success: Number(exitCode || 0) === 0,
        output: stdout,
        error: stderr,
        execution_time: (Date.now() - startedAt) / 1000,
        return_code: Number(exitCode || 0),
      });
    });

    try {
      child.stdin.end();
    } catch { /* no-op */ }
  });
}

module.exports = { executeJsCode, validateJsCode };
