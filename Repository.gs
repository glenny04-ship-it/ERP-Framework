//Repository_getTable()

//Repository_getRows()

//Repository_getHeaders()

//Repository_getSheet()

/**
 * Returns all rows from a repository table as objects.
 *
 * @param {string} tableName
 * @returns {Object[]}
 */
function Repository_getRows(tableName) {

  const config = Repository_getConfig_(tableName);
  const sheet = Repository_getSheet_(tableName);
  const headers = Repository_getHeaders_(sheet, config);

  const lastRow = sheet.getLastRow();

  if (lastRow <= config.headerRow) {
    return [];
  }

  const values = sheet.getRange(
    config.headerRow + 1,
    1,
    lastRow - config.headerRow,
    headers.length
  ).getValues();


headers.forEach((h, i) => {

});

  const pk = config.primaryKey;
  const pkIndex = headers.indexOf(pk);

  if (pkIndex === -1) {
    throw new Error(
      `Primary key "${pk}" not found in table "${tableName}".`
    );
  }

  return values
    .filter(row => {
      const key = String(row[pkIndex] ?? "").trim();
      return key !== "";
    })
    .map(row => Repository_rowToObject_(row, headers));

}


/**
 * Writes row data to the sheet while never touching columns listed
 * in protectedFields (e.g. formula-driven columns like "QTY Balance").
 *
 * setValues() always pastes a literal into every cell in the range
 * it's given, so the only safe way to preserve a formula is to never
 * include that column in the written range at all. This groups the
 * headers into contiguous non-protected segments and writes each
 * segment with its own setValues() call, leaving protected columns
 * completely untouched (including any pre-filled formula in a row
 * being inserted for the first time).
 *
 * @param {Sheet} sheet
 * @param {number} startRow 1-indexed sheet row of the first row being written
 * @param {string[]} headers
 * @param {Array[]} rows Array of row-arrays (already ordered per headers)
 * @param {string[]} protectedFields Header names to never write
 */
function Repository_writeRows_(sheet, startRow, headers, rows, protectedFields) {

  const protectedSet = new Set(protectedFields || []);

  let segStart = null;

  for (let i = 0; i <= headers.length; i++) {

    const isProtected = i < headers.length && protectedSet.has(headers[i]);

    if (!isProtected && i < headers.length) {
      if (segStart === null) segStart = i;
      continue;
    }

    if (segStart !== null) {
      const segLen = i - segStart;
      const segValues = rows.map(row => row.slice(segStart, i));
      sheet.getRange(startRow, segStart + 1, rows.length, segLen)
        .setValues(segValues);
      segStart = null;
    }
  }
}

/**
 * Inserts one or more records.
 *
 * @param {string} tableName
 * @param {Object|Object[]} records
 * @returns {{success:boolean, inserted:number}}
 */
function Repository_insert(tableName, records) {

  const config = Repository_getConfig_(tableName);
  const sheet = Repository_getSheet_(tableName);
  const headers = Repository_getHeaders_(sheet, config);

    Logger.log("Table Name: " + tableName);
Logger.log(JSON.stringify(config));


headers.forEach((h, i) => {

});

  const pk = config.primaryKey;
  const pkIndex = headers.indexOf(pk);

  if (pkIndex === -1) {
    throw new Error(
      `Repository_insert: Primary key "${pk}" not found in table "${tableName}".`
    );
  }

  // Normalize to array
  if (!Array.isArray(records)) {
    records = [records];
  }

  if (records.length === 0) {
    return {
      success: true,
      inserted: 0
    };
  }

  // ----------------------------------------------------------
  // Validate primary keys
  // ----------------------------------------------------------

  records.forEach((record, index) => {

    if (!record || typeof record !== "object") {
      throw new Error(
        `Repository_insert: Record ${index + 1} is not a valid object.`
      );
    }

    const pkValue = String(record[pk] ?? "").trim();

    if (pkValue === "") {
      throw new Error(
        `Repository_insert: Record ${index + 1} has a blank primary key "${pk}".`
      );
    }

  });

  // ----------------------------------------------------------
  // Determine insert row
  // ----------------------------------------------------------
  // Uses the sheet's actual last row (data in any column), not
  // just the last populated PK. Scanning only the PK column is
  // fragile: a row with data but a blank/cleared PK (e.g. from
  // a manual edit) would be silently overwritten by the next
  // insert, since the old logic would treat the row above it
  // as "last populated" and insert right after that instead.

  const lastRow = sheet.getLastRow();
  const insertRow = Math.max(lastRow, config.headerRow) + 1;

  // ----------------------------------------------------------
  // Convert records
  // ----------------------------------------------------------

  const rows = records.map(record =>
    Repository_objectToRow_(record, headers)
  );

  // ----------------------------------------------------------
  // Insert
  // ----------------------------------------------------------

  Repository_writeRows_(
    sheet,
    insertRow,
    headers,
    rows,
    config.protectedFields
  );

  return {
    success: true,
    inserted: rows.length,
    startRow: insertRow
  };

}

/**
 * Updates an existing record.
 *
 * Only fields present in the supplied record are updated.
 * All other fields remain unchanged.
 *
 * @param {string} tableName
 * @param {Object} record
 * @returns {{success:boolean}}
 */
function Repository_update(tableName, record) {

  // ----------------------------------------------------------
  // Basic validation
  // ----------------------------------------------------------

  if (!tableName) {
    throw new Error("Repository_update: tableName is required.");
  }

  if (!record || typeof record !== "object") {
    throw new Error("Repository_update: record must be an object.");
  }

  const config = Repository_getConfig_(tableName);
  const sheet = Repository_getSheet_(tableName);
  const headers = Repository_getHeaders_(sheet, config);
  const headerMap = Repository_getHeaderMap_(headers);

  const pk = config.primaryKey;

  if (!(pk in headerMap)) {
    throw new Error(
      `Repository_update: Primary key "${pk}" not found in table "${tableName}".`
    );
  }

  if (!(pk in record)) {
    throw new Error(
      `Repository_update: Record does not contain primary key "${pk}".`
    );
  }

  // ----------------------------------------------------------
  // Validate primary key value
  // ----------------------------------------------------------

  const pkValue = String(record[pk] ?? "").trim();

  if (pkValue === "") {
    throw new Error(
      `Repository_update: Primary key "${pk}" cannot be blank.`
    );
  }

  const pkIndex = headerMap[pk];

  const lastRow = sheet.getLastRow();

  if (lastRow <= config.headerRow) {
    throw new Error(
      `Repository_update: Table "${tableName}" contains no data.`
    );
  }

  const values = sheet.getRange(
    config.headerRow + 1,
    1,
    lastRow - config.headerRow,
    headers.length
  ).getValues();

  // ----------------------------------------------------------
  // Locate record
  // ----------------------------------------------------------

  const target = values.findIndex(row =>
    String(row[pkIndex] ?? "").trim() === pkValue
  );

  if (target === -1) {
    throw new Error(
      `Repository_update: Record not found (${pk}: ${pkValue}).`
    );
  }

  // ----------------------------------------------------------
  // Merge with existing row
  // ----------------------------------------------------------

  const current = Repository_rowToObject_(
    values[target],
    headers
  );

  const updated = {
    ...current,
    ...record
  };

  // Never allow the primary key to change
  updated[pk] = current[pk];

  const row = Repository_objectToRow_(
    updated,
    headers
  );

  // ----------------------------------------------------------
  // Persist (protected/formula columns are never written)
  // ----------------------------------------------------------

  Repository_writeRows_(
    sheet,
    config.headerRow + 1 + target,
    headers,
    [row],
    config.protectedFields
  );

  return {
    success: true,
    table: tableName,
    primaryKey: pk,
    primaryKeyValue: pkValue
  };

}

function Repository_delete(tableName, fieldName, value) {

  const table = Repository_getConfig_(tableName);
  const sheet = Repository_getSheet_(tableName);

  const lastRow = sheet.getLastRow();

  if (lastRow <= table.headerRow) {
    return 0;
  }

  const headers = Repository_getHeaders_(sheet, table);

  const data = sheet
    .getRange(
      table.headerRow + 1,
      1,
      lastRow - table.headerRow,
      headers.length
    )
    .getValues();

  const fieldIndex =
    headers.indexOf(fieldName);

  if (fieldIndex === -1) {

    throw new Error(
      "Field not found: " + fieldName
    );

  }

  let deleted = 0;

  // Delete from bottom to top
  for (let i = data.length - 1; i >= 0; i--) {

    if (String(data[i][fieldIndex]) === String(value)) {

      sheet.deleteRow(
        table.headerRow + 1 + i
      );

      deleted++;

    }

  }

  return deleted;

}

/**
 * Returns the sheet for a table.
 *
 * @param {string} tableName
 * @returns {Sheet}
 */
function Repository_getSheet_(tableName) {

  const config = Repository_getConfig_(tableName);

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(config.sheet);

  if (!sheet) {
    throw new Error(`Sheet not found: ${config.sheet}`);
  }

  return sheet;

}

/**
 * Reads the header row.
 *
 * @param {Sheet} sheet
 * @param {Object} config
 * @returns {string[]}
 */
function Repository_getHeaders_(sheet, config) {

  return sheet
    .getRange(
      config.headerRow,
      1,
      1,
      sheet.getLastColumn()
    )
    .getValues()[0];

}

/**
 * Converts an object into a sheet row.
 *
 * @param {Object} record
 * @param {string[]} headers
 * @returns {Array}
 */
function Repository_objectToRow_(record, headers) {

  return headers.map(header => {

    return record.hasOwnProperty(header)

      ? record[header]

      : "";

  });

}

/**
 * Converts a sheet row into an object.
 *
 * @param {Array} row
 * @param {string[]} headers
 * @returns {Object}
 */
function Repository_rowToObject_(row, headers) {

  const obj = {};

  headers.forEach((header, i) => {

    obj[header] = row[i];

  });

  return obj;

}

function Repository_getHeaderMap_(headers) {

  const map = {};

  headers.forEach((header, index) => {

    map[header] = index;

  });

  return map;

}

/**
 * Finds records matching the supplied criteria.
 *
 * @param {string} tableName
 * @param {Object} criteria
 * @returns {Object[]}
 */
function Repository_find(tableName, criteria) {

  const rows = Repository_getRows(tableName);

  if (!criteria || Object.keys(criteria).length === 0) {
    return rows;
  }

  return rows.filter(row => {

    return Object.entries(criteria).every(([field, value]) => {

      return String(row[field]) === String(value);

    });

  });

}

/**
 * Finds the first matching record.
 *
 * @param {string} tableName
 * @param {Object} criteria
 * @returns {Object|null}
 */
function Repository_findOne(tableName, criteria) {

  return Repository_find(tableName, criteria)[0] || null;

}

function Repository_getById(tableName, id) {

  const config = Repository_getConfig_(tableName);

  const rows = Repository_getRows(tableName);

  const record = rows.find(row =>
    String(row[config.primaryKey]) === String(id)
  );

  return record || null;

}

function generateSequentialID(tableName, idColumnHeader, prefix, padding = 4) {
  const rows = Repository_getRows(tableName) || [];
  const regex = new RegExp(`^${prefix}(\\d+)$`, "i");

  let maxNum = 0;

  for (let i = 0; i < rows.length; i++) {
    const rawId = String(rows[i][idColumnHeader] || "").trim();
    const match = rawId.match(regex);

    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }

  const nextNum = maxNum + 1;
  return `${prefix}${String(nextNum).padStart(padding, "0")}`;
}

/**
 * Inserts or updates a row depending on whether
 * the primary key already exists.
 *
 * Returns:
 * {
 *    action : "inserted" | "updated",
 *    key    : primaryKeyValue
 * }
 */
function Repository_upsert(tableName, row) {

  if (!row) {
    throw new Error(
      "Repository_upsert(): row cannot be null."
    );
  }

  const config = Repository_getConfig_(tableName);

  if (!config) {
    throw new Error(`Unknown table: ${tableName}`
    );
  }

  const pk = config.primaryKey;

  if (!pk) {
    throw new Error(
      `Primary key not defined for table "${tableName}".`
    );
  }

  const keyValue = row[pk];

  if (
    keyValue === undefined ||
    keyValue === null ||
    String(keyValue).trim() === ""
  ) {
    throw new Error(`Repository_upsert(): Missing primary key "${pk}".`);
  }

  const existing = Repository_getById(tableName,keyValue);

  if (existing) {

    Repository_update(tableName,row);

    return {
      action: "updated",
      key: keyValue
    };
  }

  Repository_insert(tableName,row);

  return {
    action: "inserted",
    key: keyValue
  };
}

function testRepositoryUpsert() {

  const row = Repository_getById(
    "SalesDetails",
    "D79663"
  );
  Logger.log(Repository_upsert("SalesDetails",row)
  );

}

