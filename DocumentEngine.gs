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
 * Returns the configured document definition.
 *
 * Registry.Documents contains metadata only:
 * header table, detail tables, primary key, views, etc.
 */
function Document_getConfig(documentType) {

  const config = Registry.Documents[documentType];

  if (!config) {
    throw new Error(
      `Unknown document type: ${documentType}`
    );
  }

  return config;
}


/**
 * Retrieves a document header by primary key.
 */
function Document_getHeader(documentType, id) {

  const config = Document_getConfig(documentType);

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


/**
 * Retrieves all configured detail tables for a document.
 *
 * Returned shape:
 *
 * {
 *   SalesDetails: [...],
 *   Charges: [...],
 *   ...
 * }
 */
function Document_getDetails(documentType, id) {

  const config = Document_getConfig(documentType);

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


/**
 * Retrieves a complete document DTO.
 *
 * DTO shape:
 * {
 *   type,
 *   key,
 *   header,
 *   details: {
 *     <detailTable>: [...]
 *   },
 *   view
 * }
 */
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


/**
 * Deletes a document and all configured detail rows.
 *
 * Details are deleted before the header to avoid leaving
 * orphaned detail records.
 *
 * Locking serializes document deletion against document saves.
 * It does not provide database-style rollback.
 */
function Document_delete(documentType, id) {

  const config = Document_getConfig(documentType);

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      "Document_delete: Could not acquire lock. " +
      "Another document operation is in progress — please try again."
    );
  }

  try {

    // Delete all details first.
    config.detailTables.forEach(detail => {

      Repository_delete(
        detail.table,
        detail.foreignKey,
        id
      );

    });

    // Delete header.
    Repository_delete(
      config.headerTable,
      config.primaryKey,
      id
    );

    return true;

  } finally {
    lock.releaseLock();
  }
}


/**
 * Merges submitted detail rows into an existing document.
 *
 * Responsibilities:
 *  - Update existing rows belonging to this document
 *  - Insert new rows
 *  - Delete removed rows
 *  - Maintain display order
 *  - Prevent a detail primary key from being reassigned
 *    from another document
 *
 * Returns:
 * {
 *   inserted : Number,
 *   updated  : Number,
 *   deleted  : Number
 * }
 */
function Document_mergeDetails_(
  documentConfig,
  detailConfig,
  parentID,
  submittedRows
) {

  if (!detailConfig || !detailConfig.table) {
    throw new Error(
      "Document_mergeDetails_: Invalid detail configuration."
    );
  }

  if (parentID === null || parentID === undefined || parentID === "") {
    throw new Error(
      `Document_mergeDetails_: Missing parent ID for table ${detailConfig.table}.`
    );
  }

  if (submittedRows === null || submittedRows === undefined) {
    submittedRows = [];
  }

  if (!Array.isArray(submittedRows)) {
    throw new Error(
      `Document_mergeDetails_: Expected an array for ${detailConfig.table}.`
    );
  }

  const table = detailConfig.table;
  const foreignKey = detailConfig.foreignKey;

  const repoConfig = Repository_getConfig_(table);
  const pk = repoConfig.primaryKey;

  const displayOrderField =
    detailConfig.displayOrderField || null;

  //--------------------------------------------------
  // Existing rows belonging to this document
  //--------------------------------------------------

  const existingRows =
    Repository_getRows(table)
      .filter(r =>
        String(r[foreignKey]) === String(parentID)
      );

  //--------------------------------------------------
  // Existing rows keyed by primary key
  //--------------------------------------------------

  const existingByPK = {};

  existingRows.forEach(row => {
    const rowPK = row[pk];

    if (rowPK !== null && rowPK !== undefined && rowPK !== "") {
      existingByPK[String(rowPK)] = row;
    }
  });

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
  // Validate and upsert submitted rows
  //--------------------------------------------------

  submittedRows.forEach((row, index) => {

    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        `Document_mergeDetails_: Invalid detail row at index ${index}.`
      );
    }

    const submittedPK = row[pk];

    if (
      submittedPK === null ||
      submittedPK === undefined ||
      submittedPK === ""
    ) {
      throw new Error(
        `Document_mergeDetails_: Missing primary key "${pk}" ` +
        `for ${table} row at index ${index}.`
      );
    }

    const submittedPKKey = String(submittedPK);

    //--------------------------------------------------
    // Duplicate primary key protection
    //--------------------------------------------------

    if (submittedMap[submittedPKKey]) {
      throw new Error(
        `Document_mergeDetails_: Duplicate primary key "${submittedPK}" ` +
        `submitted for ${table}.`
      );
    }

    //--------------------------------------------------
    // Determine whether this is an existing detail
    // belonging to the current document.
    //--------------------------------------------------

    const existingForDocument =
      existingByPK[submittedPKKey];

    //--------------------------------------------------
    // If the PK exists in the repository but is NOT
    // one of this document's existing rows, reject it.
    //
    // This prevents a submitted detail ID from another
    // document being reassigned to the current document.
    //--------------------------------------------------

    const repositoryRecord =
      Repository_getById(table, submittedPK);

    if (repositoryRecord && !existingForDocument) {
      throw new Error(
        `Document_mergeDetails_: Detail ${submittedPK} ` +
        `already belongs to another document and cannot be reassigned.`
      );
    }

    //--------------------------------------------------
    // Force the detail's parent to the document being
    // saved. The ownership check above ensures an
    // existing detail cannot be moved across documents.
    //--------------------------------------------------

    row[foreignKey] = parentID;

    //--------------------------------------------------
    // Display Order
    //--------------------------------------------------

    if (displayOrderField) {
      row[displayOrderField] = index + 1;
    }

    //--------------------------------------------------
    // Detail ID is generated client-side (see sales.html
    // addSOLine()) and is expected to be present on every
    // submitted row.
    //--------------------------------------------------

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

    submittedMap[submittedPKKey] = true;

  });

  //--------------------------------------------------
  // Delete removed rows
  //--------------------------------------------------

  existingRows.forEach(row => {

    const rowPK = row[pk];

    if (!submittedMap[String(rowPK)]) {

      Repository_delete(
        table,
        pk,
        rowPK
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


/**
 * Saves a document (header + details), whether it is brand new
 * or an existing document being edited.
 *
 * The header primary key must already be present on
 * document.master before this function is called.
 *
 * Detail rows are supplied keyed by configured detail-table name:
 *
 * {
 *   master: {...},
 *   details: {
 *     SalesDetails: [...]
 *   }
 * }
 *
 * This function serializes concurrent document saves using
 * LockService. It does NOT provide database-style transaction
 * rollback: if a later sheet operation fails, earlier successful
 * writes remain committed.
 *
 * @param {string} documentType
 * @param {Object} document
 * @param {Object} document.master Header record
 * @param {Object} document.details Detail arrays keyed by table name
 * @returns {Object}
 */
function Document_save(documentType, document) {

  const config = Document_getConfig(documentType);

  if (!document || typeof document !== "object") {
    throw new Error(
      "Document_save: Document payload is required."
    );
  }

  if (!document.master || typeof document.master !== "object") {
    throw new Error(
      "Document_save: Document master/header is required."
    );
  }

  const headerConfig =
    Registry.Tables[config.headerTable];

  if (!headerConfig || !headerConfig.primaryKey) {
    throw new Error(
      `Document_save: Invalid header table configuration for ${config.headerTable}.`
    );
  }

  const headerPK = headerConfig.primaryKey;
  const parentID = document.master[headerPK];

  if (
    parentID === null ||
    parentID === undefined ||
    parentID === ""
  ) {
    throw new Error(
      `Document_save: Missing header primary key "${headerPK}".`
    );
  }

  const details =
    document.details === null ||
    document.details === undefined
      ? {}
      : document.details;

  if (
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    throw new Error(
      "Document_save: document.details must be an object keyed by detail table name."
    );
  }

  //--------------------------------------------------
  // Detail validation
  //
  // A document transaction must contain at least one
  // detail row across its configured detail tables.
  //
  // This validation intentionally runs BEFORE the header
  // upsert so that:
  //   - a new document with no details is rejected
  //   - an existing document cannot be saved after all
  //     details have been removed
  //   - no header mutation occurs when validation fails
  //--------------------------------------------------

  let totalDetailRows = 0;

  for (const detailConfig of config.detailTables) {

    const rowsForTable =
      details[detailConfig.table] || [];

    if (!Array.isArray(rowsForTable)) {
      throw new Error(
        `Document_save: Details for ${detailConfig.table} must be an array.`
      );
    }

    totalDetailRows += rowsForTable.length;
  }

  if (totalDetailRows === 0) {
    throw new Error(
      `${documentType} cannot be saved without at least one detail line.`
    );
  }

  // Serialize document saves so concurrent Repository writes
  // cannot interleave.
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      "Document_save: Could not acquire lock. " +
      "Another document operation is in progress — please try again."
    );
  }

  try {

    const headerResult = Repository_upsert(
      config.headerTable,
      document.master
    );

    for (const detailConfig of config.detailTables) {

      const rowsForTable =
        details[detailConfig.table] || [];

      Document_mergeDetails_(
        config,
        detailConfig,
        parentID,
        rowsForTable
      );

    }

    return {
      success: true,
      action: headerResult.action
    };

  } finally {
    lock.releaseLock();
  }

}


/**
 * TEST FUNCTIONS
 */
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
