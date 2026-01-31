import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from 'prosemirror-model';

export const TableRowOverflowKey = new PluginKey("TableRowOverflow");
const RM_CLEANUP_META = "rmRowOverflowCleanup";

const LIMIT = 880;
const PULL_GAP = 24;
const PULL_MARGIN = 12;

const uuid = () => {
    const c: any = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const isCellType = (t: any) =>
    t?.spec?.tableRole === "cell" ||
    t?.spec?.tableRole === "header_cell" ||
    t?.name === "tableCell" ||
    t?.name === "tableHeader" ||
    t?.name === "table_cell" ||
    t?.name === "table_header";

const findCell = (state: EditorState) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d);
        if (isCellType(n.type)) return { node: n, pos: $from.before(d), depth: d };
    }
    return null;
};

const findRow = (state: EditorState) => {
    const { $from } = state.selection as any;
    for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d);
        if (n.type?.name === "tableRow" || n.type?.name === "table_row") return { node: n, pos: $from.before(d), depth: d };
    }
    return null;
};

const inCell = (state: EditorState) => !!findCell(state);

const currentCellEl = (view: EditorView) => {
    const { from } = view.state.selection;
    const at = view.domAtPos(from);
    const el = at.node instanceof HTMLElement ? at.node : at.node.parentElement;
    return (el?.closest?.("td,th") as HTMLElement | null) ?? null;
};

const isNormalCell = (cellNode: any) =>
    !cellNode?.attrs?.rmMergedTo &&
    !(cellNode?.attrs?.rmMergeOrigin && Number(cellNode?.attrs?.rmRowspan || 1) > 1);

const createEmptyCell = (templateCellNode: any, schema: any) => {
    const cellType = templateCellNode.type;
    const attrs = {
        ...(templateCellNode.attrs ?? {}),
        rmMergedTo: null,
        rmMergeOrigin: false,
        rmHideMode: null,
        rmRowspan: 1,
        rmCellId: null,
    };
    const filled = cellType.createAndFill?.(attrs);
    if (filled) return filled;

    const p = schema.nodes.paragraph?.createAndFill?.();
    return cellType.create(attrs, p ? [p] : undefined);
};
const isRowNode = (n: any) => !!n && (n.type?.name === "tableRow" || n.type?.name === "table_row");

const colIndexInDomRow = (view: EditorView) => {
    const cell = currentCellEl(view);
    if (!cell) return null;

    const tr = cell.closest("tr");
    if (!tr) return null;

    const cells = Array.from(tr.children).filter((n) => {
        const tag = (n as HTMLElement).tagName;
        return tag === "TD" || tag === "TH";
    });

    const idx = cells.indexOf(cell);
    return idx >= 0 ? idx : null;
};

const selectSameColInRow = (doc: any, rowPos: number, colIndex: number) => {
    const rowNode = doc.nodeAt(rowPos);
    if (!rowNode) return null;

    const target = Math.max(0, Math.min(colIndex, rowNode.childCount - 1));

    let pos = rowPos + 1;
    for (let i = 0; i < target; i++) pos += rowNode.child(i).nodeSize;

    return TextSelection.near(doc.resolve(pos + 1));
};

const buildGotoOrInsertTr = (view: EditorView) => {
    const { state } = view;

    const cell = findCell(state);
    const row = findRow(state);
    const table = findTable(state);
    if (!cell || !row || !table) return null;

    const colIndex = colIndexInDomRow(view) ?? state.selection.$from.index(row.depth);

    const rowId = row.node.attrs?.rmRowId as string | null;
    const linkedTo = row.node.attrs?.rmLinkedTo as string | null;

    const mainRowId = linkedTo || rowId || uuid();

    let tr = state.tr;
    const spanH = Number(cell.node.attrs?.rmRowspan ?? 1);

    const insertPos = !isNormalCell(cell.node) ? getInsertPosAfterRowspan(tr.doc, table.pos, row.pos, spanH)
                                                : (row.pos + row.node.nodeSize);

    const nextRow = state.doc.nodeAt(insertPos);

    if (isRowNode(nextRow) && nextRow?.attrs?.rmLinkedTo === mainRowId) {
        const sel = selectSameColInRow(state.doc, insertPos, colIndex);
        if (!sel) return null;
        return state.tr.setSelection(sel);
    }

    const cells = [];
    for (let i = 0; i < row.node.childCount; i++) {
        cells.push(createEmptyCell(row.node.child(i), state.schema));
    }

    const newRow = row.node.type.create(
        { ...row.node.attrs, rmRowId: null,   rmLinkedTo: mainRowId },
        cells,
    );

    if (!linkedTo && !rowId) {
        tr = tr.setNodeMarkup(row.pos, undefined, { ...row.node.attrs, rmRowId: mainRowId });
    }

    tr = tr.insert(insertPos, newRow);

    const sel = selectSameColInRow(tr.doc, insertPos, colIndex);
    if (sel) tr = tr.setSelection(sel);

    return tr;
};

const insertOrGotoLinkedRow = (view: EditorView) => {
    const tr = buildGotoOrInsertTr(view);
    if (!tr) return false;
    view.dispatch(tr);
    view.focus();
    return true;
};

const measureTextHeight = (contentEl: HTMLElement, text: string) => {
    const m = document.createElement("p");
    m.style.position = "fixed";
    m.style.left = "-99999px";
    m.style.top = "0";
    m.style.visibility = "hidden";
    m.style.margin = "0";
    m.style.whiteSpace = "pre-wrap";
    m.style.wordBreak = "break-word";
    const cs = window.getComputedStyle(contentEl);
    m.style.width = `${contentEl.clientWidth}px`;
    m.style.font = cs.font;
    m.style.fontSize = cs.fontSize;
    m.style.lineHeight = cs.lineHeight;
    m.style.letterSpacing = cs.letterSpacing;
    m.textContent = text;
    document.body.appendChild(m);
    const h = m.scrollHeight;
    m.remove();
    return h;
};

const isEmptyParagraph = (n: any) =>
    n?.type?.name === "paragraph" && n.content.size === 0;

const getMainRowId = (rowNode: any) =>
    (rowNode?.attrs?.rmLinkedTo as string | null) ||
    (rowNode?.attrs?.rmRowId as string | null) ||
    null;

const getNextLinkedRow = (state: EditorState, rowPos: number, rowNode: any, mainRowId: string) => {
    const table = findTable(state);
    const cell = findCell(state);
    if (!table || !cell) return null;

    const spanH = Number(cell.node.attrs?.rmRowspan ?? 1);
    const nextPos = !isNormalCell(cell.node)
        ? getInsertPosAfterRowspan(state.doc as any, table.pos, rowPos, spanH)
        : (rowPos + rowNode.nodeSize);

    const nextRow = state.doc.nodeAt(nextPos);
    if (isRowNode(nextRow) && nextRow?.attrs?.rmLinkedTo === mainRowId) {
        return { pos: nextPos, node: nextRow };
    }
    return null;
};

const getCellAtRowPos = (doc: any, rowPos: number, colIndex: number) => {
    const rowNode = doc.nodeAt(rowPos);
    if (!rowNode) return null;

    const target = Math.max(0, Math.min(colIndex, rowNode.childCount - 1));

    let pos = rowPos + 1;
    for (let i = 0; i < target; i++) pos += rowNode.child(i).nodeSize;

    const cellNode = doc.nodeAt(pos);
    if (!cellNode) return null;

    return { pos, node: cellNode };
};

const firstNonEmptyBlock = (cellNode: any) => {
    for (let i = 0; i < cellNode.childCount; i++) {
        const ch = cellNode.child(i);
        if (!(ch.type?.name === "paragraph" && ch.content.size === 0)) {
            return { node: ch, index: i };
        }
    }
    return null;
};

const cellInsertPosAtEnd = (cellPos: number, cellNode: any) => {
    let insertPos = cellPos + cellNode.nodeSize - 1;

    if (cellNode.childCount > 0) {
        const last = cellNode.child(cellNode.childCount - 1);
        if (isEmptyParagraph(last)) {
            insertPos -= last.nodeSize;
        }
    }
    return insertPos;
};

const pullUpOneBlockFromLinkedRow = (view: EditorView) => {
    const { state } = view;

    const row = findRow(state);
    const cell = findCell(state);
    if (!row || !cell) return false;

    const mainRowId = getMainRowId(row.node);
    if (!mainRowId) return false;

    const colIndex = colIndexInDomRow(view) ?? state.selection.$from.index(row.depth);

    const nextRow = getNextLinkedRow(state, row.pos, row.node, mainRowId);
    if (!nextRow) return false;

    const currCellEl = currentCellEl(view);
    if (!currCellEl) return false;

    const currContent =
        (currCellEl.querySelector(".rm-cell-content") as HTMLElement | null) ?? currCellEl;

    const available = LIMIT - getHeight(cell.node, currContent);
    if (available < PULL_GAP) return false;

    const nextCell = getCellAtRowPos(state.doc, nextRow?.pos, colIndex);
    if (!nextCell) return false;

    const movable = firstNonEmptyBlock(nextCell.node);
    if (!movable) return false;

    const nextCellDom = view.nodeDOM(nextCell.pos) as HTMLElement | null;
    const nextContent =
        (nextCellDom?.querySelector?.(".rm-cell-content") as HTMLElement | null) ?? nextCellDom;

    const blockEl = (nextContent?.children[movable.index] as HTMLElement | undefined) ?? null;
    const blockH = blockEl?.getBoundingClientRect().height ?? 0;

    if (blockH && blockH > available - PULL_MARGIN) return false;

    let blockPos = nextCell.pos + 1;
    for (let i = 0; i < movable.index; i++) blockPos += nextCell.node.child(i).nodeSize;

    const blockNode = movable.node;

    let tr = state.tr;

    tr = tr.delete(blockPos, blockPos + blockNode.nodeSize);

    const mappedNextCellPos = tr.mapping.map(nextCell.pos);
    tr = ensureCellHasAtLeastOneParagraph(tr, mappedNextCellPos, state.schema);

    const currCell = findCell(({ ...state, doc: tr.doc } as any));
    if (!currCell) return false;

    const insertAt = cellInsertPosAtEnd(currCell.pos, currCell.node);
    tr = tr.insert(insertAt, blockNode);

    const mappedNextRowPos = tr.mapping.map(nextRow?.pos);
    const nextRowNow = tr.doc.nodeAt(mappedNextRowPos);

    if (nextRowNow && isRowNode(nextRowNow) && isRowEffectivelyEmpty(nextRowNow)) {
        tr = tr.delete(mappedNextRowPos, mappedNextRowPos + nextRowNow.nodeSize);
    }

    view.dispatch(tr.scrollIntoView());
    return true;
};

const isCellEffectivelyEmpty = (cellNode: any) => {
    if (!cellNode) return true;

    if (cellNode.childCount === 0) return true;

    for (let i = 0; i < cellNode.childCount; i++) {
        const ch = cellNode.child(i);
        if (ch.type?.name !== "paragraph") return false;
        if (ch.content.size > 0) return false;
    }
    return true;
};

const isRowEffectivelyEmpty = (rowNode: any) => {
    if (!rowNode) return true;

    for (let i = 0; i < rowNode.childCount; i++) {
        const cell = rowNode.child(i);
        if (!isNormalCell(cell)) return false;

        if (!isCellEffectivelyEmpty(cell)) return false;
    }
    return true;
};

const ensureCellHasAtLeastOneParagraph = (tr: any, cellPos: number, schema: any) => {
    const cellNode = tr.doc.nodeAt(cellPos);
    if (!cellNode) return tr;

    if (cellNode.childCount > 0) return tr;

    const p = schema.nodes.paragraph?.createAndFill?.();
    if (!p) return tr;

    return tr.insert(cellPos + 1, p);
};

const getContentHeightPxFromBlocks = (content: HTMLElement): number => {
    const blocks = Array.from(content.children) as HTMLElement[];
    if (!blocks.length) return 0;

    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    for (const b of blocks) {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        const mt = parseFloat(cs.marginTop || "0") || 0;
        const mb = parseFloat(cs.marginBottom || "0") || 0;
        top = Math.min(top, r.top - mt);
        bottom = Math.max(bottom, r.bottom + mb);
    }

    const ccs = getComputedStyle(content);
    const padTop = parseFloat(ccs.paddingTop || "0") || 0;
    const padBottom = parseFloat(ccs.paddingBottom || "0") || 0;

    const h = (bottom - top) + padTop + padBottom;
    return Number.isFinite(h) ? Math.max(0, h) : content.scrollHeight;
};

const getInsertPosAfterRowspan = (doc: PMNode, tablePos: number, originRowPos: number, spanH: number): number => {
    const rows = collectRowPositionsInTable(doc, tablePos);
    const originRowNode = doc.nodeAt(originRowPos);
    if (!originRowNode) return originRowPos;

    const idx = rows.indexOf(originRowPos);
    if (idx === -1) return originRowPos + originRowNode.nodeSize;

    const safeSpan = Math.max(1, Number(spanH || 1));
    const lastRowPos = rows[Math.min(idx + safeSpan - 1, rows.length - 1)];
    const lastRowNode = doc.nodeAt(lastRowPos);
    if (!lastRowNode) return originRowPos + originRowNode.nodeSize;

    return lastRowPos + lastRowNode.nodeSize;
}

const collectRowPositionsInTable = (doc: PMNode, tablePos: number): number[] => {
    const table = doc.nodeAt(tablePos);
    if (!table || table.type.name !== 'table') return [];

    const rows: number[] = [];
    table.descendants((node, relPos) => {
        if (node.type.name === 'tableRow') rows.push(tablePos + 1 + relPos);
        return true;
    });

    rows.sort((a, b) => a - b);
    return rows;
}

const getHeight = (node:any, content: HTMLElement) => {
    if (isNormalCell(node)){
        return content.scrollHeight
    }
    return getContentHeightPxFromBlocks(content)
}

const findTable = (state: EditorState) => {
    const { $from } = state.selection as any;
    for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d);
        const role = n.type?.spec?.tableRole;
        if (n.type?.name === "table" || role === "table") {
            return { node: n, pos: $from.before(d), depth: d };
        }
    }
    return null;
};



const getMainIdFromRow = (rowNode: any): string | null => {
    return (rowNode?.attrs?.rmRowId as string | null) ?? null;
};

const collectMainRowIds = (doc: PMNode): Set<string> => {
    const ids = new Set<string>();
    doc.descendants((node) => {
        if (!isRowNode(node)) return true;
        const id = getMainIdFromRow(node);
        if (id) ids.add(String(id));
        return true;
    });
    return ids;
};

const deleteLinkedRowsForMainIds = (
    oldState: EditorState,
    newState: EditorState,
) => {
    const oldMainIds = collectMainRowIds(oldState.doc as any);
    if (oldMainIds.size === 0) return null;

    const newMainIds = collectMainRowIds(newState.doc as any);

    const deletedMainIds: string[] = [];
    for (const id of oldMainIds) {
        if (!newMainIds.has(id)) deletedMainIds.push(id);
    }
    if (deletedMainIds.length === 0) return null;

    const toDelete: Array<{ pos: number; size: number }> = [];

    newState.doc.descendants((node, pos) => {
        if (!isRowNode(node)) return true;

        const linkedTo = node.attrs?.rmLinkedTo as string | null;
        const rowId = node.attrs?.rmRowId as string | null;

        if (linkedTo && deletedMainIds.includes(String(linkedTo))) {
            toDelete.push({ pos, size: node.nodeSize });
        }

        if (rowId && deletedMainIds.includes(String(rowId))) {
            toDelete.push({ pos, size: node.nodeSize });
        }

        return true;
    });

    if (toDelete.length === 0) return null;

    toDelete.sort((a, b) => b.pos - a.pos);

    const tr = newState.tr;
    tr.setMeta(RM_CLEANUP_META, true);

    for (const d of toDelete) {
        const p = tr.mapping.map(d.pos);
        const n = tr.doc.nodeAt(p);
        if (n && isRowNode(n)) {
            tr.deleteRange(p, p + n.nodeSize);
        }
    }

    return tr.steps.length ? tr : null;
};

export const TableRowOverflow = new Plugin({
    key: TableRowOverflowKey,
    appendTransaction(transactions, oldState, newState) {
        if (transactions.some(t => t.getMeta(RM_CLEANUP_META))) return null;
        if (!transactions.some(t => t.docChanged)) return null;
        return deleteLinkedRowsForMainIds(oldState, newState);
    },

    props: {
        handlePaste(view, event, slice) {
            if (!inCell(view.state)) return false;

            const cell = findCell(view.state);
            if (!cell) return false;

            const cellEl = currentCellEl(view);
            if (!cellEl) return false;

            const content = (cellEl.querySelector(".rm-cell-content") as HTMLElement | null) ?? cellEl;

            const text = event.clipboardData?.getData("text/plain") ?? "";
            const addedHeight = measureTextHeight(content, text) ?? 0;
            const shouldRedirect = getHeight(cell.node, content) + addedHeight >= LIMIT
            if (!shouldRedirect) return false;
            event.preventDefault();

            const baseTr = buildGotoOrInsertTr(view);
            if (!baseTr) return false;

            view.dispatch(baseTr.replaceSelection(slice).scrollIntoView());
            view.focus();
            return true;
        },
    },

    view() {
        let lastRowKey = "";
        let wasOver = false;

        return {
            update(view: EditorView, prevState: EditorState) {
                if (view.state.doc.eq(prevState.doc)) return;
                if (!inCell(view.state)) return;

                requestAnimationFrame(() => {
                    const row = findRow(view.state);
                    const cell = findCell(view.state);
                    if (!row || !cell) return;

                    const key = String(row.node.attrs?.rmLinkedTo || row.node.attrs?.rmRowId || row.pos);
                    if (key !== lastRowKey) {
                        lastRowKey = key;
                        wasOver = false;
                    }

                    const cellEl = currentCellEl(view);
                    if (!cellEl) return;
                    const content = (cellEl.querySelector(".rm-cell-content") as HTMLElement | null) ?? cellEl;
                    const height = getHeight(cell.node, content);

                    const over = height >= LIMIT;
                    const under = height <= (LIMIT - PULL_GAP);
                    if (over && !wasOver) {
                        const ok = insertOrGotoLinkedRow(view);
                        if (ok) wasOver = true;
                    }

                    if (!over) wasOver = false;

                    if (under) {
                        pullUpOneBlockFromLinkedRow(view);
                    }

                });
            },
            destroy() {},
        };
    },
});
