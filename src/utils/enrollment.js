/**
 * Enrollment format: one letter + 6 digits (YY + SS + RR).
 * I260105 → Innovators, year 2026, section 01, roll 05
 * S260206 → Spark, year 2026, section 02, roll 06
 * B260702 → Builders, year 2026, section 07, roll 02
 */
const registry = require("./batch-catalog-registry");

// Legacy seed of the three original programs. The batch catalog (registry) is the authority for
// any batch beyond these and for newly created ones; this map stays as a zero-dependency fallback
// so the original three behave identically even before the registry has loaded from the DB.
const PREFIX_TO_BATCH = {
  I: "Innovators",
  S: "Spark",
  B: "Builders",
};

/** Resolve an enrollment letter to its batch display name (legacy seed first, then catalog). */
function batchNameForPrefix(prefix) {
  const p = String(prefix || "").trim().toUpperCase();
  return PREFIX_TO_BATCH[p] || registry.prefixToDisplayNameSync(p) || "";
}

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
  // Batch prefix = one OR MORE letters (e.g. I, SU, ADV) + exactly 6 digits (YY section roll).
  // Multi-letter prefixes lift the old single-letter (26-batch) ceiling; the 6 trailing digits parse
  // unambiguously regardless of prefix length.
  const m = /^([A-Z]+)(\d{6})$/.exec(value);
  if (!m) {
    throw new Error(
      "Invalid enrollment_number. Expected a batch prefix (letters) + 6 digits (YY section roll), e.g. I260105, SU260206, ADV260702"
    );
  }
  const prefix = m[1];
  const enrollment_batch_name = batchNameForPrefix(prefix);
  if (!enrollment_batch_name) {
    throw new Error(
      `Unknown enrollment batch prefix "${prefix}". Create a batch with this enrollment_prefix in the batch catalog first.`
    );
  }
  const digits = m[2];
  const year2 = Number(digits.slice(0, 2));
  const enrollment_year = 2000 + year2;
  const enrollment_section = digits.slice(2, 4);
  const enrollment_roll_no = digits.slice(4, 6);
  return {
    enrollment_number: value,
    enrollment_batch_prefix: prefix,
    enrollment_batch_name,
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
  // Prefer the catalog's canonical batch_id for this enrollment letter; fall back to the
  // lowercased display name (matches the legacy behavior for Spark/Builders/Innovators).
  const fromPrefix = registry.prefixToBatchIdSync(parsed.enrollment_batch_prefix);
  return {
    batch: name,
    batch_id: fromPrefix || name.toLowerCase(),
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
  const letter = CATALOG_BATCH_ID_TO_PREFIX[bid] || registry.batchIdToPrefixSync(bid);
  if (!letter) {
    return { batch_id: bid };
  }
  return {
    $or: [{ batch_id: bid }, { enrollment_number: new RegExp(`^${letter}\\d{6}$`, "i") }],
  };
}

/** Program batch key(s) for loading timetable/notifications consistently (document batch_id ∪ enrollment-derived catalog id). */
function catalogBatchIdsFromStudentLean(student) {
  // Read-switch: when a resolved membership set has been attached (non-legacy mode only),
  // return it verbatim. Nothing attaches this in legacy mode, so this is a perfect no-op there.
  if (student && Array.isArray(student.__membershipBatchIds)) return student.__membershipBatchIds;
  const ids = new Set();
  const bid = String(student?.batch_id || "").trim().toLowerCase();
  if (bid) ids.add(bid);
  try {
    if (student?.enrollment_number) {
      const p = parseEnrollmentNumber(student.enrollment_number);
      ids.add(String(deriveStudentBatchFromEnrollment(p).batch_id || "").trim().toLowerCase());
    }
  } catch {
    /* invalid / partial enrollment_number */
  }
  return [...ids].filter(Boolean);
}

/**
 * Mongo $or branch conditions for membership in one catalog program (spark / builders / innovators).
 * Enrollment letter wins when enrollment_number matches I|S|B + 6 digits, so a stale `batch_id`
 * alone cannot place a Spark student in Builders notifications (and vice versa).
 * Students with no enrollment_number still match on `batch_id` only (legacy rows).
 */
function catalogBatchMembershipOrConditions(batchKey) {
  const bid = String(batchKey || "").trim().toLowerCase();
  if (!bid) return [];
  const letter = CATALOG_BATCH_ID_TO_PREFIX[bid] || registry.batchIdToPrefixSync(bid);
  if (!letter) {
    return [{ batch_id: bid }];
  }
  return [
    { enrollment_number: new RegExp(`^${letter}\\d{6}$`, "i") },
    {
      $and: [
        {
          $or: [{ enrollment_number: { $exists: false } }, { enrollment_number: null }, { enrollment_number: "" }],
        },
        { batch_id: bid },
      ],
    },
  ];
}

/**
 * Filter for Student.find: role student, in any of the given catalog batches, optional section(s).
 */
function studentsInCatalogBatchesFilter(batchKeys, { sectionId = "", sectionIds } = {}) {
  const keys = [...new Set((batchKeys || []).map((k) => String(k || "").trim().toLowerCase()).filter(Boolean))];
  if (!keys.length) {
    return { _id: null };
  }
  const orConds = keys.flatMap((k) => catalogBatchMembershipOrConditions(k));
  const filter = { role: "student", $or: orConds };

  const sidSingle = String(sectionId || "").trim().toLowerCase();
  const sidMany = Array.isArray(sectionIds)
    ? sectionIds.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const normalizedSections = sidMany.length ? [...new Set(sidMany)] : sidSingle ? [sidSingle] : [];
  if (normalizedSections.length === 1) {
    filter.section_id = normalizedSections[0];
  } else if (normalizedSections.length > 1) {
    filter.section_id = { $in: normalizedSections };
  }
  return filter;
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

/** Same rules as optional section filter on `GET /admin/batches/:batch_id/students`. */
function catalogBatchStudentFilter(batchId, rawSection) {
  const batch_id = String(batchId || "").trim().toLowerCase();
  const membership = catalogBatchMongoMatch(batch_id);
  if (rawSection === undefined || String(rawSection).trim() === "") {
    return { role: "student", ...membership };
  }
  const sid = String(rawSection ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  let sectionPart;
  if (sid === "__unassigned__") {
    sectionPart = { $or: [{ section_id: "" }, { section_id: { $exists: false } }] };
  } else {
    sectionPart = {
      $or: [
        { section_id: sid },
        {
          $and: [
            {
              $or: [{ section_id: "" }, { section_id: { $exists: false } }, { section_id: null }],
            },
            { enrollment_section: sid },
          ],
        },
      ],
    };
  }
  return { role: "student", $and: [membership, sectionPart] };
}

module.exports = {
  parseEnrollmentNumber,
  PREFIX_TO_BATCH,
  deriveStudentBatchFromEnrollment,
  catalogBatchMongoMatch,
  catalogBatchMembershipOrConditions,
  studentsInCatalogBatchesFilter,
  catalogBatchStudentFilter,
  catalogBatchIdsFromStudentLean,
  augmentStudentCatalogFieldsFromEnrollment,
  applyEnrollmentDerivedFieldsToStudentDocument,
};
