const { sendSuccess, sendError } = require("../utils/response");
const badgeDefSvc = require("../services/achievement-badge-definition.service");

async function listCatalog(req, res) {
  try {
    const data = await badgeDefSvc.listCatalogForAdmin();
    return sendSuccess(res, data);
  } catch (err) {
    return sendError(res, 500, "BADGE_CATALOG_FAILED", err?.message ? String(err.message) : "Failed to load badge catalog");
  }
}

async function patchDefinition(req, res) {
  try {
    const code = String(req.params.badgeCode || "").trim();
    if (!code) {
      return sendError(res, 400, "BADGE_CODE_REQUIRED", "badgeCode is required");
    }
    const doc = await badgeDefSvc.upsertDefinition(code, req.body || {});
    const data = {
      badge_code: doc.badge_code,
      category: doc.category,
      title: doc.title,
      description: doc.description || "",
      icon_key: doc.icon_key,
      accent: doc.accent,
      is_published: Boolean(doc.is_published),
      sort_order: Number(doc.sort_order || 0),
      updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    };
    return sendSuccess(res, data, "Badge definition saved.");
  } catch (err) {
    const c = err?.code;
    if (c === "BADGE_CODE_NOT_PROGRAMMABLE") {
      return sendError(res, 400, c, "This badge code is not tied to automatic awarding rules.");
    }
    if (c === "INVALID_ICON_KEY" || c === "INVALID_ACCENT") {
      return sendError(res, 400, c, "Invalid icon or accent token.");
    }
    if (c === "EMPTY_PATCH") {
      return sendError(res, 400, c, "No fields to update.");
    }
    return sendError(res, 500, "BADGE_DEFINITION_SAVE_FAILED", err?.message ? String(err.message) : "Save failed");
  }
}

module.exports = { listCatalog, patchDefinition };
