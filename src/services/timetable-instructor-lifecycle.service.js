const mongoose = require("mongoose");
const Staff = require("../models/Staff");
const { parseGoogleMeetUrl } = require("../utils/google-meet-url");
const { minutesUntilClassStart, parseSlotStart } = require("../utils/timetable-slot-start");
const {
  notifyInstructorsForSlot,
  resolveInstructorRecipientsByName,
  buildClassAssignedEmail,
  buildClassRescheduledEmail,
  buildClassUnassignedEmail,
  buildMeetLinkUpdatedEmail,
  fmtWhenLocal,
} = require("./instructor-notifications.service");

/** Classes starting within this window skip the separate 60-minute cron reminder. */
const INSTRUCTOR_60M_SUPPRESS_WITHIN_MINUTES = 60;

const INSTRUCTOR_TIMETABLE_ACTION = "/dashboard/instructor/timetable?focus=today";

function instructorIdentityChanged(prevStaffId, prevTeacher, nextStaffId, nextTeacher) {
  const prevId = String(prevStaffId || "").trim();
  const nextId = String(nextStaffId || "").trim();
  if (prevId && nextId) return prevId !== nextId;
  if (prevId !== nextId) return true;
  return (
    String(prevTeacher || "").trim().toLowerCase() !== String(nextTeacher || "").trim().toLowerCase()
  );
}

function canonicalMeetLink(value) {
  return parseGoogleMeetUrl(value) || String(value || "").trim();
}

function meetLinkChanged(prevLink, nextLink) {
  const prev = canonicalMeetLink(prevLink);
  const next = canonicalMeetLink(nextLink);
  return Boolean(next) && prev !== next;
}

function shouldSuppressInstructor60mReminder(slot, at = new Date()) {
  const mins = minutesUntilClassStart(slot, at);
  if (mins === null) return false;
  return mins <= INSTRUCTOR_60M_SUPPRESS_WITHIN_MINUTES;
}

function is60mReminderSuppressedForCurrentSchedule(slot) {
  const rev = Number(slot.schedule_revision) || 1;
  const suppressed = slot.instructor_reminder_60m_suppressed_schedule_revision;
  return suppressed != null && Number(suppressed) === rev;
}

function apply60mSuppressionForCurrentSchedule(doc) {
  const rev = Number(doc.schedule_revision) || 1;
  const slotLike = {
    class_date: doc.class_date,
    time: doc.time,
    schedule_revision: rev,
  };
  if (shouldSuppressInstructor60mReminder(slotLike)) {
    doc.instructor_reminder_60m_suppressed_schedule_revision = rev;
  } else {
    doc.instructor_reminder_60m_suppressed_schedule_revision = null;
  }
}

function resetInstructorReminderMarkers(doc) {
  doc.instructor_reminder_10m_sent_at = null;
  doc.instructor_reminder_60m_sent_at = null;
  doc.instructor_reminder_60m_meet_link = "";
}

function resetAllScheduleReminderMarkers(doc) {
  doc.student_reminder_10m_sent_at = null;
  resetInstructorReminderMarkers(doc);
  doc.meet_link_missing_10m_alert_sent_at = null;
  doc.class_live_sent_at = null;
}

function initLifecycleFieldsOnCreate(doc) {
  doc.schedule_revision = 1;
  doc.instructor_assignment_revision = 1;
  doc.meet_link_revision = 1;
  apply60mSuppressionForCurrentSchedule(doc);
}

async function notifySpecificInstructorStaff({
  staffId,
  slot,
  event_type,
  title,
  message,
  action_url,
  emailBuilder,
  dedupe_key,
}) {
  const id = String(staffId || "").trim();
  if (!id || !mongoose.isValidObjectId(id)) return { notified: 0, emailed: 0 };

  const row = await Staff.findOne({ _id: id }).select("_id name email role").lean();
  if (!row) return { notified: 0, emailed: 0 };

  const { emitEventNotification } = require("./staffPanelNotification.service");
  const { sendSimpleEmail } = require("./brevo");

  const dedupeKey =
    dedupe_key ||
    `${String(event_type || "event").trim()}:${String(slot?._id || "").trim()}:${String(row._id)}`;

  await emitEventNotification({
    audience: "individual",
    recipient_id: String(row._id),
    title,
    message,
    category: "alerts",
    event_type,
    action_url: action_url || "",
    dedupe_key: dedupeKey,
  });

  let emailed = 0;
  const toEmail = String(row.email || "").trim();
  if (emailBuilder && toEmail) {
    try {
      const mail = emailBuilder({ staff: row, slot });
      await sendSimpleEmail({ toEmail, ...mail });
      emailed = 1;
    } catch (e) {
      console.error("[INSTRUCTOR_LIFECYCLE_EMAIL_FAILED]", event_type, e?.message || e);
    }
  }

  return { notified: 1, emailed };
}

function slotSummaryLine(slot) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const batch = slot.batch_id || "N/A";
  const section = slot.section_id ? `, Section: ${slot.section_id}` : "";
  return `${slot.subject || "Class"} (${whenText}). Batch: ${batch}${section}`;
}

async function notifyClassAssigned(slot, assignmentRevision) {
  const rev = Number(assignmentRevision) || 1;
  const meet = String(slot.meet_link || "").trim();
  const staffKey = String(slot.staff_id || slot.teacher || "").trim();
  try {
    await notifyInstructorsForSlot({
      slot,
      event_type: "timetable_class_assigned",
      title: "Class assigned to you",
      message: `You have been assigned to teach ${slotSummaryLine(slot)}${meet ? `. Meet: ${meet}` : ""}`,
      action_url: INSTRUCTOR_TIMETABLE_ACTION,
      dedupe_key: `timetable_class_assigned:${String(slot._id)}:${staffKey}:${rev}`,
      emailBuilder: ({ staff }) => buildClassAssignedEmail({ staffName: staff?.name, slot }),
    });
  } catch (e) {
    console.error("[TIMETABLE_CLASS_ASSIGNED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function notifyClassUnassigned(prevSlot, prevStaffId, assignmentRevision) {
  const rev = Number(assignmentRevision) || 1;
  let targetStaffId = String(prevStaffId || "").trim();
  if (!targetStaffId && prevSlot.teacher) {
    const matches = await resolveInstructorRecipientsByName(prevSlot.teacher);
    if (matches.length === 1) targetStaffId = String(matches[0]._id);
  }
  const staffKey = targetStaffId || String(prevSlot.teacher || "").trim();
  if (!staffKey) return;
  const whenText = fmtWhenLocal(prevSlot.class_date, prevSlot.time);
  try {
    await notifySpecificInstructorStaff({
      staffId: targetStaffId,
      slot: prevSlot,
      event_type: "timetable_class_unassigned",
      title: "Class unassigned",
      message: `You are no longer assigned to teach ${prevSlot.subject || "Class"} (${whenText}).`,
      action_url: INSTRUCTOR_TIMETABLE_ACTION,
      dedupe_key: `timetable_class_unassigned:${String(prevSlot._id)}:${staffKey}:${rev}`,
      emailBuilder: ({ staff }) => buildClassUnassignedEmail({ staffName: staff?.name, slot: prevSlot }),
    });
  } catch (e) {
    console.error("[TIMETABLE_CLASS_UNASSIGNED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function notifyClassRescheduled(slot, scheduleRevision, previousSchedule) {
  const rev = Number(scheduleRevision) || 1;
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const oldWhen =
    previousSchedule?.class_date && previousSchedule?.time
      ? fmtWhenLocal(previousSchedule.class_date, previousSchedule.time)
      : "";
  try {
    await notifyInstructorsForSlot({
      slot,
      event_type: "timetable_class_rescheduled",
      title: "Class rescheduled",
      message: oldWhen
        ? `${slot.subject || "Class"} moved from ${oldWhen} to ${whenText}.`
        : `${slot.subject || "Class"} rescheduled to ${whenText}.`,
      action_url: INSTRUCTOR_TIMETABLE_ACTION,
      dedupe_key: `timetable_class_rescheduled:${String(slot._id)}:${rev}`,
      emailBuilder: ({ staff }) =>
        buildClassRescheduledEmail({
          staffName: staff?.name,
          slot,
          previousSchedule,
        }),
    });
  } catch (e) {
    console.error("[TIMETABLE_CLASS_RESCHEDULED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function notifyMeetLinkUpdated(slot, meetLinkRevision) {
  const rev = Number(meetLinkRevision) || 1;
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const meet = String(slot.meet_link || "").trim();
  const startsAt = parseSlotStart(slot.class_date, slot.time);
  if (!startsAt || startsAt.getTime() <= Date.now()) return;

  try {
    await notifyInstructorsForSlot({
      slot,
      event_type: "timetable_meet_link_updated",
      title: "Meet link updated",
      message: `The Meet link for ${slot.subject} (${whenText}) was updated. New link: ${meet}`,
      action_url: INSTRUCTOR_TIMETABLE_ACTION,
      dedupe_key: `timetable_meet_link_updated:${String(slot._id)}:${rev}`,
      emailBuilder: ({ staff }) => buildMeetLinkUpdatedEmail({ staffName: staff?.name, slot }),
    });
  } catch (e) {
    console.error("[TIMETABLE_MEET_LINK_UPDATED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function handleInstructorLifecycleAfterCreate(slot) {
  if (!slot) return;
  const hasInstructor = Boolean(String(slot.staff_id || "").trim() || String(slot.teacher || "").trim());
  if (!hasInstructor) return;
  await notifyClassAssigned(slot, slot.instructor_assignment_revision || 1);
}

/**
 * @param {object} params
 * @param {object} params.slot - saved slot document (plain object or mongoose doc)
 * @param {boolean} params.scheduleChanged
 * @param {boolean} params.instructorChanged
 * @param {boolean} params.meetLinkChanged
 * @param {object} [params.previousSchedule] - { class_date, time }
 * @param {object} [params.previousInstructor] - { staff_id, teacher }
 */
async function handleInstructorLifecycleAfterUpdate({
  slot,
  scheduleChanged,
  instructorChanged,
  meetLinkChanged: meetChanged,
  previousSchedule,
  previousInstructor,
}) {
  const slotObj = slot?.toObject ? slot.toObject() : slot;
  if (!slotObj?._id) return;

  if (instructorChanged) {
    const assignmentRev = Number(slotObj.instructor_assignment_revision) || 1;
    const prevSlot = {
      ...slotObj,
      class_date: previousSchedule?.class_date ?? slotObj.class_date,
      time: previousSchedule?.time ?? slotObj.time,
      staff_id: previousInstructor?.staff_id ?? null,
      teacher: previousInstructor?.teacher ?? "",
    };
    if (previousInstructor?.staff_id || previousInstructor?.teacher) {
      await notifyClassUnassigned(prevSlot, previousInstructor.staff_id, assignmentRev);
    }
    await notifyClassAssigned(slotObj, assignmentRev);
    return;
  }

  if (scheduleChanged) {
    await notifyClassRescheduled(slotObj, slotObj.schedule_revision, previousSchedule);
  }

  if (meetChanged && !scheduleChanged) {
    await notifyMeetLinkUpdated(slotObj, slotObj.meet_link_revision);
  }
}

module.exports = {
  INSTRUCTOR_60M_SUPPRESS_WITHIN_MINUTES,
  INSTRUCTOR_TIMETABLE_ACTION,
  instructorIdentityChanged,
  meetLinkChanged,
  shouldSuppressInstructor60mReminder,
  is60mReminderSuppressedForCurrentSchedule,
  apply60mSuppressionForCurrentSchedule,
  resetInstructorReminderMarkers,
  resetAllScheduleReminderMarkers,
  initLifecycleFieldsOnCreate,
  handleInstructorLifecycleAfterCreate,
  handleInstructorLifecycleAfterUpdate,
  notifyMeetLinkUpdated,
};
