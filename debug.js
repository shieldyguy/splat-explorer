// Settings panel — tabbed sections + optional telemetry log.
//
// Two visibility gates:
//   - `body[data-debug]` OR `?debug` → control panel renders. This is the
//     user-facing UI; on this page it's always on.
//   - `?debug` alone → live telemetry log lines render. Dev-only; never
//     surfaced to end users.

const panel = document.getElementById("debug-panel");
const handleEl = document.getElementById("debug-handle");
const tabsEl = document.getElementById("debug-tabs");
const bodyEl = document.getElementById("debug-body");
const actionsEl = document.getElementById("debug-actions");
const toastEl = document.getElementById("debug-toast");
const logEl = document.getElementById("debug-log");

const params = new URLSearchParams(window.location.search);
export const active = params.has("debug") || document.body.hasAttribute("data-debug");
const logActive = params.has("debug");

if (active) panel.classList.add("visible");
if (!logActive && logEl) logEl.hidden = true;

// Mobile bottom sheet — handle taps toggle open/closed. CSS handles the
// transform; we only flip the class + aria state.
if (handleEl) {
  handleEl.addEventListener("click", () => {
    const open = !panel.classList.contains("drawer-open");
    panel.classList.toggle("drawer-open", open);
    handleEl.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

// ── Tabs ─────────────────────────────────────────────────────────────

let activeTab = null;
const sections = new Map();

function setActiveTab(name) {
  if (!sections.has(name)) return;
  activeTab = name;
  for (const [n, { tab, container }] of sections) {
    const on = n === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    container.hidden = !on;
  }
  // Reset scroll so a fresh tab always starts at the top.
  if (bodyEl) bodyEl.scrollTop = 0;
}

export function setActiveSection(name) {
  setActiveTab(name);
}

// ── Section API ──────────────────────────────────────────────────────

export function section(name) {
  if (!active) return noopSection();
  if (sections.has(name)) return sections.get(name).api;

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "tab";
  tab.dataset.tab = name;
  tab.textContent = name;
  tab.setAttribute("role", "tab");
  tab.addEventListener("click", () => setActiveTab(name));
  tabsEl.appendChild(tab);

  const container = document.createElement("div");
  container.className = "panel-section";
  container.dataset.section = name;
  bodyEl.appendChild(container);

  const api = buildSectionApi(container);
  // Override remove so the tab + map entry are torn down with the body.
  api.remove = () => {
    container.remove();
    tab.remove();
    sections.delete(name);
    if (activeTab === name) {
      activeTab = null;
      const next = sections.keys().next().value;
      if (next) setActiveTab(next);
    }
  };
  sections.set(name, { api, tab, container });
  if (!activeTab) setActiveTab(name);
  return api;
}

function buildSectionApi(container) {
  const add = (el) => container.appendChild(el);

  return {
    clear() {
      container.innerHTML = "";
    },
    remove() {
      container.remove();
    },

    header(text) {
      const el = document.createElement("div");
      el.className = "control-header";
      el.textContent = text;
      add(el);
    },

    slider(label, { min, max, step, value, onChange }) {
      const row = document.createElement("div");
      row.className = "control-row control-slider";
      const lbl = document.createElement("label");
      lbl.className = "control-label";
      lbl.textContent = label;
      const range = document.createElement("input");
      range.type = "range";
      range.min = min;
      range.max = max;
      range.step = step;
      range.value = value;
      range.className = "control-range";
      const num = document.createElement("input");
      num.type = "number";
      num.min = min;
      num.max = max;
      num.step = step;
      num.value = value;
      num.className = "control-num";
      row.append(lbl, range, num);
      add(row);
      range.addEventListener("input", () => {
        num.value = range.value;
        onChange(parseFloat(range.value));
      });
      num.addEventListener("input", () => {
        range.value = num.value;
        onChange(parseFloat(num.value));
      });
    },

    select(label, options, opts) {
      const onChange = typeof opts === "function" ? opts : opts.onChange;
      const value = typeof opts === "function" ? 0 : (opts.value ?? 0);
      const row = document.createElement("div");
      row.className = "control-row control-select";
      const lbl = document.createElement("label");
      lbl.className = "control-label";
      lbl.textContent = label;
      const sel = document.createElement("select");
      sel.className = "control-selectbox";
      options.forEach((opt, i) => {
        const o = document.createElement("option");
        o.value = i;
        o.textContent = opt;
        sel.appendChild(o);
      });
      sel.value = String(value);
      row.append(lbl, sel);
      add(row);
      sel.addEventListener("change", () => onChange(parseInt(sel.value)));
    },

    checkbox(label, { value = false, onChange } = {}) {
      const row = document.createElement("label");
      row.className = "control-row control-checkbox";
      const lbl = document.createElement("span");
      lbl.className = "control-label";
      lbl.textContent = label;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.className = "control-check";
      row.append(lbl, input);
      add(row);
      input.addEventListener("change", () => onChange(input.checked));
    },

    color(label, { value = "#ffffff", onChange } = {}) {
      const row = document.createElement("div");
      row.className = "control-row control-color";
      const lbl = document.createElement("label");
      lbl.className = "control-label";
      lbl.textContent = label;
      const input = document.createElement("input");
      input.type = "color";
      input.value = value;
      input.className = "control-colorbox";
      row.append(lbl, input);
      add(row);
      input.addEventListener("input", () => onChange(input.value));
    },

    // button(label, onClick) — full-width primary
    // button(label, { onClick, subtle: true }) — bordered/transparent
    button(label, onClickOrOpts) {
      const onClick =
        typeof onClickOrOpts === "function"
          ? onClickOrOpts
          : onClickOrOpts.onClick;
      const subtle =
        typeof onClickOrOpts === "function" ? false : !!onClickOrOpts.subtle;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.className = subtle ? "control-button subtle" : "control-button";
      btn.addEventListener("click", onClick);
      add(btn);
    },
  };
}

function noopSection() {
  const noop = () => {};
  return {
    clear: noop,
    remove: noop,
    header: noop,
    slider: noop,
    select: noop,
    checkbox: noop,
    color: noop,
    button: noop,
  };
}

// ── Header actions (top-right of panel) ──────────────────────────────

export function action(label, { icon, title, onClick } = {}) {
  if (!active) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "panel-action";
  btn.title = title ?? label;
  btn.setAttribute("aria-label", label);
  const iconEl = document.createElement("span");
  iconEl.className = "panel-action-icon";
  iconEl.textContent = icon ?? "";
  const labelEl = document.createElement("span");
  labelEl.className = "panel-action-label";
  labelEl.textContent = label;
  btn.append(iconEl, labelEl);
  actionsEl.appendChild(btn);
  btn.addEventListener("click", onClick);
  return btn;
}

// ── Global toast ─────────────────────────────────────────────────────

let toastTimer = 0;
export function flash(msg) {
  if (!active || !toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 1800);
}

// ── Telemetry log (dev-only, ?debug) ─────────────────────────────────

const lines = {};
export function log(key, value) {
  if (!logActive) return;
  lines[key] = value;
  logEl.innerHTML = Object.entries(lines)
    .map(([k, v]) => `<div><span class="log-key">${k}:</span> ${v}</div>`)
    .join("");
}
