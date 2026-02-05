import { Extension, type CommandProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { CellSelection, TableMap } from 'prosemirror-tables';

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        TableMergePlus: {
            toggleTableMerge: () => ReturnType;
            mergeTableSelection: () => ReturnType;
            unmergeTableAtSelection: () => ReturnType;
            deleteRowPlus: () => ReturnType;
        };
    }
}

type HideMode = "none" | "hidden" | null;

function uuid() {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isTable(n: PMNode) {
    return n.type.name === "table" || n.type.spec.tableRole === "table";
}

function isCell(n: PMNode) {
    const r = n.type.spec.tableRole;
    return (
        n.type.name === "tableCell" ||
        n.type.name === "tableHeader" ||
        r === "cell" ||
        r === "header_cell"
    );
}

function findAncestor($pos: any, pred: (n: PMNode) => boolean) {
    for (let d = $pos.depth; d > 0; d--) {
        const n = $pos.node(d) as PMNode;
        if (pred(n)) return { node: n, pos: $pos.before(d) };
    }
    return null;
}

/**
 * Duck-typing cell selection (avoids instanceof issues if prosemirror-tables duplicated)
 */
function getCellSelectionLike(state: any) {
    const sel = state.selection as any;
    if (sel?.$anchorCell && sel?.$headCell) return sel;
    return null;
}

function getCellRowCol(map: TableMap, posInTable: number) {
    // find first index that points to this cell position
    for (let i = 0; i < map.map.length; i++) {
        if (map.map[i] === posInTable) {
            return { row: Math.floor(i / map.width), col: i % map.width };
        }
    }
    return null;
}

function emptyCellContent(schema: any) {
    const p = schema.nodes.paragraph?.createAndFill();
    if (!p) throw new Error("Schema must have paragraph node for table cells.");
    return Fragment.from(p);
}

function ensureCellIdsTr(state: any) {
    let tr = state.tr;
    let changed = false;

    state.doc.descendants((node: PMNode, pos: number) => {
        if (!isCell(node)) return true;
        if (node.attrs?.rmCellId) return true;
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, rmCellId: uuid() });
        changed = true;
        return true;
    });

    return changed ? tr : null;
}

function isVisuallyEmptyCell(cell: PMNode) {
    // "empty" even if it has trailingBreak/hardBreak only
    if (cell.textContent.trim() !== "") return false;

    let hasNonTrivial = false;
    cell.descendants((n) => {
        // allow paragraphs + hardBreak only
        if (n.type.name === "hardBreak" || n.type.name === "paragraph") return true;

        // any other node means it's not empty (image, mention, etc.)
        if (n.isLeaf && n.type.name !== "hardBreak") {
            hasNonTrivial = true;
            return false;
        }
        return true;
    });

    return !hasNonTrivial;
}

function meaningfulBlocksFromCell(cell: PMNode) {
    const out: PMNode[] = [];
    cell.content.forEach((block) => {
        if (block.type.name === "paragraph" && block.textContent.trim() === "" && block.content.size === 0) {
            return;
        }
        out.push(block);
    });
    return out;
}


export const TableMergePlus = Extension.create({
    name: "TableMergePlus",

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey("rmEnsureCellIds"),
                view(view) {
                    // one-time + keeps ids stable
                    const tr = ensureCellIdsTr(view.state);
                    if (tr) view.dispatch(tr);
                    return {};
                },
                appendTransaction(trs, _old, state) {
                    if (!trs.some((t) => t.docChanged)) return null;
                    return ensureCellIdsTr(state);
                },
            }),
        ];
    },

    addCommands() {
        const mergeInternal =
            () =>
                ({ state, dispatch }: CommandProps) => {
                    const sel = getCellSelectionLike(state);
                    if (!sel) return false;

                    const tableInfo = findAncestor(sel.$anchorCell, isTable);
                    if (!tableInfo) return false;

                    const tableNode = tableInfo.node;
                    const tableStart = tableInfo.pos + 1;
                    const map = TableMap.get(tableNode);

                    const a = sel.$anchorCell.pos - tableStart;
                    const b = sel.$headCell.pos - tableStart;
                    const rect = map.rectBetween(a, b);

                    const width = rect.right - rect.left;
                    const height = rect.bottom - rect.top;

                    if (width === 1 && height === 1) return false;

                    // Collect all cells in selection rectangle
                    const cells: { abs: number; node: PMNode; r: number; c: number }[] = [];
                    for (let r = rect.top; r < rect.bottom; r++) {
                        for (let c = rect.left; c < rect.right; c++) {
                            const posInTable = map.map[r * map.width + c];
                            const abs = tableStart + posInTable;
                            const n = state.doc.nodeAt(abs);
                            if (!n || !isCell(n)) return false;
                            cells.push({ abs, node: n, r, c });
                        }
                    }

                    // Toggle safety: if any cell already merged -> refuse merge (use toggle to unmerge)
                    for (const cell of cells) {
                        if (cell.node.attrs?.rmMergedTo) return false;
                        if (cell.node.attrs?.rmMergeOrigin && (cell.node.attrs?.rmRowspan > 1 || cell.node.attrs?.rmColspan > 1))
                            return false;
                    }

                    // Origin is top-left
                    const origin = cells.find((x) => x.r === rect.top && x.c === rect.left)!;
                    const originId: string = origin.node.attrs.rmCellId;
                    if (!originId) return false;

                    const schema = state.schema;
                    const mergedBlocks: PMNode[] = [];

// keep origin content if it’s not visually empty, otherwise keep only one empty paragraph later
                    if (!isVisuallyEmptyCell(origin.node)) {
                        mergedBlocks.push(...meaningfulBlocksFromCell(origin.node));
                    }

// append only meaningful content from other cells
                    for (const cell of cells) {
                        if (cell.abs === origin.abs) continue;
                        if (isVisuallyEmptyCell(cell.node)) continue;
                        mergedBlocks.push(...meaningfulBlocksFromCell(cell.node));
                    }

// if everything was empty => keep a single empty paragraph (prevents height growth)
                    if (mergedBlocks.length === 0) {
                        const p = schema.nodes.paragraph.create();
                        mergedBlocks.push(p);
                    }

                    const mergedOrigin = origin.node.type.create(
                        {
                            ...origin.node.attrs,
                            rmMergeOrigin: true,
                            rmMergedTo: null,
                            rmHideMode: null,
                            rmColspan: width,
                            rmRowspan: height,
                        },
                        Fragment.fromArray(mergedBlocks)
                    );


                    // Create covered cells (empty content + ghost attrs)
                    const empty = emptyCellContent(schema);

                    const updates: { abs: number; oldNode: PMNode; newNode: PMNode }[] = [];

                    for (const cell of cells) {
                        if (cell.abs === origin.abs) continue;

                        const hideMode: HideMode = cell.r === rect.top ? "none" : "hidden";

                        const newCell = cell.node.type.create(
                            {
                                ...cell.node.attrs,
                                // covered by originId
                                rmMergeOrigin: false,
                                rmMergedTo: originId,
                                rmHideMode: hideMode,
                                rmColspan: 1,
                                rmRowspan: 1,
                            },
                            empty
                        );

                        updates.push({ abs: cell.abs, oldNode: cell.node, newNode: newCell });
                    }

                    // Replace in descending order to avoid pos shifts
                    updates.sort((x, y) => y.abs - x.abs);

                    let tr = state.tr;

                    for (const u of updates) {
                        tr = tr.replaceWith(u.abs, u.abs + u.oldNode.nodeSize, u.newNode);
                    }

                    // Replace origin last
                    tr = tr.replaceWith(origin.abs, origin.abs + origin.node.nodeSize, mergedOrigin);

                    if (dispatch) dispatch(tr.scrollIntoView());
                    return true;
                };

        const unmergeInternal =
            () =>
                ({ state, dispatch }: CommandProps) => {
                    const sel = getCellSelectionLike(state);
                    if (!sel) return false;

                    const tableInfo = findAncestor(sel.$anchorCell, isTable);
                    if (!tableInfo) return false;

                    const tableNode = tableInfo.node;
                    const tableStart = tableInfo.pos + 1;
                    const map = TableMap.get(tableNode);

                    // Identify target merge id from selection: prefer covered->origin, else origin itself
                    const anchorAbs = sel.$anchorCell.pos;
                    const anchorNode = state.doc.nodeAt(anchorAbs);
                    if (!anchorNode || !isCell(anchorNode)) return false;

                    let originId: string | null = null;

                    if (anchorNode.attrs?.rmMergedTo) {
                        originId = anchorNode.attrs.rmMergedTo;
                    } else if (anchorNode.attrs?.rmMergeOrigin && (anchorNode.attrs?.rmRowspan > 1 || anchorNode.attrs?.rmColspan > 1)) {
                        originId = anchorNode.attrs.rmCellId;
                    }

                    // If anchor isn't merged, scan head cell too (common when selection starts outside)
                    if (!originId) {
                        const headAbs = sel.$headCell.pos;
                        const headNode = state.doc.nodeAt(headAbs);
                        if (headNode && isCell(headNode)) {
                            if (headNode.attrs?.rmMergedTo) originId = headNode.attrs.rmMergedTo;
                            else if (headNode.attrs?.rmMergeOrigin && (headNode.attrs?.rmRowspan > 1 || headNode.attrs?.rmColspan > 1))
                                originId = headNode.attrs.rmCellId;
                        }
                    }

                    if (!originId) return false;

                    // Find origin position inside this table
                    let originAbs: number | null = null;
                    tableNode.descendants((n: PMNode, relPos: number) => {
                        if (originAbs != null) return false;
                        if (!isCell(n)) return true;
                        if (n.attrs?.rmCellId === originId && (n.attrs?.rmMergeOrigin || (n.attrs?.rmRowspan > 1 || n.attrs?.rmColspan > 1))) {
                            originAbs = tableStart + relPos;
                            return false;
                        }
                        return true;
                    });

                    if (originAbs == null) return false;

                    const originNode2 = state.doc.nodeAt(originAbs);
                    if (!originNode2 || !isCell(originNode2)) return false;

                    const spanW = Number(originNode2.attrs?.rmColspan ?? 1);
                    const spanH = Number(originNode2.attrs?.rmRowspan ?? 1);
                    if (spanW <= 1 && spanH <= 1) return false;

                    const originPosInTable = originAbs - tableStart;
                    const rc = getCellRowCol(map, originPosInTable);
                    if (!rc) return false;

                    const top = rc.row;
                    const left = rc.col;
                    const bottom = Math.min(top + spanH, map.height);
                    const right = Math.min(left + spanW, map.width);

                    const schema = state.schema;
                    const empty = emptyCellContent(schema);

                    const updates: { abs: number; oldNode: PMNode; newNode: PMNode }[] = [];

                    for (let r = top; r < bottom; r++) {
                        for (let c = left; c < right; c++) {
                            const posInTable = map.map[r * map.width + c];
                            const abs = tableStart + posInTable;
                            const n = state.doc.nodeAt(abs);
                            if (!n || !isCell(n)) continue;

                            // Origin resets
                            if (abs === originAbs) {
                                const newOrigin = n.type.create(
                                    {
                                        ...n.attrs,
                                        rmMergeOrigin: false,
                                        rmMergedTo: null,
                                        rmHideMode: null,
                                        rmColspan: 1,
                                        rmRowspan: 1,
                                    },
                                    n.content // keep merged content in origin (simple)
                                );
                                updates.push({ abs, oldNode: n, newNode: newOrigin });
                            } else if (n.attrs?.rmMergedTo === originId) {
                                // Covered cells become normal empty cells again
                                const newCell = n.type.create(
                                    {
                                        ...n.attrs,
                                        rmMergeOrigin: false,
                                        rmMergedTo: null,
                                        rmHideMode: null,
                                        rmColspan: 1,
                                        rmRowspan: 1,
                                    },
                                    empty
                                );
                                updates.push({ abs, oldNode: n, newNode: newCell });
                            }
                        }
                    }

                    if (!updates.length) return false;

                    updates.sort((a, b) => b.abs - a.abs);

                    let tr = state.tr;
                    for (const u of updates) {
                        tr = tr.replaceWith(u.abs, u.abs + u.oldNode.nodeSize, u.newNode);
                    }

                    if (dispatch) dispatch(tr.scrollIntoView());
                    return true;
                };
                const deleteRowPlus = () => ({ state }: CommandProps) => {
                    const editor = this.editor;
                    const view = editor.view;

                    const selLike: any = getCellSelectionLike(state);
                    const $from = state.selection.$from;

                    // Find the table from either the cell selection or the text cursor
                    const tableInfo = selLike
                        ? findAncestor(selLike.$anchorCell, isTable)
                        : findAncestor($from, isTable);
                    if (!tableInfo) return false;

                    const tableNode = tableInfo.node;
                    const tableStart = tableInfo.pos + 1;
                    const map = TableMap.get(tableNode);

                    let anchorCellAbs: number | null = null;
                    if (selLike) {
                        anchorCellAbs = selLike.$anchorCell.pos;
                    } else {
                        // Climb from $from to find the enclosing cell start
                        for (let d = $from.depth; d >= 0; d--) {
                            const n: any = $from.node(d);
                            if (isCell(n)) {
                                anchorCellAbs = $from.before(d);
                                break;
                            }
                        }
                    }
                    if (anchorCellAbs == null) return false;

                    const posInTable = anchorCellAbs - tableStart;
                    const idx = map.map.indexOf(posInTable);
                    if (idx < 0) return false;
                    const rowIndex = Math.floor(idx / map.width);

                    // Scan the row for merges intersecting it
                    type Target = { abs: number; originId: string };
                    const targets: Target[] = [];
                    const seen = new Set<string>();

                    for (let c = 0; c < map.width; c++) {
                        const cellPosInTable = map.map[rowIndex * map.width + c];
                        const abs = tableStart + cellPosInTable;
                        const n: any = state.doc.nodeAt(abs);
                        if (!n || !isCell(n)) continue;

                        const a = n.attrs || {};
                        if (a.rmMergedTo && !seen.has(a.rmMergedTo)) {
                            seen.add(a.rmMergedTo);
                            targets.push({ abs, originId: a.rmMergedTo });
                        } else if (a.rmMergeOrigin && (Number(a.rmRowspan || 1) > 1 || Number(a.rmColspan || 1) > 1)) {
                            const id = String(a.rmCellId || '');
                            if (id && !seen.has(id)) {
                                seen.add(id);
                                targets.push({ abs, originId: id });
                            }
                        }
                    }

                    // For each intersecting merge, move to that cell with a CellSelection and unmerge
                    if (targets.length) {
                        for (const t of targets) {
                            const $cell = editor.state.doc.resolve(t.abs);
                            const tr1 = editor.state.tr.setSelection(new CellSelection($cell, $cell));
                            view.dispatch(tr1);
                            editor.commands.unmergeTableAtSelection();
                        }
                    }


                    editor.chain().focus().deleteRow().run();
                    return true;
                };
        const insertRowAfterPlus =
            () =>
                ({ state }: CommandProps) => {
                    const editor = this.editor;
                    const view = editor.view;

                    const selLike: any = getCellSelectionLike(state);
                    const $from = state.selection.$from;

                    // Find the table from either the cell selection or the text cursor
                    const tableInfo = selLike
                        ? findAncestor(selLike.$anchorCell, isTable)
                        : findAncestor($from, isTable);
                    if (!tableInfo) return false;

                    const tableNode = tableInfo.node;
                    const tableStart = tableInfo.pos + 1;
                    const map = TableMap.get(tableNode);

                    // Find current cell position
                    let anchorCellAbs: number | null = null;
                    if (selLike) {
                        anchorCellAbs = selLike.$anchorCell.pos;
                    } else {
                        for (let d = $from.depth; d >= 0; d--) {
                            const n = $from.node(d);
                            if (isCell(n)) {
                                anchorCellAbs = $from.before(d);
                                break;
                            }
                        }
                    }
                    if (anchorCellAbs == null) return false;

                    const posInTable = anchorCellAbs - tableStart;
                    const idx = map.map.indexOf(posInTable);
                    if (idx < 0) return false;
                    const currentRowIndex = Math.floor(idx / map.width);

                    // Collect merge info BEFORE inserting the row
                    // We need to know which merges span past the current row
                    type MergeInfo = {
                        originId: string;
                        originPosInTable: number;
                        colspan: number;
                        rowspan: number;
                        originRow: number;
                        originCol: number;
                    };

                    const mergesToExtend: MergeInfo[] = [];
                    const seenOrigins = new Set<string>();

                    // Scan the current row to find merges that need extending
                    for (let c = 0; c < map.width; c++) {
                        const cellPosInTable = map.map[currentRowIndex * map.width + c];
                        const abs = tableStart + cellPosInTable;
                        const node = state.doc.nodeAt(abs);
                        if (!node || !isCell(node)) continue;

                        const attrs = node.attrs || {};

                        // Case 1: This cell is an origin with rowspan > 1
                        // The merge extends below current row, so new row should be included
                        if (attrs.rmMergeOrigin && Number(attrs.rmRowspan || 1) > 1) {
                            const originId = String(attrs.rmCellId || "");
                            if (originId && !seenOrigins.has(originId)) {
                                seenOrigins.add(originId);
                                const rc = getCellRowCol(map, cellPosInTable);
                                if (rc) {
                                    mergesToExtend.push({
                                        originId,
                                        originPosInTable: cellPosInTable,
                                        colspan: Number(attrs.rmColspan || 1),
                                        rowspan: Number(attrs.rmRowspan || 1),
                                        originRow: rc.row,
                                        originCol: rc.col,
                                    });
                                }
                            }
                        }
                            // Case 2: This cell is covered by a merge (rmMergedTo is set)
                        // Need to check if the merge extends past this row
                        else if (attrs.rmMergedTo) {
                            const originId = String(attrs.rmMergedTo);
                            if (!seenOrigins.has(originId)) {
                                // Find the origin cell to get its rowspan
                                let originInfo: MergeInfo | null = null;
                                tableNode.descendants((n: PMNode, relPos: number) => {
                                    if (originInfo) return false;
                                    if (!isCell(n)) return true;
                                    const a = n.attrs || {};
                                    if (a.rmCellId === originId && a.rmMergeOrigin) {
                                        const rc = getCellRowCol(map, relPos);
                                        if (rc) {
                                            const rowspan = Number(a.rmRowspan || 1);
                                            const originBottom = rc.row + rowspan;
                                            // Only extend if merge goes past current row
                                            if (originBottom > currentRowIndex + 1) {
                                                originInfo = {
                                                    originId,
                                                    originPosInTable: relPos,
                                                    colspan: Number(a.rmColspan || 1),
                                                    rowspan,
                                                    originRow: rc.row,
                                                    originCol: rc.col,
                                                };
                                            }
                                        }
                                        return false;
                                    }
                                    return true;
                                });
                                if (originInfo) {
                                    seenOrigins.add(originId);
                                    mergesToExtend.push(originInfo);
                                }
                            }
                        }
                    }

                    // Also check rows ABOVE current row for merges that span into/past current row
                    for (let r = 0; r < currentRowIndex; r++) {
                        for (let c = 0; c < map.width; c++) {
                            const cellPosInTable = map.map[r * map.width + c];
                            const abs = tableStart + cellPosInTable;
                            const node = state.doc.nodeAt(abs);
                            if (!node || !isCell(node)) continue;

                            const attrs = node.attrs || {};

                            if (attrs.rmMergeOrigin) {
                                const originId = String(attrs.rmCellId || "");
                                if (originId && !seenOrigins.has(originId)) {
                                    const rowspan = Number(attrs.rmRowspan || 1);
                                    const rc = getCellRowCol(map, cellPosInTable);
                                    if (rc) {
                                        const originBottom = rc.row + rowspan;
                                        // Merge spans past current row?
                                        if (originBottom > currentRowIndex + 1) {
                                            seenOrigins.add(originId);
                                            mergesToExtend.push({
                                                originId,
                                                originPosInTable: cellPosInTable,
                                                colspan: Number(attrs.rmColspan || 1),
                                                rowspan,
                                                originRow: rc.row,
                                                originCol: rc.col,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Now do the standard row insert
                    editor.chain().focus().addRowAfter().run();

                    // If no merges to extend, we're done
                    if (mergesToExtend.length === 0) return true;

                    // Get fresh state after insert
                    const newState = editor.state;
                    const new$from = newState.selection.$from;
                    const newTableInfo = findAncestor(new$from, isTable);
                    if (!newTableInfo) return true;

                    const newTableNode = newTableInfo.node;
                    const newTableStart = newTableInfo.pos + 1;
                    const newMap = TableMap.get(newTableNode);

                    const newRowIndex = currentRowIndex + 1;
                    const schema = newState.schema;
                    const empty = emptyCellContent(schema);

                    // Collect all updates
                    type Update = { abs: number; oldNode: PMNode; newNode: PMNode };
                    const updates: Update[] = [];
                    const updatedOrigins = new Set<string>();

                    for (const merge of mergesToExtend) {
                        // Update origin's rowspan (only once per origin)
                        if (!updatedOrigins.has(merge.originId)) {
                            // Find origin in new doc
                            let originAbs: number | null = null;
                            let originNode: PMNode | null = null;

                            newTableNode.descendants((n: PMNode, relPos: number) => {
                                if (originAbs !== null) return false;
                                if (!isCell(n)) return true;
                                if (n.attrs?.rmCellId === merge.originId && n.attrs?.rmMergeOrigin) {
                                    originAbs = newTableStart + relPos;
                                    originNode = n;
                                    return false;
                                }
                                return true;
                            });

                            if (originAbs !== null && originNode !== null) {
                                const newOrigin = (originNode as PMNode).type.create(
                                    {
                                        ...(originNode as PMNode).attrs,
                                        rmRowspan: merge.rowspan + 1,
                                    },
                                    (originNode as PMNode).content
                                );
                                updates.push({
                                    abs: originAbs,
                                    oldNode: originNode as PMNode,
                                    newNode: newOrigin,
                                });
                                updatedOrigins.add(merge.originId);
                            }
                        }

                        // Mark cells in the new row that fall within this merge's column span
                        for (let c = merge.originCol; c < merge.originCol + merge.colspan; c++) {
                            if (c >= newMap.width) continue;

                            const newCellPosInTable = newMap.map[newRowIndex * newMap.width + c];
                            const newCellAbs = newTableStart + newCellPosInTable;
                            const newCellNode = newState.doc.nodeAt(newCellAbs);

                            if (!newCellNode || !isCell(newCellNode)) continue;

                            // Skip if already processed (handles colspan overlap)
                            if (updates.some((u) => u.abs === newCellAbs)) continue;

                            // Determine hideMode: "none" if in first row of merge (origin row), "hidden" otherwise
                            const hideMode: HideMode = newRowIndex === merge.originRow ? "none" : "hidden";

                            const coveredCell = newCellNode.type.create(
                                {
                                    ...newCellNode.attrs,
                                    rmMergeOrigin: false,
                                    rmMergedTo: merge.originId,
                                    rmHideMode: hideMode,
                                    rmColspan: 1,
                                    rmRowspan: 1,
                                },
                                empty
                            );

                            updates.push({
                                abs: newCellAbs,
                                oldNode: newCellNode,
                                newNode: coveredCell,
                            });
                        }
                    }

                    if (updates.length === 0) return true;

                    // Sort descending by position to avoid shifts
                    updates.sort((a, b) => b.abs - a.abs);

                    let tr = newState.tr;
                    for (const u of updates) {
                        tr = tr.replaceWith(u.abs, u.abs + u.oldNode.nodeSize, u.newNode);
                    }

                    if (tr.docChanged) {
                        view.dispatch(tr);
                    }

                    return true;
                };
        return {
            mergeTableSelection: mergeInternal,
            unmergeTableAtSelection: unmergeInternal,
            toggleTableMerge:
                () =>
                    (props: CommandProps) => {
                        // if unmerge succeeds -> done, else try merge
                        return unmergeInternal()(props) || mergeInternal()(props);
                    },
            deleteRowPlus,
            insertRowAfterPlus

        };
    },
});
