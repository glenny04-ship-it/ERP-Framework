/**
 * ============================================================
 * Sales Invoices Module
 * Version: 1.0.0
 *
 * Sales Invoice = Revenue Recognition.
 *
 * IMPORTANT TRANSACTION RULE
 * --------------------------
 * Every write operation follows:
 * VALIDATE -> PLAN -> COMMIT
 *
 * All business/data-integrity validation completes before
 * any Repository insert/update/delete or Document save/delete.
 * ============================================================
 */

const SI_TABLE = "SalesInvoices";
const SI_DR_TABLE = "DeliveryReceipts";
const SI_CUSTOMER_TABLE = "Customers";
const SI_CUSTOMER_TOTAL_FIELD = "Total Sales";
const SI_DR_INVOICED_FIELD = "DR Invoiced";
const SI_DEFAULT_STATUS = "Open";

/* ============================================================
 * READ APIs
 * ============================================================ */

/**
 * Retrieves all Sales Invoices with formatted dates.
 */
function siGetAllSI() {
  const tz = Session.getScriptTimeZone();

  return Repository_getRows(SI_TABLE).map(row => {
    const result = Object.assign({}, row);

    if (result["SI Date"] instanceof Date) {
      result["SI Date"] = Utilities.formatDate(result["SI Date"], tz, "MM/dd/yyyy");
    }

    return result;
  });
}

/**
 * Retrieves all customers.
 */
function siGetCustomers() {
  return Repository_getRows(SI_CUSTOMER_TABLE);
}

/**
 * Retrieves eligible Delivery Receipts for a customer.
 * Eligible DRs: DR Status !== 'Fulfilled' (or current DR being edited).
 */
function siGetEligibleDeliveryReceipts(customerID, currentSIID) {
  if (!customerID) {
    throw new Error("Customer ID is required to fetch Delivery Receipts.");
  }

  let currentDRID = "";
  if (currentSIID) {
    const currentSI = Repository_getById(SI_TABLE, currentSIID);
    if (currentSI) {
      currentDRID = String(currentSI["DR ID"] || "").trim();
    }
  }

  const allDRs = Repository_getRows(SI_DR_TABLE);

  return allDRs
    .filter(row => {
      const sameCustomer = String(row["Customer ID"]).trim() === String(customerID).trim();
      const status = String(row["DR Status"] || "Open").trim();
      const isCurrentDR = currentDRID && String(row["DR ID"]).trim() === currentDRDR;

      // Status must NOT be 'Fulfilled', or it must be the DR linked to the active SI being edited
      return sameCustomer && (status !== "Fulfilled" || isCurrentDR);
    })
    .map(row => {
      const drAmount = Number(row["DR Amount"]) || 0;
      const drInvoiced = Number(row[SI_DR_INVOICED_FIELD]) || 0;
      const drBalance = Math.max(0, drAmount - drInvoiced);

      const result = Object.assign({}, row, {
        "DR Amount": drAmount,
        "DR Invoiced": drInvoiced,
        "DR Balance": drBalance
      });

      if (result["DR Date"] instanceof Date) {
        result["DR Date"] = Utilities.formatDate(
          result["DR Date"],
          Session.getScriptTimeZone(),
          "yyyy-MM-dd"
        );
      }

      return result;
    });
}

/**
 * Retrieves details of a specific Sales Invoice and calculates DR Balance.
 */
function siGetSalesInvoice(siID) {
  if (!siID) {
    throw new Error("Sales Invoice ID is required.");
  }

  const tz = Session.getScriptTimeZone();
  const header = Repository_getById(SI_TABLE, siID);

  if (!header) {
    throw new Error(`Sales Invoice not found: ${siID}`);
  }

  const safeHeader = Object.assign({}, header);

  if (safeHeader["SI Date"] instanceof Date) {
    safeHeader["SI Date"] = Utilities.formatDate(safeHeader["SI Date"], tz, "yyyy-MM-dd");
  }

  // Fetch linked DR details for accurate balance display
  let drBalance = 0;
  if (safeHeader["DR ID"]) {
    const dr = Repository_getById(SI_DR_TABLE, safeHeader["DR ID"]);
    if (dr) {
      const drAmount = Number(dr["DR Amount"]) || 0;
      const drInvoiced = Number(dr[SI_DR_INVOICED_FIELD]) || 0;
      // Allow current SI Amount back into available balance for edit calculation
      const currentSIAmt = Number(safeHeader["SI Amount"]) || 0;
      drBalance = Math.max(0, (drAmount - drInvoiced) + currentSIAmt);
    }
  }

  safeHeader["DR Balance"] = drBalance;

  console.log(JSON.stringify({
    diagnostic: "SI_GET_SALES_INVOICE",
    siID: siID,
    headerReturned: !!safeHeader
  }));

  return { header: safeHeader };
}

/* ============================================================
 * HELPER / VALIDATION FUNCTIONS
 * ============================================================ */

/**
 * Generates sequential SI ID (e.g., SI-0001).
 */
function siGenerateSIID() {
  const rows = Repository_getRows(SI_TABLE);
  let max = 0;

  rows.forEach(row => {
    const match = String(row["SI ID"] || "").trim().match(/^SI-(\d+)$/i);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  });

  return `SI-${String(max + 1).padStart(4, "0")}`;
}

function siRequireCustomer_(id) {
  if (!id) throw new Error("Customer is required.");
  const row = Repository_getById(SI_CUSTOMER_TABLE, id);
  if (!row) throw new Error(`Customer not found: ${id}`);
  return row;
}

function siRequireDR_(id) {
  if (!id) throw new Error("Delivery Receipt is required.");
  const row = Repository_getById(SI_DR_TABLE, id);
  if (!row) throw new Error(`Delivery Receipt not found: ${id}`);
  return row;
}

function siLogUpdate_(table, primaryKeyField, primaryKeyValue, fields, reason) {
  console.log(JSON.stringify({
    diagnostic: "SI_RELATED_TABLE_UPDATE",
    table,
    primaryKeyField,
    primaryKeyValue,
    fields: fields || {},
    reason: reason || "Sales Invoice integration"
  }));
}

function siLogPartialCommitFailure_(context, error, plan) {
  console.error(JSON.stringify({
    diagnostic: "SI_PARTIAL_COMMIT_FAILURE",
    timestamp: new Date().toISOString(),
    context: context || "",
    error: error && error.message ? error.message : String(error),
    plan: plan || null,
    message: "A multi-step commit failed after one or more writes may have occurred. Manual reconciliation may be required."
  }));
}

/* ============================================================
 * READ-ONLY INTEGRATION PLAN
 * ============================================================ */

function siBuildIntegrationPlan_(oldSI, newPayload) {
  const drID = String(newPayload.drID).trim();
  const dr = siRequireDR_(drID);

  const customerID = String(newPayload.customerID).trim();
  const customer = siRequireCustomer_(customerID);

  const oldAmount = oldSI ? Number(oldSI["SI Amount"]) || 0 : 0;
  const newAmount = Number(newPayload.siAmount) || 0;
  const deltaAmount = newAmount - oldAmount;

  // 1. DR Invoiced & Status Validation
  const currentDRInvoiced = Number(dr[SI_DR_INVOICED_FIELD]) || 0;
  const drAmount = Number(dr["DR Amount"]) || 0;
  const newDRInvoiced = currentDRInvoiced + deltaAmount;

  if (newDRInvoiced < 0) {
    throw new Error(`Delivery Receipt ${drID} would have negative ${SI_DR_INVOICED_FIELD}.`);
  }

  const prospectiveDRBalance = drAmount - newDRInvoiced;
  if (prospectiveDRBalance < 0) {
    throw new Error(`SI Amount exceeds available Delivery Receipt balance. Maximum allowed: ${drAmount - (currentDRInvoiced - oldAmount)}.`);
  }

  // Determine prospective DR Status
  let newDRStatus = "Open";
  if (prospectiveDRBalance === 0 && drAmount > 0) {
    newDRStatus = "Fulfilled";
  } else if (newDRInvoiced > 0 && prospectiveDRBalance > 0) {
    newDRStatus = "Partially Fulfilled";
  }

  // 2. Customer Total Sales Validation
  const currentTotalSales = Number(customer[SI_CUSTOMER_TOTAL_FIELD]) || 0;
  const newTotalSales = currentTotalSales + deltaAmount;

  if (newTotalSales < 0) {
    throw new Error(`Customer ${customerID} would have negative ${SI_CUSTOMER_TOTAL_FIELD}.`);
  }

  return {
    drPlan: {
      drID,
      oldInvoiced: currentDRInvoiced,
      deltaInvoiced: deltaAmount,
      newInvoiced: newDRInvoiced,
      oldStatus: dr["DR Status"] || "Open",
      newStatus: newDRStatus,
      drBalance: prospectiveDRBalance
    },
    customerPlan: {
      customerID,
      oldTotalSales: currentTotalSales,
      deltaSales: deltaAmount,
      newTotalSales
    }
  };
}

/* ============================================================
 * COMMIT HELPERS
 * ============================================================ */

function siApplyDRPlan_(drPlan) {
  if (!drPlan) return;

  siLogUpdate_(
    SI_DR_TABLE,
    "DR ID",
    drPlan.drID,
    {
      [SI_DR_INVOICED_FIELD]: {
        oldValue: drPlan.oldInvoiced,
        delta: drPlan.deltaInvoiced,
        newValue: drPlan.newInvoiced
      },
      "DR Status": {
        oldValue: drPlan.oldStatus,
        newValue: drPlan.newStatus
      }
    },
    "Sales Invoice processing"
  );

  Repository_update(SI_DR_TABLE, {
    "DR ID": drPlan.drID,
    [SI_DR_INVOICED_FIELD]: drPlan.newInvoiced,
    "DR Status": drPlan.newStatus
  });
}

function siApplyCustomerPlan_(customerPlan) {
  if (!customerPlan) return;

  siLogUpdate_(
    SI_CUSTOMER_TABLE,
    "Customer ID",
    customerPlan.customerID,
    {
      [SI_CUSTOMER_TOTAL_FIELD]: {
        oldValue: customerPlan.oldTotalSales,
        delta: customerPlan.deltaSales,
        newValue: customerPlan.newTotalSales
      }
    },
    "Sales Invoice revenue update"
  );

  Repository_update(SI_CUSTOMER_TABLE, {
    "Customer ID": customerPlan.customerID,
    [SI_CUSTOMER_TOTAL_FIELD]: customerPlan.newTotalSales
  });
}

/* ============================================================
 * SAVE / EDIT (VALIDATE -> PLAN -> COMMIT)
 * ============================================================ */

function siSaveSalesInvoice(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Sales Invoice payload is required.");
  }

  const master = payload.master || {};
  const customerID = String(master["Customer ID"] || "").trim();
  const drID = String(master["DR ID"] || "").trim();
  const siAmount = Number(master["SI Amount"]);

  if (!customerID) throw new Error("Customer ID is required.");
  if (!drID) throw new Error("Delivery Receipt ID is required.");
  if (!Number.isFinite(siAmount) || siAmount <= 0) {
    throw new Error("SI Amount must be greater than zero.");
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("Could not acquire lock. Another transaction is in progress.");
  }

  let integrationPlan;
  let siID;
  let commitStage = "VALIDATE_PLAN";

  try {
    // 1. READ CURRENT STATE
    const customer = siRequireCustomer_(customerID);
    const dr = siRequireDR_(drID);

    if (String(dr["Customer ID"]).trim() !== customerID) {
      throw new Error(`Delivery Receipt ${drID} does not belong to Customer ${customerID}.`);
    }

    const requestedSIID = String(master["SI ID"] || "").trim();
    siID = requestedSIID || siGenerateSIID();

    const existingSI = Repository_getById(SI_TABLE, siID);
    const isEdit = !!existingSI;

    if (isEdit && String(existingSI["DR ID"]).trim() !== drID) {
      throw new Error("Changing the Delivery Receipt on an existing Sales Invoice is not allowed.");
    }

    const siDate = master["SI Date"] || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

    // 2. BUILD PLAN
    const newPayload = {
      customerID,
      drID,
      siAmount
    };

    integrationPlan = siBuildIntegrationPlan_(existingSI, newPayload);

    // 3. BUILD DOCUMENT PAYLOAD
    const documentPayload = {
      master: {
        "SI Date": siDate,
        "SI ID": siID,
        "Customer ID": customerID,
        "Customer Name": customer["Customer Name"] || "",
        "State": customer["State"] || "",
        "City": customer["City"] || "",
        "SO ID": dr["SO ID"] || master["SO ID"] || "",
        "DR ID": drID,
        "Invoice Num": master["Invoice Num"] || dr["Invoice Num"] || "",
        "SI Amount": siAmount,
        "SI Status": master["SI Status"] || SI_DEFAULT_STATUS
      }
    };

    // 4. COMMIT
    commitStage = "DOCUMENT_SAVE";
    const docResult = Document_save("SalesInvoice", documentPayload);

    commitStage = "DELIVERY_RECEIPT_UPDATE";
    siApplyDRPlan_(integrationPlan.drPlan);

    commitStage = "CUSTOMER_TOTAL_SALES_UPDATE";
    siApplyCustomerPlan_(integrationPlan.customerPlan);

    console.log(JSON.stringify({
      diagnostic: "SALES_INVOICE_SAVE",
      action: isEdit ? "updated" : "inserted",
      siID,
      drID,
      customerID,
      siAmount,
      drInvoicedDelta: integrationPlan.drPlan.deltaInvoiced,
      customerSalesDelta: integrationPlan.customerPlan.deltaSales
    }));

    return {
      success: true,
      action: isEdit ? "updated" : "inserted",
      siID,
      siAmount,
      document: docResult,
      integration: integrationPlan
    };

  } catch (error) {
    siLogPartialCommitFailure_(`siSaveSalesInvoice:${commitStage}`, error, {
      integrationPlan,
      siID,
      drID,
      customerID
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * DELETE (VALIDATE -> PLAN -> COMMIT)
 * ============================================================ */

function siDeleteSalesInvoice(siID) {
  if (!siID) {
    throw new Error("Sales Invoice ID is required.");
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("Could not acquire transaction lock.");
  }

  let integrationPlan;
  let commitStage = "VALIDATE_PLAN";

  try {
    // 1. READ CURRENT STATE
    const si = Repository_getById(SI_TABLE, siID);
    if (!si) {
      throw new Error(`Sales Invoice not found: ${siID}`);
    }

    const customerID = String(si["Customer ID"] || "").trim();
    const drID = String(si["DR ID"] || "").trim();
    const siAmount = Number(si["SI Amount"]) || 0;

    // 2. BUILD READ-ONLY REVERSAL PLAN
    const newPayload = {
      customerID,
      drID,
      siAmount: 0 // Zero out current SI amount
    };

    integrationPlan = siBuildIntegrationPlan_(si, newPayload);

    // 3. COMMIT
    commitStage = "DELIVERY_RECEIPT_REVERSAL";
    siApplyDRPlan_(integrationPlan.drPlan);

    commitStage = "CUSTOMER_REVENUE_REVERSAL";
    siApplyCustomerPlan_(integrationPlan.customerPlan);

    commitStage = "DOCUMENT_DELETE";
    const docResult = Document_delete("SalesInvoice", siID);

    console.log(JSON.stringify({
      diagnostic: "SALES_INVOICE_DELETE",
      siID,
      drID,
      customerID,
      reversedAmount: siAmount
    }));

    return {
      success: true,
      action: "deleted",
      siID,
      document: docResult,
      integration: integrationPlan
    };

  } catch (error) {
    siLogPartialCommitFailure_(`siDeleteSalesInvoice:${commitStage}`, error, {
      integrationPlan,
      siID
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
}
