import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) {
		__defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	}
	if (!no_symbols) {
		__defProp(target, Symbol.toStringTag, { value: "Module" });
	}
	return target;
};

//#endregion
//#region src/host/config.ts
const Config = Schema.object({
	channel: Schema.union([
		Schema.const("ilink").description("微信官方 ClawBot/iLink 机器人（推荐，合规，扫码绑定）"),
		Schema.const("wechaty").description("wechaty 个人号协议（封号风险，仅限自用）"),
		Schema.const("feishu").description("飞书自建应用机器人（官方开放平台）"),
		Schema.const("dingtalk").description("钉钉企业内部应用机器人（官方开放平台，Stream 长连接）"),
		Schema.const("wecom").description("企业微信智能机器人（官方 aibot SDK，WS 长连接；仅企业内成员可见）")
	]).default("ilink").description("[单通道兼容项] 通道实现；channels 非空时忽略。"),
	channels: Schema.array(Schema.union([
		Schema.const("ilink"),
		Schema.const("wechaty"),
		Schema.const("feishu"),
		Schema.const("dingtalk"),
		Schema.const("wecom")
	])).default(["ilink"]).description("启用的通道列表（可多选并行，如 [ilink, feishu, dingtalk]）。"),
	dingtalk: Schema.object({
		clientId: Schema.string().default("").description("钉钉企业内部应用 Client ID（AppKey），同时作为 robotCode。"),
		clientSecret: Schema.string().default("").description("钉钉企业内部应用 Client Secret（AppSecret）。")
	}).default({
		clientId: "",
		clientSecret: ""
	}).description("[dingtalk] 企业内部应用凭据。"),
	wecom: Schema.object({
		botId: Schema.string().default("").description("企业微信智能机器人 Bot ID。"),
		secret: Schema.string().default("").description("企业微信智能机器人 Secret。")
	}).default({
		botId: "",
		secret: ""
	}).description("[wecom] 智能机器人凭据。"),
	feishu: Schema.object({
		appId: Schema.string().default("").description("飞书自建应用 App ID。"),
		appSecret: Schema.string().default("").description("飞书自建应用 App Secret。"),
		domain: Schema.union([Schema.const("feishu").description("飞书（国内）"), Schema.const("lark").description("Lark（海外）")]).default("feishu").description("开放平台域名。")
	}).default({
		appId: "",
		appSecret: "",
		domain: "feishu"
	}).description("[feishu] 自建应用凭据。"),
	puppet: Schema.string().default("wechaty-puppet-wechat4u").description("[wechaty] puppet (protocol impl): wechaty-puppet-wechat4u | wechaty-puppet-padlocal | wechaty-puppet-xp."),
	puppetToken: Schema.string().default("").description("[wechaty] Token for paid puppets (padlocal etc.); empty for wechat4u."),
	storagePath: Schema.string().default("").description("Where login state and bindings persist. Empty means $DSH_HOME/storages/dsh-chatops/."),
	security: Schema.object({
		listenFilehelper: Schema.boolean().default(true).description("Respond to messages in \"File Transfer\" (filehelper) — the safest entry point, visible only to yourself."),
		listenSelf: Schema.boolean().default(true).description("Respond to messages you send to yourself."),
		allowContacts: Schema.array(Schema.string()).default([]).description("额外信任的私聊用户 id（ilink 用户 id 或 wechaty wxid）；扫码绑定的 owner 始终被信任。"),
		allowRooms: Schema.array(Schema.string()).default([]).description("信任的群聊（wechaty 群 topic / ilink 群 id）；群内只有 @Bot 的消息才被响应。")
	}).default({
		listenFilehelper: true,
		listenSelf: true,
		allowContacts: [],
		allowRooms: []
	}),
	push: Schema.object({
		onSessionComplete: Schema.boolean().default(true).description("Push a summary to the bound chat window when a session turn completes."),
		onApproval: Schema.boolean().default(true).description("Push approval requests to the bound window; answer with /approve or /reject."),
		approvalTimeoutSec: Schema.number().default(300).description("Seconds to wait for a WeChat approval decision before falling through to other answerers (GUI)."),
		longOutputAsFile: Schema.boolean().default(true).description("Send long /log output as a .txt file instead of many messages (file-capable channels).")
	}).default({
		onSessionComplete: true,
		onApproval: true,
		approvalTimeoutSec: 300,
		longOutputAsFile: true
	}),
	reply: Schema.object({
		maxChunkBytes: Schema.number().default(6e3).description("Max bytes per outbound WeChat message; longer text is split into chunks."),
		rateLimitMs: Schema.number().default(1200).description("Minimum interval between outbound messages (plus random jitter) — anti-risk-control throttling."),
		maxFileMB: Schema.number().default(100).description("Max file size (MB) allowed for IM file delivery (platform may still reject oversized files).")
	}).default({
		maxChunkBytes: 6e3,
		rateLimitMs: 1200,
		maxFileMB: 100
	})
});

//#endregion
//#region src/host/channel.ts
/**
* WeChat channel: owns the wechaty bot lifecycle (scan → login → message →
* logout), login-state persistence, and a rate-limited outbound queue.
*
* wechaty and its puppets are OPTIONAL peer modules loaded lazily: the
* plugin must still load (and print actionable install guidance) when they
* are absent, so nothing here imports wechaty statically.
*/
var WechatChannel = class {
	config;
	events;
	logger;
	bot = null;
	outQueue = Promise.resolve();
	lastSentAt = 0;
	constructor(config, events, logger) {
		this.config = config;
		this.events = events;
		this.logger = logger;
	}
	get storageDir() {
		return this.config.storagePath || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "storages", "dsh-chatops");
	}
	get online() {
		return this.bot != null && this.bot.isLoggedIn !== false;
	}
	async start() {
		let WechatyBuilder;
		try {
			({WechatyBuilder} = await import("wechaty"));
		} catch {
			this.logger.warn("dsh-chatops: \"wechaty\" is not installed. Run inside the plugin directory:\n  pnpm add wechaty wechaty-puppet-wechat4u\n(or wechaty-puppet-padlocal for a stable paid puppet). The plugin stays loaded; WeChat features stay off.");
			return;
		}
		mkdirSync(this.storageDir, { recursive: true });
		let puppet;
		try {
			const mod = await import(this.config.puppet);
			const PuppetImpl = mod.default ?? mod;
			const options = this.config.puppetToken ? { token: this.config.puppetToken } : {};
			puppet = typeof PuppetImpl === "function" ? new PuppetImpl(options) : PuppetImpl;
		} catch {
			this.logger.warn(`dsh-chatops: puppet "${this.config.puppet}" is not installed. Run: pnpm add ${this.config.puppet}`);
			return;
		}
		this.bot = WechatyBuilder.build({
			name: join(this.storageDir, "dsh-chatops"),
			puppet
		});
		this.bot.on("scan", (qrcode, status) => {
			this.logger.info(`dsh-chatops: scan QR to log in (status ${status})`);
			this.events.onScan(qrcode);
		}).on("login", (user) => {
			this.logger.info(`dsh-chatops: logged in as ${user?.name?.() ?? "unknown"}`);
			this.events.onLogin(user?.name?.() ?? "unknown");
		}).on("logout", (user, reason) => {
			this.logger.warn(`dsh-chatops: logged out (${reason ?? "no reason"}) — scan again to relogin`);
			this.events.onLogout(reason ?? "");
		}).on("message", (msg) => {
			Promise.resolve().then(() => this.handleMessage(msg)).catch((error) => this.logger.warn(`dsh-chatops: message handling failed: ${error?.message ?? error}`));
		}).on("error", (error) => {
			this.logger.warn(`dsh-chatops: bot error: ${error?.message ?? error}`);
		});
		await this.bot.start();
		this.logger.info("dsh-chatops: bot started, waiting for scan/login");
	}
	async stop() {
		const bot = this.bot;
		this.bot = null;
		if (bot) try {
			await bot.stop();
		} catch {}
	}
	async handleMessage(msg) {
		if (msg.type?.() !== 7 && msg.text?.() === void 0) return;
		const text = (msg.text?.() ?? "").trim();
		if (!text) return;
		const talker = msg.talker?.();
		const room = msg.room?.();
		const self = talker?.self?.() === true;
		let inbound;
		if (room) {
			const topic = await room.topic?.();
			if (!await msg.mentionSelf?.()) return;
			const stripped = text.replace(/^@[^\s]+\s*/, "").trim();
			inbound = {
				windowKey: `room:${topic}`,
				kind: "room",
				talkerId: talker?.id ?? "",
				talkerName: talker?.name?.() ?? "",
				text: stripped
			};
		} else if (talker?.id === "filehelper") inbound = {
			windowKey: "filehelper",
			kind: "filehelper",
			talkerId: "filehelper",
			talkerName: "文件传输助手",
			text
		};
		else if (self) inbound = {
			windowKey: "self",
			kind: "self",
			talkerId: "self",
			talkerName: "我",
			text
		};
		else inbound = {
			windowKey: `contact:${talker?.id ?? "unknown"}`,
			kind: "contact",
			talkerId: talker?.id ?? "",
			talkerName: talker?.name?.() ?? "",
			text
		};
		this.events.onMessage(inbound);
	}
	/**
	* Send text to a conversation, chunked and throttled. Outbound messages go
	* through ONE serialized queue with a minimum interval plus jitter —
	* bursting messages is the fastest way to trip WeChat risk control.
	*/
	say(windowKey, text) {
		const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6e3);
		this.outQueue = this.outQueue.then(async () => {
			for (const chunk of chunks) {
				await this.throttle();
				try {
					await this.sayOnce(windowKey, chunk);
				} catch (error) {
					this.logger.warn(`dsh-chatops: send to ${windowKey} failed: ${error?.message ?? error}`);
				}
			}
		});
		return this.outQueue;
	}
	async sayOnce(windowKey, text) {
		const bot = this.bot;
		if (!bot) return;
		if (windowKey === "filehelper") {
			await (await bot.Contact.find({ id: "filehelper" }))?.say(text);
			return;
		}
		if (windowKey === "self") {
			await (bot.currentUser ?? bot.userSelf?.())?.say(text);
			return;
		}
		if (windowKey.startsWith("room:")) {
			await (await bot.Room.find({ topic: windowKey.slice(5) }))?.say(text);
			return;
		}
		if (windowKey.startsWith("contact:")) await (await bot.Contact.find({ id: windowKey.slice(8) }))?.say(text);
	}
	async throttle() {
		const min = this.config.reply?.rateLimitMs ?? 1200;
		const jitter = Math.floor(Math.random() * 400);
		const wait = this.lastSentAt + min + jitter - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastSentAt = Date.now();
	}
};
/** Split text into chunks of at most maxBytes (UTF-8), breaking on newlines when possible. */
function chunkText(text, maxBytes) {
	const chunks = [];
	let rest = text;
	while (Buffer.byteLength(rest, "utf8") > maxBytes) {
		let cut = Math.min(rest.length, Math.floor(maxBytes / 3));
		while (Buffer.byteLength(rest.slice(0, cut), "utf8") > maxBytes && cut > 1) cut = Math.floor(cut * .9);
		const newline = rest.lastIndexOf("\n", cut);
		if (newline > cut * .5) cut = newline + 1;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

//#endregion
//#region src/host/ilink/api.ts
/**
* Tencent iLink bot protocol client (微信 ClawBot / 官方机器人平台).
*
* Reverse-confirmed from xmanrui/dsh-im (MIT), protocol version 2.4.6.
* Pure HTTPS JSON over fetch — zero third-party dependencies.
*
* Flow: beginLogin → pollLogin(wait→scaned→confirmed) → {bot_token, baseurl}
*       → getUpdates long-poll (cursor: get_updates_buf) → sendmessage.
*/
const ILINK_QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
const ILINK_PROTOCOL_VERSION = "2.4.6";
const DEFAULT_BOT_TYPE = "3";
const ILINK_APP_ID = "bot";
const ILINK_CLIENT_VERSION = String(132102);
const LOGIN_TIMEOUT_MS = 1e4;
const SHORT_TIMEOUT_MS = 15e3;
const CDN_UPLOAD_TIMEOUT_MS = 6e4;
const CDN_UPLOAD_RETRIES = 3;
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WEIXIN_CDN_HOST = "novac2c.cdn.weixin.qq.com";
/** AES-128-ECB (PKCS7) padded size — what iLink expects as `filesize`. */
function aesEcbPaddedSize(size) {
	return Math.ceil((size + 1) / 16) * 16;
}
function trustedCdnUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.hostname !== WEIXIN_CDN_HOST) throw new ILinkError("untrusted-cdn-url", "微信返回了不受信任的 CDN 地址");
	return url.toString();
}
var ILinkError = class extends Error {
	code;
	status;
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "ILinkError";
		this.code = code;
		this.status = options.status;
	}
};
function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
function baseInfo() {
	return {
		channel_version: ILINK_PROTOCOL_VERSION,
		bot_agent: "DeepSeekHarness/dsh-chatops"
	};
}
function commonHeaders() {
	return {
		"iLink-App-Id": ILINK_APP_ID,
		"iLink-App-ClientVersion": ILINK_CLIENT_VERSION
	};
}
function authenticatedHeaders(token) {
	const headers = {
		...commonHeaders(),
		"content-type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64")
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}
async function requestJson(options) {
	const url = new URL(options.endpoint, options.baseUrl).toString();
	const timeout = AbortSignal.timeout(options.timeoutMs ?? SHORT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response;
	try {
		response = await fetch(url, {
			method: options.method,
			headers: options.authenticated === false ? commonHeaders() : authenticatedHeaders(options.token ?? null),
			body: options.body === void 0 ? void 0 : JSON.stringify(options.body),
			signal
		});
	} catch (error) {
		if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ILinkError("timeout", `iLink request timed out: ${options.endpoint}`, { cause: error });
		const cause = error?.cause;
		const detail = cause ? `${cause.code ?? ""}${cause.code ? " " : ""}${cause.message ?? cause}`.trim() : "no-cause";
		throw new ILinkError("network-error", `iLink request failed: ${error?.message ?? error} [${detail}] (${options.endpoint})`, { cause: error });
	}
	if (!response.ok) throw new ILinkError("http-error", `iLink HTTP ${response.status}: ${options.endpoint}`, { status: response.status });
	try {
		return await response.json();
	} catch (error) {
		throw new ILinkError("invalid-response", `iLink returned non-JSON: ${options.endpoint}`, { cause: error });
	}
}
/** Extract first text/voice-transcript item from an inbound message. */
function extractText(message) {
	for (const item of message?.item_list ?? []) {
		if (item?.type === 1 && typeof item.text_item?.text === "string") {
			const text = item.text_item.text.trim();
			if (text) return text;
		}
		if (item?.type === 3 && typeof item.voice_item?.text === "string") {
			const text = item.voice_item.text.trim();
			if (text) return text;
		}
	}
	return null;
}
function messageId(message) {
	if (message?.message_id !== void 0 && message?.message_id !== null) return String(message.message_id);
	return nonEmpty(message?.client_id);
}
function createILinkApi() {
	return Object.freeze({
		/** Step ①: request a binding QR. Returns the qrcode token + QR image URL. */
		async beginLogin({ localTokens = [], botType = "3", signal } = {}) {
			const response = await requestJson({
				method: "POST",
				baseUrl: ILINK_QR_BASE_URL,
				endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
				body: { local_token_list: localTokens.slice(-10) },
				timeoutMs: LOGIN_TIMEOUT_MS,
				signal
			});
			const qrcode = nonEmpty(response?.qrcode);
			if (!qrcode) throw new ILinkError("invalid-qr", "iLink 没有返回二维码令牌");
			return {
				qrcode,
				qrcodeUrl: nonEmpty(response?.qrcode_img_content)
			};
		},
		/** Step ②: long-poll the scan status (35s). */
		async pollLogin({ qrcode, baseUrl = ILINK_QR_BASE_URL, verifyCode, signal }) {
			let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
			if (nonEmpty(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
			const response = await requestJson({
				method: "GET",
				baseUrl,
				endpoint,
				timeoutMs: 4e4,
				signal,
				authenticated: false
			});
			const status = response?.status;
			const result = { status };
			if (status === "confirmed") {
				result.botToken = nonEmpty(response?.bot_token) ?? void 0;
				result.botId = nonEmpty(response?.ilink_bot_id) ?? void 0;
				result.ownerUserId = nonEmpty(response?.ilink_user_id) ?? void 0;
				result.baseUrl = nonEmpty(response?.baseurl) ?? void 0;
			}
			const redirectBase = nonEmpty(response?.baseurl);
			if (redirectBase && !result.baseUrl) result.baseUrl = redirectBase;
			return result;
		},
		/** Step ④: long-poll inbound messages. Timeout returns an empty batch. */
		async getUpdates({ baseUrl, token, getUpdatesBuf = "", signal }) {
			try {
				return await requestJson({
					method: "POST",
					baseUrl,
					endpoint: "ilink/bot/getupdates",
					body: {
						get_updates_buf: getUpdatesBuf,
						base_info: baseInfo()
					},
					token,
					timeoutMs: 4e4,
					signal
				});
			} catch (error) {
				if (error instanceof ILinkError && error.code === "timeout") return {
					ret: 0,
					msgs: [],
					get_updates_buf: getUpdatesBuf
				};
				throw error;
			}
		},
		/** Step ⑤: send a text message. contextToken keeps the conversation context. */
		async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }) {
			const response = await requestJson({
				method: "POST",
				baseUrl,
				endpoint: "ilink/bot/sendmessage",
				token,
				signal,
				body: {
					msg: {
						from_user_id: "",
						to_user_id: toUserId,
						client_id: `dsh-chatops-${randomUUID()}`,
						message_type: 2,
						message_state: 2,
						item_list: [{
							type: 1,
							text_item: { text }
						}],
						...nonEmpty(contextToken) ? { context_token: contextToken.trim() } : {},
						...nonEmpty(runId) ? { run_id: runId.trim() } : {}
					},
					base_info: baseInfo()
				}
			});
			if (response?.ret !== void 0 && response.ret !== 0) throw new ILinkError("send-rejected", "iLink 拒绝了回复消息");
			return true;
		},
		/** File/image step ①: request a CDN upload slot. */
		async getUploadUrl({ baseUrl, token, toUserId, file, mediaType, aesKey, fileKey, signal }) {
			const response = await requestJson({
				method: "POST",
				baseUrl,
				endpoint: "ilink/bot/getuploadurl",
				token,
				signal,
				body: {
					filekey: fileKey,
					media_type: mediaType,
					to_user_id: toUserId,
					rawsize: file.bytes.byteLength,
					rawfilemd5: createHash("md5").update(file.bytes).digest("hex"),
					filesize: aesEcbPaddedSize(file.bytes.byteLength),
					no_need_thumb: true,
					aeskey: aesKey.toString("hex"),
					base_info: baseInfo()
				}
			});
			if (response?.ret !== void 0 && response.ret !== 0) throw new ILinkError("upload-url-rejected", `微信拒绝了文件上传请求 (ret=${response.ret})`);
			return response;
		},
		/** Step ②+③: AES-128-ECB encrypt and upload to the WeChat CDN. */
		async uploadCdn({ upload, fileKey, bytes, aesKey, signal }) {
			let url;
			const full = nonEmpty(upload?.upload_full_url);
			if (full) url = trustedCdnUrl(full);
			else {
				const param = nonEmpty(upload?.upload_param);
				if (!param) throw new ILinkError("missing-upload-url", "微信没有返回文件上传地址");
				const u = new URL(`${WEIXIN_CDN_BASE_URL}/upload`);
				u.searchParams.set("encrypted_query_param", param);
				u.searchParams.set("filekey", fileKey);
				url = trustedCdnUrl(u.toString());
			}
			const cipher = createCipheriv("aes-128-ecb", aesKey, null);
			const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
			let lastError;
			for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt++) try {
				const response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: new Uint8Array(ciphertext),
					signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS),
					redirect: "error"
				});
				if (response.status !== 200) throw new ILinkError("upload-failed", `微信 CDN 上传失败（HTTP ${response.status}）`, { status: response.status });
				const downloadParam = response.headers.get("x-encrypted-param");
				await response.body?.cancel?.().catch(() => void 0);
				if (!downloadParam) throw new ILinkError("missing-download-param", "CDN 未返回下载凭证");
				return downloadParam;
			} catch (error) {
				lastError = error;
			}
			throw lastError instanceof Error ? lastError : new ILinkError("upload-failed", String(lastError));
		},
		/** Step ④: send the uploaded artifact as a file/image message. */
		async sendArtifact({ baseUrl, token, toUserId, file, mediaType, downloadParam, aesKey, ciphertextSize, contextToken, signal }) {
			const media = {
				encrypt_query_param: downloadParam,
				aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
				encrypt_type: 1
			};
			const item = mediaType === 1 ? {
				type: 2,
				image_item: {
					media,
					mid_size: ciphertextSize
				}
			} : {
				type: 4,
				file_item: {
					media,
					file_name: file.fileName,
					len: String(file.bytes.byteLength)
				}
			};
			const response = await requestJson({
				method: "POST",
				baseUrl,
				endpoint: "ilink/bot/sendmessage",
				token,
				signal,
				body: {
					msg: {
						from_user_id: "",
						to_user_id: toUserId,
						client_id: `dsh-chatops-${randomUUID()}`,
						message_type: 2,
						message_state: 2,
						item_list: [item],
						...nonEmpty(contextToken) ? { context_token: contextToken.trim() } : {}
					},
					base_info: baseInfo()
				}
			});
			if (response?.ret !== void 0 && response.ret !== 0) throw new ILinkError("send-rejected", `微信拒绝了文件消息 (ret=${response.ret})`);
			return true;
		},
		/** Bot-online notification, called once when the poll loop starts. */
		async notifyStart({ baseUrl, token, signal }) {
			return requestJson({
				method: "POST",
				baseUrl,
				endpoint: "ilink/bot/msg/notifystart",
				token,
				signal,
				timeoutMs: LOGIN_TIMEOUT_MS,
				body: { base_info: baseInfo() }
			});
		},
		/** Bot-offline notification, best-effort on shutdown. */
		async notifyStop({ baseUrl, token, signal }) {
			return requestJson({
				method: "POST",
				baseUrl,
				endpoint: "ilink/bot/msg/notifystop",
				token,
				signal,
				timeoutMs: LOGIN_TIMEOUT_MS,
				body: { base_info: baseInfo() }
			});
		}
	});
}

//#endregion
//#region src/host/ilink/store.ts
/**
* iLink account state: bot token (via DSH credential store when available,
* file fallback), connection metadata, long-poll cursor, and a dedup ring
* of recently seen message ids. One JSON file + one credential ref.
*/
const CREDENTIAL_REF = "DSH_CHATOPS_ILINK_BOT_TOKEN";
/** Pre-rename credential ref; checked as a fallback so old logins survive. */
const LEGACY_CREDENTIAL_REF = "DSH_WECHAT_ILINK_BOT_TOKEN";
const STATE_VERSION = 1;
const SEEN_RING_SIZE = 200;
var ILinkStore = class {
	credentials;
	logger;
	state = {
		botId: null,
		ownerUserId: null,
		baseUrl: null,
		getUpdatesBuf: "",
		seenMessageIds: []
	};
	tokenCache = null;
	stateFile;
	constructor(storageDir, credentials, logger) {
		this.credentials = credentials;
		this.logger = logger;
		mkdirSync(storageDir, { recursive: true });
		this.stateFile = join(storageDir, "ilink-state.json");
		this.load();
		this.tokenCache = this.readFileToken();
	}
	get data() {
		return this.state;
	}
	async getToken() {
		if (this.tokenCache) return this.tokenCache;
		if (this.credentials) for (const ref of [CREDENTIAL_REF, LEGACY_CREDENTIAL_REF]) try {
			const resolved = await this.credentials.resolve(ref);
			const value = typeof resolved === "string" ? resolved : resolved?.value;
			if (typeof value === "string" && value.trim()) {
				this.tokenCache = value.trim();
				return this.tokenCache;
			}
		} catch (error) {
			this.logger.warn(`dsh-chatops: credential resolve failed: ${error?.message ?? error}`);
		}
		this.tokenCache = this.readFileToken();
		return this.tokenCache;
	}
	async setToken(token) {
		this.tokenCache = token;
		if (this.credentials) try {
			await this.credentials.set(CREDENTIAL_REF, token);
		} catch (error) {
			this.logger.warn(`dsh-chatops: credential set failed, using file fallback: ${error?.message ?? error}`);
			this.writeFileToken(token);
		}
		else this.writeFileToken(token);
	}
	async clearToken() {
		this.tokenCache = null;
		if (this.credentials) try {
			await this.credentials.unset(CREDENTIAL_REF);
		} catch {}
		this.writeFileToken(null);
	}
	async bindAccount(info) {
		this.state.botId = info.botId;
		this.state.ownerUserId = info.ownerUserId;
		this.state.baseUrl = info.baseUrl;
		this.state.getUpdatesBuf = "";
		this.state.seenMessageIds = [];
		this.save();
	}
	async unbind() {
		await this.clearToken();
		this.state = {
			botId: null,
			ownerUserId: null,
			baseUrl: null,
			getUpdatesBuf: "",
			seenMessageIds: []
		};
		this.save();
	}
	setCursor(buf) {
		if (buf && buf !== this.state.getUpdatesBuf) {
			this.state.getUpdatesBuf = buf;
			this.save();
		}
	}
	hasSeen(messageId) {
		return this.state.seenMessageIds.includes(messageId);
	}
	markSeen(messageId) {
		this.state.seenMessageIds.push(messageId);
		if (this.state.seenMessageIds.length > SEEN_RING_SIZE) this.state.seenMessageIds = this.state.seenMessageIds.slice(-200);
		this.save();
	}
	load() {
		if (!existsSync(this.stateFile)) return;
		try {
			const raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
			if (raw?.version === STATE_VERSION && raw.state) this.state = {
				...this.state,
				...raw.state
			};
		} catch (error) {
			this.logger.warn(`dsh-chatops: ilink state load failed: ${error?.message ?? error}`);
		}
	}
	save() {
		let raw = {};
		try {
			if (existsSync(this.stateFile)) raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
		} catch {}
		raw.version = STATE_VERSION;
		raw.state = this.state;
		try {
			writeFileSync(this.stateFile, JSON.stringify(raw, null, 2), { mode: 384 });
		} catch (error) {
			this.logger.warn(`dsh-chatops: ilink state save failed: ${error?.message ?? error}`);
		}
	}
	readFileToken() {
		try {
			const raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
			return typeof raw?.fileToken === "string" && raw.fileToken ? raw.fileToken : null;
		} catch {
			return null;
		}
	}
	writeFileToken(token) {
		let raw = {};
		try {
			if (existsSync(this.stateFile)) raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
		} catch {}
		if (token) raw.fileToken = token;
		else delete raw.fileToken;
		raw.version = STATE_VERSION;
		raw.state = this.state;
		try {
			writeFileSync(this.stateFile, JSON.stringify(raw, null, 2), { mode: 384 });
		} catch (error) {
			this.logger.warn(`dsh-chatops: token file save failed: ${error?.message ?? error}`);
		}
	}
};

//#endregion
//#region src/host/ilink/channel.ts
/**
* ILinkChannel: drives the WeChat ClawBot (腾讯 iLink 官方机器人) connection.
*
* Same structural contract as the wechaty WechatChannel — storageDir,
* online, start(), stop(), say(windowKey, text) — so SessionBridge/index.ts
* work unchanged. windowKey is `user:{ilink_user_id}` (private chats; group
* support is a phase-2 TODO).
*
* Lifecycle: restore token → connect; or loginFlow (QR scan state machine)
* → confirmed → connect. Stale token (-14) drops back to loginFlow.
*/
/** Min interval for interactive messages — fast enough to feel instant. */
const INTERACTIVE_MIN_MS = 350;
var ILinkChannel = class {
	config;
	events;
	logger;
	api = createILinkApi();
	store;
	abort = null;
	state = "idle";
	lastError = null;
	qrUrl = null;
	pendingVerifyCode = null;
	interactiveQueue = Promise.resolve();
	bulkQueue = Promise.resolve();
	pendingInteractive = 0;
	lastSentAt = 0;
	/** context_token per windowKey, from the latest inbound message. */
	contextTokens = /* @__PURE__ */ new Map();
	constructor(config, events, logger, credentials = null) {
		this.config = config;
		this.events = events;
		this.logger = logger;
		this.store = new ILinkStore(this.storageDir, credentials, logger);
	}
	get storageDir() {
		return this.config.storagePath || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "storages", "dsh-chatops");
	}
	/** Lifecycle debug log — the DSH host log is hard to reach; this file is not. */
	dbg(message) {
		this.logger.info(`dsh-chatops: ${message}`);
		try {
			appendFileSync(join(this.storageDir, "ilink-debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`);
		} catch {}
	}
	get online() {
		return this.state === "connected";
	}
	statusSnapshot() {
		return {
			state: this.state,
			online: this.online,
			qrUrl: this.qrUrl,
			botId: this.store.data.botId,
			ownerUserId: this.store.data.ownerUserId,
			lastError: this.lastError
		};
	}
	/** GUI supplies the SMS code when the phone asks for it. */
	submitVerifyCode(code) {
		this.pendingVerifyCode = code.trim();
		this.logger.info("dsh-chatops: verify code received, continuing login poll");
	}
	async unbind() {
		await this.stop();
		await this.store.unbind();
		this.state = "idle";
	}
	async start() {
		if (this.abort) return;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		this.run(signal).catch((error) => {
			this.lastError = error?.message ?? String(error);
			this.state = "error";
			this.dbg(`lifecycle crashed fatally: ${this.lastError}`);
		});
	}
	async stop() {
		const abort = this.abort;
		this.abort = null;
		if (!abort) return;
		abort.abort();
		const { baseUrl } = this.store.data;
		const token = await this.store.getToken();
		if (baseUrl && token) try {
			await this.api.notifyStop({
				baseUrl,
				token,
				signal: AbortSignal.timeout(5e3)
			});
		} catch {}
		this.state = "idle";
	}
	async run(signal) {
		let crashes = 0;
		while (!signal.aborted) {
			const token = await this.store.getToken();
			const { baseUrl } = this.store.data;
			this.dbg(`lifecycle beat: token=${token ? "present" : "missing"} baseUrl=${baseUrl ?? "missing"}`);
			try {
				if (token && baseUrl) await this.connect(token, baseUrl, signal);
				else await this.loginFlow(signal);
				crashes = 0;
			} catch (error) {
				if (signal.aborted) return;
				crashes += 1;
				this.lastError = error?.message ?? String(error);
				this.dbg(`lifecycle crash (${crashes}): ${this.lastError}`);
				await sleep(Math.min(2e3 * 2 ** (crashes - 1), 3e4), signal);
			}
		}
	}
	/** QR scan state machine: QR → wait → scaned → (verifycode?) → confirmed. */
	async loginFlow(signal) {
		let baseUrl;
		while (!signal.aborted) {
			const { qrcode, qrcodeUrl } = await this.api.beginLogin({ signal });
			this.qrUrl = qrcodeUrl;
			this.state = "await_scan";
			this.lastError = null;
			this.events.onScan(qrcodeUrl ?? qrcode);
			this.logger.info("dsh-chatops: iLink QR ready — 打开 /wechat/qr 或设置页扫码绑定");
			let verifyCode;
			while (!signal.aborted) {
				if (this.pendingVerifyCode) {
					verifyCode = this.pendingVerifyCode;
					this.pendingVerifyCode = null;
				}
				let result;
				try {
					result = await this.api.pollLogin({
						qrcode,
						baseUrl,
						verifyCode,
						signal
					});
				} catch (error) {
					if (error instanceof ILinkError && error.code === "timeout") continue;
					throw error;
				}
				verifyCode = void 0;
				switch (result.status) {
					case "wait": break;
					case "scaned":
						this.state = "scanned";
						break;
					case "scaned_but_redirect":
					case "binded_redirect":
						if (result.baseUrl) baseUrl = result.baseUrl;
						break;
					case "need_verifycode":
						this.state = "need_verifycode";
						this.logger.info("dsh-chatops: 微信要求短信验证码，请在 /wechat/qr 页面输入");
						break;
					case "verify_code_blocked": throw new ILinkError("verify-blocked", "短信验证码被限制，请稍后再试");
					case "expired":
						this.logger.info("dsh-chatops: 二维码已过期，重新获取");
						break;
					case "confirmed":
						if (!result.botToken) throw new ILinkError("invalid-confirm", "confirmed 缺少 bot_token");
						await this.store.setToken(result.botToken);
						await this.store.bindAccount({
							botId: result.botId ?? null,
							ownerUserId: result.ownerUserId ?? null,
							baseUrl: result.baseUrl ?? baseUrl ?? null
						});
						this.qrUrl = null;
						this.dbg(`login confirmed: bot=${result.botId} owner=${result.ownerUserId} base=${result.baseUrl ?? baseUrl} tokenLen=${result.botToken.length}`);
						this.events.onLogin(result.botId ?? "ilink-bot");
						return;
				}
				if (result.status === "expired") break;
			}
		}
	}
	/** Connected phase: notifyStart + getUpdates long-poll with cursor. */
	async connect(token, baseUrl, signal) {
		this.state = "connecting";
		try {
			await this.api.notifyStart({
				baseUrl,
				token,
				signal
			});
		} catch (error) {
			this.logger.warn(`dsh-chatops: notifystart failed (continuing): ${error?.message ?? error}`);
		}
		this.state = "connected";
		this.lastError = null;
		this.dbg(`iLink connected (bot=${this.store.data.botId ?? "unknown"}, base=${baseUrl})`);
		let failures = 0;
		while (!signal.aborted) {
			let response;
			try {
				response = await this.api.getUpdates({
					baseUrl,
					token,
					getUpdatesBuf: this.store.data.getUpdatesBuf,
					signal
				});
			} catch (error) {
				if (signal.aborted) return;
				failures += 1;
				this.lastError = error?.message ?? String(error);
				this.logger.warn(`dsh-chatops: getupdates failed (${failures}): ${this.lastError}`);
				await sleep(Math.min(2e3 * 2 ** (failures - 1), 3e4), signal);
				continue;
			}
			if (response?.ret !== void 0 && response.ret !== 0 || response?.errcode !== void 0 && response.errcode !== 0) {
				const code = response.errcode ?? response.ret;
				this.dbg(`getupdates rejected: code=${code} raw=${JSON.stringify(response).slice(0, 300)}`);
				if (code === -14) {
					this.logger.warn("dsh-chatops: bot_token 已失效（-14），需要重新扫码绑定");
					await this.store.clearToken();
					this.events.onLogout("stale-token");
					this.state = "idle";
					return;
				}
				failures += 1;
				this.lastError = `getupdates rejected (ret=${code})`;
				await sleep(Math.min(2e3 * 2 ** (failures - 1), 3e4), signal);
				continue;
			}
			failures = 0;
			this.lastError = null;
			for (const raw of response?.msgs ?? []) this.dispatchInbound(raw);
			if (typeof response?.get_updates_buf === "string" && response.get_updates_buf) this.store.setCursor(response.get_updates_buf);
		}
	}
	dispatchInbound(raw) {
		try {
			if (raw?.message_type === 2) return;
			const id = messageId(raw);
			const fromUserId = typeof raw?.from_user_id === "string" ? raw.from_user_id.trim() : "";
			if (!id || !fromUserId) return;
			if (this.store.hasSeen(id)) return;
			this.store.markSeen(id);
			const text = extractText(raw);
			if (!text) {
				this.dbg(`inbound non-text message from ${fromUserId} (skipped, types=${(raw?.item_list ?? []).map((i) => i?.type).join(",")})`);
				return;
			}
			this.dbg(`inbound text from ${fromUserId}: ${text.slice(0, 80)}`);
			const windowKey = `user:${fromUserId}`;
			const contextToken = typeof raw?.context_token === "string" ? raw.context_token.trim() : "";
			if (contextToken) this.contextTokens.set(windowKey, contextToken);
			const msg = {
				windowKey,
				kind: "contact",
				talkerId: fromUserId,
				talkerName: fromUserId,
				text
			};
			this.events.onMessage(msg);
		} catch (error) {
			this.logger.warn(`dsh-chatops: inbound dispatch failed: ${error?.message ?? error}`);
		}
	}
	/**
	* Two-lane outbound: interactive messages (command replies, acks,
	* approvals) must NEVER queue behind a draining bulk output (/log's dozen
	* chunks at anti-flood throttle). Bulk chunks yield whenever interactive
	* traffic is pending, so a long dump no longer stalls the conversation.
	*/
	say(windowKey, text, opts) {
		const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6e3);
		if (!opts?.bulk) {
			this.pendingInteractive++;
			this.interactiveQueue = this.interactiveQueue.then(async () => {
				try {
					for (const chunk of chunks) {
						await this.throttle(INTERACTIVE_MIN_MS, 100);
						await this.sendChunk(windowKey, chunk);
					}
				} finally {
					this.pendingInteractive--;
				}
			});
			return this.interactiveQueue;
		}
		this.bulkQueue = this.bulkQueue.then(async () => {
			for (const chunk of chunks) {
				while (this.pendingInteractive > 0) await new Promise((r) => setTimeout(r, 300));
				await this.throttle(this.config.reply?.rateLimitMs ?? 1200, 400);
				await this.sendChunk(windowKey, chunk);
			}
		});
		return this.bulkQueue;
	}
	async sendChunk(windowKey, chunk) {
		const { baseUrl } = this.store.data;
		const token = await this.store.getToken();
		if (!baseUrl || !token || !windowKey.startsWith("user:")) return;
		try {
			await this.api.sendText({
				baseUrl,
				token,
				toUserId: windowKey.slice(5),
				text: chunk,
				contextToken: this.contextTokens.get(windowKey)
			});
		} catch (error) {
			this.logger.warn(`dsh-chatops: send to ${windowKey} failed: ${error?.message ?? error}`);
		}
	}
	/**
	* Send a file/image as a native WeChat message (CDN upload + AES).
	* Images (jpg/png/webp/gif) render inline; everything else arrives as a
	* file card. Size is fenced by reply.maxFileMB before reading the file.
	*/
	async sendFile(windowKey, filePath, caption) {
		if (!windowKey.startsWith("user:")) throw new Error("file send requires a private-chat window");
		const toUserId = windowKey.slice(5);
		const { baseUrl } = this.store.data;
		const token = await this.store.getToken();
		if (!baseUrl || !token) throw new Error("iLink 通道未连接");
		const maxMB = this.config.reply?.maxFileMB ?? 20;
		const bytes = await readFile(filePath);
		if (bytes.byteLength > maxMB * 1024 * 1024) throw new Error(`文件超过 ${maxMB}MB 上限（${(bytes.byteLength / 1048576).toFixed(1)}MB）`);
		const fileName = basename(filePath);
		const isImage = [
			".jpg",
			".jpeg",
			".png",
			".webp",
			".gif"
		].includes(extname(fileName).toLowerCase());
		this.bulkQueue = this.bulkQueue.then(async () => {
			try {
				const aesKey = randomBytes(16);
				const fileKey = randomBytes(16).toString("hex");
				const file = {
					fileName,
					bytes
				};
				const upload = await this.api.getUploadUrl({
					baseUrl,
					token,
					toUserId,
					file,
					mediaType: isImage ? 1 : 3,
					aesKey,
					fileKey
				});
				const downloadParam = await this.api.uploadCdn({
					upload,
					fileKey,
					bytes,
					aesKey
				});
				const ciphertextSize = Math.ceil((bytes.byteLength + 1) / 16) * 16;
				await this.api.sendArtifact({
					baseUrl,
					token,
					toUserId,
					file,
					mediaType: isImage ? 1 : 3,
					downloadParam,
					aesKey,
					ciphertextSize,
					contextToken: this.contextTokens.get(windowKey)
				});
				if (caption) await this.say(windowKey, caption);
				this.dbg(`file sent to ${toUserId}: ${fileName} (${bytes.byteLength}B, ${isImage ? "image" : "file"})`);
			} catch (error) {
				this.logger.warn(`dsh-chatops: 文件发送失败 ${fileName}: ${error?.message ?? error}`);
				await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`);
				throw error;
			}
		});
		return this.bulkQueue;
	}
	async throttle(min, jitter) {
		const wait = this.lastSentAt + min + Math.floor(Math.random() * jitter) - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastSentAt = Date.now();
	}
};
function sleep(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

//#endregion
//#region src/host/ilink/qrimg.ts
/**
* Server-side QR image generation for the binding page.
*
* The iLink `qrcode_img_content` is NOT an image: it is a WeChat verification
* WEBPAGE URL (opening it in a browser shows a QR; putting it in <img src>
* yields a broken image / cross-origin refusal). The correct display is a QR
* code ENCODING that URL — WeChat scans it and opens the binding flow. We
* generate the data-URL locally with the `qrcode` package (no third-party
* roundtrip, works offline). Cached per URL: the page polls every 2s.
*/
let cache = null;
async function qrDataUrl(url) {
	if (cache?.url === url) return cache.dataUrl;
	try {
		const mod = await import("qrcode");
		const dataUrl = await (mod.default ?? mod).toDataURL(url, {
			margin: 1,
			width: 320
		});
		cache = {
			url,
			dataUrl
		};
		return dataUrl;
	} catch {
		return null;
	}
}

//#endregion
//#region src/host/feishu/cards.ts
var cards_exports = /* @__PURE__ */ __exportAll({
	approvalCard: () => approvalCard,
	approvalResultCard: () => approvalResultCard,
	progressCard: () => progressCard,
	progressResultCard: () => progressResultCard
});
function approvalCard(d) {
	return {
		config: { wide_screen_mode: true },
		header: {
			title: {
				tag: "plain_text",
				content: "⚠️ DSH 审批请求"
			},
			template: "orange"
		},
		elements: [
			{
				tag: "div",
				text: {
					tag: "lark_md",
					content: `**会话**：${escapeMd(d.sessionTitle)}\n**工具**：\`${d.toolName}\`\n**原因**：${escapeMd(d.reason)}`
				}
			},
			{ tag: "hr" },
			{
				tag: "action",
				actions: [{
					tag: "button",
					text: {
						tag: "plain_text",
						content: "✅ 批准"
					},
					type: "primary",
					value: {
						dshApproval: d.approvalId,
						outcome: "allowed-once"
					}
				}, {
					tag: "button",
					text: {
						tag: "plain_text",
						content: "❌ 拒绝"
					},
					type: "danger",
					value: {
						dshApproval: d.approvalId,
						outcome: "rejected"
					}
				}]
			},
			{
				tag: "note",
				elements: [{
					tag: "plain_text",
					content: `${d.timeoutMin} 分钟内有效，超时转 GUI 处理；也可回复 /approve 或 /reject`
				}]
			}
		]
	};
}
function approvalResultCard(d, outcome, operator) {
	const approved = outcome === "allowed-once";
	return {
		config: { wide_screen_mode: true },
		header: {
			title: {
				tag: "plain_text",
				content: approved ? "✅ 已批准" : "❌ 已拒绝"
			},
			template: approved ? "green" : "red"
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: `**会话**：${escapeMd(d.sessionTitle)}\n**工具**：\`${d.toolName}\`\n**原因**：${escapeMd(d.reason)}`
			}
		}, {
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: `由 ${operator} 操作`
			}]
		}]
	};
}
function progressCard(sessionTitle, prompt) {
	return {
		config: { wide_screen_mode: true },
		header: {
			title: {
				tag: "plain_text",
				content: "🔄 DSH 任务执行中"
			},
			template: "blue"
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: `**会话**：${escapeMd(sessionTitle)}\n**指令**：${escapeMd(prompt.slice(0, 200))}`
			}
		}, {
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "执行中，完成后此卡片自动更新…"
			}]
		}]
	};
}
function progressResultCard(sessionTitle, prompt, kind, excerpt) {
	const ok = kind === "completed";
	return {
		config: { wide_screen_mode: true },
		header: {
			title: {
				tag: "plain_text",
				content: ok ? "✅ DSH 任务完成" : `⚠️ 任务结束（${kind}）`
			},
			template: ok ? "green" : "red"
		},
		elements: [
			{
				tag: "div",
				text: {
					tag: "lark_md",
					content: `**会话**：${escapeMd(sessionTitle)}\n**指令**：${escapeMd(prompt.slice(0, 200))}`
				}
			},
			{ tag: "hr" },
			{
				tag: "div",
				text: {
					tag: "lark_md",
					content: escapeMd(excerpt.slice(0, 1500))
				}
			},
			{
				tag: "note",
				elements: [{
					tag: "plain_text",
					content: "回复 /log 1 查看完整输出"
				}]
			}
		]
	};
}
/** lark_md treats some chars specially; keep it minimal. */
function escapeMd(text) {
	return String(text ?? "");
}

//#endregion
//#region src/host/feishu/channel.ts
/**
* FeishuChannel: 飞书自建应用机器人通道（官方开放平台，lark-oapi SDK）。
*
* - 收消息：WSClient WebSocket 长连接 + EventDispatcher（无需公网回调）；
*   事件 im.message.receive_v1（私聊直接响应 / 群聊需 @机器人）。
* - 发消息：im.message.create REST；单队列轻节流（300ms，API 配额宽裕）。
* - 审批：交互卡片 + card.action.trigger 按钮回调（decision 路由到 bridge）。
* - 进度：任务状态卡原地更新（create → patch）。
*
* windowKey 命名：`fsu:{open_id}` 私聊，`fsc:{chat_id}` 群聊。
* SDK 是可选依赖：未安装时插件照常加载并给出安装指引。
*/
const SEND_INTERVAL_MS$2 = 300;
var FeishuChannel = class {
	config;
	events;
	logger;
	client = null;
	wsClient = null;
	state = "idle";
	lastError = null;
	botOpenId = null;
	botName = null;
	outQueue = Promise.resolve();
	lastSentAt = 0;
	constructor(config, events, logger) {
		this.config = config;
		this.events = events;
		this.logger = logger;
	}
	get online() {
		return this.state === "connected";
	}
	statusSnapshot() {
		return {
			state: this.state,
			online: this.online,
			botName: this.botName,
			botOpenId: this.botOpenId,
			lastError: this.lastError
		};
	}
	async start() {
		const appId = this.config.feishu?.appId;
		const appSecret = this.config.feishu?.appSecret;
		if (!appId || !appSecret) {
			this.logger.warn("dsh-chatops: feishu.appId / feishu.appSecret 未配置，飞书通道未启动（在插件设置中填写自建应用凭据）");
			this.state = "idle";
			this.lastError = "missing appId/appSecret";
			return;
		}
		let lark;
		try {
			lark = await import("@larksuiteoapi/node-sdk");
		} catch {
			this.logger.warn("dsh-chatops: 未安装 @larksuiteoapi/node-sdk。在插件目录执行：\n  pnpm add @larksuiteoapi/node-sdk");
			this.state = "error";
			this.lastError = "lark sdk not installed";
			return;
		}
		const domain = this.config.feishu?.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
		this.client = new lark.Client({
			appId,
			appSecret,
			domain,
			loggerLevel: lark.LoggerLevel.warn
		});
		try {
			const info = await this.client.request({
				method: "GET",
				url: "/open-apis/bot/v3/info"
			});
			this.botOpenId = info?.data?.bot?.open_id ?? info?.bot?.open_id ?? null;
			this.botName = info?.data?.bot?.app_name ?? info?.bot?.app_name ?? null;
			this.logger.info(`dsh-chatops: feishu bot = ${this.botName} (${this.botOpenId})`);
		} catch (error) {
			this.logger.warn(`dsh-chatops: 获取飞书机器人信息失败（群@检测可能失效）: ${error?.message ?? error}`);
		}
		const dispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": (event) => {
				Promise.resolve().then(() => this.handleMessage(event)).catch((error) => this.logger.warn(`dsh-chatops: feishu message handling failed: ${error?.message ?? error}`));
			},
			"card.action.trigger": async (event) => {
				try {
					await this.handleCardAction(event);
				} catch (error) {
					this.logger.warn(`dsh-chatops: feishu card action failed: ${error?.message ?? error}`);
				}
			}
		});
		this.state = "connecting";
		this.wsClient = new lark.WSClient({
			appId,
			appSecret,
			domain,
			loggerLevel: lark.LoggerLevel.warn,
			onReady: () => {
				this.state = "connected";
				this.lastError = null;
				this.logger.info("dsh-chatops: 飞书长连接已建立");
			},
			onError: (error) => {
				this.lastError = error?.message ?? String(error);
				this.logger.warn(`dsh-chatops: 飞书长连接错误: ${this.lastError}`);
			},
			onReconnecting: () => {
				this.state = "reconnecting";
			},
			onReconnected: () => {
				this.state = "connected";
				this.lastError = null;
			}
		});
		this.wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
			this.state = "error";
			this.lastError = error?.message ?? String(error);
			this.logger.warn(`dsh-chatops: 飞书 WSClient 启动失败: ${this.lastError}`);
		});
	}
	async stop() {
		this.state = "idle";
		try {
			this.wsClient?.close?.();
		} catch {}
		this.wsClient = null;
		this.client = null;
	}
	async handleMessage(event) {
		const sender = event?.sender;
		const message = event?.message;
		if (!message || sender?.sender_type !== "user") return;
		if (message.message_type !== "text") return;
		let text;
		try {
			text = String(JSON.parse(message.content)?.text ?? "").trim();
		} catch {
			return;
		}
		if (!text) return;
		const openId = sender?.sender_id?.open_id ?? "";
		if (!openId) return;
		if (message.chat_type === "p2p") {
			this.events.onMessage({
				windowKey: `fsu:${openId}`,
				kind: "contact",
				talkerId: openId,
				talkerName: openId,
				text
			});
			return;
		}
		const mentions = message.mentions ?? [];
		if (!(mentions.some((m) => m?.id?.open_id && m.id.open_id === this.botOpenId) || this.botOpenId == null && mentions.length > 0)) return;
		const stripped = text.replace(/@_user_\d+/g, "").trim();
		if (!stripped) return;
		this.events.onMessage({
			windowKey: `fsc:${message.chat_id}`,
			kind: "room",
			talkerId: openId,
			talkerName: openId,
			text: stripped
		});
	}
	async handleCardAction(event) {
		const value = event?.action?.value;
		const approvalId = typeof value?.dshApproval === "string" ? value.dshApproval : null;
		const outcome = value?.outcome;
		if (!approvalId || outcome !== "allowed-once" && outcome !== "rejected") return;
		const operatorOpenId = event?.operator?.open_id ?? "unknown";
		const messageId = event?.context?.open_message_id ?? null;
		const resultCard = await this.events.onCardAction({
			approvalId,
			outcome,
			operatorOpenId,
			messageId
		});
		if (resultCard && messageId && this.client) try {
			await this.client.im.message.patch({
				path: { message_id: messageId },
				data: { content: JSON.stringify(resultCard) }
			});
		} catch (error) {
			this.logger.warn(`dsh-chatops: 审批卡更新失败: ${error?.message ?? error}`);
		}
	}
	say(windowKey, text, _opts) {
		const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6e3);
		this.outQueue = this.outQueue.then(async () => {
			for (const chunk of chunks) {
				await this.throttle();
				await this.sendMessage(windowKey, "text", JSON.stringify({ text: chunk }));
			}
		});
		return this.outQueue;
	}
	/** Approval card; part of the channel card capability probed by the bridge. */
	async sendApprovalCard(windowKey, data) {
		await this.sendMessage(windowKey, "interactive", JSON.stringify(approvalCard(data)));
	}
	/** Streaming task card: create now, patch on completion. */
	async sendProgressCard(windowKey, sessionTitle, prompt) {
		return await this.sendMessage(windowKey, "interactive", JSON.stringify(progressCard(sessionTitle, prompt)));
	}
	async completeProgressCard(messageId, sessionTitle, prompt, kind, excerpt) {
		if (!this.client) return;
		try {
			await this.client.im.message.patch({
				path: { message_id: messageId },
				data: { content: JSON.stringify(progressResultCard(sessionTitle, prompt, kind, excerpt)) }
			});
		} catch (error) {
			this.logger.warn(`dsh-chatops: 进度卡更新失败: ${error?.message ?? error}`);
		}
	}
	/**
	* Send a workspace file/image as a native Feishu message.
	* Images (jpg/png/webp/gif) upload via im.image.create and render inline;
	* everything else uploads via im.file.create and arrives as a file card.
	* Requires the app scope `im:resource` (读取与上传图片或文件资源).
	*/
	async sendFile(windowKey, filePath, caption) {
		if (!this.client) throw new Error("飞书通道未连接");
		const maxMB = this.config.reply?.maxFileMB ?? 100;
		const info = await stat(filePath);
		if (info.size > maxMB * 1024 * 1024) throw new Error(`文件超过 ${maxMB}MB 上限（${(info.size / 1048576).toFixed(1)}MB）`);
		const fileName = basename(filePath);
		const isImage = [
			".jpg",
			".jpeg",
			".png",
			".webp",
			".gif"
		].includes(extname(fileName).toLowerCase());
		this.outQueue = this.outQueue.then(async () => {
			try {
				if (isImage) {
					const up = await this.client.im.image.create({ data: {
						image_type: "message",
						image: createReadStream(filePath)
					} });
					const imageKey = up?.data?.image_key ?? up?.image_key;
					if (!imageKey) throw new Error(`图片上传被拒: ${up?.msg ?? "no image_key"}`);
					await this.sendMessage(windowKey, "image", JSON.stringify({ image_key: imageKey }));
				} else {
					const up = await this.client.im.file.create({ data: {
						file_type: "stream",
						file_name: fileName,
						file: createReadStream(filePath)
					} });
					const fileKey = up?.data?.file_key ?? up?.file_key;
					if (!fileKey) throw new Error(`文件上传被拒: ${up?.msg ?? "no file_key"}`);
					await this.sendMessage(windowKey, "file", JSON.stringify({ file_key: fileKey }));
				}
				if (caption) await this.say(windowKey, caption);
			} catch (error) {
				this.logger.warn(`dsh-chatops: 飞书文件发送失败 ${fileName}: ${error?.message ?? error}`);
				await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`);
			}
		});
		return this.outQueue;
	}
	/** Returns the created message id when available. */
	async sendMessage(windowKey, msgType, content) {
		if (!this.client) return null;
		const p2p = windowKey.startsWith("fsu:");
		const group = windowKey.startsWith("fsc:");
		if (!p2p && !group) return null;
		try {
			const response = await this.client.im.message.create({
				params: { receive_id_type: p2p ? "open_id" : "chat_id" },
				data: {
					receive_id: windowKey.replace(/^(fsu|fsc):/, ""),
					msg_type: msgType,
					content
				}
			});
			if (response?.code !== void 0 && response.code !== 0) {
				this.logger.warn(`dsh-chatops: 飞书发送被拒: code=${response.code} ${response.msg ?? ""}`);
				return null;
			}
			return response?.data?.message_id ?? null;
		} catch (error) {
			this.logger.warn(`dsh-chatops: 飞书发送失败: ${error?.message ?? error}`);
			return null;
		}
	}
	async throttle() {
		const wait = this.lastSentAt + SEND_INTERVAL_MS$2 - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastSentAt = Date.now();
	}
};

//#endregion
//#region src/host/dingtalk/channel.ts
const API_BASE = "https://api.dingtalk.com/";
const OAPI_BASE = "https://oapi.dingtalk.com/";
const SEND_INTERVAL_MS$1 = 300;
var DingTalkChannel = class {
	config;
	events;
	logger;
	client = null;
	state = "idle";
	lastError = null;
	tokenCache = null;
	outQueue = Promise.resolve();
	lastSentAt = 0;
	constructor(config, events, logger) {
		this.config = config;
		this.events = events;
		this.logger = logger;
	}
	get online() {
		return this.state === "connected";
	}
	statusSnapshot() {
		return {
			state: this.state,
			online: this.online,
			lastError: this.lastError
		};
	}
	async start() {
		const clientId = this.config.dingtalk?.clientId;
		const clientSecret = this.config.dingtalk?.clientSecret;
		if (!clientId || !clientSecret) {
			this.logger.warn("dsh-chatops: dingtalk.clientId / clientSecret 未配置，钉钉通道未启动");
			this.state = "idle";
			this.lastError = "missing clientId/clientSecret";
			return;
		}
		let DWClient, TOPIC_ROBOT;
		try {
			({DWClient, TOPIC_ROBOT} = await import("dingtalk-stream"));
		} catch {
			this.logger.warn("dsh-chatops: 未安装 dingtalk-stream。在插件目录执行：pnpm add dingtalk-stream");
			this.state = "error";
			this.lastError = "dingtalk-stream not installed";
			return;
		}
		try {
			await this.accessToken();
		} catch (error) {
			this.state = "error";
			this.lastError = error?.message ?? String(error);
			this.logger.warn(`dsh-chatops: 钉钉凭据校验失败: ${this.lastError}`);
			return;
		}
		this.state = "connecting";
		const client = new DWClient({
			clientId,
			clientSecret,
			endpoint: API_BASE.replace(/\/$/, ""),
			autoReconnect: true,
			keepAlive: true,
			debug: false
		});
		this.client = client;
		client.registerCallbackListener(TOPIC_ROBOT, (response) => {
			const messageId = response?.headers?.messageId;
			if (messageId) try {
				client.socketCallBackResponse(messageId, { success: true });
			} catch {}
			Promise.resolve().then(async () => {
				const message = typeof response?.data === "string" ? JSON.parse(response.data) : response?.data;
				if (message) this.handleMessage(message);
			}).catch((error) => this.logger.warn(`dsh-chatops: 钉钉消息处理失败: ${error?.message ?? error}`));
		});
		try {
			await client.connect();
			this.state = "connected";
			this.lastError = null;
			this.logger.info("dsh-chatops: 钉钉 Stream 长连接已建立");
		} catch (error) {
			this.state = "error";
			this.lastError = error?.message ?? String(error);
			this.logger.warn(`dsh-chatops: 钉钉连接失败: ${this.lastError}`);
		}
	}
	async stop() {
		this.state = "idle";
		try {
			this.client?.disconnect?.();
		} catch {}
		this.client = null;
	}
	/** Robot callback payload (Stream TOPIC_ROBOT). */
	handleMessage(message) {
		if (message?.msgtype !== "text") return;
		const text = String(message?.text?.content ?? "").trim();
		if (!text) return;
		const staffId = message?.senderStaffId ?? "";
		if (!staffId) return;
		if (String(message?.conversationType) === "2") {
			if (message?.isInAtList !== true) return;
			const stripped = text.replace(/@\S+/g, "").trim();
			if (!stripped) return;
			this.events.onMessage({
				windowKey: `dsc:${message.conversationId}`,
				kind: "room",
				talkerId: staffId,
				talkerName: message?.senderNick ?? staffId,
				text: stripped
			});
			return;
		}
		this.events.onMessage({
			windowKey: `dsu:${staffId}`,
			kind: "contact",
			talkerId: staffId,
			talkerName: message?.senderNick ?? staffId,
			text
		});
	}
	say(windowKey, text, _opts) {
		const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6e3);
		this.outQueue = this.outQueue.then(async () => {
			for (const chunk of chunks) {
				await this.throttle();
				await this.sendRobotMessage(windowKey, "sampleText", { content: chunk });
			}
		});
		return this.outQueue;
	}
	/** Native file/image delivery: oapi media/upload → sampleFile / sampleImageMsg. */
	async sendFile(windowKey, filePath, caption) {
		const maxMB = this.config.reply?.maxFileMB ?? 100;
		const info = await stat(filePath);
		if (info.size > maxMB * 1024 * 1024) throw new Error(`文件超过 ${maxMB}MB 上限（${(info.size / 1048576).toFixed(1)}MB）`);
		const fileName = basename(filePath);
		const isImage = [
			".jpg",
			".jpeg",
			".png",
			".webp",
			".gif"
		].includes(extname(fileName).toLowerCase());
		this.outQueue = this.outQueue.then(async () => {
			try {
				const mediaId = await this.uploadMedia(filePath, isImage ? "image" : "file");
				if (isImage) await this.sendRobotMessage(windowKey, "sampleImageMsg", { photoURL: mediaId });
				else await this.sendRobotMessage(windowKey, "sampleFile", {
					mediaId,
					fileName,
					fileType: extname(fileName).replace(".", "")
				});
				if (caption) await this.say(windowKey, caption);
			} catch (error) {
				this.logger.warn(`dsh-chatops: 钉钉文件发送失败 ${fileName}: ${error?.message ?? error}`);
				await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`);
			}
		});
		return this.outQueue;
	}
	async accessToken() {
		const clientId = this.config.dingtalk?.clientId;
		const clientSecret = this.config.dingtalk?.clientSecret;
		if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) return this.tokenCache.token;
		const response = await fetch(new URL("v1.0/oauth2/accessToken", API_BASE), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				appKey: clientId,
				appSecret: clientSecret
			}),
			signal: AbortSignal.timeout(15e3)
		});
		const value = await response.json().catch(() => null);
		const token = value?.accessToken;
		if (!token) throw new Error(`钉钉未返回 accessToken（HTTP ${response.status}）`);
		const expireIn = Number(value?.expireIn ?? value?.expiresIn ?? 7200);
		this.tokenCache = {
			token,
			expiresAt: Date.now() + Math.max(60, expireIn - 60) * 1e3
		};
		return token;
	}
	async sendRobotMessage(windowKey, msgKey, msgParam) {
		const token = await this.accessToken();
		const robotCode = this.config.dingtalk?.clientId;
		const isGroup = windowKey.startsWith("dsc:");
		const body = {
			robotCode,
			msgKey,
			msgParam: JSON.stringify(msgParam),
			...isGroup ? { openConversationId: windowKey.slice(4) } : { userIds: [windowKey.slice(4)] }
		};
		const response = await fetch(new URL(isGroup ? "v1.0/robot/groupMessages/send" : "v1.0/robot/oToMessages/batchSend", API_BASE), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-acs-dingtalk-access-token": token
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15e3)
		});
		const value = await response.json().catch(() => null);
		const code = value?.errcode ?? value?.code;
		if (!response.ok || code !== void 0 && code !== 0 && code !== "0") throw new Error(`钉钉发送被拒: HTTP ${response.status} ${value?.errmessage ?? value?.message ?? ""}`);
	}
	async uploadMedia(filePath, type) {
		const token = await this.accessToken();
		const url = new URL("media/upload", OAPI_BASE);
		url.searchParams.set("access_token", token);
		url.searchParams.set("type", type);
		const form = new FormData();
		const bytes = await stat(filePath).then(async () => {
			const { readFile } = await import("node:fs/promises");
			return readFile(filePath);
		});
		form.append("media", new Blob([new Uint8Array(bytes)]), basename(filePath));
		const response = await fetch(url, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(6e4)
		});
		const value = await response.json().catch(() => null);
		const mediaId = value?.media_id;
		if (!mediaId) throw new Error(`钉钉媒体上传被拒: ${value?.errmsg ?? `HTTP ${response.status}`}`);
		return String(mediaId);
	}
	async throttle() {
		const wait = this.lastSentAt + SEND_INTERVAL_MS$1 - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastSentAt = Date.now();
	}
};

//#endregion
//#region src/host/wecom/channel.ts
/**
* WecomChannel: 企业微信智能机器人通道（官方 @wecom/aibot-node-sdk）。
*
* - 收消息：WSClient WebSocket 长连接（botId + secret 鉴权），主动出站、
*   零公网回调；私聊直接响应，群聊靠投递即 @（群回调文本自带 @机器人 前缀，
*   剥离后入桥）。
* - 发消息：client.sendMessage(chatId, {msgtype:'text', text:{content}})；
*   文件/图片：client.uploadMedia → client.sendMediaMessage。
* - 流式（replyStream：正在思考中/进度/流式回答）是企微独有原生能力，二期接入。
* - SDK 为可选依赖：未安装时插件照常加载并给出安装指引。
*
* windowKey 命名：`wsu:{userid}` 私聊，`wsc:{chatid}` 群聊。
* 注意：企微智能机器人仅面向企业内部成员，个人微信不可见。
*/
const SEND_INTERVAL_MS = 300;
var WecomChannel = class {
	config;
	events;
	logger;
	client = null;
	state = "idle";
	lastError = null;
	outQueue = Promise.resolve();
	lastSentAt = 0;
	constructor(config, events, logger) {
		this.config = config;
		this.events = events;
		this.logger = logger;
	}
	get online() {
		return this.state === "connected";
	}
	statusSnapshot() {
		return {
			state: this.state,
			online: this.online,
			lastError: this.lastError
		};
	}
	async start() {
		const botId = this.config.wecom?.botId;
		const secret = this.config.wecom?.secret;
		if (!botId || !secret) {
			this.logger.warn("dsh-chatops: wecom.botId / wecom.secret 未配置，企业微信通道未启动");
			this.state = "idle";
			this.lastError = "missing botId/secret";
			return;
		}
		let WSClient;
		try {
			({WSClient} = await import("@wecom/aibot-node-sdk"));
		} catch {
			this.logger.warn("dsh-chatops: 未安装 @wecom/aibot-node-sdk。在插件目录执行：pnpm add @wecom/aibot-node-sdk");
			this.state = "error";
			this.lastError = "wecom sdk not installed";
			return;
		}
		this.state = "connecting";
		const client = new WSClient({
			botId,
			secret,
			logger: {
				debug() {},
				info() {},
				warn() {},
				error() {}
			}
		});
		client.on("message", (frame) => {
			Promise.resolve().then(() => this.handleMessage(frame)).catch((error) => this.logger.warn(`dsh-chatops: 企微消息处理失败: ${error?.message ?? error}`));
		});
		client.on("authenticated", () => {
			this.state = "connected";
			this.lastError = null;
			this.logger.info("dsh-chatops: 企业微信长连接已建立");
		});
		client.on("disconnected", () => {
			if (this.state === "connected") this.state = "connecting";
		});
		client.on("error", (error) => {
			this.lastError = error?.message ?? String(error);
			this.logger.warn(`dsh-chatops: 企微连接错误: ${this.lastError}`);
		});
		this.client = client;
		Promise.resolve().then(() => client.connect()).catch((error) => {
			this.state = "error";
			this.lastError = error?.message ?? String(error);
			this.logger.warn(`dsh-chatops: 企微 WSClient 启动失败: ${this.lastError}`);
		});
	}
	async stop() {
		this.state = "idle";
		try {
			this.client?.disconnect?.();
		} catch {}
		this.client = null;
	}
	/** Frame body: { msgtype, chattype: 'single'|'group', chatid, from: {userid}, text/voice/mixed }. */
	handleMessage(frame) {
		const body = frame?.body ?? frame;
		let text = "";
		if (body?.msgtype === "text") text = String(body?.text?.content ?? "").trim();
		else if (body?.msgtype === "voice") text = String(body?.voice?.content ?? "").trim();
		else if (body?.msgtype === "mixed" && Array.isArray(body?.mixed?.msg_item)) text = body.mixed.msg_item.filter((item) => item?.msgtype === "text" && typeof item?.text?.content === "string").map((item) => item.text.content).join("\n").trim();
		else return;
		if (!text) return;
		const userId = body?.from?.userid ?? "";
		if (!userId) return;
		if (body.chattype === "group") {
			const stripped = text.replace(/^\s*@\S+(?:\s+|$)/u, "").trim();
			if (!stripped) return;
			this.events.onMessage({
				windowKey: `wsc:${body.chatid}`,
				kind: "room",
				talkerId: userId,
				talkerName: userId,
				text: stripped
			});
			return;
		}
		this.events.onMessage({
			windowKey: `wsu:${userId}`,
			kind: "contact",
			talkerId: userId,
			talkerName: userId,
			text
		});
	}
	say(windowKey, text, _opts) {
		const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6e3);
		this.outQueue = this.outQueue.then(async () => {
			for (const chunk of chunks) {
				await this.throttle();
				await this.sendText(windowKey, chunk);
			}
		});
		return this.outQueue;
	}
	/** Native file/image delivery: uploadMedia → sendMediaMessage. */
	async sendFile(windowKey, filePath, caption) {
		if (!this.client) throw new Error("企业微信通道未连接");
		const maxMB = this.config.reply?.maxFileMB ?? 100;
		const info = await stat(filePath);
		if (info.size > maxMB * 1024 * 1024) throw new Error(`文件超过 ${maxMB}MB 上限（${(info.size / 1048576).toFixed(1)}MB）`);
		const fileName = basename(filePath);
		const isImage = [
			".jpg",
			".jpeg",
			".png",
			".webp",
			".gif"
		].includes(extname(fileName).toLowerCase());
		this.outQueue = this.outQueue.then(async () => {
			try {
				const bytes = await readFile(filePath);
				const mediaId = await this.client.uploadMedia(bytes, {
					type: isImage ? "image" : "file",
					filename: fileName
				});
				await this.client.sendMediaMessage(this.chatIdOf(windowKey), isImage ? "image" : "file", mediaId);
				if (caption) await this.say(windowKey, caption);
			} catch (error) {
				this.logger.warn(`dsh-chatops: 企微文件发送失败 ${fileName}: ${error?.message ?? error}`);
				await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`);
			}
		});
		return this.outQueue;
	}
	chatIdOf(windowKey) {
		return windowKey.replace(/^(wsu|wsc):/, "");
	}
	async sendText(windowKey, text) {
		if (!this.client) return;
		try {
			await this.client.sendMessage(this.chatIdOf(windowKey), {
				msgtype: "text",
				text: { content: text }
			});
		} catch (error) {
			this.logger.warn(`dsh-chatops: 企微发送失败: ${error?.message ?? error}`);
		}
	}
	async throttle() {
		const wait = this.lastSentAt + SEND_INTERVAL_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastSentAt = Date.now();
	}
};

//#endregion
//#region src/host/manager.ts
const PREFIXES = [
	"wsu:",
	"wsc:",
	"dsu:",
	"dsc:",
	"fsu:",
	"fsc:",
	"user:",
	"contact:",
	"room:",
	"filehelper",
	"self"
];
var ChannelManager = class {
	channels = /* @__PURE__ */ new Map();
	register(prefixes, channel) {
		for (const prefix of prefixes) this.channels.set(prefix, channel);
	}
	channelFor(windowKey) {
		for (const prefix of PREFIXES) if (windowKey.startsWith(prefix)) return this.channels.get(prefix) ?? null;
		return null;
	}
	/** Card-capable channel for this window, or null (structural probe). */
	cardsFor(windowKey) {
		const channel = this.channelFor(windowKey);
		return typeof channel?.sendApprovalCard === "function" ? channel : null;
	}
	say(windowKey, text, opts) {
		const channel = this.channelFor(windowKey);
		if (!channel) return Promise.resolve();
		return channel.say(windowKey, text, opts);
	}
	all() {
		return [...new Set(this.channels.values())];
	}
};

//#endregion
//#region src/host/auth.ts
/**
* Source filtering and window↔session binding store.
*
* 来源过滤是个人号方案的第一道命：默认只响应 filehelper / self / 显式白名单，
* 其余一切消息（陌生人私聊、被拉进的群）静默忽略并记审计日志。
*/
var AuthStore = class {
	config;
	logger;
	bindings = /* @__PURE__ */ new Map();
	/** Users always trusted: the scan-binding owner(s). Persisted, survives restarts. */
	ownerIds = /* @__PURE__ */ new Set();
	bindingsFile;
	auditFile;
	constructor(config, storageDir, logger) {
		this.config = config;
		this.logger = logger;
		mkdirSync(storageDir, { recursive: true });
		this.bindingsFile = join(storageDir, "bindings.json");
		this.auditFile = join(storageDir, "audit.jsonl");
		this.load();
	}
	/** Mark a user id as a binding owner (always trusted). */
	addOwner(userId) {
		if (userId && !this.ownerIds.has(userId)) {
			this.ownerIds.add(userId);
			this.save();
		}
	}
	/** Whether any owner has been adopted/configured yet. */
	hasOwners() {
		return this.ownerIds.size > 0;
	}
	/** Is this conversation window allowed to drive DSH at all? */
	isAllowed(windowKey, kind) {
		const sec = this.config.security ?? {};
		switch (kind) {
			case "filehelper": return sec.listenFilehelper !== false;
			case "self": return sec.listenSelf !== false;
			case "contact": {
				const id = windowKey.replace(/^(user|contact|fsu|dsu|wsu):/, "");
				if (this.ownerIds.has(id)) return true;
				return (sec.allowContacts ?? []).includes(id);
			}
			case "room": {
				const id = windowKey.replace(/^(room|fsc|dsc|wsc):/, "");
				return (sec.allowRooms ?? []).includes(id);
			}
			default: return false;
		}
	}
	/** For room messages the actual talker must additionally be trusted. */
	isRoomTalkerAllowed(talkerId) {
		const sec = this.config.security ?? {};
		if (this.ownerIds.has(talkerId)) return true;
		return (sec.allowContacts ?? []).length === 0 || (sec.allowContacts ?? []).includes(talkerId);
	}
	getBinding(windowKey) {
		return this.bindings.get(windowKey);
	}
	setBinding(windowKey, sessionId, workspace = null) {
		const binding = {
			sessionId,
			workspace,
			boundAt: Date.now()
		};
		this.bindings.set(windowKey, binding);
		this.save();
		return binding;
	}
	/** Which windows currently point at this session (for push routing). */
	windowsForSession(sessionId) {
		const out = [];
		for (const [key, b] of this.bindings) if (b.sessionId === sessionId) out.push(key);
		return out;
	}
	/** One JSON line per security-relevant event: ignored sources, commands, approvals. */
	audit(event, data) {
		const line = JSON.stringify({
			time: (/* @__PURE__ */ new Date()).toISOString(),
			event,
			...data
		});
		try {
			appendFileSync(this.auditFile, line + "\n");
		} catch (error) {
			this.logger.warn(`dsh-chatops: audit write failed: ${error?.message ?? error}`);
		}
	}
	load() {
		if (!existsSync(this.bindingsFile)) return;
		try {
			const raw = JSON.parse(readFileSync(this.bindingsFile, "utf8"));
			for (const [key, value] of Object.entries(raw.bindings ?? {})) this.bindings.set(key, value);
			for (const id of raw.owners ?? []) if (typeof id === "string" && id) this.ownerIds.add(id);
		} catch (error) {
			this.logger.warn(`dsh-chatops: bindings load failed: ${error?.message ?? error}`);
		}
	}
	save() {
		try {
			writeFileSync(this.bindingsFile, JSON.stringify({
				version: 1,
				owners: [...this.ownerIds],
				bindings: Object.fromEntries(this.bindings)
			}, null, 2));
		} catch (error) {
			this.logger.warn(`dsh-chatops: bindings save failed: ${error?.message ?? error}`);
		}
	}
};

//#endregion
//#region src/host/bridge.ts
/**
* SessionBridge: routes WeChat messages to DSH sessions and back.
*
* Command surface (`/` prefix; anything else goes to the bound session as a
* prompt):
*   /help            指令帮助
*   /sessions        列出会话（编号 + 标题 + 状态）
*   /use <n|id>      切换当前窗口绑定的会话
*   /bind            查看当前绑定
*   /status          当前会话运行状态
*   /log [n]         最近 n 条 assistant 输出（内存环形缓冲）
*   /approve /reject 响应待审批请求
*   /stop            中断当前会话（TODO: 依赖 agent 中断 API，见下）
*   /new <prompt>    新建会话（TODO: 依赖会话创建 API，见下）
*/
const LOG_RING_SIZE = 50;
/** Max chars /log will emit in one go (≈8 WeChat messages after chunking). */
const LOG_TOTAL_CAP = 12e3;
/** /log output longer than this is sent as a .txt file (file-capable channels). */
const LONG_OUTPUT_FILE_THRESHOLD = 4e3;
var SessionBridge = class {
	ctx;
	config;
	channel;
	auth;
	logger;
	/** sessionId → recent assistant text snippets (ring buffer). */
	logRings = /* @__PURE__ */ new Map();
	/** Latest turn status per session: running | idle. */
	turnStatus = /* @__PURE__ */ new Map();
	/** Approvals currently waiting on an IM decision. */
	pendingApprovals = /* @__PURE__ */ new Map();
	/** The same approvals keyed by approval id (card-button callbacks carry ids). */
	pendingById = /* @__PURE__ */ new Map();
	/** sessionId|windowKey → streaming progress card (feishu). */
	progressCards = /* @__PURE__ */ new Map();
	/** Last active root agent, mirrors dsh-cron's delivery heuristic. */
	lastActiveRoot = null;
	/** Last listing shown by /sessions, so /use <编号> maps to the same order. */
	lastList = [];
	constructor(ctx, config, channel, auth, logger) {
		this.ctx = ctx;
		this.config = config;
		this.channel = channel;
		this.auth = auth;
		this.logger = logger;
	}
	/**
	* Human-readable session name: the folded `session/title` event via the
	* sessionTitle service (auto-generated after the first turn), falling back
	* to a direct scan of `session/title` events, then the first user message,
	* and finally the raw id.
	*/
	titleOf(session) {
		try {
			const snap = (this.ctx.sessionTitle ?? this.ctx.get?.("sessionTitle"))?.get?.(session);
			if (snap?.title) return snap.title;
		} catch {}
		try {
			let title = null;
			let firstUser = null;
			for (const event of session?.events ?? []) if (event?.type === "session/title" && event?.data?.title) title = event.data.title;
			else if (!firstUser && event?.type === "user/message") {
				const text = messageText(event.data?.message ?? event.data);
				if (text) firstUser = text;
			}
			if (title) return title;
			if (firstUser) return firstUser.slice(0, 30) + (firstUser.length > 30 ? "…" : "");
		} catch {}
		return session?.id ?? "未命名会话";
	}
	/** sessionQuery 服务（已在 inject 声明；防御性获取兜底 headless profile）。 */
	query() {
		try {
			return this.ctx.sessionQuery ?? this.ctx.get?.("sessionQuery") ?? null;
		} catch {
			return null;
		}
	}
	/** 诊断：上一次冷会话读取的状态（无服务/异常/记录数）。 */
	coldDiag = "未执行";
	/**
	* Seed model options for resume, mirroring the API proxy: sessions that
	* already logged a model selection keep it; this fills the blank that
	* otherwise breaks the persona assembly (prompt variable "{{model}}").
	*/
	seedAgentOptions() {
		try {
			const sel = (this.ctx.agentDefaultModel ?? this.ctx.get?.("agentDefaultModel"))?.currentSelection?.();
			if (sel?.provider && sel?.model) return {
				provider: sel.provider,
				model: sel.model
			};
		} catch {}
	}
	/** GUI 的归档集合（storages/workspace.json），归档会话与 GUI 保持一致地隐藏。 */
	archivedIds() {
		try {
			const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
			const raw = JSON.parse(readFileSync(join(dshHome, "storages", "workspace.json"), "utf8"));
			return new Set(raw?.global?.archivedSessionIds ?? []);
		} catch {
			return /* @__PURE__ */ new Set();
		}
	}
	/**
	* 全量顶层会话：live roots 在前（可交互），其后是持久化里的冷会话。
	* 结果缓存到 lastList，供 /use <编号> 按同一顺序取。
	*/
	async allSessions() {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const agent of this.roots()) {
			const s = agent?.session;
			if (!s?.id || seen.has(s.id)) continue;
			seen.add(s.id);
			out.push({
				id: s.id,
				title: this.titleOf(s),
				live: true,
				agent
			});
		}
		const q = this.query();
		if (!q?.listSessions) this.coldDiag = "sessionQuery 服务不可用";
		else {
			let records = [];
			try {
				records = await q.listSessions();
				this.coldDiag = `冷记录 ${records.length} 条`;
			} catch (e) {
				records = [];
				this.coldDiag = `listSessions 异常: ${e?.message ?? e}`;
			}
			const archived = this.archivedIds();
			const cold = records.filter((r) => {
				const h = r?.header ?? r;
				return h?.id && !seen.has(h.id) && !archived.has(h.id);
			});
			let titleFails = 0;
			await Promise.all(cold.map(async (r) => {
				const h = r.header ?? r;
				let title = null;
				try {
					const t = await q.readTitle?.(h.id);
					title = typeof t === "string" ? t : t?.title ?? null;
				} catch (e) {
					titleFails++;
					if (titleFails === 1) this.coldDiag += `；readTitle 异常: ${e?.message ?? e}`;
				}
				const cwdName = typeof h.cwd === "string" ? h.cwd.split("/").filter(Boolean).pop() ?? "" : "";
				const liveAgent = this.liveAgentOf(h.id);
				out.push({
					id: h.id,
					title: title ?? (liveAgent ? this.titleOf(liveAgent.session) : null) ?? (cwdName ? `[${cwdName}] ` : "") + `${String(h.id).slice(8, 14)}…`,
					live: Boolean(liveAgent),
					agent: liveAgent ?? void 0
				});
			}));
			this.coldDiag += `；进入列表 ${cold.length} 条`;
		}
		this.lastList = out;
		return out;
	}
	start() {
		this.ctx.on("agent/created", ({ agent }) => {
			if (this.ctx.agents.roots().includes(agent)) this.lastActiveRoot = agent;
		});
		this.ctx.on("agent/status", ({ agent }) => {
			if (agent && this.ctx.agents.roots().includes(agent)) this.lastActiveRoot = agent;
		});
		this.ctx.on("session/event", (session, event) => {
			try {
				this.onSessionEvent(session, event);
			} catch (error) {
				this.logger.warn(`dsh-chatops: session/event handling failed: ${error?.message ?? error}`);
			}
		});
		this.ctx.on("approval/request", (req) => this.onApprovalRequest(req));
	}
	onSessionEvent(session, event) {
		const sessionId = session?.id;
		if (!sessionId) return;
		const data = event?.data ?? {};
		if (event.type === "assistant/message") {
			const text = messageText(data.message);
			if (text) {
				const ring = this.logRings.get(sessionId) ?? [];
				ring.push(text);
				if (ring.length > LOG_RING_SIZE) ring.shift();
				this.logRings.set(sessionId, ring);
			}
			return;
		}
		if (event.type === "turn/start") {
			this.turnStatus.set(sessionId, "running");
			return;
		}
		if (event.type === "turn/end") {
			const wasRunning = this.turnStatus.get(sessionId) === "running";
			this.turnStatus.set(sessionId, "idle");
			if (!wasRunning) return;
			if (this.config.push?.onSessionComplete !== false) {
				const kind = data.reason?.kind ?? "unknown";
				const ring = this.logRings.get(sessionId) ?? [];
				const last = ring[ring.length - 1];
				const excerpt = last ? last.slice(0, 300) : "(无文本输出)";
				for (const windowKey of this.auth.windowsForSession(sessionId)) {
					const cardKey = `${sessionId}|${windowKey}`;
					const progress = this.progressCards.get(cardKey);
					if (progress) {
						this.progressCards.delete(cardKey);
						const cards = this.channel.cardsFor?.(windowKey);
						if (cards?.completeProgressCard) {
							cards.completeProgressCard(progress.messageId, progress.sessionTitle, progress.prompt, kind, last ?? "(无文本输出)");
							continue;
						}
					}
					const icon = kind === "completed" ? "✅" : "⚠️";
					this.channel.say(windowKey, `${icon} [${this.titleOf(session)}] 任务${kind === "completed" ? "完成" : `结束(${kind})`}：\n${excerpt}\n\n回复 /log 1 查看完整输出`);
				}
			}
		}
	}
	async onApprovalRequest(req) {
		if (this.config.push?.onApproval === false) return void 0;
		const session = req.agent?.session;
		const sessionId = session?.id;
		if (!sessionId) return void 0;
		const windows = this.auth.windowsForSession(sessionId);
		if (windows.length === 0) return void 0;
		const timeoutMs = Math.max(10, this.config.push?.approvalTimeoutSec ?? 300) * 1e3;
		const approvalId = `appr-${randomUUID().slice(0, 8)}`;
		const cardData = {
			approvalId,
			sessionTitle: this.titleOf(session),
			toolName: req.toolName ?? "unknown",
			reason: String(req.reason ?? "").slice(0, 300),
			timeoutMin: Math.round(timeoutMs / 6e4)
		};
		const decision = new Promise((resolve) => {
			const timer = setTimeout(() => {
				const pending = this.pendingById.get(approvalId);
				if (pending) this.dropApproval(pending);
				resolve(void 0);
			}, timeoutMs);
			const pending = {
				id: approvalId,
				req,
				resolve,
				sessionId,
				windows,
				cardData,
				timer
			};
			for (const w of windows) this.pendingApprovals.set(w, pending);
			this.pendingById.set(approvalId, pending);
		});
		this.auth.audit("approval/asked", {
			sessionId,
			toolName: req.toolName,
			reason: String(req.reason ?? "").slice(0, 200)
		});
		for (const windowKey of windows) {
			const cards = this.channel.cardsFor?.(windowKey);
			if (cards) cards.sendApprovalCard(windowKey, cardData);
			else this.channel.say(windowKey, `⚠️ [${cardData.sessionTitle}] 审批请求\n工具: ${cardData.toolName}\n原因: ${cardData.reason}\n\n回复 /approve 批准，/reject 拒绝（${cardData.timeoutMin} 分钟内有效，超时转 GUI 处理）`);
		}
		return decision;
	}
	dropApproval(pending) {
		clearTimeout(pending.timer);
		for (const [key, value] of this.pendingApprovals) if (value === pending) this.pendingApprovals.delete(key);
		this.pendingById.delete(pending.id);
	}
	/**
	* Card-button decision (feishu card.action.trigger). Returns the terminal
	* card to swap into the message, or null when the approval is unknown or
	* the operator is not trusted.
	*/
	async decideApprovalById(approvalId, outcome, operatorId) {
		const pending = this.pendingById.get(approvalId);
		if (!pending) return null;
		if (!this.auth.isAllowed(`fsu:${operatorId}`, "contact")) {
			this.auth.audit("approval/denied-operator", {
				approvalId,
				operatorId
			});
			return null;
		}
		this.dropApproval(pending);
		this.auth.audit("approval/decided", {
			sessionId: pending.sessionId,
			toolName: pending.req?.toolName,
			outcome,
			operator: operatorId,
			via: "card"
		});
		pending.resolve(outcome);
		const { approvalResultCard } = await Promise.resolve().then(() => cards_exports);
		return approvalResultCard(pending.cardData, outcome, operatorId);
	}
	async handleInbound(msg) {
		if (!this.auth.isAllowed(msg.windowKey, msg.kind)) {
			this.auth.audit("ignored/message", {
				windowKey: msg.windowKey,
				kind: msg.kind,
				talkerId: msg.talkerId
			});
			return;
		}
		if (msg.kind === "room" && !this.auth.isRoomTalkerAllowed(msg.talkerId)) {
			this.auth.audit("ignored/room-talker", {
				windowKey: msg.windowKey,
				talkerId: msg.talkerId
			});
			return;
		}
		const text = msg.text;
		this.auth.audit("command/inbound", {
			windowKey: msg.windowKey,
			text: text.slice(0, 200)
		});
		if (text.startsWith("/")) {
			const reply = await this.runCommand(msg, text);
			const cmd = text.split(/\s+/)[0];
			if (cmd === "/log" && reply && reply.length > LONG_OUTPUT_FILE_THRESHOLD && this.config.push?.longOutputAsFile !== false) {
				const channel = this.channel.channelFor?.(msg.windowKey) ?? null;
				if (typeof channel?.sendFile === "function") {
					const dir = mkdtempSync(join(tmpdir(), "dsh-chatops-"));
					const file = join(dir, `session-log-${Date.now()}.txt`);
					writeFileSync(file, reply);
					await channel.sendFile(msg.windowKey, file, "📄 输出较长，已转为文件发送");
					return;
				}
			}
			if (reply) await this.channel.say(msg.windowKey, reply, { bulk: cmd === "/log" });
			return;
		}
		await this.forwardPrompt(msg, text);
	}
	async runCommand(msg, text) {
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		switch (cmd) {
			case "/help": return HELP_TEXT;
			case "/sessions": return await this.listSessions();
			case "/use": return await this.useSession(msg.windowKey, arg);
			case "/bind": return this.showBinding(msg.windowKey);
			case "/status": return this.showStatus(msg.windowKey);
			case "/log": return this.showLog(msg.windowKey, Number.parseInt(arg, 10) || 3);
			case "/send": return await this.sendFileCommand(msg.windowKey, arg);
			case "/approve": return this.decideApproval(msg.windowKey, "allowed-once");
			case "/reject": return this.decideApproval(msg.windowKey, "rejected");
			case "/stop": return "⏳ /stop 尚未接入：中断 API 待确认（GUI 侧 interrupt 路径）。";
			case "/new": return "⏳ /new 尚未接入：会话创建 API 待确认。请先在 GUI 新建会话后用 /use 绑定。";
			default: return `未知指令 ${cmd}，回复 /help 查看可用指令。`;
		}
	}
	roots() {
		try {
			return this.ctx.agents.roots();
		} catch {
			return [];
		}
	}
	/** 按 sessionId 找活 agent——覆盖非 root 的活会话（continuable 子会话 resume 后不是 root）。 */
	liveAgentOf(sessionId) {
		try {
			return this.ctx.agents.get?.(sessionId) ?? null;
		} catch {
			return null;
		}
	}
	async listSessions() {
		const all = await this.allSessions();
		if (all.length === 0) return "当前没有任何会话。请先在 DSH GUI 中创建一个会话。";
		const lines = all.map((s, i) => {
			const status = s.live ? this.turnStatus.get(s.id) === "running" ? "🔄运行中" : "💤空闲" : "📦未加载";
			return `${i + 1}. ${s.title} ${status}\n   id: ${shortId(s.id)}`;
		});
		return `📋 会话列表（${all.length} 个）：\n${lines.join("\n")}\n\n[诊断] ${this.coldDiag}\n回复 /use <编号> 切换（📦会话会自动唤醒）`;
	}
	async useSession(windowKey, arg) {
		if (!arg) return "用法：/use <编号或会话id>";
		const list = this.lastList.length > 0 ? this.lastList : await this.allSessions();
		let entry = null;
		const index = Number.parseInt(arg, 10);
		if (Number.isFinite(index) && index >= 1 && index <= list.length) entry = list[index - 1];
		else entry = list.find((s) => s.id === arg || s.id.startsWith(arg)) ?? null;
		if (!entry) return `找不到会话 "${arg}"。回复 /sessions 查看列表。`;
		if (!(entry.agent ?? this.liveAgentOf(entry.id))) try {
			const handle = await this.ctx.agents.resume({
				resumeSessionId: entry.id,
				agentOptions: this.seedAgentOptions()
			});
			entry.agent = handle?.agent ?? handle;
			entry.live = true;
		} catch (error) {
			const msg = String(error?.message ?? error);
			if (msg.includes("while it is live")) {
				if (this.liveAgentOf(entry.id)) {
					this.auth.setBinding(windowKey, entry.id);
					return `✅ 已绑定会话：${entry.title}\n直接发消息即作为 prompt 发送。`;
				}
			}
			return `⚠️ 会话「${entry.title}」尚未加载，自动唤醒失败：${msg}\n请先在 GUI 中打开它，再 /use 绑定。`;
		}
		this.auth.setBinding(windowKey, entry.id);
		return `✅ 已绑定会话：${entry.title}\n直接发消息即作为 prompt 发送。`;
	}
	showBinding(windowKey) {
		const binding = this.auth.getBinding(windowKey);
		if (!binding?.sessionId) return "当前窗口未绑定会话。回复 /sessions 查看列表，/use <编号> 绑定。";
		const agent = this.liveAgentOf(binding.sessionId);
		return `当前绑定：${agent ? this.titleOf(agent.session) : binding.sessionId}${agent ? "" : "（会话已关闭，请重新 /use）"}`;
	}
	showStatus(windowKey) {
		const sessionId = this.auth.getBinding(windowKey)?.sessionId;
		if (!sessionId) return "未绑定会话。回复 /sessions + /use <编号> 先绑定。";
		return (this.turnStatus.get(sessionId) ?? "idle") === "running" ? "🔄 当前会话正在执行中…" : "💤 当前会话空闲，可以直接发消息。";
	}
	showLog(windowKey, count) {
		const sessionId = this.auth.getBinding(windowKey)?.sessionId;
		if (!sessionId) return "未绑定会话。回复 /sessions + /use <编号> 先绑定。";
		const ring = this.logRings.get(sessionId) ?? [];
		if (ring.length === 0) return "暂无输出记录（缓冲区仅保留插件加载后的新输出）。";
		const items = ring.slice(-Math.min(count, 10));
		let body = items.map((t, i) => `--- ${i + 1}/${items.length} ---\n${t}`).join("\n");
		if (body.length > LOG_TOTAL_CAP) {
			body = body.slice(-12e3);
			body = `（内容过长，仅显示最近 ${LOG_TOTAL_CAP} 字符，完整内容请在 GUI 查看）\n…${body}`;
		}
		return `📄 最近 ${items.length} 条输出（完整）：\n${body}`;
	}
	decideApproval(windowKey, outcome) {
		const pending = this.pendingApprovals.get(windowKey);
		if (!pending) return "当前没有等待审批的请求。";
		this.dropApproval(pending);
		this.auth.audit("approval/decided", {
			sessionId: pending.sessionId,
			toolName: pending.req?.toolName,
			outcome,
			windowKey
		});
		pending.resolve(outcome);
		return outcome === "allowed-once" ? "✅ 已批准，继续执行。" : "❌ 已拒绝。";
	}
	/** /send <path>: push a workspace file to the bound IM window. */
	async sendFileCommand(windowKey, arg) {
		if (!arg) return "用法：/send <工作区内文件路径>（如 /send reports/weekly.md）";
		const sessionId = this.auth.getBinding(windowKey)?.sessionId;
		if (!sessionId) return "未绑定会话。回复 /sessions + /use <编号> 先绑定。";
		const resolved = this.resolveWorkspaceFile(sessionId, arg);
		if ("error" in resolved) return resolved.error;
		return await this.sendFileToWindow(windowKey, resolved.path, `📎 ${basename(resolved.path)}`) ? `📤 文件「${basename(resolved.path)}」发送中…` : "当前通道不支持文件发送（微信 ilink / 飞书支持；wechaty 通道暂不支持）。";
	}
	/**
	* Tool entry: the model calls im_send_file inside a session; the file goes
	* to every IM window bound to THAT session (never to a stranger's window).
	*/
	async sendFileForSession(sessionId, relPath, caption) {
		const resolved = this.resolveWorkspaceFile(sessionId, relPath);
		if ("error" in resolved) {
			this.auth.audit("file/send-failed", {
				sessionId,
				relPath,
				reason: resolved.error
			});
			return `发送失败：${resolved.error}`;
		}
		const windows = this.auth.windowsForSession(sessionId);
		if (windows.length === 0) {
			this.auth.audit("file/send-failed", {
				sessionId,
				relPath,
				reason: "no-bound-window"
			});
			return "发送失败：该会话没有绑定任何 IM 窗口（在微信/飞书里 /use 绑定后再试）。";
		}
		let sent = 0;
		let lastError = null;
		for (const windowKey of windows) try {
			if (await this.sendFileToWindow(windowKey, resolved.path, caption ?? `📎 ${basename(resolved.path)}`)) sent++;
			else lastError = "通道不支持文件发送";
		} catch (error) {
			lastError = error?.message ?? String(error);
		}
		if (sent === 0 && lastError) {
			this.auth.audit("file/send-failed", {
				sessionId,
				relPath,
				reason: lastError
			});
			return `发送失败：${lastError}`;
		}
		this.auth.audit("file/send", {
			sessionId,
			path: resolved.path,
			windows,
			sent
		});
		return sent > 0 ? `文件「${basename(resolved.path)}」已发送到 ${sent} 个 IM 窗口。` : "发送失败：绑定的通道不支持文件发送。";
	}
	/** Resolve relPath inside the session workspace; refuse escapes. */
	resolveWorkspaceFile(sessionId, relPath) {
		const cwd = this.liveAgentOf(sessionId)?.session?.header?.cwd;
		if (!cwd) return { error: "会话未加载，无法确定工作区。请 /use 重新绑定（📦会话会自动唤醒）。" };
		const abs = resolve(cwd, relPath);
		if (abs !== cwd && !abs.startsWith(cwd + sep)) {
			this.auth.audit("file/escape-blocked", {
				sessionId,
				relPath
			});
			return { error: "只允许发送当前会话工作区内的文件。" };
		}
		if (!existsSync(abs)) return { error: `文件不存在：${relPath}` };
		try {
			if (!statSync(abs).isFile()) return { error: `不是文件：${relPath}` };
		} catch {
			return { error: `无法读取：${relPath}` };
		}
		return { path: abs };
	}
	/** Send via the channel owning this window, when it supports file send. */
	async sendFileToWindow(windowKey, path, caption) {
		const channel = this.channel.channelFor?.(windowKey) ?? null;
		if (typeof channel?.sendFile !== "function") return false;
		await channel.sendFile(windowKey, path, caption);
		return true;
	}
	async forwardPrompt(msg, text) {
		const windowKey = msg.windowKey;
		let sessionId = this.auth.getBinding(windowKey)?.sessionId;
		let agent = sessionId ? this.liveAgentOf(sessionId) : null;
		if (!agent && sessionId) try {
			await this.ctx.agents.resume({
				resumeSessionId: sessionId,
				agentOptions: this.seedAgentOptions()
			});
			agent = this.liveAgentOf(sessionId);
		} catch {}
		if (!agent) {
			agent = this.lastActiveRoot && this.roots().includes(this.lastActiveRoot) ? this.lastActiveRoot : this.roots()[this.roots().length - 1];
			if (!agent) {
				await this.channel.say(windowKey, "当前没有打开的会话。请先在 DSH GUI 中打开一个会话。");
				return;
			}
			this.auth.setBinding(windowKey, agent.session.id);
			await this.channel.say(windowKey, `🔗 已自动绑定到最近活跃的会话：${this.titleOf(agent.session)}`);
		}
		try {
			const message = createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-chatops"
				}
			});
			agent.followup(message);
			this.turnStatus.set(agent.session.id, "running");
			const cards = this.channel.cardsFor?.(windowKey);
			if (cards?.sendProgressCard) {
				const sessionTitle = this.titleOf(agent.session);
				const messageId = await cards.sendProgressCard(windowKey, sessionTitle, text);
				if (messageId) this.progressCards.set(`${agent.session.id}|${windowKey}`, {
					messageId,
					prompt: text,
					sessionTitle
				});
				else await this.channel.say(windowKey, `🚀 已发送给 [${sessionTitle}]，完成后通知你。`);
			} else await this.channel.say(windowKey, `🚀 已发送给 [${this.titleOf(agent.session)}]，完成后通知你。`);
		} catch (error) {
			this.logger.warn(`dsh-chatops: followup failed: ${error?.message ?? error}`);
			await this.channel.say(windowKey, `❌ 发送失败：${error?.message ?? error}`);
		}
	}
};
const HELP_TEXT = `🤖 dsh-chatops 指令：
/sessions — 会话列表
/use <编号> — 绑定会话
/bind — 查看当前绑定
/status — 会话运行状态
/log [n] — 最近 n 条完整输出
/approve /reject — 审批
/send <路径> — 回传工作区文件
直接发送其他文字 = 作为 prompt 发给绑定会话`;
function shortId(id) {
	const text = typeof id === "string" ? id : "?";
	return text.length > 24 ? text.slice(0, 24) + "…" : text;
}
function messageText(message) {
	if (!message) return "";
	if (typeof message === "string") return message;
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
	return "";
}

//#endregion
//#region src/host/qrcode.ts
/**
* Login-QR rendering: terminal QR when qrcode-terminal is available, plus an
* online-render fallback link that always works (scan it with WeChat).
* The latest QR string is also kept for the optional /wechat/api/status
* endpoint so a GUI panel can render it later.
*/
let latestQr = null;
async function renderScanQr(qrcode, logger) {
	latestQr = qrcode;
	try {
		const mod = await import("qrcode-terminal");
		(mod.default ?? mod).generate(qrcode, { small: true }, (out) => {
			process.stderr.write(`\n🤖 dsh-chatops: 用微信扫码登录 Bot（小号！）\n${out}\n`);
		});
	} catch {
		logger.info(`dsh-chatops: qrcode-terminal not installed; render the login QR via this link:
  https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrcode)}`);
	}
}

//#endregion
//#region src/host/index.ts
/**
* dsh-chatops: drive DeepSeek Harness from WeChat.
*
* Default channel: 微信官方 ClawBot（腾讯 iLink 机器人协议）— scan a QR in
* the browser page /wechat/qr, a bot contact appears in WeChat, chat with it
* to drive every workspace and session. Compliant, no ban risk, token-based
* reconnection (no rescan on restart).
*
* Alternative channel: wechaty personal-account bot (v1 skeleton; violates
* WeChat ToS, use a throwaway account only).
*/
const name = "dsh-chatops";
const inject = [
	"agents",
	"sessionQuery",
	"sessionTitle",
	"tools"
];
function apply(ctx, config) {
	const logger = ctx.logger;
	const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : ctx.credentials ?? null;
	const kinds = Array.isArray(config.channels) && config.channels.length > 0 ? config.channels : [config.channel ?? "ilink"];
	const manager = new ChannelManager();
	const channelsByKind = /* @__PURE__ */ new Map();
	const storageDir = config.storagePath || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "storages", "dsh-chatops");
	migrateStorage(storageDir, logger);
	const auth = new AuthStore(config, storageDir, logger);
	let ilinkChannel = null;
	const onMessage = (msg) => {
		if ((msg.windowKey.startsWith("fsu:") || msg.windowKey.startsWith("dsu:") || msg.windowKey.startsWith("wsu:")) && !auth.hasOwners()) {
			auth.addOwner(msg.talkerId);
			auth.audit("owner/adopted", {
				channel: msg.windowKey.split(":")[0],
				userId: msg.talkerId
			});
			manager.say(msg.windowKey, `🤖 dsh-chatops 已上线，你已被登记为管理员（${msg.talkerId}）。回复 /help 查看指令。`);
		}
		bridge.handleInbound(msg).catch((error) => logger.warn(`dsh-chatops: inbound handling failed: ${error?.message ?? error}`));
	};
	for (const kind of kinds) if (kind === "ilink") {
		ilinkChannel = new ILinkChannel(config, {
			onMessage,
			onLogin: (userName) => {
				auth.audit("bot/login", {
					userName,
					channel: "ilink"
				});
				const owner = ilinkChannel.store.data.ownerUserId;
				if (owner) {
					auth.addOwner(owner);
					ilinkChannel.say(`user:${owner}`, "🤖 dsh-chatops 已上线。回复 /help 查看指令。");
				}
			},
			onLogout: (reason) => auth.audit("bot/logout", {
				reason,
				channel: "ilink"
			}),
			onScan: () => logger.info("dsh-chatops: 微信机器人待扫码绑定，打开 /wechat/qr 页面扫码")
		}, logger, credentials);
		manager.register(["user:"], ilinkChannel);
		channelsByKind.set("ilink", ilinkChannel);
		if (ilinkChannel.store.data.ownerUserId) auth.addOwner(ilinkChannel.store.data.ownerUserId);
	} else if (kind === "wechaty") {
		const wechaty = new WechatChannel(config, {
			onMessage,
			onLogin: (userName) => {
				auth.audit("bot/login", {
					userName,
					channel: "wechaty"
				});
				if (config.security?.listenFilehelper !== false) wechaty.say("filehelper", "🤖 dsh-chatops 已上线。回复 /help 查看指令。");
			},
			onLogout: (reason) => auth.audit("bot/logout", {
				reason,
				channel: "wechaty"
			}),
			onScan: (qrcode) => void renderScanQr(qrcode, logger)
		}, logger);
		manager.register([
			"contact:",
			"room:",
			"filehelper",
			"self"
		], wechaty);
		channelsByKind.set("wechaty", wechaty);
	} else if (kind === "feishu") {
		const feishu = new FeishuChannel(config, {
			onMessage,
			onLogin: () => {},
			onLogout: () => {},
			onScan: () => {},
			onCardAction: async (action) => {
				return bridge.decideApprovalById(action.approvalId, action.outcome, action.operatorOpenId);
			}
		}, logger);
		manager.register(["fsu:", "fsc:"], feishu);
		channelsByKind.set("feishu", feishu);
	} else if (kind === "dingtalk") {
		const dingtalk = new DingTalkChannel(config, {
			onMessage,
			onLogin: () => {},
			onLogout: () => {},
			onScan: () => {}
		}, logger);
		manager.register(["dsu:", "dsc:"], dingtalk);
		channelsByKind.set("dingtalk", dingtalk);
	} else if (kind === "wecom") {
		const wecom = new WecomChannel(config, {
			onMessage,
			onLogin: () => {},
			onLogout: () => {},
			onScan: () => {}
		}, logger);
		manager.register(["wsu:", "wsc:"], wecom);
		channelsByKind.set("wecom", wecom);
	} else logger.warn(`dsh-chatops: unknown channel "${kind}", skipped`);
	const bridge = new SessionBridge(ctx, config, manager, auth, logger);
	bridge.start();
	ctx.tools.register(defineTool({
		name: "im_send_file",
		description: "Send a file from the current session workspace to the IM windows (WeChat/Feishu) bound to this session. Use when the user asks to receive a generated file (report, chart, csv, image) in their IM. The path must be inside the session workspace. Images (jpg/png/webp/gif) render inline; other files arrive as file cards.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Workspace-relative file path, e.g. reports/weekly.md."
			},
			caption: {
				type: "string",
				description: "Optional short message sent alongside the file."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: String(value)
			}]
		},
		async execute(args, exec) {
			const sessionId = exec?.agent?.session?.id;
			if (!sessionId) return "无法确定当前会话，文件未发送。";
			return bridge.sendFileForSession(sessionId, String(args?.path ?? ""), args?.caption);
		}
	}));
	ctx.effect(() => {
		for (const channel of manager.all()) channel.start().catch((error) => logger.warn(`dsh-chatops: channel start failed: ${error?.message ?? error}`));
		return () => {
			for (const channel of manager.all()) channel.stop();
		};
	});
	ctx.inject?.(["webServer"], (webCtx) => {
		webCtx.effect(() => {
			const disposers = ["/chatops", "/wechat"].map((prefix) => webCtx.webServer.register({
				kind: "prefix",
				path: prefix,
				handler: async (req, res) => {
					try {
						const remote = req.socket?.remoteAddress ?? "";
						const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
						const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname.replace(/^\/wechat(?=\/|$)/, "/chatops");
						if (!loopback) {
							writeJson(res, 403, { ok: false });
							return;
						}
						if (pathname === "/chatops/qr" && req.method === "GET") {
							res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
							res.end(QR_PAGE_HTML);
							return;
						}
						if (pathname === "/chatops/api/status" && req.method === "GET") {
							const result = {
								kinds,
								channels: {}
							};
							for (const [kind, channel] of channelsByKind) result.channels[kind] = channel.statusSnapshot?.() ?? { online: channel.online };
							if (ilinkChannel) {
								Object.assign(result, ilinkChannel.statusSnapshot());
								if (result.qrUrl) result.qrDataUrl = await qrDataUrl(result.qrUrl);
							}
							writeJson(res, 200, {
								ok: true,
								result
							});
							return;
						}
						if (pathname === "/chatops/api/verify" && req.method === "POST") {
							const body = await readBody(req);
							const code = String(JSON.parse(body || "{}")?.code ?? "").trim();
							if (ilinkChannel && code) {
								ilinkChannel.submitVerifyCode(code);
								writeJson(res, 200, { ok: true });
							} else writeJson(res, 400, { ok: false });
							return;
						}
						if (pathname === "/chatops/api/config" && req.method === "GET") {
							writeJson(res, 200, {
								ok: true,
								result: config
							});
							return;
						}
						if (pathname === "/chatops/api/config" && req.method === "POST") {
							const body = await readBody(req);
							const next = JSON.parse(body || "{}")?.config;
							if (!next || typeof next !== "object") {
								writeJson(res, 400, {
									ok: false,
									error: "config object required"
								});
								return;
							}
							saveProfileOverride(config, next, logger);
							writeJson(res, 200, {
								ok: true,
								result: { hotReload: true }
							});
							return;
						}
						if (pathname === "/chatops/api/rebind" && req.method === "POST") {
							if (ilinkChannel) {
								await ilinkChannel.unbind();
								await ilinkChannel.start();
							}
							writeJson(res, 200, { ok: true });
							return;
						}
						writeJson(res, 404, { ok: false });
					} catch (error) {
						try {
							if (!res.headersSent) writeJson(res, 400, {
								ok: false,
								error: error?.message ?? String(error)
							});
							else res.end();
						} catch {}
					}
				}
			}, "dsh-chatops: im routes"));
			return () => disposers.forEach((d) => typeof d === "function" ? d() : d?.dispose?.());
		});
		logger.info("dsh-chatops: QR binding page mounted at /chatops/qr (legacy /wechat/qr alias kept)");
	});
	logger.info(`dsh-chatops: loaded (channels=${kinds.join(",")})`);
}
/**
* Rename migration from the dsh-wechat era: move the old storage dir
* (login token, bindings, owners, audit) under the new name, and rename the
* wechaty memory-card file to match the new bot name. One-shot, best-effort.
*/
function migrateStorage(newDir, logger) {
	try {
		const oldDir = newDir.replace(/dsh-chatops$/, "dsh-wechat");
		if (oldDir === newDir || !existsSync(oldDir)) return;
		if (!existsSync(newDir)) {
			renameSync(oldDir, newDir);
			logger.info("dsh-chatops: migrated storage from storages/dsh-wechat");
		}
		const oldCard = join(newDir, "dsh-wechat.memory-card.json");
		const newCard = join(newDir, "dsh-chatops.memory-card.json");
		if (existsSync(oldCard) && !existsSync(newCard)) renameSync(oldCard, newCard);
	} catch (error) {
		logger.warn(`dsh-chatops: storage migration failed: ${error?.message ?? error}`);
	}
}
/**
* Persist the full plugin config as a profile override row (id dsh-chatops)
* in the profile's cordis.patch.yml. Patch semantics replace the row's whole
* config, so we always write the COMPLETE merged config. Cordis watches the
* file and hot-reloads the composition — no restart needed in normal cases.
*/
function saveProfileOverride(current, next, logger) {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const patchPath = typeof current.profilePatch === "string" && current.profilePatch || join(dshHome, "profiles", "web", "cordis.patch.yml");
	const merged = {
		...current,
		...next
	};
	let rows = [];
	if (existsSync(patchPath)) try {
		const parsed = yaml.load(readFileSync(patchPath, "utf8"));
		if (Array.isArray(parsed)) rows = parsed;
	} catch (error) {
		logger.warn(`dsh-chatops: profile patch parse failed: ${error?.message ?? error}`);
	}
	const index = rows.findIndex((r) => r && typeof r === "object" && r.id === "dsh-chatops" && !r.insert);
	const row = {
		id: "dsh-chatops",
		name: "dsh-chatops",
		config: merged
	};
	if (index >= 0) rows[index] = row;
	else rows.push(row);
	writeFileSync(patchPath, yaml.dump(rows, {
		noRefs: true,
		lineWidth: 120
	}), "utf8");
	logger.info(`dsh-chatops: config saved to ${patchPath} (cordis hot-reloads the composition)`);
}
function writeJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 65536) reject(/* @__PURE__ */ new Error("body too large"));
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}
/** Self-contained binding page: polls /wechat/api/status and renders the QR. */
const QR_PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-chatops 扫码绑定</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222}
 .card{border:1px solid #e5e5e5;border-radius:12px;padding:24px;text-align:center}
 #qr{max-width:280px;width:100%;border-radius:8px}
 .state{font-size:15px;margin:12px 0}
 .ok{color:#07c160}.warn{color:#fa9d3b}.err{color:#e6432d}
 input{padding:8px;font-size:16px;width:140px}button{padding:8px 16px;font-size:15px}
 .muted{color:#888;font-size:13px}
</style></head><body>
<div class="card">
 <h2>🤖 dsh-chatops</h2>
 <div id="state" class="state muted">加载中…</div>
 <img id="qr" style="display:none" alt="微信扫码绑定">
 <div id="verify" style="display:none;margin-top:12px">
   <p class="muted">微信要求短信验证码：</p>
   <input id="code" placeholder="验证码" inputmode="numeric">
   <button onclick="submitCode()">提交</button>
 </div>
 <p class="muted" id="hint" style="display:none">用微信扫描上方二维码，确认后机器人会出现在你的聊天列表</p>
 <p class="muted" style="display:none;word-break:break-all" ><a id="link" target="_blank" rel="noopener"></a></p>
</div>
<script>
const stateEl=document.getElementById('state'),qrEl=document.getElementById('qr'),
      verifyEl=document.getElementById('verify'),hintEl=document.getElementById('hint'),
      linkEl=document.getElementById('link');
const LABELS={idle:'未连接',await_scan:'请用微信扫码',scanned:'已扫码，请在手机上确认',
 need_verifycode:'需要短信验证码',connecting:'连接中…',connected:'✅ 已连接，回到微信和机器人聊天即可',error:'连接出错'};
async function tick(){
 try{
  const r=await fetch('/chatops/api/status');const j=await r.json();const s=j.result||{};
  stateEl.textContent=LABELS[s.state]||s.state||'未知状态';
  stateEl.className='state '+(s.state==='connected'?'ok':s.state==='error'?'err':'warn');
  const showQr=s.state==='await_scan'&&s.qrDataUrl;
  qrEl.style.display=showQr?'block':'none'; if(showQr&&qrEl.src!==s.qrDataUrl)qrEl.src=s.qrDataUrl;
  hintEl.style.display=showQr?'block':'none';
  linkEl.style.display=(s.state==='await_scan'&&!s.qrDataUrl&&s.qrUrl)?'block':'none';
  if(linkEl.style.display==='block'){linkEl.href=s.qrUrl;linkEl.textContent=s.qrUrl;}
  verifyEl.style.display=s.state==='need_verifycode'?'block':'none';
  if(s.lastError&&s.state==='error')stateEl.textContent+='：'+s.lastError;
 }catch(e){stateEl.textContent='状态查询失败';stateEl.className='state err'}
}
async function submitCode(){
 const code=document.getElementById('code').value.trim();if(!code)return;
 await fetch('/chatops/api/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
 document.getElementById('code').value='';tick();
}
tick();setInterval(tick,2000);
<\/script></body></html>`;

//#endregion
export { Config, apply, inject, name };