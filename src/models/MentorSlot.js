const mongoose = require("mongoose");

const mentorSlotSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    mentor_name: { type: String, required: true, trim: true },
    /**
     * Optional stable reference to the Staff document for this mentor. When set, notification
     * recipient resolution uses this id exclusively (no name-based fan-out). Older/legacy slots
     * without staff_id keep resolving recipients via exact `mentor_name` matching against active
     * Staff (mentor/instructor) — see mentor-notification.service.js:resolveMentorRecipients.
     */
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    mentor_info: { type: String, default: "", trim: true },
    date: { type: Date, required: true, index: true },
    publish_date: { type: Date, default: Date.now, index: true },
    time: { type: String, required: true },
    duration_minutes: { type: Number, default: 60, min: 1 },
    meet_link: { type: String, default: "" },
    /** Legacy combined mentor+student ~15m marker (student 15m still uses this). */
    reminder_15m_sent_at: { type: Date, default: null, index: true },
    /** Mentor-only ~60m reminder marker (replaces mentor leg of reminder_15m_sent_at). */
    reminder_60m_sent_at: { type: Date, default: null, index: true },
    meet_link_missing_alert_15m_sent_at: { type: Date, default: null, index: true },
    /**
     * When equal to schedule_revision, the 60m mentor cron reminder is skipped for the current
     * schedule (late publish / late reschedule / late reassignment).
     */
    mentor_reminder_60m_suppressed_schedule_revision: { type: Number, default: null },
    schedule_revision: { type: Number, default: 1 },
    mentor_assignment_revision: { type: Number, default: 1 },
    meet_link_revision: { type: Number, default: 1 },
    /** Set when students were notified that this slot is published (create/update fan-out or publish sweep). */
    publish_notified_at: { type: Date, default: null, index: true },
    target_batch_ids: [{ type: String, trim: true, lowercase: true }],
    target_section_ids: [{ type: String, trim: true, lowercase: true }],
    target_student_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
    booking_state: { type: String, enum: ["open", "booked", "cancelled"], default: "open", index: true },
    booked_by: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
    booked_at: { type: Date, default: null },

    /** schedule_revision value for which post-session mentor tasks were delivered. */
    post_session_tasks_sent_schedule_revision: { type: Number, default: null },
    post_session_tasks_sent_at: { type: Date, default: null },
    /** schedule_revision for which a destination-configuration admin alert was sent. */
    post_session_destination_alerted_schedule_revision: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("MentorSlot", mentorSlotSchema);
