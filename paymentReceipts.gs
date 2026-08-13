Exit code: 0
Wall time: 1.5 seconds
Output:
/**
 * Payment Receipts Module
 *
 * A receipt applies one payment to one Sales Invoice.  SI Balance remains a
 * sheet formula; this module changes only SI Paid and SI Status.
 */
const PR_TABLE = "PaymentReceipts";
const PR_SI_TABLE = "SalesInvoices";
const PR_CUSTOMER_TABLE = "Customers";
const PR_STATUS_APPLIED = "Applied";

function prGetAllPaymentReceipts() {
  const tz = Session.getScriptTimeZone();
  return Repository_getRows(PR_TABLE).map(row => {
    const result = Object.assign({}, row);
    if (result["PR Date"] instanceof Date) {
      result["PR Date"] = Utilities.formatDate(result["PR Date"], tz, "MM/dd/yyyy");
    }
    return result;
  });
}

function prGetCustomers() {
  return Repository_getRows(PR_CUSTOMER_TABLE);
}

function prGeneratePRID() {
  return generateSequentialID(PR_TABLE, "PR ID", "PR-", 4);
}

function prGetEligibleSalesInvoices(customerID, currentPRID) {
  if (!customerID) throw new Error("Customer ID is required.");
  let currentSIID = "";
  if (currentPRID) {
    const currentPR = Repository_getById(PR_TABLE, currentPRID);
    currentSIID = currentPR ? String(currentPR["SI ID"] || "").trim() : "";
  }

  return Repository_getRows(PR_SI_TABLE)
    .filter(si => String(si["Customer ID"] || "").trim() === String(customerID).trim())
    .filter(si => String(si["SI Status"] || "Open").trim() !== "Full Payment" || String(si["SI ID"] || "").trim() === currentSIID)
    .map(si => Object.assign({}, si, {
      "SI Amount": Number(si["SI Amount"]) || 0,
      "SI Paid": Number(si["SI Paid"]) || 0,
      "SI Balance": Math.max(0, Number(si["SI Amount"]) - (Number(si["SI Paid"]) || 0))
    }));
}

function prGetPaymentReceipt(prID) {
  if (!prID) throw new Error("Payment Receipt ID is required.");
  const header = Repository_getById(PR_TABLE, prID);
  if (!header) throw new Error(`Payment Receipt not found: ${prID}`);
  const result = Object.assign({}, header);
  if (result["PR Date"] instanceof Date) {
    result["PR Date"] = Utilities.formatDate(result["PR Date"], Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  const si = Repository_getById(PR_SI_TABLE, result["SI ID"]);
  const oldAmount = Number(result["PR Amount"]) || 0;
  result["Available SI Balance"] = si
    ? Math.max(0, (Number(si["SI Amount"]) || 0) - (Number(si["SI Paid"]) || 0) + oldAmount)
    : 0;
  return { header: result };
}

function prRequireCustomer_(customerID) {
  const customer = Repository_getById(PR_CUSTOMER_TABLE, customerID);
  if (!customer) throw new Error(`Customer not found: ${customerID}`);
  return customer;
}

function prRequireSI_(siID) {
  const si = Repository_getById(PR_SI_TABLE, siID);
  if (!si) throw new Error(`Sales Invoice not found: ${siID}`);
  return si;
}

function prStatusForSI_(siAmount, siPaid) {
  const amount = Number(siAmount) || 0;
  const paid = Number(siPaid) || 0;
  if (paid <= 0) return "Open";
  if (paid >= amount) return "Full Payment";
  return "Partial Payment";
}

function prBuildPlan_(oldPR, input, allowZeroAmount) {
  const customer = prRequireCustomer_(input.customerID);
  const si = prRequireSI_(input.siID);
  if (String(si["Customer ID"] || "").trim() !== input.customerID) {
    throw new Error(`Sales Invoice ${input.siID} does not belong to the selected customer.`);
  }
  const oldAmount = oldPR ? Number(oldPR["PR Amount"]) || 0 : 0;
  const newAmount = Number(input.prAmount);
  if (!Number.isFinite(newAmount) || newAmount < 0 || (!allowZeroAmount && newAmount === 0)) {
    throw new Error("PR Amount must be greater than zero.");
  }
  const currentPaid = Number(si["SI Paid"]) || 0;
  const siAmount = Number(si["SI Amount"]) || 0;
  const newPaid = currentPaid + newAmount - oldAmount;
  if (newPaid < 0 || newPaid > siAmount) {
    const available = Math.max(0, siAmount - currentPaid + oldAmount);
    throw new Error(`PR Amount cannot exceed the available SI Balance (${available.toFixed(2)}).`);
  }
  const currentCustomerPayments = Number(customer["Total Payments"]) || 0;
  const newCustomerPayments = currentCustomerPayments + newAmount - oldAmount;
  if (newCustomerPayments < 0) throw new Error(`Customer ${input.customerID} would have negative Total Payments.`);
  return {
    si: { id: input.siID, paid: newPaid, status: prStatusForSI_(siAmount, newPaid) },
    customer: { id: input.customerID, totalPayments: newCustomerPayments },
    oldAmount, newAmount
  };
}

function prApplyPlan_(plan) {
  Repository_update(PR_SI_TABLE, { "SI ID": plan.si.id, "SI Paid": plan.si.paid, "SI Status": plan.si.status });
  Repository_update(PR_CUSTOMER_TABLE, { "Customer ID": plan.customer.id, "Total Payments": plan.customer.totalPayments });
}

function prSavePaymentReceipt(payload) {
  const master = payload && payload.master ? payload.master : {};
  const customerID = String(master["Customer ID"] || "").trim();
  const siID = String(master["SI ID"] || "").trim();
  if (!customerID || !siID) throw new Error("Customer and Sales Invoice are required.");
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Could not acquire transaction lock.");
  try {
    const prID = String(master["PR ID"] || "").trim() || prGeneratePRID();
    const existing = Repository_getById(PR_TABLE, prID);
    if (existing && (String(existing["Customer ID"]) !== customerID || String(existing["SI ID"]) !== siID)) {
      throw new Error("Changing the customer or Sales Invoice on an existing Payment Receipt is not allowed.");
    }
    const plan = prBuildPlan_(existing, { customerID, siID, prAmount: master["PR Amount"] });
    const customer = prRequireCustomer_(customerID);
    const si = prRequireSI_(siID);
    Repository_upsert(PR_TABLE, {
      "PR Date": master["PR Date"] || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
      "PR ID": prID,
      "Customer ID": customerID,
      "Customer Name": customer["Customer Name"] || "",
      "State": customer["State"] || "",
      "City": customer["City"] || "",
      "SI ID": siID,
      "Invoice Num": si["Invoice Num"] || "",
      "PR Amount": plan.newAmount,
      "PR Status": PR_STATUS_APPLIED
    });
    prApplyPlan_(plan);
    return { success: true, action: existing ? "updated" : "inserted", prID, integration: plan };
  } finally {
    lock.releaseLock();
  }
}

function prDeletePaymentReceipt(prID) {
  if (!prID) throw new Error("Payment Receipt ID is required.");
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Could not acquire transaction lock.");
  try {
    const receipt = Repository_getById(PR_TABLE, prID);
    if (!receipt) throw new Error(`Payment Receipt not found: ${prID}`);
    const plan = prBuildPlan_(receipt, {
      customerID: String(receipt["Customer ID"]), siID: String(receipt["SI ID"]), prAmount: 0
    }, true);
    Repository_delete(PR_TABLE, "PR ID", prID);
    prApplyPlan_(plan);
    return { success: true, action: "deleted", prID, integration: plan };
  } finally {
    lock.releaseLock();
  }
}

