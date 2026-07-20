import { EditorState, Transaction } from "@tiptap/pm/state";
import { setCellAttr } from "@tiptap/pm/tables";

/**
 * Sets (or clears, when passed null) the `backgroundColor` attribute on the
 * currently selected table cell(s). Works for both a single cell at the cursor
 * and a multi-cell CellSelection. Mirrors setHeaderBackground, but targets the
 * selection rather than every header in the table.
 */
const setCellBackground = (
  color: string | null
) => ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
  return setCellAttr("backgroundColor", color)(state, dispatch);
};

export default setCellBackground;
