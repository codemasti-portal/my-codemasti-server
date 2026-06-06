/**
 * Fixed batches (Spark, Builders, Innovators).
 * Sections are not auto-seeded: they follow enrollment IDs (digits 3–4 = section, e.g. S260105 → section 01)
 * or are added in admin. No placeholder “core” section.
 */
const DEFAULT_BATCHES = [
  { batch_id: "spark", name: "Spark", order: 0, enrollment_prefix: "S", tier_label: "Beginner", is_protected: true, include_in_default_views: true },
  { batch_id: "builders", name: "Builders", order: 1, enrollment_prefix: "B", tier_label: "Intermediate", is_protected: true, include_in_default_views: true },
  { batch_id: "innovators", name: "Innovators", order: 2, enrollment_prefix: "I", tier_label: "Advanced", is_protected: true, include_in_default_views: true },
];

/** Empty defaults — catalog sections are created in admin or implied from student enrollment_section. */
const DEFAULT_SECTIONS_BY_BATCH = {
  spark: [],
  builders: [],
  innovators: [],
};

module.exports = { DEFAULT_BATCHES, DEFAULT_SECTIONS_BY_BATCH };
