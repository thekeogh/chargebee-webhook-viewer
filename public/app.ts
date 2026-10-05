const STORAGE_KEY = "keogh.chargebeeWebhookViewer.events.v1";
const SIDEBAR_WIDTH_KEY = "keogh.chargebeeWebhookViewer.sidebarWidth.v1";
const SIDEBAR_COLLAPSED_KEY = "keogh.chargebeeWebhookViewer.sidebarCollapsed.v1";
const CONTROLS_ACCORDION_OPEN_KEY = "keogh.chargebeeWebhookViewer.controlsAccordionOpen.v1";
const LEGACY_CLI_ACCORDION_OPEN_KEY = "keogh.chargebeeWebhookViewer.cliAccordionOpen.v1";
const LEGACY_API_ACCORDION_OPEN_KEY = "keogh.chargebeeWebhookViewer.apiAccordionOpen.v1";
const GROUP_OPEN_KEY_PREFIX = "keogh.chargebeeWebhookViewer.groupOpen.";
const PREFIX_OPEN_KEY_PREFIX = "keogh.chargebeeWebhookViewer.prefixOpen.";
const GROUP_ORDER_STORAGE_KEY = "keogh.chargebeeWebhookViewer.groupOrder.v1";
const EVENT_ORDER_KEY_PREFIX = "keogh.chargebeeWebhookViewer.eventOrder.";
const FORWARD_WEBHOOK_URL_STORAGE_KEY = "keogh.chargebeeWebhookViewer.forwardWebhookUrl.v1";
const MAX_EVENTS = 500;

const els: Record<string, any> = {
  appShell: document.querySelector("#appShell"),
  statusBar: document.querySelector(".status-bar"),
  eventList: document.querySelector("#eventList"),
  countLabel: document.querySelector("#countLabel"),
  selectedTime: document.querySelector("#selectedTime"),
  selectedTitle: document.querySelector("#selectedTitle"),
  jsonEditor: document.querySelector("#jsonEditor"),
  metadataCode: document.querySelector("#metadataCode"),
  metadataSummary: document.querySelector("#metadataSummary"),
  copyBodyButton: document.querySelector("#copyBodyButton"),
  copyObjectButton: document.querySelector("#copyObjectButton"),
  collapseAllGroupsButton: document.querySelector("#collapseAllGroupsButton"),
  clearAllButton: document.querySelector("#clearAllButton"),
  forwardWebhookUrlInput: document.querySelector("#forwardWebhookUrlInput"),
  payloadStatus: document.querySelector("#payloadStatus"),
  listenerDot: document.querySelector("#listenerDot"),
  listenerStatus: document.querySelector("#listenerStatus"),
  footerListenerDot: document.querySelector("#footerListenerDot"),
  footerListenerStatus: document.querySelector("#footerListenerStatus"),
  forwardingStatus: document.querySelector("#forwardingStatus"),
  resendButton: document.querySelector("#resendButton"),
  command: document.querySelector("#tunnelCommand"),
  publicUrl: document.querySelector("#publicWebhookUrl"),
  listenerLog: document.querySelector("#listenerLog"),
  startListenerButton: document.querySelector("#startListenerButton"),
  stopListenerButton: document.querySelector("#stopListenerButton"),
  collapseSidebarButton: document.querySelector("#collapseSidebarButton"),
  resizeHandle: document.querySelector("#resizeHandle"),
  controlsAccordion: document.querySelector("#controlsAccordion"),
  template: document.querySelector("#eventItemTemplate"),
  groupTemplate: document.querySelector("#eventGroupTemplate"),
};

let events = loadEvents();
let selectedId = events[0]?.id || null;
let listenerState = null;
let isResizingSidebar = false;
let editor = null;
let pendingEditorValue = "";
let draggedGroupType = null;
let draggedEventId = null;
let forwardingSaveTimer = null;
let forwardingState = { url: "", lastResult: null };
let resending = false;
const MIN_SIDEBAR_WIDTH = 390;

function loadEvents() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEvents() {
  const snapshots = [events.slice(-MAX_EVENTS), events.slice(-100), events.slice(-25)];

  for (const snapshot of snapshots) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      if (snapshot.length !== events.length) {
        events = snapshot;
        if (!events.some((event) => event.id === selectedId)) selectedId = events[0]?.id || null;
      }
      return true;
    } catch (error) {
      if (error?.name !== "QuotaExceededError") {
        console.warn("Unable to save webhook history", error);
        return false;
      }
    }
  }

  console.warn("Unable to save webhook history: localStorage quota exceeded.");
  return false;
}

function loadSettings() {
  els.forwardWebhookUrlInput.value = localStorage.getItem(FORWARD_WEBHOOK_URL_STORAGE_KEY) || "";
}

function renderForwardingStatus(state) {
  forwardingState = state;
  updateResendButton();
  const url = state?.url || "";
  const result = state?.lastResult;
  els.forwardingStatus.title = result?.url || url;
  if (!url) {
    els.forwardingStatus.textContent = "Forwarding: off";
    return;
  }
  if (!result) {
    els.forwardingStatus.textContent = "Forwarding: ready";
    return;
  }
  if (result.ok) {
    els.forwardingStatus.textContent = `Forwarded: ${result.status}`;
    return;
  }
  els.forwardingStatus.textContent = `Forward failed: ${result.error || result.status || "unknown error"}`;
}

async function saveForwardWebhookUrl() {
  const url = els.forwardWebhookUrlInput.value.trim();
  localStorage.setItem(FORWARD_WEBHOOK_URL_STORAGE_KEY, url);
  const response = await fetch("/forwarding/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || "Unable to save forwarding URL.");
  els.forwardWebhookUrlInput.value = state.url || "";
  localStorage.setItem(FORWARD_WEBHOOK_URL_STORAGE_KEY, state.url || "");
  renderForwardingStatus(state);
}

async function loadForwardWebhookUrl() {
  try {
    const response = await fetch("/forwarding/config");
    if (!response.ok) return;
    const state = await response.json();
    const localUrl = localStorage.getItem(FORWARD_WEBHOOK_URL_STORAGE_KEY) || "";
    if (!state.url && localUrl) {
      els.forwardWebhookUrlInput.value = localUrl;
      await saveForwardWebhookUrl();
      return;
    }
    els.forwardWebhookUrlInput.value = state.url;
    localStorage.setItem(FORWARD_WEBHOOK_URL_STORAGE_KEY, state.url);
    renderForwardingStatus(state);
  } catch {
    renderForwardingStatus({ url: els.forwardWebhookUrlInput.value });
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function loadSidebarPreferences() {
  const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  const width = Number.isFinite(savedWidth) ? clamp(savedWidth, MIN_SIDEBAR_WIDTH, 640) : MIN_SIDEBAR_WIDTH;
  const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  els.appShell.style.setProperty("--sidebar-width", `${width}px`);
  els.appShell.classList.toggle("sidebar-collapsed", collapsed);
  els.collapseSidebarButton.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  els.collapseSidebarButton.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
}

function setSidebarCollapsed(collapsed) {
  els.appShell.classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  els.collapseSidebarButton.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  els.collapseSidebarButton.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
}

function syncAppHeight() {
  const statusBarHeight = els.statusBar.getBoundingClientRect().height;
  els.appShell.style.height = `${Math.max(0, window.innerHeight - statusBarHeight)}px`;
}

function setSidebarWidth(width) {
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(720, window.innerWidth - 360));
  const nextWidth = clamp(width, MIN_SIDEBAR_WIDTH, maxWidth);
  els.appShell.style.setProperty("--sidebar-width", `${nextWidth}px`);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
}

function loadAccordionPreferences() {
  const saved = localStorage.getItem(CONTROLS_ACCORDION_OPEN_KEY);
  const legacyOpen =
    localStorage.getItem(LEGACY_CLI_ACCORDION_OPEN_KEY) === "true" ||
    localStorage.getItem(LEGACY_API_ACCORDION_OPEN_KEY) === "true";
  els.controlsAccordion.open = saved == null ? legacyOpen : saved === "true";
}

function saveAccordionPreference(key, details) {
  localStorage.setItem(key, String(details.open));
}

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

function formatEventDate(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function titleFor(event) {
  if (event.customTitle?.trim()) return event.customTitle.trim();
  return defaultTitleFor(event);
}

function defaultTitleFor(event) {
  return event.chargebee?.eventId || "Webhook";
}

function subtitleFor(event) {
  const bits = [formatEventDate(event.receivedAt)];
  if (!event.validJson) bits.push("invalid JSON");
  return bits.join(" · ");
}

function groupTitleFor(event) {
  return event?.chargebee?.type || "Webhook events";
}

function eventPrefixFor(eventType) {
  const type = String(eventType || "Webhook events");
  // Keep compound resource names together (credit_note, item_price, etc.).
  const resources = ["subscription_entitlement", "unbilled_charge", "promotional_credit", "payment_source", "payment_intent", "credit_note", "item_family", "item_price", "gift", "subscription", "customer", "invoice", "transaction", "coupon", "item", "quote", "order", "entitlement"];
  return resources.find((resource) => type === resource || type.startsWith(`${resource}_`)) || type.split("_")[0];
}

function eventPrefixLabel(prefix) {
  return prefix.replace(/[_-]+/g, " ");
}

function groupStorageKey(eventType) {
  return `${GROUP_OPEN_KEY_PREFIX}${encodeURIComponent(eventType || "unknown")}`;
}

function loadGroupOpenState(eventType) {
  return localStorage.getItem(groupStorageKey(eventType)) === "true";
}

function saveGroupOpenState(eventType, open) {
  localStorage.setItem(groupStorageKey(eventType), String(Boolean(open)));
}

function prefixStorageKey(prefix) {
  return `${PREFIX_OPEN_KEY_PREFIX}${encodeURIComponent(prefix || "unknown")}`;
}

function loadPrefixOpenState(prefix) {
  return localStorage.getItem(prefixStorageKey(prefix)) !== "false";
}

function savePrefixOpenState(prefix, open) {
  localStorage.setItem(prefixStorageKey(prefix), String(Boolean(open)));
}

function eventOrderStorageKey(eventType) {
  return `${EVENT_ORDER_KEY_PREFIX}${encodeURIComponent(eventType || "unknown")}`;
}

function loadOrder(key) {
  try {
    const order = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(order) ? order : [];
  } catch {
    return [];
  }
}

function saveOrder(key, order) {
  localStorage.setItem(key, JSON.stringify(order));
}

function orderBySavedIds(items, savedOrder, idForItem) {
  const positions = new Map<any, number>(savedOrder.map((id, index) => [id, index]));
  return [...items].sort((left, right) => {
    const leftPosition = positions.get(idForItem(left));
    const rightPosition = positions.get(idForItem(right));
    if (leftPosition == null && rightPosition == null) return 0;
    if (leftPosition == null) return 1;
    if (rightPosition == null) return -1;
    return leftPosition - rightPosition;
  });
}

function groupEvents(items) {
  const groupsByArrival = [];
  const byType = new Map();

  for (const event of items) {
    const type = groupTitleFor(event);
    let group = byType.get(type);
    if (!group) {
      group = { type, events: [] };
      byType.set(type, group);
      groupsByArrival.push(group);
    }
    group.events.push(event);
  }

  const orderedGroups = orderBySavedIds(groupsByArrival, loadOrder(GROUP_ORDER_STORAGE_KEY), (group) => group.type);
  return orderedGroups.map((group) => ({
    ...group,
    events: orderBySavedIds(group.events, loadOrder(eventOrderStorageKey(group.type)), (event) => event.id),
  }));
}

function moveGroup(type, targetType, placeAfter) {
  const order = groupEvents(events).map((group) => group.type);
  const sourceIndex = order.indexOf(type);
  const targetIndex = order.indexOf(targetType);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

  order.splice(sourceIndex, 1);
  const nextTargetIndex = order.indexOf(targetType);
  order.splice(nextTargetIndex + (placeAfter ? 1 : 0), 0, type);
  saveOrder(GROUP_ORDER_STORAGE_KEY, order);
  render();
}

function moveEventWithinGroup(type, id, targetId, placeAfter) {
  const group = groupEvents(events).find((item) => item.type === type);
  if (!group) return;

  const order = group.events.map((event) => event.id);
  const sourceIndex = order.indexOf(id);
  const targetIndex = order.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

  order.splice(sourceIndex, 1);
  const nextTargetIndex = order.indexOf(targetId);
  order.splice(nextTargetIndex + (placeAfter ? 1 : 0), 0, id);
  saveOrder(eventOrderStorageKey(type), order);
  render();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightedJson(value) {
  const json = JSON.stringify(value, null, 2);
  return escapeHtml(json).replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let className = "token-number";
      if (/^"/.test(match)) {
        className = /:$/.test(match) ? "token-key" : "token-string";
      } else if (match === "true" || match === "false") {
        className = "token-boolean";
      } else if (match === "null") {
        className = "token-null";
      }
      return `<span class="${className}">${match}</span>`;
    },
  );
}

function stringifyPayload(event) {
  if (!event) return "Incoming Chargebee webhook payloads will appear here.";
  if (!event.validJson) return event.rawBody || "";
  const json = JSON.stringify(event.body, null, 2);
  return typeof json === "string" ? json : "No JSON body was stored for this webhook.";
}

function editorValueFor(event) {
  return stringifyPayload(event);
}

function setEditorValue(value) {
  pendingEditorValue = typeof value === "string" ? value : "";
  if (!editor) return;
  if (editor.getValue() !== pendingEditorValue) {
    editor.setValue(pendingEditorValue);
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.revealLine(1);
  }
}

function selectedEvent() {
  return events.find((event) => event.id === selectedId) || null;
}

function ensureGroupOpenForEvent(event) {
  const type = groupTitleFor(event);
  if (!type) return;
  if (!loadGroupOpenState(type)) saveGroupOpenState(type, true);
}

function renderList() {
  els.eventList.replaceChildren();
  els.countLabel.textContent = `${events.length} ${events.length === 1 ? "hook" : "hooks"}`;

  let previousPrefix = null;
  let prefixGroupList = null;
  for (const group of groupEvents(events)) {
    const prefix = eventPrefixFor(group.type);
    if (prefix !== previousPrefix) {
      const section = document.createElement("section");
      const divider = document.createElement("div");
      const label = document.createElement("span");
      const toggle = document.createElement("button");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const firstChevron = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const secondChevron = document.createElementNS("http://www.w3.org/2000/svg", "path");

      section.className = "event-prefix-section";
      section.classList.toggle("collapsed", !loadPrefixOpenState(prefix));
      divider.className = "event-prefix-divider";
      label.textContent = eventPrefixLabel(prefix);
      toggle.className = "event-prefix-toggle";
      toggle.type = "button";
      toggle.title = `Collapse ${eventPrefixLabel(prefix)} events`;
      toggle.setAttribute("aria-label", `Collapse ${eventPrefixLabel(prefix)} events`);
      toggle.setAttribute("aria-expanded", String(loadPrefixOpenState(prefix)));
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      firstChevron.setAttribute("d", "m7 10 5-5 5 5");
      secondChevron.setAttribute("d", "m7 18 5-5 5 5");
      icon.append(firstChevron, secondChevron);
      toggle.append(icon);
      divider.append(label, toggle);

      prefixGroupList = document.createElement("div");
      prefixGroupList.className = "event-prefix-groups";
      section.append(divider, prefixGroupList);
      toggle.addEventListener("click", () => {
        const open = !section.classList.contains("collapsed");
        savePrefixOpenState(prefix, !open);
        renderList();
      });
      els.eventList.append(section);
    }

    const groupNode = els.groupTemplate.content.firstElementChild.cloneNode(true);
    const groupSummary = groupNode.querySelector(".event-group-summary");
    const groupTitle = groupNode.querySelector(".event-group-title");
    const groupCount = groupNode.querySelector(".event-group-count");
    const groupList = groupNode.querySelector(".event-group-list");
    const isSelectedGroup = group.events.some((event) => event.id === selectedId);

    groupNode.open = loadGroupOpenState(group.type);
    groupNode.draggable = true;
    groupNode.dataset.type = group.type;
    groupNode.classList.toggle("selected-group", isSelectedGroup);
    groupTitle.textContent = group.type;
    groupCount.textContent = String(group.events.length);

    groupNode.addEventListener("toggle", () => {
      saveGroupOpenState(group.type, groupNode.open);
    });

    groupNode.addEventListener("dragstart", (dragEvent) => {
      if (dragEvent.target !== groupNode) return;
      draggedGroupType = group.type;
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData("text/plain", group.type);
      groupNode.classList.add("dragging");
    });

    groupNode.addEventListener("dragend", () => {
      draggedGroupType = null;
      els.eventList.querySelectorAll(".dragging, .drag-over-before, .drag-over-after").forEach((node) => {
        node.classList.remove("dragging", "drag-over-before", "drag-over-after");
      });
    });

    groupNode.addEventListener("dragover", (dragEvent) => {
      if (!draggedGroupType || draggedGroupType === group.type) return;
      dragEvent.preventDefault();
      const placeAfter = dragEvent.clientY > groupNode.getBoundingClientRect().top + groupNode.offsetHeight / 2;
      groupNode.classList.toggle("drag-over-before", !placeAfter);
      groupNode.classList.toggle("drag-over-after", placeAfter);
    });

    groupNode.addEventListener("dragleave", () => {
      groupNode.classList.remove("drag-over-before", "drag-over-after");
    });

    groupNode.addEventListener("drop", (dragEvent) => {
      if (!draggedGroupType || draggedGroupType === group.type) return;
      dragEvent.preventDefault();
      const placeAfter = dragEvent.clientY > groupNode.getBoundingClientRect().top + groupNode.offsetHeight / 2;
      moveGroup(draggedGroupType, group.type, placeAfter);
    });

    for (const event of group.events) {
      const node = els.template.content.firstElementChild.cloneNode(true);
      const titleInput = node.querySelector(".event-title-input");

      node.dataset.id = event.id;
      node.draggable = true;
      node.classList.toggle("selected", event.id === selectedId);
      node.querySelector(".event-main").textContent = titleFor(event);
      titleInput.value = titleFor(event);
      titleInput.placeholder = defaultTitleFor(event);
      node.querySelector(".event-sub").textContent = subtitleFor(event);

      node.addEventListener("click", () => {
        selectedId = event.id;
        render();
      });

      node.addEventListener("dragstart", (dragEvent) => {
        draggedEventId = event.id;
        dragEvent.stopPropagation();
        dragEvent.dataTransfer.effectAllowed = "move";
        dragEvent.dataTransfer.setData("text/plain", event.id);
        node.classList.add("dragging");
      });

      node.addEventListener("dragend", () => {
        draggedEventId = null;
        groupList.querySelectorAll(".dragging, .drag-over-before, .drag-over-after").forEach((item) => {
          item.classList.remove("dragging", "drag-over-before", "drag-over-after");
        });
      });

      node.addEventListener("dragover", (dragEvent) => {
        if (!draggedEventId || draggedEventId === event.id) return;
        dragEvent.preventDefault();
        dragEvent.stopPropagation();
        const placeAfter = dragEvent.clientY > node.getBoundingClientRect().top + node.offsetHeight / 2;
        node.classList.toggle("drag-over-before", !placeAfter);
        node.classList.toggle("drag-over-after", placeAfter);
      });

      node.addEventListener("dragleave", () => {
        node.classList.remove("drag-over-before", "drag-over-after");
      });

      node.addEventListener("drop", (dragEvent) => {
        if (!draggedEventId || draggedEventId === event.id) return;
        dragEvent.preventDefault();
        dragEvent.stopPropagation();
        const placeAfter = dragEvent.clientY > node.getBoundingClientRect().top + node.offsetHeight / 2;
        moveEventWithinGroup(group.type, draggedEventId, event.id, placeAfter);
      });

      node.querySelector(".edit-title").addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        node.classList.add("editing");
        titleInput.focus();
        titleInput.select();
      });

      titleInput.addEventListener("keydown", (inputEvent) => {
        inputEvent.stopPropagation();
        if (inputEvent.key === "Enter") titleInput.blur();
        if (inputEvent.key === "Escape") {
          titleInput.value = titleFor(event);
          node.classList.remove("editing");
          titleInput.blur();
        }
      });

      titleInput.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
      });

      titleInput.addEventListener("blur", () => {
        renameEvent(event.id, titleInput.value);
      });

      node.querySelector(".delete-one").addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        deleteEvent(event.id);
      });

      groupList.append(node);
    }

    prefixGroupList.append(groupNode);
    previousPrefix = prefix;
  }
}

function renderSelected() {
  const event = selectedEvent();
  updateResendButton();

  if (!event) {
    els.selectedTime.textContent = "Waiting for webhook";
    els.selectedTitle.textContent = "No payload yet";
    els.metadataSummary.textContent = "No request selected";
    els.metadataCode.textContent = "";
    setEditorValue(editorValueFor(null));
    els.copyBodyButton.disabled = true;
    els.copyObjectButton.disabled = true;
    return;
  }

  const metadata = {
    id: event.id,
    receivedAt: event.receivedAt,
    method: event.method,
    path: event.path,
    remoteAddress: event.remoteAddress,
    validJson: event.validJson,
    parseError: event.parseError,
    chargebee: event.chargebee,
    headers: event.headers,
  };

  els.selectedTime.textContent = formatTime(event.receivedAt);
  els.selectedTitle.textContent = titleFor(event);
  els.metadataSummary.textContent = [
    event.method,
    event.path,
    event.chargebee?.eventId || null,
  ].filter(Boolean).join(" · ");
  els.metadataCode.innerHTML = highlightedJson(metadata);
  setEditorValue(editorValueFor(event));
  els.copyBodyButton.disabled = false;
  els.copyObjectButton.disabled = !event.body?.content;
}

function render() {
  renderList();
  renderSelected();
}

function renderListener() {
  const status = listenerState?.status || "stopped";
  if (listenerState?.command) els.command.textContent = listenerState.command;
  if (listenerState?.publicUrl) els.publicUrl.textContent = `${listenerState.publicUrl}/webhook`;
  const pid = listenerState?.pid ? ` · PID ${listenerState.pid}` : "";
  const labels = {
    starting: "Starting",
    running: "Running",
    stopping: "Stopping",
    stopped: "Stopped",
    error: "Error",
  };

  els.listenerDot.className = `listener-dot ${status}`;
  els.listenerStatus.textContent = `${labels[status] || status}${pid}`;
  els.footerListenerDot.className = `listener-dot ${status}`;
  els.footerListenerStatus.textContent = `ngrok tunnel: ${labels[status] || status}${pid}`;
  els.startListenerButton.disabled = status === "starting" || status === "running" || status === "stopping";
  els.stopListenerButton.disabled = status !== "running" && status !== "starting";

  const logs = listenerState?.logs || [];
  els.listenerLog.textContent = logs.length
    ? logs.map((log) => `[${formatTime(log.at)}] ${log.stream}: ${log.line}`).join("\n")
    : "No listener output yet.";
  els.listenerLog.scrollTop = els.listenerLog.scrollHeight;
}

function receiveEvent(event) {
  events = [...events.filter((item) => item.id !== event.id), event].slice(-MAX_EVENTS);
  selectedId = event.id;
  ensureGroupOpenForEvent(event);
  saveEvents();
  render();
}

function receiveListener(state) {
  listenerState = state;
  renderListener();
}

function deleteEvent(id) {
  const deletedSelected = selectedId === id;
  events = events.filter((event) => event.id !== id);
  if (deletedSelected) selectedId = events[0]?.id || null;
  saveEvents();
  render();
}

function renameEvent(id, title) {
  const event = events.find((item) => item.id === id);
  if (!event) return;

  const trimmed = title.trim();
  event.customTitle = trimmed && trimmed !== defaultTitleFor(event) ? trimmed : null;
  saveEvents();
  render();
}

function clearAll() {
  events = [];
  selectedId = null;
  saveEvents();
  render();
}

function collapseAllGroups() {
  const groups = groupEvents(events);
  if (groups.some((group) => loadGroupOpenState(group.type))) {
    for (const group of groups) {
      saveGroupOpenState(group.type, false);
    }
  } else {
    const prefixes = [...new Set(groups.map((group) => eventPrefixFor(group.type)))];
    for (const prefix of prefixes) {
      savePrefixOpenState(prefix, false);
    }
  }
  renderList();
}

async function copyText(text, button) {
  const original = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 900);
}

function initMonacoEditor() {
  if (!window.require) return;

  window.require.config({ paths: { vs: "/monaco/vs" } });
  window.require(["vs/editor/editor.main"], () => {
    monaco.editor.defineTheme("chargebee-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "ffb66b" },
        { token: "string.value.json", foreground: "82f0b5" },
        { token: "number.json", foreground: "ffd166" },
        { token: "keyword.json", foreground: "e6b98f" },
      ],
      colors: {
        "editor.background": "#160e09",
        "editor.foreground": "#ecdfd3",
        "editorLineNumber.foreground": "#95745d",
        "editorLineNumber.activeForeground": "#fff8f1",
        "editor.selectionBackground": "#ff830066",
        "editor.inactiveSelectionBackground": "#ff830033",
        "editorCursor.foreground": "#ffb66b",
        "editorIndentGuide.background1": "#4b3321",
        "editorIndentGuide.activeBackground1": "#ffb66b",
        "editorWidget.background": "#2a1b12",
        "editorWidget.border": "#745034",
      },
    });

    editor = monaco.editor.create(els.jsonEditor, {
      value: pendingEditorValue,
      language: "json",
      theme: "chargebee-dark",
      readOnly: true,
      domReadOnly: false,
      fontFamily: '"Ubuntu Sans Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 16,
      lineHeight: 24,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: true, side: "right", renderCharacters: false },
      folding: true,
      foldingStrategy: "indentation",
      showFoldingControls: "always",
      wordWrap: "on",
      wrappingIndent: "indent",
      lineNumbersMinChars: 4,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      stickyScroll: { enabled: true },
      renderWhitespace: "selection",
      copyWithSyntaxHighlighting: false,
      contextmenu: true,
      find: {
        addExtraSpaceOnTop: false,
        autoFindInSelection: "multiline",
        seedSearchStringFromSelection: "always",
      },
    });

    editor.addAction({
      id: "copy-selection-or-document",
      label: "Copy selection or document",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
      run: () => {
        const selection = editor.getModel().getValueInRange(editor.getSelection());
        navigator.clipboard.writeText(selection || editor.getValue());
      },
    });
  });
}

function connectEvents() {
  const source = new EventSource("/events");

  source.addEventListener("open", () => {
    // Connected to the local app event stream.
  });

  source.addEventListener("error", () => {
    // EventSource auto-reconnects; listener state is reported separately.
  });

  source.addEventListener("webhook", (message) => {
    receiveEvent(JSON.parse(message.data));
  });

  source.addEventListener("listener", (message) => {
    receiveListener(JSON.parse(message.data));
  });

  source.addEventListener("forwarding", (message) => {
    renderForwardingStatus(JSON.parse(message.data));
  });
}

async function postListenerAction(action) {
  const response = await fetch(`/listener/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(`Listener ${action} failed`);
  receiveListener(await response.json());
}

els.copyBodyButton.addEventListener("click", () => {
  if (!editor) return;
  copyText(editor.getValue(), els.copyBodyButton);
});

els.copyObjectButton.addEventListener("click", () => {
  const event = selectedEvent();
  const content = event?.body?.content;
  if (!content) return;
  copyText(JSON.stringify(content, null, 2), els.copyObjectButton);
});

els.collapseAllGroupsButton.addEventListener("click", collapseAllGroups);

els.clearAllButton.addEventListener("click", () => {
  if (events.length === 0) return;
  if (window.confirm("Delete all stored webhooks from this browser?")) clearAll();
});

els.forwardWebhookUrlInput.addEventListener("input", () => {
  clearTimeout(forwardingSaveTimer);
  forwardingSaveTimer = setTimeout(() => {
    saveForwardWebhookUrl().catch((error) => {
      els.forwardingStatus.textContent = `Forwarding: ${error.message}`;
    });
  }, 500);
});
els.forwardWebhookUrlInput.addEventListener("blur", () => {
  clearTimeout(forwardingSaveTimer);
  saveForwardWebhookUrl().catch((error) => {
    els.forwardingStatus.textContent = `Forwarding: ${error.message}`;
  });
});

els.collapseSidebarButton.addEventListener("click", () => {
  setSidebarCollapsed(!els.appShell.classList.contains("sidebar-collapsed"));
});

els.controlsAccordion.addEventListener("toggle", () => {
  saveAccordionPreference(CONTROLS_ACCORDION_OPEN_KEY, els.controlsAccordion);
});

els.resizeHandle.addEventListener("pointerdown", (event) => {
  if (els.appShell.classList.contains("sidebar-collapsed")) return;
  isResizingSidebar = true;
  document.body.classList.add("resizing-sidebar");
  els.resizeHandle.setPointerCapture(event.pointerId);
});

els.resizeHandle.addEventListener("pointermove", (event) => {
  if (!isResizingSidebar) return;
  setSidebarWidth(event.clientX);
});

function stopSidebarResize(event) {
  if (!isResizingSidebar) return;
  isResizingSidebar = false;
  document.body.classList.remove("resizing-sidebar");
  if (event?.pointerId != null) els.resizeHandle.releasePointerCapture(event.pointerId);
}

els.resizeHandle.addEventListener("pointerup", stopSidebarResize);
els.resizeHandle.addEventListener("pointercancel", stopSidebarResize);

els.startListenerButton.addEventListener("click", async () => {
  try {
    els.startListenerButton.disabled = true;
    await postListenerAction("start");
  } catch (error) {
    window.alert(error.message);
  }
});

els.stopListenerButton.addEventListener("click", async () => {
  try {
    els.stopListenerButton.disabled = true;
    await postListenerAction("stop");
  } catch (error) {
    window.alert(error.message);
  }
});

loadSidebarPreferences();
loadAccordionPreferences();
loadSettings();
syncAppHeight();
render();
renderListener();
loadForwardWebhookUrl();
initMonacoEditor();
connectEvents();

window.addEventListener("resize", syncAppHeight);
window.visualViewport?.addEventListener("resize", syncAppHeight);

function updateResendButton() {
  els.resendButton.disabled = resending || !selectedEvent() || !forwardingState?.url;
  els.resendButton.textContent = resending ? "Resending…" : "Resend";
}

els.resendButton.addEventListener("click", async () => {
  const event = selectedEvent();
  if (!event || resending) return;
  resending = true;
  updateResendButton();
  try {
    clearTimeout(forwardingSaveTimer);
    await saveForwardWebhookUrl();
    const response = await fetch("/forwarding/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: event.path, headers: event.headers, rawBody: event.rawBody, eventId: event.id }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Resend failed.");
    renderForwardingStatus({ ...forwardingState, lastResult: result });
  } catch (error) {
    els.forwardingStatus.textContent = `Resend failed: ${error.message}`;
  } finally {
    resending = false;
    updateResendButton();
  }
});
