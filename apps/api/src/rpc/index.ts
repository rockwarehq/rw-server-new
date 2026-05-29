import * as device from "./device.js";
import * as site from "./site.js";
import * as workcenter from "./workcenter.js";
import * as station from "./station.js";
import * as events from "./events.js";
import * as metrics from "./metrics.js";
import * as metricCatalog from "./metric-catalog.js";
import * as inventory from "./inventory.js";
import * as job from "./job.js";
import * as dashboard from "./dashboard.js";
import * as display from "./display.js";
import * as processType from "./process-type.js";
import * as statusCategory from "./status-category.js";
import * as statusReason from "./status-reason.js";
import * as shift from "./shift.js";
import * as disposition from "./disposition.js";
import * as pointValue from "./point-value.js";
import * as shiftRecap from "./shift-recap.js";
import * as logs from "./logs.js";
import * as employee from "./employee.js";
import * as employeeRole from "./employee-role.js";
import * as operator from "./operator.js";
import * as customer from "./customer.js";
import * as order from "./order.js";
import * as siteAndonRules from "./site-andon-rules.js";
import * as workspace from "./workspace.js";
import * as automations from "./automations.js";

export const router = {
  events: {
    ingest: events.ingest,
    stream: events.stream,
  },
  pointValue: {
    getSnapshots: pointValue.getSnapshots,
    stream: pointValue.stream,
  },
  workspace: {
    listMembers: workspace.listMembers,
    listUserRoles: workspace.listUserRoles,
  },
  metrics: {
    stream: metrics.stream,
    streamValues: metrics.streamValues,
    getBuckets: metrics.getBuckets,
    getShiftValues: metrics.getShiftValues,
  },
  metricCatalog: {
    list: metricCatalog.list,
  },
  gateway: {
    create: device.gatewayCreate,
    list: device.gatewayList,
    get: device.gatewayGet,
    update: device.gatewayUpdate,
    delete: device.gatewayDelete,
  },
  datasource: {
    list: device.datasourceList,
    get: device.datasourceGet,
    create: device.datasourceCreate,
    update: device.datasourceUpdate,
    delete: device.datasourceDelete,
    publish: device.datasourcePublish,
    unpublish: device.datasourceUnpublish,
  },
  site: {
    create: site.create,
    list: site.list,
    get: site.get,
    tree: site.tree,
    deviceTree: site.deviceTree,
    update: site.update,
    delete: site.remove,
    andonRules: {
      list: siteAndonRules.list,
      create: siteAndonRules.create,
      update: siteAndonRules.update,
      delete: siteAndonRules.remove,
      reorder: siteAndonRules.reorder,
    },
  },
  workcenter: {
    create: workcenter.create,
    list: workcenter.list,
    get: workcenter.get,
    update: workcenter.update,
    move: workcenter.move,
    delete: workcenter.remove,
  },
  station: {
    create: station.create,
    list: station.list,
    get: station.get,
    update: station.update,
    move: station.move,
    delete: station.remove,
    createEvent: station.createEvent,
    updateEvent: station.updateEvent,
    deleteEvent: station.deleteEvent,
    listEvents: station.listEvents,
    listEventExecutions: station.listEventExecutions,
    listEventsForProcessor: station.listEventsForProcessor,
    getTagSnapshotsForProcessor: station.getTagSnapshotsForProcessor,
    toggleEvent: station.toggleEvent,
    triggerEvent: station.triggerEvent,
    addDatasource: station.addDatasource,
    removeDatasource: station.removeDatasource,
    listDatasources: station.listDatasources,
    // State management
    splitDowntime: station.splitDowntime,
    assignDowntimeReason: station.assignDowntimeReason,
    changeJob: station.changeJob,
    listStateLogs: station.listStateLogs,
  },
  material: {
    create: inventory.materialCreate,
    list: inventory.materialList,
    get: inventory.materialGet,
    update: inventory.materialUpdate,
    delete: inventory.materialRemove,
  },
  materialLedger: {
    create: inventory.materialLedgerCreate,
    list: inventory.materialLedgerList,
    usage: inventory.materialLedgerUsage,
  },
  product: {
    // CRUD
    create: inventory.productCreate,
    list: inventory.productList,
    get: inventory.productGet,
    update: inventory.productUpdate,
    delete: inventory.productRemove,
    // Lifecycle
    archive: inventory.productArchive,
    unarchive: inventory.productUnarchive,
    duplicate: inventory.productDuplicate,
    // Materials
    addMaterial: inventory.productAddMaterial,
    updateMaterial: inventory.productUpdateMaterial,
    removeMaterial: inventory.productRemoveMaterial,
    listMaterials: inventory.productListMaterials,
    // Material alternate groups
    createAltGroup: inventory.productCreateAltGroup,
    addMaterialToAltGroup: inventory.productAddMaterialToAltGroup,
    setAltGroupActive: inventory.productSetAltGroupActive,
    removeFromAltGroup: inventory.productRemoveFromAltGroup,
    deleteAltGroup: inventory.productDeleteAltGroup,
    updateAltGroupLabel: inventory.productUpdateAltGroupLabel,
    // Pictures
    addPicture: inventory.productAddPicture,
    removePicture: inventory.productRemovePicture,
    setPrimaryPicture: inventory.productSetPrimaryPicture,
    listPictures: inventory.productListPictures,
  },
  inventory: {
    list: inventory.inventoryList,
    get: inventory.inventoryGet,
    getByCycle: inventory.inventoryGetByCycle,
  },
  tool: {
    create: job.toolCreate,
    list: job.toolList,
    get: job.toolGet,
    update: job.toolUpdate,
    delete: job.toolRemove,
    addCavity: job.toolAddCavity,
    updateCavity: job.toolUpdateCavity,
    removeCavity: job.toolRemoveCavity,
    listCavities: job.toolListCavities,
  },
  job: {
    create: job.create,
    list: job.list,
    get: job.get,
    update: job.update,
    delete: job.remove,
    addTool: job.addTool,
    removeTool: job.removeTool,
    listTools: job.listTools,
    addItem: job.addItem,
    updateItem: job.updateItem,
    removeItem: job.removeItem,
    listItems: job.listItems,
    jobsByProductIds: job.jobsByProductIds,
  },
  dashboard: {
    create: dashboard.create,
    list: dashboard.list,
    get: dashboard.get,
    update: dashboard.update,
    delete: dashboard.remove,
  },
  display: {
    register: display.register,
    get: display.get,
    heartbeat: display.heartbeat,
    list: display.list,
    claim: display.claim,
    assignDashboard: display.assignDashboard,
    unassignDashboard: display.unassignDashboard,
    update: display.update,
    delete: display.remove,
  },
  processType: {
    create: processType.create,
    list: processType.list,
    get: processType.get,
    update: processType.update,
    delete: processType.remove,
  },
  statusCategory: {
    create: statusCategory.create,
    list: statusCategory.list,
    get: statusCategory.get,
    update: statusCategory.update,
    delete: statusCategory.remove,
  },
  statusReason: {
    create: statusReason.create,
    list: statusReason.list,
    get: statusReason.get,
    update: statusReason.update,
    delete: statusReason.remove,
  },
  shift: {
    current: shift.current,
  },
  shiftPattern: {
    create: shift.patternCreate,
    list: shift.patternList,
    get: shift.patternGet,
    update: shift.patternUpdate,
    delete: shift.patternDelete,
    duplicate: shift.patternDuplicate,
  },
  shiftDefinition: {
    create: shift.definitionCreate,
    list: shift.definitionList,
    get: shift.definitionGet,
    update: shift.definitionUpdate,
    delete: shift.definitionDelete,
  },
  shiftAssignment: {
    create: shift.assignmentCreate,
    list: shift.assignmentList,
    get: shift.assignmentGet,
    update: shift.assignmentUpdate,
    delete: shift.assignmentDelete,
  },
  disposition: {
    create: disposition.dispositionCreate,
    list: disposition.dispositionList,
    get: disposition.dispositionGet,
    update: disposition.dispositionUpdate,
    delete: disposition.dispositionDelete,
  },
  dispositionReason: {
    create: disposition.reasonCreate,
    list: disposition.reasonList,
    get: disposition.reasonGet,
    update: disposition.reasonUpdate,
    delete: disposition.reasonDelete,
  },
  dispositionLog: {
    record: disposition.logRecord,
    create: disposition.logCreate,
    list: disposition.logList,
    get: disposition.logGet,
    update: disposition.logUpdate,
    delete: disposition.logDelete,
  },
  shiftRecap: {
    shiftInstances: shiftRecap.shiftInstanceList,
    currentShiftInstance: shiftRecap.currentShiftInstance,
    metricBucketLogs: shiftRecap.metricBucketLogList,
    stationJobLogs: shiftRecap.stationJobLogList,
    jobMetrics: shiftRecap.jobMetricsList,
    downtimeLogs: shiftRecap.downtimeLogList,
    scrapByReason: shiftRecap.scrapByReasonList,
    commentList: shiftRecap.commentList,
    commentCreate: shiftRecap.commentCreate,
    commentUpdate: shiftRecap.commentUpdate,
    commentDelete: shiftRecap.commentDelete,
  },
  logs: {
    metricBucketSearch: logs.metricBucketLogSearch,
    hourlyBucketSearch: logs.hourlyBucketSearch,
    stationShiftSummary: logs.stationShiftSummary,
    downtimeSearch: logs.downtimeLogSearch,
    dispositionSearch: logs.dispositionLogSearch,
    materialUsageSearch: logs.materialUsageSearch,
    cycleSearch: logs.cycleSearch,
    logonSearch: logs.logonLogSearch,
    partLogSearch: logs.partLogSearch,
  },
  employee: {
    create: employee.create,
    list: employee.list,
    get: employee.get,
    update: employee.update,
    delete: employee.remove,
  },
  employeeRole: {
    create: employeeRole.create,
    list: employeeRole.list,
    update: employeeRole.update,
    delete: employeeRole.remove,
  },
  operator: {
    config: operator.config,
    logon: operator.operatorLogon,
    logoff: operator.operatorLogoff,
    logoffAll: operator.operatorLogoffAll,
    activeSessions: operator.activeSessions,
    employees: operator.employees,
  },
  customer: {
    create: customer.create,
    list: customer.list,
    get: customer.get,
    update: customer.update,
    delete: customer.remove,
  },
  order: {
    create: order.create,
    list: order.list,
    get: order.get,
    update: order.update,
    delete: order.remove,
    transitionStatus: order.transitionStatus,
    addLineItem: order.addLineItem,
    updateLineItem: order.updateLineItem,
    removeLineItem: order.removeLineItem,
    reorder: order.reorder,
    nextNumber: order.nextNumber,
  },
  automations: {
    getCatalog: automations.getCatalog,
    listRefOptions: automations.listRefOptions,
    list: automations.listAutomations,
    create: automations.createAutomation,
    update: automations.updateAutomation,
    delete: automations.deleteAutomation,
  },
};

export type AppRouter = typeof router;
