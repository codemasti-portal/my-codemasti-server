const { sendSuccess, sendError } = require("../utils/response");
const BadgeProgram = require("../models/BadgeProgram");
const badgeProgramSvc = require("../services/badge-program.service");

function mapProgramLean(row) {
  if (!row) return null;
  const id = row._id || row.id;
  return {
    id: id ? String(id) : "",
    badge_code: row.badge_code,
    title: row.title,
    description: row.description || "",
    icon_key: row.icon_key,
    accent: row.accent,
    status: row.status,
    award_rule_kind: row.award_rule_kind,
    award_rule_threshold: Number(row.award_rule_threshold || 0),
    monthly_evaluation: row.monthly_evaluation || "ist_auto",
    monthly_custom_dom:
      row.monthly_custom_dom != null && row.monthly_custom_dom !== ""
        ? Number(row.monthly_custom_dom)
        : null,
    published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    created_at: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updated_at: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    custom_image_url: row.custom_image_url || "",
    badge_layout: row.badge_layout && typeof row.badge_layout === "object" ? row.badge_layout : null,
  };
}

async function list(req, res) {
  try {
    const status = String(req.query.status || "all").toLowerCase();
    const q = {};
    if (status === "published" || status === "draft") q.status = status;
    const rows = await BadgeProgram.find(q).sort({ updatedAt: -1 }).lean();
    const data = rows.map((r) => mapProgramLean(r));
    return sendSuccess(res, data);
  } catch (err) {
    return sendError(res, 500, "BADGE_PROGRAM_LIST_FAILED", err?.message || "Failed to list badges");
  }
}

async function getOne(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const row = await BadgeProgram.findById(id).lean();
    if (!row) return sendError(res, 404, "BADGE_PROGRAM_NOT_FOUND", "Badge not found");
    return sendSuccess(res, mapProgramLean(row));
  } catch (err) {
    return sendError(res, 500, "BADGE_PROGRAM_GET_FAILED", err?.message || "Failed to load badge");
  }
}

async function create(req, res) {
  try {
    const body = req.body || {};
    let doc = await badgeProgramSvc.createDraft(body);
    let awardSummary = null;
    let profileSync = null;
    if (body.publish_now) {
      await badgeProgramSvc.updateProgram(doc._id, {}, { publish: true });
      doc = await BadgeProgram.findById(doc._id);
      awardSummary = await badgeProgramSvc.awardAllStudentsForPublishedProgram(doc._id);
      profileSync = doc ? await badgeProgramSvc.syncEarnedProgramBadgesFromProgram(doc) : null;
    }
    const lean = doc.toObject ? doc.toObject() : doc;
    const msg = body.publish_now
      ? `Published. New awards (this pass): ${awardSummary?.awarded_hints ?? 0} of ${awardSummary?.students_checked ?? 0} students checked.`
      : "Badge saved as draft.";
    const profileNote =
      profileSync && profileSync.student_badges_updated > 0
        ? ` Synced display (title, description, art) on ${profileSync.student_badges_updated} student row(s).`
        : "";
    return sendSuccess(
      res,
      { ...mapProgramLean(lean), award_summary: awardSummary, profile_sync: profileSync },
      body.publish_now ? `${msg}${profileNote}` : msg
    );
  } catch (err) {
    const c = err?.code;
    if (c === "TITLE_REQUIRED" || c === "INVALID_RULE_KIND" || c === "INVALID_THRESHOLD") {
      return sendError(res, 400, c, err.message || "Invalid input");
    }
    return sendError(res, 500, "BADGE_PROGRAM_CREATE_FAILED", err?.message || "Create failed");
  }
}

async function patch(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const before = await BadgeProgram.findById(id).select("status").lean();
    if (!before) return sendError(res, 404, "BADGE_PROGRAM_NOT_FOUND", "Badge not found");

    const body = { ...(req.body || {}) };
    const publishNow = Boolean(body.publish_now);
    delete body.publish_now;

    const doc = await badgeProgramSvc.updateProgram(id, body, { publish: publishNow });
    if (!doc) return sendError(res, 404, "BADGE_PROGRAM_NOT_FOUND", "Badge not found");

    let awardSummary = null;
    if (publishNow && before.status === "draft" && doc.status === "published") {
      awardSummary = await badgeProgramSvc.awardAllStudentsForPublishedProgram(doc._id);
    }

    let profileSync = null;
    if (doc.status === "published") {
      profileSync = await badgeProgramSvc.syncEarnedProgramBadgesFromProgram(doc);
    }

    const msg =
      publishNow && before.status === "draft"
        ? "Published and queued awards for eligible students."
        : "Badge updated.";
    const profileNote =
      profileSync && profileSync.student_badges_updated > 0
        ? ` Updated ${profileSync.student_badges_updated} student profile badge row(s).`
        : "";
    return sendSuccess(
      res,
      {
        ...mapProgramLean(doc.toObject ? doc.toObject() : doc),
        award_summary: awardSummary,
        profile_sync: profileSync,
      },
      awardSummary
        ? `${msg} New inserts (approximate): ${awardSummary.awarded_hints}. Students scanned: ${awardSummary.students_checked}.${profileNote}`
        : `${msg}${profileNote}`
    );
  } catch (err) {
    return sendError(res, 500, "BADGE_PROGRAM_UPDATE_FAILED", err?.message || "Update failed");
  }
}

async function reawardPublished(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const before = await BadgeProgram.findById(id).lean();
    if (!before || before.status !== "published") {
      return sendError(res, 400, "BADGE_NOT_PUBLISHED", "Only published badges can be re-awarded.");
    }
    const awardSummary = await badgeProgramSvc.awardAllStudentsForPublishedProgram(id);
    const doc = await BadgeProgram.findById(id);
    const profileSync = doc ? await badgeProgramSvc.syncEarnedProgramBadgesFromProgram(doc) : null;
    return sendSuccess(
      res,
      { ...awardSummary, profile_sync: profileSync },
      profileSync && profileSync.student_badges_updated > 0
        ? `Eligible students refreshed. Synced display on ${profileSync.student_badges_updated} student badge row(s).`
        : "Eligible students refreshed."
    );
  } catch (err) {
    return sendError(res, 500, "BADGE_REAWARD_FAILED", err?.message || "Re-award failed");
  }
}

async function remove(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const summary = await badgeProgramSvc.deleteBadgeProgram(id);
    if (!summary.ok) {
      return sendError(res, 404, "BADGE_PROGRAM_NOT_FOUND", "Badge not found.");
    }
    return sendSuccess(
      res,
      summary,
      `Badge deleted. Removed ${summary.removed_student_badges} earned row(s) from student profiles (if any).`
    );
  } catch (err) {
    return sendError(res, 500, "BADGE_PROGRAM_DELETE_FAILED", err?.message || "Delete failed");
  }
}

module.exports = {
  list,
  getOne,
  create,
  patch,
  reawardPublished,
  remove,
};
