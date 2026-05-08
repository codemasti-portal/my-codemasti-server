require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Student = require("../models/Student");
const Announcement = require("../models/Announcement");
const Note = require("../models/Note");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const TimetableSlot = require("../models/TimetableSlot");
const TimetableEvent = require("../models/TimetableEvent");
const LiveClass = require("../models/LiveClass");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ClassJoinAudit = require("../models/ClassJoinAudit");
const ArenaQuestion = require("../models/ArenaQuestion");
const MentorSlot = require("../models/MentorSlot");
const CommunityMessage = require("../models/CommunityMessage");
const Notification = require("../models/Notification");
const BatchCatalog = require("../models/BatchCatalog");
const { DEFAULT_BATCHES, DEFAULT_SECTIONS_BY_BATCH } = require("../constants/batchDefaults");
const { parseEnrollmentNumber } = require("../utils/enrollment");

const BATCH_LABEL = "Weekend Batch Alpha";
const BATCH_ID = "batch_alpha";

async function seed() {
  await connectDb();

  // Default admin for testing the admin panel + OTP auth.
  await Student.updateOne(
    { email: "admin@codemasti.com" },
    {
      $set: {
        name: "Admin",
        role: "admin",
        batch: "",
        batch_id: "",
        course: "",
        parent_name: "",
        phone_number: "",
        batch_allowance: "",
        progress: 0,
      },
    },
    { upsert: true }
  );

  // Arjun (registered demo student) — I260105 = Innovators, 2026, section 01, roll 05
  const arjunEnrollment = "I260105";
  const arjunParsed = parseEnrollmentNumber(arjunEnrollment);
  await Student.updateOne(
    { email: "arjun.kumar@codemasti.com" },
    {
      $set: {
        name: "Arjun Kumar",
        role: "student",
        batch: BATCH_LABEL,
        batch_id: BATCH_ID,
        section_id: arjunParsed.enrollment_section,
        course: "Full Stack Development",
        progress: 42,
        parent_name: "Ravi Kumar",
        phone_number: "9876543210",
        enrollment_number: arjunParsed.enrollment_number,
        enrollment_batch_prefix: arjunParsed.enrollment_batch_prefix,
        enrollment_batch_name: arjunParsed.enrollment_batch_name,
        enrollment_year: arjunParsed.enrollment_year,
        enrollment_section: arjunParsed.enrollment_section,
        enrollment_roll_no: arjunParsed.enrollment_roll_no,
        batch_allowance: arjunParsed.enrollment_batch_name,
      },
    },
    { upsert: true }
  );
  let student = await Student.findOne({ email: "arjun.kumar@codemasti.com" });

  // Priya (registered demo student) — S260106 = Spark, 2026, section 01, roll 06
  const priyaEnrollment = "S260106";
  const priyaParsed = parseEnrollmentNumber(priyaEnrollment);
  await Student.updateOne(
    { email: "priya.sharma@codemasti.com" },
    {
      $set: {
        name: "Priya Sharma",
        role: "student",
        batch: BATCH_LABEL,
        batch_id: BATCH_ID,
        section_id: priyaParsed.enrollment_section,
        course: "Full Stack Development",
        progress: 67,
        parent_name: "Suresh Sharma",
        phone_number: "9123456780",
        enrollment_number: priyaParsed.enrollment_number,
        enrollment_batch_prefix: priyaParsed.enrollment_batch_prefix,
        enrollment_batch_name: priyaParsed.enrollment_batch_name,
        enrollment_year: priyaParsed.enrollment_year,
        enrollment_section: priyaParsed.enrollment_section,
        enrollment_roll_no: priyaParsed.enrollment_roll_no,
        batch_allowance: priyaParsed.enrollment_batch_name,
      },
    },
    { upsert: true }
  );
  let student2 = await Student.findOne({ email: "priya.sharma@codemasti.com" });

  await Announcement.updateOne(
    { title: "Hackathon Registration Open" },
    {
      $set: {
        description: "Join the upcoming CodeMasti nationwide hackathon.",
        scope: "global",
        date: new Date("2026-03-10T10:00:00Z"),
      },
    },
    { upsert: true }
  );

  await Announcement.updateOne(
    { title: "Batch Alpha: Weekly standup" },
    {
      $set: {
        description: "Friday 6 PM — share blockers and wins with your mentor.",
        scope: "batch",
        batch: BATCH_LABEL,
        date: new Date("2026-04-01T09:00:00Z"),
      },
    },
    { upsert: true }
  );

  await Announcement.updateOne(
    { title: "Library maintenance window" },
    {
      $set: {
        description: "Video notes may be briefly unavailable on Sunday 2–3 AM IST.",
        scope: "global",
        date: new Date("2026-04-05T14:00:00Z"),
      },
    },
    { upsert: true }
  );

  await Note.updateOne(
    { subject: "DSA", module: "Arrays", topic: "Sliding Window" },
    {
      $set: {
        summary: "Key techniques for array-based interview problems.",
        sections: [
          { title: "Two Pointers", points: ["Move pointers based on condition", "Avoid nested loops"] },
          { title: "Window", points: ["Track current sum", "Shrink and expand efficiently"] },
        ],
        size: "1.2MB",
        file_url: "https://example.com/files/notes/dsa-arrays-sliding-window.pdf",
        updated_date: new Date(),
      },
    },
    { upsert: true }
  );

  await Note.updateOne(
    { subject: "Web Development", module: "React", topic: "Hooks cheat sheet" },
    {
      $set: {
        summary: "useState, useEffect, and custom hooks patterns used in class projects.",
        sections: [
          { title: "useState", points: ["Functional updates", "Lazy initial state"] },
          { title: "useEffect", points: ["Dependency array", "Cleanup on unmount"] },
        ],
        size: "890KB",
        file_url: "https://example.com/files/notes/react-hooks.pdf",
        updated_date: new Date("2026-03-28T12:00:00Z"),
      },
    },
    { upsert: true }
  );

  await Note.updateOne(
    { subject: "System Design", module: "Fundamentals", topic: "Load balancing" },
    {
      $set: {
        summary: "High-level patterns for scaling services and routing traffic.",
        sections: [
          { title: "Layers", points: ["DNS", "L4 vs L7", "Health checks"] },
        ],
        size: "640KB",
        file_url: "https://example.com/files/notes/sd-load-balancing.pdf",
        updated_date: new Date("2026-03-15T08:30:00Z"),
      },
    },
    { upsert: true }
  );

  let assignment = await Assignment.findOne({ subject: "DSA", module: "Recursion" });
  if (!assignment) {
    assignment = await Assignment.create({
      subject: "DSA",
      module: "Recursion",
      release_date: new Date("2026-04-01T00:00:00Z"),
      deadline_date: new Date("2026-04-07T23:59:59Z"),
    });
  }

  await AssignmentQuestion.updateOne(
    { assignment_id: assignment._id, name: "Factorial" },
    {
      $set: {
        title: "Factorial",
        description: "Compute factorial of n.",
        difficulty: "easy",
        xp: 20,
        topics: ["recursion"],
        requirements: ["Use recursion"],
        input_format: "integer n",
        output_format: "integer factorial(n)",
        constraints: ["0 <= n <= 20"],
        examples: [{ input: "5", output: "120" }],
        time_limit: "1s",
        memory_limit: "128MB",
        starter_code: {
          python: "def solve(n):\n    pass",
          javascript: "function solve(n) {\n  \n}",
        },
        hidden_tests: [{ input: "10", output: "3628800" }],
      },
    },
    { upsert: true }
  );

  await AssignmentQuestion.updateOne(
    { assignment_id: assignment._id, name: "Fibonacci" },
    {
      $set: {
        title: "Fibonacci number",
        description: "Return the n-th Fibonacci number (0-indexed: F(0)=0, F(1)=1).",
        difficulty: "medium",
        xp: 35,
        topics: ["recursion", "dynamic programming"],
        requirements: ["Handle n up to 35"],
        input_format: "integer n",
        output_format: "integer F(n)",
        constraints: ["0 <= n <= 35"],
        examples: [{ input: "7", output: "13" }],
        time_limit: "1s",
        memory_limit: "128MB",
        starter_code: {
          python: "def solve(n):\n    pass",
          javascript: "function solve(n) {\n  \n}",
        },
        hidden_tests: [{ input: "10", output: "55" }],
      },
    },
    { upsert: true }
  );

  let assignmentWeb = await Assignment.findOne({ subject: "Web Development", module: "React Hooks" });
  if (!assignmentWeb) {
    assignmentWeb = await Assignment.create({
      subject: "Web Development",
      module: "React Hooks",
      release_date: new Date("2026-04-02T00:00:00Z"),
      deadline_date: new Date("2026-04-10T23:59:59Z"),
    });
  }

  await AssignmentQuestion.updateOne(
    { assignment_id: assignmentWeb._id, name: "Toggle theme" },
    {
      $set: {
        title: "Build a minimal theme toggle",
        description: "Implement light/dark state with useState and persist choice in localStorage.",
        difficulty: "easy",
        xp: 25,
        topics: ["react", "hooks"],
        requirements: ["Use useState", "Read/write localStorage"],
        input_format: "N/A (UI task)",
        output_format: "Working component",
        constraints: ["No external UI libraries"],
        examples: [
          { input: "toggle", output: "theme switches and persists on reload" },
        ],
        time_limit: "1s",
        memory_limit: "128MB",
        starter_code: {
          javascript: "function ThemeToggle() {\n  return null;\n}",
        },
        hidden_tests: [],
      },
    },
    { upsert: true }
  );

  const factorialQ = await AssignmentQuestion.findOne({
    assignment_id: assignment._id,
    name: "Factorial",
  }).lean();
  if (factorialQ) {
    await AssignmentSubmission.updateOne(
      {
        assignment_id: assignment._id,
        question_id: factorialQ._id,
        student_id: student._id,
      },
      {
        $set: {
          language: "python",
          code: "def solve(n):\n    return 1 if n <= 1 else n * solve(n-1)",
          status: "Accepted",
          test_cases_passed: "10/10",
          execution_time_ms: 12,
          memory_mb: 8,
          submitted_at: new Date("2026-04-02T08:00:00Z"),
        },
      },
      { upsert: true }
    );
  }

  const fibQ = await AssignmentQuestion.findOne({
    assignment_id: assignment._id,
    name: "Fibonacci",
  }).lean();
  if (fibQ) {
    await AssignmentSubmission.updateOne(
      {
        assignment_id: assignment._id,
        question_id: fibQ._id,
        student_id: student2._id,
      },
      {
        $set: {
          language: "python",
          code: "def solve(n):\n    return n",
          status: "Wrong Answer",
          test_cases_passed: "2/10",
          execution_time_ms: 5,
          memory_mb: 8,
          submitted_at: new Date("2026-04-02T09:15:00Z"),
        },
      },
      { upsert: true }
    );
  }

  await TimetableSlot.updateOne(
    {
      batch_id: BATCH_ID,
      day: "Monday",
      time: "09:00 AM - 10:30 AM",
      subject: "DSA",
      teacher: "Rahul Sharma",
    },
    {
      $set: {
        batch_id: BATCH_ID,
        day: "Monday",
        time: "09:00 AM - 10:30 AM",
        subject: "DSA",
        teacher: "Rahul Sharma",
      },
    },
    { upsert: true }
  );

  await TimetableSlot.updateOne(
    {
      batch_id: BATCH_ID,
      day: "Wednesday",
      time: "07:00 PM - 08:30 PM",
      subject: "Web Development",
      teacher: "Neha Gupta",
    },
    {
      $set: {
        batch_id: BATCH_ID,
        day: "Wednesday",
        time: "07:00 PM - 08:30 PM",
        subject: "Web Development",
        teacher: "Neha Gupta",
      },
    },
    { upsert: true }
  );

  await TimetableEvent.updateOne(
    { title: "April Mentorship Workshop", date: new Date("2026-04-14T10:00:00Z") },
    {
      $set: {
        type: "workshop",
        description: "Special problem-solving workshop with mentors.",
        batch_id: BATCH_ID,
      },
    },
    { upsert: true }
  );

  const now = new Date();
  const nowDate = now.toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  const toHHmm = (dateObj) => `${pad(dateObj.getUTCHours())}:${pad(dateObj.getUTCMinutes())}`;
  const minus20 = new Date(now.getTime() - 20 * 60 * 1000);
  const plus20 = new Date(now.getTime() + 20 * 60 * 1000);
  const plus8 = new Date(now.getTime() + 8 * 60 * 1000);
  const plus68 = new Date(now.getTime() + 68 * 60 * 1000);

  await LiveClass.updateOne(
    { batch_id: BATCH_ID, topic: "Dynamic Programming Intro", date: nowDate },
    {
      $set: {
        subject: "DSA",
        topic: "Dynamic Programming Intro",
        instructor: "Rahul Sharma",
        batch_id: BATCH_ID,
        target_batch_ids: [BATCH_ID],
        target_section_refs: [],
        date: nowDate,
        start_time: toHHmm(minus20),
        end_time: toHHmm(plus20),
        meet_link: "https://meet.example.com/live-dp",
        recording_link: "",
      },
    },
    { upsert: true }
  );

  await LiveClass.updateOne(
    { batch_id: BATCH_ID, topic: "System Design Basics", date: nowDate },
    {
      $set: {
        subject: "System Design",
        topic: "System Design Basics",
        instructor: "Neha Gupta",
        batch_id: BATCH_ID,
        target_batch_ids: [],
        target_section_refs: [{ batch_id: BATCH_ID, section_id: "01" }],
        date: nowDate,
        start_time: toHHmm(plus8),
        end_time: toHHmm(plus68),
        meet_link: "https://meet.example.com/system-design",
        recording_link: "",
      },
    },
    { upsert: true }
  );

  await LiveClass.updateOne(
    { batch_id: BATCH_ID, topic: "React Advanced Patterns", date: "2026-04-30" },
    {
      $set: {
        subject: "Web Development",
        topic: "React Advanced Patterns",
        instructor: "Amit Verma",
        batch_id: BATCH_ID,
        target_batch_ids: [BATCH_ID],
        target_section_refs: [],
        date: "2026-04-30",
        start_time: "18:00",
        end_time: "19:30",
        meet_link: "https://meet.example.com/react-advanced",
        recording_link: "",
      },
    },
    { upsert: true }
  );

  await LiveClass.updateOne(
    { batch_id: BATCH_ID, topic: "Git & CI/CD Revision", date: "2026-03-20" },
    {
      $set: {
        subject: "DevOps",
        topic: "Git & CI/CD Revision",
        instructor: "Priya Nair",
        batch_id: BATCH_ID,
        target_batch_ids: [BATCH_ID],
        target_section_refs: [],
        date: "2026-03-20",
        start_time: "17:00",
        end_time: "18:30",
        meet_link: "https://meet.example.com/devops-revision",
        recording_link: "https://videos.example.com/devops-revision",
      },
    },
    { upsert: true }
  );

  const dpClass = await LiveClass.findOne({
    batch_id: BATCH_ID,
    topic: "Dynamic Programming Intro",
    date: nowDate,
  });
  if (dpClass) {
    const existingJoin = await ClassJoinAudit.findOne({
      class_id: dpClass._id,
      student_id: student._id,
    });
    if (!existingJoin) {
      await ClassJoinAudit.create({
        class_id: dpClass._id,
        student_id: student._id,
        joined_at: new Date("2026-04-02T07:45:00Z"),
        source: "web",
        ip_address: "127.0.0.1",
        user_agent: "seed-script",
      });
    }
  }

  await TimetableEvent.updateOne(
    { title: "Institute Holiday", date: new Date("2026-04-21T00:00:00Z") },
    {
      $set: {
        type: "holiday",
        description: "No classes due to scheduled holiday.",
        batch_id: "",
      },
    },
    { upsert: true }
  );

  await ArenaQuestion.updateOne(
    { title: "Two Sum" },
    {
      $set: {
        number: 1,
        title: "Two Sum",
        subject: "DSA",
        topic: "Arrays",
        difficulty: "easy",
        description: "Return indices of two numbers that add up to the target.",
        requirements: ["Exactly one valid answer exists"],
        input_format: "array nums, integer target",
        output_format: "array of two indices",
        constraints: ["2 <= nums.length <= 1e4"],
        examples: [{ input: "[2,7,11,15], 9", output: "[0,1]" }],
        time_limit: "1s",
        memory_limit: "128MB",
        starter_code: {
          python: "def solve(nums, target):\n    pass",
          javascript: "function solve(nums, target) {\n}",
        },
        hidden_tests: [{ input: "[[3,2,4],6]", output: "[1,2]" }],
        xp: 20,
        acceptance_rate: 68,
      },
    },
    { upsert: true }
  );

  await MentorSlot.updateOne(
    { subject: "DSA", mentor_name: "Sample Mentor Seed", time: "10:00 AM IST" },
    {
      $set: {
        subject: "DSA",
        mentor_name: "Sample Mentor Seed",
        date: new Date("2026-04-15T10:00:00.000Z"),
        time: "10:00 AM IST",
        meet_link: "https://meet.example.com/mentor-slot",
        booking_state: "open",
        booked_by: null,
        booked_at: null,
      },
    },
    { upsert: true }
  );

  await CommunityMessage.updateOne(
    { channel_id: "general", text: "Welcome to the community channel!" },
    {
      $set: {
        channel_id: "general",
        student_id: student._id,
        author_name: student.name,
        text: "Welcome to the community channel!",
        likes: [],
      },
    },
    { upsert: true }
  );

  await Notification.updateOne(
    { student_id: student._id, title: "New announcement" },
    {
      $set: {
        student_id: student._id,
        type: "announcement",
        title: "New announcement",
        body: "Check the announcements tab for institute updates.",
        read_at: null,
        ref_id: "",
      },
    },
    { upsert: true }
  );

  for (const b of DEFAULT_BATCHES) {
    await BatchCatalog.updateOne(
      { batch_id: b.batch_id },
      { $setOnInsert: { name: b.name, order: b.order, sections: [] } },
      { upsert: true }
    );
  }
  for (const [batch_id, sections] of Object.entries(DEFAULT_SECTIONS_BY_BATCH)) {
    await BatchCatalog.updateOne(
      { batch_id, $or: [{ sections: { $exists: false } }, { sections: { $size: 0 } }] },
      { $set: { sections } }
    );
  }

  // Seed assignment bundles for all batches so each batch has coding/written/quiz coverage.
  for (const batch of DEFAULT_BATCHES) {
    const batchId = String(batch.batch_id || "").trim().toLowerCase();
    const batchName = String(batch.name || batchId);

    const codingAssignment = await Assignment.findOneAndUpdate(
      { subject: "DSA", module: `Arrays Drill (${batchName})`, batch_id: batchId },
      {
        $set: {
          assignment_type: "coding",
          subject: "DSA",
          module: `Arrays Drill (${batchName})`,
          batch_id: batchId,
          release_date: new Date("2026-04-10T00:00:00Z"),
          deadline_date: new Date("2026-04-20T23:59:59Z"),
        },
      },
      { upsert: true, new: true }
    );
    await AssignmentQuestion.updateOne(
      { assignment_id: codingAssignment._id, name: "array-sum" },
      {
        $set: {
          title: "Sum of Array",
          description: "Given n integers, return the sum of all elements.",
          difficulty: "easy",
          xp: 20,
          topics: ["arrays", "loops"],
          requirements: ["Read all values", "Return exact sum"],
          input_format: "First line n, second line has n space-separated integers.",
          output_format: "Single integer sum.",
          constraints: ["1 <= n <= 100000", "-10^9 <= a[i] <= 10^9"],
          examples: [{ input: "5\n1 2 3 4 5", output: "15", explanation: "1+2+3+4+5=15" }],
          time_limit: "1s",
          memory_limit: "128MB",
          starter_code: {
            python: "def solve(nums):\n    return 0\n",
            javascript: "function solve(nums) {\n  return 0;\n}\n",
            java: "class Solution { static long solve(int[] nums){ return 0L; } }",
            cpp: "long long solve(const vector<int>& nums){ return 0; }",
          },
          hidden_tests: [
            { input: "3\n10 20 30", expected_output: "60" },
            { input: "4\n-1 2 -3 4", expected_output: "2" },
          ],
        },
      },
      { upsert: true }
    );

    const writtenAssignment = await Assignment.findOneAndUpdate(
      { subject: "System Design", module: `HTTP Basics Reflection (${batchName})`, batch_id: batchId },
      {
        $set: {
          assignment_type: "written",
          subject: "System Design",
          module: `HTTP Basics Reflection (${batchName})`,
          batch_id: batchId,
          release_date: new Date("2026-04-11T00:00:00Z"),
          deadline_date: new Date("2026-04-22T23:59:59Z"),
        },
      },
      { upsert: true, new: true }
    );
    await AssignmentQuestion.updateOne(
      { assignment_id: writtenAssignment._id, name: "http-idempotency" },
      {
        $set: {
          title: "Explain idempotency in HTTP",
          description:
            "Write a concise explanation of idempotency in HTTP methods. Include at least one practical API example.",
          difficulty: "easy",
          xp: 15,
          topics: ["http", "api-design"],
          requirements: ["Define idempotency", "Compare at least two HTTP methods", "Give one real example"],
          input_format: "Free text response (150-300 words).",
          output_format: "Clear structured explanation.",
          constraints: [],
          examples: [],
          time_limit: "",
          memory_limit: "",
          starter_code: {},
          hidden_tests: [],
        },
      },
      { upsert: true }
    );

    const quizAssignment = await Assignment.findOneAndUpdate(
      { subject: "Web Development", module: `JavaScript Quick Quiz (${batchName})`, batch_id: batchId },
      {
        $set: {
          assignment_type: "quiz",
          subject: "Web Development",
          module: `JavaScript Quick Quiz (${batchName})`,
          batch_id: batchId,
          release_date: new Date("2026-04-12T00:00:00Z"),
          deadline_date: new Date("2026-04-18T23:59:59Z"),
        },
      },
      { upsert: true, new: true }
    );
    await AssignmentQuestion.updateOne(
      { assignment_id: quizAssignment._id, name: "js-let-scope" },
      {
        $set: {
          title: "What is the scope of let?",
          description: "Select the correct option.",
          difficulty: "easy",
          xp: 10,
          topics: ["javascript"],
          requirements: [],
          input_format: "",
          output_format: "",
          constraints: [],
          examples: [],
          time_limit: "",
          memory_limit: "",
          starter_code: {},
          hidden_tests: [],
          question_image_url: "",
          quiz_options: [
            { text: "Function scoped", image_url: "", is_correct: false },
            { text: "Block scoped", image_url: "", is_correct: true },
            { text: "Global only", image_url: "", is_correct: false },
            { text: "Class scoped", image_url: "", is_correct: false },
          ],
        },
      },
      { upsert: true }
    );
  }

  console.log("Seed complete");
  console.log(`Arjun (primary JWT sub): ${student._id}`);
  console.log(`Priya (second user): ${student2._id}`);
  await mongoose.connection.close();
}

seed().catch(async (error) => {
  console.error("Seed failed:", error);
  await mongoose.connection.close();
  process.exit(1);
});
