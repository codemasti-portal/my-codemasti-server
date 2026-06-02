const express = require("express");
const { requireStaffAuth, requireStaffRoles } = require("../../middlewares/staff.middleware");
const { ROLES } = require("../../utils/rbac");
const courses = require("../../controllers/admin-courses.controller");
const enrollments = require("../../controllers/admin-enrollments.controller");
const invoices = require("../../controllers/admin-invoices.controller");
const payments = require("../../controllers/admin-payments.controller");
const manualPayments = require("../../controllers/admin-manual-payments.controller");

const router = express.Router();

// Billing is super-admin only. Regular admins (academic operations) don't have visibility into
// money flows — that's reserved for the founder / accounting owner.
const adminOnly = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN])];

// Courses
router.get("/courses", ...adminOnly, courses.listCourses);
router.get("/courses/:id", ...adminOnly, courses.getCourse);
router.post("/courses", ...adminOnly, courses.createCourse);
router.patch("/courses/:id", ...adminOnly, courses.updateCourse);
router.delete("/courses/:id", ...adminOnly, courses.deleteCourse);

// Enrollments
router.get("/enrollments", ...adminOnly, enrollments.listEnrollments);
router.get("/enrollments/reconcile", ...adminOnly, enrollments.reconcileEnrollments);
router.post("/enrollments/reconcile", ...adminOnly, enrollments.reconcileEnrollments);
router.get("/enrollments/:id", ...adminOnly, enrollments.getEnrollment);
router.post("/enrollments", ...adminOnly, enrollments.createEnrollment);
router.patch("/enrollments/:id", ...adminOnly, enrollments.updateEnrollment);
router.delete("/enrollments/:id", ...adminOnly, enrollments.deleteEnrollment);
router.post("/enrollments/:id/transition", ...adminOnly, enrollments.transitionEnrollment);

// Invoices
router.get("/invoices", ...adminOnly, invoices.listInvoices);
router.get("/invoices/:id", ...adminOnly, invoices.getInvoice);
router.post("/invoices", ...adminOnly, invoices.createInvoice);
router.post("/invoices/bulk-generate", ...adminOnly, invoices.bulkGenerateForCourse);
router.patch("/invoices/:id", ...adminOnly, invoices.patchInvoice);
router.delete("/invoices/:id", ...adminOnly, invoices.deleteInvoice);

// Payments
router.get("/payments", ...adminOnly, payments.listPayments);
router.get("/payments/reconciliation", ...adminOnly, payments.reconciliation);
router.post("/payments/:id/refund", ...adminOnly, payments.refundPayment);
router.get("/refunds", ...adminOnly, payments.listRefunds);

// Manual UPI payment proofs (review queue)
router.get("/manual-payments", ...adminOnly, manualPayments.listManualPayments);
router.patch("/manual-payments/:id", ...adminOnly, manualPayments.patchManualPaymentNote);
router.post("/manual-payments/:id/approve", ...adminOnly, manualPayments.approveManualPayment);
router.post("/manual-payments/:id/reject", ...adminOnly, manualPayments.rejectManualPayment);

module.exports = router;
