import { setCellAttr } from "@tiptap/pm/tables";
import { EditorState, Transaction } from "@tiptap/pm/state";

export type CellVerticalAlign = "top" | "middle" | "bottom";

const setCellVerticalAlign =
  (value: CellVerticalAlign | null) =>
  ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
    return setCellAttr("verticalAlign", value)(state, dispatch);
  };

export default setCellVerticalAlign;
