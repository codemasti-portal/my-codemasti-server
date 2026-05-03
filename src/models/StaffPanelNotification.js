const mongoose = require("mongoose");

const AUDIENCES = ["global", "role", "individual"];
const CATEGORIES = ["updates", "alerts", "assignments", "system"];
const SOURCES = ["manual", "event"];

const staffPanelNotificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    category: { type: String, enum: CATEGORIES, default: "updates", index: true },
    /** global = all staff; role = any staff whose role is in target_roles; individual = recipient_id only */
    audience: { type: String, enum: AUDIENCES, required: true, index: true },
    target_roles: { type: [String], default: [] },
    recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    source: { type: String, enum: SOURCES, default: "manual", index: true },
    event_type: { type: String, default: "", trim: true, maxlength: 80 },
    /** Optional key to prevent duplicate event notifications. */
    dedupe_key: { type: String, default: "", trim: true, maxlength: 160 },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

staffPanelNotificationSchema.index({ createdAt: -1 });
staffPanelNotificationSchema.index({ audience: 1, createdAt: -1 });
// Prevent duplicates when dedupe_key is set.
staffPanelNotificationSchema.index(
  { dedupe_key: 1 },
  { unique: true, sparse: true, partialFilterExpression: { dedupe_key: { $type: "string", $ne: "" } } }
);

module.exports = mongoose.model("StaffPanelNotification", staffPanelNotificationSchema);
module.exports.AUDIENCES = AUDIENCES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.SOURCES = SOURCES;
