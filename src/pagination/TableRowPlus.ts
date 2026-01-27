import TableRow from "@tiptap/extension-table-row";

export const TableRowPlus = TableRow.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            rmRowId: { default: null as string | null },
            rmLinkedPrev: { default: null as string | null },
            rmLinkedNext: { default: null as string | null },

            textAlign: {
                default: null,
                parseHTML: (el) =>
                    el.style.textAlign ||
                    el.getAttribute("data-align") ||
                    el.getAttribute("align") ||
                    null,
                renderHTML: (attrs) => {
                    if (!attrs.textAlign) return {};
                    return {
                        style: `text-align:${attrs.textAlign}`,
                        "data-align": attrs.textAlign,
                    };
                },
            },
        };
    },

    addNodeView() {
        return ({ node }) => {
            const dom = document.createElement("tr");
            dom.style.display = "grid";
            dom.style.gridTemplateColumns = `var(--cell-percentage)`;
            dom.style.position = "relative";

            const apply = (n: typeof node) => {
                // align
                const align = n.attrs.textAlign;
                if (align) {
                    dom.style.textAlign = align;
                    dom.dataset.align = align;
                } else {
                    dom.style.textAlign = "";
                    delete dom.dataset.align;
                }

                if (n.attrs.rmRowId) dom.dataset.rmRowId = String(n.attrs.rmRowId);
                else delete dom.dataset.rmRowId;

                if (n.attrs.rmLinkedPrev) dom.dataset.rmLinkedPrev = String(n.attrs.rmLinkedPrev);
                else delete dom.dataset.rmLinkedPrev;

                if (n.attrs.rmLinkedNext) dom.dataset.rmLinkedNext = String(n.attrs.rmLinkedNext);
                else delete dom.dataset.rmLinkedNext;
            };

            apply(node);

            return {
                dom,
                contentDOM: dom,
                update(updatedNode) {
                    if (updatedNode.type.name !== "tableRow") return false;
                    apply(updatedNode);
                    return true;
                },
            };
        };
    },
});

export default TableRowPlus;
