/**
 * python-runner.js
 *
 * This script is spawned as a child process by python-wasm-executor.js.
 * It receives a JSON payload via stdin:
 *   { code: string, inputs: string[], executionMode: "full_program" | "function_only" }
 *
 * It loads Pyodide (Python via WebAssembly — no Python binary needed),
 * runs the code for each input, and writes JSON results to stdout:
 *   { results: [{ output, error, success }] }
 *
 * If Pyodide fails to load, writes { error: string, results: [] } and exits with code 1.
 */

"use strict";

function buildPythonWrapper(userCode, stdin, executionMode) {
  const rawCode = String(userCode || "");
  const stdinLiteral = JSON.stringify(String(stdin || ""));

  // Preamble: patch sys.stdin with io.StringIO so input() / sys.stdin.readline() work correctly.
  // Also cap print calls to avoid flooding output.
  const preamble = `
import sys as __sys
import io as __io
__sys.stdin = __io.StringIO(${stdinLiteral})
__cm_print_count = [0]
__cm_MAX_PRINTS = 10000
__cm_orig_print = print
def __cm_safe_print(*args, **kwargs):
    __cm_print_count[0] += 1
    if __cm_print_count[0] <= __cm_MAX_PRINTS:
        __cm_orig_print(*args, **kwargs)
print = __cm_safe_print
`;

  if (String(executionMode || "full_program") !== "function_only") {
    return preamble + rawCode;
  }

  // function_only: call solve() with the input, print result
  return `${preamble}
${rawCode}

__cm_input = ${stdinLiteral}
__cm_result = None
try:
    __cm_result = solve(__cm_input)
except TypeError:
    import json as __cm_json
    __cm_lines = [line for line in __cm_input.strip().splitlines() if line.strip() != ""]
    __cm_first = __cm_lines[0].strip() if __cm_lines else ""
    __cm_arg = __cm_first
    try:
        __cm_arg = int(__cm_first)
    except Exception:
        try:
            __cm_arg = float(__cm_first)
        except Exception:
            try:
                __cm_arg = __cm_json.loads(__cm_first) if __cm_first else ""
            except Exception:
                __cm_arg = __cm_first
    try:
        __cm_result = solve(__cm_arg)
    except TypeError:
        __cm_result = solve()

if __cm_result is not None:
    print(__cm_result)
`;
}

async function main() {
  // Read JSON payload from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: "Invalid JSON payload", results: [] }));
    process.exit(1);
  }

  const { code, inputs, executionMode = "full_program" } = payload;

  if (!code || !Array.isArray(inputs)) {
    process.stdout.write(JSON.stringify({ error: "Missing code or inputs", results: [] }));
    process.exit(1);
  }

  let pyodide;
  try {
    const { loadPyodide } = require("pyodide");
    pyodide = await loadPyodide({
      // Silence Pyodide's own stdout/stderr during init
      stdout: () => {},
      stderr: () => {},
    });
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ error: `Pyodide failed to load: ${e.message || e}`, results: [] })
    );
    process.exit(1);
  }

  const results = [];

  for (const stdin of inputs) {
    let outputBuffer = "";
    let stderrBuffer = "";

    // stdout/stderr captured via Pyodide hooks; stdin is patched inside Python via io.StringIO
    pyodide.setStdout({
      batched: (s) => {
        outputBuffer += s + "\n";
      },
    });
    pyodide.setStderr({
      batched: (s) => {
        stderrBuffer += s + "\n";
      },
    });

    const pythonCode = buildPythonWrapper(code, stdin, executionMode);

    try {
      // Run in a fresh namespace so variables don't leak between test cases
      const freshGlobals = pyodide.globals.get("dict")();
      await pyodide.runPythonAsync(pythonCode, { globals: freshGlobals });
      freshGlobals.destroy();

      results.push({
        output: outputBuffer.trimEnd(),
        error: stderrBuffer.trimEnd(),
        success: true,
      });
    } catch (e) {
      const errMsg = String((e && e.message) ? e.message : e);
      // Strip Pyodide internal file paths from traceback for clean student-facing errors
      const cleanErr = errMsg
        .replace(/^PythonError:\s*/i, "")
        .replace(/File "\/lib\/python\S+", line \d+, in \S+\n/g, "")
        .replace(/^\s+\.\.\.\s*$\n/gm, "")
        .trim();

      results.push({
        output: outputBuffer.trimEnd(),
        error: cleanErr || stderrBuffer.trimEnd(),
        success: false,
      });
    }
  }

  process.stdout.write(JSON.stringify({ results }));
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({ error: e.message || String(e), results: [] })
  );
  process.exit(1);
});
