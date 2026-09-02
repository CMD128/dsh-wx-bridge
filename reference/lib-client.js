window.__ModuleLoader__.load({
	id: "dsh-chatops",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react, 1);

//#region src/client/index.tsx
/**
* dsh-chatops client half: a settings-page tab「IM 通道」(settings.section
* slot — the DSH-idiomatic extension point for plugin settings).
*
* Four channel cards (WeChat ClawBot / Feishu / DingTalk / WeCom), each with
* live status, enable toggle, and credential form. WeChat additionally shows
* the binding QR inline and a re-bind button. All data flows through the
* host's loopback API (/chatops/api/*); saving writes a profile override row
* and cordis hot-reloads the plugin.
*/
const name = "dsh-chatops";
const inject = ["slots"];
const CHANNELS = [
	{
		kind: "ilink",
		title: "微信 · ClawBot",
		desc: "扫码绑定官方机器人，普通微信里直接聊",
		creds: []
	},
	{
		kind: "feishu",
		title: "飞书",
		desc: "自建应用 + 机器人能力，长连接",
		creds: [["appId", "App ID"], [
			"appSecret",
			"App Secret",
			true
		]]
	},
	{
		kind: "dingtalk",
		title: "钉钉",
		desc: "企业内部应用 + Stream 模式",
		creds: [["clientId", "Client ID"], [
			"clientSecret",
			"Client Secret",
			true
		]]
	},
	{
		kind: "wecom",
		title: "企业微信",
		desc: "智能机器人（仅企业内成员可见）",
		creds: [["botId", "Bot ID"], [
			"secret",
			"Secret",
			true
		]]
	}
];
const STATE_LABELS = {
	idle: "未启用",
	await_scan: "等待扫码",
	scanned: "已扫码待确认",
	need_verifycode: "需要验证码",
	connecting: "连接中…",
	connected: "已连接",
	reconnecting: "重连中…",
	error: "出错"
};
const styles = {
	wrap: {
		padding: "16px 20px",
		maxWidth: 760,
		fontFamily: "inherit",
		color: "var(--dsw-alias-label-primary, #1b1b1c)"
	},
	card: {
		border: "1px solid var(--dsw-alias-border-l2, #e2e4e9)",
		borderRadius: 10,
		padding: "14px 16px",
		marginBottom: 14,
		background: "var(--dsw-alias-bg-layer-2, #fff)"
	},
	head: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		marginBottom: 6
	},
	title: {
		fontWeight: 600,
		fontSize: 15,
		color: "var(--dsw-alias-label-primary, #1b1b1c)"
	},
	desc: {
		color: "var(--dsw-alias-label-tertiary, #888)",
		fontSize: 12.5,
		marginBottom: 10
	},
	dot: (color) => ({
		width: 9,
		height: 9,
		borderRadius: 9,
		background: color,
		flexShrink: 0
	}),
	state: {
		fontSize: 12.5,
		color: "var(--dsw-alias-label-tertiary, #888)"
	},
	toggle: {
		marginLeft: "auto",
		display: "flex",
		alignItems: "center",
		gap: 6,
		fontSize: 13,
		color: "var(--dsw-alias-label-secondary, #555)"
	},
	row: {
		display: "flex",
		gap: 10,
		marginBottom: 8
	},
	field: {
		flex: 1,
		display: "flex",
		flexDirection: "column",
		gap: 4
	},
	label: {
		fontSize: 12,
		color: "var(--dsw-alias-label-caption, #999)"
	},
	input: {
		padding: "7px 10px",
		fontSize: 13,
		borderRadius: 7,
		border: "1px solid var(--dsw-alias-border-l3, #ddd)",
		background: "var(--dsw-specific-input-major, #fff)",
		color: "var(--dsw-alias-label-primary, #1b1b1c)"
	},
	btn: {
		padding: "7px 16px",
		fontSize: 13,
		borderRadius: 7,
		border: "1px solid var(--dsw-alias-border-l3, #ddd)",
		background: "var(--dsw-alias-button-elevated-fill, #fff)",
		cursor: "pointer",
		color: "var(--dsw-alias-label-primary, #1b1b1c)"
	},
	btnPrimary: {
		padding: "7px 16px",
		fontSize: 13,
		borderRadius: 7,
		border: "none",
		background: "var(--dsw-alias-button-info-fill, #4176e6)",
		color: "#fff",
		cursor: "pointer"
	},
	qr: {
		width: 200,
		borderRadius: 8,
		border: "1px solid var(--dsw-alias-border-l2, #eee)",
		display: "block",
		margin: "10px 0",
		background: "#fff"
	},
	toast: {
		position: "fixed",
		bottom: 24,
		right: 24,
		background: "var(--dsw-alias-toast-bg, #222)",
		color: "#fff",
		padding: "10px 16px",
		borderRadius: 8,
		fontSize: 13,
		zIndex: 9999
	},
	err: {
		color: "var(--dsw-alias-state-error-primary, #e6432d)",
		fontSize: 12.5,
		marginTop: 6,
		wordBreak: "break-all"
	},
	hint: {
		fontSize: 12,
		color: "var(--dsw-alias-label-caption, #999)",
		marginTop: 10
	}
};
function stateColor(state, online) {
	if (online || state === "connected") return "#07c160";
	if (state === "error") return "#e6432d";
	if (state === "idle") return "#bbb";
	return "#fa9d3b";
}
function ChatopsSettings() {
	const [config, setConfig] = (0, react.useState)(null);
	const [status, setStatus] = (0, react.useState)(null);
	const [toast, setToast] = (0, react.useState)("");
	const toastTimer = (0, react.useRef)(null);
	const showToast = (0, react.useCallback)((text) => {
		setToast(text);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(""), 2600);
	}, []);
	const refresh = (0, react.useCallback)(async () => {
		try {
			const [cfg, st] = await Promise.all([fetch("/chatops/api/config").then((r) => r.json()), fetch("/chatops/api/status").then((r) => r.json())]);
			if (cfg?.ok) setConfig((prev) => prev && prev.__dirty ? prev : {
				...cfg.result,
				__dirty: false
			});
			if (st?.ok) setStatus(st.result);
		} catch {}
	}, []);
	(0, react.useEffect)(() => {
		refresh();
		const timer = setInterval(() => {
			refresh();
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
		const { __dirty, ...clean } = config;
		if ((await fetch("/chatops/api/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config: clean })
		})).ok) {
			setConfig({
				...clean,
				__dirty: false
			});
			showToast("✅ 已保存，插件热重载中（若通道未变化请重启 dsh web）");
		} else showToast("❌ 保存失败");
	};
	const rebind = async () => {
		await fetch("/chatops/api/rebind", { method: "POST" });
		showToast("已解绑，正在生成新二维码…");
		setTimeout(() => void refresh(), 1500);
	};
	if (!config) return react.default.createElement("div", { style: styles.wrap }, "加载中…");
	const enabled = Array.isArray(config.channels) ? config.channels : [config.channel ?? "ilink"];
	const channelStatus = (kind) => status?.channels?.[kind] ?? (kind === "ilink" ? status : null);
	return react.default.createElement("div", { style: styles.wrap }, react.default.createElement("h3", { style: { margin: "0 0 4px" } }, "IM 通道"), react.default.createElement("div", { style: {
		...styles.desc,
		marginBottom: 14
	} }, "微信 / 飞书 / 钉钉 / 企业微信 四通道可并行。凭据仅保存在本机 profile 配置中。"), ...CHANNELS.map((meta) => {
		const st = channelStatus(meta.kind);
		const isOn = enabled.includes(meta.kind);
		return react.default.createElement("div", {
			key: meta.kind,
			style: styles.card
		}, react.default.createElement("div", { style: styles.head }, react.default.createElement("span", { style: styles.dot(stateColor(st?.state, st?.online)) }), react.default.createElement("span", { style: styles.title }, meta.title), react.default.createElement("span", { style: styles.state }, isOn ? STATE_LABELS[st?.state ?? "connecting"] ?? st?.state ?? "…" : "未启用"), react.default.createElement("label", { style: styles.toggle }, react.default.createElement("input", {
			type: "checkbox",
			checked: isOn,
			onChange: (e) => {
				const next = e.target.checked ? [...enabled, meta.kind] : enabled.filter((k) => k !== meta.kind);
				edit(["channels"], next.length > 0 ? next : ["ilink"]);
			}
		}), "启用")), react.default.createElement("div", { style: styles.desc }, meta.desc), st?.lastError ? react.default.createElement("div", { style: styles.err }, String(st.lastError)) : null, meta.creds.length > 0 ? react.default.createElement("div", { style: styles.row }, ...meta.creds.map(([field, label, isSecret]) => react.default.createElement("div", {
			key: field,
			style: styles.field
		}, react.default.createElement("label", { style: styles.label }, label), react.default.createElement("input", {
			style: styles.input,
			type: isSecret ? "password" : "text",
			placeholder: `填写 ${label}`,
			value: config?.[meta.kind]?.[field] ?? "",
			onChange: (e) => edit([meta.kind, field], e.target.value.trim())
		})))) : null, meta.kind === "ilink" && st?.state === "await_scan" && st?.qrDataUrl ? react.default.createElement("div", null, react.default.createElement("img", {
			style: styles.qr,
			src: st.qrDataUrl,
			alt: "微信扫码绑定"
		}), react.default.createElement("div", { style: styles.label }, "用微信扫码，手机上确认后机器人出现在聊天列表")) : null, meta.kind === "ilink" ? react.default.createElement("div", { style: { marginTop: 8 } }, react.default.createElement("button", {
			style: styles.btn,
			onClick: () => void rebind()
		}, "重新扫码绑定")) : null);
	}), react.default.createElement("div", { style: {
		display: "flex",
		gap: 10,
		alignItems: "center"
	} }, react.default.createElement("button", {
		style: config.__dirty ? styles.btnPrimary : styles.btn,
		onClick: () => void save()
	}, config.__dirty ? "保存（有改动）" : "保存"), react.default.createElement("span", { style: styles.hint }, "保存后 cordis 自动热重载插件；通道无反应时重启 dsh web")), toast ? react.default.createElement("div", { style: styles.toast }, toast) : null);
}
function apply(ctx) {
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "dsh-chatops",
		order: 22,
		label: () => "IM 通道"
	}, ChatopsSettings));
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
		return module.exports;
	}
});
