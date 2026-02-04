import { Node } from "@tiptap/pm/model";
import { Editor } from "@tiptap/core";

export class TablePlusNodeView {
    node: Node;
    getPos: () => number | undefined;
    editor: Editor;
    dom: HTMLElement;
    contentDOM: HTMLElement;

    maxCellCount: number;
    cellPercentage: number[];
    columnSize: string;

    slider: HTMLElement; // overlay for resize handles
    handles: HTMLElement[];
    lockBadge: HTMLElement;
    options: any;

    isRTL: boolean;
    isLocked: boolean;

    // observe direction changes
    private dirObserver?: MutationObserver;

    rowspanLayer: HTMLElement;
    private rafRowspan?: number;
    private layoutObserver?: ResizeObserver;
    private isAdjustingHeights = false;
    constructor(
        node: Node,
        getPos: () => number | undefined,
        editor: Editor,
        options: any
    ) {
        this.node = node;
        this.columnSize = node.attrs.columnSize;
        this.getPos = getPos;
        this.editor = editor;
        this.options = options ?? {};

        this.isRTL = this.getIsRTL();
        this.isLocked = Boolean(node.attrs?.locked);

        // Root wrapper for the table + overlay
        this.dom = document.createElement("div");
        this.dom.style.position = "relative"; // containing block for absolute overlay

        this.maxCellCount = 0;
        this.cellPercentage = [];
        this.handles = [];

        // The table content element
        this.contentDOM = document.createElement("table");
        this.contentDOM.classList.add("table-plus");
        this.contentDOM.style.flex = "1";
        this.dom.appendChild(this.contentDOM);
        this.rowspanLayer = document.createElement("div");
        this.rowspanLayer.contentEditable = "false";
        this.rowspanLayer.style.position = "absolute";
        this.rowspanLayer.style.inset = "0";
        this.rowspanLayer.style.zIndex = "0";
        this.rowspanLayer.style.pointerEvents = "none";
        this.dom.appendChild(this.rowspanLayer);
        // Absolute overlay that spans the table area
        this.slider = document.createElement("div");
        this.slider.contentEditable = "false";
        this.slider.style.position = "absolute";
        this.slider.style.inset = "0";             // top/right/bottom/left: 0
        this.slider.style.zIndex = "2";             // below handle z-index but above table content
        this.slider.style.pointerEvents = "none";   // ignore events; handles will re-enable
        this.dom.appendChild(this.slider);

        // Lock badge overlay
        this.lockBadge = this.createLockBadge();
        this.dom.appendChild(this.lockBadge);

        // Initialize sizes + handles
        this.updateNode(node);

        // Start observing direction changes (e.g., switching to Arabic)
        this.startDirectionObserver();
        this.scheduleInitialRowspanRender();
        this.setupLayoutObserver();

    }

    private scheduleInitialRowspanRender() {
        // Use multiple rAF to ensure layout is complete
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Additional delay for fonts/styles to load
                setTimeout(() => {
                    this.scheduleRowspanRender();
                }, 100);
            });
        });
    }
    // Observe direction changes on editor root and document
    private startDirectionObserver() {
        const editorEl = this.editor.view.dom as HTMLElement;

        const check = () => {
            const nextRTL = this.getIsRTL();
            if (nextRTL !== this.isRTL) {
                this.isRTL = nextRTL;
                // Rebuild handles so left/right/transform are correct
                this.updateHandles();
                // Ensure handle positions reflect current percentages
                this.updateHandlePositions();
                this.scheduleRowspanRender();
            }
        };

        // Run once after mount
        requestAnimationFrame(check);

        this.dirObserver = new MutationObserver(() => {
            requestAnimationFrame(check);
        });

        this.dirObserver.observe(editorEl, {
            attributes: true,
            attributeFilter: ["dir", "lang", "style", "class"],
        });

        this.dirObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["dir", "lang"],
        });
    }
    private setupLayoutObserver() {
        this.layoutObserver = new ResizeObserver(() => {
            if (this.isAdjustingHeights) return;
            this.scheduleRowspanRender();
        });
        this.layoutObserver.observe(this.dom);
    }

    // Called by ProseMirror when nodeview is removed
    destroy() {
        this.dirObserver?.disconnect();
        this.dirObserver = undefined;
        this.layoutObserver?.disconnect();
        if (this.rafRowspan) cancelAnimationFrame(this.rafRowspan);
    }

    private adjustRowHeightsForMergedCells() {
        if (this.isAdjustingHeights) return;
        this.isAdjustingHeights = true;

        try {
            let styleEl = this.dom.querySelector('style.rm-height-styles') as HTMLStyleElement;
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.className = 'rm-height-styles';
                this.dom.appendChild(styleEl);
            }

            const origins = Array.from(
                this.dom.querySelectorAll<HTMLElement>(
                    'td[data-rm-merge-origin="true"], th[data-rm-merge-origin="true"]',
                ),
            );

            let cssRules = '';

            for (const origin of origins) {
                const rowspan = Number(origin.getAttribute('data-rm-rowspan') || '1');
                if (rowspan <= 1) continue;

                const id = origin.getAttribute('data-rm-cell-id');
                if (!id) continue;

                const content = origin.querySelector<HTMLElement>('.rm-cell-content');
                if (!content) continue;

                const members = [
                    origin,
                    ...Array.from(
                        this.dom.querySelectorAll<HTMLElement>(
                            `td[data-rm-merged-to="${id}"], th[data-rm-merged-to="${id}"]`,
                        ),
                    ),
                ];

                const visibleMembers = members.filter((el) => getComputedStyle(el).display !== 'none');
                if (visibleMembers.length === 0) continue;

                // Get merge width from visible members
                let minL = Infinity, maxR = -Infinity;
                for (const el of visibleMembers) {
                    const r = el.getBoundingClientRect();
                    minL = Math.min(minL, r.left);
                    maxR = Math.max(maxR, r.right);
                }
                const mergeWidth = maxR - minL;

                // Measure content height in isolation
                const originalPosition = content.style.position;
                const originalInset = content.style.inset;
                const originalWidth = content.style.width;
                const originalHeight = content.style.height;
                const originalMinHeight = content.style.minHeight;

                content.style.position = 'static';
                content.style.inset = '';
                content.style.width = `${mergeWidth}px`;
                content.style.height = 'auto';
                content.style.minHeight = 'auto';

                void content.offsetHeight;
                const contentHeight = content.scrollHeight;

                content.style.position = originalPosition;
                content.style.inset = originalInset;
                content.style.width = originalWidth;
                content.style.height = originalHeight;
                content.style.minHeight = originalMinHeight;

                origin.style.setProperty('--rm-merge-w', `${mergeWidth}px`);

                const buffer = 45;
                const minHeightPerCell = 53.93;
                let requiredHeightPerCell = Math.max(
                    minHeightPerCell,
                    Math.ceil((contentHeight + buffer) / rowspan)
                );

                requiredHeightPerCell = Math.min(requiredHeightPerCell, 440);

                const lastHeight = origin.dataset.rmLastHeight;
                const newHeight = requiredHeightPerCell.toString();

                if (lastHeight && Math.abs(parseInt(lastHeight) - requiredHeightPerCell) < 5) {
                    continue;
                }
                origin.dataset.rmLastHeight = newHeight;

                origin.style.setProperty('--rm-merge-h', `${requiredHeightPerCell * rowspan}px`);

                for (const member of visibleMembers) {
                    const cellId = member.getAttribute('data-rm-cell-id');
                    const mergedTo = member.getAttribute('data-rm-merged-to');
                    const selector = cellId
                        ? `[data-rm-cell-id="${cellId}"]`
                        : mergedTo
                            ? `[data-rm-merged-to="${mergedTo}"]`
                            : null;

                    if (selector) {
                        cssRules += `${selector} { height: ${requiredHeightPerCell}px !important; }\n`;
                    }
                }
            }

            const needsHeightAdjustment = cssRules.trim().length > 0;
            const hadRules = (styleEl.textContent || '').trim().length > 0;

            if (needsHeightAdjustment || hadRules) {
                styleEl.textContent = cssRules;
            }

            requestAnimationFrame(() => {
                this.renderRowspanOverlays();
            });

        } finally {
            setTimeout(() => {
                this.isAdjustingHeights = false;
            }, 20);
        }
    }
    private scheduleRowspanRender() {
        if (this.rafRowspan) cancelAnimationFrame(this.rafRowspan);
        this.rafRowspan = requestAnimationFrame(() => {
            const rect = this.dom.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
                setTimeout(() => this.scheduleRowspanRender(), 50);
                return;
            }
            this.adjustRowHeightsForMergedCells();
        });
    }

    private renderRowspanOverlays() {
        this.rowspanLayer.innerHTML = "";

        const wrapperRect = this.dom.getBoundingClientRect();

        const origins = Array.from(
            this.dom.querySelectorAll<HTMLElement>(
                'td[data-rm-merge-origin="true"], th[data-rm-merge-origin="true"]'
            )
        );

        for (const origin of origins) {
            const rowspan = Number(origin.getAttribute("data-rm-rowspan") || "1");
            if (rowspan <= 1) continue; // only needed when vertical merge exists

            const id = origin.getAttribute("data-rm-cell-id");
            if (!id) continue;

            const members = [
                origin,
                ...Array.from(
                    this.dom.querySelectorAll<HTMLElement>(
                        `td[data-rm-merged-to="${id}"], th[data-rm-merged-to="${id}"]`
                    )
                ),
            ].filter((el) => getComputedStyle(el).display !== "none");

            if (!members.length) continue;

            // union rect
            let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
            for (const el of members) {
                const r = el.getBoundingClientRect();
                minL = Math.min(minL, r.left);
                minT = Math.min(minT, r.top);
                maxR = Math.max(maxR, r.right);
                maxB = Math.max(maxB, r.bottom);
            }

            const printHeight = (maxB - minT) + rowspan;
            // ✅ surface (fills merged area)
            const surface = document.createElement("div");
            surface.className = "rm-merge-surface";
            surface.style.position = "absolute";
            surface.style.left = `${minL - wrapperRect.left}px`;
            surface.style.top = `${minT - wrapperRect.top}px`;
            surface.style.width = `${maxR - minL}px`;
            surface.style.height = `${maxB - minT}px`;
            surface.style.boxSizing = "border-box";
            surface.style.pointerEvents = "none"; // keep editing on real cells
            surface.style.setProperty('--print-height', `${printHeight }px`);
            // match origin background if any
            const bg = getComputedStyle(origin).backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
                surface.style.backgroundColor = bg;
            } else {
                surface.style.backgroundColor = "transparent";
            }

            const borderColor = getComputedStyle(this.dom).getPropertyValue('--table-border-color').trim() || 'black';
            surface.style.border = `1px solid ${borderColor}`;

            this.rowspanLayer.appendChild(surface);
        }
    }


    // Create full-height line handles and wire drag logic
    addHandles() {
        const locked = this.isLocked;
        const dragHandle = (handle: HTMLElement) => {
            let handleIndex = parseInt(handle.dataset.index ?? "0");

            const onMove = (clientX: number) => {
                const rect = this.slider.getBoundingClientRect();

                // position of pointer relative to overlay rect, respecting RTL
                let x = this.isRTL ? rect.right - clientX : clientX - rect.left;
                x = Math.max(x, this.options.minColumnSize ?? 0);

                let percent = Math.min(Math.max((x / rect.width) * 100, 0), 100);

                const getHandlePosition = (h: HTMLElement) => {
                    return this.isRTL
                        ? parseFloat(h.style.right || "0")
                        : parseFloat(h.style.left || "0");
                };

                // Enforce min size with previous handle
                if (handleIndex > 0) {
                    const prev = getHandlePosition(this.handles[handleIndex - 1]);
                    percent = Math.max(percent, prev);
                }

                // Enforce min size with next handle
                if (handleIndex < this.handles.length - 1) {
                    const next = getHandlePosition(this.handles[handleIndex + 1]);
                    percent = Math.min(percent, next);
                }

                if (this.isRTL) {
                    handle.style.right = percent + "%";
                    handle.style.left = "auto";
                } else {
                    handle.style.left = percent + "%";
                    handle.style.right = "auto";
                }

                this.updateValues(this.getColumnSizes(this.handles), false);
            };

            // Pointer events (covers mouse + touch + pen)
            const onPointerMove = (e: PointerEvent) => {
                e.preventDefault();
                onMove(e.clientX);
            };
            const onPointerUp = (e: PointerEvent) => {
                e.preventDefault();
                document.removeEventListener("pointermove", onPointerMove);
                document.removeEventListener("pointerup", onPointerUp);
                this.scheduleRowspanRender();
                this.updateValues(this.getColumnSizes(this.handles), true);
            };

            handle.addEventListener("pointerdown", (e: PointerEvent) => {
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                e.preventDefault();
                handleIndex = parseInt(handle.dataset.index ?? "0");

                // ✅ Get handle position
                const handleRect = handle.getBoundingClientRect();
                const handleCenterX = handleRect.left + handleRect.width / 2;

                // ✅ Hide only borders that are near the handle
                this.rowspanLayer.querySelectorAll<HTMLElement>('.rm-merge-surface').forEach(surface => {
                    const surfaceRect = surface.getBoundingClientRect();
                    const tolerance = 10; // pixels

                    // Check if handle is near the left edge of surface
                    if (Math.abs(surfaceRect.left - handleCenterX) < tolerance) {
                        surface.style.borderLeftColor = 'transparent';
                    }
                    // Check if handle is near the right edge of surface
                    if (Math.abs(surfaceRect.right - handleCenterX) < tolerance) {
                        surface.style.borderRightColor = 'transparent';
                    }
                });

                document.addEventListener("pointermove", onPointerMove);
                document.addEventListener("pointerup", onPointerUp);
            });

            // Mouse fallback (older browsers)
            const onMouseMove = (e: MouseEvent) => {
                e.preventDefault();
                onMove(e.clientX);
            };
            const onMouseUp = (e: MouseEvent) => {
                e.preventDefault();
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                this.updateValues(this.getColumnSizes(this.handles), true);
            };
            handle.addEventListener("mousedown", (e) => {
                e.preventDefault();
                handleIndex = parseInt(handle.dataset.index ?? "0");
                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);
            });
        };

        let lastValue = 0;

        for (let index = 0; index < this.cellPercentage.length; index++) {
            lastValue += this.cellPercentage[index];

            if (index >= this.handles.length) {
                const handle = document.createElement("div");
                handle.className = "handle";
                handle.dataset.index = index.toString();

                // Placement within overlay
                handle.style.position = "absolute";
                handle.style.top = "0";
                handle.style.height = "100%";
                handle.style.width = (this.options.resizeHandleStyle?.width as string) || "12px"; // hit-area width
                handle.style.zIndex = "2";
                handle.style.pointerEvents = locked ? "none" : "auto";
                handle.style.cursor = locked ? "not-allowed" : "ew-resize";
                handle.style.touchAction = "none";
                // Allow user overrides via options
                if (this.options.resizeHandleStyle) {
                    Object.assign(handle.style, this.options.resizeHandleStyle);
                }

                if (this.isRTL) {
                    handle.style.right = `${lastValue}%`;
                    handle.style.left = "auto";
                    handle.style.transform = "translateX(50%)";  // center over seam (RTL)
                } else {
                    handle.style.left = `${lastValue}%`;
                    handle.style.right = "auto";
                    handle.style.transform = "translateX(-50%)"; // center over seam (LTR)
                }

                this.slider.appendChild(handle);
                this.handles.push(handle);
                if (!locked) {
                    dragHandle(handle);
                }
            }
        }
    }

    removeHandles() {
        while (this.handles.length > this.cellPercentage.length) {
            const handle = this.handles[this.handles.length - 1];
            if (!handle) break;
            if (handle.parentNode === this.slider) this.slider.removeChild(handle);
            this.handles.splice(this.handles.length - 1, 1);
        }
        this.handles.forEach((h, i) => (h.dataset.index = i.toString()));
    }

    updateHandlePositions() {
        let lastValue = 0;
        for (let index = 0; index < this.cellPercentage.length; index++) {
            lastValue += this.cellPercentage[index];
            const h = this.handles[index];
            if (!h) continue;

            if (this.isRTL) {
                h.style.right = `${lastValue}%`;
                h.style.left = "auto";
                h.style.transform = "translateX(50%)";  // X only
            } else {
                h.style.left = `${lastValue}%`;
                h.style.right = "auto";
                h.style.transform = "translateX(-50%)"; // X only
            }
        }
    }

    updateHandles() {
        // clear current handles
        this.handles.forEach((handle) => {
            if (handle.parentNode === this.slider) this.slider.removeChild(handle);
        });
        this.handles = [];

        // recreate with current direction and percentages
        this.addHandles();
    }

    getIsRTL(): boolean {
        const editorElement = this.editor.view.dom as HTMLElement;
        const computedStyle = window.getComputedStyle(editorElement);
        const direction = computedStyle.direction;

        if (
            direction === "rtl" ||
            document.dir === "rtl" ||
            document.documentElement.dir === "rtl"
        ) {
            return true;
        }

        const lang = editorElement.lang || document.documentElement.lang || "";
        const rtlLanguages = ["ar"];
        return rtlLanguages.some((rtlLang) => lang.startsWith(rtlLang));
    }

    private applyTableStyles(node: Node) {
        const tableExt = this.editor.extensionManager.extensions.find((ext) => ext.name === "table") as any;
        const fallbackBorder = tableExt?.options?.borderColor || "black";
        const effectiveBorder = (node.attrs.borderColor as string | null) || fallbackBorder;
        this.dom.style.setProperty("--table-border-color", effectiveBorder);
        this.contentDOM.style.setProperty("--table-border-color", effectiveBorder);
    }


    updateNode(node: Node) {
        this.isRTL = this.getIsRTL();
        this.isLocked = Boolean(node.attrs.locked);
        this.applyTableStyles(node);
        this.columnSize = node.attrs.columnSize;

        let _maxCellCount = 0;
        node.forEach((child) => {
            if (child.type.name === "tableRowGroup") {
                child.forEach((row) => {
                    if (row.type.name === "tableRow") {
                        if (row.childCount > _maxCellCount) _maxCellCount = row.childCount;
                    }
                });
            } else if (child.type.name === "tableRow") {
                if (child.childCount > _maxCellCount) _maxCellCount = child.childCount;
            }
        });

        this.maxCellCount = _maxCellCount;

        const getColumnSizeList = (columnSize: string) => {
            const arr = columnSize.split(",").map((str) => str.trim());
            const numbers =
                arr.length > 0 && arr.every((item) => item !== "" && !isNaN(Number(item)))
                    ? arr.map(Number)
                    : [];
            return numbers;
        };

        this.dom.style.setProperty("--cell-count", this.maxCellCount.toString());

        // default equal distribution
        const base = Math.floor(100 / Math.max(this.maxCellCount, 1));
        this.cellPercentage = Array(this.maxCellCount).fill(base);

        const columnSize = getColumnSizeList(this.columnSize);
        if (columnSize.length === this.maxCellCount) {
            this.cellPercentage = columnSize;
        } else if (this.maxCellCount > 0) {
            // ensure sum to 100 (avoid rounding drift)
            const sum = this.cellPercentage.reduce((a, b) => a + b, 0);
            this.cellPercentage[this.cellPercentage.length - 1] += 100 - sum;
        }

        this.dom.style.setProperty(
            "--cell-percentage",
            this.cellPercentage.map((a) => `${a}%`).join(" ")
        );

        // ensure handles count matches and direction is respected
        this.updateHandles();
        this.updateLockBadge();
        this.scheduleRowspanRender();

    }

    getColumnSizes(handles: HTMLElement[]) {
        const values = handles.map((h) => {
            const position = this.isRTL
                ? parseFloat(h.style.right || "0")
                : parseFloat(h.style.left || "0");
            return Math.round(position * 100) / 100;
        });

        let counted = 0;
        const _values: number[] = [];
        for (let i = 0; i < values.length; i++) {
            _values.push(Math.round((values[i] - counted) * 100) / 100);
            counted = values[i];
        }
        return _values;
    }

    updateValues(_values: number[], updateNode: boolean = false) {
        this.cellPercentage = [..._values];
        this.dom.style.setProperty(
            "--cell-percentage",
            _values.map((a) => `${a}%`).join(" ")
        );

        if (this.isLocked && updateNode) {
            return;
        }

        if (updateNode) {
            this.scheduleRowspanRender();
            this.editor.commands.command(({ tr }) => {
                const pos = this.getPos();
                if (typeof pos !== "number") return false;

                tr.setNodeMarkup(pos, undefined, {
                    ...this.node.attrs,
                    columnSize: _values.map((a) => a.toString()).join(","),
                });

                return true;
            });
        }
    }

    getContentDOM() {
        return this.contentDOM;
    }

    update(node: Node) {
        if (node.type.name === this.node.type.name) {
            this.updateNode(node);
        }
        this.node = node;
        return true;
    }

    ignoreMutation() {
        return true;
    }

    private createLockBadge() {
        const badge = document.createElement("div");
        badge.className =
            "pointer-events-none absolute top-0 left-0 z-10 flex size-[33px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-gray-200 p-0 select-none hidden";
        badge.setAttribute("aria-hidden", "true");
        badge.setAttribute("contenteditable", "false");

        badge.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="text-gray-800">
            <path d="M4 6.66537V5.33203C4 3.12536 4.66667 1.33203 8 1.33203C11.3333 1.33203 12 3.12536 12 5.33203V6.66537" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M8.00065 12.3333C8.92113 12.3333 9.66732 11.5871 9.66732 10.6667C9.66732 9.74619 8.92113 9 8.00065 9C7.08018 9 6.33398 9.74619 6.33398 10.6667C6.33398 11.5871 7.08018 12.3333 8.00065 12.3333Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M11.332 14.666H4.66536C1.9987 14.666 1.33203 13.9993 1.33203 11.3327V9.99935C1.33203 7.33268 1.9987 6.66602 4.66536 6.66602H11.332C13.9987 6.66602 14.6654 7.33268 14.6654 9.99935V11.3327C14.6654 13.9993 13.9987 14.666 11.332 14.666Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
        return badge;
    }

    private updateLockBadge() {
        if (!this.lockBadge) return;
        if (this.isLocked) {
            this.lockBadge.classList.remove("hidden");
        } else {
            this.lockBadge.classList.add("hidden");
        }
    }
}
