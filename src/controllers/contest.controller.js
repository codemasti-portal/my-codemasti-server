const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const Contest = require("../models/Contest");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { scopeStudentToBatch } = require("../utils/student-batch-context");
const {
  listContestsForStudent,
  pickDashboardContestCard,
  toStudentContestRow,
  loadTestsMap,
  isContestVisibleToStudent,
} = require("../services/contest.service");

async function loadStudent(req) {
  const raw = await Student.findById(req.user.sub).lean();
  if (!raw) return null;
  const student = augmentStudentCatalogFieldsFromEnrollment(raw);
  await scopeStudentToBatch(req, student);
  return student;
}

async function listMyContests(req, res) {
  const student = await loadStudent(req);
  if (!student) return sendError(res, 401, "UNAUTHORIZED", "Student not found");

  const rows = await listContestsForStudent(student, { now: new Date() });
  return sendSuccess(res, rows);
}

async function getMyContest(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid contest id");
  }
  const student = await loadStudent(req);
  if (!student) return sendError(res, 401, "UNAUTHORIZED", "Student not found");

  const row = await Contest.findById(req.params.id).lean();
  if (!row) return sendError(res, 404, "NOT_FOUND", "Contest not found");
  if (!isContestVisibleToStudent(student, row, new Date())) {
    return sendError(res, 404, "NOT_FOUND", "Contest not found");
  }

  const tests = await loadTestsMap([row.test_id]);
  return sendSuccess(res, toStudentContestRow(row, tests.get(String(row.test_id)), new Date()));
}

module.exports = { listMyContests, getMyContest, pickDashboardContestCard, loadStudent };
