
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


/**
 * Save New SO: master + details + batch recalc with LockService
*/
function soSaveNewSO(payload) {

  const result1 = Repository_insert("SalesOrders", payload.master);
  const result2 = Repository_insert("SalesDetails",payload.details);

  return {
    success: true
  };

}


function soDeleteSalesOrder(soID) {

  return Document_delete(
    "SalesOrder",
    soID
  );

}




