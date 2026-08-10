
/**
 * Fetch all SO rows
 */
function soGetAllSO() {

  const tz = Session.getScriptTimeZone();
  const rows = Repository_getRows("SalesOrders");

  return rows.map(row => {
    if (row["SO Date"] instanceof Date) {

      row["SO Date"] = Utilities.formatDate(row["SO Date"],tz,"MM/dd/yyyy");
    }
    return row;
  });

}

/**
 * Fetch customers list
 */
function soGetCustomers() {
  try {
    return Repository_getRows(
      "Customers"
    );
  } catch (err) {
    console.error(err);
    throw new Error(
      "soGetCustomers failed: " + err.message
    );
  }
}

function soGetInventoryItems() {
  const data = Repository_getRows("Inventory");
  Logger.log(data.length);
  if (data.length > 0) {
    Logger.log(JSON.stringify(data[0]));
  }
  return data;
}

function soGetSalesOrder(soID) {
  const doc = Document_get("SalesOrder", soID);
  // Force serialization/deserialization
  return JSON.parse(JSON.stringify(doc));
}


// Note: SO creation and editing both go through
// Document_save("SalesOrder", payload),
// called directly from sales.html. soSaveNewSO was a hardcoded duplicate
// of that logic (no validation, no Registry-driven table config, and
// never called from the frontend) — removed.


/**
 * ============================================================
 * Sales Order Delete
 * ============================================================
 *
 * Removes the SO and reverses its contribution to
 * Customer.Total Sales.
 */
function soDeleteSalesOrder(soID) {

  if (!soID) {
    throw new Error(
      "soDeleteSalesOrder: Sales Order ID is required."
    );
  }

  /*
   * Read the SO BEFORE deleting it.
   */
  const existingSO =
    Repository_getById(
      "SalesOrders",
      soID
    );

  if (!existingSO) {
    throw new Error(
      `Sales Order not found: ${soID}`
    );
  }

  const customerID =
    existingSO["Customer ID"];

  const amount =
    Number(existingSO["Total SO Amount"]) || 0;

  if (!customerID) {
    throw new Error(
      `Sales Order ${soID} has no Customer ID.`
    );
  }

  /*
   * Delete through the generic Document Engine.
   */
  const result =
    Document_delete(
      "SalesOrder",
      soID
    );

  /*
   * Reverse the customer's aggregate.
   */
  soAdjustAggregate_(
    "Customers",
    "Customer ID",
    customerID,
    "Total Sales",
    -amount
  );

  return {
    success: true,
    action: "deleted",
    soID: soID,
    customerAdjustment: {
      customerID: customerID,
      delta: -amount
    },
    document: result
  };
}

/**
 * ============================================================
 * Sales Aggregate Helper
 * ============================================================
 *
 * Applies an incremental delta to an aggregate field on a
 * master record.
 *
 * This is intentionally kept in the Sales module for now.
 * If Purchasing / Inventory require the same behavior,
 * extract this into the EAF framework under an ADR.
 */
function soAdjustAggregate_(
  tableName,
  primaryKeyField,
  primaryKeyValue,
  aggregateField,
  delta
) {

  if (
    primaryKeyValue === null ||
    primaryKeyValue === undefined ||
    primaryKeyValue === ""
  ) {
    throw new Error(
      `Aggregate update failed: missing ${primaryKeyField}.`
    );
  }

  const numericDelta = Number(delta) || 0;

  if (numericDelta === 0) {
    return {
      success: true,
      changed: false,
      delta: 0
    };
  }

  const record =
    Repository_getById(
      tableName,
      primaryKeyValue
    );

  if (!record) {
    throw new Error(
      `${tableName} record not found: ${primaryKeyValue}`
    );
  }

  const currentValue =
    Number(record[aggregateField]) || 0;

  const newValue =
    currentValue + numericDelta;

  Repository_update(
    tableName,
    {
      [primaryKeyField]: primaryKeyValue,
      [aggregateField]: newValue
    }
  );

  return {
    success: true,
    changed: true,
    oldValue: currentValue,
    delta: numericDelta,
    newValue: newValue
  };
}

/**
 * ============================================================
 * Sales Order Save
 * ============================================================
 *
 * Handles the Sales business rule that Customer.Total Sales
 * must reflect the aggregate value of Sales Orders.
 *
 * New:
 *   + new SO amount
 *
 * Edit, same customer:
 *   + (new amount - old amount)
 *
 * Edit, different customer:
 *   - old customer / old amount
 *   + new customer / new amount
 */
function soSaveSalesOrder(payload) {

  if (!payload || typeof payload !== "object") {
    throw new Error(
      "soSaveSalesOrder: Sales Order payload is required."
    );
  }

  if (!payload.master || typeof payload.master !== "object") {
    throw new Error(
      "soSaveSalesOrder: Sales Order master is required."
    );
  }

  const master = payload.master;

  const soID = master["SO ID"];
  const newCustomerID = master["Customer ID"];
  const newAmount =
    Number(master["Total SO Amount"]) || 0;

  if (!soID) {
    throw new Error(
      "soSaveSalesOrder: Sales Order ID is required."
    );
  }

  if (!newCustomerID) {
    throw new Error(
      "soSaveSalesOrder: Customer ID is required."
    );
  }

  /*
   * Read the existing SO before saving.
   *
   * If it exists, this is an edit.
   * If it does not exist, this is a new SO.
   */
  const existingSO =
    Repository_getById(
      "SalesOrders",
      soID
    );

  const oldCustomerID =
    existingSO
      ? existingSO["Customer ID"]
      : null;

  const oldAmount =
    existingSO
      ? Number(existingSO["Total SO Amount"]) || 0
      : 0;

  /*
   * Save the Sales Order and its details through
   * the generic Document Engine.
   */
  const saveResult =
    Document_save(
      "SalesOrder",
      payload
    );

  /*
   * NEW SO
   */
  if (!existingSO) {

    soAdjustAggregate_(
      "Customers",
      "Customer ID",
      newCustomerID,
      "Total Sales",
      newAmount
    );

    return {
      success: true,
      action: "inserted",
      customerAdjustment: {
        customerID: newCustomerID,
        delta: newAmount
      },
      document: saveResult
    };
  }

  /*
   * EDIT — CUSTOMER DID NOT CHANGE
   */
  if (
    String(oldCustomerID) ===
    String(newCustomerID)
  ) {

    const delta =
      newAmount - oldAmount;

    if (delta !== 0) {

      soAdjustAggregate_(
        "Customers",
        "Customer ID",
        newCustomerID,
        "Total Sales",
        delta
      );

    }

    return {
      success: true,
      action: "updated",
      customerAdjustment: {
        customerID: newCustomerID,
        delta: delta
      },
      document: saveResult
    };
  }

  /*
   * EDIT — CUSTOMER CHANGED
   *
   * Reverse the old customer's contribution,
   * then apply the new customer's contribution.
   */
  soAdjustAggregate_(
    "Customers",
    "Customer ID",
    oldCustomerID,
    "Total Sales",
    -oldAmount
  );

  soAdjustAggregate_(
    "Customers",
    "Customer ID",
    newCustomerID,
    "Total Sales",
    newAmount
  );

  return {
    success: true,
    action: "updated",
    customerAdjustment: {
      oldCustomerID: oldCustomerID,
      oldDelta: -oldAmount,
      newCustomerID: newCustomerID,
      newDelta: newAmount
    },
    document: saveResult
  };
}




