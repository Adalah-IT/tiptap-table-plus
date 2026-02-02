import TableCell from "@tiptap/extension-table-cell";

type HideMode = "none" | "hidden" | null;

export const TableCellPlus = TableCell.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
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
            const dom = document.createElement("td");
            dom.style.border = `1px solid var(--table-border-color, black)`;

            const content = document.createElement("div");
            content.style.paddingInline = '16px'
            dom.appendChild(content);

            const apply = (n: any) => {
                // reset
                dom.style.display = "";
                dom.style.visibility = "";
                dom.style.pointerEvents = "";
                dom.style.position = "";
                dom.style.zIndex = "";
                dom.style.overflow = "";
                dom.style.maxHeight = "";
                dom.style.borderColor = "var(--table-border-color, black)";
                dom.style.backgroundColor = "";

                content.style.position = "";
                content.style.inset = "";
                content.style.width = "";
                content.style.height = "";
                content.style.minHeight = "";
                content.style.zIndex = "";
                content.className = "";
                content.style.pointerEvents = "";

                // colspan (visual)
                const vCol = Math.max(1, Number(n.attrs.rmColspan ?? 1));
                dom.style.gridColumn = `auto / span ${vCol}`;
                dom.setAttribute("colspan", String(vCol));

                // data attrs
                if (n.attrs.rmCellId) dom.setAttribute("data-rm-cell-id", String(n.attrs.rmCellId));
                else dom.removeAttribute("data-rm-cell-id");

                if (n.attrs.rmMergeOrigin) dom.setAttribute("data-rm-merge-origin", "true");
                else dom.removeAttribute("data-rm-merge-origin");

                if (n.attrs.rmMergedTo) dom.setAttribute("data-rm-merged-to", String(n.attrs.rmMergedTo));
                else dom.removeAttribute("data-rm-merged-to");

                const vRow = Math.max(1, Number(n.attrs.rmRowspan ?? 1));
                if (vRow > 1) dom.setAttribute("data-rm-rowspan", String(vRow));
                else dom.removeAttribute("data-rm-rowspan");

                // covered cells
                const hideMode = (n.attrs.rmHideMode ?? null) as HideMode;
                if (n.attrs.rmMergedTo) {
                    dom.style.pointerEvents = "none";

                    if (hideMode === "none") {
                        dom.style.display = "none";      // top row covered => remove from grid
                    } else if (hideMode === "hidden") {
                        dom.style.visibility = "hidden"; // lower rows => keep slot
                    }
                }

                if (n.attrs.rmMergeOrigin && vRow > 1) {
                    dom.style.position = "relative";
                    dom.style.zIndex = "2";
                    dom.style.overflow = "visible";
                    dom.style.maxHeight = "none";
                    dom.style.borderColor = "transparent";
                    dom.style.backgroundColor = "transparent";
                    content.style.position = "absolute";
                    content.style.inset = "0";
                    content.className = "rm-cell-content";
                    content.style.width = "var(--rm-merge-w, 100%)";
                    content.style.height = "var(--rm-merge-h, 100%)";
                    content.style.minHeight = "var(--rm-merge-h, 100%)";
                    content.style.zIndex = "3";
                    content.style.pointerEvents = "auto";
                }
            };

            apply(node);

            return {
                dom,
                contentDOM: content,
                update(updatedNode) {
                    if (updatedNode.type.name !== "tableCell") return false;
                    apply(updatedNode);
                    return true;
                },
            };
        };
    },
});

export default TableCellPlus;
