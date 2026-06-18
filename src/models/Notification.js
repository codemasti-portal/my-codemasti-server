const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    type: {
      type: String,
      enum: [
        "announcement",
        "system",
        "class_start_10m",
        "class_live",
        "recording_uploaded",
        "notes_uploaded",
      ],
      default: "system",
      index: true,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: "" },
    /** Portal-relative path to navigate to when the notification is tapped. */
    deep_link: { type: String, default: "", trim: true },
    /** Optional direct join/action URL (e.g. Google Meet link for class_live / class_start_10m). */
    meet_url: { type: String, default: "", trim: true },
    read_at: { type: Date, default: null, index: true },
    ref_id: { type: String, default: "" },

    /**
     * Used to avoid duplicate sends in schedulers / multi-instance deployments.
     * Example: "class10m:<slotId>:<studentId>".
     */
    dedupe_key: { type: String, default: "", trim: true },

    /** Email delivery audit (optional). */
    email_to: { type: String, default: "", trim: true },
    email_sent_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// Prevent duplicates when dedupe_key is set.
notificationSchema.index(
  { dedupe_key: 1 },
  { unique: true, sparse: true, partialFilterExpression: { dedupe_key: { $type: "string", $ne: "" } } }
);

module.exports = mongoose.model("Notification", notificationSchema);
