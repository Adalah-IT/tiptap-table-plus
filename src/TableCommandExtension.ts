import { Extension, findParentNode } from '@tiptap/core';
import duplicateColumn from "./commands/duplicateColumn";
import duplicateRow from "./commands/duplicateRow";

export const TableCommandExtension = Extension.create({
  name: "tableCommandExtension",

  addCommands() {
    return {
      duplicateColumn:
        (withContent = true) =>
        ({ state, dispatch }) => {
          duplicateColumn(state, dispatch, withContent);
          return true;
        },
      duplicateRow:
        (withContent = true) =>
        ({ state, dispatch }) => {
          duplicateRow(state, dispatch, withContent);
          return true;
        },
        setTableAlign:
            (align: 'left' | 'center' | 'right' | 'start' | 'end' | 'justify') =>
                ({ state, dispatch }) => {
                    const table = findParentNode(n => n.type.name === 'table')(state.selection);
                    if (!table) return false;

                    const tr = state.tr;
                    let changed = false;

                    table.node.descendants((node, pos) => {
                        if (node.type.name === 'tableRow') {
                            changed = true;
                            tr.setNodeMarkup(table.pos + 1 + pos, undefined, {
                                ...node.attrs,
                                textAlign: align,
                            });
                        }
                    });

                    if (changed && dispatch) dispatch(tr);
                    return changed;
                },

        unsetTableAlign:
            () =>
                ({ state, dispatch }) => {
                    const table = findParentNode(n => n.type.name === 'table')(state.selection);
                    if (!table) return false;

                    const tr = state.tr;
                    let changed = false;

                    table.node.descendants((node, pos) => {
                        if (node.type.name === 'tableRow' && node.attrs?.textAlign) {
                            changed = true;
                            const { textAlign, ...rest } = node.attrs;
                            tr.setNodeMarkup(table.pos + 1 + pos, undefined, rest);
                        }
                    });

                    if (changed && dispatch) dispatch(tr);
                    return changed;
                },
    };
  },
});
export default TableCommandExtension;
