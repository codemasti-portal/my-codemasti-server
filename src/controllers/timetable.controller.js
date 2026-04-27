const { z } = require("zod");
const { sendSuccess } = require("../utils/response");
const TimetableSlot = require("../models/TimetableSlot");
const TimetableEvent = require("../models/TimetableEvent");
const Student = require("../models/Student");

async function weekly(req, res) {
  const student = await Student.findById(req.user.sub)
    .select("batch_id section_id")
    .lean();
  const batch_id = String(student?.batch_id || "").trim().toLowerCase();
  const section_id = String(student?.section_id || "").trim().toLowerCase();

  if (!batch_id) {
    return sendSuccess(res, []);
  }

  const filter = { batch_id };
  if (section_id) {
    filter.$or = [
      { section_id: "" },
      { section_id: { $exists: false } },
      { section_id: section_id },
    ];
  }

  const slots = await TimetableSlot.find(filter).sort({ day: 1, time: 1 }).lean();

  const data = slots.map((slot) => ({
    day: slot.day,
    time: slot.time,
    subject: slot.subject,
    teacher: slot.teacher,
    section_id: slot.section_id || "",
  }));

  return sendSuccess(res, data);
}

async function events(req, res) {
  const schema = z.object({
    from: z.string().min(10),
    to: z.string().min(10),
  });
  const query = schema.parse(req.query);
  const student = await Student.findById(req.user.sub).select("batch_id").lean();
  const batch_id = String(student?.batch_id || "").trim().toLowerCase();

  const fromDate = new Date(`${query.from}T00:00:00.000Z`);
  const toDate = new Date(`${query.to}T23:59:59.999Z`);

  const filter = {
    date: { $gte: fromDate, $lte: toDate },
  };
  if (batch_id) {
    filter.$or = [{ batch_id: "" }, { batch_id }];
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

module.exports = { weekly, events };
