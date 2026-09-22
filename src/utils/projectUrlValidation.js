const { isHttpUrl } = require("./projectDocument");

const MAX_URL_CHARS = 2048;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const GH_OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)(?:$|[?#])/i;
const LOOM_ID = /^[a-f0-9]{16,40}$/i;

function parseHttpsUrl(value) {
  const s = String(value || "").trim();
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > MAX_URL_CHARS) return { ok: false, reason: "too_long" };
  if (!isHttpUrl(s)) return { ok: false, reason: "scheme" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "userinfo" };
  return { ok: true, url: u, href: u.toString() };
}

function hostOf(u) {
  return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
}

function youtubeVideoId(u) {
  const host = hostOf(u);
  const path = u.pathname || "";
  if (host === "youtu.be") {
    const id = path.split("/").filter(Boolean)[0] || "";
    return YT_ID.test(id) ? id : "";
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    const v = u.searchParams.get("v");
    if (v && YT_ID.test(v)) return v;
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "v") {
      const id = parts[1] || "";
      return YT_ID.test(id) ? id : "";
    }
  }
  return "";
}

function isGithubHostedVideo(u) {
  const host = hostOf(u);
  const path = u.pathname || "";
  if (host === "user-images.githubusercontent.com" || host === "media.githubusercontent.com") {
    return true;
  }
  if (host === "raw.githubusercontent.com") {
    return VIDEO_EXT.test(path);
  }
  if (host === "github.com") {
    if (/\/releases\/download\//i.test(path) && VIDEO_EXT.test(path)) return true;
    if (/\/assets\//i.test(path)) return true;
    if (/\/raw\//i.test(path) && VIDEO_EXT.test(path)) return true;
  }
  return false;
}

function isLoomShare(u) {
  const host = hostOf(u);
  if (host !== "loom.com") return false;
  const parts = (u.pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "share" && parts[0] !== "embed") return false;
  return Boolean(parts[1] && LOOM_ID.test(parts[1].split("?")[0]));
}

function isVimeoVideo(u) {
  const host = hostOf(u);
  const parts = (u.pathname || "").split("/").filter(Boolean);
  if (host === "player.vimeo.com") {
    return parts[0] === "video" && /^\d{6,12}$/.test(parts[1] || "");
  }
  if (host === "vimeo.com") {
    return /^\d{6,12}$/.test(parts[0] || "");
  }
  return false;
}

function videoIdentityKey(u) {
  const yt = youtubeVideoId(u);
  if (yt) return `youtube:${yt}`;
  const host = hostOf(u);
  if (host === "loom.com") {
    const parts = (u.pathname || "").split("/").filter(Boolean);
    return `loom:${(parts[1] || "").toLowerCase()}`;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const parts = (u.pathname || "").split("/").filter(Boolean);
    const id = host === "player.vimeo.com" ? parts[1] : parts[0];
    return `vimeo:${id}`;
  }
  return `url:${u.origin}${u.pathname.replace(/\/$/, "")}`;
}

function normalizeProjectVideoUrl(value, fieldName) {
  const parsed = parseHttpsUrl(value);
  if (!parsed.ok) {
    const msg =
      parsed.reason === "empty"
        ? `${fieldName} is required.`
        : `${fieldName} must be a valid https URL.`;
    return { ok: false, message: msg };
  }
  const { url, href } = parsed;
  if (youtubeVideoId(url) || isGithubHostedVideo(url) || isLoomShare(url) || isVimeoVideo(url)) {
    return { ok: true, value: href, identity: videoIdentityKey(url) };
  }
  return {
    ok: false,
    message: `${fieldName} must be a YouTube, Vimeo, Loom, or GitHub-hosted video URL.`,
  };
}

function normalizeGithubRepositoryUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, value: "" };
  const parsed = parseHttpsUrl(raw);
  if (!parsed.ok) {
    return { ok: false, message: "github_repository_url must be a valid https GitHub repository URL." };
  }
  const { url } = parsed;
  if (hostOf(url) !== "github.com") {
    return { ok: false, message: "github_repository_url must be a github.com repository URL." };
  }
  const parts = (url.pathname || "").split("/").filter(Boolean);
  if (parts.length < 2) {
    return { ok: false, message: "github_repository_url must be in the form https://github.com/owner/repo." };
  }
  let owner = parts[0];
  let repo = parts[1].replace(/\.git$/i, "");
  if (!GH_OWNER_REPO.test(owner) || !GH_OWNER_REPO.test(repo) || owner === "orgs" || owner === "settings") {
    return { ok: false, message: "github_repository_url must be in the form https://github.com/owner/repo." };
  }
  return { ok: true, value: `https://github.com/${owner}/${repo}` };
}

function normalizeProjectSubmissionLinks(body) {
  const explanation = normalizeProjectVideoUrl(body?.explanation_video_url, "explanation_video_url");
  if (!explanation.ok) return explanation;
  const demo = normalizeProjectVideoUrl(body?.demo_video_url, "demo_video_url");
  if (!demo.ok) return demo;
  if (explanation.value === demo.value || explanation.identity === demo.identity) {
    return {
      ok: false,
      message: "explanation_video_url and demo_video_url must be different videos.",
    };
  }
  const github = normalizeGithubRepositoryUrl(body?.github_repository_url);
  if (!github.ok) return github;
  return {
    ok: true,
    value: {
      explanation_video_url: explanation.value,
      demo_video_url: demo.value,
      github_repository_url: github.value,
    },
  };
}

module.exports = {
  parseHttpsUrl,
  normalizeProjectVideoUrl,
  normalizeGithubRepositoryUrl,
  normalizeProjectSubmissionLinks,
};
