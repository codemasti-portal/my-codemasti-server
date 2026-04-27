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

const quizOptionSchema = new mongoose.Schema(
  {
    text: { type: String, default: "", trim: true },
    image_url: { type: String, default: "", trim: true },
    is_correct: { type: Boolean, default: false },
  },
  { _id: false }
);

const assignmentQuestionSchema = new mongoose.Schema(
  {
    assignment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "easy", index: true },
    xp: { type: Number, default: 10 },
    topics: [{ type: String, trim: true, index: true }],
    requirements: [{ type: String }],
    input_format: { type: String, default: "" },
    output_format: { type: String, default: "" },
    constraints: [{ type: String }],
    examples: [{ type: mongoose.Schema.Types.Mixed }],
    time_limit: { type: String, default: "1s" },
    memory_limit: { type: String, default: "128MB" },
    execution_mode: { type: String, enum: ["full_program", "function_only"], default: "full_program" },
    starter_code: { type: starterCodeSchema, default: () => ({}) },
    hidden_tests: [{ type: mongoose.Schema.Types.Mixed }],
    question_image_url: { type: String, default: "", trim: true },
    quiz_options: { type: [quizOptionSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("AssignmentQuestion", assignmentQuestionSchema);
