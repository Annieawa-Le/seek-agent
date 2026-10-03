const factory = (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0dsh-css:/Users/zcl/code/dsh-web-ui/packages/skins/ths/src/client/ths.module.css.mjs
		const css = ""; /* 样式已抽出到 skin.css */
		const tagId = "@linxin666/dsh-client-ui-skin-ths/ths.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@linxin666/dsh-client-ui-skin-ths";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ths_module_css_default = {
			"aionPreviewIn": "ipHsWW_aionPreviewIn",
			"thsStatusbar": "ipHsWW_thsStatusbar",
			"thsStatusbarCell": "ipHsWW_thsStatusbarCell",
			"thsStatusbarSpacer": "ipHsWW_thsStatusbarSpacer",
			"thsTitlebar": "ipHsWW_thsTitlebar",
			"thsTitlebarBtn": "ipHsWW_thsTitlebarBtn",
			"thsTitlebarIcon": "ipHsWW_thsTitlebarIcon",
			"thsTitlebarTicker": "ipHsWW_thsTitlebarTicker",
			"thsTitlebarTickerChg": "ipHsWW_thsTitlebarTickerChg",
			"thsTitlebarTickerVal": "ipHsWW_thsTitlebarTickerVal",
			"thsTitlebarTitle": "ipHsWW_thsTitlebarTitle"
		};
		//#endregion
		//#region src/client/index.ts
		/** The product title the skin pins (captured by the shell's DocumentTitle after settle). */
		const SKIN_TITLE = "同花顺 · DeepSeek 在线";
		/** Refresh cadence of the code-workload index cell. */
		const CODE_INDEX_REFRESH_MS = 3e4;
		/** Status bar cells; the spacer cell splits the quote group from the status group. */
		const STOCK_CELLS = [
			{
				text: "同花顺",
				trend: "brand"
			},
			{
				text: "上证指数 3,342.17 ▲0.42%",
				trend: "up"
			},
			{
				text: "深证成指 10,846.59 ▲0.87%",
				trend: "up"
			},
			{
				text: "创业板指 2,201.33 ▼0.21%",
				trend: "down"
			},
			{
				text: "就绪",
				trend: "none"
			},
			{
				text: "已连接",
				trend: "none"
			},
			{
				text: "在线",
				trend: "none"
			}
		];
		/** Title bar window buttons (decorative glyphs, aria-hidden). */
		const TITLEBAR_GLYPHS = [
			"–",
			"□",
			"×"
		];
		/** Live-quote chip shown in the title bar before the window buttons. */
		const TICKER = {
			name: "上证指数",
			value: "3,342.17",
			change: "▲0.42%",
			trend: "up"
		};
		/**
		* Resolve one module class name. The css-modules record types as
		* `string | undefined` under noUncheckedIndexedAccess; every key used here
		* is a literal name in this package's own stylesheet, so the fallback is
		* unreachable in practice and only satisfies the indexed-access type.
		*/
		const cls = (name) => ths_module_css_default[name] ?? "";
		/** White candlestick mark, inline so the skin carries no static assets. */
		const CANDLE_SVG = [
			"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 48 48\" aria-hidden=\"true\">",
			"<rect x=\"6\" y=\"14\" width=\"8\" height=\"20\" fill=\"#fff\"/>",
			"<rect x=\"9\" y=\"6\" width=\"2\" height=\"36\" fill=\"#fff\"/>",
			"<rect x=\"17\" y=\"20\" width=\"8\" height=\"18\" fill=\"#fff\"/>",
			"<rect x=\"20\" y=\"12\" width=\"2\" height=\"34\" fill=\"#fff\"/>",
			"<rect x=\"28\" y=\"10\" width=\"8\" height=\"16\" fill=\"#fff\"/>",
			"<rect x=\"31\" y=\"4\" width=\"2\" height=\"28\" fill=\"#fff\"/>",
			"</svg>"
		].join("");
		/** Brand-red square favicon carrying the 同 glyph, inline data URI. */
		const FAVICON_SVG = [
			"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" viewBox=\"0 0 64 64\">",
			"<rect x=\"2\" y=\"2\" width=\"60\" height=\"60\" rx=\"12\" fill=\"#e60012\"/>",
			"<text x=\"32\" y=\"45\" font-size=\"36\" font-family=\"PingFang SC, Microsoft YaHei, sans-serif\" fill=\"#fff\" text-anchor=\"middle\">同</text>",
			"</svg>"
		].join("");
		/**
		* Apply the stock-trading skin: body attribute, chrome bars, title, favicon.
		* All writes are retracted by the effect disposer on dispose.
		* @param ctx - owning context (the effect lifecycle owns retraction).
		*/
		function apply(ctx) {
			const body = document.body;
			const originalTitle = document.title;
			body.dataset.dshThs = "";
			const titlebar = document.createElement("div");
			titlebar.className = cls("thsTitlebar");
			titlebar.dataset.skinChrome = "titlebar";
			const icon = document.createElement("span");
			icon.className = cls("thsTitlebarIcon");
			icon.innerHTML = CANDLE_SVG;
			const title = document.createElement("span");
			title.className = cls("thsTitlebarTitle");
			title.textContent = SKIN_TITLE;
			titlebar.append(icon, title);
			const ticker = document.createElement("span");
			ticker.className = cls("thsTitlebarTicker");
			const tickerName = document.createElement("span");
			tickerName.textContent = TICKER.name;
			const tickerValue = document.createElement("span");
			tickerValue.className = cls("thsTitlebarTickerVal");
			tickerValue.textContent = TICKER.value;
			const tickerChange = document.createElement("span");
			tickerChange.className = cls("thsTitlebarTickerChg");
			tickerChange.dataset.trend = TICKER.trend;
			tickerChange.textContent = TICKER.change;
			ticker.append(tickerName, tickerValue, tickerChange);
			titlebar.append(ticker);
			for (const glyph of TITLEBAR_GLYPHS) {
				const btn = document.createElement("span");
				btn.className = cls("thsTitlebarBtn");
				btn.setAttribute("aria-hidden", "true");
				btn.textContent = glyph;
				titlebar.append(btn);
			}
			const statusbar = document.createElement("div");
			statusbar.className = cls("thsStatusbar");
			statusbar.dataset.skinChrome = "statusbar";
			const spacer = document.createElement("span");
			spacer.className = cls("thsStatusbarSpacer");
			statusbar.append(spacer);
			for (const cell of STOCK_CELLS) {
				const el = document.createElement("span");
				el.className = cls("thsStatusbarCell");
				el.textContent = cell.text;
				if (cell.trend !== "none") el.dataset.trend = cell.trend;
				statusbar.append(el);
			}
			const codeIndexCell = document.createElement("span");
			codeIndexCell.className = cls("thsStatusbarCell");
			codeIndexCell.textContent = "代码指数 --";
			statusbar.append(codeIndexCell);
			const favicon = document.createElement("link");
			favicon.rel = "icon";
			favicon.href = `data:image/svg+xml;utf8,${encodeURIComponent(FAVICON_SVG)}`;
			document.head.append(favicon);
			document.title = SKIN_TITLE;
			body.append(titlebar, statusbar);
			const workspaces = ctx.get("workspaces");
			const refreshCodeIndex = () => {
				if (workspaces === void 0) return;
				(async () => {
					try {
						// 内核 0.1.2：connection.api 门面已随 typert RPC 换血移除，工作区
						// 清单改读 workspaces 服务快照；codeKline RPC 现内核不存在，
						// 缺失时保持无数据（不显示假的 0 行）。
						const items = workspaces.list.getSnapshot().items;
						const codeKline = ctx.get("connection")?.api?.codeKline;
						if (typeof codeKline?.list !== "function") return;
						let net = 0;
						for (const workspace of items) {
							const response = await codeKline.list({
								workspaceId: workspace.workspaceId,
								days: 1
							});
							if (!response.result.ok) continue;
							const candles = response.result.value.candles;
							const last = candles[candles.length - 1];
							if (last === void 0) continue;
							net += last.close - last.open;
						}
						const trend = net > 0 ? "up" : net < 0 ? "down" : "none";
						codeIndexCell.textContent = `代码指数 ${net > 0 ? "+" : ""}${net} 行`;
						if (trend !== "none") codeIndexCell.dataset.trend = trend;
						else delete codeIndexCell.dataset.trend;
					} catch {
						codeIndexCell.textContent = "代码指数 --";
					}
				})();
			};
			refreshCodeIndex();
			const refreshTimer = setInterval(refreshCodeIndex, CODE_INDEX_REFRESH_MS);
			ctx.effect(() => () => {
				clearInterval(refreshTimer);
				delete body.dataset.dshThs;
				titlebar.remove();
				statusbar.remove();
				favicon.remove();
				if (document.title === SKIN_TITLE) document.title = originalTitle;
			}, "ui-skin-ths: quote chrome");
		}
		//#endregion
		exports.apply = apply;
		return module.exports;
	};


// ── dsh-theme 适配层 ─────────────────────────────────────────────
// 上游包是 DSH 的 window.__ModuleLoader__ bundle；这里把 factory 跑一遍取它的
// exports.apply —— 皮肤脚本本身一行未改（上面整段 factory 即上游原文）。
const __skinExports = factory(() => {
	throw new Error('皮肤包无外部依赖，require 不应被调用');
});
export const apply = __skinExports.apply;
export const inject = __skinExports.inject;
export default apply;
