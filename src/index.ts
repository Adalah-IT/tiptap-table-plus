import PaginationTable from "./pagination";
import { TablePlus } from "./TablePlus";

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
      tableCommandExtension: {
        duplicateColumn: (withContent?: boolean) => ReturnType;
        duplicateRow: (withContent?: boolean) => ReturnType;
        setTableAlign: (align: 'left' | 'center' | 'right' | 'start' | 'end' | 'justify') => ReturnType;
        unsetTableAlign: () => ReturnType;
        toggleTableLock: () => ReturnType;
        setHeaderBackground: (color: string | null) => ReturnType;
        setTableBorderColor: (color: string | null) => ReturnType;
        setCellVerticalAlign: (value: "top" | "middle" | "bottom" | null) => ReturnType;
      };
    }
  }
  
export { PaginationTable, TablePlus };
