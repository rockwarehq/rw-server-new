// Inventory domain service - exports material, inventory, product,
// and disposition operations

export * as material from "./material.js";
export * as materialBalance from "./material-balance.js";
export * as materialLedger from "./material-ledger.js";
export * as materialShiftFlush from "@rw/services/inventory/material-shift-flush";
export * as inventory from "@rw/services/inventory/inventory";
export * as product from "./product.js";
export * as disposition from "./disposition.js";
export * as dispositionReason from "./disposition-reason.js";
export * as dispositionLog from "./disposition-log.js";
