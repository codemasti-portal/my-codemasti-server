const mongoose = require("mongoose");

const timetableSlotSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, trim: true, index: true },
    /** Empty = applies to all sections in the batch; otherwise catalog section_id (e.g. core). */
    section_id: { type: String, default: "", trim: true, index: true },
    day: {
      type: String,
      required: true,
      enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      index: true,
    },
    /** Exact class date (YYYY-MM-DD). */
    class_date: { type: String, required: true, trim: true, index: true },
    time: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true, index: true },
    topic: { type: String, default: "", trim: true },
    teacher: { type: String, required: true, trim: true },
    /** Optional reference to the Staff document. When set, instructor notifications use ID-based lookup (more reliable than name matching). */
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    meet_link: { type: String, default: "", trim: true },
    recording_link: { type: String, default: "", trim: true },
    notes_link: { type: String, default: "", trim: true },
    is_taken: { type: Boolean, default: false, index: true },

    /** One-time “class starts in ~10 minutes” reminders (prevent duplicate emails on each poll tick). */
    student_reminder_10m_sent_at: { type: Date, default: null },
    instructor_reminder_10m_sent_at: { type: Date, default: null },

    /** One-time "class starts in ~1 hour" reminder email to the instructor. */
    instructor_reminder_60m_sent_at: { type: Date, default: null },
    /** Meet link value at the moment the 1-hour instructor email was sent (to detect later changes). */
    instructor_reminder_60m_meet_link: { type: String, default: "", trim: true },
    /**
     * When equal to schedule_revision, the 60m cron reminder is skipped for the current schedule
     * incarnation (late create / late reschedule / late reassignment). Cleared when the new start
     * is more than 60 minutes away.
     */
    instructor_reminder_60m_suppressed_schedule_revision: { type: Number, default: null },
    /** Increments when class_date or time changes — powers reschedule dedupe and reminder reset. */
    schedule_revision: { type: Number, default: 1 },
    /** Increments when instructor identity changes — powers assign/unassign dedupe. */
    instructor_assignment_revision: { type: Number, default: 1 },
    /** Increments when the canonical Meet URL changes — powers meet-update dedupe. */
    meet_link_revision: { type: Number, default: 1 },

    /** One-time "class is now live" notification sent at the scheduled start time. */
    class_live_sent_at: { type: Date, default: null },

    /** One-time alert when meet_link is missing near start time. */
    meet_link_missing_10m_alert_sent_at: { type: Date, default: null },

    /** schedule_revision value for which post-class instructor tasks were delivered. */
    post_class_tasks_sent_schedule_revision: { type: Number, default: null },
    post_class_tasks_sent_at: { type: Date, default: null },
    /** schedule_revision for which a destination-configuration admin alert was sent. */
    post_class_destination_alerted_schedule_revision: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("TimetableSlot", timetableSlotSchema);
