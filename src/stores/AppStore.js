import { destroy, flow, types } from "mobx-state-tree";
import { Modal } from "../components/Common/Modal/Modal";
import { History } from "../utils/history";
import { isDefined } from "../utils/utils";
import { Action } from "./Action";
import * as DataStores from "./DataStores";
import { DynamicModel, registerModel } from "./DynamicModel";
import { TabStore } from "./Tabs";
import { CustomJSON } from "./types";
import { User } from "./Users";

export const AppStore = types
  .model("AppStore", {
    mode: types.optional(
      types.enumeration(["explorer", "labelstream", "labeling"]),
      "explorer",
    ),

    viewsStore: types.optional(TabStore, {
      views: [],
    }),

    project: types.optional(CustomJSON, {}),

    loading: types.optional(types.boolean, false),

    loadingData: false,

    users: types.optional(types.array(User), []),

    taskStore: types.optional(
      types.late(() => {
        return DynamicModel.get("tasksStore");
      }),
      {},
    ),

    annotationStore: types.optional(
      types.late(() => {
        return DynamicModel.get("annotationsStore");
      }),
      {},
    ),

    availableActions: types.optional(types.array(Action), []),

    serverError: types.map(CustomJSON),

    crashed: false,

    interfaces: types.map(types.boolean),

    toolbar: types.string,
  })
  .views((self) => ({
    /** @returns {import("../sdk/dm-sdk").DataManager} */
    get SDK() {
      return self._sdk;
    },

    /** @returns {import("../sdk/lsf-sdk").LSFWrapper} */
    get LSF() {
      return self.SDK.lsf;
    },

    /** @returns {import("../utils/api-proxy").APIProxy} */
    get API() {
      return self.SDK.api;
    },

    get apiVersion() {
      return self.SDK.apiVersion;
    },

    get isLabeling() {
      return !!self.dataStore?.selected || self.isLabelStreamMode || self.mode === 'labeling';
    },

    get isLabelStreamMode() {
      return self.mode === "labelstream";
    },

    get isExplorerMode() {
      return self.mode === "explorer" || self.mode === 'labeling';
    },

    get currentView() {
      return self.viewsStore.selected;
    },

    get dataStore() {
      switch (self.target) {
        case "tasks":
          return self.taskStore;
        case "annotations":
          return self.annotationStore;
        default:
          return null;
      }
    },

    get target() {
      return self.viewsStore.selected?.target ?? "tasks";
    },

    get labelingIsConfigured() {
      return self.project?.config_has_control_tags === true;
    },

    get labelingConfig() {
      return self.project.label_config_line ?? self.project.label_config;
    },

    get showPreviews() {
      return self.SDK.showPreviews;
    },

    get currentSelection() {
      return self.currentView.selected.snapshot;
    },

    get currentFilter() {
      return self.currentView.filterSnposhot;
    },
  }))
  .volatile(() => ({
    needsDataFetch: false,
    projectFetch: false,
  }))
  .actions((self) => ({
    startPolling() {
      if (self._poll) return;
      if (self.SDK.polling === false) return;

      const poll = async (self) => {
        await self.fetchProject({ interaction: "timer" });
        self._poll = setTimeout(() => poll(self), 10000);
      };

      poll(self);
    },

    beforeDestroy() {
      clearTimeout(self._poll);
      window.removeEventListener("popstate", self.handlePopState);
    },

    setMode(mode) {
      self.mode = mode;
    },

    addActions(...actions) {
      self.availableActions.push(...actions);
    },

    removeAction(id) {
      const action = self.availableActions.find((action) => action.id === id);

      if (action) destroy(action);
    },

    interfaceEnabled(name) {
      return self.interfaces.get(name) === true;
    },

    enableInterface(name) {
      if (!self.interfaces.has(name)) {
        console.warn(`Unknown interface ${name}`);
      } else {
        self.interfaces.set(name, true);
      }
    },

    disableInterface(name) {
      if (!self.interfaces.has(name)) {
        console.warn(`Unknown interface ${name}`);
      } else {
        self.interfaces.set(name, false);
      }
    },

    setToolbar(toolbarString) {
      self.toolbar = toolbarString;
    },

    setTask: flow(function* ({ taskID, annotationID, pushState }) {
      if (pushState !== false) {
        History.navigate({ task: taskID, annotation: annotationID ?? null });
      }

      if (!isDefined(taskID)) return;

      self.loadingData = true;

      if (self.mode === 'labelstream') {
        yield self.taskStore.loadNextTask({
          select: !!taskID && !!annotationID,
        });
      }

      if (annotationID !== undefined) {
        self.annotationStore.setSelected(annotationID);
      } else {
        self.taskStore.setSelected(taskID);

        yield self.taskStore.loadTask(taskID, {
          select: !!taskID && !!annotationID,
        });

        const annotation = self.LSF?.currentAnnotation;
        const id = annotation?.pk ?? annotation?.id;

        self.LSF?.setLSFTask(self.taskStore.selected, id);

        self.loadingData = false;
      }
    }),

    unsetTask(options) {
      try {
        self.annotationStore.unset();
        self.taskStore.unset();
      } catch (e) {
        /* Something weird */
      }

      if (options?.pushState !== false) {
        History.navigate({ task: null, annotation: null });
      }
    },

    unsetSelection() {
      self.annotationStore.unset({ withHightlight: true });
      self.taskStore.unset({ withHightlight: true });
    },

    createDataStores() {
      const grouppedColumns = self.viewsStore.columns.reduce((res, column) => {
        res.set(column.target, res.get(column.target) ?? []);
        res.get(column.target).push(column);
        return res;
      }, new Map());

      grouppedColumns.forEach((columns, target) => {
        const dataStore = DataStores[target].create?.(columns);

        if (dataStore) registerModel(`${target}Store`, dataStore);
      });
    },

    startLabelStream(options = {}) {
      if (!self.confirmLabelingConfigured()) return;

      self.SDK.setMode("labelstream");

      if (options?.pushState !== false) {
        History.navigate({ labeling: 1 });
      }

      return;
    },

    startLabeling(item, options = {}) {
      if (!self.confirmLabelingConfigured()) return;

      if (self.dataStore.loadingItem) return;

      self.SDK.setMode("labeling");

      if (item && !item.isSelected) {
        const labelingParams = {
          pushState: options?.pushState,
        };

        if (isDefined(item.task_id)) {
          Object.assign(labelingParams, {
            annotationID: item.id,
            taskID: item.task_id,
          });
        } else {
          Object.assign(labelingParams, {
            taskID: item.id,
          });
        }

        self.setTask(labelingParams);
      } else {
        self.closeLabeling();
      }
    },

    confirmLabelingConfigured() {
      if (!self.labelingIsConfigured) {
        Modal.confirm({
          title: "You're almost there!",
          body:
            "Before you can annotate the data, set up labeling configuration",
          onOk() {
            self.SDK.invoke("settingsClicked");
          },
          okText: "Go to setup",
        });
        return false;
      } else {
        return true;
      }
    },

    closeLabeling(options) {
      const { SDK } = self;

      self.unsetTask(options);

      let viewId;
      const tabFromURL = History.getParams().tab;

      if (isDefined(self.currentView)) {
        viewId = self.currentView.tabKey;
      } else if (isDefined(tabFromURL)) {
        viewId = tabFromURL;
      } else if (isDefined(self.viewsStore)) {
        viewId = self.viewsStore.views[0]?.tabKey;
      }

      if (isDefined(viewId)) {
        History.forceNavigate({ tab: viewId });
      }

      SDK.setMode("explorer");
      SDK.destroyLSF();
    },

    handlePopState: (({ state }) => {
      const { tab, task, annotation, labeling } = state ?? {};

      if (tab) {
        const tabId = parseInt(tab);

        self.viewsStore.setSelected(Number.isNaN(tabId) ? tab : tabId, {
          pushState: false,
          createDefault: false,
        });
      }

      if (task) {
        const params = {};

        if (annotation) {
          params.task_id = parseInt(task);
          params.id = parseInt(annotation);
        } else {
          params.id = parseInt(task);
        }

        self.startLabeling(params, { pushState: false });
      } else if (labeling) {
        self.startLabelStream({ pushState: false });
      } else {
        self.closeLabeling({ pushState: false });
      }
    }).bind(self),

    resolveURLParams() {
      window.addEventListener("popstate", self.handlePopState);
    },

    setLoading(value) {
      self.loading = value;
    },

    fetchProject: flow(function* (options = {}) {
      self.projectFetch = options.force === true;

      const oldProject = JSON.stringify(self.project ?? {});
      const params =
        options && options.interaction
          ? {
            interaction: options.interaction,
          }
          : null;

      try {
        const newProject = yield self.apiCall("project", params);
        const projectLength = Object.entries(self.project ?? {}).length;

        self.needsDataFetch = (options.force !== true && projectLength > 0) ? (
          self.project.task_count !== newProject.task_count ||
          self.project.task_number !== newProject.task_number ||
          self.project.annotation_count !== newProject.annotation_count ||
          self.project.num_tasks_with_annotations !== newProject.num_tasks_with_annotations
        ) : false;

        if (JSON.stringify(newProject ?? {}) !== oldProject) {
          self.project = newProject;
        }
      } catch {
        self.crash();
        return false;
      }
      self.projectFetch = false;
      return true;
    }),

    fetchActions: flow(function* () {
      const serverActions = yield self.apiCall("actions");

      self.addActions(...(serverActions ?? []));
    }),

    fetchUsers: flow(function* () {
      const list = yield self.apiCall("users");

      self.users.push(...list);
    }),

    fetchData: flow(function* ({ isLabelStream } = {}) {
      self.setLoading(true);

      const { tab, task, labeling, query } = History.getParams();

      self.viewsStore.fetchColumns();

      const requests = [
        self.fetchProject(),
        self.fetchUsers(),
      ];

      if (!isLabelStream) {
        requests.push(self.fetchActions());

        if (!self.SDK.settings?.onlyVirtualTabs) {
          requests.push(self.viewsStore.fetchTabs(tab, task, labeling));
        } else {
          requests.push(self.viewsStore.addView({ virtual: true }, { autosave: false }));
        }
      } else if (isLabelStream && !!tab) {
        const { selectedItems } = JSON.parse(decodeURIComponent(query ?? "{}"));

        requests.push(self.viewsStore.fetchSingleTab(tab, selectedItems ?? {}));
      }

      const [projectFetched] = yield Promise.all(requests);

      if (projectFetched) {
        self.resolveURLParams();

        self.setLoading(false);

        self.startPolling();
      }
    }),

    apiCall: flow(function* (methodName, params, body) {
      const apiTransform = self.SDK.apiTransform?.[methodName];
      const requestParams = apiTransform?.params?.(params) ?? params ?? {};
      const requestBody = apiTransform?.body?.(body) ?? body ?? undefined;

      let result = yield self.API[methodName](requestParams, requestBody);

      if (result.error && result.status !== 404) {
        if (result.response) {
          self.serverError.set(methodName, {
            error: "Something went wrong",
            response: result.response,
          });
        }

        console.warn({
          message: "Error occurred when loading data",
          description: result?.response?.detail ?? result.error,
        });

        self.SDK.invoke("error", result);

        // notification.error({
        //   message: "Error occurred when loading data",
        //   description: result?.response?.detail ?? result.error,
        // });
      } else {
        self.serverError.delete(methodName);
      }

      return result;
    }),

    invokeAction: flow(function* (actionId, options = {}) {
      const view = self.currentView ?? {};

      const needsLock =
        self.availableActions.findIndex((a) => a.id === actionId) >= 0;

      const { selected } = view;
      const actionCallback = self.SDK.getAction(actionId);

      if (view && needsLock && !actionCallback) view.lock();

      const labelStreamMode = localStorage.getItem("dm:labelstream:mode");

      // @todo this is dirty way to sync across nested apps
      // don't apply filters for "all" on "next_task"
      const actionParams = {
        ordering: view.ordering,
        selectedItems: selected?.snapshot ?? { all: false, included: [] },
        filters: {
          conjunction: view.conjunction ?? 'and',
          items: view.serializedFilters ?? [],
        },
      };

      if (actionId === "next_task") {
        if (labelStreamMode === 'all') {
          delete actionParams.filters;

          if (actionParams.selectedItems.all === false && actionParams.selectedItems.included.length === 0) {
            delete actionParams.selectedItems;
            delete actionParams.ordering;
          }
        } else if (labelStreamMode === 'filtered') {
          delete actionParams.selectedItems;
        }
      }

      if (actionCallback instanceof Function) {
        return actionCallback(actionParams, view);
      }

      const requestParams = {
        id: actionId,
      };

      if (isDefined(view.id) && !view?.virtual) {
        requestParams.tabID = view.id;
      }

      if (options.body) {
        Object.assign(actionParams, options.body);
      }

      const result = yield self.apiCall(
        "invokeAction",
        requestParams,
        {
          body: actionParams,
        },
      );

      if (result.reload) {
        self.SDK.reload();
        return;
      }

      if (options.reload !== false) {
        yield view.reload();
        self.fetchProject();
        view.clearSelection();
      }

      view?.unlock?.();

      return result;
    }),

    crash() {
      self.destroy();
      self.crashed = true;
      self.SDK.invoke("crash");
    },

    destroy() {
      if (self.taskStore) {
        self.taskStore?.clear();
        self.taskStore = undefined;
      }

      if (self.annotationStore) {
        self.annotationStore?.clear();
        self.annotationStore = undefined;
      }

      clearTimeout(self._poll);
    },
  }));
