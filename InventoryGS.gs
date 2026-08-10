/**
 * ============================================================
 * Inventory Domain
 * Phase 1 — Sales Order Allocation
 *
 * Inventory is maintained as a current-state table.
 *
 * Stored quantities:
 *   QTY On-Hand
 *   QTY Allocated
 *   QTY Delivered
 *   QTY On-Order
 *
 * Derived:
 *   QTY Available = QTY On-Hand - QTY Allocated
 *
 * Policy:
 *   ERP_ALLOW_OVER_ALLOCATION
 *   default = TRUE
 *
 * TRUE  -> negative QTY Available is allowed
 * FALSE -> allocation cannot exceed QTY On-Hand
 * ============================================================
 */

const INVENTORY_ALLOW_OVER_ALLOCATION_PROPERTY =
  "ERP_ALLOW_OVER_ALLOCATION";

const INVENTORY_DEFAULT_ALLOW_OVER_ALLOCATION = true;

function Inventory_getAllowOverAllocation() {
  const value = PropertiesService.getScriptProperties()
    .getProperty(INVENTORY_ALLOW_OVER_ALLOCATION_PROPERTY);

  if (value === null || value === "") {
    return INVENTORY_DEFAULT_ALLOW_OVER_ALLOCATION;
  }

  return String(value).toLowerCase() === "true";
}

function Inventory_setAllowOverAllocation(enabled) {
  const value =
    enabled === true ||
    String(enabled).toLowerCase() === "true";

  PropertiesService.getScriptProperties()
    .setProperty(
      INVENTORY_ALLOW_OVER_ALLOCATION_PROPERTY,
      String(value)
    );

  return {
    success: true,
    allowOverAllocation: value
  };
}

function Inventory_getPolicy() {
  return {
    allowOverAllocation:
      Inventory_getAllowOverAllocation()
  };
}

function Inventory_getAvailable_(row) {
  const onHand = Number(row["QTY On-Hand"]) || 0;
  const allocated = Number(row["QTY Allocated"]) || 0;
  return onHand - allocated;
}

/**
 * Validate an item-level allocation delta map without mutating Inventory.
 * Positive delta = allocate more.
 * Negative delta = release allocation.
 */
function Inventory_validateSOAllocationDelta(deltaMap) {
  if (!deltaMap || typeof deltaMap !== "object" || Array.isArray(deltaMap)) {
    throw new Error(
      "Inventory_validateSOAllocationDelta: allocation delta map is required."
    );
  }

  const allowOverAllocation = Inventory_getAllowOverAllocation();
  const warnings = [];
  const projected = [];

  Object.keys(deltaMap).forEach(itemID => {
    const delta = Number(deltaMap[itemID]) || 0;
    if (delta === 0) return;

    const item = Repository_getById("Inventory", itemID);
    if (!item) throw new Error(`Inventory item not found: ${itemID}`);

    const onHand = Number(item["QTY On-Hand"]) || 0;
    const currentAllocated = Number(item["QTY Allocated"]) || 0;
    const newAllocated = currentAllocated + delta;
    const newAvailable = onHand - newAllocated;

    if (!allowOverAllocation && newAvailable < 0) {
      throw new Error(
        `Inventory allocation exceeds On-Hand for ${itemID}. ` +
        `On-Hand: ${onHand}, Projected Allocated: ${newAllocated}, ` +
        `Projected Available: ${newAvailable}. ` +
        `Over-allocation is currently disabled.`
      );
    }

    if (newAvailable < 0) {
      warnings.push({
        itemID: itemID,
        itemName: item["Item Name"] || "",
        onHand: onHand,
        currentAllocated: currentAllocated,
        allocationDelta: delta,
        projectedAllocated: newAllocated,
        projectedAvailable: newAvailable,
        shortageQty: Math.abs(newAvailable)
      });
    }

    projected.push({
      itemID: itemID,
      onHand: onHand,
      currentAllocated: currentAllocated,
      allocationDelta: delta,
      projectedAllocated: newAllocated,
      projectedAvailable: newAvailable
    });
  });

  return {
    success: true,
    allowOverAllocation: allowOverAllocation,
    warnings: warnings,
    projected: projected
  };
}

/**
 * Apply an item-level allocation delta map to Inventory.
 *
 * The complete delta map is validated first, then every affected inventory
 * row is calculated from one consistent snapshot before any writes occur.
 * This prevents multi-line SO edits/deletes from depending on sequential
 * read/write state and correctly handles item changes, line additions,
 * line removals, quantity changes, and whole-SO deletion.
 */
function Inventory_applySOAllocationDelta(deltaMap) {
  const validation = Inventory_validateSOAllocationDelta(deltaMap);
  const itemIDs = Object.keys(deltaMap || {})
    .filter(itemID => Number(deltaMap[itemID]) !== 0);

  if (!itemIDs.length) {
    return {
      success: true,
      allowOverAllocation: validation.allowOverAllocation,
      warnings: validation.warnings,
      updated: []
    };
  }

  // Take a single consistent snapshot of all affected Inventory records.
  const inventoryRows = Repository_getRows("Inventory");
  const byItemID = {};

  inventoryRows.forEach(row => {
    const itemID = String(row["Item ID"] || "").trim();
    if (itemID) byItemID[itemID] = row;
  });

  const changes = itemIDs.map(itemID => {
    const item = byItemID[itemID];
    if (!item) throw new Error(`Inventory item not found: ${itemID}`);

    const delta = Number(deltaMap[itemID]) || 0;
    const currentAllocated = Number(item["QTY Allocated"]) || 0;
    const newAllocated = currentAllocated + delta;

    return {
      itemID: itemID,
      delta: delta,
      oldAllocated: currentAllocated,
      newAllocated: newAllocated,
      onHand: Number(item["QTY On-Hand"]) || 0,
      available: (Number(item["QTY On-Hand"]) || 0) - newAllocated
    };
  });

  // Apply the complete validated change set. Each affected item is updated
  // from the same snapshot rather than re-reading a changing row per item.
  changes.forEach(change => {
    Repository_update("Inventory", {
      "Item ID": change.itemID,
      "QTY Allocated": change.newAllocated
    });
  });

  return {
    success: true,
    allowOverAllocation: validation.allowOverAllocation,
    warnings: validation.warnings,
    updated: changes
  };
}

/**
 * Returns Inventory with derived QTY Available.
 * QTY Available is intentionally not persisted to the sheet.
 */
function Inventory_getCurrentState() {
  return Repository_getRows("Inventory")
    .map(row => {
      const result = Object.assign({}, row);
      result["QTY Available"] = Inventory_getAvailable_(row);
      return result;
    });
}
