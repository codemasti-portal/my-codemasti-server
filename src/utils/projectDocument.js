/**
 * Project instructional document stored on AssignmentQuestion.project_document.
 * Markdown strings follow the same convention as question.description (GFM on the clients).
 */

const MAX_MARKDOWN_CHARS = 20000;
const MAX_STEPS = 40;
const MAX_MEDIA_PER_STEP = 12;
const MAX_URL_CHARS = 2048;
const MAX_LABEL_CHARS = 200;
const MAX_STEP_ID_CHARS = 80;

function isHttpUrl(value) {
  const s = String(value || "").trim();
  if (!s || s.length > MAX_URL_CHARS) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

function clipString(value, max) {
  return String(value ?? "").slice(0, max);
}

function normalizeMediaList(rows, { urlKey = "url", labelKey = "label" } = {}) {
  if (!Array.isArray(rows)) return { ok: false, message: "Media lists must be arrays." };
  if (rows.length > MAX_MEDIA_PER_STEP) {
    return { ok: false, message: `At most ${MAX_MEDIA_PER_STEP} media items are allowed per step list.` };
  }
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
    const url = String(row[urlKey] ?? row.href ?? "").trim();
    if (!url) continue;
    if (!isHttpUrl(url)) {
      return { ok: false, message: `Invalid URL at index ${i}: only http(s) URLs are allowed.` };
    }
    const label = clipString(row[labelKey] ?? row.caption ?? row.title ?? "", MAX_LABEL_CHARS).trim();
    out.push({ url, label });
  }
  return { ok: true, value: out };
}

function slugStepId(raw, index) {
  const base = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STEP_ID_CHARS);
  return base || `step-${index + 1}`;
}

function emptyProjectDocument() {
  return {
    overview: "",
    prerequisites: "",
    steps: [],
    deliverables: "",
  };
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function normalizeProjectDocument(input) {
  if (input == null) {
    return { ok: true, value: emptyProjectDocument() };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "project_document must be an object." };
  }

  const overview = clipString(input.overview, MAX_MARKDOWN_CHARS);
  const prerequisites = clipString(input.prerequisites, MAX_MARKDOWN_CHARS);
  const deliverables = clipString(input.deliverables, MAX_MARKDOWN_CHARS);

  if (String(input.overview || "").length > MAX_MARKDOWN_CHARS) {
    return { ok: false, message: `overview exceeds ${MAX_MARKDOWN_CHARS} characters.` };
  }
  if (String(input.prerequisites || "").length > MAX_MARKDOWN_CHARS) {
    return { ok: false, message: `prerequisites exceeds ${MAX_MARKDOWN_CHARS} characters.` };
  }
  if (String(input.deliverables || "").length > MAX_MARKDOWN_CHARS) {
    return { ok: false, message: `deliverables exceeds ${MAX_MARKDOWN_CHARS} characters.` };
  }

  const rawSteps = input.steps;
  if (rawSteps != null && !Array.isArray(rawSteps)) {
    return { ok: false, message: "project_document.steps must be an array." };
  }
  if ((rawSteps || []).length > MAX_STEPS) {
    return { ok: false, message: `At most ${MAX_STEPS} implementation steps are allowed.` };
  }

  const steps = [];
  const seenIds = new Set();
  for (let i = 0; i < (rawSteps || []).length; i += 1) {
    const row = rawSteps[i] && typeof rawSteps[i] === "object" ? rawSteps[i] : {};
    let stepId = slugStepId(row.step_id || row.id, i);
    if (seenIds.has(stepId)) {
      return { ok: false, message: `Duplicate step_id "${stepId}". Each step needs a unique identifier.` };
    }
    seenIds.add(stepId);
    if (String(row.content || "").length > MAX_MARKDOWN_CHARS) {
      return { ok: false, message: `Step "${stepId}" content exceeds ${MAX_MARKDOWN_CHARS} characters.` };
    }

    const images = normalizeMediaList(row.images || [], { labelKey: "caption" });
    if (!images.ok) return { ok: false, message: `Step "${stepId}" images: ${images.message}` };
    const videos = normalizeMediaList(row.videos || [], { labelKey: "caption" });
    if (!videos.ok) return { ok: false, message: `Step "${stepId}" videos: ${videos.message}` };
    const resources = normalizeMediaList(row.resources || [], { labelKey: "label" });
    if (!resources.ok) return { ok: false, message: `Step "${stepId}" resources: ${resources.message}` };

    steps.push({
      step_id: stepId,
      title: clipString(row.title, MAX_LABEL_CHARS).trim(),
      content: String(row.content ?? ""),
      images: images.value,
      videos: videos.value,
      resources: resources.value,
    });
  }

  return {
    ok: true,
    value: { overview, prerequisites, steps, deliverables },
  };
}

function projectDocumentForStudent(doc) {
  const n = normalizeProjectDocument(doc || {});
  return n.ok ? n.value : emptyProjectDocument();
}

function hasProjectDocumentContent(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  if (String(d.overview || "").trim()) return true;
  if (String(d.prerequisites || "").trim()) return true;
  if (String(d.deliverables || "").trim()) return true;
  if (Array.isArray(d.steps) && d.steps.length) return true;
  return false;
}

module.exports = {
  MAX_MARKDOWN_CHARS,
  MAX_STEPS,
  MAX_MEDIA_PER_STEP,
  emptyProjectDocument,
  normalizeProjectDocument,
  projectDocumentForStudent,
  hasProjectDocumentContent,
  isHttpUrl,
};
