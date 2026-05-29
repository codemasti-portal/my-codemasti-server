const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const courses = require("../../controllers/student-courses.controller");
const payments = require("../../controllers/student-payments.controller");

const router = express.Router();

router.get("/courses", requireAuth, courses.listMyCourses);
router.get("/courses/:enrollmentId", requireAuth, courses.getMyCourseDetail);

router.post("/payments/initiate", requireAuth, payments.initiatePayment);
router.get("/payments/status/:merchantTxnId", requireAuth, payments.getPaymentStatus);

module.exports = router;
