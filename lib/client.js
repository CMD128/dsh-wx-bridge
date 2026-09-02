window.__ModuleLoader__.load({
	id: "dsh-wechat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client-src/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);
var name = "dsh-wechat";
var inject = ["slots"];
var STATE_LABELS = {
  idle: "\u672A\u542F\u7528",
  await_scan: "\u7B49\u5F85\u626B\u7801",
  scanned: "\u5DF2\u626B\u7801\u5F85\u786E\u8BA4",
  need_verifycode: "\u9700\u8981\u9A8C\u8BC1\u7801",
  connecting: "\u8FDE\u63A5\u4E2D\u2026",
  connected: "\u5DF2\u8FDE\u63A5",
  error: "\u51FA\u9519"
};
var styles = {
  wrap: { padding: "16px 20px", maxWidth: 760, fontFamily: "inherit", color: "var(--dsw-alias-label-primary, #1b1b1c)" },
  card: { border: "1px solid var(--dsw-alias-border-l2, #e2e4e9)", borderRadius: 10, padding: "14px 16px", marginBottom: 14, background: "var(--dsw-alias-bg-layer-2, #fff)" },
  head: { display: "flex", alignItems: "center", gap: 10, marginBottom: 6 },
  title: { fontWeight: 600, fontSize: 15, color: "var(--dsw-alias-label-primary, #1b1b1c)" },
  desc: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 12.5, marginBottom: 10 },
  dot: (color) => ({ width: 9, height: 9, borderRadius: 9, background: color, flexShrink: 0 }),
  state: { fontSize: 12.5, color: "var(--dsw-alias-label-tertiary, #888)" },
  row: { display: "flex", gap: 10, marginBottom: 8, alignItems: "center" },
  field: { flex: 1, display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 12, color: "var(--dsw-alias-label-caption, #999)" },
  input: { padding: "7px 10px", fontSize: 13, borderRadius: 7, border: "1px solid var(--dsw-alias-border-l3, #ddd)", background: "var(--dsw-specific-input-major, #fff)", color: "var(--dsw-alias-label-primary, #1b1b1c)" },
  btn: { padding: "7px 16px", fontSize: 13, borderRadius: 7, border: "1px solid var(--dsw-alias-border-l3, #ddd)", background: "var(--dsw-alias-button-elevated-fill, #fff)", cursor: "pointer", color: "var(--dsw-alias-label-primary, #1b1b1c)" },
  btnPrimary: { padding: "7px 16px", fontSize: 13, borderRadius: 7, border: "none", background: "var(--dsw-alias-button-info-fill, #4176e6)", color: "#fff", cursor: "pointer" },
  btnDanger: { padding: "7px 16px", fontSize: 13, borderRadius: 7, border: "none", background: "#e6432d", color: "#fff", cursor: "pointer" },
  qr: { width: 200, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #eee)", display: "block", margin: "10px 0", background: "#fff" },
  toast: { position: "fixed", bottom: 24, right: 24, background: "var(--dsw-alias-toast-bg, #222)", color: "#fff", padding: "10px 16px", borderRadius: 8, fontSize: 13, zIndex: 9999 },
  err: { color: "var(--dsw-alias-state-error-primary, #e6432d)", fontSize: 12.5, marginTop: 6, wordBreak: "break-all" },
  hint: { fontSize: 12, color: "var(--dsw-alias-label-caption, #999)", marginTop: 10 },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dsw-alias-label-secondary, #555)" }
};
function stateColor(state, online) {
  if (online || state === "connected") return "#07c160";
  if (state === "error") return "#e6432d";
  if (state === "idle") return "#bbb";
  return "#fa9d3b";
}
function WechatSettings() {
  const [config, setConfig] = (0, import_react.useState)(null);
  const [status, setStatus] = (0, import_react.useState)(null);
  const [sessions, setSessions] = (0, import_react.useState)(null);
  const [toast, setToast] = (0, import_react.useState)("");
  const toastTimer = (0, import_react.useRef)(null);
  const showToast = (0, import_react.useCallback)((text) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      const [cfg, st2, ss] = await Promise.all([
        fetch("/chatops/api/config").then((r) => r.json()),
        fetch("/chatops/api/status").then((r) => r.json()),
        fetch("/chatops/api/sessions").then((r) => r.json())
      ]);
      if (cfg?.ok) setConfig((prev) => prev && prev.__dirty ? prev : { ...cfg.result, __dirty: false });
      if (st2?.ok) setStatus(st2.result);
      if (ss?.ok) setSessions(ss.result.sessions);
    } catch {
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3e3);
    return () => clearInterval(timer);
  }, [refresh]);
  const edit = (path, value) => {
    setConfig((prev) => {
      const next = structuredClone(prev);
      let node = next;
      for (const key of path.slice(0, -1)) node = node[key] ??= {};
      node[path[path.length - 1]] = value;
      next.__dirty = true;
      return next;
    });
  };
  const save = async () => {
    if (!config) return;
    if (config.approval?.enabled) {
      const code = String(config.approval?.authCode ?? "");
      if (!/^\d{4,6}$/.test(code)) {
        showToast("\u274C \u542F\u7528\u6388\u6743\u7801\u987B\u586B\u5199 4-6 \u4F4D\u6570\u5B57");
        return;
      }
    }
    const { __dirty, ...clean } = config;
    const response = await fetch("/chatops/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: clean })
    });
    if (response.ok) {
      setConfig({ ...clean, __dirty: false });
      showToast("\u2705 \u5DF2\u4FDD\u5B58\uFF0C\u63D2\u4EF6\u70ED\u91CD\u8F7D\u4E2D\uFF08\u82E5\u901A\u9053\u672A\u53D8\u5316\u8BF7\u91CD\u542F dsh web\uFF09");
    } else {
      showToast("\u274C \u4FDD\u5B58\u5931\u8D25");
    }
  };
  const rebind = async () => {
    await fetch("/chatops/api/rebind", { method: "POST" });
    showToast("\u5DF2\u89E3\u7ED1\uFF0C\u6B63\u5728\u751F\u6210\u65B0\u4E8C\u7EF4\u7801\u2026");
    setTimeout(() => void refresh(), 1500);
  };
  if (!config) return import_react.default.createElement("div", { style: styles.wrap }, "\u52A0\u8F7D\u4E2D\u2026");
  const st = status ?? {};
  const s = st.state ?? "idle";
  const online = Boolean(st.online);
  const authCodeOn = Boolean(config.approval?.enabled);
  return import_react.default.createElement(
    "div",
    { style: styles.wrap },
    import_react.default.createElement("h3", { style: { margin: "0 0 4px" } }, "\u5FAE\u4FE1\u901A\u9053"),
    import_react.default.createElement(
      "div",
      { style: { ...styles.desc, marginBottom: 14 } },
      "\u5FAE\u4FE1\u5B98\u65B9 ClawBot\uFF08iLink\uFF09\uFF1A\u626B\u7801\u7ED1\u5B9A\u540E\uFF0C\u79C1\u804A\u5373\u53EF\u9A71\u52A8 DSH \u4F1A\u8BDD\u3002\u51ED\u636E\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\u3002"
    ),
    // 连接状态卡
    import_react.default.createElement(
      "div",
      { style: styles.card },
      import_react.default.createElement(
        "div",
        { style: styles.head },
        import_react.default.createElement("span", { style: styles.dot(stateColor(s, online)) }),
        import_react.default.createElement("span", { style: styles.title }, "\u8FDE\u63A5\u72B6\u6001"),
        import_react.default.createElement("span", { style: { ...styles.state, marginLeft: "auto" } }, STATE_LABELS[s] ?? s)
      ),
      st.ownerUserId ? import_react.default.createElement("div", { style: styles.desc }, `\u5DF2\u7ED1\u5B9A\u8D26\u53F7\uFF1A${st.ownerUserId}`) : import_react.default.createElement("div", { style: styles.desc }, "\u5C1A\u672A\u7ED1\u5B9A\u5FAE\u4FE1\u8D26\u53F7"),
      s === "await_scan" && st.qrDataUrl ? import_react.default.createElement("img", { src: st.qrDataUrl, style: styles.qr, alt: "\u5FAE\u4FE1\u626B\u7801\u7ED1\u5B9A" }) : null,
      import_react.default.createElement(
        "div",
        { style: styles.row },
        import_react.default.createElement("button", { style: styles.btnDanger, onClick: () => void rebind() }, "\u89E3\u7ED1\u5E76\u91CD\u65B0\u626B\u7801")
      )
    ),
    // 授权码卡
    import_react.default.createElement(
      "div",
      { style: styles.card },
      import_react.default.createElement(
        "div",
        { style: styles.head },
        import_react.default.createElement("span", { style: styles.title }, "\u5371\u9669\u64CD\u4F5C\u6388\u6743\u7801")
      ),
      import_react.default.createElement(
        "div",
        { style: styles.desc },
        "\u5F00\u542F\u540E\uFF0C\u5FAE\u4FE1\u91CC\u7684\u5371\u9669\u64CD\u4F5C\u5BA1\u6279\u9700\u56DE\u590D\u6388\u6743\u7801\u624D\u653E\u884C\uFF08\u9632\u8BEF\u64CD\u4F5C\uFF09\u3002\u5173\u95ED = \u76F4\u63A5 /approve \u5373\u53EF\u3002"
      ),
      import_react.default.createElement(
        "div",
        { style: styles.row },
        import_react.default.createElement(
          "label",
          { style: styles.check },
          import_react.default.createElement("input", {
            type: "checkbox",
            checked: authCodeOn,
            onChange: (e) => edit(["approval", "enabled"], e.target.checked)
          }),
          "\u542F\u7528\u6388\u6743\u7801"
        ),
        authCodeOn ? import_react.default.createElement("input", { style: { ...styles.input, width: 140 }, value: String(config.approval?.authCode ?? ""), onChange: (e) => edit(["approval", "authCode"], e.target.value.replace(/\D/g, "").slice(0, 6)), placeholder: "4-6 \u4F4D\u6570\u5B57", maxLength: 6 }) : null
      ),
      import_react.default.createElement(
        "div",
        { style: styles.row },
        import_react.default.createElement(
          "label",
          { style: styles.check },
          import_react.default.createElement("input", { type: "checkbox", checked: config.push?.onSessionComplete !== false, onChange: (e) => edit(["push", "onSessionComplete"], e.target.checked) }),
          "\u4EFB\u52A1\u5B8C\u6210\u63A8\u9001"
        )
      )
    ),
    // 默认会话卡
    import_react.default.createElement(
      "div",
      { style: styles.card },
      import_react.default.createElement(
        "div",
        { style: styles.head },
        import_react.default.createElement("span", { style: styles.title }, "\u9ED8\u8BA4\u5BF9\u63A5\u4F1A\u8BDD")
      ),
      import_react.default.createElement(
        "div",
        { style: styles.desc },
        "\u5FAE\u4FE1\u672A\u7528 /use \u6307\u5B9A\u4F1A\u8BDD\u65F6\uFF0C\u6D88\u606F\u81EA\u52A8\u53D1\u5F80\u6B64\u4F1A\u8BDD\uFF08\u7559\u7A7A = \u6700\u8FD1\u6D3B\u8DC3\u4F1A\u8BDD\uFF09\u3002"
      ),
      import_react.default.createElement(
        "div",
        { style: styles.row },
        import_react.default.createElement(
          "select",
          {
            style: { ...styles.input, flex: 1 },
            value: config.defaultSessionId ?? "",
            onChange: (e) => edit(["defaultSessionId"], e.target.value || "")
          },
          import_react.default.createElement("option", { value: "" }, "\uFF08\u81EA\u52A8\uFF1A\u6700\u8FD1\u6D3B\u8DC3\u4F1A\u8BDD\uFF09"),
          (sessions ?? []).map((s2) => import_react.default.createElement("option", { key: s2.id, value: s2.id }, `${s2.live ? "\u25CF" : "\u25CB"} ${s2.title}`))
        )
      )
    ),
    // 保存
    import_react.default.createElement(
      "div",
      { style: styles.row },
      import_react.default.createElement(
        "button",
        { style: config.__dirty ? styles.btnPrimary : styles.btn, onClick: () => void save() },
        config.__dirty ? "\u4FDD\u5B58\uFF08\u6709\u6539\u52A8\uFF09" : "\u4FDD\u5B58"
      )
    ),
    toast ? import_react.default.createElement("div", { style: styles.toast }, toast) : null
  );
}
function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-wechat",
    order: 22,
    label: () => "\u5FAE\u4FE1\u901A\u9053"
  }, WechatSettings));
}

		return module.exports;
	}
});
