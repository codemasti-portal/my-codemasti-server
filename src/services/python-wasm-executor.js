/**
 * python-wasm-executor.js
 *
 * Runs Python student code via Pyodide (Python compiled to WebAssembly).
 * No Python binary needed on the server — uses the `pyodide` npm package.
 *
 * Spawns python-runner.js as an isolated child process.
 * If the child crashes or times out, the main Express server is unaffected.
 *
 * Supports two modes:
 *  - Single execution (run endpoint): executeOnePython({ code, stdin, timeoutMs })
 *  - Batch execution (submit endpoint): executeManyPython({ code, inputs, timeoutMs })
 */

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const RUNNER_PATH = path.join(__dirname, "runners", "python-runner.js");

// Total timeout for the child process (covers Pyodide load + all test cases).
// On a cold Vercel lambda, Pyodide loads from disk in ~3-4s; leave generous headroom.
const DEFAULT_TIMEOUT_MS = 25000; // 25s batch — stays comfortably within maxDuration:30
const SINGLE_TIMEOUT_MS  = 20000; // 20s single run — covers cold-start boot + Pyodide load

/**
 * Spawn the python-runner child process, send it a payload, collect results.
 */
function runPythonRunner(payload, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [RUNNER_PATH], {
      windowsHide: true,
      env: {}, // no server env vars passed to child
    });

    let stdout = "";
    let stderr = "";
    const maxBuffer = 2 * 1024 * 1024; // 2 MB
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
        ok: false,
        error: `Runner error: ${err.message || "failed to start python runner"}`,
        results: [],
        elapsed: (Date.now() - startedAt) / 1000,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          ok: false,
          error: "Execution timeout",
          results: [],
          elapsed: timeoutMs / 1000,
        });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve({
          ok: false,
          error: stderr || "Runner returned invalid output",
          results: [],
          elapsed: (Date.now() - startedAt) / 1000,
        });
        return;
      }

      if (parsed.error) {
        resolve({
          ok: false,
          error: parsed.error,
          results: parsed.results || [],
          elapsed: (Date.now() - startedAt) / 1000,
        });
        return;
      }

      resolve({
        ok: true,
        results: parsed.results || [],
        elapsed: (Date.now() - startedAt) / 1000,
      });
    });

    // Send payload to child via stdin
    try {
      child.stdin.write(JSON.stringify(payload), "utf8");
      child.stdin.end();
    } catch { /* no-op */ }
  });
}

/**
 * Execute Python code once (used by the /run endpoint).
 * Returns the same shape as js-executor: { success, output, error, execution_time, return_code }
 */
async function executeOnePython({ code, stdin = "", timeoutMs = SINGLE_TIMEOUT_MS, executionMode = "full_program" }) {
  const result = await runPythonRunner(
    { code, inputs: [stdin], executionMode },
    timeoutMs
  );

  if (!result.ok) {
    return {
      success: false,
      output: "",
      error: result.error || "Python execution failed",
      execution_time: result.elapsed,
      return_code: -1,
    };
  }

  const r = result.results[0] || { output: "", error: "", success: false };
  return {
    success: r.success,
    output: r.output || "",
    error: r.error || "",
    execution_time: result.elapsed,
    return_code: r.success ? 0 : 1,
  };
}

/**
 * Execute Python code against multiple inputs (used by the /submit endpoint).
 * Returns an array of per-test results: [{ output, error, success }]
 * Loads Pyodide once, runs all inputs sequentially in the same child process.
 */
async function executeManyPython({ code, inputs, timeoutMs = DEFAULT_TIMEOUT_MS, executionMode = "full_program" }) {
  const result = await runPythonRunner(
    { code, inputs, executionMode },
    timeoutMs
  );

  if (!result.ok) {
    // Return all tests as failed with the runner error
    return {
      ok: false,
      error: result.error,
      results: inputs.map(() => ({ output: "", error: result.error, success: false })),
      elapsed: result.elapsed,
    };
  }

  return {
    ok: true,
    results: result.results,
    elapsed: result.elapsed,
  };
}

module.exports = { executeOnePython, executeManyPython };
