const { z } = require("zod");
const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const Announcement = require("../models/Announcement");
const Note = require("../models/Note");
const Student = require("../models/Student");
const Notification = require("../models/Notification");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");

const INSERT_CHUNK = 500;

function normSectionId(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function studentMatchesNoteAudience(student, note) {
  const batchIds = [
    student?.batch_id,
    student?.batch,
    student?.enrollment_batch_name,
    student?.enrollment_batch_prefix,
  ]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  const sid = normSectionId(student?.section_id || student?.enrollment_section || "");
  const targetBatchIds = (note?.target_batch_ids || []).map((x) => String(x || "").trim().toLowerCase());
  const targetRefs = (note?.target_section_refs || []).map((r) => ({
    batch_id: String(r?.batch_id || "").trim().toLowerCase(),
    section_id: normSectionId(r?.section_id || ""),
  }));

  // Legacy notes without explicit targeting are visible to all students.
  if (targetBatchIds.length === 0 && targetRefs.length === 0) return true;
  if (batchIds.length && targetBatchIds.some((bid) => batchIds.includes(bid))) return true;
  if (batchIds.length && sid && targetRefs.some((r) => batchIds.includes(r.batch_id) && r.section_id === sid)) return true;
  return false;
}

async function fanoutNoteNotification(noteDoc, action = "added") {
  if (!noteDoc) return;
  const students = await Student.find({})
    .select("_id batch batch_id section_id enrollment_section enrollment_number enrollment_batch_name enrollment_batch_prefix")
    .lean();
  const matched = students.filter((s) =>
    studentMatchesNoteAudience(augmentStudentCatalogFieldsFromEnrollment(s), noteDoc)
  );
  if (!matched.length) return;

  const docs = matched.map((s) => ({
    student_id: s._id,
    type: "system",
    title: action === "updated" ? "Note updated" : "New note added",
    body: `${noteDoc.subject} - ${noteDoc.module}`,
    read_at: null,
    ref_id: `note:${String(noteDoc._id)}`,
  }));
  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    const slice = docs.slice(i, i + INSERT_CHUNK);
    if (slice.length) await Notification.insertMany(slice, { ordered: false });
  }
}

function isPublishedNow(dateValue) {
  if (!dateValue) return true;
  const t = new Date(dateValue).getTime();
  if (!Number.isFinite(t)) return true;
  return t <= Date.now();
}

function studentMatchesAnnouncement(student, ann) {
  if (!student || !ann) return false;
  if (ann.scope === "global") return true;
  if (ann.scope !== "batch") return false;

  const annBid = String(ann.batch_id || "").trim();
  const annBatch = String(ann.batch || "").trim();
  const stBid = String(student.batch_id || "").trim();
  const stBatch = String(student.batch || "").trim();

  let programOk = false;
  if (annBid) {
    programOk = stBid ? stBid === annBid : Boolean(annBatch && stBatch && stBatch === annBatch);
  } else {
    programOk = Boolean(annBatch && stBatch && stBatch === annBatch);
  }
  if (!programOk) return false;

  const sectionIds = Array.isArray(ann.section_ids) ? ann.section_ids.map(normSectionId).filter(Boolean) : [];
  if (sectionIds.length === 0) return true;
  const stSection = normSectionId(student.section_id || student.enrollment_section || "");
  if (!stSection) return false;
  return sectionIds.includes(stSection);
}

async function fanoutAnnouncementNotification(annDoc) {
  if (!annDoc || !isPublishedNow(annDoc.date)) return;

  const students = await Student.find({}).select("_id batch batch_id section_id enrollment_section").lean();
  const matched = students.filter((s) => studentMatchesAnnouncement(s, annDoc));
  if (!matched.length) return;
  const refId = String(annDoc._id);
  const matchedIds = matched.map((s) => s._id);

  const existing = await Notification.find({
    type: "announcement",
    ref_id: refId,
    student_id: { $in: matchedIds },
  })
    .select("student_id")
    .lean();
  const alreadyNotified = new Set(existing.map((n) => String(n.student_id)));

  const docs = matched
    .map((s) => {
      if (alreadyNotified.has(String(s._id))) return null;
      return {
      student_id: s._id,
      type: "announcement",
      title: annDoc.title,
      body: annDoc.description,
      read_at: null,
      ref_id: refId,
      };
    })
    .filter(Boolean);
  if (!docs.length) return;

  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    const slice = docs.slice(i, i + INSERT_CHUNK);
    if (slice.length) await Notification.insertMany(slice, { ordered: false });
  }
}

function mapAnnouncementDoc(a) {
  const t = a.date ? new Date(a.date).getTime() : NaN;
  const is_scheduled = Number.isFinite(t) && t > Date.now();
  return {
    id: String(a._id),
    title: a.title,
    description: a.description,
    scope: a.scope,
    batch: a.batch,
    batch_id: a.batch_id || "",
    section_ids: Array.isArray(a.section_ids) ? a.section_ids : [],
    date: a.date,
    is_scheduled,
  };
}

const noteSectionSchema = z.object({
  title: z.string().min(1),
  points: z.array(z.string()).default([]),
});

async function listAnnouncements(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const batchIdFilter = String(req.query.batch_id || "").trim().toLowerCase();
  const includeGlobal = String(req.query.include_global || "") === "1" || String(req.query.include_global || "").toLowerCase() === "true";
  let mongoFilter = {};
  if (batchIdFilter) {
    mongoFilter = includeGlobal
      ? { $or: [{ batch_id: batchIdFilter }, { scope: "global" }] }
      : { batch_id: batchIdFilter };
  }

  const [items, total] = await Promise.all([
    Announcement.find(mongoFilter).sort({ date: -1 }).skip(skip).limit(limit).lean(),
    Announcement.countDocuments(mongoFilter),
  ]);

  const data = items.map(mapAnnouncementDoc);
  return sendSuccess(res, data, "", { page, limit, total });
}

async function getAnnouncement(req, res) {
  const doc = await Announcement.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Announcement not found");
  return sendSuccess(res, mapAnnouncementDoc(doc));
}

async function createAnnouncement(req, res) {
  const batchTargetSchema = z.object({
    batch: z.string().min(1).trim(),
    batch_id: z.string().optional().default(""),
    section_ids: z.array(z.string()).optional().default([]),
  });

  const multiSchema = z.object({
    title: z.string().min(2).trim(),
    description: z.string().min(1).trim(),
    date: z.coerce.date().optional(),
    audience: z.enum(["global", "batches"]),
    batches: z.array(batchTargetSchema).min(1),
  });

  const legacySchema = z.object({
    title: z.string().min(2).trim(),
    description: z.string().min(1).trim(),
    scope: z.enum(["batch", "global"]).default("global"),
    batch: z.string().optional().default(""),
    batch_id: z.string().optional().default(""),
    section_ids: z.array(z.string()).optional().default([]),
    date: z.coerce.date().optional(),
  });

  const raw = req.body || {};
  let createdDocs = [];

  if (raw.audience === "batches" && Array.isArray(raw.batches)) {
    const body = multiSchema.parse(raw);
    for (const t of body.batches) {
      const section_ids = (t.section_ids || []).map(normSectionId).filter(Boolean);
      const doc = await Announcement.create({
        title: body.title,
        description: body.description,
        scope: "batch",
        batch: t.batch.trim(),
        batch_id: String(t.batch_id || "").trim(),
        section_ids,
        date: body.date || new Date(),
      });
      createdDocs.push(doc);
      await fanoutAnnouncementNotification(doc.toObject ? doc.toObject() : doc);
    }
    return sendSuccess(
      res,
      {
        count: createdDocs.length,
        items: createdDocs.map((c) => mapAnnouncementDoc(c.toObject ? c.toObject() : c)),
      },
      `Created ${createdDocs.length} announcement(s)`
    );
  }

  if (raw.audience === "global") {
    const title = String(raw.title || "").trim();
    const description = String(raw.description || "").trim();
    if (title.length < 2 || !description) {
      return sendError(res, 400, "VALIDATION_ERROR", "title and description are required");
    }
    const created = await Announcement.create({
      title,
      description,
      scope: "global",
      batch: "",
      batch_id: "",
      section_ids: [],
      date: raw.date ? new Date(raw.date) : new Date(),
    });
    await fanoutAnnouncementNotification(created.toObject ? created.toObject() : created);
    return sendSuccess(res, mapAnnouncementDoc(created.toObject()), "Announcement created");
  }

  const body = legacySchema.parse(raw);
  if (body.scope === "batch" && !body.batch?.trim()) {
    return sendError(res, 400, "VALIDATION_ERROR", "batch is required when scope is batch");
  }
  const section_ids = (body.section_ids || []).map(normSectionId).filter(Boolean);
  const created = await Announcement.create({
    title: body.title,
    description: body.description,
    scope: body.scope,
    batch: body.scope === "batch" ? body.batch.trim() : "",
    batch_id: body.scope === "batch" ? String(body.batch_id || "").trim() : "",
    section_ids: body.scope === "batch" ? section_ids : [],
    date: body.date || new Date(),
  });
  await fanoutAnnouncementNotification(created.toObject ? created.toObject() : created);
  return sendSuccess(res, mapAnnouncementDoc(created.toObject()), "Announcement created");
}

async function updateAnnouncement(req, res) {
  const schema = z.object({
    title: z.string().min(2).trim().optional(),
    description: z.string().min(1).trim().optional(),
    scope: z.enum(["batch", "global"]).optional(),
    batch: z.string().optional(),
    batch_id: z.string().optional(),
    section_ids: z.array(z.string()).optional(),
    date: z.coerce.date().optional(),
  });
  const body = schema.parse(req.body);
  const doc = await Announcement.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Announcement not found");

  if (body.title !== undefined) doc.title = body.title;
  if (body.description !== undefined) doc.description = body.description;
  if (body.scope !== undefined) doc.scope = body.scope;
  if (body.batch !== undefined) doc.batch = body.batch;
  if (body.batch_id !== undefined) doc.batch_id = String(body.batch_id || "").trim();
  if (body.section_ids !== undefined) {
    doc.section_ids = body.section_ids.map(normSectionId).filter(Boolean);
  }
  if (body.date !== undefined) doc.date = body.date;
  if (doc.scope === "batch" && !doc.batch?.trim()) {
    return sendError(res, 400, "VALIDATION_ERROR", "batch is required when scope is batch");
  }
  await doc.save();
  return sendSuccess(res, mapAnnouncementDoc(doc.toObject()), "Announcement updated");
}

async function deleteAnnouncement(req, res) {
  const r = await Announcement.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Announcement not found");
  return sendSuccess(res, { id: req.params.id }, "Announcement deleted");
}

/** Query filters for GET /admin/notes — optional batch_id, section_id, subject (AND together). */
function buildNotesListFilter(query) {
  const subject = String(query.subject || "").trim();
  const batch_id = String(query.batch_id || "").trim().toLowerCase();
  const rawSec = query.section_id;
  const section_id =
    rawSec !== undefined && String(rawSec).trim() !== "" ? normSectionId(rawSec) : "";

  const clauses = [];
  if (subject) clauses.push({ subject });

  if (batch_id) {
    if (section_id) {
      clauses.push({
        $or: [
          { target_batch_ids: batch_id },
          {
            target_section_refs: {
              $elemMatch: { batch_id, section_id },
            },
          },
        ],
      });
    } else {
      clauses.push({
        $or: [{ target_batch_ids: batch_id }, { "target_section_refs.batch_id": batch_id }],
      });
    }
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

async function listNotes(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const filter = buildNotesListFilter(req.query);
  const [items, total] = await Promise.all([
    Note.find(filter).sort({ updated_date: -1 }).skip(skip).limit(limit).lean(),
    Note.countDocuments(filter),
  ]);

  const data = items.map((n) => ({
    id: String(n._id),
    subject: n.subject,
    module: n.module,
    topic: n.topic,
    summary: n.summary,
    size: n.size,
    file_url: n.file_url,
    updated_date: n.updated_date,
    target_batch_ids: n.target_batch_ids || [],
    target_section_refs: (n.target_section_refs || []).map((r) => ({
      batch_id: r.batch_id,
      section_id: r.section_id,
    })),
  }));
  return sendSuccess(res, data, "", { page, limit, total });
}

async function getNote(req, res) {
  const doc = await Note.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Note not found");
  return sendSuccess(res, {
    id: String(doc._id),
    subject: doc.subject,
    module: doc.module,
    topic: doc.topic,
    summary: doc.summary,
    sections: doc.sections || [],
    size: doc.size,
    file_url: doc.file_url,
    updated_date: doc.updated_date,
    target_batch_ids: doc.target_batch_ids || [],
    target_section_refs: (doc.target_section_refs || []).map((r) => ({
      batch_id: r.batch_id,
      section_id: r.section_id,
    })),
  });
}

const sectionRefZ = z.object({
  batch_id: z.string().min(1).trim(),
  section_id: z.string().min(1).trim(),
});

async function createNote(req, res) {
  const schema = z
    .object({
      subject: z.string().min(1).trim(),
      module: z.string().min(1).trim(),
      topic: z.string().optional().default(""),
      summary: z.string().optional().default(""),
      sections: z.array(noteSectionSchema).optional().default([]),
      size: z.string().optional().default(""),
      file_url: z.string().min(1).trim(),
      updated_date: z.coerce.date().optional(),
      target_batch_ids: z.array(z.string().trim()).optional().default([]),
      target_section_refs: z.array(sectionRefZ).optional().default([]),
    })
    .refine(
      (b) =>
        (b.target_batch_ids && b.target_batch_ids.length > 0) ||
        (b.target_section_refs && b.target_section_refs.length > 0),
      { message: "Select at least one batch or one section" }
    );
  const body = schema.parse(req.body);
  const created = await Note.create({
    subject: body.subject,
    module: body.module,
    topic: body.topic,
    summary: body.summary,
    sections: body.sections,
    size: body.size,
    file_url: body.file_url,
    updated_date: body.updated_date || new Date(),
    target_batch_ids: [...new Set(body.target_batch_ids.map((x) => x.toLowerCase()))],
    target_section_refs: body.target_section_refs.map((r) => ({
      batch_id: r.batch_id.toLowerCase().trim(),
      section_id: r.section_id.toLowerCase().trim(),
    })),
  });
  await fanoutNoteNotification(created.toObject ? created.toObject() : created, "added");
  return sendSuccess(
    res,
    {
      id: String(created._id),
      subject: created.subject,
      module: created.module,
      topic: created.topic,
      file_url: created.file_url,
    },
    "Note created"
  );
}

async function updateNote(req, res) {
  const schema = z.object({
    subject: z.string().min(1).trim().optional(),
    module: z.string().min(1).trim().optional(),
    topic: z.string().optional(),
    summary: z.string().optional(),
    sections: z.array(noteSectionSchema).optional(),
    size: z.string().optional(),
    file_url: z.string().min(1).optional(),
    updated_date: z.coerce.date().optional(),
    target_batch_ids: z.array(z.string().trim()).optional(),
    target_section_refs: z.array(sectionRefZ).optional(),
  });
  const body = schema.parse(req.body);
  const doc = await Note.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Note not found");

  if (body.subject !== undefined) doc.subject = body.subject;
  if (body.module !== undefined) doc.module = body.module;
  if (body.topic !== undefined) doc.topic = body.topic;
  if (body.summary !== undefined) doc.summary = body.summary;
  if (body.sections !== undefined) doc.sections = body.sections;
  if (body.size !== undefined) doc.size = body.size;
  if (body.file_url !== undefined) doc.file_url = body.file_url;
  if (body.updated_date !== undefined) doc.updated_date = body.updated_date;
  else doc.updated_date = new Date();
  if (body.target_batch_ids !== undefined) {
    doc.target_batch_ids = [...new Set(body.target_batch_ids.map((x) => x.toLowerCase()))];
  }
  if (body.target_section_refs !== undefined) {
    doc.target_section_refs = body.target_section_refs.map((r) => ({
      batch_id: r.batch_id.toLowerCase().trim(),
      section_id: r.section_id.toLowerCase().trim(),
    }));
  }
  const tb = doc.target_batch_ids || [];
  const ts = doc.target_section_refs || [];
  if (tb.length === 0 && (!ts || ts.length === 0)) {
    return sendError(res, 400, "VALIDATION_ERROR", "Select at least one batch or one section");
  }
  await doc.save();
  await fanoutNoteNotification(doc.toObject ? doc.toObject() : doc, "updated");
  return sendSuccess(
    res,
    {
      id: String(doc._id),
      subject: doc.subject,
      module: doc.module,
      topic: doc.topic,
      file_url: doc.file_url,
      updated_date: doc.updated_date,
    },
    "Note updated"
  );
}

async function deleteNote(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid note id");
  }
  const r = await Note.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Note not found");
  return sendSuccess(res, { id: req.params.id }, "Note deleted");
}

module.exports = {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
};
