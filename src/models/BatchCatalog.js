const mongoose = require("mongoose");

const sectionSchema = new mongoose.Schema(
  {
    section_id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    subjects: { type: [String], default: [] },
  },
  { _id: false }
);

const batchCatalogSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    sections: { type: [sectionSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("BatchCatalog", batchCatalogSchema);
