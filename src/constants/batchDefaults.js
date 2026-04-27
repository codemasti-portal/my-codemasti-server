/**
 * Fixed batches (Spark, Builders, Innovators).
 * Sections are not auto-seeded: they follow enrollment IDs (digits 3–4 = section, e.g. S260105 → section 01)
 * or are added in admin. No placeholder “core” section.
 */
const DEFAULT_BATCHES = [
  { batch_id: "spark", name: "Spark", order: 0 },
  { batch_id: "builders", name: "Builders", order: 1 },
  { batch_id: "innovators", name: "Innovators", order: 2 },
];

/** Empty defaults — catalog sections are created in admin or implied from student enrollment_section. */
const DEFAULT_SECTIONS_BY_BATCH = {
  spark: [],
  builders: [],
  innovators: [],
};

module.exports = { DEFAULT_BATCHES, DEFAULT_SECTIONS_BY_BATCH };
