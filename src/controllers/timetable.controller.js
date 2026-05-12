const { z } = require("zod");
const { sendSuccess } = require("../utils/response");
const TimetableSlot = require("../models/TimetableSlot");
const TimetableEvent = require("../models/TimetableEvent");
const Student = require("../models/Student");
const { catalogBatchIdsFromStudentLean } = require("../utils/enrollment");

async function weekly(req, res) {
  const schema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  });
  const query = schema.parse(req.query);

  const student = await Student.findById(req.user.sub).select("batch_id section_id enrollment_number").lean();
  const batchKeys = catalogBatchIdsFromStudentLean(student);
  const section_id = String(student?.section_id || "").trim().toLowerCase();

  if (!batchKeys.length) {
    return sendSuccess(res, []);
  }

  const filter = { batch_id: { $in: batchKeys } };
  if (section_id) {
    filter.$or = [
      { section_id: "" },
      { section_id: { $exists: false } },
      { section_id: section_id },
    ];
  }

  // Default window: last 30 days + next 60 days, to support both weekly & monthly views.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fromDefault = new Date(now);
  fromDefault.setDate(fromDefault.getDate() - 30);
  const toDefault = new Date(now);
  toDefault.setDate(toDefault.getDate() + 60);

  const from = String(query.from || "").trim() || fmt(fromDefault);
  const to = String(query.to || "").trim() || fmt(toDefault);
  filter.class_date = { $gte: from, $lte: to };

  const slots = await TimetableSlot.find(filter).sort({ class_date: 1, time: 1 }).lean();

  const data = slots.map((slot) => ({
    id: String(slot._id),
    day: slot.day,
    time: slot.time,
    subject: slot.subject,
    topic: slot.topic || "",
    teacher: slot.teacher,
    section_id: slot.section_id || "",
    class_date: slot.class_date || "",
    meet_link: slot.meet_link || "",
    recording_link: slot.recording_link || "",
    notes_link: slot.notes_link || "",
  }));

  return sendSuccess(res, data);
}

async function recordings(req, res) {
  const schema = z.object({
    q: z.string().optional(),
    subject: z.string().optional(),
    instructor: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().optional().default(1),
    limit: z.coerce.number().optional().default(20),
  });
  const query = schema.parse(req.query);

  const student = await Student.findById(req.user.sub).select("batch_id section_id enrollment_number").lean();
  const batchKeys = catalogBatchIdsFromStudentLean(student);
  const section_id = String(student?.section_id || "").trim().toLowerCase();
  if (!batchKeys.length) return sendSuccess(res, [], "", { page: 1, limit: 20, total: 0 });

  const filter = { batch_id: { $in: batchKeys }, recording_link: { $exists: true, $ne: "" } };
  if (section_id) {
    filter.$or = [
      { section_id: "" },
      { section_id: { $exists: false } },
      { section_id: section_id },
    ];
  }
  if (query.from || query.to) {
    filter.class_date = {};
    if (query.from) filter.class_date.$gte = query.from;
    if (query.to) filter.class_date.$lte = query.to;
  }
  if (query.subject?.trim()) {
    filter.subject = { $regex: query.subject.trim(), $options: "i" };
  }
  if (query.instructor?.trim()) {
    filter.teacher = { $regex: query.instructor.trim(), $options: "i" };
  }
  if (query.q?.trim()) {
    const q = query.q.trim();
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { subject: { $regex: q, $options: "i" } },
          { teacher: { $regex: q, $options: "i" } },
        ],
      },
    ];
  }

  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    TimetableSlot.find(filter).sort({ class_date: -1, time: -1 }).skip(skip).limit(limit).lean(),
    TimetableSlot.countDocuments(filter),
  ]);

  const data = rows.map((slot) => ({
    id: String(slot._id),
    subject: slot.subject,
    topic: "", // Timetable doesn't store topic; keep shape compatible with student UI.
    instructor: slot.teacher,
    date: slot.class_date,
    time: slot.time,
    recording_link: slot.recording_link,
  }));
  return sendSuccess(res, data, "", { page, limit, total });
}

async function notes(req, res) {
  const schema = z.object({
    q: z.string().optional(),
    subject: z.string().optional(),
    instructor: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().optional().default(1),
    limit: z.coerce.number().optional().default(20),
  });
  const query = schema.parse(req.query);

  const student = await Student.findById(req.user.sub).select("batch_id section_id enrollment_number").lean();
  const batchKeys = catalogBatchIdsFromStudentLean(student);
  const section_id = String(student?.section_id || "").trim().toLowerCase();
  if (!batchKeys.length) return sendSuccess(res, [], "", { page: 1, limit: 20, total: 0 });

  const filter = { batch_id: { $in: batchKeys }, notes_link: { $exists: true, $ne: "" } };
  if (section_id) {
    filter.$or = [
      { section_id: "" },
      { section_id: { $exists: false } },
      { section_id: section_id },
    ];
  }
  if (query.from || query.to) {
    filter.class_date = {};
    if (query.from) filter.class_date.$gte = query.from;
    if (query.to) filter.class_date.$lte = query.to;
  }
  if (query.subject?.trim()) {
    filter.subject = { $regex: query.subject.trim(), $options: "i" };
  }
  if (query.instructor?.trim()) {
    filter.teacher = { $regex: query.instructor.trim(), $options: "i" };
  }
  if (query.q?.trim()) {
    const q = query.q.trim();
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { subject: { $regex: q, $options: "i" } },
          { teacher: { $regex: q, $options: "i" } },
        ],
      },
    ];
  }

  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    TimetableSlot.find(filter).sort({ class_date: -1, time: -1 }).skip(skip).limit(limit).lean(),
    TimetableSlot.countDocuments(filter),
  ]);

  const data = rows.map((slot) => ({
    id: String(slot._id),
    subject: slot.subject,
    topic: "",
    instructor: slot.teacher,
    date: slot.class_date,
    time: slot.time,
    notes_link: slot.notes_link,
  }));
  return sendSuccess(res, data, "", { page, limit, total });
}

async function events(req, res) {
  const schema = z.object({
    from: z.string().min(10),
    to: z.string().min(10),
  });
  const query = schema.parse(req.query);
  const student = await Student.findById(req.user.sub).select("batch_id enrollment_number").lean();
  const batchKeys = catalogBatchIdsFromStudentLean(student);

  const fromDate = new Date(`${query.from}T00:00:00.000Z`);
  const toDate = new Date(`${query.to}T23:59:59.999Z`);

  const filter = {
    date: { $gte: fromDate, $lte: toDate },
  };
  if (batchKeys.length) {
    filter.$or = [{ batch_id: "" }, { batch_id: { $in: batchKeys } }];
  }

  const rows = await TimetableEvent.find(filter).sort({ date: 1 }).lean();

  const data = rows.map((event) => ({
    id: String(event._id),
    title: event.title,
    type: event.type,
    description: event.description,
    date: event.date,
    batch_id: event.batch_id || null,
  }));

  return sendSuccess(res, data);
}

module.exports = { weekly, recordings, notes, events };
