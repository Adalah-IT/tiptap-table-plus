import TableRow from "@tiptap/extension-table-row";

export const TableRowPlus = TableRow.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            textAlign: {
                default: null,
                parseHTML: el =>
                    el.style.textAlign ||
                    el.getAttribute('data-align') ||
                    el.getAttribute('align') ||
                    null,
                renderHTML: attrs => {
                    if (!attrs.textAlign) return {};
                    return { style: `text-align:${attrs.textAlign}`, 'data-align': attrs.textAlign };
                },
            },
        };
    },

    addNodeView() {
        return ({ node }) => {
            const dom = document.createElement('tr');
            dom.style.display = 'grid';
            dom.style.gridTemplateColumns = `var(--cell-percentage)`;
            dom.style.position = "relative";

            const applyAlign = (n: typeof node) => {
                const align = n.attrs.textAlign;
                if (align) {
                    dom.style.textAlign = align;
                    dom.dataset.align = align;
                } else {
                    dom.style.textAlign = '';
                    delete dom.dataset.align;
                }
            };

            applyAlign(node);

            return {
                dom,
                contentDOM: dom,
                update(updatedNode) {
                    if (updatedNode.type.name !== 'tableRow') return false;
                    applyAlign(updatedNode);
                    return true;
                },
            };
        };
    },
});

export default TableRowPlus;
