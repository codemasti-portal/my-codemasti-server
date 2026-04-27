const { sendSuccess, sendError } = require("../utils/response");
const MentorSlot = require("../models/MentorSlot");
const MentorSessionJoin = require("../models/MentorSessionJoin");
const Student = require("../models/Student");

function getSessionStartMs(slot) {
  const baseDate = new Date(slot?.date);
  if (Number.isNaN(baseDate.getTime())) return NaN;
  const rawTime = String(slot?.time || "").trim();
  const m24 = rawTime.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!m24) return baseDate.getTime();
  const hh = Number(m24[1]);
  const mm = Number(m24[2]);
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    hh,
    mm,
    0,
    0
  ).getTime();
}

async function listSlots(req, res) {
  const student = await Student.findById(req.user.sub).select("batch_id section_id").lean();
  const studentBatchId = String(student?.batch_id || "").trim().toLowerCase();
  const studentSectionId = String(student?.section_id || "").trim().toLowerCase();
  const filter = { publish_date: { $lte: new Date() } };
  const batchSectionClauses = [];
  if (studentBatchId) {
    if (studentSectionId) {
      batchSectionClauses.push({
        $and: [
          { target_batch_ids: studentBatchId },
          {
            $or: [
              { target_section_ids: { $exists: false } },
              { target_section_ids: { $size: 0 } },
              { target_section_ids: studentSectionId },
            ],
          },
        ],
      });
    } else {
      batchSectionClauses.push({
        $and: [
          { target_batch_ids: studentBatchId },
          {
            $or: [{ target_section_ids: { $exists: false } }, { target_section_ids: { $size: 0 } }],
          },
        ],
      });
    }
  }
  filter.$or = [{ target_student_ids: req.user.sub }, ...batchSectionClauses];
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }

  const slots = await MentorSlot.find(filter).sort({ date: 1, time: 1 }).limit(200).lean();
  const data = slots.map((s) => ({
    id: String(s._id),
    mentor_name: s.mentor_name,
    mentor_info: s.mentor_info || "",
    date: s.date,
    publish_date: s.publish_date || null,
    time: s.time,
    duration_minutes: Number(s.duration_minutes || 60),
    meet_link: s.meet_link,
    target_batch_ids: Array.isArray(s.target_batch_ids) ? s.target_batch_ids : [],
    target_section_ids: Array.isArray(s.target_section_ids) ? s.target_section_ids : [],
    target_student_ids: Array.isArray(s.target_student_ids) ? s.target_student_ids.map((id) => String(id)) : [],
  }));
  return sendSuccess(res, data);
}

async function book(req, res) {
  const slot = await MentorSlot.findById(req.params.slotId);
  if (!slot) return sendError(res, 404, "SLOT_NOT_FOUND", "Slot not found");
  if (slot.booking_state !== "open") {
    return sendError(res, 409, "SLOT_UNAVAILABLE", "Slot is not available");
  }
  slot.booking_state = "booked";
  slot.booked_by = req.user.sub;
  slot.booked_at = new Date();
  await slot.save();
  return sendSuccess(res, { slot_id: String(slot._id), booking_state: slot.booking_state }, "Booked");
}

async function cancelBooking(req, res) {
  const slot = await MentorSlot.findById(req.params.slotId);
  if (!slot) return sendError(res, 404, "SLOT_NOT_FOUND", "Slot not found");
  if (String(slot.booked_by) !== String(req.user.sub)) {
    return sendError(res, 403, "FORBIDDEN", "You did not book this slot");
  }
  slot.booking_state = "open";
  slot.booked_by = null;
  slot.booked_at = null;
  await slot.save();
  return sendSuccess(res, { slot_id: String(slot._id) }, "Cancelled");
}

async function mySessions(req, res) {
  const tab = String(req.query.tab || "upcoming");
  const nowMs = Date.now();
  const student = await Student.findById(req.user.sub).select("batch_id section_id").lean();
  const studentBatchId = String(student?.batch_id || "").trim().toLowerCase();
  const studentSectionId = String(student?.section_id || "").trim().toLowerCase();
  const batchSectionClauses = [];
  if (studentBatchId) {
    if (studentSectionId) {
      batchSectionClauses.push({
        $and: [
          { target_batch_ids: studentBatchId },
          {
            $or: [
              { target_section_ids: { $exists: false } },
              { target_section_ids: { $size: 0 } },
              { target_section_ids: studentSectionId },
            ],
          },
        ],
      });
    } else {
      batchSectionClauses.push({
        $and: [
          { target_batch_ids: studentBatchId },
          {
            $or: [{ target_section_ids: { $exists: false } }, { target_section_ids: { $size: 0 } }],
          },
        ],
      });
    }
  }
  const filter = {
    publish_date: { $lte: new Date() },
    $or: [{ target_student_ids: req.user.sub }, ...batchSectionClauses],
  };
  const slots = await MentorSlot.find(filter).sort({ date: 1 }).lean();
  const filtered = slots.filter((s) => {
    const startMs = getSessionStartMs(s);
    if (Number.isNaN(startMs)) return false;
    const durationMs = Math.max(1, Number(s.duration_minutes || 60)) * 60 * 1000;
    const endMs = startMs + durationMs;
    return tab === "past" ? nowMs > endMs : nowMs <= endMs;
  });
  const data = filtered.map((s) => ({
    session_id: String(s._id),
    subject: "Mentor Session",
    mentor_name: s.mentor_name,
    mentor_info: s.mentor_info || "",
    date: s.date,
    time: s.time,
    duration_minutes: Number(s.duration_minutes || 60),
    meet_link: s.meet_link,
  }));
  return sendSuccess(res, data);
}

async function joinSession(req, res) {
  const student = await Student.findById(req.user.sub).select("batch_id section_id").lean();
  const studentBatchId = String(student?.batch_id || "").trim().toLowerCase();
  const studentSectionId = String(student?.section_id || "").trim().toLowerCase();
  const slot = await MentorSlot.findById(req.params.sessionId).lean();
  if (!slot) return sendError(res, 404, "SESSION_NOT_FOUND", "Session not found");
  const isIndividual = Array.isArray(slot.target_student_ids) && slot.target_student_ids.some((id) => String(id) === String(req.user.sub));
  const batchMatch = Array.isArray(slot.target_batch_ids) && slot.target_batch_ids.includes(studentBatchId);
  const sectionList = Array.isArray(slot.target_section_ids) ? slot.target_section_ids : [];
  const sectionMatch = sectionList.length === 0 || (studentSectionId && sectionList.includes(studentSectionId));
  if (!(isIndividual || (batchMatch && sectionMatch))) return sendError(res, 403, "FORBIDDEN", "Session is not assigned to you");
  if (slot.publish_date && new Date(slot.publish_date).getTime() > Date.now()) {
    return sendError(res, 403, "FORBIDDEN", "Session is not published yet");
  }
  try {
    await MentorSessionJoin.create({
      slot_id: slot._id,
      student_id: req.user.sub,
      joined_at: new Date(),
      source: String(req.body?.source || "web"),
    });
  } catch (e) {
    if (e?.code === 11000) {
      return sendSuccess(res, { session_id: req.params.sessionId, already_joined: true });
    }
    throw e;
  }
  return sendSuccess(res, { session_id: req.params.sessionId, joined: true });
}

module.exports = { listSlots, book, cancelBooking, mySessions, joinSession };
