import TableHeader from "@tiptap/extension-table-header";
import { mergeAttributes } from "@tiptap/core";

type HideMode = "none" | "hidden" | null;

export const TableHeaderPlus = TableHeader.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            backgroundColor: {
                default: null,
                parseHTML: (element: HTMLElement) =>
                    element.getAttribute("data-header-bg") ||
                    element.style.backgroundColor ||
                    null,
                renderHTML: (attrs: { backgroundColor?: string | null }) => {
                    if (!attrs.backgroundColor) return {};
                    return {
                        "data-header-bg": attrs.backgroundColor,
                        style: `background-color:${attrs.backgroundColor}`,
                    };
                },
            },
            borderColor: {
                default: null,
                parseHTML: (element: HTMLElement) =>
                    element.getAttribute("data-header-border") ||
                    null,
                renderHTML: (attrs: { borderColor?: string | null }) => {
                    if (!attrs.borderColor) return {};
                    return {
                        "data-header-border": attrs.borderColor,
                        style: `border-color:${attrs.borderColor}`,
                    };
                },
            },
            // ✅ ADD MERGE ATTRIBUTES
            rmCellId: { default: null },
            rmMergeOrigin: { default: false },
            rmMergedTo: { default: null },
            rmHideMode: { default: null as HideMode },
            rmColspan: { default: 1 },
            rmRowspan: { default: 1 },
        };
    },
    addNodeView() {
        return ({ node }) => {
            const borderColor =
                (node.attrs.borderColor as string) ||
                "var(--table-border-color, black)";
            const dom = document.createElement('th');
            dom.style.border = `1px solid ${borderColor}`;

            // ✅ ADD CONTENT WRAPPER (same as TableCellPlus)
            const content = document.createElement("div");
            content.style.paddingInline = '16px';
            dom.appendChild(content);

            const apply = (n: typeof node) => {
                // Apply background
                const bg = n.attrs.backgroundColor;
                dom.style.backgroundColor = bg || "var(--color-secondary, #f5f5f5)";
                if (bg) {
                    dom.setAttribute("data-header-bg", bg);
                } else {
                    dom.removeAttribute("data-header-bg");
                }

                // ✅ RESET STYLES (same as TableCellPlus)
                dom.style.display = "";
                dom.style.visibility = "";
                dom.style.pointerEvents = "";
                dom.style.position = "";
                dom.style.zIndex = "";
                dom.style.overflow = "";
                dom.style.maxHeight = "";
                content.className = "";

                content.style.position = "";
                content.style.inset = "";
                content.style.width = "";
                content.style.height = "";
                content.style.minHeight = "";
                content.style.zIndex = "";
                content.style.pointerEvents = "";

                // ✅ COLSPAN (visual)
                const vCol = Math.max(1, Number(n.attrs.rmColspan ?? n.attrs.colspan ?? 1));
                dom.style.gridColumn = `auto / span ${vCol}`;
                dom.setAttribute("colspan", String(vCol));

                // ✅ DATA ATTRS FOR MERGE SYSTEM
                if (n.attrs.rmCellId) dom.setAttribute("data-rm-cell-id", String(n.attrs.rmCellId));
                else dom.removeAttribute("data-rm-cell-id");

                if (n.attrs.rmMergeOrigin) dom.setAttribute("data-rm-merge-origin", "true");
                else dom.removeAttribute("data-rm-merge-origin");

                if (n.attrs.rmMergedTo) dom.setAttribute("data-rm-merged-to", String(n.attrs.rmMergedTo));
                else dom.removeAttribute("data-rm-merged-to");

                const vRow = Math.max(1, Number(n.attrs.rmRowspan ?? n.attrs.rowspan ?? 1));
                if (vRow > 1) dom.setAttribute("data-rm-rowspan", String(vRow));
                else dom.removeAttribute("data-rm-rowspan");

                // ✅ COVERED CELLS
                const hideMode = (n.attrs.rmHideMode ?? null) as HideMode;
                if (n.attrs.rmMergedTo) {
                    dom.style.pointerEvents = "none";

                    if (hideMode === "none") {
                        dom.style.display = "none";
                    } else if (hideMode === "hidden") {
                        dom.style.visibility = "hidden";
                    }
                }

                // ✅ MERGE ORIGIN STYLING
                if (n.attrs.rmMergeOrigin && vRow > 1) {
                    dom.style.position = "relative";
                    dom.style.zIndex = "2";
                    dom.style.overflow = "visible";
                    dom.style.maxHeight = "none";
                    dom.style.borderColor = "transparent";
                    // Keep background for headers
                    content.style.position = "absolute";
                    content.style.inset = "0";
                    content.style.width = "var(--rm-merge-w, 100%)";
                    content.style.height = "var(--rm-merge-h, 100%)";
                    content.style.minHeight = "var(--rm-merge-h, 100%)";
                    content.style.zIndex = "3";
                    content.className = "rm-cell-content";
                    content.style.pointerEvents = "auto";
                    content.style.backgroundColor = bg || "var(--color-secondary, #f5f5f5)";
                }
            };

            apply(node);

            return {
                dom,
                contentDOM: content,
                update(updatedNode) {
                    if (updatedNode.type.name !== 'tableHeader') {
                        return false;
                    }
                    apply(updatedNode);
                    return true;
                },
            };
        };
    },
    renderHTML({ HTMLAttributes }) {
        const existingStyle = HTMLAttributes.style || "";
        const backgroundColor = HTMLAttributes['data-header-bg'] || null;
        const baseBg = backgroundColor
            ? `background-color: ${backgroundColor}`
            : "background-color: var(--color-secondary, #f5f5f5)";
        const mergedStyle = existingStyle
            ? `${baseBg}; ${existingStyle}`
            : baseBg;

        return [
            "th",
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                style: mergedStyle,
            }),
            0,
        ];
    },
});

export default TableHeaderPlus;
