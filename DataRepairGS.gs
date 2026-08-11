/**
 * ============================================================
 * ERP DATA REPAIR / RECOMPUTE UTILITIES
 * Phase 1 transaction model
 *
 * PURPOSE
 *   Manual recovery utilities only. These functions are NOT
 *   part of normal transaction processing.
 * ============================================================
 */

const DATA_REPAIR_DEFAULT_BATCH_SIZE = 250;

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

      const soID =
        String(row["SO ID"] || "").trim();

      if (!soID) return;

      totalsBySO[soID] =
        (totalsBySO[soID] || 0) +
        (Number(row["Total Sales Price"]) || 0);

      if (!qtyBySO[soID]) {
        qtyBySO[soID] = {
          ordered: 0,
          delivered: 0
        };
      }

      qtyBySO[soID].ordered +=
        Number(row["QTY Ordered"]) || 0;

      qtyBySO[soID].delivered +=
        Number(row["QTY Delivered"]) || 0;

    });

    const endIndex =
      Math.min(
        startIndex + batchSize,
        orders.length
      );

    const batch =
      orders.slice(startIndex, endIndex);

    // --------------------------------------------------
    // IMPORTANT:
    // Build a sparse repair record.
    // Only fields owned by this repair are included.
    // --------------------------------------------------

    const updated = batch.map(row => {

      const soID =
        String(row["SO ID"] || "").trim();

      const totals =
        qtyBySO[soID] || {
          ordered: 0,
          delivered: 0
        };

      return {
        "SO ID": soID,
        "Total SO Amount":
          totalsBySO[soID] || 0,
        "SO Status":
          _repairCalculateSOStatus_(
            totals.ordered,
            totals.delivered
          )
      };

    });

    _repairWriteRowsByPrimaryKey_(
      "SalesOrders",
      updated
    );

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

    const inventory =
      Repository_getRows("Inventory");

    const details =
      Repository_getRows("SalesDetails");

    const allocationByItem = {};
    const deliveredByItem = {};

    details.forEach(row => {

      const itemID =
        String(row["Item ID"] || "").trim();

      if (!itemID) return;

      const ordered =
        Number(row["QTY Ordered"]) || 0;

      const delivered =
        Number(row["QTY Delivered"]) || 0;

      allocationByItem[itemID] =
        (allocationByItem[itemID] || 0) +
        (ordered - delivered);

      deliveredByItem[itemID] =
        (deliveredByItem[itemID] || 0) +
        delivered;

    });

    const endIndex =
      Math.min(
        startIndex + batchSize,
        inventory.length
      );

    const batch =
      inventory.slice(startIndex, endIndex);

    // --------------------------------------------------
    // IMPORTANT:
    // Do NOT return the complete Inventory row.
    //
    // QTY Available is intentionally excluded because
    // it is a Google Sheets formula field.
    // --------------------------------------------------

    const updated = batch.map(row => {

      const itemID =
        String(row["Item ID"] || "").trim();

      return {
        "Item ID": itemID,
        "QTY Allocated":
          allocationByItem[itemID] || 0,
        "QTY Delivered":
          deliveredByItem[itemID] || 0
      };

    });

    _repairWriteRowsByPrimaryKey_(
      "Inventory",
      updated
    );

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

    const customers =
      Repository_getRows("Customers");

    const orders =
      Repository_getRows("SalesOrders");

    // Receipts currently has a repository primary-key mismatch:
    // the live schema uses Trx ID while the repository configuration
    // still expects Receipt ID. Customer repair only needs the receipt
    // data, so read the sheet directly and do not depend on that stale PK.
    const receipts =
      _repairReadTableRowsWithoutPK_("Receipts");

    const ordersByCustomer = {};
    const receiptsByCustomer = {};

    orders.forEach(row => {

      const customerID =
        String(row["Customer ID"] || "").trim();

      if (!customerID) return;

      ordersByCustomer[customerID] =
        (ordersByCustomer[customerID] || 0) +
        (Number(row["Total SO Amount"]) || 0);

    });

    receipts.forEach(row => {

      const customerID =
        String(row["Customer ID"] || "").trim();

      if (!customerID) return;

      receiptsByCustomer[customerID] =
        (receiptsByCustomer[customerID] || 0) +
        (Number(row["Amount Received"]) || 0);

    });

    const endIndex =
      Math.min(
        startIndex + batchSize,
        customers.length
      );

    const batch =
      customers.slice(startIndex, endIndex);

    // --------------------------------------------------
    // IMPORTANT:
    // Only write fields owned by Customer repair.
    //
    // Balance Receivable is intentionally excluded
    // because it is a Google Sheets formula field.
    // --------------------------------------------------

    const updated = batch.map(row => {

      const customerID =
        String(row["Customer ID"] || "").trim();

      return {
        "Customer ID": customerID,
        "Total Orders":
          ordersByCustomer[customerID] || 0,
        "Total Receipts":
          receiptsByCustomer[customerID] || 0
      };

    });

    _repairWriteRowsByPrimaryKey_(
      "Customers",
      updated
    );

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

function ERP_RecomputePhase1(batchSize) {

  batchSize = _repairNormalizeBatchSize_(batchSize);

  const results = {
    SalesOrders: [],
    Inventory: [],
    Customers: []
  };

  // --------------------------------------------------
  // 1. Recompute Sales Orders
  // --------------------------------------------------

  let result =
    ERP_RecomputeSalesOrdersBatch(0, batchSize);

  results.SalesOrders.push(result);

  if (!result.complete) {
    return repairIncompletePhase1Result_(
      "SalesOrders",
      result,
      results
    );
  }

  // --------------------------------------------------
  // 2. Recompute Inventory
  // --------------------------------------------------

  result =
    ERP_RecomputeInventoryBatch(0, batchSize);

  results.Inventory.push(result);

  if (!result.complete) {
    return repairIncompletePhase1Result_(
      "Inventory",
      result,
      results
    );
  }

  // --------------------------------------------------
  // 3. Recompute Customers
  // --------------------------------------------------

  result =
    ERP_RecomputeCustomersBatch(0, batchSize);

  results.Customers.push(result);

  if (!result.complete) {
    return repairIncompletePhase1Result_(
      "Customers",
      result,
      results
    );
  }

  return {
    success: true,
    complete: true,
    results: results
  };
}

function _repairIncompletePhase1Result_(tableName, result, results) {
  return { success: false, complete: false, message: tableName + " exceeds one batch. Continue from nextStartIndex.", nextStartIndex: result.nextStartIndex, results: results };
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
  if (!Number.isFinite(n) || n <= 0) return DATA_REPAIR_DEFAULT_BATCH_SIZE;
  return Math.floor(n);
}

function _repairAcquireLock_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("ERP data repair could not acquire the script lock. Another document operation is in progress — please try again.");
  return lock;
}

function _repairReadTableRowsWithoutPK_(tableName) {
  const sheet = Repository_getSheet_(tableName);
  const headerRow = Repository_getConfig_(tableName).headerRow;
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow <= headerRow || lastColumn === 0) return [];
  const headers = sheet.getRange(headerRow, 1, 1, lastColumn).getValues()[0];
  const values = sheet.getRange(headerRow + 1, 1, lastRow - headerRow, headers.length).getValues();
  return values.map(row => Repository_rowToObject_(row, headers));
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
      'ERP data repair: Primary key "' +
      pk +
      '" not found in ' +
      tableName +
      '.'
    );
  }

  const lastRow = sheet.getLastRow();

  if (lastRow <= config.headerRow) return;

  const values =
    sheet
      .getRange(
        config.headerRow + 1,
        1,
        lastRow - config.headerRow,
        headers.length
      )
      .getValues();

  //--------------------------------------------------
  // Locate repository rows by primary key
  //--------------------------------------------------

  const rowIndexByPK = {};

  values.forEach((row, index) => {

    const key =
      String(row[pkIndex] ?? "").trim();

    if (key !== "") {
      rowIndexByPK[key] = index;
    }

  });

  //--------------------------------------------------
  // Apply only explicitly supplied fields
  //--------------------------------------------------

  rows.forEach(record => {

    if (!record || typeof record !== "object") {
      throw new Error(
        "ERP data repair: Invalid repair record."
      );
    }

    const key =
      String(record[pk] ?? "").trim();

    if (!key) {
      throw new Error(
        'ERP data repair: ' +
        tableName +
        ' contains a blank primary key.'
      );
    }

    const targetIndex =
      rowIndexByPK[key];

    if (targetIndex === undefined) {
      throw new Error(
        'ERP data repair: ' +
        tableName +
        ' record not found (' +
        pk +
        ': ' +
        key +
        ').'
      );
    }

    //------------------------------------------------
    // Only fields explicitly included in the record
    // are written.
    //------------------------------------------------

    Object.keys(record).forEach(field => {

      const columnIndex =
        headers.indexOf(field);

      if (columnIndex === -1) {
        throw new Error(
          'ERP data repair: Field "' +
          field +
          '" not found in table "' +
          tableName +
          '".'
        );
      }

      sheet
        .getRange(
          config.headerRow + 1 + targetIndex,
          columnIndex + 1
        )
        .setValue(record[field]);

    });

  });
}

function _repairBatchResult_(tableName, startIndex, batchSize, total, processed) {
  const nextStartIndex = startIndex + processed;
  return { success: true, table: tableName, startIndex: startIndex, batchSize: batchSize, processed: processed, total: total, nextStartIndex: nextStartIndex, complete: nextStartIndex >= total };
}
