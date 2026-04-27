const mongoose = require("mongoose");

const starterCodeSchema = new mongoose.Schema(
  {
    python: { type: String, default: "" },
    javascript: { type: String, default: "" },
    java: { type: String, default: "" },
    cpp: { type: String, default: "" },
  },
  { _id: false }
);

const arenaQuestionSchema = new mongoose.Schema(
  {
    batch_id: { type: String, default: "", trim: true, lowercase: true, index: true },
    number: { type: Number, default: 1, index: true },
    title: { type: String, required: true, trim: true },
    subject: { type: String, default: "DSA", trim: true, index: true },
    topic: { type: String, default: "", trim: true, index: true },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "easy", index: true },
    description: { type: String, required: true },
    requirements: [{ type: String }],
    input_format: { type: String, default: "" },
    output_format: { type: String, default: "" },
    constraints: [{ type: String }],
    examples: [{ type: mongoose.Schema.Types.Mixed }],
    time_limit: { type: String, default: "1s" },
    memory_limit: { type: String, default: "128MB" },
    starter_code: { type: starterCodeSchema, default: () => ({}) },
    hidden_tests: [{ type: mongoose.Schema.Types.Mixed }],
    xp: { type: Number, default: 20 },
    acceptance_rate: { type: Number, default: 50 },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("ArenaQuestion", arenaQuestionSchema);
