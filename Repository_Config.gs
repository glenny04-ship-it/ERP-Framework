const Registry = {

    Tables: {

        SalesOrders: {
            sheet: "Sales Orders",
            headerRow: 1,
            primaryKey: "SO ID"
        },

        SalesDetails: {
            sheet: "Sales Details",
            headerRow: 1,
            primaryKey: "Detail ID",
            foreignKey: "SO ID",
            protectedFields: ["QTY Balance"]   // <-- add this line
        },

        Customers: {
            sheet: "Customers",
            headerRow: 1,
            primaryKey: "Customer ID",
            protectedFields: ["Balance Receivable"]
        },

        Inventory: {
            sheet: "Inventory",
            headerRow: 1,
            primaryKey: "Item ID",
            protectedFields: ["QTY Available"]
        },

        Suppliers: {
            sheet: "Suppliers",
            headerRow: 1,
            primaryKey: "Supplier ID"
        },

        PurchaseOrders: {
            sheet: "Purchase Orders",
            headerRow: 1,
            primaryKey: "PO ID"
        },

        PurchaseDetails: {
            sheet: "Purchase Details",
            headerRow: 1,
            primaryKey: "Detail ID",
            foreignKey: "PO ID"
        },

        Receipts: {
            sheet: "Receipts",
            headerRow: 1,
            primaryKey: "Receipt ID",
            foreignKey: "SO ID"
        },

        Payments: {
            sheet: "Payments",
            headerRow: 1,
            primaryKey: "Payment ID",
            foreignKey: "PO ID"
        }

    },

Documents: {

  SalesOrder: {

  headerTable: "SalesOrders",

  primaryKey: "SO ID",

  idStrategy: {
    type: "Sequence",
    prefix: "SO-",
    padding: 4
  },

  detailTables: [
    {
      table: "SalesDetails",
      foreignKey: "SO ID",
      displayOrderField: "Display Order",
      idStrategy: {
        type: "ParentSequence",
        prefixField: "SO ID"
      }
    }
  ]
},

  PurchaseOrder: {

    headerTable: "PurchaseOrders",

    detailTables: [

      {
        table: "PurchaseDetails",
        foreignKey: "PO ID"
      }

    ],

    primaryKey: "PO ID"

  }


    },

    Lookups: {

      Customers: {

        table: "Customers",

        valueField: "Customer ID",

        displayField: "Customer Name",

        sortField: "Customer Name"

    },

    Suppliers: {

        table: "Suppliers",

        valueField: "Supplier ID",

        displayField: "Supplier Name",

        sortField: "Supplier Name"

    },

    Inventory: {

        table: "Inventory",

        valueField: "Item ID",

        displayField: "Item Name",

        sortField: "Item Name"

    }

    },

    Events: {

    },

    Views: {

      SalesOrder: {

    title: "Sales Order",

    headerFields: [

        "SO ID",
        "SO Date",
        "Customer Name",
        "Invoice Num",
        "State",
        "City",
        "Total SO Amount",
        "Total Received",
        "SO Balance",
        "Receipt Status",
        "Shipping Status"

    ],

    detailTables: {

        SalesDetails: {

            title: "Items",

            columns: [

                "Item Name",
                "QTY Sold",
                "Unit Price",
                "Price Incl Tax",
                "Shipping Fees",
                "Total Sales Price"

            ]

        }

    }

      }

},

}

/**
 * Generates a new parent/document ID.
 *
 * Example:
 *   SO-0001
 *   SO-0002
 *   SO-0003
 *
 * Uses the document's Registry configuration:
 *
 * idStrategy: {
 *   type: "Sequence",
 *   prefix: "SO-",
 *   padding: 4
 * }
 */
function Document_generateID_(documentType) {

  const config =
    Document_getConfig(documentType);

  if (!config.idStrategy) {
    throw new Error(
      `ID strategy not configured for document type: ${documentType}`
    );
  }

  const strategy = config.idStrategy;

  if (strategy.type !== "Sequence") {
    throw new Error(
      `Unsupported ID strategy: ${strategy.type}`
    );
  }

  const prefix =
    String(strategy.prefix || "");

  const padding =
    Number(strategy.padding || 1);

  if (!prefix) {
    throw new Error(
      `ID prefix not configured for document type: ${documentType}`
    );
  }

  const table =
    config.headerTable;

  const primaryKey =
    config.primaryKey;

  const rows =
    Repository_getRows(table);

  let maxSequence = 0;

  rows.forEach(row => {

    const id =
      String(row[primaryKey] || "").trim();

    if (!id || !id.startsWith(prefix)) {
      return;
    }

    const suffix =
      id.substring(prefix.length);

    const sequence =
      parseInt(suffix, 10);

    if (!isNaN(sequence)) {
      maxSequence =
        Math.max(maxSequence, sequence);
    }
  });

  return (
    prefix +
    String(maxSequence + 1).padStart(padding, "0")
  );
}

function Document_generateID(documentType) {
  return Document_generateID_(documentType);
}


function testDocumentGenerateID() {

  const id =
    Document_generateID_("SalesOrder");

  Logger.log("Generated ID: " + id);

  return id;
}
