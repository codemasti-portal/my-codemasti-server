const mongoose = require("mongoose");

/** Per-staff read / dismiss state for a panel notification (broadcasts share one notification doc). */
const staffPanelNotificationStateSchema = new mongoose.Schema(
  {
    notification_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StaffPanelNotification",
      required: true,
      index: true,
    },
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true, index: true },
    read_at: { type: Date, default: null },
    dismissed_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

staffPanelNotificationStateSchema.index({ notification_id: 1, staff_id: 1 }, { unique: true });

module.exports = mongoose.model("StaffPanelNotificationState", staffPanelNotificationStateSchema);
