const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const { paymentProofUpload } = require("../../middlewares/upload.middleware");
const courses = require("../../controllers/student-courses.controller");
const payments = require("../../controllers/student-payments.controller");

const router = express.Router();

router.get("/courses", requireAuth, courses.listMyCourses);
router.get("/courses/:enrollmentId", requireAuth, courses.getMyCourseDetail);

router.get("/payments/config", requireAuth, payments.getPaymentConfig);
router.post("/payments/initiate", requireAuth, payments.initiatePayment);
router.get("/payments/status/:merchantTxnId", requireAuth, payments.getPaymentStatus);
router.post("/payments/manual", requireAuth, paymentProofUpload, payments.submitManualPayment);

module.exports = router;
