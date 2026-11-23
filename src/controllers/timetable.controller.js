const { z } = require("zod");
const { sendSuccess } = require("../utils/response");
const TimetableSlot = require("../models/TimetableSlot");
const TimetableEvent = require("../models/TimetableEvent");
const Student = require("../models/Student");
const { scopeStudentToBatch } = require("../utils/student-batch-context");
const { catalogBatchIdsFromStudentLean } = require("../utils/enrollment");

async function weekly(req, res) {
  const schema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  });
  const query = schema.parse(req.query);

  const student = await Student.findById(req.user.sub).select("batch_id section_id enrollment_number").lean();
  await scopeStudentToBatch(req, student);
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

  // Default window: generous range when the client omits from/to. Notifications are sent for
  // any new slot, but this query used to cap at +60 days — classes further out never appeared on
  // the student timetable. Widen defaults; prefer clients to pass from/to for the visible calendar.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fromDefault = new Date(now);
  fromDefault.setDate(fromDefault.getDate() - 365);
  const toDefault = new Date(now);
  toDefault.setDate(toDefault.getDate() + 730);

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

async function events(req, res) {
  const schema = z.object({
    from: z.string().min(10),
    to: z.string().min(10),
  });
  const query = schema.parse(req.query);
  const student = await Student.findById(req.user.sub).select("batch_id section_id enrollment_number").lean();
  await scopeStudentToBatch(req, student);
  const batchKeys = catalogBatchIdsFromStudentLean(student);
  const sectionId = String(student?.section_id || "").trim().toLowerCase();

  const fromDate = new Date(`${query.from}T00:00:00.000Z`);
  const toDate = new Date(`${query.to}T23:59:59.999Z`);

  const clauses = [{ date: { $gte: fromDate, $lte: toDate } }];
  if (batchKeys.length) {
    clauses.push({ $or: [{ batch_id: "" }, { batch_id: { $in: batchKeys } }] });
  }
  if (sectionId) {
    clauses.push({
      $or: [{ section_id: "" }, { section_id: { $exists: false } }, { section_id: sectionId }],
    });
  }
  const filter = clauses.length === 1 ? clauses[0] : { $and: clauses };

  const rows = await TimetableEvent.find(filter).sort({ date: 1 }).lean();

  const data = rows.map((event) => ({
    id: String(event._id),
    title: event.title,
    type: event.type,
    description: event.description,
    date: event.date,
    batch_id: event.batch_id || null,
    all_day: event.all_day !== false,
    time: event.time || "",
    duration_minutes: Number(event.duration_minutes || 60),
    meet_link: event.meet_link || "",
  }));

  return sendSuccess(res, data);
}

module.exports = { weekly, events };
