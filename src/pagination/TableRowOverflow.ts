import {
    Plugin,
    PluginKey,
    TextSelection,
    type EditorState,
    type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Slice, Fragment } from "@tiptap/pm/model";

export const tableRowOverflowPluginKey = new PluginKey("rmTableRowOverflow");

const RM_ROW_CLEANUP_META = "rmRowCleanup";

const NODE_TABLE = "table";
const NODE_ROW = "tableRow";
const NODE_GROUP = "tableRowGroup";
const NODE_CELL = "tableCell";
const NODE_HEADER = "tableHeader";

// Step 4 tuning
const MERGE_BACK_MIN_FREE_PX = 18; // must have at least this much free room
const MERGE_BACK_BUFFER_PX = 10;   // safety buffer (borders/padding/rounding)

/**
 * - paginate overflowing active cell (insert linked row, move overflow, cursor)
 * - cleanup linked rows when user deletes origin row (or any row in chain)
 * - merge-back when space becomes available after deletion (pull content up + delete empty linked rows)
 */
export function TableRowOverflow() {
    let applying = false;
    let raf: number | null = null;

    return new Plugin({
        key: tableRowOverflowPluginKey,

        appendTransaction(transactions, oldState, newState) {
            if (transactions.some((t) => t.getMeta(RM_ROW_CLEANUP_META))) return null;
            if (!transactions.some((t) => t.docChanged)) return null;
            return cleanupDeletedRowChains(oldState, newState);
        },

        view(view) {
            const schedule = (fn: () => void) => {
                if (raf) cancelAnimationFrame(raf);
                raf = requestAnimationFrame(fn);
            };

            const onStart = () => (applying = true);

            const onEnd = () => {
                applying = false;
                schedule(run);
            };

            const run = () => {
                if (typeof window === "undefined" || typeof document === "undefined") return;
                if (applying) return;
                if ((view as any).composing) return;

                const didPaginateActive = maybePaginateActiveCell(view, onStart, onEnd, {
                    moveSelection: view.hasFocus() && view.state.selection.empty,
                });
                if (didPaginateActive) return;

                const didReflow = maybePaginateFirstOverflowInCurrentTable(view, onStart, onEnd);
                if (didReflow) return;

                const didGlobalReflow = maybePaginateFirstOverflowInEditor(view, onStart, onEnd);
                if (didGlobalReflow) return;

                void maybeMergeBackActiveCell(view, onStart, onEnd);
            };

            return {
                update(view: EditorView, prevState) {
                    const docChanged = view.state.doc !== prevState.doc;
                    const selChanged = !view.state.selection.eq(prevState.selection);
                    if (!docChanged && !selChanged) return;

                    schedule(run);
                },
                destroy() { if (raf) cancelAnimationFrame(raf); }
            };
        }

    });
}


async function maybeMergeBackActiveCell(
    view: EditorView,
    onApplyStart: () => void,
    onApplyEnd: () => void,
): Promise<boolean> {
    const state = view.state;
    const info = getSelectionTableContext(state);
    if (!info) return false;

    const { rowPos, rowNode, cellPos, tableNode } = info;
    if (tableNode?.attrs?.locked) return false;

    const currentRowId = asStringOrNull(rowNode.attrs?.rmRowId);
    const nextRowId = asStringOrNull(rowNode.attrs?.rmLinkedNext);
    if (!currentRowId || !nextRowId) return false;

    const cellIndex = getCellIndexInRow(rowNode, rowPos, cellPos);
    if (cellIndex < 0) return false;

    const originTd = getActiveCellDom(view);
    if (!originTd) return false;

    // Must NOT be overflowing
    if (isOverflowing(originTd)) return false;

    //  Correct capacity: how much more can fit BEFORE max-height
    const capacityPx = getCellAvailableCapacityPx(originTd);
    if (capacityPx < MERGE_BACK_MIN_FREE_PX) return false;

    const nextRowPos = findRowPosById(state.doc, nextRowId);
    if (nextRowPos == null) return false;

    const nextRowNode = state.doc.nodeAt(nextRowPos);
    if (!nextRowNode || nextRowNode.type.name !== NODE_ROW) return false;

    const nextPrev = asStringOrNull(nextRowNode.attrs?.rmLinkedPrev);
    if (nextPrev && nextPrev !== currentRowId) return false;

    const nextCellPos = getCellPosInRow(state.doc, nextRowPos, cellIndex);
    if (nextCellPos == null) return false;

    const nextCellNode = state.doc.nodeAt(nextCellPos);
    if (!nextCellNode) return false;

    // If next row is already empty -> delete/relink it
    if (isRowCompletelyEmpty(nextRowNode)) {
        return deleteRowIfEmptyAndRelink(view, currentRowId, rowPos, nextRowPos, nextRowId);
    }

    // Need DOM of next cell to estimate first block height
    const nextTd = getCellDomByPos(view, nextCellPos);
    if (!nextTd) return false;

    const nextContent = nextTd.querySelector(".rm-cell-content") as HTMLElement | null;
    if (!nextContent) return false;

    const firstBlockIndex = getFirstMeaningfulBlockIndex(nextCellNode);
    if (firstBlockIndex == null) return false;

    const firstBlockEl = (nextContent.children[firstBlockIndex] as HTMLElement | undefined) ?? null;
    if (!firstBlockEl) return false;

    const blockH = firstBlockEl.getBoundingClientRect().height;
    if (blockH + MERGE_BACK_BUFFER_PX > capacityPx) {
        // Step 4a: we only move whole blocks. (Partial move comes later.)
        return false;
    }

    const tr = state.tr;
    tr.setMeta(RM_ROW_CLEANUP_META, true);

    const oldSelection = state.selection;

    // Move the block (PM transaction)
    const moved = moveWholeBlockFromNextToOrigin(tr, {
        originCellPos: cellPos,
        nextCellPos,
        nextBlockIndex: firstBlockIndex,
    });

    if (!moved) return false;

    // If next row becomes empty after move, delete it + relink chain
    cleanupEmptyLinkedRowInTr(tr, currentRowId, nextRowId);

    // Keep cursor stable
    const mappedSel = oldSelection.map(tr.doc, tr.mapping);
    tr.setSelection(mappedSel);

    onApplyStart();
    try {
        view.dispatch(tr);
        return true;
    } finally {
        requestAnimationFrame(() => onApplyEnd());
    }
}


function moveWholeBlockFromNextToOrigin(
    tr: Transaction,
    args: {
        originCellPos: number;
        nextCellPos: number;
        nextBlockIndex: number;
    },
): boolean {
    const { originCellPos, nextCellPos, nextBlockIndex } = args;

    const nextCellNode = tr.doc.nodeAt(nextCellPos);
    if (!nextCellNode) return false;

    const nextRange = getCellChildRange(nextCellPos, nextCellNode, nextBlockIndex);
    if (!nextRange) return false;

    const movedSlice = tr.doc.slice(nextRange.from, nextRange.to);
    if (!movedSlice.content.size) return false;

    // 1) delete from next cell
    tr.deleteRange(nextRange.from, nextRange.to);

    // 2) insert into origin cell
    const originCellNode = tr.doc.nodeAt(originCellPos);
    if (!originCellNode) return false;

    const originFrom = originCellPos + 1;
    const originTo = originCellPos + originCellNode.nodeSize - 1;
    const closed = new Slice(movedSlice.content, 0, 0);

    if (isEmptyPlaceholderCell(originCellNode)) {
        // replace placeholder
        tr.replaceRange(originFrom, originTo, closed);
    } else {
        // append to end of cell content
        tr.replaceRange(originTo, originTo, closed);
    }

    return true;
}


function deleteRowIfEmptyAndRelink(
    view: EditorView,
    currentRowId: string,
    currentRowPos: number,
    nextRowPos: number,
    nextRowId: string,
): boolean {
    const state = view.state;
    const tr = state.tr;
    tr.setMeta(RM_ROW_CLEANUP_META, true);

    const nextRowNode = state.doc.nodeAt(nextRowPos);
    if (!nextRowNode || nextRowNode.type.name !== NODE_ROW) return false;

    // ensure it's truly empty row (all cells empty)
    if (!isRowCompletelyEmpty(nextRowNode)) return false;

    const nextNextId = asStringOrNull(nextRowNode.attrs?.rmLinkedNext);

    // delete next row
    tr.deleteRange(nextRowPos, nextRowPos + nextRowNode.nodeSize);

    // relink current row -> nextNext
    safeSetNodeMarkup(tr, currentRowPos, NODE_ROW, (attrs) => ({
        ...attrs,
        rmLinkedNext: nextNextId ?? null,
    }));

    // update nextNext.rmLinkedPrev -> currentRowId
    if (nextNextId) {
        const nextNextPos = findRowPosById(tr.doc, nextNextId);
        if (nextNextPos != null) {
            safeSetNodeMarkup(tr, nextNextPos, NODE_ROW, (attrs) => ({
                ...attrs,
                rmLinkedPrev: currentRowId,
            }));
        }
    }

    if (!tr.steps.length) return false;

    view.dispatch(tr);
    return true;
}


function cleanupDeletedRowChains(oldState: EditorState, newState: EditorState): Transaction | null {
    const oldRows = collectRowsById(oldState.doc);
    if (oldRows.size === 0) return null;

    const newRows = collectRowsById(newState.doc);
    const deletedIds: string[] = [];

    for (const id of oldRows.keys()) {
        if (!newRows.has(id)) deletedIds.push(id);
    }
    if (deletedIds.length === 0) return null;

    const removeIds = new Set<string>();
    const clearPrevIds = new Set<string>();

    for (const deletedId of deletedIds) {
        const oldRow = oldRows.get(deletedId);
        if (!oldRow) continue;

        const prevId = asStringOrNull(oldRow.node.attrs?.rmLinkedPrev);
        if (prevId && newRows.has(prevId)) {
            clearPrevIds.add(prevId);
        }

        let nextId = asStringOrNull(oldRow.node.attrs?.rmLinkedNext);
        while (nextId) {
            if (removeIds.has(nextId)) break;
            removeIds.add(nextId);

            const nextOld = oldRows.get(nextId);
            if (!nextOld) break;
            nextId = asStringOrNull(nextOld.node.attrs?.rmLinkedNext);
        }
    }

    if (removeIds.size === 0 && clearPrevIds.size === 0) return null;

    const structure = collectRowStructure(newState.doc, removeIds);

    const tr = newState.tr;
    tr.setMeta(RM_ROW_CLEANUP_META, true);

    for (const prevId of clearPrevIds) {
        const row = structure.rowsById.get(prevId);
        if (!row) continue;
        if (structure.tablesToDelete.has(row.tablePos)) continue;
        if (row.groupPos != null && structure.groupsToDelete.has(row.groupPos)) continue;

        safeSetNodeMarkup(tr, row.pos, NODE_ROW, (attrs) => ({
            ...attrs,
            rmLinkedNext: null,
        }));
    }

    const deletions: Array<{ pos: number; size: number }> = [];

    for (const tablePos of structure.tablesToDelete) {
        const node = newState.doc.nodeAt(tablePos);
        if (!node || node.type.name !== NODE_TABLE) continue;
        deletions.push({ pos: tablePos, size: node.nodeSize });
    }

    for (const groupPos of structure.groupsToDelete) {
        const parentTablePos = structure.groupToTablePos.get(groupPos);
        if (parentTablePos != null && structure.tablesToDelete.has(parentTablePos)) continue;

        const node = newState.doc.nodeAt(groupPos);
        if (!node || node.type.name !== NODE_GROUP) continue;
        deletions.push({ pos: groupPos, size: node.nodeSize });
    }

    for (const row of structure.rowsToDelete) {
        if (structure.tablesToDelete.has(row.tablePos)) continue;
        if (row.groupPos != null && structure.groupsToDelete.has(row.groupPos)) continue;

        const node = newState.doc.nodeAt(row.pos);
        if (!node || node.type.name !== NODE_ROW) continue;
        deletions.push({ pos: row.pos, size: node.nodeSize });
    }

    if (deletions.length === 0 && tr.steps.length === 0) return null;

    deletions.sort((a, b) => b.pos - a.pos);
    for (const d of deletions) {
        tr.deleteRange(d.pos, d.pos + d.size);
    }

    return tr.steps.length ? tr : null;
}

function collectRowsById(doc: PMNode): Map<string, { node: PMNode; pos: number }> {
    const map = new Map<string, { node: PMNode; pos: number }>();
    doc.descendants((node, pos) => {
        if (node.type.name !== NODE_ROW) return true;
        const id = asStringOrNull(node.attrs?.rmRowId);
        if (!id) return true;
        map.set(id, { node, pos });
        return true;
    });
    return map;
}

type RowInfo = {
    id: string;
    pos: number;
    tablePos: number;
    groupPos: number | null;
};

function collectRowStructure(doc: PMNode, removeIds: Set<string>) {
    const rowsById = new Map<string, RowInfo>();
    const rowsToDelete: RowInfo[] = [];

    const tableKeepCounts = new Map<number, number>();
    const groupKeepCounts = new Map<number, number>();
    const groupToTablePos = new Map<number, number>();

    doc.descendants((node, pos) => {
        if (node.type.name !== NODE_ROW) return true;

        const resolved = doc.resolve(pos + 1);
        const table = findAncestor(resolved, NODE_TABLE);
        if (!table) return true;

        const group = findAncestor(resolved, NODE_GROUP);

        const id = asStringOrNull(node.attrs?.rmRowId);
        const rowWillBeDeleted = id ? removeIds.has(id) : false;
        const rowCountsAsKeep = id ? !rowWillBeDeleted : true;

        if (rowCountsAsKeep) {
            tableKeepCounts.set(table.pos, (tableKeepCounts.get(table.pos) ?? 0) + 1);
            if (group) {
                groupKeepCounts.set(group.pos, (groupKeepCounts.get(group.pos) ?? 0) + 1);
                groupToTablePos.set(group.pos, table.pos);
            }
        } else {
            if (group) groupToTablePos.set(group.pos, table.pos);
        }

        if (id) {
            const info: RowInfo = { id, pos, tablePos: table.pos, groupPos: group?.pos ?? null };
            rowsById.set(id, info);
            if (removeIds.has(id)) rowsToDelete.push(info);
        }

        return true;
    });

    const tablesToDelete = new Set<number>();
    doc.descendants((node, pos) => {
        if (node.type.name !== NODE_TABLE) return true;
        const keep = tableKeepCounts.get(pos) ?? 0;
        if (keep === 0) tablesToDelete.add(pos);
        return true;
    });

    const groupsToDelete = new Set<number>();
    doc.descendants((node, pos) => {
        if (node.type.name !== NODE_GROUP) return true;
        const keep = groupKeepCounts.get(pos) ?? 0;
        if (keep === 0) groupsToDelete.add(pos);
        return true;
    });

    return { rowsById, rowsToDelete, tablesToDelete, groupsToDelete, groupToTablePos };
}

function findAncestor($pos: any, typeName: string): { pos: number; node: PMNode } | null {
    for (let d = $pos.depth; d > 0; d--) {
        const n = $pos.node(d);
        if (n.type.name === typeName) {
            return { pos: $pos.before(d), node: n };
        }
    }
    return null;
}


function maybePaginateActiveCell(
    view: EditorView,
    onApplyStart: () => void,
    onApplyEnd: () => void,
    opts?: { moveSelection?: boolean },
): boolean {
    const state = view.state;
    const { schema } = state;

    const info = getSelectionTableContext(state);
    if (!info) return false;

    const { cellPos, cellNode, rowPos, rowNode, tableNode } = info;
    if (tableNode?.attrs?.locked) return false;

    const cellDom = getActiveCellDom(view);
    if (!cellDom) return false;

    if (!isOverflowing(cellDom)) return false;

    const cellIndex = getCellIndexInRow(rowNode, rowPos, cellPos);
    if (cellIndex < 0) return false;

    const split = computeSplitPoint(view, cellDom, cellPos, cellNode);
    if (!split) return false;

    const originRowId = ensureRowId(rowNode.attrs?.rmRowId);

    const tr = state.tr;
    tr.setMeta(tableRowOverflowPluginKey, true);

    if (rowNode.attrs?.rmRowId !== originRowId) {
        tr.setNodeMarkup(rowPos, undefined, { ...rowNode.attrs, rmRowId: originRowId });
    }

    const nextRowIdExisting = (rowNode.attrs?.rmLinkedNext as string | null) ?? null;
    const nextRowId = nextRowIdExisting ?? newId();

    if (!nextRowIdExisting) {
        const newRow = buildEmptyLinkedRow(schema, rowNode, {
            rmRowId: nextRowId,
            rmLinkedPrev: originRowId,
            rmLinkedNext: null,
        });

        tr.setNodeMarkup(rowPos, undefined, {
            ...rowNode.attrs,
            rmRowId: originRowId,
            rmLinkedNext: nextRowId,
        });

        const insertPos = rowPos + rowNode.nodeSize;
        tr.insert(insertPos, newRow);
    }

    const cellContentFrom = cellPos + 1;
    const cellContentTo = cellPos + cellNode.nodeSize - 1;

    let movedSlice: Slice | null = null;

    if (split.kind === "block") {
        const cutPos = clamp(split.cutPos, cellContentFrom, cellContentTo);
        if (cutPos >= cellContentTo) return false;

        movedSlice = tr.doc.slice(cutPos, cellContentTo);
        if (!movedSlice.content.size) return false;

        tr.deleteRange(cutPos, cellContentTo);
    } else {
        const cutPos = clamp(split.cutPos, cellContentFrom, cellContentTo);
        const $cut = tr.doc.resolve(cutPos);

        const textblockDepth = findNearestTextblockDepth($cut);
        if (textblockDepth == null) return false;

        const tbEnd = $cut.end(textblockDepth);
        if (cutPos >= tbEnd) return false;

        const tail = tr.doc.slice(cutPos, tbEnd);
        if (!tail.content.size) return false;

        const tbType = $cut.node(textblockDepth).type;
        const movedBlock = tbType.create(tbType.defaultAttrs, tail.content);

        movedSlice = new Slice(Fragment.from(movedBlock), 0, 0);

        tr.deleteRange(cutPos, tbEnd);
    }

    const nextRowPos = findRowPosById(tr.doc, nextRowId);
    if (nextRowPos == null) return false;

    const nextRowNode = tr.doc.nodeAt(nextRowPos);
    if (nextRowNode?.type.name === NODE_ROW) {
        const prev = (nextRowNode.attrs?.rmLinkedPrev as string | null) ?? null;
        if (prev !== originRowId) {
            tr.setNodeMarkup(nextRowPos, undefined, {
                ...nextRowNode.attrs,
                rmLinkedPrev: originRowId,
            });
        }
    }

    const targetCellPos = getCellPosInRow(tr.doc, nextRowPos, cellIndex);
    if (targetCellPos == null) return false;

    const targetCellNode = tr.doc.nodeAt(targetCellPos);
    if (!targetCellNode) return false;

    const targetFrom = targetCellPos + 1;
    const targetTo = targetCellPos + targetCellNode.nodeSize - 1;

    const closed = new Slice(movedSlice!.content, 0, 0);
    const emptyPlaceholder = isEmptyPlaceholderCell(targetCellNode);

    const insertFrom = targetFrom;
    if (emptyPlaceholder) {
        tr.replaceRange(targetFrom, targetTo, closed);
    } else {
        tr.replaceRange(targetFrom, targetFrom, closed); // prepend
    }

    const insertedSize = closed.content.size;
    const insertedTo = insertFrom + insertedSize;

    const cursorPos =
        findLastEditablePosInRange(tr.doc, insertFrom, insertedTo) ??
        findFirstTextPosInsideCell(tr.doc, targetCellPos) ??
        insertFrom;

    const moveSelection = opts?.moveSelection ?? true;
    const oldSelection = state.selection;

    if (moveSelection) {
        tr.setSelection(TextSelection.create(tr.doc, clamp(cursorPos, 0, tr.doc.content.size)));
    } else {
        const mapped = oldSelection.map(tr.doc, tr.mapping);
        tr.setSelection(mapped);
    }

    onApplyStart();
    try {
        view.dispatch(tr);
        return true;
    } finally {
        requestAnimationFrame(() => onApplyEnd());
    }
}

function getTableContextAtPos(
    state: any,
    pos: number,
): {
    cellPos: number;
    cellNode: PMNode;
    rowPos: number;
    rowNode: PMNode;
    tableNode: PMNode | null;
} | null {
    const $pos = state.doc.resolve(pos);

    let cellPos: number | null = null;
    let cellNode: PMNode | null = null;

    let rowPos: number | null = null;
    let rowNode: PMNode | null = null;

    let tableNode: PMNode | null = null;

    for (let d = $pos.depth; d > 0; d--) {
        const n = $pos.node(d);

        if (!cellNode && (n.type.name === "tableCell" || n.type.name === "tableHeader")) {
            cellNode = n;
            cellPos = $pos.before(d);
        }

        if (!rowNode && n.type.name === "tableRow") {
            rowNode = n;
            rowPos = $pos.before(d);
        }

        if (!tableNode && n.type.name === "table") {
            tableNode = n;
        }
    }

    if (cellPos == null || !cellNode || rowPos == null || !rowNode) return null;
    return { cellPos, cellNode, rowPos, rowNode, tableNode };
}

function paginateCellAtContext(
    view: EditorView,
    ctx: { cellPos: number; cellNode: PMNode; rowPos: number; rowNode: PMNode; tableNode: PMNode | null },
    cellDom: HTMLElement,
    onApplyStart: () => void,
    onApplyEnd: () => void,
): boolean {
    const state = view.state;
    const { schema } = state;
    const { cellPos, cellNode, rowPos, rowNode, tableNode } = ctx;

    if (tableNode?.attrs?.locked) return false;
    if (!isOverflowing(cellDom)) return false;

    const cellIndex = getCellIndexInRow(rowNode, rowPos, cellPos);
    if (cellIndex < 0) return false;

    const split = computeSplitPoint(view, cellDom, cellPos, cellNode);
    if (!split) return false;

    const originRowId = ensureRowId(rowNode.attrs?.rmRowId);

    const tr = state.tr;
    tr.setMeta(tableRowOverflowPluginKey, true);

    if (rowNode.attrs?.rmRowId !== originRowId) {
        tr.setNodeMarkup(rowPos, undefined, { ...rowNode.attrs, rmRowId: originRowId });
    }

    const nextRowIdExisting = (rowNode.attrs?.rmLinkedNext as string | null) ?? null;
    const nextRowId = nextRowIdExisting ?? newId();

    if (!nextRowIdExisting) {
        const newRow = buildEmptyLinkedRow(schema, rowNode, {
            rmRowId: nextRowId,
            rmLinkedPrev: originRowId,
            rmLinkedNext: null,
        });

        tr.setNodeMarkup(rowPos, undefined, {
            ...rowNode.attrs,
            rmRowId: originRowId,
            rmLinkedNext: nextRowId,
        });

        tr.insert(rowPos + rowNode.nodeSize, newRow);
    }

    const cellContentFrom = cellPos + 1;
    const cellContentTo = cellPos + cellNode.nodeSize - 1;

    let movedSlice: Slice | null = null;

    if (split.kind === "block") {
        const cutPos = clamp(split.cutPos, cellContentFrom, cellContentTo);
        if (cutPos >= cellContentTo) return false;

        movedSlice = tr.doc.slice(cutPos, cellContentTo);
        if (!movedSlice.content.size) return false;

        tr.deleteRange(cutPos, cellContentTo);
    } else {
        const cutPos = clamp(split.cutPos, cellContentFrom, cellContentTo);
        const $cut = tr.doc.resolve(cutPos);

        const textblockDepth = findNearestTextblockDepth($cut);
        if (textblockDepth == null) return false;

        const tbEnd = $cut.end(textblockDepth);
        if (cutPos >= tbEnd) return false;

        const tail = tr.doc.slice(cutPos, tbEnd);
        if (!tail.content.size) return false;

        const tbType = $cut.node(textblockDepth).type;
        const movedBlock = tbType.create(tbType.defaultAttrs, tail.content);
        movedSlice = new Slice(Fragment.from(movedBlock), 0, 0);

        tr.deleteRange(cutPos, tbEnd);
    }

    const nextRowPos = findRowPosById(tr.doc, nextRowId);
    if (nextRowPos == null) return false;

    const nextRowNode = tr.doc.nodeAt(nextRowPos);
    if (nextRowNode?.type.name === NODE_ROW) {
        const prev = (nextRowNode.attrs?.rmLinkedPrev as string | null) ?? null;
        if (prev !== originRowId) {
            tr.setNodeMarkup(nextRowPos, undefined, {
                ...nextRowNode.attrs,
                rmLinkedPrev: originRowId,
            });
        }
    }

    const targetCellPos = getCellPosInRow(tr.doc, nextRowPos, cellIndex);
    if (targetCellPos == null) return false;

    const targetCellNode = tr.doc.nodeAt(targetCellPos);
    if (!targetCellNode) return false;

    const targetFrom = targetCellPos + 1;
    const targetTo = targetCellPos + targetCellNode.nodeSize - 1;

    const closed = new Slice(movedSlice!.content, 0, 0);

    if (isEmptyPlaceholderCell(targetCellNode)) {
        tr.replaceRange(targetFrom, targetTo, closed);
    } else {
        tr.replaceRange(targetFrom, targetFrom, closed); // prepend
    }

    // keep selection (toolbar formatting)
    tr.setSelection(state.selection.map(tr.doc, tr.mapping));

    if (!tr.steps.length) return false;

    onApplyStart();
    try {
        view.dispatch(tr);
        return true;
    } finally {
        requestAnimationFrame(() => onApplyEnd());
    }
}



function maybePaginateFirstOverflowInEditor(
    view: EditorView,
    onApplyStart: () => void,
    onApplyEnd: () => void,
): boolean {
    const root = view.dom as HTMLElement;

    const cells = Array.from(
        root.querySelectorAll<HTMLElement>("table.table-plus td, table.table-plus th"),
    );

    const overflowing = cells.find((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        if (el.getAttribute("data-rm-merged-to")) return false; // optional
        return isOverflowing(el);
    });

    if (!overflowing) return false;

    let pos: number;
    try {
        const anchor = (overflowing.querySelector(".rm-cell-content") ?? overflowing) as HTMLElement;
        pos = view.posAtDOM(anchor, 0);
    } catch {
        return false;
    }

    const ctx = getTableContextAtPos(view.state, pos);
    if (!ctx) return false;

    return paginateCellAtContext(view, ctx, overflowing, onApplyStart, onApplyEnd);
}


function maybePaginateFirstOverflowInCurrentTable(
    view: EditorView,
    onApplyStart: () => void,
    onApplyEnd: () => void,
): boolean {
    const state = view.state;

    const anchorCell = getActiveCellDom(view);
    if (!anchorCell) return false;

    const tableEl = anchorCell.closest("table.table-plus") as HTMLElement | null;
    if (!tableEl) return false;

    const cells = Array.from(tableEl.querySelectorAll("td,th")) as HTMLElement[];

    const overflowing = cells.find((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;

        // skip covered merged cells if you want (optional safety)
        if (el.getAttribute("data-rm-merged-to")) return false;

        return isOverflowing(el);
    });

    if (!overflowing) return false;

    // Convert DOM cell to PM position
    let pos: number;
    try {
        const anchor = (overflowing.querySelector(".rm-cell-content") ?? overflowing) as HTMLElement;
        pos = view.posAtDOM(anchor, 0);
    } catch {
        return false;
    }

    const ctx = getTableContextAtPos(state, pos);
    if (!ctx) return false;

    // paginate this overflowing cell but KEEP selection
    return paginateCellAtContext(view, ctx, overflowing, onApplyStart, onApplyEnd);
}


/* -------------------------------- shared helpers -------------------------------- */

function getSelectionTableContext(state: any): {
    cellPos: number;
    cellNode: PMNode;
    rowPos: number;
    rowNode: PMNode;
    tableNode: PMNode | null;
} | null {
    const $from = state.selection.$from;

    let cellPos: number | null = null;
    let cellNode: PMNode | null = null;

    let rowPos: number | null = null;
    let rowNode: PMNode | null = null;

    let tableNode: PMNode | null = null;

    for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d);

        if (!cellNode && (n.type.name === NODE_CELL || n.type.name === NODE_HEADER)) {
            cellNode = n;
            cellPos = $from.before(d);
        }
        if (!rowNode && n.type.name === NODE_ROW) {
            rowNode = n;
            rowPos = $from.before(d);
        }
        if (!tableNode && n.type.name === NODE_TABLE) {
            tableNode = n;
        }
    }

    if (cellPos == null || !cellNode || rowPos == null || !rowNode) return null;
    return { cellPos, cellNode, rowPos, rowNode, tableNode };
}

function isOverflowing(el: HTMLElement) {
    const tdOverflow = el.scrollHeight > el.clientHeight + 1;

    const content = el.querySelector<HTMLElement>(".rm-cell-content");
    const contentOverflow = content
        ? content.scrollHeight > content.clientHeight + 1
        : false;

    return tdOverflow || contentOverflow;
}
function cleanupEmptyLinkedRowInTr(tr: Transaction, currentRowId: string, nextRowId: string) {
    const nextRowPos = findRowPosById(tr.doc, nextRowId);
    if (nextRowPos == null) return;

    const nextRowNode = tr.doc.nodeAt(nextRowPos);
    if (!nextRowNode || nextRowNode.type.name !== NODE_ROW) return;

    if (!isRowCompletelyEmpty(nextRowNode)) return;

    const nextNextId = asStringOrNull(nextRowNode.attrs?.rmLinkedNext);

    // delete next row
    tr.deleteRange(nextRowPos, nextRowPos + nextRowNode.nodeSize);

    // relink current -> nextNext
    const currentRowPos = findRowPosById(tr.doc, currentRowId);
    if (currentRowPos != null) {
        safeSetNodeMarkup(tr, currentRowPos, NODE_ROW, (attrs) => ({
            ...attrs,
            rmLinkedNext: nextNextId ?? null,
        }));
    }

    // update nextNext.prev -> current
    if (nextNextId) {
        const nextNextPos = findRowPosById(tr.doc, nextNextId);
        if (nextNextPos != null) {
            safeSetNodeMarkup(tr, nextNextPos, NODE_ROW, (attrs) => ({
                ...attrs,
                rmLinkedPrev: currentRowId,
            }));
        }
    }
}


function getCellAvailableCapacityPx(td: HTMLElement) {
    const cs = getComputedStyle(td);

    // maxHeight is set by your CSS: max-height: var(--rm-max-content-child-height)
    const maxH = cs.maxHeight;
    const maxHeightPx =
        maxH && maxH !== "none" && !Number.isNaN(parseFloat(maxH))
            ? parseFloat(maxH)
            : td.clientHeight;

    // scrollHeight reflects content height
    const capacity = maxHeightPx - td.scrollHeight;
    return Math.max(0, capacity);
}


function getActiveCellDom(view: EditorView): HTMLElement | null {
    const { node } = view.domAtPos(view.state.selection.from);
    let el: HTMLElement | null =
        node.nodeType === Node.TEXT_NODE ? (node.parentElement as HTMLElement) : (node as HTMLElement);

    while (el) {
        if (el.tagName === "TD" || el.tagName === "TH") return el;
        el = el.parentElement;
    }
    return null;
}

function getCellDomByPos(view: EditorView, pos: number): HTMLElement | null {
    try {
        const dom = view.nodeDOM(pos) as HTMLElement | null;
        if (!dom) return null;
        if (dom.tagName === "TD" || dom.tagName === "TH") return dom;
        // sometimes nodeDOM returns inner; climb
        let el: HTMLElement | null = dom;
        while (el) {
            if (el.tagName === "TD" || el.tagName === "TH") return el;
            el = el.parentElement;
        }
        return null;
    } catch {
        return null;
    }
}

function getCellIndexInRow(rowNode: PMNode, rowPos: number, cellPos: number) {
    const rowContentStart = rowPos + 1;
    const rel = cellPos - rowContentStart;
    if (rel < 0) return -1;

    let offset = 0;
    for (let i = 0; i < rowNode.childCount; i++) {
        if (offset === rel) return i;
        offset += rowNode.child(i).nodeSize;
    }
    return -1;
}

function getCellPosInRow(doc: PMNode, rowPos: number, cellIndex: number) {
    const row = doc.nodeAt(rowPos);
    if (!row || row.type.name !== NODE_ROW) return null;
    if (cellIndex < 0 || cellIndex >= row.childCount) return null;

    let p = rowPos + 1;
    for (let i = 0; i < cellIndex; i++) p += row.child(i).nodeSize;
    return p;
}

function findRowPosById(doc: PMNode, id: string) {
    let found: number | null = null;
    doc.descendants((node, pos) => {
        if (node.type.name === NODE_ROW && node.attrs?.rmRowId === id) {
            found = pos;
            return false;
        }
        return true;
    });
    return found;
}

function asStringOrNull(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
}

function safeSetNodeMarkup(
    tr: Transaction,
    pos: number,
    expectedTypeName: string,
    patch: (attrs: Record<string, any>) => Record<string, any>,
) {
    const node = tr.doc.nodeAt(pos);
    if (!node || node.type.name !== expectedTypeName) return;
    tr.setNodeMarkup(pos, undefined, patch({ ...node.attrs }));
}

function ensureRowId(existing: string | null | undefined) {
    return existing && String(existing).trim().length ? String(existing) : newId();
}

function newId() {
    const c: any = globalThis as any;
    if (c.crypto?.randomUUID) return c.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildEmptyLinkedRow(
    schema: any,
    fromRow: PMNode,
    attrs: { rmRowId: string; rmLinkedPrev: string | null; rmLinkedNext: string | null },
) {
    const nextAttrs = { ...fromRow.attrs, ...attrs };

    const cells = [];
    for (let i = 0; i < fromRow.childCount; i++) {
        const c = fromRow.child(i);
        const cellType = c.type;
        const safeAttrs = {
            ...c.attrs,
            rmMergedTo: null,
            rmMergeOrigin: false,
            rmHideMode: null,
            rmRowspan: 1,
            rmColspan: 1,
            rmCellId: null,
        };
        const empty = cellType.createAndFill(safeAttrs);
        cells.push(empty);
    }

    return schema.nodes.tableRow.create(nextAttrs, cells);
}

function isEmptyPlaceholderCell(cellNode: PMNode) {
    if (cellNode.childCount !== 1) return false;
    const only = cellNode.child(0);
    if (!only.isTextblock) return false;
    return only.content.size === 0 && !only.textContent;
}

function isCellCompletelyEmpty(cellNode: PMNode) {
    // Treat "placeholder empty paragraph" as empty; also treat whitespace-only as empty
    if (cellNode.childCount === 0) return true;
    if (cellNode.childCount === 1 && isEmptyPlaceholderCell(cellNode)) return true;
    return cellNode.textContent.trim().length === 0 && allChildrenAreEmptyTextblocks(cellNode);
}

function allChildrenAreEmptyTextblocks(cellNode: PMNode) {
    for (let i = 0; i < cellNode.childCount; i++) {
        const ch = cellNode.child(i);
        if (!ch.isTextblock) return false;
        if (ch.textContent.trim().length !== 0) return false;
        // if it has non-text inline nodes, treat as non-empty
        let hasInline = false;
        ch.descendants((n) => {
            if (n.isInline && !n.isText) {
                hasInline = true;
                return false;
            }
            return true;
        });
        if (hasInline) return false;
    }
    return true;
}

function isRowCompletelyEmpty(rowNode: PMNode) {
    for (let i = 0; i < rowNode.childCount; i++) {
        const cell = rowNode.child(i);
        if (!isCellCompletelyEmpty(cell)) return false;
    }
    return true;
}

function getFirstMeaningfulBlockIndex(cellNode: PMNode): number | null {
    for (let i = 0; i < cellNode.childCount; i++) {
        const ch = cellNode.child(i);
        if (!ch.isTextblock) return i; // list/table etc => treat meaningful
        if (ch.textContent.trim().length > 0) return i;
        // allow inline nodes
        let hasInline = false;
        ch.descendants((n) => {
            if (n.isInline && !n.isText) {
                hasInline = true;
                return false;
            }
            return true;
        });
        if (hasInline) return i;
    }
    return null;
}

function getCellChildRange(cellPos: number, cellNode: PMNode, childIndex: number) {
    if (childIndex < 0 || childIndex >= cellNode.childCount) return null;
    const start = cellPos + 1;
    let offset = 0;
    for (let i = 0; i < childIndex; i++) offset += cellNode.child(i).nodeSize;
    const from = start + offset;
    const to = from + cellNode.child(childIndex).nodeSize;
    return { from, to };
}

function findLastTextblockInCell(doc: PMNode, cellPos: number): { pos: number; node: PMNode } | null {
    const cell = doc.nodeAt(cellPos);
    if (!cell) return null;

    const base = cellPos + 1;
    let last: { pos: number; node: PMNode } | null = null;

    cell.descendants((node, relPos) => {
        if (node.isTextblock) last = { pos: base + relPos, node };
        return true;
    });

    return last;
}

function findFirstTextPosInsideCell(doc: PMNode, cellPos: number) {
    const cell = doc.nodeAt(cellPos);
    if (!cell) return null;

    const from = cellPos + 1;
    let found: number | null = null;

    cell.descendants((node, pos) => {
        if (node.isTextblock) {
            found = from + pos + 1;
            return false;
        }
        return true;
    });

    return found;
}

function findLastEditablePosInRange(doc: PMNode, from: number, to: number) {
    let lastTextPos: number | null = null;
    let lastTextblockEnd: number | null = null;

    doc.nodesBetween(from, to, (node, pos) => {
        if (node.isText) lastTextPos = pos + node.nodeSize;
        else if (node.isTextblock) lastTextblockEnd = pos + node.nodeSize - 1;
        return true;
    });

    return lastTextPos ?? lastTextblockEnd;
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

function getCaretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
    const anyDoc = document as any;

    if (typeof anyDoc.caretPositionFromPoint === "function") {
        const pos = anyDoc.caretPositionFromPoint(x, y);
        if (!pos) return null;
        return { node: pos.offsetNode, offset: pos.offset };
    }

    if (typeof anyDoc.caretRangeFromPoint === "function") {
        const range = anyDoc.caretRangeFromPoint(x, y);
        if (!range) return null;
        return { node: range.startContainer, offset: range.startOffset };
    }

    return null;
}

function computeSplitPoint(
    view: EditorView,
    cellDom: HTMLElement,
    cellPos: number,
    cellNode: PMNode,
): { kind: "block"; cutPos: number } | { kind: "inline"; cutPos: number } | null {
    const content = cellDom.querySelector(".rm-cell-content") as HTMLElement | null;
    if (!content) return null;

    const cellRect = cellDom.getBoundingClientRect();
    const cs = getComputedStyle(cellDom);
    const padBottom = parseFloat(cs.paddingBottom || "0");
    const innerBottom = cellRect.bottom - padBottom;

    const blocks = Array.from(content.children) as HTMLElement[];
    let lastFullyVisible = -1;

    for (let i = 0; i < blocks.length; i++) {
        const r = blocks[i]!.getBoundingClientRect();
        if (r.bottom <= innerBottom + 0.5) lastFullyVisible = i;
        else break;
    }

    if (lastFullyVisible >= 0 && lastFullyVisible < blocks.length - 1) {
        const idx = Math.min(lastFullyVisible, Math.max(0, cellNode.childCount - 1));
        const cutPos = cutPosAfterBlockIndex(cellPos, cellNode, idx);
        return { kind: "block", cutPos };
    }

    const isRTL = getComputedStyle(view.dom).direction === "rtl";
    const x = isRTL ? cellRect.right - 6 : cellRect.left + 6;
    const y = innerBottom - 2;

    const inViewport = y >= 0 && y <= window.innerHeight;

    if (inViewport) {
        const caret = getCaretAtPoint(x, y);
        if (caret) {
            try {
                const pmPos = view.posAtDOM(caret.node, caret.offset);
                return { kind: "inline", cutPos: pmPos };
            } catch {
                // fall through
            }
        }
    }

    const blockEl = blocks[0] as HTMLElement | undefined;
    if (!blockEl) return null;

    const pmPos = findInlineCutPosByDomBinarySearch(view, blockEl, innerBottom);
    if (pmPos == null) return null;

    return { kind: "inline", cutPos: pmPos };

}

function findInlineCutPosByDomBinarySearch(
    view: EditorView,
    blockEl: HTMLElement,
    innerBottom: number,
): number | null {
    // Collect text nodes in this block
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);

    if (nodes.length === 0) return null;

    // Build index map: globalCharIndex -> (textNode, offset)
    const segments: Array<{ node: Text; start: number; end: number }> = [];
    let total = 0;
    for (const n of nodes) {
        const len = n.data.length;
        if (len <= 0) continue;
        segments.push({ node: n, start: total, end: total + len });
        total += len;
    }
    if (total <= 1) return null;

    const pointAt = (charIndex: number): { node: Text; offset: number } | null => {
        const i = Math.max(0, Math.min(total - 1, charIndex));
        const seg = segments.find((s) => i >= s.start && i < s.end);
        if (!seg) return null;
        return { node: seg.node, offset: i - seg.start };
    };

    const charBottom = (node: Text, offset: number): number => {
        const r = document.createRange();
        const len = node.data.length;

        // pick a 1-char range to get a real rect
        if (len === 0) return Number.POSITIVE_INFINITY;

        const start = Math.max(0, Math.min(len - 1, offset));
        const end = Math.min(len, start + 1);

        r.setStart(node, start);
        r.setEnd(node, end);

        const rect = r.getBoundingClientRect();
        return rect.bottom || Number.POSITIVE_INFINITY;
    };

    // Binary search: find the greatest char index whose rect.bottom <= innerBottom
    let lo = 0;
    let hi = total - 1;
    let best = 0;

    for (let iter = 0; iter < 20 && lo <= hi; iter++) {
        const mid = (lo + hi) >> 1;
        const p = pointAt(mid);
        if (!p) break;

        const bottom = charBottom(p.node, p.offset);

        if (bottom <= innerBottom + 0.5) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    // Ensure not returning "start" (would move nothing)
    best = Math.max(1, best);

    const bestPoint = pointAt(best);
    if (!bestPoint) return null;

    try {
        return view.posAtDOM(bestPoint.node, bestPoint.offset);
    } catch {
        return null;
    }
}


function cutPosAfterBlockIndex(cellPos: number, cellNode: PMNode, blockIndex: number) {
    const start = cellPos + 1;
    let offset = 0;
    for (let i = 0; i <= blockIndex; i++) offset += cellNode.child(i).nodeSize;
    return start + offset;
}

function findNearestTextblockDepth($pos: any): number | null {
    for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).isTextblock) return d;
    }
    return null;
}
