/**
 * Returns the table configuration.
 *
 * @param {string} tableName
 * @returns {Object}
 */
function Repository_getConfig_(tableName) {

  const config = Registry.Tables[tableName];

  if (!config) {

    throw new Error(
      `Repository: Unknown table "${tableName}".`
    );

  }

  return config;

}
