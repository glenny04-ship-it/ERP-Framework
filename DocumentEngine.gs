/**
 * ============================================================
 * ERP CORE
 * Document Engine
 * Version : 1.0.0-alpha
 *
 * Generic document orchestration layer.
 * Responsible for coordinating Repository operations.
 *
 * It DOES NOT contain module-specific business logic.
 * ============================================================
 */


/**
 * Save a document consisting of:
 *  - one header record
 *  - zero or more detail records
 *
 * @param {Object} document
 * @returns {Object}
 */
function Document_save(document) {

  Logger.log("Document_save entered");
  Logger.log(JSON.stringify(document));

  if (!document) {
    throw new Error("Document is required.");
  }

  if (!document.header) {
    throw new Error("Document header missing.");
  }

  if (!document.header.table) {
    throw new Error("Header table missing.");
  }

  if (!document.header.record) {
    throw new Error("Header record missing.");
  }

  //--------------------------------------------------
  // Validation callback
  //--------------------------------------------------

  if (
    document.callbacks &&
    typeof document.callbacks.validate === "function"
  ) {
    document.callbacks.validate(document);
  }

  //--------------------------------------------------
  // Header
  //--------------------------------------------------

  Repository_insert(
    document.header.table,
    document.header.record
  );

  //--------------------------------------------------
  // Details
  //--------------------------------------------------

  if (
    document.details &&
    document.details.records &&
    document.details.records.length
  ) {

    Repository_insert(
      document.details.table,
      document.details.records
    );

  }

  //--------------------------------------------------
  // After Save callback
  //--------------------------------------------------

  if (
    document.callbacks &&
    typeof document.callbacks.afterSave === "function"
  ) {

    document.callbacks.afterSave(document);

  }

  return {
    success: true
  };

}

function Document_getConfig(documentType) {

  const config = Registry.Documents[documentType];

  if (!config) {

    throw new Error(
      `Unknown document type: ${documentType}`
    );

  }

  return config;

}

function Document_getHeader(documentType, id) {

  const config =
    Document_getConfig(documentType);

  const headers =
    Repository_getRows(config.headerTable);

  const record = Repository_getById(
  config.headerTable,
  id
);

if (!record) {

  throw new Error(
    `${documentType} not found (${id})`
  );

}

return record;

}

function Document_getDetails(documentType, id) {

  const config =
    Document_getConfig(documentType);

  const details = {};

  config.detailTables.forEach(detailConfig => {

    const rows =
      Repository_getRows(detailConfig.table)
        .filter(row =>
          String(row[detailConfig.foreignKey]) === String(id)
        );

    details[detailConfig.table] = rows;

  });

  return details;

}


function Document_get(documentType, id) {

    const config = Document_getConfig(documentType);

    const header = Document_getHeader(documentType, id);

    if (!header) {
        return null;
    }

    const document = {
        type: documentType,
        key: header[config.primaryKey],
        header: header,
        details: Document_getDetails(documentType, id),
        view: Registry.Views[documentType]
    };

    return JSON.parse(JSON.stringify(document));
}

function Document_delete(documentType, id) {

  const config =
    Document_getConfig(documentType);

  // Delete all details first
  config.detailTables.forEach(detail => {

    Repository_delete(
      detail.table,
      detail.foreignKey,
      id
    );

  });

  // Delete header
  Repository_delete(
    config.headerTable,
    config.primaryKey,
    id
  );

  return true;

}

/**
 * Merges submitted detail rows into an existing document.
 *
 * Responsibilities:
 *  - Update existing rows
 *  - Insert new rows
 *  - Delete removed rows
 *  - Maintain display order
 *
 * Returns:
 * {
 *    inserted : Number,
 *    updated  : Number,
 *    deleted  : Number
 * }
 */
function Document_mergeDetails_(
  documentConfig,
  detailConfig,
  parentID,
  submittedRows
) {

  submittedRows = submittedRows || [];

  const table = detailConfig.table;
  const foreignKey = detailConfig.foreignKey;

  const repoConfig = Repository_getConfig_(table);

  const pk = repoConfig.primaryKey;

  const displayOrderField =
    detailConfig.displayOrderField || null;

  //--------------------------------------------------
  // Existing rows
  //--------------------------------------------------

  const existingRows =
    Repository_getRows(table)
      .filter(r =>
        String(r[foreignKey]) === String(parentID)
      );

  //--------------------------------------------------
  // Statistics
  //--------------------------------------------------

  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  //--------------------------------------------------
  // Submitted lookup
  //--------------------------------------------------

  const submittedMap = {};

  //--------------------------------------------------
  // Upsert submitted rows
  //--------------------------------------------------

  submittedRows.forEach((row, index) => {

    row[foreignKey] = parentID;

    //------------------------------------------
    // Display Order
    //------------------------------------------

    if (displayOrderField) {

      row[displayOrderField] = index + 1;

    }

    //------------------------------------------
    // New row
    //------------------------------------------

    if (!row[pk]) {

      row[pk] = Document_generateDetailID_(
        documentConfig,
        detailConfig,
        parentID,
        existingRows
      );

    }

    const result =
      Repository_upsert(
        table,
        row
      );

    if (result.action === "inserted") {

      inserted++;

    } else {

      updated++;

    }

    submittedMap[row[pk]] = true;

  });

  //--------------------------------------------------
  // Delete removed rows
  //--------------------------------------------------

  existingRows.forEach(row => {
    if (!submittedMap[row[pk]]) {
      Repository_delete(
        table,
        pk,
        row[pk]
      );
      deleted++;
    }
  });

  //--------------------------------------------------

  return {
    inserted: inserted,
    updated: updated,
    deleted: deleted
  };

}

function Document_create(documentType, document) {

    const config = Registry.Documents[documentType];

    // Insert header
    Repository_insert(config.headerTable, document.master);

    // Insert all detail tables
    for (const detailConfig of config.detailTables) {
        const rows = document.details || [];
        if (rows.length > 0) {
            Repository_insert(detailConfig.table, rows);
        }
    }

    return {
        success: true
    };
}

function Document_update(documentType, document) {

  const config = Registry.Documents[documentType];

  if (!config) {
    throw new Error(
      "Document configuration not found: " + documentType
    );
  }
  const headerPK =
      Registry.Tables[config.headerTable].primaryKey;

  Repository_update(
      config.headerTable,
      document.master
  );
  for (const detailConfig of config.detailTables) {

      Document_mergeDetails_(
          config,
          detailConfig,
          document.master[headerPK],
          document.details || []
      );

  }
  return {
      success: true
  };
}

/**
 * Generates
 * SO000123-04
 * PO000045-03
 */
function generateParentSequenceID(
  parentID,
  existingRows,
  primaryKey
) {

  let maxSeq = 0;

  existingRows.forEach(row => {

    const id = String(row[primaryKey]);

    const parts = id.split("-");

    if (parts.length < 2) return;

    const seq = Number(parts[1]);

    if (!isNaN(seq) && seq > maxSeq) {

      maxSeq = seq;

    }

  });

  return (
    parentID +
    "-" +
    String(maxSeq + 1).padStart(2, "0")
  );

}

// TEST FUNCTIONS

function testDocumentGetHeaderSafe(documentType, id) {

    const header = Document_getHeader(documentType, id);

    return {
        "SO Date": header["SO Date"]
            ? Utilities.formatDate(
                new Date(header["SO Date"]),
                Session.getScriptTimeZone(),
                "yyyy-MM-dd"
            )
            : "",

        "SO ID": header["SO ID"],
        "Customer ID": header["Customer ID"],
        "Customer Name": header["Customer Name"],
        "Invoice Num": header["Invoice Num"],
        "State": header["State"],
        "City": header["City"]
    };
}
