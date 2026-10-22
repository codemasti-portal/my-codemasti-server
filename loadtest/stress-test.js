#!/usr/bin/env node
/**
 * CodeMasti API stress test.
 *
 * Simulates N students logging in (ramped over RAMP_SEC) and browsing the student portal with
 * think time between pages, samples the EC2 container's CPU/memory over SSH, and writes an
 * HTML report + JSON summary + raw CSV to loadtest/reports/<timestamp>/.
 *
 * Zero dependencies (Node 18+). Normally launched via loadtest/run-stress-test.sh.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { performance } = require("perf_hooks");

const env = process.env;
const int = (v, d) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const CFG = {
  baseUrl: (env.BASE_URL || "https://server.codemasti.com/v1").replace(/\/$/, ""),
  email: env.STUDENT_EMAIL,
  password: env.STUDENT_PASSWORD,
  users: int(env.USERS, 500),
  rampSec: int(env.RAMP_SEC, 60),
  holdSec: int(env.HOLD_SEC, 180),
  thinkMinMs: int(env.THINK_MIN_MS, 2000),
  thinkMaxMs: int(env.THINK_MAX_MS, 5000),
  timeoutMs: int(env.TIMEOUT_MS, 30000),
  loginMode: env.LOGIN_MODE === "shared" ? "shared" : "each",
  targetP95Ms: int(env.TARGET_P95_MS, 1000),
  targetErrPct: int(env.TARGET_ERROR_PCT, 1),
  sshKey: env.SSH_KEY,
  sshHost: env.SSH_HOST,
  outDir: env.OUT_DIR || path.join(__dirname, "reports", stamp()),
};

// Student portal pages and the API calls each one fires in parallel (like the frontend does).
const PAGES = [
  { name: "Dashboard", weight: 3, calls: ["/dashboard/home", "/notifications/unread-count"] },
  { name: "Timetable", weight: 2, calls: ["/timetable/weekly", "/timetable/events"] },
  { name: "Assignments", weight: 2, calls: ["/assignments", "/assignments/filters"] },
  { name: "Notes", weight: 1, calls: ["/notes", "/notes/filters"] },
  { name: "Leaderboard", weight: 1, calls: ["/leaderboard", "/leaderboard/me"] },
  { name: "Profile", weight: 1, calls: ["/students/me", "/students/me/achievements"] },
  { name: "Notifications", weight: 1, calls: ["/notifications"] },
];
const ENTRY_PAGE = { name: "Post-login landing", calls: ["/auth/me", "/dashboard/home", "/notifications/unread-count"] };
const LOGIN_EP = "POST /auth/login";

// ---------- runtime state ----------
const samples = []; // { t, ep, status, ms, err, u }
const pageSamples = []; // { t, name, ms, ok }
const timeline = []; // { t, active, inflight }
const serverStats = []; // { t, cpu, memMiB, memLimitMiB, load }
let recording = false;
let startedAt = 0;
let activeUsers = 0;
let inflight = 0;
let usersLoggedIn = 0;
let usersFailedLogin = 0;
let stopNow = false;
const disabledEndpoints = {}; // ep -> status seen in smoke check

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now() - startedAt;
const think = () => CFG.thinkMinMs + Math.random() * (CFG.thinkMaxMs - CFG.thinkMinMs);
const isError = (s) => Boolean(s.err) || s.status === 0 || s.status >= 400;

async function request(method, ep, { token, body } = {}) {
  const label = method === "POST" && ep === "/auth/login" ? LOGIN_EP : `${method} ${ep}`;
  const t0 = performance.now();
  const u = activeUsers;
  let status = 0;
  let err = null;
  let json = null;
  inflight++;
  try {
    const res = await fetch(CFG.baseUrl + ep, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CFG.timeoutMs),
    });
    status = res.status;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  } catch (e) {
    err = e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message || "network error";
  } finally {
    inflight--;
  }
  const ms = performance.now() - t0;
  if (recording) samples.push({ t: t0 - startedAt, ep: label, status, ms, err, u });
  return { status, json, ms, err };
}

async function login() {
  const r = await request("POST", "/auth/login", { body: { email: CFG.email, password: CFG.password } });
  const token = r.json?.data?.access_token;
  return { ok: r.status === 200 && Boolean(token), token, r };
}

async function loadPage(page, token) {
  const calls = page.calls.filter((c) => !disabledEndpoints[c]);
  if (!calls.length) return;
  const t0 = performance.now();
  const results = await Promise.all(calls.map((c) => request("GET", c, { token })));
  if (recording) {
    pageSamples.push({
      t: t0 - startedAt,
      name: page.name,
      ms: performance.now() - t0,
      ok: results.every((r) => !r.err && r.status > 0 && r.status < 400),
    });
  }
}

function pickPage(pages) {
  const total = pages.reduce((s, p) => s + p.weight, 0);
  let x = Math.random() * total;
  for (const p of pages) if ((x -= p.weight) <= 0) return p;
  return pages[0];
}

async function virtualUser(startDelayMs, stopAtMs, sharedToken, pages) {
  await sleep(startDelayMs);
  if (stopNow) return;
  let token = sharedToken;
  if (!token) {
    for (let attempt = 1; attempt <= 3 && !token && !stopNow; attempt++) {
      const l = await login();
      if (l.ok) token = l.token;
      else if (attempt < 3) await sleep(think());
    }
    if (!token) {
      usersFailedLogin++;
      return;
    }
  }
  usersLoggedIn++;
  activeUsers++;
  try {
    await loadPage(ENTRY_PAGE, token);
    while (!stopNow && now() < stopAtMs) {
      await sleep(think());
      if (stopNow || now() >= stopAtMs) break;
      await loadPage(pickPage(pages), token);
    }
  } finally {
    activeUsers--;
  }
}

// ---------- server metrics over SSH ----------
function parseMiB(s) {
  const m = /([\d.]+)\s*([KMG]i?B)/i.exec(s || "");
  if (!m) return 0;
  const v = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit.startsWith("G") ? v * 1024 : unit.startsWith("K") ? v / 1024 : v;
}

function startServerMonitor() {
  if (!CFG.sshKey || !CFG.sshHost) return null;
  const remote =
    "while true; do s=$(sudo docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' codemasti-api 2>/dev/null); " +
    "l=$(cut -d' ' -f1 /proc/loadavg); echo \"M|$s|$l\"; sleep 1; done";
  const proc = spawn("ssh", ["-i", CFG.sshKey, "-o", "BatchMode=yes", "-o", "ServerAliveInterval=10", CFG.sshHost, remote], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const parts = line.split("|");
      if (parts[0] !== "M" || parts.length < 4) continue;
      const [used, limit] = parts[2].split("/");
      serverStats.push({
        t: now(),
        cpu: parseFloat(parts[1]) || 0,
        memMiB: parseMiB(used),
        memLimitMiB: parseMiB(limit),
        load: parseFloat(parts[3]) || 0,
      });
    }
  });
  proc.on("error", () => {});
  return proc;
}

function countServerErrorLogs(sinceIso) {
  if (!CFG.sshKey || !CFG.sshHost) return null;
  try {
    const out = execFileSync(
      "ssh",
      ["-i", CFG.sshKey, "-o", "BatchMode=yes", CFG.sshHost, `sudo docker logs --since ${sinceIso} codemasti-api 2>&1 | grep -c '\\[ERROR\\]' || true`],
      { encoding: "utf8", timeout: 30000 }
    );
    return Number(out.trim()) || 0;
  } catch {
    return null;
  }
}

// ---------- statistics ----------
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(list) {
  const ms = list.map((s) => s.ms).sort((a, b) => a - b);
  const errors = list.filter((s) => (s.ok === undefined ? isError(s) : !s.ok)).length;
  const sum = ms.reduce((a, b) => a + b, 0);
  return {
    count: list.length,
    errors,
    errPct: list.length ? (errors / list.length) * 100 : 0,
    avg: ms.length ? sum / ms.length : 0,
    min: ms[0] || 0,
    p50: pct(ms, 50),
    p90: pct(ms, 90),
    p95: pct(ms, 95),
    p99: pct(ms, 99),
    max: ms[ms.length - 1] || 0,
  };
}

function groupBy(list, key) {
  const m = new Map();
  for (const s of list) {
    const k = key(s);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return m;
}

function buildBuckets(durationMs, bucketSec = 5) {
  const size = bucketSec * 1000;
  const n = Math.max(1, Math.ceil(durationMs / size));
  const buckets = Array.from({ length: n }, (_, i) => ({ t: i * bucketSec, list: [] }));
  for (const s of samples) {
    const i = Math.min(n - 1, Math.floor(s.t / size));
    buckets[i].list.push(s);
  }
  // The last bucket is usually partial: use its real length, and drop it if it's under a second.
  const seconds = (b) => Math.min(bucketSec, durationMs / 1000 - b.t);
  return buckets.filter((b) => seconds(b) >= 1).map((b) => {
    const st = summarize(b.list);
    const tl = timeline.filter((x) => x.t >= b.t * 1000 && x.t < (b.t + bucketSec) * 1000);
    return {
      t: b.t,
      rps: b.list.length / seconds(b),
      p50: st.p50,
      p95: st.p95,
      errors: st.errors,
      active: tl.length ? Math.max(...tl.map((x) => x.active)) : 0,
    };
  });
}

function saturationBands(bandSize = 50) {
  const nonLogin = samples.filter((s) => s.ep !== LOGIN_EP);
  const g = groupBy(nonLogin, (s) => Math.floor(s.u / bandSize));
  return [...g.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, list]) => ({ from: k * bandSize, to: k * bandSize + bandSize - 1, ...summarize(list) }));
}

// ---------- report ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const fmtPct = (v) => `${v < 10 && v > 0 ? v.toFixed(2) : v.toFixed(1)}%`;
const fmtNum = (v) => Math.round(v).toLocaleString("en-US");

function niceCeil(v) {
  if (v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}

function svgChart({ series, xMax, yFmt = (v) => fmtNum(v), height = 220, refLine }) {
  const W = 760;
  const H = height;
  const L = 64;
  const R = 16;
  const T = 14;
  const B = 30;
  const ys = series.flatMap((s) => s.points.map((p) => p[1]));
  const yMax = niceCeil(Math.max(1, ...ys, refLine ? refLine.value * 1.1 : 0));
  const x = (v) => L + (v / Math.max(1, xMax)) * (W - L - R);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`;
    g += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${esc(yFmt(v))}</text>`;
  }
  const xStep = niceCeil(xMax / 8);
  for (let v = 0; v <= xMax; v += xStep) {
    g += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle" class="tick">${v}s</text>`;
  }
  if (refLine) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(refLine.value)}" y2="${y(refLine.value)}" class="ref"/>`;
    g += `<text x="${W - R}" y="${y(refLine.value) - 5}" text-anchor="end" class="tick ref-label">${esc(refLine.label)}</text>`;
  }
  for (const s of series) {
    if (!s.points.length) continue;
    const pts = s.points.map(([px, py]) => `${x(px).toFixed(1)},${y(py).toFixed(1)}`).join(" ");
    g += `<polyline points="${pts}" fill="none" style="stroke:var(${s.color})" stroke-width="2" stroke-linejoin="round"/>`;
  }
  const legend = series
    .map((s) => `<span class="legend-item"><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`)
    .join("");
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${g}</svg>`;
}

function buildFindings(ctx) {
  const f = [];
  const { latency, login, endpoints, server, baseline, statusCounts, saturation } = ctx;
  const n429 = statusCounts["429"] || 0;
  const timeouts = statusCounts.timeout || 0;
  const n5xx = Object.entries(statusCounts)
    .filter(([k]) => /^5\d\d$/.test(k))
    .reduce((s, [, v]) => s + v, 0);
  const netErrs = Object.entries(statusCounts)
    .filter(([k]) => !/^\d{3}$/.test(k) && k !== "timeout")
    .reduce((s, [, v]) => s + v, 0);

  if (n429) {
    f.push({
      level: "bad",
      title: `${fmtNum(n429)} requests were rate-limited (HTTP 429)`,
      detail:
        "The API rate limiter (RATE_LIMIT_API_MAX, default 200 req/min per IP) rejected traffic. If the limit was not raised for this test, these results mostly measure the limiter. In production, many students behind one school/college network share a single public IP and would hit the same wall.",
    });
  }
  if (timeouts) {
    f.push({
      level: "bad",
      title: `${fmtNum(timeouts)} requests timed out (> ${fmtMs(CFG.timeoutMs)})`,
      detail: "The server could not answer in time — a sign it was saturated. Check the CPU chart and the slowest endpoints below.",
    });
  }
  if (n5xx) {
    f.push({
      level: "bad",
      title: `${fmtNum(n5xx)} server errors (HTTP 5xx)`,
      detail: "The API or Nginx returned errors under load. Inspect them with: sudo docker logs codemasti-api and sudo tail /var/log/nginx/error.log on EC2.",
    });
  }
  if (netErrs) {
    f.push({
      level: "bad",
      title: `${fmtNum(netErrs)} connection-level failures`,
      detail:
        "Requests failed before an HTTP response (connection reset/refused, DNS, socket limits). If these appear early, the load-generating machine may be the bottleneck (open-file limit, Wi-Fi, VPN/proxy).",
    });
  }
  if (login.count && login.p95 > 2000) {
    f.push({
      level: "warn",
      title: `Login is slow under load (p95 ${fmtMs(login.p95)})`,
      detail:
        "loginWithPassword uses bcrypt.compareSync, which blocks Node's single event loop for every password check — while it runs, no other request is served. With many students logging in together, logins queue up and slow down every other API call too. Switching to the async bcrypt.compare (runs on the libuv thread pool) is a one-line fix and typically the biggest win for 'everyone logs in at class start'.",
    });
  }
  if (server.count) {
    if (server.cpuMax >= 90) {
      f.push({
        level: "warn",
        title: `Server CPU saturated (peak ${server.cpuMax.toFixed(0)}% of one core)`,
        detail:
          "Node.js runs JavaScript on a single core, so ~100% here means the API process is maxed out even though the t3.small has 2 vCPUs. Options: run 2 API containers (or Node cluster mode) behind Nginx, make bcrypt async, or move to a larger instance. Note t3 instances are burstable: sustained high CPU drains CPU credits and AWS then throttles the instance.",
      });
    } else if (latency.p95 > CFG.targetP95Ms && server.cpuMax < 60) {
      f.push({
        level: "warn",
        title: "Latency is high but the server CPU is not busy",
        detail: `Peak CPU was only ${server.cpuMax.toFixed(0)}%, so the API process is mostly waiting — most likely on MongoDB (the Atlas free M0 tier has throughput and connection limits) or on the network. Compare slow endpoints: the ones doing several DB queries will dominate.`,
      });
    }
    if (server.memMax && server.memLimit && server.memMax / server.memLimit > 0.8) {
      f.push({
        level: "warn",
        title: `High memory use (peak ${fmtNum(server.memMax)} MiB of ${fmtNum(server.memLimit)} MiB)`,
        detail: "The instance has 2 GB RAM. Sustained memory pressure leads to swapping and slowdowns.",
      });
    }
  }
  if (baseline && baseline.median > 150) {
    f.push({
      level: "info",
      title: `Every request carries ~${fmtMs(baseline.median)} of pure network time`,
      detail:
        "Measured with /health (no DB, no work) before the test. This is the round trip from the test machine to the Sydney server and is included in every latency number in this report; it is not server load.",
    });
  }
  const breach = saturation.find((b) => b.count >= 30 && b.p95 > CFG.targetP95Ms);
  if (breach) {
    f.push({
      level: "warn",
      title: `Latency target first exceeded at ~${breach.from}–${breach.to} concurrent students`,
      detail: `p95 latency in that band was ${fmtMs(breach.p95)} (target ${fmtMs(CFG.targetP95Ms)}). See "Latency vs concurrent students" below.`,
    });
  }
  const slow = endpoints.filter((e) => e.ep !== LOGIN_EP).slice(0, 3);
  if (slow.length) {
    f.push({
      level: "info",
      title: "Slowest endpoints (by p95)",
      detail: slow.map((e) => `${e.ep} — ${fmtMs(e.p95)}`).join(" · "),
    });
  }
  if (!f.some((x) => x.level !== "info")) {
    f.unshift({
      level: "good",
      title: `The server handled ${CFG.users} students without errors or slowdowns`,
      detail: "No rate limiting, timeouts, server errors or saturation were detected during the test.",
    });
  }
  return f;
}

function renderReport(ctx) {
  const { overall, latency, login, pages, endpoints, statusCounts, buckets, server, baseline, saturation, findings, verdict, durationSec, errorLogLines } = ctx;
  const xMax = durationSec;
  const card = (label, value, sub = "", tone = "") =>
    `<div class="card ${tone}"><div class="card-label">${esc(label)}</div><div class="card-value">${value}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;
  const toneFor = (v, good, warn) => (v <= good ? "good" : v <= warn ? "warn" : "bad");

  const endpointRows = endpoints
    .map(
      (e) => `<tr><td class="ep">${esc(e.ep)}</td><td>${fmtNum(e.count)}</td><td class="${e.errors ? "bad-text" : ""}">${fmtNum(e.errors)}</td><td>${fmtPct(e.errPct)}</td>
<td>${fmtMs(e.avg)}</td><td>${fmtMs(e.p50)}</td><td>${fmtMs(e.p90)}</td><td class="${e.p95 > CFG.targetP95Ms ? "bad-text" : ""}">${fmtMs(e.p95)}</td><td>${fmtMs(e.p99)}</td><td>${fmtMs(e.max)}</td></tr>`
    )
    .join("");
  const pageRows = pages
    .map(
      (p) => `<tr><td class="ep">${esc(p.name)}</td><td>${fmtNum(p.count)}</td><td>${fmtPct(p.errPct)}</td><td>${fmtMs(p.p50)}</td><td class="${p.p95 > CFG.targetP95Ms * 1.5 ? "bad-text" : ""}">${fmtMs(p.p95)}</td><td>${fmtMs(p.max)}</td></tr>`
    )
    .join("");
  const satRows = saturation
    .map(
      (b) => `<tr><td>${b.from}–${b.to}</td><td>${fmtNum(b.count)}</td><td>${fmtMs(b.p50)}</td><td class="${b.p95 > CFG.targetP95Ms ? "bad-text" : ""}">${fmtMs(b.p95)}</td><td>${fmtMs(b.p99)}</td><td>${fmtPct(b.errPct)}</td></tr>`
    )
    .join("");
  const statusRows = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmtNum(v)}</td><td>${fmtPct((v / Math.max(1, overall.count)) * 100)}</td></tr>`)
    .join("");
  const errGroups = [...groupBy(samples.filter(isError), (s) => `${s.ep} → ${s.err || s.status}`).entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15)
    .map(([k, v]) => `<tr><td class="ep">${esc(k)}</td><td>${fmtNum(v.length)}</td></tr>`)
    .join("");
  const disabled = Object.entries(disabledEndpoints);

  const charts = [
    { title: "Concurrent students", body: svgChart({ xMax, series: [{ name: "Active students", color: "--c1", points: timeline.map((x) => [x.t / 1000, x.active]) }, { name: "Requests in flight", color: "--c2", points: timeline.map((x) => [x.t / 1000, x.inflight]) }] }) },
    { title: "Throughput (requests / second, 5 s buckets)", body: svgChart({ xMax, series: [{ name: "req/s", color: "--c1", points: buckets.map((b) => [b.t, b.rps]) }], yFmt: (v) => v.toFixed(v < 10 ? 1 : 0) }) },
    { title: "Response time (5 s buckets)", body: svgChart({ xMax, yFmt: fmtMs, refLine: { value: CFG.targetP95Ms, label: `target p95 ${fmtMs(CFG.targetP95Ms)}` }, series: [{ name: "p50", color: "--c1", points: buckets.map((b) => [b.t, b.p50]) }, { name: "p95", color: "--c3", points: buckets.map((b) => [b.t, b.p95]) }] }) },
    { title: "Failed requests (per 5 s bucket)", body: svgChart({ xMax, series: [{ name: "errors", color: "--bad", points: buckets.map((b) => [b.t, b.errors]) }] }) },
  ];
  if (server.count) {
    charts.push({ title: "Server CPU (API container, % of one core)", body: svgChart({ xMax, yFmt: (v) => `${Math.round(v)}%`, refLine: { value: 100, label: "1 full core" }, series: [{ name: "CPU %", color: "--c3", points: serverStats.map((s) => [s.t / 1000, s.cpu]) }] }) });
    charts.push({ title: "Server memory (API container, MiB)", body: svgChart({ xMax, series: [{ name: "Memory MiB", color: "--c2", points: serverStats.map((s) => [s.t / 1000, s.memMiB]) }] }) });
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeMasti Stress Test</title>
<style>
:root{--bg:#f7f7f5;--surface:#fff;--text:#1d1d1b;--muted:#6b6b66;--border:#e3e2dd;--c1:#2563eb;--c2:#0d9488;--c3:#d97706;--good:#15803d;--warn:#b45309;--bad:#dc2626;--good-bg:#ecfdf3;--warn-bg:#fffbeb;--bad-bg:#fef2f2;--info-bg:#eff6ff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--surface:#1f1f1d;--text:#ececea;--muted:#a3a39d;--border:#33332f;--c1:#60a5fa;--c2:#2dd4bf;--c3:#fbbf24;--good:#4ade80;--warn:#fbbf24;--bad:#f87171;--good-bg:#12261a;--warn-bg:#2a2210;--bad-bg:#2c1414;--info-bg:#132036}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 12px}
.muted{color:var(--muted)}.verdict{border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid var(--border)}
.verdict.good{background:var(--good-bg);border-color:var(--good)}.verdict.warn{background:var(--warn-bg);border-color:var(--warn)}.verdict.bad{background:var(--bad-bg);border-color:var(--bad)}
.verdict b{font-size:20px;display:block;margin-bottom:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px}.card-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card-value{font-size:24px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}.card-sub{font-size:12px;color:var(--muted)}
.card.good .card-value{color:var(--good)}.card.warn .card-value{color:var(--warn)}.card.bad .card-value{color:var(--bad)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}.panel h3{margin:0 0 6px;font-size:15px}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--border);stroke-width:1}.chart .tick{fill:var(--muted);font-size:11px}.chart .ref{stroke:var(--bad);stroke-dasharray:5 4;stroke-width:1}.chart .ref-label{fill:var(--bad)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-bottom:4px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px}th:first-child,td:first-child{text-align:left}td.ep{font-family:ui-monospace,Menlo,monospace;font-size:12px}.bad-text{color:var(--bad);font-weight:600}
.finding{border-left:4px solid var(--border);background:var(--surface);border-radius:6px;padding:10px 14px;margin-bottom:10px}
.finding.bad{border-color:var(--bad)}.finding.warn{border-color:var(--warn)}.finding.good{border-color:var(--good)}.finding.info{border-color:var(--c1)}.finding p{margin:4px 0 0;color:var(--muted);font-size:14px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0;font-size:14px}dt{color:var(--muted)}dd{margin:0}code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
</style></head><body><main>
<h1>CodeMasti API stress test</h1>
<div class="muted">${esc(CFG.baseUrl)} · ${esc(new Date(ctx.startedIso).toLocaleString())} · ${CFG.users} simulated students · ${durationSec}s</div>

<div class="verdict ${verdict.tone}"><b>${esc(verdict.label)}</b>${esc(verdict.text)}</div>

<div class="cards">
${card("Students logged in", `${fmtNum(usersLoggedIn)} / ${CFG.users}`, usersFailedLogin ? `${usersFailedLogin} failed to log in` : "all succeeded", usersFailedLogin ? "bad" : "good")}
${card("Total requests", fmtNum(overall.count), `peak ${Math.max(0, ...buckets.map((b) => b.rps)).toFixed(1)} req/s · avg ${(overall.count / Math.max(1, durationSec)).toFixed(1)} req/s`)}
${card("Error rate", fmtPct(overall.errPct), `${fmtNum(overall.errors)} failed`, toneFor(overall.errPct, CFG.targetErrPct, 5))}
${card("p50 response", fmtMs(latency.p50), "login excluded")}
${card("p95 response", fmtMs(latency.p95), `target ≤ ${fmtMs(CFG.targetP95Ms)}`, toneFor(latency.p95, CFG.targetP95Ms, CFG.targetP95Ms * 3))}
${card("p99 response", fmtMs(latency.p99), `max ${fmtMs(latency.max)}`)}
${card("Login p95", login.count ? fmtMs(login.p95) : "—", login.count ? `${fmtNum(login.count)} logins` : "shared token mode", login.count ? toneFor(login.p95, 2000, 6000) : "")}
${server.count ? card("Server CPU peak", `${server.cpuMax.toFixed(0)}%`, `avg ${server.cpuAvg.toFixed(0)}% · 100% = 1 core`, toneFor(server.cpuMax, 70, 95)) : ""}
${server.count ? card("Server memory peak", `${fmtNum(server.memMax)} MiB`, `of ${fmtNum(server.memLimit)} MiB`) : ""}
${baseline ? card("Network baseline", fmtMs(baseline.median), "/health round trip, no load") : ""}
</div>

<h2>Findings</h2>
${findings.map((x) => `<div class="finding ${x.level}"><b>${esc(x.title)}</b><p>${esc(x.detail)}</p></div>`).join("")}

<h2>Over time</h2>
${charts.map((c) => `<div class="panel"><h3>${esc(c.title)}</h3>${c.body}</div>`).join("")}

<h2>Latency vs concurrent students</h2>
<p class="muted">Requests grouped by how many students were active when the request was sent (login excluded). Shows the point where the server starts to slow down.</p>
<div class="panel table-wrap"><table><thead><tr><th>Active students</th><th>Requests</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th></tr></thead><tbody>${satRows}</tbody></table></div>

<h2>Page load times (what students feel)</h2>
<p class="muted">Each page fires its API calls in parallel; this is the time until all of them finished.</p>
<div class="panel table-wrap"><table><thead><tr><th>Page</th><th>Loads</th><th>Failed</th><th>p50</th><th>p95</th><th>Max</th></tr></thead><tbody>${pageRows}</tbody></table></div>

<h2>Per-endpoint latency</h2>
<div class="panel table-wrap"><table><thead><tr><th>Endpoint</th><th>Requests</th><th>Errors</th><th>Err %</th><th>Avg</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>${endpointRows}</tbody></table></div>

<h2>Responses</h2>
<div class="panel table-wrap"><table><thead><tr><th>Status / error</th><th>Count</th><th>Share</th></tr></thead><tbody>${statusRows}</tbody></table></div>
${errGroups ? `<div class="panel table-wrap"><h3>Top failures</h3><table><thead><tr><th>Endpoint → status</th><th>Count</th></tr></thead><tbody>${errGroups}</tbody></table></div>` : ""}
${errorLogLines !== null && errorLogLines !== undefined ? `<p class="muted">Server log: ${fmtNum(errorLogLines)} <code>[ERROR]</code> lines written by the API container during the test.</p>` : ""}

<h2>Test setup</h2>
<div class="panel"><dl>
<dt>Target</dt><dd><code>${esc(CFG.baseUrl)}</code></dd>
<dt>Students</dt><dd>${CFG.users}, ramped up over ${CFG.rampSec}s, then held for ${CFG.holdSec}s</dd>
<dt>Login</dt><dd>${CFG.loginMode === "each" ? "every simulated student logs in with POST /auth/login (same test account)" : "one login, token shared by all students"}</dd>
<dt>Behaviour</dt><dd>after login: landing page, then a random portal page every ${CFG.thinkMinMs / 1000}–${CFG.thinkMaxMs / 1000}s (think time)</dd>
<dt>Pages</dt><dd>${PAGES.map((p) => `${esc(p.name)} (${p.calls.map(esc).join(", ")})`).join("; ")}</dd>
<dt>Pass criteria</dt><dd>error rate ≤ ${CFG.targetErrPct}%, p95 ≤ ${fmtMs(CFG.targetP95Ms)} (login excluded), all students logged in</dd>
<dt>Request timeout</dt><dd>${fmtMs(CFG.timeoutMs)}</dd>
${disabled.length ? `<dt>Skipped endpoints</dt><dd>${disabled.map(([ep, st]) => `<code>${esc(ep)}</code> (smoke check returned ${esc(st)})`).join(", ")}</dd>` : ""}
<dt>Load source</dt><dd>a single machine; all latencies include its network path to the server</dd>
</dl></div>
</main></body></html>`;
}

// ---------- main ----------
async function main() {
  if (!CFG.email || !CFG.password) {
    console.error("Set STUDENT_EMAIL and STUDENT_PASSWORD (a test student account with a password set).");
    process.exit(1);
  }
  process.on("SIGINT", () => {
    if (stopNow) process.exit(130);
    console.log("\n⏹  Stopping early — finishing in-flight requests and writing the report (Ctrl+C again to abort)…");
    stopNow = true;
  });

  const origin = new URL(CFG.baseUrl).origin;
  console.log(`▶ CodeMasti stress test → ${CFG.baseUrl}`);
  console.log(`  ${CFG.users} students · ramp ${CFG.rampSec}s · hold ${CFG.holdSec}s · think ${CFG.thinkMinMs}-${CFG.thinkMaxMs}ms · login: ${CFG.loginMode}`);

  // Network baseline: /health does no DB work, so this is pure round-trip time.
  const base = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10000) }).then((r) => r.text());
      if (i > 0) base.push(performance.now() - t0); // first one includes TLS handshake
    } catch {
      /* ignore */
    }
  }
  base.sort((a, b) => a - b);
  const baseline = base.length ? { median: pct(base, 50), min: base[0] } : null;
  if (baseline) console.log(`  network baseline (/health): ${fmtMs(baseline.median)}`);

  // Smoke check: one real login + every endpoint once; endpoints that don't return 2xx are skipped.
  const smoke = await login();
  if (!smoke.ok) {
    console.error(`✖ Smoke-check login failed (HTTP ${smoke.r.status || smoke.r.err}): ${JSON.stringify(smoke.r.json?.error || smoke.r.json || "")}`);
    process.exit(1);
  }
  const uniqueCalls = [...new Set([...ENTRY_PAGE.calls, ...PAGES.flatMap((p) => p.calls)])];
  for (const c of uniqueCalls) {
    const r = await request("GET", c, { token: smoke.token });
    if (r.err || r.status >= 400) disabledEndpoints[c] = r.err || `HTTP ${r.status}`;
  }
  const pages = PAGES.filter((p) => p.calls.some((c) => !disabledEndpoints[c]));
  const skipped = Object.entries(disabledEndpoints);
  console.log(`  smoke check: login OK, ${uniqueCalls.length - skipped.length}/${uniqueCalls.length} endpoints OK`);
  for (const [ep, st] of skipped) console.log(`  ⚠ skipping ${ep} (${st})`);

  // Run
  const startedIso = new Date().toISOString();
  startedAt = performance.now();
  recording = true;
  const monitor = startServerMonitor();
  const durationMs = (CFG.rampSec + CFG.holdSec) * 1000;
  const tick = setInterval(() => timeline.push({ t: now(), active: activeUsers, inflight }), 1000);
  let lastIdx = 0;
  const progress = setInterval(() => {
    const recent = samples.slice(lastIdx);
    lastIdx = samples.length;
    const st = summarize(recent);
    const cpu = serverStats.length ? ` · server CPU ${serverStats[serverStats.length - 1].cpu.toFixed(0)}%` : "";
    console.log(
      `  [${String(Math.round(now() / 1000)).padStart(3)}s] students ${String(activeUsers).padStart(3)} · ${(recent.length / 5).toFixed(1)} req/s · p95 ${fmtMs(st.p95)} · errors ${st.errors}${cpu}`
    );
  }, 5000);

  const sharedToken = CFG.loginMode === "shared" ? smoke.token : null;
  const step = CFG.users > 1 ? (CFG.rampSec * 1000) / (CFG.users - 1) : 0;
  await Promise.all(Array.from({ length: CFG.users }, (_, i) => virtualUser(i * step, durationMs, sharedToken, pages)));

  clearInterval(tick);
  clearInterval(progress);
  recording = false;
  const actualMs = now();
  await sleep(1500); // let the monitor capture the cool-down
  if (monitor) monitor.kill();
  const errorLogLines = countServerErrorLogs(startedIso);

  // Analyse
  const nonLogin = samples.filter((s) => s.ep !== LOGIN_EP);
  const overall = summarize(samples);
  const overallNonLogin = summarize(nonLogin);
  const loginStats = summarize(samples.filter((s) => s.ep === LOGIN_EP));
  const endpoints = [...groupBy(samples, (s) => s.ep).entries()].map(([ep, list]) => ({ ep, ...summarize(list) })).sort((a, b) => b.p95 - a.p95);
  const pagesSummary = [...groupBy(pageSamples, (s) => s.name).entries()].map(([name, list]) => ({ name, ...summarize(list) })).sort((a, b) => b.p95 - a.p95);
  const statusCounts = {};
  for (const s of samples) {
    const k = s.err ? (s.err === "timeout" ? "timeout" : String(s.err)) : String(s.status);
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const durationSec = Math.round(actualMs / 1000);
  const buckets = buildBuckets(actualMs);
  const saturation = saturationBands(CFG.users >= 200 ? 50 : 25);
  const cpus = serverStats.map((s) => s.cpu);
  const server = {
    count: serverStats.length,
    cpuMax: cpus.length ? Math.max(...cpus) : 0,
    cpuAvg: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : 0,
    memMax: serverStats.length ? Math.max(...serverStats.map((s) => s.memMiB)) : 0,
    memLimit: serverStats.length ? serverStats[serverStats.length - 1].memLimitMiB : 0,
    loadMax: serverStats.length ? Math.max(...serverStats.map((s) => s.load)) : 0,
  };

  const allLoggedIn = usersFailedLogin === 0 && !stopNow;
  let verdict;
  if (overall.errPct <= CFG.targetErrPct && overallNonLogin.p95 <= CFG.targetP95Ms && allLoggedIn) {
    verdict = { tone: "good", label: `PASS — handles ${CFG.users} concurrent students`, text: `Error rate ${fmtPct(overall.errPct)} and p95 ${fmtMs(overallNonLogin.p95)} are within targets.` };
  } else if (overall.errPct <= 5 && overallNonLogin.p95 <= CFG.targetP95Ms * 3 && usersFailedLogin === 0) {
    const misses = [];
    if (overallNonLogin.p95 > CFG.targetP95Ms) misses.push(`p95 is ${fmtMs(overallNonLogin.p95)} (target ${fmtMs(CFG.targetP95Ms)}) — students will notice lag`);
    if (overall.errPct > CFG.targetErrPct) misses.push(`error rate is ${fmtPct(overall.errPct)} (target ≤ ${CFG.targetErrPct}%)`);
    verdict = { tone: "warn", label: `DEGRADED — works for ${CFG.users} students, with issues`, text: `No major failures, but ${misses.join("; ")}.` };
  } else {
    verdict = { tone: "bad", label: `FAIL — cannot reliably serve ${CFG.users} concurrent students`, text: `Error rate ${fmtPct(overall.errPct)}, p95 ${fmtMs(overallNonLogin.p95)}, ${usersFailedLogin} students could not log in. See findings below.` };
  }
  if (stopNow) verdict.text += " (Test was stopped early.)";

  const ctx = { overall, latency: overallNonLogin, login: loginStats, pages: pagesSummary, endpoints, statusCounts, buckets, server, baseline, saturation, verdict, durationSec, errorLogLines, startedIso };
  ctx.findings = buildFindings(ctx);

  fs.mkdirSync(CFG.outDir, { recursive: true });
  const htmlPath = path.join(CFG.outDir, "report.html");
  fs.writeFileSync(htmlPath, renderReport(ctx));
  fs.writeFileSync(
    path.join(CFG.outDir, "summary.json"),
    JSON.stringify(
      { config: { ...CFG, password: undefined, sshKey: undefined }, startedIso, durationSec, verdict, usersLoggedIn, usersFailedLogin, overall, overallExcludingLogin: overallNonLogin, login: loginStats, endpoints, pages: pagesSummary, statusCounts, server, baseline, saturation, findings: ctx.findings, disabledEndpoints, errorLogLines },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(CFG.outDir, "requests.csv"),
    "t_ms,endpoint,status,latency_ms,error,active_students\n" +
      samples.map((s) => `${Math.round(s.t)},${s.ep},${s.status},${Math.round(s.ms)},${s.err ? `"${String(s.err).replace(/"/g, "'")}"` : ""},${s.u}`).join("\n")
  );

  console.log(`\n${verdict.label}`);
  console.log(`  ${verdict.text}`);
  console.log(`  requests ${fmtNum(overall.count)} · errors ${fmtPct(overall.errPct)} · p50 ${fmtMs(overallNonLogin.p50)} · p95 ${fmtMs(overallNonLogin.p95)} · login p95 ${loginStats.count ? fmtMs(loginStats.p95) : "—"}`);
  if (server.count) console.log(`  server CPU peak ${server.cpuMax.toFixed(0)}% · memory peak ${fmtNum(server.memMax)} MiB`);
  console.log(`\n📄 Report: ${htmlPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
