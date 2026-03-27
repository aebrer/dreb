import type { ExtensionAPI, ExtensionContext } from "@dreb/coding-agent";

const applyWidgets = (ctx: ExtensionContext) => {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("widget-above", ["Above editor widget"]);
	ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
};

export default function widgetPlacementExtension(dreb: ExtensionAPI) {
	dreb.on("session_start", (_event, ctx) => {
		applyWidgets(ctx);
	});

	dreb.on("session_switch", (_event, ctx) => {
		applyWidgets(ctx);
	});
}
