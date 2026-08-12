/**
 * ============================================================
 * Delivery Receipts Module
 * Version: 1.1.0-alpha
 *
 * Delivery Receipt = physical fulfillment.
 * It does NOT recognize revenue.
 *
 * IMPORTANT TRANSACTION RULE
 * --------------------------
 * Every write operation follows:
 *
 *   VALIDATE -> PLAN -> COMMIT
 *
 * All business/data-integrity validation must complete before
 * any Repository insert/update/delete or Document save/delete.
 *
 * The integration delta is calculated once and then applied once.
 * In particular, inventory must never be updated during validation.
 * ============================================================
 */

const DR_HEADER_TABLE = "DeliveryReceipts";
const DR_DETAIL_TABLE = "DeliveryDetails";
const DR_SO_TABLE = "SalesOrders";
const DR_SD_TABLE = "SalesDetails";
const DR_CUSTOMER_TABLE = "Customers";
const DR_INVENTORY_TABLE = "Inventory";
const DR_CUSTOMER_TOTAL_FIELD = "Total Deliveries";
const DR_DEFAULT_STATUS = "Open";

const SO_DEFAULT_STATUS = "Open";
/* ============================================================
 * READ APIs
 * ============================================================ */

function drGetAllDR() {
  const tz = Session.getScriptTimeZone();

  return Repository_getRows(DR_HEADER_TABLE).map(row => {
    const result = Object.assign({}, row);

    if (result["DR Date"] instanceof Date) {
      result["DR Date"] =
        Utilities.formatDate(result["DR Date"], tz, "MM/dd/yyyy");
    }

    return result;
  });
}

function drGetCustomers() {
  return Repository_getRows(DR_CUSTOMER_TABLE);
}

function drGetOpenSalesOrders(customerID, currentDRID) {
  drRequireCustomer_(customerID);

  let currentSOID = "";

  if (currentDRID) {
    const currentDR =
      Repository_getById(DR_HEADER_TABLE, currentDRID);

    if (currentDR) {
      currentSOID = String(currentDR["SO ID"] || "");
    }
  }

  return Repository_getRows(DR_SO_TABLE)
    .filter(row => {
      const sameCustomer =
        String(row["Customer ID"]) === String(customerID);

      const status =
        String(row["SO Status"] || "Open").trim();

      const isCurrentSO =
        currentSOID &&
        String(row["SO ID"]) === currentSOID;

      return (
        sameCustomer &&
        (status !== "Fulfilled" || isCurrentSO)
      );
    })
    .map(row => {
      const result = Object.assign({}, row);

      if (result["SO Date"] instanceof Date) {
        result["SO Date"] =
          Utilities.formatDate(
            result["SO Date"],
            Session.getScriptTimeZone(),
            "yyyy-MM-dd"
          );
      }

      return result;
    });
}

function drGetOutstandingSalesDetails(soID, currentDRID) {
  drRequireSalesOrder_(soID);

  const currentDetailIDs = {};

  if (currentDRID) {
    Repository_getRows(DR_DETAIL_TABLE)
      .filter(row =>
        String(row["DR ID"]) === String(currentDRID)
      )
      .forEach(row => {
        const id =
          String(row["Sales Detail ID"] || "").trim();

        if (id) currentDetailIDs[id] = true;
      });
  }

  return Repository_getRows(DR_SD_TABLE)
    .filter(row => {
      if (String(row["SO ID"]) !== String(soID)) {
        return false;
      }

      const balance =
        Number(row["QTY Balance"]) || 0;

      const isCurrentDRLine =
        !!currentDetailIDs[
          String(row["Detail ID"] || "")
        ];

      return balance !== 0 || isCurrentDRLine;
    })
    .map(row => {
      const result = Object.assign({}, row);

      if (result["SO Date"] instanceof Date) {
        result["SO Date"] =
          Utilities.formatDate(
            result["SO Date"],
            Session.getScriptTimeZone(),
            "yyyy-MM-dd"
          );
      }

      return result;
    });
}

function drGetDeliveryReceipt(drID) {
  if (!drID) {
    throw new Error("Delivery Receipt ID is required.");
  }

  const tz = Session.getScriptTimeZone();

  const header =
    Repository_getById(DR_HEADER_TABLE, drID);

  if (!header) {
    throw new Error(
      `Delivery Receipt not found: ${drID}`
    );
  }

  const details =
    Repository_getRows(DR_DETAIL_TABLE)
      .filter(row =>
        String(row["DR ID"]) === String(drID)
      );

  const safeHeader =
    Object.assign({}, header);

  if (safeHeader["DR Date"] instanceof Date) {
    safeHeader["DR Date"] =
      Utilities.formatDate(
        safeHeader["DR Date"],
        tz,
        "yyyy-MM-dd"
      );
  }

  const safeDetails =
    details.map(row => {
      const result = Object.assign({}, row);

      if (result["DR Date"] instanceof Date) {
        result["DR Date"] =
          Utilities.formatDate(
            result["DR Date"],
            tz,
            "yyyy-MM-dd"
          );
      }

      return result;
    });

  console.log(JSON.stringify({
    diagnostic: "DR_GET_DELIVERY_RECEIPT",
    drID: drID,
    headerReturned: !!safeHeader,
    detailCount: safeDetails.length
  }));

  return {
    header: safeHeader,
    details: safeDetails
  };
}

/* ============================================================
 * ID / VALIDATION HELPERS
 * ============================================================ */

function drGenerateDRID() {
  const rows =
    Repository_getRows(DR_HEADER_TABLE);

  let max = 0;

  rows.forEach(row => {
    const match =
      String(row["DR ID"] || "")
        .trim()
        .match(/^DR-(\d+)$/i);

    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  });

  return `DR-${String(max + 1).padStart(4, "0")}`;
}

function drRequireCustomer_(id) {
  if (!id) {
    throw new Error("Customer is required.");
  }

  const row =
    Repository_getById(DR_CUSTOMER_TABLE, id);

  if (!row) {
    throw new Error(`Customer not found: ${id}`);
  }

  return row;
}

function drRequireSalesOrder_(id) {
  if (!id) {
    throw new Error("Sales Order is required.");
  }

  const row =
    Repository_getById(DR_SO_TABLE, id);

  if (!row) {
    throw new Error(`Sales Order not found: ${id}`);
  }

  return row;
}

function drValidateSOCustomer_(so, customerID) {
  if (
    String(so["Customer ID"]) !==
    String(customerID)
  ) {
    throw new Error(
      `Sales Order ${so["SO ID"]} does not belong to customer ${customerID}.`
    );
  }
}

function drNormalizePayloadDetails_(payload) {
  if (!payload || !payload.details) {
    return [];
  }

  if (Array.isArray(payload.details)) {
    return payload.details;
  }

  if (
    Array.isArray(
      payload.details[DR_DETAIL_TABLE]
    )
  ) {
    return payload.details[DR_DETAIL_TABLE];
  }

  return [];
}

// CHANGED: delegates to drCalculateStatusFromRows_() instead of
// duplicating the Open / Partially Fulfilled / Fulfilled logic.
// drCalculateStatusFromRows_() (defined later in this file) remains
// the single source of truth for that logic.
function drCalculateStatus_(
  soID
) {
  const rows =
    Repository_getRows(DR_SD_TABLE);

  return drCalculateStatusFromRows_(
    rows,
    soID
  );
}

/* ============================================================
 * LOGGING
 * ============================================================ */

function drLogUpdate_(
  table,
  primaryKeyField,
  primaryKeyValue,
  fields,
  reason
) {
  console.log(JSON.stringify({
    diagnostic: "DR_RELATED_TABLE_UPDATE",
    table,
    primaryKeyField,
    primaryKeyValue,
    fields: fields || {},
    reason:
      reason ||
      "Delivery Receipt integration"
  }));
}

/* ============================================================
 * AMOUNT / DELTA HELPERS
 * ============================================================ */

function drCalculateLineAmount_(
  source,
  deliveredQty
) {
  const orderedQty =
    Number(source["QTY Ordered"]) || 0;

  const totalSalesAmount =
    Number(source["Total Sales Amount"]) || 0;

  const qty =
    Number(deliveredQty) || 0;

  if (orderedQty <= 0 || qty <= 0) {
    return 0;
  }

  const deliveryRatio =
    qty / orderedQty;

  return Math.round(
    (
      totalSalesAmount *
      deliveryRatio +
      Number.EPSILON
    ) * 100
  ) / 100;
}

function drCalculateAmount_(
  sourceByID,
  lines
) {
  let amount = 0;

  (lines || []).forEach(line => {
    const detailID =
      String(line["Sales Detail ID"] || "");

    const source =
      sourceByID[detailID];

    if (!source) {
      throw new Error(
        `Sales Detail ${detailID} not found while calculating DR amount.`
      );
    }

    amount +=
      drCalculateLineAmount_(
        source,
        Number(line["QTY Delivered"])
      );
  });

  return amount;
}

function drAggregateQty_(rows) {
  const map = {};

  (rows || []).forEach(row => {
    const id =
      String(row["Sales Detail ID"] || "")
        .trim();

    if (!id) {
      return;
    }

    map[id] =
      (Number(map[id]) || 0) +
      (Number(row["QTY Delivered"]) || 0);
  });

  return map;
}

function drBuildDeliveryDelta_(
  oldRows,
  newRows
) {
  const oldMap =
    drAggregateQty_(oldRows);

  const newMap =
    drAggregateQty_(newRows);

  const ids =
    Object.assign({}, oldMap, newMap);

  const delta = {};

  Object.keys(ids).forEach(id => {
    const d =
      (Number(newMap[id]) || 0) -
      (Number(oldMap[id]) || 0);

    if (d !== 0) {
      delta[id] = d;
    }
  });

  console.log(JSON.stringify({
    diagnostic: "DR_DELIVERY_DELTA",
    oldMap,
    newMap,
    delta
  }));

  return delta;
}

/* ============================================================
 * READ-ONLY INTEGRATION PLAN
 *
 * No Repository_update/insert/delete occurs anywhere in this
 * section.
 * ============================================================ */

function drBuildIntegrationPlan_(
  oldRows,
  newRows
) {
  const deltaBySalesDetail =
    drBuildDeliveryDelta_(
      oldRows,
      newRows
    );

  const salesDetails =
    Repository_getRows(DR_SD_TABLE);

  const byDetail = {};

  salesDetails.forEach(row => {
    byDetail[
      String(row["Detail ID"])
    ] = row;
  });

  const inventoryDelta = {};
  const salesDetailPlan = [];
  const inventoryPlan = [];

  Object.keys(deltaBySalesDetail)
    .forEach(detailID => {
      const delta =
        Number(deltaBySalesDetail[detailID]) || 0;

      const source =
        byDetail[detailID];

      if (!source) {
        throw new Error(
          `Sales Detail ${detailID} not found while validating delivery delta.`
        );
      }

      const oldDelivered =
        Number(source["QTY Delivered"]) || 0;

      const newDelivered =
        oldDelivered + delta;

      if (newDelivered < 0) {
        throw new Error(
          `Sales Detail ${detailID} would have negative delivered quantity.`
        );
      }

      const ordered =
        Number(source["QTY Ordered"]) || 0;

      if (newDelivered > ordered) {
        throw new Error(
          `Sales Detail ${detailID} would exceed ordered quantity.`
        );
      }

      const itemID =
        String(source["Item ID"] || "").trim();

      if (!itemID) {
        throw new Error(
          `Sales Detail ${detailID} has no Item ID.`
        );
      }

      inventoryDelta[itemID] =
        (Number(inventoryDelta[itemID]) || 0) +
        delta;

      salesDetailPlan.push({
        detailID,
        delta,
        oldDelivered,
        newDelivered
      });
    });

  Object.keys(inventoryDelta)
    .forEach(itemID => {
      const delta =
        Number(inventoryDelta[itemID]) || 0;

      const inventory =
        Repository_getById(
          DR_INVENTORY_TABLE,
          itemID
        );

      if (!inventory) {
        throw new Error(
          `Inventory item not found: ${itemID}`
        );
      }

      const oldOnHand =
        Number(inventory["QTY On-Hand"]) || 0;

      const oldAllocated =
        Number(inventory["QTY Allocated"]) || 0;

      const oldDelivered =
        Number(inventory["QTY Delivered"]) || 0;

      const newOnHand =
        oldOnHand - delta;

      const newAllocated =
        oldAllocated - delta;

      const newDelivered =
        oldDelivered + delta;

      if (newOnHand < 0) {
        throw new Error(
          `Inventory item ${itemID} does not have enough on-hand quantity for this delivery.`
        );
      }

      if (newAllocated < 0) {
        throw new Error(
          `Inventory item ${itemID} does not have enough allocated quantity to release.`
        );
      }

      if (newDelivered < 0) {
        throw new Error(
          `Inventory item ${itemID} would have negative QTY Delivered.`
        );
      }

      inventoryPlan.push({
        itemID,
        delta,
        oldOnHand,
        oldAllocated,
        oldDelivered,
        newOnHand,
        newAllocated,
        newDelivered
      });
    });

  return {
    salesDetailDelta: deltaBySalesDetail,
    inventoryDelta,
    salesDetailPlan,
    inventoryPlan
  };
}

function drValidateCustomerAggregatePlan_(
  customerID,
  amountDelta
) {
  const customer =
    drRequireCustomer_(customerID);

  const oldValue =
    Number(
      customer[DR_CUSTOMER_TOTAL_FIELD]
    ) || 0;

  const newValue =
    oldValue + Number(amountDelta || 0);

  if (newValue < 0) {
    throw new Error(
      `Customer ${customerID} would have negative ${DR_CUSTOMER_TOTAL_FIELD}.`
    );
  }

  return {
    customerID,
    oldValue,
    delta: Number(amountDelta || 0),
    newValue
  };
}

function drBuildSOStatusPlan_(
  soID
) {
  const row =
    drRequireSalesOrder_(soID);

  // CHANGED: second fallback now uses SO_DEFAULT_STATUS (was
  // DR_DEFAULT_STATUS) — this value is Sales Order status domain.
  const oldStatus =
    String(
      row["SO Status"] ||
      SO_DEFAULT_STATUS
    ).trim() ||
    SO_DEFAULT_STATUS;

  const newStatus =
    drCalculateStatus_(soID);

  return {
    soID,
    oldStatus,
    newStatus,
    changed: oldStatus !== newStatus
  };
}

/* ============================================================
 * WRITE / COMMIT HELPERS
 * ============================================================ */

function drApplySalesDetailDelta_(
  salesDetailID,
  delta
) {
  if (!delta) {
    return;
  }

  const row =
    Repository_getById(
      DR_SD_TABLE,
      salesDetailID
    );

  if (!row) {
    throw new Error(
      `Sales Detail not found: ${salesDetailID}`
    );
  }

  const oldValue =
    Number(row["QTY Delivered"]) || 0;

  const newValue =
    oldValue + Number(delta);

  // Defensive check. Primary validation should already have
  // occurred in drBuildIntegrationPlan_().
  if (newValue < 0) {
    throw new Error(
      `Sales Detail ${salesDetailID} would have negative delivered quantity.`
    );
  }

  drLogUpdate_(
    DR_SD_TABLE,
    "Detail ID",
    salesDetailID,
    {
      "QTY Delivered": {
        oldValue,
        delta: Number(delta),
        newValue
      },
      "QTY Balance": {
        persisted: false,
        formula:
          "QTY Ordered - QTY Delivered"
      }
    },
    "Delivery Receipt fulfillment"
  );

  Repository_update(
    DR_SD_TABLE,
    {
      "Detail ID": salesDetailID,
      "QTY Delivered": newValue
    }
  );
}

function drApplyInventoryPlan_(
  plan
) {
  if (!plan || !plan.length) {
    return;
  }

  plan.forEach(entry => {
    const {
      itemID,
      delta,
      oldOnHand,
      oldAllocated,
      oldDelivered,
      newOnHand,
      newAllocated,
      newDelivered
    } = entry;

    console.log(JSON.stringify({
      diagnostic:
        "DR_INVENTORY_DELTA_DISPATCH",
      itemID,
      delta,
      inventoryDeltaKeys:
        plan.map(x => x.itemID),
      inventoryDelta:
        plan.reduce((map, x) => {
          map[x.itemID] = x.delta;
          return map;
        }, {})
    }));

    drLogUpdate_(
      DR_INVENTORY_TABLE,
      "Item ID",
      itemID,
      {
        "QTY On-Hand": {
          oldValue: oldOnHand,
          delta: -delta,
          newValue: newOnHand
        },
        "QTY Allocated": {
          oldValue: oldAllocated,
          delta: -delta,
          newValue: newAllocated
        },
        "QTY Delivered": {
          oldValue: oldDelivered,
          delta,
          newValue: newDelivered
        },
        "QTY Available": {
          persisted: false,
          formula:
            "QTY On-Hand - QTY Allocated"
        }
      },
      "Delivery Receipt fulfillment"
    );

    Repository_update(
      DR_INVENTORY_TABLE,
      {
        "Item ID": itemID,
        "QTY On-Hand": newOnHand,
        "QTY Allocated": newAllocated,
        "QTY Delivered": newDelivered
      }
    );

    console.log(JSON.stringify({
      diagnostic:
        "DR_INVENTORY_DELTA_DISPATCH_COMPLETE",
      itemID,
      delta
    }));
  });
}

function drApplyCustomerAggregatePlan_(
  plan
) {
  if (!plan || !plan.delta) {
    return;
  }

  drLogUpdate_(
    DR_CUSTOMER_TABLE,
    "Customer ID",
    plan.customerID,
    {
      [DR_CUSTOMER_TOTAL_FIELD]: {
        oldValue: plan.oldValue,
        delta: plan.delta,
        newValue: plan.newValue
      }
    },
    "Delivery Receipt aggregate"
  );

  Repository_update(
    DR_CUSTOMER_TABLE,
    {
      "Customer ID": plan.customerID,
      [DR_CUSTOMER_TOTAL_FIELD]:
        plan.newValue
    }
  );
}

function drApplySOStatusPlan_(
  plan
) {
  if (!plan || !plan.changed) {
    return plan ? plan.newStatus : null;
  }

  drLogUpdate_(
    DR_SO_TABLE,
    "SO ID",
    plan.soID,
    {
      "SO Status": {
        oldValue: plan.oldStatus,
        delta: null,
        newValue: plan.newStatus
      }
    },
    "Delivery Receipt fulfillment status"
  );

  Repository_update(
    DR_SO_TABLE,
    {
      "SO ID": plan.soID,
      "SO Status": plan.newStatus
    }
  );

  return plan.newStatus;
}

/*
 * Backward-compatible single-call integration helper.
 *
 * IMPORTANT: This is now a COMMIT function. It assumes that the
 * caller has already completed drBuildIntegrationPlan_() validation.
 */

/*
 * Reconciliation diagnostic for Google Sheets multi-step commits.
 *
 * Google Sheets does not provide a cross-sheet transaction. If a commit
 * fails after one or more writes have succeeded, the complete plan must
 * remain available for manual reconciliation.
 */
// CHANGED: added an explicit "message" field so a reader of the log
// (who may not have this file open) knows this diagnostic does NOT
// mean the transaction was rolled back — Sheets has no cross-sheet
// transaction, so some writes may already have landed.
function drLogPartialCommitFailure_(
  context,
  error,
  plan
) {
  const payload = {
    diagnostic:
      "DR_PARTIAL_COMMIT_FAILURE",

    timestamp:
      new Date().toISOString(),

    context:
      context || "",

    error:
      error && error.message
        ? error.message
        : String(error),

    plan:
      plan || null,

    message:
      "A multi-step Google Sheets commit failed after one or more writes may have occurred. Manual reconciliation may be required."
  };

  console.error(
    JSON.stringify(payload)
  );
}

// CHANGED: added defensive shape checks. These are purely structural
// (cannot produce a different business decision than the plan already
// contains) and guard against this COMMIT-only function ever being
// called with a malformed plan that bypassed drBuildIntegrationPlan_().
function drApplyIntegrationPlan_(
  integrationPlan
) {
  if (!integrationPlan) {
    throw new Error(
      "Delivery Receipt integration plan is required."
    );
  }

  if (!Array.isArray(
    integrationPlan.salesDetailPlan
  )) {
    throw new Error(
      "Delivery Receipt Sales Detail integration plan is invalid."
    );
  }

  if (!Array.isArray(
    integrationPlan.inventoryPlan
  )) {
    throw new Error(
      "Delivery Receipt Inventory integration plan is invalid."
    );
  }

  /*
   * IMPORTANT:
   *
   * This function is COMMIT only.
   *
   * All business validation must already have been
   * completed by drBuildIntegrationPlan_().
   *
   * No validation that can reject the transaction
   * should be introduced here unless it is purely
   * defensive and cannot produce a different business
   * decision from the previously validated plan.
   */

  integrationPlan.salesDetailPlan
    .forEach(entry => {
      drApplySalesDetailDelta_(
        entry.detailID,
        entry.delta
      );
    });

  drApplyInventoryPlan_(
    integrationPlan.inventoryPlan
  );

  return {
    salesDetailDelta:
      integrationPlan.salesDetailDelta,
    inventoryDelta:
      integrationPlan.inventoryDelta
  };
}

/*
 * Retained for compatibility with existing module calls.
 * It now performs PLAN + COMMIT in one function, but all
 * validation occurs before the first write.
 */
function drApplyIntegrationDelta_(
  oldRows,
  newRows
) {
  const plan =
    drBuildIntegrationPlan_(
      oldRows,
      newRows
    );

  return drApplyIntegrationPlan_(
    plan
  );
}

/* ============================================================
 * BUILD DOCUMENT PAYLOAD
 * ============================================================ */

function drBuildDocument_(
  master,
  lines,
  persistedByID,
  drID,
  customer,
  so
) {
  const drDate =
    master["DR Date"] ||
    Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    );

  const sourceDetails = {};

  lines.forEach(line => {
    const id =
      String(
        line["Sales Detail ID"] || ""
      );

    const source =
      persistedByID[id];

    if (source) {
      sourceDetails[id] = source;
    }
  });

  const amount =
    drCalculateAmount_(
      sourceDetails,
      lines
    );

  const header = {
    "DR Date": drDate,
    "DR ID": drID,
    "Customer ID":
      String(master["Customer ID"] || ""),
    "Customer Name":
      customer["Customer Name"] || "",
    "State":
      customer["State"] || "",
    "City":
      customer["City"] || "",
    "SO ID":
      String(master["SO ID"] || ""),
    "Invoice Num":
      master["Invoice Num"] ||
      so["Invoice Num"] ||
      "",
    "DR Status":
      String(
        master["DR Status"] ||
        DR_DEFAULT_STATUS
      ),
    "DR Amount": amount
  };

  const details =
    lines.map((line, index) => {
      const source =
        persistedByID[
          String(
            line["Sales Detail ID"]
          )
        ];

      return {
        "DR Date": drDate,
        "DR ID": drID,
        "Customer ID":
          header["Customer ID"],
        "Customer Name":
          header["Customer Name"],
        "State":
          header["State"],
        "City":
          header["City"],
        "SO ID":
          header["SO ID"],
        "Invoice Num":
          header["Invoice Num"],
        "SO DR Detail ID":
          line["SO DR Detail ID"] ||
          `${drID}-${String(index + 1).padStart(2, "0")}`,
        "Sales Detail ID":
          source["Detail ID"],
        "Item ID":
          source["Item ID"],
        "Item Name":
          source["Item Name"],
        "QTY Ordered":
          Number(source["QTY Ordered"]) || 0,
        "QTY Delivered":
          Number(line["QTY Delivered"]) || 0,
        "QTY Balance":
          Number(source["QTY Balance"]) || 0
      };
    });

  return {
    master: header,
    details: {
      [DR_DETAIL_TABLE]: details
    },
    amount
  };
}

/* ============================================================
 * SAVE / EDIT
 *
 * VALIDATE -> PLAN -> COMMIT
 * ============================================================ */


/*
 * Delivery Receipt mutation guard.
 *
 * Open DRs may be edited.
 * Invoiced and Cancelled DRs are immutable.
 *
 * Physical delete is retained only for the current transition period;
 * the long-term workflow is Cancel rather than Delete.
 */
function drAssertMutableStatus_(header, drID, action) {
  const status = String(
    header && header["DR Status"] || DR_DEFAULT_STATUS
  ).trim();

  if (status === "Invoiced") {
    throw new Error(
      `Delivery Receipt ${drID} is Invoiced and cannot be ${action || "modified"}.`
    );
  }

  if (status === "Cancelled") {
    throw new Error(
      `Delivery Receipt ${drID} is Cancelled and cannot be ${action || "modified"}.`
    );
  }
}

function drSaveDeliveryReceipt(payload) {
  if (
    !payload ||
    typeof payload !== "object"
  ) {
    throw new Error(
      "Delivery Receipt payload is required."
    );
  }

  if (
    !payload.master ||
    typeof payload.master !== "object"
  ) {
    throw new Error(
      "Delivery Receipt header is required."
    );
  }

  const master = payload.master;

  const submittedLines =
    drNormalizePayloadDetails_(payload);

  if (!submittedLines.length) {
    throw new Error(
      "Delivery Receipt must contain at least one detail row."
    );
  }

  const lock =
    LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      "Could not acquire transaction lock. Another transaction is in progress."
    );
  }

  // FIX: declared here (not `const` inside the try block) so the
  // catch block below can still reference them for diagnostic logging.
  // A `const` declared inside `try {}` is out of scope in `catch {}`
  // in JS, which was throwing a ReferenceError and masking the real
  // commit error entirely.
  let integrationPlan;
  let customerID;
  let soID;
  let drID;
  let oldAmount;
  let newAmount;
  let customerPlan;
  let statusPlan;

  // CHANGED: tracks which commit stage was in flight when a failure
  // occurred. Starts as "VALIDATE_PLAN" because steps 1-4 below don't
  // write anything yet — a failure there is a validation failure, not
  // a partial commit, and the diagnostic should say so honestly.
  let commitStage = "VALIDATE_PLAN";

  try {
    /* ------------------------------
     * 1. READ CURRENT STATE
     * ------------------------------ */

    customerID =
      String(
        master["Customer ID"] || ""
      ).trim();

    soID =
      String(
        master["SO ID"] || ""
      ).trim();

    if (!customerID) {
      throw new Error("Customer is required.");
    }

    if (!soID) {
      throw new Error(
        "Sales Order is required."
      );
    }

    const customer =
      drRequireCustomer_(customerID);

    const so =
      drRequireSalesOrder_(soID);

    drValidateSOCustomer_(
      so,
      customerID
    );

    const requestedDRID =
      String(
        master["DR ID"] || ""
      ).trim();

    drID =
      requestedDRID ||
      drGenerateDRID();

    const existingHeader =
      Repository_getById(
        DR_HEADER_TABLE,
        drID
      );

    const isEdit =
      !!existingHeader;

    // FIX: only assert mutability on the edit path. Calling this
    // unconditionally relied on DR_DEFAULT_STATUS staying a "safe"
    // fallback for the null-header (new DR) case, which was implicit
    // rather than intentional.
    if (isEdit) {
      drAssertMutableStatus_(
        existingHeader,
        drID,
        "modified"
      );
    }

    if (
      !isEdit &&
      String(
        so["SO Status"] || "Open"
      ).trim() === "Fulfilled"
    ) {
      throw new Error(
        `Sales Order ${soID} is already Fulfilled.`
      );
    }

    if (
      isEdit &&
      String(
        existingHeader["SO ID"]
      ) !== String(soID)
    ) {
      throw new Error(
        "Changing the Sales Order on an existing Delivery Receipt is not allowed."
      );
    }

    const oldRows =
      isEdit
        ? Repository_getRows(
            DR_DETAIL_TABLE
          ).filter(r =>
            String(r["DR ID"]) ===
            String(drID)
          )
        : [];

    if (
      isEdit &&
      !oldRows.length
    ) {
      throw new Error(
        `Delivery Receipt ${drID} has no detail rows.`
      );
    }

    const persistedDetails =
      Repository_getRows(
        DR_SD_TABLE
      );

    const byID = {};

    persistedDetails.forEach(row => {
      byID[
        String(row["Detail ID"])
      ] = row;
    });

    /* ------------------------------
     * 2. VALIDATE SUBMITTED LINES
     * ------------------------------ */

    const seen = {};

    const validated =
      submittedLines.map(
        (line, index) => {
          const sdID =
            String(
              line["Sales Detail ID"] || ""
            ).trim();

          if (!sdID) {
            throw new Error(
              `Sales Detail ID is missing at row ${index + 1}.`
            );
          }

          if (seen[sdID]) {
            throw new Error(
              `Duplicate Sales Detail ID ${sdID}.`
            );
          }

          seen[sdID] = true;

          const source =
            byID[sdID];

          if (!source) {
            throw new Error(
              `Sales Detail ${sdID} was not found.`
            );
          }

          if (
            String(source["SO ID"]) !==
            String(soID)
          ) {
            throw new Error(
              `Sales Detail ${sdID} does not belong to Sales Order ${soID}.`
            );
          }

          const oldForThisLine =
            oldRows.find(r =>
              String(
                r["Sales Detail ID"]
              ) === sdID
            );

          const persistedBalance =
            Number(
              source["QTY Balance"]
            ) || 0;

          const previousDRQty =
            oldForThisLine
              ? Number(
                  oldForThisLine[
                    "QTY Delivered"
                  ]
                ) || 0
              : 0;

          const allowableBalance =
            persistedBalance +
            previousDRQty;

          const qty =
            Number(
              line["QTY Delivered"]
            );

          if (
            !Number.isFinite(qty) ||
            qty <= 0
          ) {
            throw new Error(
              `Delivery quantity for ${sdID} must be greater than zero.`
            );
          }

          if (
            qty > allowableBalance
          ) {
            throw new Error(
              `Delivery quantity for ${sdID} cannot exceed ${allowableBalance}.`
            );
          }

          return Object.assign(
            {},
            line,
            {
              "Sales Detail ID": sdID,
              "QTY Delivered": qty
            }
          );
        }
      );

    /* ------------------------------
     * 3. BUILD READ-ONLY INTEGRATION PLAN
     * ------------------------------ */

    // FIX: assign (no `const`) — see declaration above the try block.
    integrationPlan =
      drBuildIntegrationPlan_(
        oldRows,
        validated
      );

    /* ------------------------------
     * 4. BUILD DOCUMENT
     *
     * Still no writes.
     * ------------------------------ */

    master["DR Status"] =
      isEdit
        ? String(
            existingHeader["DR Status"] ||
            DR_DEFAULT_STATUS
          )
        : DR_DEFAULT_STATUS;

    const documentPayload =
      drBuildDocument_(
        master,
        validated,
        byID,
        drID,
        customer,
        so
      );

    oldAmount =
      isEdit
        ? Number(
            existingHeader["DR Amount"]
          ) || 0
        : 0;

    newAmount =
      Number(
        documentPayload.master[
          "DR Amount"
        ]
      ) || 0;

    customerPlan =
      drValidateCustomerAggregatePlan_(
        customerID,
        newAmount - oldAmount
      );

    /*
     * Status is calculated from current SalesDetails.
     *
     * For the prospective status, calculate using the
     * planned delivered quantities rather than persisted
     * values. This keeps validation read-only.
     */
    const prospectiveRows =
      persistedDetails.map(row => {
        const change =
          integrationPlan
            .salesDetailDelta[
              String(row["Detail ID"])
            ] || 0;

        if (!change) {
          return row;
        }

        return Object.assign(
          {},
          row,
          {
            "QTY Delivered":
              (Number(
                row["QTY Delivered"]
              ) || 0) + change
          }
        );
      });

    // CHANGED: second fallback now uses SO_DEFAULT_STATUS (was
    // DR_DEFAULT_STATUS) — this value is Sales Order status domain.
    const oldStatus =
      String(
        so["SO Status"] ||
        SO_DEFAULT_STATUS
      ).trim() ||
      SO_DEFAULT_STATUS;

    const prospectiveStatus =
      drCalculateStatusFromRows_(
        prospectiveRows,
        soID
      );

    statusPlan = {
      soID,
      oldStatus,
      newStatus: prospectiveStatus,
      changed:
        oldStatus !== prospectiveStatus
    };

    /*
     * IMPORTANT:
     * Everything above this point is read-only validation/
     * planning. No database mutation has occurred.
     */

    /* ------------------------------
     * 5. COMMIT
     *
     * Commit order is deliberate:
     *
     *   1. Delivery Receipt document
     *   2. Sales Details
     *   3. Inventory
     *   4. Customer aggregate
     *   5. Sales Order status
     *
     * Google Sheets has no cross-sheet transaction.
     * Therefore the commit stage is tracked in commitStage
     * (declared above the try block) so that a partial
     * failure can be reconciled from the diagnostic log.
     * ------------------------------ */

    commitStage = "DOCUMENT_SAVE";

    const documentResult =
      Document_save(
        "DeliveryReceipt",
        documentPayload
      );

    commitStage = "INTEGRATION";

    const integration =
      drApplyIntegrationPlan_(
        integrationPlan
      );

    commitStage = "CUSTOMER_AGGREGATE";

    drApplyCustomerAggregatePlan_(
      customerPlan
    );

    commitStage = "SO_STATUS";

    const status =
      drApplySOStatusPlan_(
        statusPlan
      );

    console.log(JSON.stringify({
      diagnostic:
        "DELIVERY_RECEIPT_SAVE",
      action:
        isEdit
          ? "updated"
          : "inserted",
      drID,
      soID,
      customerID,
      drStatus:
        documentPayload.master[
          "DR Status"
        ],
      oldAmount,
      newAmount,
      deliveryDelta:
        integrationPlan
          .salesDetailDelta,
      inventoryDelta:
        integrationPlan
          .inventoryDelta,
      soStatus: status
    }));

    return {
      success: true,
      action:
        isEdit
          ? "updated"
          : "inserted",
      drID,
      drStatus:
        documentPayload.master[
          "DR Status"
        ],
      drAmount: newAmount,
      soID,
      soStatus: status,
      document: documentResult,
      integration
    };

  } catch (error) {

    // CHANGED: single catch (no nested try/catch around the commit
    // section) so a commit failure is logged exactly once, tagged
    // with the specific stage that was in flight, and carries the
    // full plan bundle for reconciliation.
    drLogPartialCommitFailure_(
      `drSaveDeliveryReceipt:${commitStage}`,
      error,
      {
        integrationPlan,
        customerPlan,
        statusPlan,
        drID,
        soID,
        customerID,
        oldAmount,
        newAmount
      }
    );

    throw error;

  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * DELETE
 *
 * VALIDATE -> PLAN -> COMMIT
 * ============================================================ */

function drDeleteDeliveryReceipt(drID) {
  if (!drID) {
    throw new Error(
      "Delivery Receipt ID is required."
    );
  }

  const lock =
    LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      "Could not acquire transaction lock."
    );
  }

  // FIX: see drSaveDeliveryReceipt — declared outside the try block
  // so the catch block's diagnostic logging can reference them.
  let integrationPlan;
  let soID;
  let customerID;
  let customerPlan;
  let statusPlan;
  let drAmount;

  // CHANGED: tracks which commit stage was in flight when a failure
  // occurred. Starts as "VALIDATE_PLAN" because step 1-2 below don't
  // write anything yet.
  let commitStage = "VALIDATE_PLAN";

  try {
    /* ------------------------------
     * 1. READ CURRENT STATE
     * ------------------------------ */

    const header =
      Repository_getById(
        DR_HEADER_TABLE,
        drID
      );

    if (!header) {
      throw new Error(
        `Delivery Receipt not found: ${drID}`
      );
    }

    // FIX: Delete previously had no status guard at all, so an
    // Invoiced (or, once Cancel lands, Cancelled) DR could be
    // deleted, silently reversing SalesDetails/Inventory/Customer
    // totals out from under a Sales Invoice that still references it.
    drAssertMutableStatus_(
      header,
      drID,
      "deleted"
    );

    const oldRows =
      Repository_getRows(
        DR_DETAIL_TABLE
      ).filter(r =>
        String(r["DR ID"]) ===
        String(drID)
      );

    if (!oldRows.length) {
      throw new Error(
        `Delivery Receipt ${drID} has no detail rows.`
      );
    }

    soID =
      String(
        header["SO ID"] || ""
      ).trim();

    customerID =
      String(
        header["Customer ID"] || ""
      ).trim();

    if (!soID) {
      throw new Error(
        `Delivery Receipt ${drID} has no Sales Order ID.`
      );
    }

    if (!customerID) {
      throw new Error(
        `Delivery Receipt ${drID} has no Customer ID.`
      );
    }

    const customer =
      drRequireCustomer_(customerID);

    const so =
      drRequireSalesOrder_(soID);

    drValidateSOCustomer_(
      so,
      customerID
    );

    /* ------------------------------
     * 2. BUILD READ-ONLY PLAN
     * ------------------------------ */

    const deliveryDelta =
      drBuildDeliveryDelta_(
        oldRows,
        []
      );

    // FIX: assign (no `const`) — see declaration above the try block.
    integrationPlan =
      drBuildIntegrationPlan_(
        oldRows,
        []
      );

    drAmount =
      Number(
        header["DR Amount"]
      ) || 0;

    customerPlan =
      drValidateCustomerAggregatePlan_(
        customerID,
        -drAmount
      );

    const salesDetails =
      Repository_getRows(
        DR_SD_TABLE
      );

    const prospectiveRows =
      salesDetails.map(row => {
        const change =
          integrationPlan
            .salesDetailDelta[
              String(row["Detail ID"])
            ] || 0;

        if (!change) {
          return row;
        }

        return Object.assign(
          {},
          row,
          {
            "QTY Delivered":
              (Number(
                row["QTY Delivered"]
              ) || 0) + change
          }
        );
      });

    // CHANGED: second fallback now uses SO_DEFAULT_STATUS (was
    // DR_DEFAULT_STATUS) — this value is Sales Order status domain.
    const oldStatus =
      String(
        so["SO Status"] ||
        SO_DEFAULT_STATUS
      ).trim() ||
      SO_DEFAULT_STATUS;

    const prospectiveStatus =
      drCalculateStatusFromRows_(
        prospectiveRows,
        soID
      );

    statusPlan = {
      soID,
      oldStatus,
      newStatus: prospectiveStatus,
      changed:
        oldStatus !== prospectiveStatus
    };

    /*
     * No write has occurred yet.
     *
     * In particular, the inventory validation is performed
     * inside drBuildIntegrationPlan_(), which only reads rows
     * and calculates resulting values.
     */

    /* ------------------------------
     * 3. COMMIT
     *
     * Delete order is deliberate:
     *
     *   1. Sales Details
     *   2. Inventory
     *   3. Customer aggregate
     *   4. Sales Order status
     *   5. Delivery Receipt document deletion
     *
     * The Delivery Receipt remains available as the
     * reconciliation anchor until every related table
     * has been successfully updated — it is deleted last,
     * not first.
     *
     * RETRY WARNING: if a failure leaves the DR undeleted
     * after SalesDetails/Inventory/Customer/SO Status have
     * already been reversed (commitStage past "INTEGRATION"),
     * do NOT blindly retry drDeleteDeliveryReceipt(drID). The
     * reversal would be recalculated and re-applied against
     * already-reversed rows, which drBuildIntegrationPlan_'s
     * negative-quantity guard will often — but is not
     * guaranteed to — catch. Verify the DR_PARTIAL_COMMIT_FAILURE
     * log and reconcile manually before retrying.
     * ------------------------------ */

    commitStage = "INTEGRATION";

    const integration =
      drApplyIntegrationPlan_(
        integrationPlan
      );

    commitStage = "CUSTOMER_AGGREGATE";

    drApplyCustomerAggregatePlan_(
      customerPlan
    );

    commitStage = "SO_STATUS";

    const status =
      drApplySOStatusPlan_(
        statusPlan
      );

    commitStage = "DOCUMENT_DELETE";

    const result =
      Document_delete(
        "DeliveryReceipt",
        drID
      );

    console.log(JSON.stringify({
      diagnostic:
        "DELIVERY_RECEIPT_DELETE",
      drID,
      soID,
      customerID,
      drStatus:
        header["DR Status"] ||
        DR_DEFAULT_STATUS,
      deliveryDelta,
      inventoryDelta:
        integrationPlan.inventoryDelta,
      reversedAmount: drAmount,
      soStatus: status
    }));

    return {
      success: true,
      action: "deleted",
      drID,
      soID,
      customerID,
      soStatus: status,
      document: result,
      integration
    };

  } catch (error) {

    // CHANGED: single catch (no nested try/catch around the commit
    // section) so a commit failure is logged exactly once, tagged
    // with the specific stage that was in flight, and carries the
    // full plan bundle for reconciliation.
    drLogPartialCommitFailure_(
      `drDeleteDeliveryReceipt:${commitStage}`,
      error,
      {
        integrationPlan,
        customerPlan,
        statusPlan,
        drID,
        soID,
        customerID,
        reversedAmount: drAmount
      }
    );

    throw error;

  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * STATUS CALCULATION FROM AN IN-MEMORY ROW SET
 * ============================================================ */

function drCalculateStatusFromRows_(
  rows,
  soID
) {
  const soRows =
    (rows || []).filter(row =>
      String(row["SO ID"]) ===
      String(soID)
    );

  if (!soRows.length) {
    return "Open";
  }

  let ordered = 0;
  let delivered = 0;

  soRows.forEach(row => {
    ordered +=
      Number(row["QTY Ordered"]) || 0;

    delivered +=
      Number(row["QTY Delivered"]) || 0;
  });

  if (delivered <= 0) {
    return "Open";
  }

  if (
    ordered > 0 &&
    delivered >= ordered
  ) {
    return "Fulfilled";
  }

  return "Partially Fulfilled";
}

/* ============================================================
 * TEST / DIAGNOSTIC
 * ============================================================ */

function testDRView() {
  const drID = "DR-0002";

  const result =
    drGetDeliveryReceipt(drID);

  Logger.log(
    JSON.stringify(result)
  );

  return result;
}
