const { sendSuccess, sendError } = require("../utils/response");
const Note = require("../models/Note");
const Student = require("../models/Student");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { cloudinary, ensureCloudinaryConfig } = require("../utils/cloudinary");
const { scopeStudentToBatch, membershipKeysOr } = require("../utils/student-batch-context");
const { catalogSubjects } = require("../utils/catalog-subjects");

function studentBatchCandidates(student) {
  const vals = [
    student?.batch_id,
    student?.batch,
    student?.enrollment_batch_name,
    student?.enrollment_batch_prefix,
  ];
  return [...new Set(vals.map((v) => String(v || "").toLowerCase().trim()).filter(Boolean))];
}

function studentNoteVisibilityFilter(student) {
  // Use the resolved M:N membership set (attached by scopeStudentToBatch) so a multi-batch student
  // only sees notes for their selected batch — NOT the legacy enrollment-label candidates, which
  // leaked another batch's notes into the selected-batch view.
  const batchIds = membershipKeysOr(student, studentBatchCandidates(student));
  const sid = String(student?.section_id || student?.enrollment_section || "")
    .toLowerCase()
    .trim();

  const parts = [];
  if (batchIds.length) {
    parts.push({ target_batch_ids: { $in: batchIds } });
  }
  if (batchIds.length && sid) {
    parts.push({
      target_section_refs: { $elemMatch: { batch_id: { $in: batchIds }, section_id: sid } },
    });
  }
  if (!parts.length) return { _id: null };
  return { $or: parts };
}

async function list(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const search = String(req.query.search || "").trim();
  const subject = String(req.query.subject || "").trim();
  const month = String(req.query.month || "").trim();
  const sort = String(req.query.sort || "updated_date");
  const order = String(req.query.order || "desc").toLowerCase() === "asc" ? 1 : -1;

  const rawStudent = await Student.findById(req.user.sub).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  await scopeStudentToBatch(req, student);

  const filter = {};
  if (subject) filter.subject = subject;
  if (search) {
    filter.$or = [
      { topic: { $regex: search, $options: "i" } },
      { module: { $regex: search, $options: "i" } },
      { summary: { $regex: search, $options: "i" } },
    ];
  }

  if (month) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      filter.updated_date = { $gte: start, $lt: end };
    }
  }

  const vis = studentNoteVisibilityFilter(student);
  const combined =
    Object.keys(filter).length > 0 ? { $and: [filter, vis] } : vis;

  const sortField = ["updated_date", "subject", "module"].includes(sort) ? sort : "updated_date";
  const [docs, total] = await Promise.all([
    Note.find(combined).sort({ [sortField]: order }).skip(skip).limit(limit).lean(),
    Note.countDocuments(combined),
  ]);

  const items = docs.map((note) => ({
    id: String(note._id),
    subject: note.subject,
    module: note.module,
    updated_date: note.updated_date,
    size: note.size,
    download_link: `${req.protocol}://${req.get("host")}/v1/notes/${note._id}/download`,
    topic: note.topic,
    attachment_type: detectNoteAttachmentType(note.file_url),
  }));

  return sendSuccess(res, items, "", { page, limit, total });
}

async function filters(req, res) {
  const rawStudent = await Student.findById(req.user.sub).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  await scopeStudentToBatch(req, student);
  const vis = studentNoteVisibilityFilter(student);
  // Subjects come from the batch catalog (single source of truth), NOT from distinct note tags.
  const [subjects, monthsRows] = await Promise.all([
    catalogSubjects(String(student.batch_id || "")),
    Note.aggregate([
      { $match: vis },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m", date: "$updated_date", timezone: "UTC" },
          },
        },
      },
      { $sort: { _id: -1 } },
    ]),
  ]);
  return sendSuccess(res, {
    subjects,
    months: monthsRows.map((r) => r._id).filter(Boolean),
  });
}

function noteVisibleToStudent(note, student) {
  const tb = note.target_batch_ids || [];
  const ts = note.target_section_refs || [];
  if (tb.length === 0 && (!ts || ts.length === 0)) return true;
  const batchIds = studentBatchCandidates(student);
  const sid = String(student?.section_id || student?.enrollment_section || "")
    .toLowerCase()
    .trim();
  if (batchIds.length && tb.some((x) => batchIds.includes(String(x).toLowerCase()))) return true;
  if (
    batchIds.length &&
    sid &&
    ts.some((r) => batchIds.includes(String(r.batch_id).toLowerCase()) && String(r.section_id).toLowerCase() === sid)
  ) {
    return true;
  }
  return false;
}

function detectNoteAttachmentType(fileUrl) {
  const url = String(fileUrl || "").toLowerCase();
  if (!url) return "link";
  if (url.includes("/video/upload/")) return "video";
  if (url.includes("/image/upload/")) return "image";
  if (url.includes("/raw/upload/") || /\.pdf(?:\?|$)/i.test(url)) return "pdf";
  if (/\.(png|jpe?g|webp|gif)(?:\?|$)/i.test(url)) return "image";
  if (/\.(mp4|mov|mkv|webm)(?:\?|$)/i.test(url)) return "video";
  return "link";
}

async function detail(req, res) {
  const note = await Note.findById(req.params.noteId).lean();
  if (!note) {
    return sendError(res, 404, "NOTE_NOT_FOUND", "Note not found");
  }

  const rawStudent = await Student.findById(req.user.sub).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  await scopeStudentToBatch(req, student);
  if (!noteVisibleToStudent(note, student)) {
    return sendError(res, 403, "NOTE_FORBIDDEN", "This note is not available for your batch or section");
  }

  return sendSuccess(res, {
    id: String(note._id),
    subject: note.subject,
    module: note.module,
    topic: note.topic,
    summary: note.summary,
    sections: note.sections || [],
    updated_date: note.updated_date,
    size: note.size,
    file_url: note.file_url,
    attachment_type: detectNoteAttachmentType(note.file_url),
  });
}

async function download(req, res) {
  const note = await Note.findById(req.params.noteId).lean();
  if (!note) {
    return sendError(res, 404, "NOTE_NOT_FOUND", "Note not found");
  }

  const rawStudent = await Student.findById(req.user.sub).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  await scopeStudentToBatch(req, student);
  if (!noteVisibleToStudent(note, student)) {
    return sendError(res, 403, "NOTE_FORBIDDEN", "This note is not available for your batch or section");
  }

  let downloadLink = note.file_url;
  const cloudinaryRaw = String(note.file_url || "").match(
    /\/raw\/upload\/(?:v(\d+)\/)?(.+)\.([a-zA-Z0-9]+)(?:\?.*)?$/
  );
  if (cloudinaryRaw) {
    try {
      ensureCloudinaryConfig();
      const version = cloudinaryRaw[1] ? Number(cloudinaryRaw[1]) : undefined;
      const publicId = cloudinaryRaw[2];
      const format = cloudinaryRaw[3];
      downloadLink = cloudinary.url(publicId, {
        resource_type: "raw",
        type: "upload",
        secure: true,
        sign_url: true,
        version,
        format,
      });
    } catch {
      downloadLink = note.file_url;
    }
  }

  return sendSuccess(res, {
    note_id: req.params.noteId,
    download_link: downloadLink,
    expires_in_sec: 300,
    attachment_type: detectNoteAttachmentType(note.file_url),
  });
}

module.exports = { list, filters, detail, download };
