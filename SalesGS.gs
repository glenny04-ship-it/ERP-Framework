/**
 * ============================================================
 * Sales Order Module
 * Phase 1 transaction model
 *
 * Sales Order = customer commitment + inventory allocation.
 * Sales Orders do NOT represent recognized sales.
 *
 * Customer aggregate:
 *   Total Orders = sum of Sales Order amounts
 *
 * Inventory:
 *   QTY Allocated = quantity committed to outstanding SOs
 *   QTY Available = QTY On-Hand - QTY Allocated
 *
 * SO lifecycle status:
 *   Open -> Partially Fulfilled -> Fulfilled
 *   Cancelled is an explicit future business action.
 * ============================================================
 */

/** Fetch all SO rows and expose a derived SO Status. */
function soGetAllSO() {
  const tz = Session.getScriptTimeZone();
  const rows = Repository_getRows("SalesOrders");

  return rows.map(row => {
    if (row["SO Date"] instanceof Date) {
      row["SO Date"] = Utilities.formatDate(row["SO Date"], tz, "MM/dd/yyyy");
    }

    // Status is derived from Sales Details unless an explicit
    // Cancelled status has been stored on the header.
    if (String(row["SO Status"] || "").toLowerCase() !== "cancelled") {
      row["SO Status"] = soCalculateStatus_(row["SO ID"]);
    }

    return row;
  });
}

/** Derive the SO lifecycle status from its detail quantities. */
function soCalculateStatus_(soID) {
  const details = soGetSalesOrderDetailsForAllocation_(soID);

  if (!details.length) {
    return "Open";
  }

  let totalOrdered = 0;
  let totalDelivered = 0;

  details.forEach(row => {
    totalOrdered += Number(row["QTY Ordered"]) || 0;
    totalDelivered += Number(row["QTY Delivered"]) || 0;
  });

  if (totalOrdered <= 0) return "Open";
  if (totalDelivered <= 0) return "Open";
  if (totalDelivered >= totalOrdered) return "Fulfilled";
  return "Partially Fulfilled";
}

/** Fetch customers list. */
function soGetCustomers() {
  try {
    return Repository_getRows("Customers");
  } catch (err) {
    console.error(err);
    throw new Error("soGetCustomers failed: " + err.message);
  }
}

/** Fetch inventory items. */
function soGetInventoryItems() {
  return Repository_getRows("Inventory");
}

/** Fetch a complete Sales Order document. */
function soGetSalesOrder(soID) {
  const doc = Document_get("SalesOrder", soID);
  return JSON.parse(JSON.stringify(doc));
}

/** Get persisted Sales Details for an SO. */
function soGetSalesOrderDetailsForAllocation_(soID) {
  return Repository_getRows("SalesDetails")
    .filter(row => String(row["SO ID"]) === String(soID));
}

/**
 * Build an item-level allocation delta.
 * Positive = allocate more; negative = release allocation.
 */
function soBuildAllocationMap_(oldDetails, newDetails) {
  const oldMap = soAggregateOutstandingAllocation_(oldDetails || []);
  const newMap = soAggregateOutstandingAllocation_(newDetails || []);

  const itemIDs = {};
  Object.keys(oldMap).forEach(id => itemIDs[String(id)] = true);
  Object.keys(newMap).forEach(id => itemIDs[String(id)] = true);

  const deltaMap = {};

  Object.keys(itemIDs).forEach(itemID => {
    const oldQty = Number(oldMap[itemID]) || 0;
    const newQty = Number(newMap[itemID]) || 0;
    const delta = newQty - oldQty;
    if (delta !== 0) deltaMap[itemID] = delta;
  });

  return deltaMap;
}

/** Aggregate outstanding allocation by Item ID. */
function soAggregateOutstandingAllocation_(details) {
  const result = {};

  (details || []).forEach(row => {
    if (!row || typeof row !== "object") return;

    const itemID = row["Item ID"];
    if (itemID === null || itemID === undefined || itemID === "") {
      throw new Error("Sales Order detail is missing Item ID.");
    }

    // QTY Ordered is now the authoritative SO quantity.
    const ordered = Number(row["QTY Ordered"]) || 0;
    const delivered = Number(row["QTY Delivered"]) || 0;
    const outstanding = Math.max(0, ordered - delivered);
    const key = String(itemID);

    result[key] = (Number(result[key]) || 0) + outstanding;
  });

  return result;
}

/** Validate a customer exists before mutation. */
function soRequireCustomer_(customerID) {
  const customer = Repository_getById("Customers", customerID);
  if (!customer) {
    throw new Error(`Customer not found: ${customerID}`);
  }
  return customer;
}

/** Incrementally adjust an aggregate on a master record. */
function soAdjustAggregate_(tableName, primaryKeyField, primaryKeyValue, aggregateField, delta) {
  if (primaryKeyValue === null || primaryKeyValue === undefined || primaryKeyValue === "") {
    throw new Error(`Aggregate update failed: missing ${primaryKeyField}.`);
  }

  const numericDelta = Number(delta) || 0;
  if (numericDelta === 0) return { success: true, changed: false, delta: 0 };

  const record = Repository_getById(tableName, primaryKeyValue);
  if (!record) throw new Error(`${tableName} record not found: ${primaryKeyValue}`);

  const currentValue = Number(record[aggregateField]) || 0;
  const newValue = currentValue + numericDelta;

  Repository_update(tableName, {
    [primaryKeyField]: primaryKeyValue,
    [aggregateField]: newValue
  });

  return {
    success: true,
    changed: true,
    oldValue: currentValue,
    delta: numericDelta,
    newValue: newValue
  };
}

/** Delete an SO, release outstanding allocation, and reverse Total Orders. */
function soDeleteSalesOrder(soID) {
  if (!soID) throw new Error("soDeleteSalesOrder: Sales Order ID is required.");

  const existingSO = Repository_getById("SalesOrders", soID);
  if (!existingSO) throw new Error(`Sales Order not found: ${soID}`);

  const customerID = existingSO["Customer ID"];
  const amount = Number(existingSO["Total SO Amount"]) || 0;
  if (!customerID) throw new Error(`Sales Order ${soID} has no Customer ID.`);

  const existingDetails = soGetSalesOrderDetailsForAllocation_(soID);
  const allocationDelta = soBuildAllocationMap_(existingDetails, null);

  soRequireCustomer_(customerID);
  const result = Document_delete("SalesOrder", soID);

  if (Object.keys(allocationDelta).length > 0) {
    Inventory_applySOAllocationDelta(allocationDelta);
  }

  soAdjustAggregate_("Customers", "Customer ID", customerID, "Total Orders", -amount);

  return {
    success: true,
    action: "deleted",
    soID: soID,
    customerAdjustment: { customerID: customerID, delta: -amount },
    inventoryAllocationDelta: allocationDelta,
    document: result
  };
}

/**
 * Save a Sales Order and maintain Total Orders + inventory allocation.
 * This intentionally does not update Customer.Total Sales.
 */
function soSaveSalesOrder(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("soSaveSalesOrder: Sales Order payload is required.");
  }
  if (!payload.master || typeof payload.master !== "object") {
    throw new Error("soSaveSalesOrder: Sales Order master is required.");
  }

  const master = payload.master;
  const soID = master["SO ID"];
  const newCustomerID = master["Customer ID"];
  const newAmount = Number(master["Total SO Amount"]) || 0;

  if (!soID) throw new Error("soSaveSalesOrder: Sales Order ID is required.");
  if (!newCustomerID) throw new Error("soSaveSalesOrder: Customer ID is required.");

  const newDetails = payload.details && Array.isArray(payload.details["SalesDetails"])
    ? payload.details["SalesDetails"]
    : [];

  const existingSO = Repository_getById("SalesOrders", soID);
  const oldCustomerID = existingSO ? existingSO["Customer ID"] : null;
  const oldAmount = existingSO ? Number(existingSO["Total SO Amount"]) || 0 : 0;
  const oldDetails = existingSO ? soGetSalesOrderDetailsForAllocation_(soID) : [];

  const allocationDelta = soBuildAllocationMap_(oldDetails, newDetails);

  soRequireCustomer_(newCustomerID);
  if (existingSO && String(oldCustomerID) !== String(newCustomerID)) {
    soRequireCustomer_(oldCustomerID);
  }

  const allocationCheck = Inventory_validateSOAllocationDelta(allocationDelta);

  // Status is a lifecycle summary. It is recalculated from detail quantities,
  // rather than accepting receipt/shipping status from the UI.
  const explicitStatus = String(master["SO Status"] || "").trim();
  if (explicitStatus.toLowerCase() !== "cancelled") {
    master["SO Status"] = soCalculateStatusFromRows_(newDetails);
  } else {
    master["SO Status"] = "Cancelled";
  }

  // Remove legacy financial/shipping status fields from the payload so an old
  // browser cannot reintroduce them after the sheet schema is migrated.
  delete master["Total Received"];
  delete master["SO Balance"];
  delete master["Receipt Status"];
  delete master["Shipping Status"];

  const saveResult = Document_save("SalesOrder", payload);

  if (Object.keys(allocationDelta).length > 0) {
    Inventory_applySOAllocationDelta(allocationDelta);
  }

  if (!existingSO) {
    soAdjustAggregate_("Customers", "Customer ID", newCustomerID, "Total Orders", newAmount);

    return {
      success: true,
      action: "inserted",
      customerAdjustment: { customerID: newCustomerID, delta: newAmount },
      inventoryAllocationDelta: allocationDelta,
      inventoryWarnings: allocationCheck.warnings,
      soStatus: master["SO Status"],
      document: saveResult
    };
  }

  if (String(oldCustomerID) === String(newCustomerID)) {
    const delta = newAmount - oldAmount;
    if (delta !== 0) {
      soAdjustAggregate_("Customers", "Customer ID", newCustomerID, "Total Orders", delta);
    }

    return {
      success: true,
      action: "updated",
      customerAdjustment: { customerID: newCustomerID, delta: delta },
      inventoryAllocationDelta: allocationDelta,
      inventoryWarnings: allocationCheck.warnings,
      soStatus: master["SO Status"],
      document: saveResult
    };
  }

  soAdjustAggregate_("Customers", "Customer ID", oldCustomerID, "Total Orders", -oldAmount);
  soAdjustAggregate_("Customers", "Customer ID", newCustomerID, "Total Orders", newAmount);

  return {
    success: true,
    action: "updated",
    customerAdjustment: {
      oldCustomerID: oldCustomerID,
      oldDelta: -oldAmount,
      newCustomerID: newCustomerID,
      newDelta: newAmount
    },
    inventoryAllocationDelta: allocationDelta,
    inventoryWarnings: allocationCheck.warnings,
    soStatus: master["SO Status"],
    document: saveResult
  };
}

/** Derive status from submitted detail rows before they are persisted. */
function soCalculateStatusFromRows_(details) {
  if (!details || !details.length) return "Open";

  let totalOrdered = 0;
  let totalDelivered = 0;

  details.forEach(row => {
    totalOrdered += Number(row["QTY Ordered"]) || 0;
    totalDelivered += Number(row["QTY Delivered"]) || 0;
  });

  if (totalOrdered <= 0) return "Open";
  if (totalDelivered <= 0) return "Open";
  if (totalDelivered >= totalOrdered) return "Fulfilled";
  return "Partially Fulfilled";
}
