// Debug panel — show with ?debug in URL
const panel = document.getElementById("debug-panel");
const logEl = document.getElementById("debug-log");
const controlsEl = document.getElementById("debug-controls");

// Active when ?debug is in the URL OR when the host page sets a
// `<body data-debug>` attribute (used by /splat/, where the panel is
// the whole point and shouldn't require a URL flag).
export const active =
  new URLSearchParams(window.location.search).has("debug") ||
  document.body.hasAttribute("data-debug");
if (active) panel.classList.add("visible");

const lines = {};

export function log(key, value) {
  if (!active) return;
  lines[key] = value;
  logEl.innerHTML = Object.entries(lines)
    .map(([k, v]) => `<div><span style="color:#888">${k}:</span> ${v}</div>`)
    .join("");
}

// Create a scoped section of controls.
// Each section can be independently cleared without affecting others.
export function section() {
  const container = document.createElement("div");
  controlsEl.appendChild(container);

  function addTo(el) {
    container.appendChild(el);
  }

  return {
    clear() {
      container.innerHTML = "";
    },
    remove() {
      container.remove();
    },

    slider(label, { min, max, step, value, onChange }) {
      if (!active) return;
      const row = document.createElement("label");
      const range = document.createElement("input");
      const num = document.createElement("input");
      range.type = "range";
      range.min = min;
      range.max = max;
      range.step = step;
      range.value = value;
      num.type = "number";
      num.min = min;
      num.max = max;
      num.step = step;
      num.value = value;
      num.style.cssText =
        "width:52px;background:#333;color:#999;border:1px solid #555;padding:1px 4px;font-family:monospace;font-size:11px;";
      row.append(label + " ", range, num);
      addTo(row);
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
      if (!active) return;
      // Backward compat: accept either `(label, options, onChange)` or
      // `(label, options, { value, onChange })`.
      const onChange = typeof opts === "function" ? opts : opts.onChange;
      const value = typeof opts === "function" ? 0 : (opts.value ?? 0);
      const row = document.createElement("label");
      const sel = document.createElement("select");
      sel.style.cssText =
        "background:#333;color:#ddd;border:1px solid #555;padding:2px 4px;margin-left:6px;";
      options.forEach((opt, i) => {
        const o = document.createElement("option");
        o.value = i;
        o.textContent = opt;
        sel.appendChild(o);
      });
      sel.value = String(value);
      row.append(label + " ", sel);
      addTo(row);
      sel.addEventListener("change", () => onChange(parseInt(sel.value)));
    },

    // button(label, onClick) — primary (bold, full-width)
    // button(label, { onClick, subtle: true }) — bordered/transparent variant
    button(label, onClickOrOpts) {
      if (!active) return;
      const onClick =
        typeof onClickOrOpts === "function"
          ? onClickOrOpts
          : onClickOrOpts.onClick;
      const subtle =
        typeof onClickOrOpts === "function" ? false : !!onClickOrOpts.subtle;
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = subtle
        ? "background:transparent;color:#ccc;border:1px solid #555;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:monospace;font-weight:normal;margin:6px 0 14px;width:100%;"
        : "color:#000;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-family:monospace;font-weight:bold;margin-top:6px;width:100%;";
      btn.addEventListener("click", onClick);
      addTo(btn);
    },

    color(label, { value = "#ffffff", onChange } = {}) {
      if (!active) return;
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "color";
      input.value = value;
      input.style.cssText =
        "width:28px;height:20px;background:none;border:1px solid #555;padding:0;cursor:pointer;margin-left:auto;";
      row.append(label + " ", input);
      addTo(row);
      input.addEventListener("input", () => onChange(input.value));
    },

    checkbox(label, { value = false, onChange } = {}) {
      if (!active) return;
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.style.cssText = "margin-right:6px;";
      row.append(input, label);
      addTo(row);
      input.addEventListener("change", () => onChange(input.checked));
    },

    flash(msg) {
      if (!active) return;
      const el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText =
        "color:#ddd;text-align:center;padding:4px;font-weight:bold;";
      addTo(el);
      setTimeout(() => el.remove(), 2000);
    },

    header(text) {
      if (!active) return;
      const el = document.createElement("div");
      el.textContent = text;
      el.style.cssText =
        "color:#e8c96e;font-size:10px;letter-spacing:0.12em;margin:8px 0 4px;border-top:1px solid rgba(255,255,255,0.15);padding-top:8px;";
      addTo(el);
    },
  };
}
