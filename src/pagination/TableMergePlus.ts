import { Extension, type CommandProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { TableMap } from "prosemirror-tables";

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        TableMergePlus: {
            toggleTableMerge: () => ReturnType;
            mergeTableSelection: () => ReturnType;
            unmergeTableAtSelection: () => ReturnType;
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

function collectBlocks(node: PMNode): PMNode[] {
    const blocks: PMNode[] = [];
    node.content.forEach((child) => blocks.push(child));
    return blocks;
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

        return {
            mergeTableSelection: mergeInternal,
            unmergeTableAtSelection: unmergeInternal,
            toggleTableMerge:
                () =>
                    (props: CommandProps) => {
                        // if unmerge succeeds -> done, else try merge
                        return unmergeInternal()(props) || mergeInternal()(props);
                    },
        };
    },
});
