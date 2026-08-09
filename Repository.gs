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
  // Determine insert row based on last populated PK
  // ----------------------------------------------------------

  const lastRow = sheet.getLastRow();

  let insertRow = config.headerRow + 1;

  if (lastRow > config.headerRow) {

    const pkValues = sheet.getRange(
      config.headerRow + 1,
      pkIndex + 1,
      lastRow - config.headerRow,
      1
    ).getValues();

    for (let i = pkValues.length - 1; i >= 0; i--) {

      if (String(pkValues[i][0] ?? "").trim() !== "") {

        insertRow = config.headerRow + 2 + i;
        break;

      }

    }

  }

  // ----------------------------------------------------------
  // Convert records
  // ----------------------------------------------------------

  const rows = records.map(record =>
    Repository_objectToRow_(record, headers)
  );

  // ----------------------------------------------------------
  // Insert
  // ----------------------------------------------------------

  sheet.getRange(
    insertRow,
    1,
    rows.length,
    headers.length
  ).setValues(rows);

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
  // Persist
  // ----------------------------------------------------------

  sheet.getRange(
    config.headerRow + 1 + target,
    1,
    1,
    headers.length
  ).setValues([row]);

  return {
    success: true,
    table: tableName,
    primaryKey: pk,
    primaryKeyValue: pkValue
  };

}

function Repository_delete(tableName, fieldName, value) {

  const table = Registry.Tables[tableName];

  if (!table) {
    throw new Error("Unknown table: " + tableName);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(table.sheet);

  if (!sheet) {
    throw new Error("Sheet not found: " + table.sheet);
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  const headers = sheet
    .getRange(
      table.headerRow,
      1,
      1,
      lastCol
    )
    .getValues()[0];

  const data = sheet
    .getRange(
      table.headerRow + 1,
      1,
      lastRow - table.headerRow,
      lastCol
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

