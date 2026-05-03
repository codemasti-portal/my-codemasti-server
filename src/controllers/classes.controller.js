const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const LiveClass = require("../models/LiveClass");
const ClassJoinAudit = require("../models/ClassJoinAudit");
const Student = require("../models/Student");

function parseClassDateTime(date, hhmm) {
  const [hour, minute] = hhmm.split(":").map((v) => Number(v));
  // Interpret stored date + time in *local* time (not UTC).
  // Adding 'Z' forces UTC and shifts the computed "Live Now" window for IST users.
  const isoLocal = `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000`;
  const d = new Date(isoLocal);
  if (!Number.isNaN(d.getTime())) return d;
  // Fallback for non-ISO parsing environments.
  return new Date(`${date} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
}

function deriveStatus(now, startAt, endAt) {
  if (now >= startAt && now <= endAt) return "Live Now";
  const diffMs = startAt.getTime() - now.getTime();
  if (diffMs > 0 && diffMs <= 15 * 60 * 1000) return "Starting Soon";
  if (now < startAt) return "Upcoming";
  return "Completed";
}

function studentClassVisibilityFilter(student) {
  const bid = String(student?.batch_id || "").toLowerCase().trim();
  const sid = String(student?.section_id || student?.enrollment_section || "").toLowerCase().trim();

  const legacyOpen = {
    $and: [
      { $or: [{ batch_id: { $exists: false } }, { batch_id: "" }] },
      {
        $or: [{ target_batch_ids: { $exists: false } }, { target_batch_ids: { $size: 0 } }],
      },
      {
        $or: [{ target_section_refs: { $exists: false } }, { target_section_refs: { $size: 0 } }],
      },
    ],
  };

  const parts = [legacyOpen];
  if (bid) {
    // Legacy single batch target.
    parts.push({ batch_id: bid });
    // New batch-level multi-target.
    parts.push({ target_batch_ids: bid });
  }
  if (bid && sid) {
    // New section-level targeting.
    parts.push({
      target_section_refs: { $elemMatch: { batch_id: bid, section_id: sid } },
    });
  }
  return { $or: parts };
}

function classVisibleToStudent(liveClass, student) {
  const tb = liveClass.target_batch_ids || [];
  const ts = liveClass.target_section_refs || [];
  const legacyBatch = String(liveClass.batch_id || "").toLowerCase().trim();
  const bid = String(student?.batch_id || "").toLowerCase().trim();
  const sid = String(student?.section_id || student?.enrollment_section || "").toLowerCase().trim();

  // Open class (legacy/global): no explicit targeting fields.
  if (!legacyBatch && tb.length === 0 && (!ts || ts.length === 0)) return true;
  if (bid && legacyBatch && legacyBatch === bid) return true;
  if (bid && tb.some((x) => String(x).toLowerCase() === bid)) return true;
  if (bid && sid && ts.some((r) => String(r.batch_id).toLowerCase() === bid && String(r.section_id).toLowerCase() === sid)) {
    return true;
  }
  return false;
}

async function live(req, res) {
  const schema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    batch_id: z.string().optional(),
    section_id: z.string().optional(),
  });
  const query = schema.parse(req.query);

  const role = String(req.user?.role || "").toLowerCase();
  const isStaff = role === "admin" || role === "teacher";
  const filter = {};
  if (query.batch_id) filter.batch_id = query.batch_id;
  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = query.from;
    if (query.to) filter.date.$lte = query.to;
  }

  if (!isStaff) {
    const student = await Student.findById(req.user.sub).lean();
    if (!student) {
      return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
    }
    const vis = studentClassVisibilityFilter(student);
    const combined =
      Object.keys(filter).length > 0 ? { $and: [filter, vis] } : vis;
    const rows = await LiveClass.find(combined).sort({ date: 1, start_time: 1 }).lean();
    const now = new Date();

    const data = rows.map((row) => {
      const startAt = parseClassDateTime(row.date, row.start_time);
      const endAt = parseClassDateTime(row.date, row.end_time);
      return {
        id: String(row._id),
        subject: row.subject,
        topic: row.topic,
        instructor: row.instructor,
        date: row.date,
        start_time: row.start_time,
        end_time: row.end_time,
        meet_link: row.meet_link,
        recording_link: row.recording_link,
        status: deriveStatus(now, startAt, endAt),
      };
    });
    return sendSuccess(res, data);
  }

  // Staff can query all, or narrow by batch/section targeting.
  const staffFilter = { ...filter };
  if (query.section_id && query.batch_id) {
    staffFilter.$or = [
      { target_section_refs: { $elemMatch: { batch_id: query.batch_id, section_id: query.section_id } } },
      { batch_id: query.batch_id },
      { target_batch_ids: query.batch_id },
    ];
  } else if (query.batch_id) {
    staffFilter.$or = [{ batch_id: query.batch_id }, { target_batch_ids: query.batch_id }];
  }

  const rows = await LiveClass.find(staffFilter).sort({ date: 1, start_time: 1 }).lean();
  const now = new Date();

  const data = rows.map((row) => {
    const startAt = parseClassDateTime(row.date, row.start_time);
    const endAt = parseClassDateTime(row.date, row.end_time);
    return {
      id: String(row._id),
      subject: row.subject,
      topic: row.topic,
      instructor: row.instructor,
      date: row.date,
      start_time: row.start_time,
      end_time: row.end_time,
      meet_link: row.meet_link,
      recording_link: row.recording_link,
      status: deriveStatus(now, startAt, endAt),
    };
  });

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

  const student = await Student.findById(req.user.sub).lean();
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }

  const vis = studentClassVisibilityFilter(student);
  const filter = {
    ...vis,
    recording_link: { $exists: true, $ne: "" },
  };

  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = query.from;
    if (query.to) filter.date.$lte = query.to;
  }

  if (query.subject?.trim()) {
    filter.subject = { $regex: query.subject.trim(), $options: "i" };
  }
  if (query.instructor?.trim()) {
    filter.instructor = { $regex: query.instructor.trim(), $options: "i" };
  }

  if (query.q?.trim()) {
    const q = query.q.trim();
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { subject: { $regex: q, $options: "i" } },
          { topic: { $regex: q, $options: "i" } },
          { instructor: { $regex: q, $options: "i" } },
        ],
      },
    ];
  }

  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    LiveClass.find(filter)
      .sort({ date: -1, start_time: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    LiveClass.countDocuments(filter),
  ]);

  const data = rows.map((row) => ({
    id: String(row._id),
    subject: row.subject,
    topic: row.topic,
    instructor: row.instructor,
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    recording_link: row.recording_link,
  }));

  return sendSuccess(res, data, "", { page, limit, total });
}

async function join(req, res) {
  const classDoc = await LiveClass.findById(req.params.classId).lean();
  if (!classDoc) {
    return sendError(res, 404, "CLASS_NOT_FOUND", "Live class not found");
  }
  const student = await Student.findById(req.user.sub).lean();
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  if (!classVisibleToStudent(classDoc, student)) {
    return sendError(res, 403, "CLASS_FORBIDDEN", "This live class is not available for your batch or section");
  }

  const source = String(req.body?.source || "web");
  const ipAddress =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "";
  const userAgent = req.headers["user-agent"] || "";

  const audit = await ClassJoinAudit.create({
    class_id: classDoc._id,
    student_id: req.user.sub,
    joined_at: new Date(),
    source,
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  return sendSuccess(res, {
    join_id: String(audit._id),
    class_id: String(classDoc._id),
    student_id: String(req.user.sub),
    joined_at: audit.joined_at,
    source: audit.source,
  });
}

async function joins(req, res) {
  if (!["admin", "teacher"].includes(req.user?.role)) {
    return sendError(res, 403, "FORBIDDEN", "Only admin/teacher can view attendance");
  }

  const classDoc = await LiveClass.findById(req.params.classId).lean();
  if (!classDoc) {
    return sendError(res, 404, "CLASS_NOT_FOUND", "Live class not found");
  }

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    ClassJoinAudit.find({ class_id: req.params.classId })
      .sort({ joined_at: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: "student_id", select: "name email batch role" })
      .lean(),
    ClassJoinAudit.countDocuments({ class_id: req.params.classId }),
  ]);

  const data = rows.map((row) => ({
    join_id: String(row._id),
    class_id: String(row.class_id),
    joined_at: row.joined_at,
    source: row.source,
    ip_address: row.ip_address,
    student: row.student_id
      ? {
          id: String(row.student_id._id),
          name: row.student_id.name,
          email: row.student_id.email,
          batch: row.student_id.batch,
          role: row.student_id.role,
        }
      : null,
  }));

  return sendSuccess(res, data, "", { page, limit, total });
}

module.exports = { live, recordings, join, joins };
