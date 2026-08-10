/**
 * ============================================================
 * ERP DATA REPAIR / RECOMPUTE UTILITIES
 * Phase 1 transaction model
 *
 * PURPOSE
 *   Manual recovery utilities only. These functions are NOT
 *   part of normal transaction processing.
 *
 *   They rebuild derived / aggregate figures from the current
 *   transaction tables when figures have become inconsistent
 *   because of manual edits, partial writes, or data corruption.
 *
 * IMPORTANT
 *   Run in dependency order when doing a full Phase 1 repair:
 *
 *     1. ERP_RecomputeSalesDetailsBatch
 *     2. ERP_RecomputeSalesOrdersBatch
 *     3. ERP_RecomputeInventoryBatch
 *     4. ERP_RecomputeCustomersBatch
 *
 * Each function accepts a zero-based startIndex and batchSize.
 * This avoids one large write when the workbook grows.
 *
 * Example:
 *   ERP_RecomputeSalesDetailsBatch(0, 250)
 *   ERP_RecomputeSalesDetailsBatch(250, 250)
 *   ...
 *
 * The functions are intentionally NOT called automatically by
 * Sales, Inventory, or any other transaction workflow.
 * ============================================================
 */

const DATA_REPAIR_DEFAULT_BATCH_SIZE = 250;


function ERP_RecomputeSalesDetailsBatch(startIndex, batchSize) {
  startIndex = _repairNormalizeStartIndex_(startIndex);
  batchSize = _repairNormalizeBatchSize_(batchSize);

  const lock = _repairAcquireLock_();

  try {
    const details = Repository_getRows("SalesDetails");

    const endIndex = Math.min(startIndex + batchSize, details.length);
    const batch = details.slice(startIndex, endIndex);

    const updated = batch.map(row => {
      const ordered = Number(row["QTY Ordered"]) || 0;
      const delivered = Number(row["QTY Delivered"]) || 0;

      row["QTY Balance"] = Math.max(0, ordered - delivered);
      return row;
    });

    _repairWriteRowsByPrimaryKey_("SalesDetails", updated);

    return _repairBatchResult_(
      "SalesDetails",
      startIndex,
      batchSize,
      details.length,
      updated.length
    );

  } finally {
    lock.releaseLock();
  }
}


function ERP_RecomputeSalesOrdersBatch(startIndex, batchSize) {
  startIndex = _repairNormalizeStartIndex_(startIndex);
  batchSize = _repairNormalizeBatchSize_(batchSize);

  const lock = _repairAcquireLock_();

  try {
    const orders = Repository_getRows("SalesOrders");
    const details = Repository_getRows("SalesDetails");

    const totalsBySO = {};
    const qtyBySO = {};

    details.forEach(row => {
      const soID = String(row["SO ID"] || "").trim();
      if (!soID) return;

      const amount = Number(row["Total Sales Price"]) || 0;
      totalsBySO[soID] = (totalsBySO[soID] || 0) + amount;

      const ordered = Number(row["QTY Ordered"]) || 0;
      const delivered = Number(row["QTY Delivered"]) || 0;

      if (!qtyBySO[soID]) {
        qtyBySO[soID] = {
          ordered: 0,
          delivered: 0
        };
      }

      qtyBySO[soID].ordered += ordered;
      qtyBySO[soID].delivered += delivered;
    });

    const endIndex = Math.min(startIndex + batchSize, orders.length);
    const batch = orders.slice(startIndex, endIndex);

    const updated = batch.map(row => {
      const soID = String(row["SO ID"] || "").trim();
      const totals = qtyBySO[soID] || { ordered: 0, delivered: 0 };

      row["Total SO Amount"] = totalsBySO[soID] || 0;
      row["SO Status"] = _repairCalculateSOStatus_(
        totals.ordered,
        totals.delivered
      );

      // Legacy fields are deliberately not reconstructed.
      // The Phase 1 model no longer uses them.
      return row;
    });

    _repairWriteRowsByPrimaryKey_("SalesOrders", updated);

    return _repairBatchResult_(
      "SalesOrders",
      startIndex,
      batchSize,
      orders.length,
      updated.length
    );

  } finally {
    lock.releaseLock();
  }
}


function ERP_RecomputeInventoryBatch(startIndex, batchSize) {
  startIndex = _repairNormalizeStartIndex_(startIndex);
  batchSize = _repairNormalizeBatchSize_(batchSize);

  const lock = _repairAcquireLock_();

  try {
    const inventory = Repository_getRows("Inventory");
    const details = Repository_getRows("SalesDetails");

    const allocationByItem = {};
    const deliveredByItem = {};

    details.forEach(row => {
      const itemID = String(row["Item ID"] || "").trim();
      if (!itemID) return;

      const ordered = Number(row["QTY Ordered"]) || 0;
      const delivered = Number(row["QTY Delivered"]) || 0;
      const outstanding = Math.max(0, ordered - delivered);

      allocationByItem[itemID] =
        (allocationByItem[itemID] || 0) + outstanding;

      deliveredByItem[itemID] =
        (deliveredByItem[itemID] || 0) + delivered;
    });

    const endIndex = Math.min(startIndex + batchSize, inventory.length);
    const batch = inventory.slice(startIndex, endIndex);

    const updated = batch.map(row => {
      const itemID = String(row["Item ID"] || "").trim();
      const onHand = Number(row["QTY On-Hand"]) || 0;

      row["QTY Allocated"] = allocationByItem[itemID] || 0;
      row["QTY Delivered"] = deliveredByItem[itemID] || 0;
      row["QTY Available"] =
        onHand - (Number(row["QTY Allocated"]) || 0);

      // QTY On-Hand and QTY On Order are deliberately not
      // reconstructed here. They are physical/procurement state,
      // not values derivable from Sales Details.
      return row;
    });

    _repairWriteRowsByPrimaryKey_("Inventory", updated);

    return _repairBatchResult_(
      "Inventory",
      startIndex,
      batchSize,
      inventory.length,
      updated.length
    );

  } finally {
    lock.releaseLock();
  }
}


function ERP_RecomputeCustomersBatch(startIndex, batchSize) {
  startIndex = _repairNormalizeStartIndex_(startIndex);
  batchSize = _repairNormalizeBatchSize_(batchSize);

  const lock = _repairAcquireLock_();

  try {
    const customers = Repository_getRows("Customers");
    const orders = Repository_getRows("SalesOrders");
    const receipts = Repository_getRows("Receipts");

    const ordersByCustomer = {};
    const receiptsByCustomer = {};

    orders.forEach(row => {
      const customerID = String(row["Customer ID"] || "").trim();
      if (!customerID) return;

      const amount = Number(row["Total SO Amount"]) || 0;
      ordersByCustomer[customerID] =
        (ordersByCustomer[customerID] || 0) + amount;
    });

    receipts.forEach(row => {
      const customerID = String(row["Customer ID"] || "").trim();
      if (!customerID) return;

      const amount = Number(row["Amount Received"]) || 0;
      receiptsByCustomer[customerID] =
        (receiptsByCustomer[customerID] || 0) + amount;
    });

    const endIndex = Math.min(startIndex + batchSize, customers.length);
    const batch = customers.slice(startIndex, endIndex);

    const updated = batch.map(row => {
      const customerID = String(row["Customer ID"] || "").trim();

      row["Total Orders"] = ordersByCustomer[customerID] || 0;
      row["Total Receipts"] = receiptsByCustomer[customerID] || 0;

      // Total Sales is intentionally NOT recomputed yet.
      // It must come from Invoice records once the Invoice module
      // is implemented. Sales Orders are not recognized sales.
      const totalSales = Number(row["Total Sales"]) || 0;
      const totalReceipts = Number(row["Total Receipts"]) || 0;
      row["Balance Receivable"] = totalSales - totalReceipts;

      return row;
    });

    _repairWriteRowsByPrimaryKey_("Customers", updated);

    return _repairBatchResult_(
      "Customers",
      startIndex,
      batchSize,
      customers.length,
      updated.length
    );

  } finally {
    lock.releaseLock();
  }
}


/**
 * Convenience function for a complete Phase 1 repair.
 *
 * This is still manually invoked only. It processes each table
 * in batches and returns a summary. For very large workbooks,
 * use the individual batch functions instead to avoid Apps Script
 * execution limits.
 */
function ERP_RecomputePhase1(batchSize) {
  batchSize = _repairNormalizeBatchSize_(batchSize);

  const results = {
    SalesDetails: [],
    SalesOrders: [],
    Inventory: [],
    Customers: []
  };

  let result;

  result = ERP_RecomputeSalesDetailsBatch(0, batchSize);
  results.SalesDetails.push(result);

  if (!result.complete) {
    return {
      success: false,
      complete: false,
      message: "SalesDetails exceeds one batch. Continue with ERP_RecomputeSalesDetailsBatch(nextStartIndex, batchSize).",
      results: results
    };
  }

  result = ERP_RecomputeSalesOrdersBatch(0, batchSize);
  results.SalesOrders.push(result);

  if (!result.complete) {
    return {
      success: false,
      complete: false,
      message: "SalesOrders exceeds one batch. Continue with ERP_RecomputeSalesOrdersBatch(nextStartIndex, batchSize).",
      results: results
    };
  }

  result = ERP_RecomputeInventoryBatch(0, batchSize);
  results.Inventory.push(result);

  if (!result.complete) {
    return {
      success: false,
      complete: false,
      message: "Inventory exceeds one batch. Continue with ERP_RecomputeInventoryBatch(nextStartIndex, batchSize).",
      results: results
    };
  }

  result = ERP_RecomputeCustomersBatch(0, batchSize);
  results.Customers.push(result);

  if (!result.complete) {
    return {
      success: false,
      complete: false,
      message: "Customers exceeds one batch. Continue with ERP_RecomputeCustomersBatch(nextStartIndex, batchSize).",
      results: results
    };
  }

  return {
    success: true,
    complete: true,
    results: results
  };
}


function _repairCalculateSOStatus_(ordered, delivered) {
  ordered = Number(ordered) || 0;
  delivered = Number(delivered) || 0;

  if (ordered <= 0) return "Open";
  if (delivered <= 0) return "Open";
  if (delivered >= ordered) return "Fulfilled";
  return "Partially Fulfilled";
}


function _repairNormalizeStartIndex_(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}


function _repairNormalizeBatchSize_(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return DATA_REPAIR_DEFAULT_BATCH_SIZE;
  }
  return Math.floor(n);
}


function _repairAcquireLock_() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      "ERP data repair could not acquire the script lock. " +
      "Another document operation is in progress — please try again."
    );
  }

  return lock;
}


function _repairWriteRowsByPrimaryKey_(tableName, rows) {
  if (!rows || rows.length === 0) return;

  const config = Repository_getConfig_(tableName);
  const sheet = Repository_getSheet_(tableName);
  const headers = Repository_getHeaders_(sheet, config);
  const pk = config.primaryKey;
  const pkIndex = headers.indexOf(pk);

  if (pkIndex === -1) {
    throw new Error(
      `ERP data repair: Primary key \"${pk}\" not found in ${tableName}.`
    );
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= config.headerRow) return;

  const values = sheet.getRange(
    config.headerRow + 1,
    1,
    lastRow - config.headerRow,
    headers.length
  ).getValues();

  const rowIndexByPK = {};

  values.forEach((row, index) => {
    const key = String(row[pkIndex] ?? "").trim();
    if (key !== "") {
      rowIndexByPK[key] = index;
    }
  });

  const targetIndexes = [];
  const targetRows = {};

  rows.forEach(record => {
    const key = String(record[pk] ?? "").trim();
    if (!key) {
      throw new Error(
        `ERP data repair: ${tableName} contains a blank primary key.`
      );
    }

    const targetIndex = rowIndexByPK[key];
    if (targetIndex === undefined) {
      throw new Error(
        `ERP data repair: ${tableName} record not found (${pk}: ${key}).`
      );
    }

    targetIndexes.push(targetIndex);
    targetRows[targetIndex] = record;
  });

  const firstIndex = Math.min.apply(null, targetIndexes);
  const lastIndex = Math.max.apply(null, targetIndexes);
  const output = values.slice(firstIndex, lastIndex + 1);

  Object.keys(targetRows).forEach(indexKey => {
    const index = Number(indexKey);
    const record = targetRows[indexKey];

    output[index - firstIndex] = headers.map((header, columnIndex) =>
      Object.prototype.hasOwnProperty.call(record, header)
        ? record[header]
        : values[index][columnIndex]
    );
  });

  // One contiguous write for the entire requested batch. Any rows
  // between target records are written back unchanged.
  sheet.getRange(
    config.headerRow + 1 + firstIndex,
    1,
    output.length,
    headers.length
  ).setValues(output);
}


function _repairBatchResult_(tableName, startIndex, batchSize, total, processed) {
  const nextStartIndex = startIndex + processed;

  return {
    success: true,
    table: tableName,
    startIndex: startIndex,
    batchSize: batchSize,
    processed: processed,
    total: total,
    nextStartIndex: nextStartIndex,
    complete: nextStartIndex >= total
  };
}
