const { spawn } = require("child_process");

const BLOCKED_PATTERNS = [
  /(^|\s)import\s+\w+/i,
  /(^|\s)from\s+\w+\s+import\s+/i,
  /__import__\s*\(/i,
  /exec\s*\(/i,
  /eval\s*\(/i,
  /compile\s*\(/i,
  /open\s*\(/i,
  /(^|\W)os\./i,
  /(^|\W)sys\./i,
  /subprocess\./i,
  /socket\./i,
  /requests\./i,
  /urllib\./i,
  /globals\s*\(\)/i,
  /locals\s*\(\)/i,
  /vars\s*\(\)/i,
  /__dict__/i,
  /__globals__/i,
  /__class__/i,
  /__mro__/i,
  /__subclasses__\s*\(/i,
];

function stripComments(code) {
  return String(code || "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("#");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function validatePythonCode(code) {
  const clean = stripComments(code);
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(clean)) {
      return { safe: false, error: `Security Error: blocked pattern ${pattern}` };
    }
  }
  return { safe: true, error: "" };
}

function buildWrappedCode(code) {
  return `
import builtins
_orig_print = print
_count = {"v": 0}
_MAX = 10000

def safe_print(*args, **kwargs):
    _count["v"] += 1
    if _count["v"] <= _MAX:
        _orig_print(*args, **kwargs)

builtins.print = safe_print

${String(code || "")}
`;
}

function executePythonCode({ code, stdin = "", timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const validation = validatePythonCode(code);
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

    const startedAt = Date.now();
    const pythonCmd = process.env.PYTHON_BIN || "python";
    const child = spawn(pythonCmd, ["-I", "-c", buildWrappedCode(code)], {
      windowsHide: true,
      env: {
        PYTHONUNBUFFERED: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    const maxBuffer = 1024 * 1024;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
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
        error: `Execution error: ${err.message || "failed to start python"}`,
        execution_time: (Date.now() - startedAt) / 1000,
        return_code: -1,
      });
    });

    child.on("close", (codeOrNull) => {
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
        success: Number(codeOrNull || 0) === 0,
        output: stdout,
        error: stderr,
        execution_time: (Date.now() - startedAt) / 1000,
        return_code: Number(codeOrNull || 0),
      });
    });

    try {
      child.stdin.write(String(stdin || ""));
      child.stdin.end();
    } catch {
      // no-op
    }
  });
}

module.exports = { executePythonCode, validatePythonCode };
