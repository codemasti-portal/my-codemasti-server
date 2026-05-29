const { sendSuccess } = require("../utils/response");
const Announcement = require("../models/Announcement");
const Student = require("../models/Student");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { postedByStudentLabel } = require("../utils/announcementAuthor");
const { scopeStudentToBatch } = require("../utils/student-batch-context");

function normSid(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function programMatches(rawStudent, ann) {
  if (ann.scope !== "batch") return false;
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent || {});
  const annBid = String(ann.batch_id || "").trim().toLowerCase();
  const stBid = String(student.batch_id || "").trim().toLowerCase();
  const annB = String(ann.batch || "").trim().toLowerCase();
  const stB = String(student.batch || "").trim().toLowerCase();
  if (annBid) {
    if (stBid && annBid === stBid) return true;
    if (!stBid && stB && annB && stB === annB) return true;
    return false;
  }
  return annB === stB && Boolean(annB);
}

function sectionAllows(student, ann) {
  const ids = Array.isArray(ann.section_ids) ? ann.section_ids.map(normSid).filter(Boolean) : [];
  if (ids.length === 0) return true;
  const eff = normSid(student.section_id || student.enrollment_section || "");
  if (!eff) return false;
  return ids.includes(eff);
}

function isAnnouncementVisible(student, ann) {
  if (ann.scope === "global") return true;
  if (ann.scope === "batch") return programMatches(student, ann) && sectionAllows(student, ann);
  return false;
}

/** Past or present `date` — future dates are scheduled and hidden from students until then. */
function isAnnouncementPublished(ann) {
  if (ann.date == null) return true;
  const t = new Date(ann.date).getTime();
  if (Number.isNaN(t)) return true;
  return t <= Date.now();
}

async function list(req, res) {
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const skip = (page - 1) * limit;
  const scope = req.query.scope;

  const student = await Student.findById(req.user.sub).lean();
  if (student) await scopeStudentToBatch(req, student);
  const all = await Announcement.find({}).sort({ date: -1 }).lean();

  let visible = all.filter((a) => isAnnouncementVisible(student, a) && isAnnouncementPublished(a));
  if (scope === "global") {
    visible = visible.filter((a) => a.scope === "global");
  }

  const total = visible.length;
  const slice = visible.slice(skip, skip + limit);

  const data = slice.map((item) => ({
    id: String(item._id),
    title: item.title,
    description: item.description,
    date: item.date,
    scope: item.scope === "global" ? "global" : "batch",
    batch_name:
      item.scope === "global"
        ? ""
        : String(item.batch || "").trim() || String(item.batch_id || "").trim(),
    posted_by_label: postedByStudentLabel(item.created_by_role),
  }));

  return sendSuccess(res, data, "", {
    page,
    limit,
    total,
  });
}

module.exports = { list };
