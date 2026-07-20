import { Extension } from '@tiptap/core';
import { EditorState, Transaction } from '@tiptap/pm/state';
import duplicateColumn from "./commands/duplicateColumn";
import duplicateRow from "./commands/duplicateRow";
import setTableAlign from "./commands/setTableAlign";
import unsetTableAlign from "./commands/unsetTableAlign";
import toggleTableLock from "./commands/toggleTableLock";
import setHeaderBackground from "./commands/setHeaderBackground";
import setCellBackground from "./commands/setCellBackground";
import setTableBorderColor from "./commands/setTableBorderColor";
import setCellVerticalAlign from "./commands/setCellVerticalAlign";

type CommandContext = { state: EditorState; dispatch?: (tr: Transaction) => void };

export const TableCommandExtension = Extension.create({
    name: "tableCommandExtension",

    addCommands() {
        return {
            duplicateColumn:
                (withContent = true) =>
                    ({ state, dispatch }: CommandContext) => {
                        duplicateColumn(state, dispatch, withContent);
                        return true;
                    },
            duplicateRow:
                (withContent = true) =>
                    ({ state, dispatch }: CommandContext) => {
                        duplicateRow(state, dispatch, withContent);
                        return true;
                    },
            setTableAlign:
                (align: 'left' | 'center' | 'right' | 'start' | 'end' | 'justify') =>
                    ({ state, dispatch }: CommandContext) => {
                        return setTableAlign(state, dispatch, align);
                    },
            unsetTableAlign:
                () =>
                    ({ state, dispatch }: CommandContext) => {
                        return unsetTableAlign(state, dispatch);
                    },
            toggleTableLock:
                () =>
                    ({ state, dispatch }: CommandContext) => {
                        return toggleTableLock(state, dispatch);
                    },
            setHeaderBackground:
                (color: string | null) =>
                    ({ state, dispatch }: CommandContext) => {
                        return setHeaderBackground(color)( { state, dispatch } );
                    },
            setCellBackground:
                (color: string | null) =>
                    ({ state, dispatch }: CommandContext) => {
                        return setCellBackground(color)({ state, dispatch });
                    },
            setTableBorderColor:
                (color: string | null) =>
                    ({ state, dispatch }: CommandContext) => {
                        return setTableBorderColor(color)({ state, dispatch });
                    },
            setCellVerticalAlign:
                (value: "top" | "middle" | "bottom" | null) =>
                    ({ state, dispatch }: CommandContext) => {
                        return setCellVerticalAlign(value)({ state, dispatch });
                    },
        };
    },
});
export default TableCommandExtension;
