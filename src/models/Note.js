const mongoose = require("mongoose");

const noteSectionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    points: [{ type: String, trim: true }],
  },
  { _id: false }
);

const sectionRefSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, trim: true },
    section_id: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const noteSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, index: true },
    module: { type: String, required: true, trim: true, index: true },
    topic: { type: String, default: "", trim: true, index: true },
    summary: { type: String, default: "" },
    sections: [noteSectionSchema],
    size: { type: String, default: "" },
    file_url: { type: String, required: true, trim: true },
    updated_date: { type: Date, default: Date.now, index: true },
    /** Which catalog batches this note applies to (multi). */
    target_batch_ids: { type: [String], default: [] },
    /** Which batch+section pairs (multi); from BatchCatalog. */
    target_section_refs: { type: [sectionRefSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Note", noteSchema);
