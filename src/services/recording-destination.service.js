const BatchCatalog = require("../models/BatchCatalog");

/**
 * @typedef {'ok' | 'missing' | 'ambiguous' | 'invalid_slot' | 'batch_not_found'} RecordingDestinationStatus
 */

/**
 * @param {object} batchLean
 * @returns {Promise<object>}
 */
async function resolveSingleBatchDestination(batchId) {
  const bid = String(batchId || "").trim().toLowerCase();
  if (!bid) {
    return {
      status: "invalid_slot",
      batch_id: null,
      batch_ids: [],
      batch_name: null,
      drive_folder_url: null,
    };
  }

  const batch = await BatchCatalog.findOne({ batch_id: bid })
    .select("batch_id name recording_drive_folder_url")
    .lean();

  if (!batch) {
    return {
      status: "batch_not_found",
      batch_id: bid,
      batch_ids: [bid],
      batch_name: null,
      drive_folder_url: null,
    };
  }

  const driveFolderUrl = String(batch.recording_drive_folder_url || "").trim();
  if (!driveFolderUrl) {
    return {
      status: "missing",
      batch_id: bid,
      batch_ids: [bid],
      batch_name: batch.name || null,
      drive_folder_url: null,
    };
  }

  return {
    status: "ok",
    batch_id: bid,
    batch_ids: [bid],
    batch_name: batch.name || null,
    drive_folder_url: driveFolderUrl,
  };
}

/**
 * Resolve the recording upload destination for a timetable or mentor slot.
 * Prefer passing an already-loaded slot object (no extra slot DB lookup).
 *
 * @param {{ kind: 'timetable' | 'mentor', slot: object }} input
 */
async function resolveRecordingDestination({ kind, slot }) {
  if (!slot || typeof slot !== "object") {
    return {
      status: "invalid_slot",
      batch_id: null,
      batch_ids: [],
      batch_name: null,
      drive_folder_url: null,
      destinations: [],
    };
  }

  if (kind === "timetable") {
    const batchId = String(slot.batch_id || "").trim().toLowerCase();
    if (!batchId) {
      return {
        status: "invalid_slot",
        batch_id: null,
        batch_ids: [],
        batch_name: null,
        drive_folder_url: null,
        destinations: [],
      };
    }

    const resolved = await resolveSingleBatchDestination(batchId);
    return {
      ...resolved,
      destinations: [
        {
          batch_id: batchId,
          batch_name: resolved.batch_name,
          status: resolved.status === "ok" ? "ok" : resolved.status === "missing" ? "missing" : resolved.status,
          drive_folder_url: resolved.drive_folder_url,
        },
      ],
    };
  }

  if (kind === "mentor") {
    const batchIds = [
      ...new Set(
        (Array.isArray(slot.target_batch_ids) ? slot.target_batch_ids : [])
          .map((id) => String(id || "").trim().toLowerCase())
          .filter(Boolean)
      ),
    ];

    if (batchIds.length === 0) {
      return {
        status: "invalid_slot",
        batch_id: null,
        batch_ids: [],
        batch_name: null,
        drive_folder_url: null,
        destinations: [],
      };
    }

    const resolvedList = await Promise.all(batchIds.map((bid) => resolveSingleBatchDestination(bid)));
    const destinations = resolvedList.map((r) => ({
      batch_id: r.batch_id,
      batch_name: r.batch_name,
      status: r.status === "ok" ? "ok" : r.status === "missing" ? "missing" : r.status,
      drive_folder_url: r.drive_folder_url,
    }));

    if (batchIds.length === 1) {
      const single = resolvedList[0];
      return {
        status: single.status,
        batch_id: single.batch_id,
        batch_ids: batchIds,
        batch_name: single.batch_name,
        drive_folder_url: single.drive_folder_url,
        destinations,
      };
    }

    return {
      status: "ambiguous",
      batch_id: null,
      batch_ids: batchIds,
      batch_name: null,
      drive_folder_url: null,
      destinations,
    };
  }

  return {
    status: "invalid_slot",
    batch_id: null,
    batch_ids: [],
    batch_name: null,
    drive_folder_url: null,
    destinations: [],
  };
}

module.exports = {
  resolveRecordingDestination,
  resolveSingleBatchDestination,
};
