import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Slice } from "@tiptap/pm/model";
import { __pastedCells, __insertCells, isInTable, selectionCell, TableMap } from "prosemirror-tables";

/**
 * prosemirror-tables' default paste lays a copied cell block out toward
 * increasing column indices and appends new columns once it runs past the
 * table's end — which reads as "adds new cells" in RTL, where the last column
 * is the visually-left cell. Clamp the paste origin so the block maps onto
 * existing cells whenever the table is large enough, growing only when the
 * block is genuinely bigger than the table.
 */
export const TableCellPasteMap = new Plugin({
    key: new PluginKey("tablePlusCellPasteMap"),
    props: {
        handlePaste: (view: EditorView, _event: ClipboardEvent, slice: Slice) => {
            const { state } = view;
            if (!isInTable(state)) return false;

            const cells = __pastedCells(slice);
            if (!cells) return false;

            // Duck-typed range check (avoids instanceof across a duplicated prosemirror-tables).
            const sel = state.selection as { $anchorCell?: unknown; $headCell?: unknown };
            if (sel.$anchorCell && sel.$headCell) return false;

            const $cell = selectionCell(state);
            const tableStart = $cell.start(-1);
            const map = TableMap.get($cell.node(-1));
            const target = map.findCell($cell.pos - tableStart);

            const left = Math.min(target.left, Math.max(0, map.width - cells.width));
            const top = Math.min(target.top, Math.max(0, map.height - cells.height));

            __insertCells(
                state,
                view.dispatch,
                tableStart,
                { left, top, right: left + cells.width, bottom: top + cells.height },
                cells,
            );

            return true;
        },
    },
});

export default TableCellPasteMap;
