import TableRow from "@tiptap/extension-table-row";

export const TableRowPlus = TableRow.extend({
    addAttributes() {
        return {
            ...this.parent?.(),

            textAlign: {
                default: null,
                parseHTML: (el) =>
                    el.style.textAlign ||
                    el.getAttribute("data-align") ||
                    el.getAttribute("align") ||
                    null,
                renderHTML: (attrs) => {
                    if (!attrs.textAlign) return {};
                    return { style: `text-align:${attrs.textAlign}`, "data-align": attrs.textAlign };
                },
            },

            rmRowId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-rm-row-id") || null,
                renderHTML: (attrs) => (attrs.rmRowId ? { "data-rm-row-id": attrs.rmRowId } : {}),
            },

            rmLinkedTo: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-rm-linked-to") || null,
                renderHTML: (attrs) => (attrs.rmLinkedTo ? { "data-rm-linked-to": attrs.rmLinkedTo } : {}),
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
                const align = n.attrs.textAlign;
                if (align) {
                    dom.style.textAlign = align;
                    dom.dataset.align = align;
                } else {
                    dom.style.textAlign = "";
                    delete dom.dataset.align;
                }

                if (n.attrs.rmRowId) dom.dataset.rmRowId = n.attrs.rmRowId;
                else delete dom.dataset.rmRowId;

                if (n.attrs.rmLinkedTo) dom.dataset.rmLinkedTo = n.attrs.rmLinkedTo;
                else delete dom.dataset.rmLinkedTo;
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
