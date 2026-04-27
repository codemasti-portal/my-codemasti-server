/**
 * Enrollment format: one letter + 6 digits (YY + SS + RR).
 * I260105 → Innovators, year 2026, section 01, roll 05
 * S260206 → Spark, year 2026, section 02, roll 06
 * B260702 → Builders, year 2026, section 07, roll 02
 */
const PREFIX_TO_BATCH = {
  I: "Innovators",
  S: "Spark",
  B: "Builders",
};

/**
 * @param {string} raw
 * @returns {{
 *   enrollment_number: string,
 *   enrollment_batch_prefix: string,
 *   enrollment_batch_name: string,
 *   enrollment_year: number,
 *   enrollment_section: string,
 *   enrollment_roll_no: string,
 * }}
 */
function parseEnrollmentNumber(raw) {
  const value = String(raw).trim().toUpperCase();
  if (!/^[ISB]\d{6}$/.test(value)) {
    throw new Error(
      "Invalid enrollment_number. Expected I|S|B + 6 digits (YY section roll), e.g. I260105, S260206, B260702"
    );
  }
  const prefix = value[0];
  const digits = value.slice(1);
  const year2 = Number(digits.slice(0, 2));
  const enrollment_year = 2000 + year2;
  const enrollment_section = digits.slice(2, 4);
  const enrollment_roll_no = digits.slice(4, 6);
  return {
    enrollment_number: value,
    enrollment_batch_prefix: prefix,
    enrollment_batch_name: PREFIX_TO_BATCH[prefix],
    enrollment_year,
    enrollment_section,
    enrollment_roll_no,
  };
}

/**
 * Display label + catalog batch_id (lowercase) from parsed enrollment.
 * Matches BatchCatalog ids: spark, builders, innovators.
 */
function deriveStudentBatchFromEnrollment(parsed) {
  const name = parsed.enrollment_batch_name || "";
  return {
    batch: name,
    batch_id: name.toLowerCase(),
  };
}

/** Catalog batch_id → first letter of valid enrollment numbers (I|S|B + 6 digits). */
const CATALOG_BATCH_ID_TO_PREFIX = {
  spark: "S",
  builders: "B",
  innovators: "I",
};

/**
 * Mongo filter: student belongs to this catalog program if batch_id matches OR enrollment_number
 * starts with the batch letter (fixes stale/wrong batch_id on the document).
 */
function catalogBatchMongoMatch(batchId) {
  const bid = String(batchId || "").trim().toLowerCase();
  const letter = CATALOG_BATCH_ID_TO_PREFIX[bid];
  if (!letter) {
    return { batch_id: bid };
  }
  return {
    $or: [{ batch_id: bid }, { enrollment_number: new RegExp(`^${letter}\\d{6}$`, "i") }],
  };
}

/**
 * Overlay batch, batch_id, and enrollment-derived fields from enrollment_number when parseable.
 */
function augmentStudentCatalogFieldsFromEnrollment(lean) {
  const o =
    lean && typeof lean.toObject === "function"
      ? lean.toObject()
      : lean
        ? { ...lean }
        : {};
  const raw = o.enrollment_number;
  if (!raw) return o;
  try {
    const p = parseEnrollmentNumber(raw);
    const { batch, batch_id } = deriveStudentBatchFromEnrollment(p);
    o.batch = batch;
    o.batch_id = batch_id;
    o.enrollment_batch_prefix = p.enrollment_batch_prefix;
    o.enrollment_batch_name = p.enrollment_batch_name;
    o.enrollment_year = p.enrollment_year;
    o.enrollment_section = p.enrollment_section;
    o.enrollment_roll_no = p.enrollment_roll_no;
    return o;
  } catch {
    return o;
  }
}

/** Persist: set catalog + enrollment fields on a Mongoose doc from its enrollment_number. */
function applyEnrollmentDerivedFieldsToStudentDocument(doc) {
  if (!doc || !doc.enrollment_number) return;
  try {
    const p = parseEnrollmentNumber(String(doc.enrollment_number));
    const { batch, batch_id } = deriveStudentBatchFromEnrollment(p);
    doc.batch = batch;
    doc.batch_id = batch_id;
    doc.enrollment_batch_prefix = p.enrollment_batch_prefix;
    doc.enrollment_batch_name = p.enrollment_batch_name;
    doc.enrollment_year = p.enrollment_year;
    doc.enrollment_section = p.enrollment_section;
    doc.enrollment_roll_no = p.enrollment_roll_no;
  } catch {
    /* leave as-is */
  }
}

module.exports = {
  parseEnrollmentNumber,
  PREFIX_TO_BATCH,
  deriveStudentBatchFromEnrollment,
  catalogBatchMongoMatch,
  augmentStudentCatalogFieldsFromEnrollment,
  applyEnrollmentDerivedFieldsToStudentDocument,
};
