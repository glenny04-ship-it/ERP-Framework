/**
 * ============================================================
 * Delivery Receipts Module
 *
 * Delivery Receipt = physical fulfillment.
 * It does NOT recognize revenue.
 *
 * Effects of a delivery:
 * - SalesDetails.QTY Delivered increases
 * - Inventory.QTY On-Hand decreases
 * - Inventory.QTY Allocated decreases
 * - Inventory.QTY Delivered increases
 * - Customer.Total Deliveries increases by DR Amount
 * - SalesOrders.SO Status is recalculated
 *
 * DeliveryDetails.QTY Balance is a snapshot of the Sales Detail
 * balance BEFORE the delivery. SalesDetails.QTY Balance remains
 * formula-driven and is never written by this module.
 *
 * One DR = one Sales Order.
 * ============================================================
 */

const DR_HEADER_TABLE = "DeliveryReceipts";
const DR_DETAIL_TABLE = "DeliveryDetails";
const DR_SO_TABLE = "SalesOrders";
const DR_SD_TABLE = "SalesDetails";
const DR_CUSTOMER_TABLE = "Customers";
const DR_INVENTORY_TABLE = "Inventory";
const DR_CUSTOMER_TOTAL_FIELD = "Total Deliveries";

/* ============================================================
 * READ APIs
 * ============================================================ */

function drGetAllDR() {
  const tz = Session.getScriptTimeZone();
  return Repository_getRows(DR_HEADER_TABLE).map(row => {
    const result = Object.assign({}, row);
    if (result["DR Date"] instanceof Date) {
      result["DR Date"] = Utilities.formatDate(result["DR Date"], tz, "MM/dd/yyyy");
    }
    return result;
  });
}

function drGetCustomers() {
  return Repository_getRows(DR_CUSTOMER_TABLE);
}

function drGetOpenSalesOrders(customerID) {
  drRequireCustomer_(customerID);
  return Repository_getRows(DR_SO_TABLE)
    .filter(row =>
      String(row["Customer ID"]) === String(customerID) &&
      String(row["SO Status"] || "Open").trim() !== "Fulfilled"
    )
    .map(row => {
      const result = Object.assign({}, row);
      if (result["SO Date"] instanceof Date) {
        result["SO Date"] = Utilities.formatDate(result["SO Date"], Session.getScriptTimeZone(), "yyyy-MM-dd");
      }
      return result;
    });
}

function drGetOutstandingSalesDetails(soID) {
  drRequireSalesOrder_(soID);
  return Repository_getRows(DR_SD_TABLE)
    .filter(row =>
      String(row["SO ID"]) === String(soID) &&
      (Number(row["QTY Balance"]) || 0) !== 0
    )
    .map(row => {
      const result = Object.assign({}, row);
      if (result["SO Date"] instanceof Date) {
        result["SO Date"] = Utilities.formatDate(result["SO Date"], Session.getScriptTimeZone(), "yyyy-MM-dd");
      }
      return result;
    });
}

function drGetDeliveryReceipt(drID) {
  if (!drID) throw new Error("Delivery Receipt ID is required.");
  const header = Repository_getById(DR_HEADER_TABLE, drID);
  if (!header) throw new Error(`Delivery Receipt not found: ${drID}`);
  return {
    header: header,
    details: Repository_getRows(DR_DETAIL_TABLE).filter(row => String(row["DR ID"]) === String(drID))
  };
}

/* ============================================================
 * ID / VALIDATION HELPERS
 * ============================================================ */

function drGenerateDRID() {
  const rows = Repository_getRows(DR_HEADER_TABLE);
  let max = 0;
  rows.forEach(row => {
    const match = String(row["DR ID"] || "").trim().match(/^DR-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return `DR-${String(max + 1).padStart(4, "0")}`;
}

function drRequireCustomer_(id) {
  if (!id) throw new Error("Customer is required.");
  const row = Repository_getById(DR_CUSTOMER_TABLE, id);
  if (!row) throw new Error(`Customer not found: ${id}`);
  return row;
}

function drRequireSalesOrder_(id) {
  if (!id) throw new Error("Sales Order is required.");
  const row = Repository_getById(DR_SO_TABLE, id);
  if (!row) throw new Error(`Sales Order not found: ${id}`);
  return row;
}

function drValidateSOCustomer_(so, customerID) {
  if (String(so["Customer ID"]) !== String(customerID)) {
    throw new Error(`Sales Order ${so["SO ID"]} does not belong to customer ${customerID}.`);
  }
}

function drValidateQty_(qty, balance, detailID) {
  const q = Number(qty);
  const b = Number(balance);
  if (!Number.isFinite(q) || q <= 0) {
    throw new Error(`Invalid delivery quantity for ${detailID}. Quantity must be greater than zero.`);
  }
  if (!Number.isFinite(b) || b <= 0) {
    throw new Error(`Sales Detail ${detailID} has no remaining balance.`);
  }
  if (q > b) {
    throw new Error(`Invalid delivery quantity for ${detailID}. Maximum deliverable quantity is ${b}.`);
  }
}

function drNormalizePayloadDetails_(payload) {
  if (!payload || !payload.details) return [];
  if (Array.isArray(payload.details)) return payload.details;
  if (Array.isArray(payload.details[DR_DETAIL_TABLE])) return payload.details[DR_DETAIL_TABLE];
  return [];
}

function drCalculateStatus_(soID) {
  const rows = Repository_getRows(DR_SD_TABLE).filter(r => String(r["SO ID"]) === String(soID));
  if (!rows.length) return "Open";
  let ordered = 0;
  let delivered = 0;
  rows.forEach(r => {
    ordered += Number(r["QTY Ordered"]) || 0;
    delivered += Number(r["QTY Delivered"]) || 0;
  });
  if (delivered <= 0) return "Open";
  if (ordered > 0 && delivered >= ordered) return "Fulfilled";
  return "Partially Fulfilled";
}

/* ============================================================
 * AMOUNT / DELTA HELPERS
 * ============================================================ */

function drCalculateLineAmount_(source, qty) {
  const unitPrice = Number(source["Unit Price"]) || 0;
  const taxRate = Number(source["Tax Rate"]) || 0;
  const merchandise = Number(qty) * unitPrice;
  return merchandise + (merchandise * taxRate);
}

function drIsFirstDeliveryForSO_(soID, excludingDRID) {
  return !Repository_getRows(DR_HEADER_TABLE).some(row =>
    String(row["SO ID"]) === String(soID) &&
    String(row["DR ID"]) !== String(excludingDRID || "")
  );
}

function drCalculateAmount_(so, sourceByID, lines, drID) {
  let amount = 0;
  lines.forEach(line => {
    const source = sourceByID[String(line["Sales Detail ID"])];
    if (!source) throw new Error(`Sales Detail ${line["Sales Detail ID"]} not found.`);
    amount += drCalculateLineAmount_(source, Number(line["QTY Delivered"]));
  });

  if (drIsFirstDeliveryForSO_(so["SO ID"], drID)) {
    const seen = {};
    Object.keys(sourceByID).forEach(id => {
      const shipping = Number(sourceByID[id]["Shipping Fees"]) || 0;
      if (shipping && !seen[id]) {
        amount += shipping;
        seen[id] = true;
      }
    });
  }
  return amount;
}

function drAggregateQty_(rows) {
  const map = {};
  (rows || []).forEach(row => {
    const id = String(row["Sales Detail ID"] || "").trim();
    if (!id) return;
    map[id] = (Number(map[id]) || 0) + (Number(row["QTY Delivered"]) || 0);
  });
  return map;
}

function drBuildDeliveryDelta_(oldRows, newRows) {
  const oldMap = drAggregateQty_(oldRows);
  const newMap = drAggregateQty_(newRows);
  const ids = Object.assign({}, oldMap, newMap);
  const delta = {};
  Object.keys(ids).forEach(id => {
    const d = (Number(newMap[id]) || 0) - (Number(oldMap[id]) || 0);
    if (d !== 0) delta[id] = d;
  });
  console.log(JSON.stringify({diagnostic:"DR_DELIVERY_DELTA", oldMap, newMap, delta}));
  return delta;
}

/* ============================================================
 * INTEGRATION EFFECTS
 * ============================================================ */

function drApplySalesDetailDelta_(salesDetailID, delta) {
  if (!delta) return;
  const row = Repository_getById(DR_SD_TABLE, salesDetailID);
  if (!row) throw new Error(`Sales Detail not found: ${salesDetailID}`);
  const oldValue = Number(row["QTY Delivered"]) || 0;
  const newValue = oldValue + Number(delta);
  if (newValue < 0) throw new Error(`Sales Detail ${salesDetailID} would have negative delivered quantity.`);
  console.log(JSON.stringify({diagnostic:"SALES_DETAIL_DELIVERY_DELTA", detailID:salesDetailID, oldValue, delta, newValue, QTYBalancePersisted:false}));
  Repository_update(DR_SD_TABLE, {"Detail ID": salesDetailID, "QTY Delivered": newValue});
}

function drApplyInventoryDelta_(itemID, delta) {
  if (!delta) return;
  const row = Repository_getById(DR_INVENTORY_TABLE, itemID);
  if (!row) throw new Error(`Inventory item not found: ${itemID}`);
  const oldOnHand = Number(row["QTY On-Hand"]) || 0;
  const oldAllocated = Number(row["QTY Allocated"]) || 0;
  const oldDelivered = Number(row["QTY Delivered"]) || 0;
  const newOnHand = oldOnHand - delta;
  const newAllocated = oldAllocated - delta;
  const newDelivered = oldDelivered + delta;
  if (newOnHand < 0) throw new Error(`Inventory item ${itemID} would have negative QTY On-Hand.`);
  if (newAllocated < 0) throw new Error(`Inventory item ${itemID} would have negative QTY Allocated.`);
  console.log(JSON.stringify({diagnostic:"INVENTORY_DELIVERY_DELTA", itemID, delta, oldOnHand, newOnHand, oldAllocated, newAllocated, oldDelivered, newDelivered, QTYAvailablePersisted:false}));
  Repository_update(DR_INVENTORY_TABLE, {"Item ID": itemID, "QTY On-Hand":newOnHand, "QTY Allocated":newAllocated, "QTY Delivered":newDelivered});
}

function drAdjustCustomerDeliveries_(customerID, delta) {
  const customer = drRequireCustomer_(customerID);
  const oldValue = Number(customer[DR_CUSTOMER_TOTAL_FIELD]) || 0;
  const newValue = oldValue + Number(delta || 0);
  console.log(JSON.stringify({diagnostic:"CUSTOMER_DELIVERY_AGGREGATE_UPDATE", customerID, field:DR_CUSTOMER_TOTAL_FIELD, oldValue, delta:Number(delta||0), newValue}));
  if (Number(delta || 0) !== 0) {
    Repository_update(DR_CUSTOMER_TABLE, {"Customer ID":customerID, [DR_CUSTOMER_TOTAL_FIELD]:newValue});
  }
}

function drApplyIntegrationDelta_(oldRows, newRows, customerID) {
  const deltaBySalesDetail = drBuildDeliveryDelta_(oldRows, newRows);
  const salesDetails = Repository_getRows(DR_SD_TABLE);
  const byDetail = {};
  salesDetails.forEach(row => { byDetail[String(row["Detail ID"])] = row; });

  const inventoryDelta = {};
  Object.keys(deltaBySalesDetail).forEach(detailID => {
    const source = byDetail[detailID];
    if (!source) throw new Error(`Sales Detail ${detailID} not found while applying delivery delta.`);
    drApplySalesDetailDelta_(detailID, deltaBySalesDetail[detailID]);
    const itemID = String(source["Item ID"] || "").trim();
    if (!itemID) throw new Error(`Sales Detail ${detailID} has no Item ID.`);
    inventoryDelta[itemID] = (Number(inventoryDelta[itemID]) || 0) + deltaBySalesDetail[detailID];
  });
  Object.keys(inventoryDelta).forEach(itemID => drApplyInventoryDelta_(itemID, inventoryDelta[itemID]));
  return {salesDetailDelta:deltaBySalesDetail, inventoryDelta};
}

function drUpdateSOStatus_(soID) {
  const status = drCalculateStatus_(soID);
  Repository_update(DR_SO_TABLE, {"SO ID":soID, "SO Status":status});
  console.log(JSON.stringify({diagnostic:"SO_FULFILLMENT_STATUS_UPDATE", soID, newStatus:status}));
  return status;
}

/* ============================================================
 * BUILD DOCUMENT PAYLOAD
 * ============================================================ */

function drBuildDocument_(master, lines, persistedByID, drID, customer, so) {
  const drDate = master["DR Date"] || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const sourceDetails = {};
  lines.forEach(line => {
    const source = persistedByID[String(line["Sales Detail ID"])];
    if (source) sourceDetails[String(line["Sales Detail ID"])] = source;
  });

  const amount = drCalculateAmount_(so, sourceDetails, lines, drID);
  const header = {
    "DR Date":drDate,
    "DR ID":drID,
    "Customer ID":String(master["Customer ID"] || ""),
    "Customer Name":customer["Customer Name"] || "",
    "State":customer["State"] || "",
    "City":customer["City"] || "",
    "SO ID":String(master["SO ID"] || ""),
    "Invoice Num":master["Invoice Num"] || so["Invoice Num"] || "",
    "DR Amount":amount
  };

  const details = lines.map((line, index) => {
    const source = persistedByID[String(line["Sales Detail ID"])];
    return {
      "DR Date":drDate,
      "DR ID":drID,
      "Customer ID":header["Customer ID"],
      "Customer Name":header["Customer Name"],
      "State":header["State"],
      "City":header["City"],
      "SO ID":header["SO ID"],
      "Invoice Num":header["Invoice Num"],
      "SO DR Detail ID":line["SO DR Detail ID"] || `${drID}-${String(index+1).padStart(2,"0")}`,
      "Sales Detail ID":source["Detail ID"],
      "Item ID":source["Item ID"],
      "Item Name":source["Item Name"],
      "QTY Ordered":Number(source["QTY Ordered"]) || 0,
      "QTY Delivered":Number(line["QTY Delivered"]) || 0,
      "QTY Balance":Number(source["QTY Balance"]) || 0
    };
  });
  return {master:header, details:{[DR_DETAIL_TABLE]:details}, amount};
}

/* ============================================================
 * SAVE / EDIT
 *
 * Uses the same Document_save path as Sales Orders for both
 * insert and update. Document_save handles the header upsert
 * and detail merge. This function validates and calculates the
 * integration deltas before/after the document save.
 * ============================================================ */

function drSaveDeliveryReceipt(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Delivery Receipt payload is required.");
  if (!payload.master || typeof payload.master !== "object") throw new Error("Delivery Receipt header is required.");

  const master = payload.master;
  const submittedLines = drNormalizePayloadDetails_(payload);
  if (!submittedLines.length) throw new Error("Delivery Receipt must contain at least one detail row.");

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Could not acquire transaction lock. Another transaction is in progress.");

  try {
    const customerID = String(master["Customer ID"] || "").trim();
    const soID = String(master["SO ID"] || "").trim();
    if (!customerID) throw new Error("Customer is required.");
    if (!soID) throw new Error("Sales Order is required.");

    const customer = drRequireCustomer_(customerID);
    const so = drRequireSalesOrder_(soID);
    drValidateSOCustomer_(so, customerID);

    const drID = String(master["DR ID"] || "").trim() || drGenerateDRID();
    const existingHeader = Repository_getById(DR_HEADER_TABLE, drID);
    const isEdit = !!existingHeader;

    if (!isEdit && String(so["SO Status"] || "Open").trim() === "Fulfilled") {
      throw new Error(`Sales Order ${soID} is already Fulfilled.`);
    }
    if (isEdit && String(existingHeader["SO ID"]) !== String(soID)) {
      throw new Error("Changing the Sales Order on an existing Delivery Receipt is not allowed.");
    }

    const oldRows = isEdit ? Repository_getRows(DR_DETAIL_TABLE).filter(r => String(r["DR ID"]) === drID) : [];
    const persistedDetails = Repository_getRows(DR_SD_TABLE);
    const byID = {};
    persistedDetails.forEach(row => { byID[String(row["Detail ID"])] = row; });

    const seen = {};
    const validated = submittedLines.map((line, index) => {
      const sdID = String(line["Sales Detail ID"] || "").trim();
      if (!sdID) throw new Error(`Sales Detail ID is missing at row ${index + 1}.`);
      if (seen[sdID]) throw new Error(`Duplicate Sales Detail ID ${sdID}.`);
      seen[sdID] = true;
      const source = byID[sdID];
      if (!source) throw new Error(`Sales Detail ${sdID} was not found.`);
      if (String(source["SO ID"]) !== soID) throw new Error(`Sales Detail ${sdID} does not belong to Sales Order ${soID}.`);

      const oldForThisLine = oldRows.find(r => String(r["Sales Detail ID"]) === sdID);
      const persistedBalance = Number(source["QTY Balance"]) || 0;
      const allowableBalance = persistedBalance + (oldForThisLine ? Number(oldForThisLine["QTY Delivered"]) || 0 : 0);
      const qty = Number(line["QTY Delivered"]);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Invalid delivery quantity for ${sdID}. Quantity must be greater than zero.`);
      if (qty > allowableBalance) throw new Error(`Invalid delivery quantity for ${sdID}. Maximum deliverable quantity is ${allowableBalance}.`);
      return Object.assign({}, line, {"Sales Detail ID":sdID, "QTY Delivered":qty});
    });

    const documentPayload = drBuildDocument_(master, validated, byID, drID, customer, so);

    // Preflight the integration delta before Document_save.
    const deliveryDelta = drBuildDeliveryDelta_(oldRows, validated);
    Object.keys(deliveryDelta).forEach(sdID => {
      const source = byID[sdID];
      const resultingDelivered = (Number(source["QTY Delivered"]) || 0) + deliveryDelta[sdID];
      if (resultingDelivered < 0) throw new Error(`Sales Detail ${sdID} would have negative delivered quantity.`);
      const itemID = String(source["Item ID"] || "").trim();
      const inventory = Repository_getById(DR_INVENTORY_TABLE, itemID);
      if (!inventory) throw new Error(`Inventory item not found: ${itemID}`);
      if ((Number(inventory["QTY On-Hand"]) || 0) - deliveryDelta[sdID] < 0) {
        throw new Error(`Inventory item ${itemID} does not have enough on-hand quantity for this delivery.`);
      }
      if ((Number(inventory["QTY Allocated"]) || 0) - deliveryDelta[sdID] < 0) {
        throw new Error(`Inventory item ${itemID} does not have enough allocated quantity to release.`);
      }
    });

    // Same document engine save used by Sales Orders.
    const documentResult = Document_save("DeliveryReceipt", documentPayload);

    const integration = drApplyIntegrationDelta_(oldRows, validated, customerID);

    const oldAmount = isEdit ? Number(existingHeader["DR Amount"]) || 0 : 0;
    const newAmount = Number(documentPayload.master["DR Amount"]) || 0;
    drAdjustCustomerDeliveries_(customerID, newAmount - oldAmount);

    const status = drUpdateSOStatus_(soID);

    console.log(JSON.stringify({diagnostic:"DELIVERY_RECEIPT_SAVE", action:isEdit?"updated":"inserted", drID, soID, customerID, oldAmount, newAmount, status}));

    return {
      success:true,
      action:isEdit?"updated":"inserted",
      drID,
      drAmount:newAmount,
      soID,
      soStatus:status,
      document:documentResult,
      integration
    };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * DELETE
 * ============================================================ */

function drDeleteDeliveryReceipt(drID) {
  if (!drID) throw new Error("Delivery Receipt ID is required.");
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Could not acquire transaction lock.");
  try {
    const header = Repository_getById(DR_HEADER_TABLE, drID);
    if (!header) throw new Error(`Delivery Receipt not found: ${drID}`);
    const oldRows = Repository_getRows(DR_DETAIL_TABLE).filter(r => String(r["DR ID"]) === String(drID));
    if (!oldRows.length) throw new Error(`Delivery Receipt ${drID} has no detail rows.`);

    const soID = String(header["SO ID"] || "");
    const customerID = String(header["Customer ID"] || "");
    const persistedDetails = Repository_getRows(DR_SD_TABLE);
    const byID = {};
    persistedDetails.forEach(row => { byID[String(row["Detail ID"])] = row; });

    // Preflight reversal.
    const delta = drBuildDeliveryDelta_(oldRows, []);
    Object.keys(delta).forEach(sdID => {
      const source = byID[sdID];
      if (!source) throw new Error(`Sales Detail ${sdID} not found while deleting ${drID}.`);
      const itemID = String(source["Item ID"] || "").trim();
      const inventory = Repository_getById(DR_INVENTORY_TABLE, itemID);
      if (!inventory) throw new Error(`Inventory item not found: ${itemID}`);
      if ((Number(inventory["QTY Delivered"]) || 0) + delta[sdID] < 0) throw new Error(`Inventory delivered quantity cannot become negative for ${itemID}.`);
    });

    const result = Document_delete("DeliveryReceipt", drID);
    drApplyIntegrationDelta_(oldRows, [], customerID);
    drAdjustCustomerDeliveries_(customerID, -(Number(header["DR Amount"]) || 0));
    const status = drUpdateSOStatus_(soID);

    console.log(JSON.stringify({diagnostic:"DELIVERY_RECEIPT_DELETE", drID, soID, customerID, status}));
    return {success:true, action:"deleted", drID, soID, soStatus:status, document:result};
  } finally {
    lock.releaseLock();
  }
}
