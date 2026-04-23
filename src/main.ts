import { Notice, Plugin, TFile, setIcon } from "obsidian";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";

type Tool = "pen" | "marker" | "eraser" | "lasso" | "image";

type Point = {
	x: number;
	y: number;
};

type StrokeItem = {
	id: string;
	type: "stroke";
	mode: "pen" | "marker";
	color: string;
	width: number;
	opacity: number;
	points: Point[];
};

type ImageItem = {
	id: string;
	type: "image";
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

type AnnotationItem = StrokeItem | ImageItem;

type FileAnnotationState = {
	items: AnnotationItem[];
};

type PluginData = {
	files: Record<string, FileAnnotationState>;
};

type PdfViewLike = {
	containerEl: HTMLElement;
	file?: TFile;
	getViewType?: () => string;
};

type ControllerOptions = {
	plugin: PdfInkPlugin;
	file: TFile;
	viewerEl: HTMLElement;
	toolbarEl: HTMLElement;
	state: FileAnnotationState;
};

type PdfPageMetric = {
	pageNumber: number;
	left: number;
	top: number;
	width: number;
	height: number;
};

type BrushPreset = {
	id: string;
	mode: "pen" | "marker";
	color: string;
	width: number;
	opacity: number;
	shape: "circle" | "diamond";
};

const EMPTY_DATA: PluginData = { files: {} };
const PDF_INK_ANNOT_PREFIX = "pdf-ink-";
const BRUSH_PRESETS: BrushPreset[] = [
	{ id: "pen-black", mode: "pen", color: "#111111", width: 3, opacity: 1, shape: "circle" },
	{ id: "pen-cyan", mode: "pen", color: "#3da4ff", width: 3, opacity: 1, shape: "circle" },
	{ id: "pen-pink", mode: "pen", color: "#ff4fa0", width: 3, opacity: 1, shape: "circle" },
	{ id: "marker-yellow", mode: "marker", color: "#ffd84d", width: 14, opacity: 0.35, shape: "diamond" }
];

function deepCloneState(state: FileAnnotationState): FileAnnotationState {
	return JSON.parse(JSON.stringify(state)) as FileAnnotationState;
}

function deepClonePluginData(data: PluginData): PluginData {
	return JSON.parse(JSON.stringify(data)) as PluginData;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		const intersect = ((yi > point.y) !== (yj > point.y))
			&& (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-6) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const apx = point.x - a.x;
	const apy = point.y - a.y;
	const ab2 = abx * abx + aby * aby;
	if (ab2 === 0) {
		return Math.hypot(point.x - a.x, point.y - a.y);
	}
	const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
	const cx = a.x + t * abx;
	const cy = a.y + t * aby;
	return Math.hypot(point.x - cx, point.y - cy);
}

function hexToRgbNormalized(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	const safe = cleaned.length === 3
		? cleaned.split("").map((char) => `${char}${char}`).join("")
		: cleaned.padEnd(6, "0").slice(0, 6);
	const value = Number.parseInt(safe, 16);
	return {
		r: ((value >> 16) & 255) / 255,
		g: ((value >> 8) & 255) / 255,
		b: (value & 255) / 255
	};
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export default class PdfInkPlugin extends Plugin {
	private dataStore: PluginData = EMPTY_DATA;
	private currentController: PdfOverlayController | null = null;
	private saveTimer: number | null = null;
	isApplyingToPdf = false;

	async onload() {
		const loaded = await this.loadData();
		this.dataStore = loaded?.files ? loaded as PluginData : deepClonePluginData(EMPTY_DATA);

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleAttach()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleAttach()));
		this.registerInterval(window.setInterval(() => this.scheduleAttach(), 1200));

		this.addCommand({
			id: "pdf-ink-undo",
			name: "PDF Ink: Undo",
			callback: () => this.currentController?.undo()
		});

		this.addCommand({
			id: "pdf-ink-redo",
			name: "PDF Ink: Redo",
			callback: () => this.currentController?.redo()
		});

		this.addCommand({
			id: "pdf-ink-apply",
			name: "PDF Ink: Save overlays to PDF file",
			callback: () => {
				void this.currentController?.applyToPdf();
			}
		});

		this.scheduleAttach();
	}

	onunload() {
		if (this.currentController) {
			this.currentController.destroy();
			this.currentController = null;
		}
	}

	getFileState(path: string): FileAnnotationState {
		return this.dataStore.files[path]
			? deepCloneState(this.dataStore.files[path])
			: { items: [] };
	}

	updateFileState(path: string, state: FileAnnotationState) {
		this.dataStore.files[path] = deepCloneState(state);
		this.scheduleSave();
	}

	private scheduleSave() {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveData(this.dataStore);
		}, 300);
	}

	private scheduleAttach() {
		window.setTimeout(() => this.attachToActivePdf(), 50);
	}

	private attachToActivePdf() {
		const activeLeaf = (this.app.workspace as unknown as { activeLeaf?: { view?: PdfViewLike } }).activeLeaf;
		const view = activeLeaf?.view;

		if (!view || view.getViewType?.() !== "pdf" || !(view.file instanceof TFile)) {
			if (this.currentController) {
				this.currentController.destroy();
				this.currentController = null;
			}
			return;
		}

		const viewerEl = view.containerEl.querySelector<HTMLElement>(".pdfViewer");
		const toolbarEl = view.containerEl.querySelector<HTMLElement>(".pdf-toolbar");
		if (!viewerEl || !toolbarEl) {
			window.setTimeout(() => this.attachToActivePdf(), 200);
			return;
		}

		if (
			this.currentController
			&& this.currentController.matches(view.file.path, viewerEl, toolbarEl)
		) {
			return;
		}

		// PDF書き込み中はビューを再構築しない（ファイル変更検知による誤再構築防止）
		if (this.isApplyingToPdf) {
			window.setTimeout(() => this.attachToActivePdf(), 600);
			return;
		}

		if (this.currentController) {
			this.currentController.destroy();
		}
		this.currentController = new PdfOverlayController({
			plugin: this,
			file: view.file,
			viewerEl,
			toolbarEl,
			state: this.getFileState(view.file.path)
		});
	}
}

class PdfOverlayController {
	private readonly plugin: PdfInkPlugin;
	private readonly file: TFile;
	private readonly viewerEl: HTMLElement;
	private readonly toolbarEl: HTMLElement;
	private readonly overlayEl: HTMLElement;
	private readonly drawCanvas: HTMLCanvasElement;
	private readonly helperCanvas: HTMLCanvasElement;
	private readonly drawCtx: CanvasRenderingContext2D;
	private readonly helperCtx: CanvasRenderingContext2D;
	private readonly toolbarGroup: HTMLElement;
	private readonly pendingImageEl: HTMLElement;
	private readonly lassoMenuEl: HTMLElement;
	private readonly resizeObserver: ResizeObserver;
	private readonly imageCache = new Map<string, HTMLImageElement>();
	private activeTool: Tool = "pen";
	private selectedPresetId = "pen-black";
	private eraserThreshold = 16;
	private state: FileAnnotationState;
	private past: FileAnnotationState[] = [];
	private future: FileAnnotationState[] = [];
	private selectionIds = new Set<string>();
	private lassoPolygon: Point[] = [];
	private draggingSelection = false;
	private pointerDown = false;
	private mutationSnapshot: FileAnnotationState | null = null;
	private drawingStroke: StrokeItem | null = null;
	private pendingImage: { src: string; width: number; height: number } | null = null;
	private previousPointer: Point | null = null;
	private copiedSelection: AnnotationItem[] = [];
	private redrawQueued = false;
	private isApplying = false;
	private isDirty = false;
	private pageResizeObserver!: ResizeObserver;
	private pageMutationObserver!: MutationObserver;
	private scrollContainer: HTMLElement | null = null;
	private scrollContainerOverflow = "";
	private activeTouchPointers = new Set<number>();
	private onWindowResize = () => this.render();

	constructor(options: ControllerOptions) {
		this.plugin = options.plugin;
		this.file = options.file;
		this.viewerEl = options.viewerEl;
		this.toolbarEl = options.toolbarEl;
		this.state = options.state;

		if (!this.viewerEl.style.position) {
			this.viewerEl.style.position = "relative";
		}
		// PDF.jsがInk注釈を独自レンダリングするとキャンバスと二重になるのを防ぐ
		this.viewerEl.classList.add("pdf-ink-active");

		this.overlayEl = createDiv({ cls: "pdf-ink-overlay" });
		this.drawCanvas = createEl("canvas", { cls: "pdf-ink-overlay-canvas" });
		this.helperCanvas = createEl("canvas", { cls: "pdf-ink-overlay-canvas" });

		const drawCtx = this.drawCanvas.getContext("2d");
		const helperCtx = this.helperCanvas.getContext("2d");
		if (!drawCtx || !helperCtx) {
			throw new Error("Canvas context creation failed");
		}
		this.drawCtx = drawCtx;
		this.helperCtx = helperCtx;

		this.overlayEl.append(this.drawCanvas, this.helperCanvas);
		this.viewerEl.appendChild(this.overlayEl);

		const { group, pendingImageEl, lassoMenuEl } = this.buildToolbar();
		this.toolbarGroup = group;
		this.pendingImageEl = pendingImageEl;
		this.lassoMenuEl = lassoMenuEl;
		this.toolbarEl.appendChild(this.toolbarGroup);
		// overlayEl の外に置くことで、メニュークリックがオーバーレイのイベントに干渉しない
		this.viewerEl.appendChild(this.lassoMenuEl);
		this.refreshToolbarState();

		this.resizeObserver = new ResizeObserver(() => this.render());
		this.resizeObserver.observe(this.viewerEl);

		// ズーム時にページ要素がリサイズされたときも再描画する
		this.pageResizeObserver = new ResizeObserver(() => this.render());
		for (const pageEl of Array.from(this.viewerEl.querySelectorAll<HTMLElement>(".page"))) {
			this.pageResizeObserver.observe(pageEl);
		}

		// PDF.jsがズーム時に.pageを作り直すと監視が途切れるため、追加されたページを再観測する
		// subtree: true にしてネストした構造でも確実に検知する
		this.pageMutationObserver = new MutationObserver(() => {
			for (const pageEl of Array.from(this.viewerEl.querySelectorAll<HTMLElement>(".page"))) {
				this.pageResizeObserver.observe(pageEl);
			}
			this.render();
		});
		this.pageMutationObserver.observe(this.viewerEl, { childList: true, subtree: true });

		// ズーム後にPDF.jsがスクロール位置を調整するタイミングでも再描画する
		this.viewerEl.addEventListener("scroll", () => this.render());
		// ブラウザレベルのズーム（ビューポートサイズ変更）にも対応する
		window.addEventListener("resize", this.onWindowResize);

		// Apple Pencil描画中にスクロールを止めるためのコンテナを探す
		let scanEl: HTMLElement | null = this.viewerEl.parentElement;
		while (scanEl) {
			const ov = getComputedStyle(scanEl).overflow;
			if (ov.includes("auto") || ov.includes("scroll")) {
				this.scrollContainer = scanEl;
				break;
			}
			scanEl = scanEl.parentElement;
		}

		this.bindPointerEvents();
		this.render();
	}

	matches(path: string, viewerEl: HTMLElement, toolbarEl: HTMLElement): boolean {
		return this.file.path === path && this.viewerEl === viewerEl && this.toolbarEl === toolbarEl;
	}

	destroy() {
		// 未保存の変更があればPDFから離れるタイミングで保存する（描画中に保存しないため）
		if (this.isDirty) {
			void this.applyToPdf(true);
		}
		this.unlockScroll();
		window.removeEventListener("resize", this.onWindowResize);
		this.viewerEl.classList.remove("pdf-ink-active");
		this.resizeObserver.disconnect();
		this.pageResizeObserver.disconnect();
		this.pageMutationObserver.disconnect();
		this.overlayEl.remove();
		this.toolbarGroup.remove();
		this.lassoMenuEl.remove();
	}

	undo() {
		const prev = this.past.pop();
		if (!prev) return;
		this.future.push(deepCloneState(this.state));
		this.state = deepCloneState(prev);
		this.plugin.updateFileState(this.file.path, this.state);
		this.isDirty = true;
		this.render();
	}

	redo() {
		const next = this.future.pop();
		if (!next) return;
		this.past.push(deepCloneState(this.state));
		this.state = deepCloneState(next);
		this.plugin.updateFileState(this.file.path, this.state);
		this.isDirty = true;
		this.render();
	}

	async applyToPdf(silent = false) {
		if (this.isApplying) return;
		if (this.state.items.length === 0) {
			if (!silent) new Notice("Nothing to save.");
			return;
		}

		const pageMetrics = this.getPageMetrics();
		if (pageMetrics.length === 0) {
			if (!silent) new Notice("Could not read PDF page layout.");
			return;
		}

		this.isApplying = true;
		this.plugin.isApplyingToPdf = true;
		try {
			const sourceBinary = await this.plugin.app.vault.adapter.readBinary(this.file.path);
			const pdfDoc = await PDFDocument.load(sourceBinary);
			const pages = pdfDoc.getPages();
			this.removePluginAnnotations(pages);

			let skippedImageCount = 0;
			for (const item of this.state.items) {
				if (item.type === "stroke") {
					this.applyStrokeToPdf(item, pageMetrics, pages, pdfDoc);
					continue;
				}
				skippedImageCount++;
			}

			const bytes = await pdfDoc.save();
			const output = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			await this.plugin.app.vault.modifyBinary(this.file, output);
			this.isDirty = false;
			if (!silent) {
				new Notice(skippedImageCount > 0
					? `Saved. ${skippedImageCount} image overlay(s) are not saved to PDF yet.`
					: "Saved.");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Save failed: ${message}`);
		} finally {
			this.isApplying = false;
			this.plugin.isApplyingToPdf = false;
		}
	}

	private applyStrokeToPdf(
		item: StrokeItem,
		pageMetrics: PdfPageMetric[],
		pages: ReturnType<PDFDocument["getPages"]>,
		pdfDoc: PDFDocument
	) {
		const pointsPx = item.points.map((point) => this.normToPixel(point));
		if (pointsPx.length < 2) return;

		const hitCounts = new Map<number, number>();
		for (const point of pointsPx) {
			const page = this.findPageForPoint(point, pageMetrics);
			if (!page) continue;
			hitCounts.set(page.pageNumber, (hitCounts.get(page.pageNumber) || 0) + 1);
		}

		let targetPageNumber = 1;
		let bestCount = -1;
		for (const [pageNumber, count] of hitCounts.entries()) {
			if (count > bestCount) {
				bestCount = count;
				targetPageNumber = pageNumber;
			}
		}

		const pageMetric = pageMetrics.find((page) => page.pageNumber === targetPageNumber);
		if (!pageMetric) return;
		const page = pages[targetPageNumber - 1];
		if (!page) return;

		const strokePoints = pointsPx
			.filter((point) => this.pointInsidePage(point, pageMetric))
			.map((point) => ({
				x: clamp01((point.x - pageMetric.left) / pageMetric.width),
				y: clamp01((point.y - pageMetric.top) / pageMetric.height)
			}));
		if (strokePoints.length < 2) return;

		const pageWidth = page.getWidth();
		const pageHeight = page.getHeight();
		const widthPdf = Math.max(0.3, (item.width / pageMetric.width) * pageWidth);
		const color = hexToRgbNormalized(item.color);
		const pdfPoints = strokePoints.map((point) => ({
			x: point.x * pageWidth,
			y: (1 - point.y) * pageHeight
		}));
		const flatInkList = pdfPoints.flatMap((point) => [point.x, point.y]);
		if (flatInkList.length < 4) return;

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const point of pdfPoints) {
			minX = Math.min(minX, point.x);
			minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}
		const pad = Math.max(widthPdf * 1.5, 2);
		const rect = [
			Math.max(0, minX - pad),
			Math.max(0, minY - pad),
			Math.min(pageWidth, maxX + pad),
			Math.min(pageHeight, maxY + pad)
		];

		const annotDict = pdfDoc.context.obj({
			Type: PDFName.of("Annot"),
			Subtype: PDFName.of("Ink"),
			Rect: rect,
			InkList: [flatInkList],
			Border: [0, 0, 0],
			C: [color.r, color.g, color.b],
			CA: item.opacity,
			BS: {
				W: widthPdf,
				S: PDFName.of("S")
			},
			T: PDFString.of("PDF Ink"),
			Contents: PDFString.of("PDF Ink Stroke"),
			NM: PDFString.of(`${PDF_INK_ANNOT_PREFIX}${item.id}`)
		});

		const annotRef = pdfDoc.context.register(annotDict);
		const annots = this.getPageAnnotsArray(page, pdfDoc);
		annots.push(annotRef);
	}

	private removePluginAnnotations(pages: ReturnType<PDFDocument["getPages"]>) {
		for (const page of pages) {
			const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
			if (!annots) continue;

			for (let i = annots.size() - 1; i >= 0; i--) {
				const annotRef = annots.get(i);
				const annot = page.doc.context.lookup(annotRef);
				if (!(annot instanceof PDFDict)) continue;

				const nmObject = annot.get(PDFName.of("NM"));
				const nmValue = this.readPdfString(nmObject);
				if (nmValue.startsWith(PDF_INK_ANNOT_PREFIX)) {
					annots.remove(i);
				}
			}
		}
	}

	private getPageAnnotsArray(page: ReturnType<PDFDocument["getPages"]>[number], pdfDoc: PDFDocument): PDFArray {
		const current = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
		if (current) return current;

		const created = pdfDoc.context.obj([]);
		page.node.set(PDFName.of("Annots"), created);
		return created;
	}

	private readPdfString(value: unknown): string {
		if (value instanceof PDFString || value instanceof PDFHexString) {
			return value.decodeText();
		}
		return "";
	}

	private getPageMetrics(): PdfPageMetric[] {
		const pages = Array.from(this.viewerEl.querySelectorAll<HTMLElement>(".page"));
		const viewerRect = this.viewerEl.getBoundingClientRect();
		// スクロール量を加算してキャンバス座標系（スクロール原点基準）に合わせる
		const scrollLeft = this.viewerEl.scrollLeft;
		const scrollTop = this.viewerEl.scrollTop;

		const results: PdfPageMetric[] = [];
		for (const pageEl of pages) {
			const pageNumber = Number(pageEl.dataset.pageNumber);
			if (!Number.isFinite(pageNumber)) continue;
			const rect = pageEl.getBoundingClientRect();
			results.push({
				pageNumber,
				left: rect.left - viewerRect.left + scrollLeft,
				top: rect.top - viewerRect.top + scrollTop,
				width: rect.width,
				height: rect.height
			});
		}
		return results;
	}

	private findPageForPoint(point: Point, pages: PdfPageMetric[]): PdfPageMetric | null {
		for (const page of pages) {
			if (this.pointInsidePage(point, page)) {
				return page;
			}
		}
		return null;
	}

	private pointInsidePage(point: Point, page: PdfPageMetric): boolean {
		return (
			point.x >= page.left
			&& point.x <= page.left + page.width
			&& point.y >= page.top
			&& point.y <= page.top + page.height
		);
	}

	private buildToolbar(): { group: HTMLElement; pendingImageEl: HTMLElement; lassoMenuEl: HTMLElement } {
		const group = createDiv({ cls: "pdf-ink-toolbar" });
		const presetButtons = BRUSH_PRESETS.map((preset) => this.createPresetButton(preset));
		const eraserButton = this.createIconButton("eraser", "eraser", "Eraser");
		const lassoButton = this.createIconButton("lasso", "lasso-select", "Lasso");
		const imageButton = this.createIconButton("image", "image-plus", "Image");
		const undoButton = createEl("button", { cls: "pdf-ink-action-button", text: "Undo" });
		const redoButton = createEl("button", { cls: "pdf-ink-action-button", text: "Redo" });
		const pendingImageEl = createSpan({ cls: "pdf-ink-pending-image" });
		const lassoMenuEl = this.createLassoMenu();

		undoButton.onclick = () => this.undo();
		redoButton.onclick = () => this.redo();

		group.append(
			...presetButtons,
			eraserButton,
			lassoButton,
			imageButton,
			undoButton,
			redoButton,
			pendingImageEl
		);

		return { group, pendingImageEl, lassoMenuEl };
	}

	private createPresetButton(preset: BrushPreset): HTMLButtonElement {
		const button = createEl("button", { cls: "pdf-ink-preset-button", attr: { "aria-label": preset.id } });
		button.dataset.tool = preset.mode;
		button.dataset.preset = preset.id;
		button.dataset.shape = preset.shape;
		button.style.setProperty("--pdf-ink-preset-color", preset.color);
		button.onclick = () => {
			this.activeTool = preset.mode;
			this.selectedPresetId = preset.id;
			this.clearLassoSelection();
			this.refreshToolbarState();
			this.render();
		};
		return button;
	}

	private createIconButton(tool: Tool, iconName: string, ariaLabel: string): HTMLButtonElement {
		const button = createEl("button", { cls: "pdf-ink-tool-button", attr: { "aria-label": ariaLabel } });
		button.dataset.tool = tool;
		setIcon(button, iconName);
		button.onclick = () => {
			this.activeTool = tool;
			if (tool !== "lasso") {
				this.clearLassoSelection();
			}
			this.refreshToolbarState();
			this.render();
		};
		return button;
	}

	private refreshToolbarState() {
		const toolButtons = this.toolbarGroup.querySelectorAll<HTMLButtonElement>(".pdf-ink-tool-button, .pdf-ink-preset-button");
		toolButtons.forEach((button) => {
			const tool = button.dataset.tool as Tool | undefined;
			const preset = button.dataset.preset;
			const isToolActive = tool === this.activeTool;
			const isPresetActive = preset ? preset === this.selectedPresetId && isToolActive : true;
			button.classList.toggle("is-active", isToolActive && isPresetActive);
		});
		this.pendingImageEl.textContent = this.pendingImage ? "Ready" : "";
	}

	private createLassoMenu(): HTMLElement {
		const menu = createDiv({ cls: "pdf-ink-lasso-menu is-hidden" });
		menu.addEventListener("pointerdown", (event) => event.stopPropagation());
		menu.addEventListener("pointerup", (event) => event.stopPropagation());
		const makeButton = (text: string, onClick: () => void) => {
			const button = createEl("button", { cls: "pdf-ink-lasso-menu-button", text });
			button.addEventListener("pointerdown", (event) => event.stopPropagation());
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				onClick();
			});
			menu.appendChild(button);
		};

		makeButton("Copy", () => this.copySelection());
		makeButton("Duplicate", () => this.duplicateSelection());
		makeButton("Delete", () => this.deleteSelection());
		makeButton("Screenshot", () => {
			void this.exportSelectionToPng();
		});
		return menu;
	}

	private copySelection() {
		const selected = this.state.items.filter((item) => this.selectionIds.has(item.id));
		this.copiedSelection = selected.map((item) => deepCloneState({ items: [item] }).items[0]);
	}

	private pasteSelection() {
		if (this.copiedSelection.length === 0) {
			new Notice("Nothing to paste.");
			return;
		}
		this.mutationSnapshot = deepCloneState(this.state);
		const offsetX = 0.02;
		const offsetY = 0.02;
		const createdIds = new Set<string>();
		for (const item of this.copiedSelection) {
			if (item.type === "stroke") {
				const clone: StrokeItem = {
					...item,
					id: crypto.randomUUID(),
					points: item.points.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY }))
				};
				this.state.items.push(clone);
				createdIds.add(clone.id);
				continue;
			}
			const clone: ImageItem = {
				...item,
				id: crypto.randomUUID(),
				x: item.x + offsetX,
				y: item.y + offsetY
			};
			this.state.items.push(clone);
			createdIds.add(clone.id);
		}
		this.selectionIds = createdIds;
		this.persistMutation();
		this.render();
	}

	private duplicateSelection() {
		this.copySelection();
		this.pasteSelection();
	}

	private deleteSelection() {
		if (this.selectionIds.size === 0) {
			return;
		}
		this.mutationSnapshot = deepCloneState(this.state);
		this.state.items = this.state.items.filter((item) => !this.selectionIds.has(item.id));
		this.clearLassoSelection();
		this.persistMutation();
		this.render();
	}

	private styleSelectionWithActivePreset() {
		const preset = BRUSH_PRESETS.find((item) => item.id === this.selectedPresetId);
		if (!preset) return;
		this.mutationSnapshot = deepCloneState(this.state);
		let changed = false;
		for (const item of this.state.items) {
			if (!this.selectionIds.has(item.id) || item.type !== "stroke") continue;
			item.mode = preset.mode;
			item.color = preset.color;
			item.width = preset.width;
			item.opacity = preset.opacity;
			changed = true;
		}
		if (changed) {
			this.persistMutation();
			this.render();
		}
	}

	private clearLassoSelection() {
		this.selectionIds.clear();
		this.lassoPolygon = [];
		this.updateLassoMenuPosition();
	}

	private updateLassoMenuPosition() {
		if (this.selectionIds.size === 0) {
			this.lassoMenuEl.classList.add("is-hidden");
			return;
		}

		const selected = this.state.items.filter((item) => this.selectionIds.has(item.id));
		const bounds = this.getSelectionBoundsInPixels(selected);
		if (!bounds) {
			this.lassoMenuEl.classList.add("is-hidden");
			return;
		}

		const centerX = (bounds.minX + bounds.maxX) / 2;
		const topY = Math.max(8, bounds.minY - 52);
		this.lassoMenuEl.style.left = `${centerX}px`;
		this.lassoMenuEl.style.top = `${topY}px`;
		this.lassoMenuEl.classList.remove("is-hidden");
	}

	private lockScroll() {
		if (!this.scrollContainer) return;
		this.scrollContainerOverflow = this.scrollContainer.style.overflow;
		this.scrollContainer.style.overflow = "hidden";
	}

	private unlockScroll() {
		if (!this.scrollContainer) return;
		this.scrollContainer.style.overflow = this.scrollContainerOverflow;
	}

	private bindPointerEvents() {
		this.overlayEl.addEventListener("pointerdown", (event) => this.onPointerDown(event), { passive: false });
		this.overlayEl.addEventListener("pointermove", (event) => this.onPointerMove(event), { passive: false });
		this.overlayEl.addEventListener("pointerup", (event) => this.onPointerUp(event), { passive: false });
		this.overlayEl.addEventListener("pointercancel", (event) => this.onPointerUp(event), { passive: false });
	}

	private onPointerDown(event: PointerEvent) {
		if (event.pointerType === "touch") {
			this.activeTouchPointers.add(event.pointerId);
			if (this.activeTouchPointers.size >= 2) {
				// 2本指検出 → 描画を中断してネイティブスクロール・ズームに任せる
				const ids = [...this.activeTouchPointers];
				this.activeTouchPointers.clear();
				if (this.pointerDown) {
					this.pointerDown = false;
					this.drawingStroke = null;
					this.mutationSnapshot = null;
					this.unlockScroll();
				}
				for (const id of ids) {
					try { this.overlayEl.releasePointerCapture(id); } catch {}
				}
				return;
			}
		}
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		this.overlayEl.setPointerCapture(event.pointerId);
		this.pointerDown = true;
		this.lockScroll();

		const p = this.eventToPixel(event);
		this.previousPointer = p;

		if (this.activeTool === "pen" || this.activeTool === "marker") {
			const preset = BRUSH_PRESETS.find((item) => item.id === this.selectedPresetId) ?? BRUSH_PRESETS[0];
			this.mutationSnapshot = deepCloneState(this.state);
			this.drawingStroke = {
				id: crypto.randomUUID(),
				type: "stroke",
				mode: preset.mode,
				color: preset.color,
				width: preset.width,
				opacity: preset.opacity,
				points: [this.pixelToNorm(p)]
			};
			this.render();
			return;
		}

		if (this.activeTool === "eraser") {
			this.mutationSnapshot = deepCloneState(this.state);
			this.eraseAt(p);
			this.render();
			return;
		}

		if (this.activeTool === "lasso") {
			if (this.selectionIds.size > 0 && this.hitSelection(p)) {
				this.draggingSelection = true;
				this.mutationSnapshot = deepCloneState(this.state);
			} else {
				this.draggingSelection = false;
				this.clearLassoSelection();
				this.lassoPolygon = [this.pixelToNorm(p)];
			}
			this.render();
			return;
		}

		if (this.activeTool === "image") {
			if (!this.pendingImage) {
				void this.pickImage();
				return;
			}
			this.mutationSnapshot = deepCloneState(this.state);
			this.placeImageAt(p, this.pendingImage);
			this.pendingImage = null;
			this.refreshToolbarState();
			this.persistMutation();
			this.render();
		}
	}

	private onPointerMove(event: PointerEvent) {
		if (!this.pointerDown) return;
		event.preventDefault();
		const p = this.eventToPixel(event);

		if (this.drawingStroke) {
			this.drawingStroke.points.push(this.pixelToNorm(p));
			this.render();
			return;
		}

		if (this.activeTool === "eraser") {
			this.eraseAt(p);
			this.render();
			return;
		}

		if (this.activeTool === "lasso") {
			if (this.draggingSelection && this.previousPointer) {
				const dx = p.x - this.previousPointer.x;
				const dy = p.y - this.previousPointer.y;
				this.moveSelectionBy(dx, dy);
			} else if (!this.draggingSelection) {
				this.lassoPolygon.push(this.pixelToNorm(p));
			}
			this.previousPointer = p;
			this.render();
		}
	}

	private onPointerUp(event: PointerEvent) {
		if (event.pointerType === "touch") {
			this.activeTouchPointers.delete(event.pointerId);
		}
		if (!this.pointerDown) return;
		this.pointerDown = false;
		this.overlayEl.releasePointerCapture(event.pointerId);
		this.unlockScroll();

		if (this.drawingStroke) {
			if (this.drawingStroke.points.length > 1) {
				this.state.items.push(this.drawingStroke);
				this.persistMutation();
			} else {
				this.mutationSnapshot = null;
			}
			this.drawingStroke = null;
		}

		if (this.activeTool === "eraser") {
			this.persistMutation();
		}

		if (this.activeTool === "lasso") {
			if (this.draggingSelection) {
				this.persistMutation();
			} else if (this.lassoPolygon.length > 2) {
				this.selectByLasso(this.lassoPolygon);
			}
			this.draggingSelection = false;
		}

		this.previousPointer = null;
		this.render();
	}

	private persistMutation() {
		if (!this.mutationSnapshot) return;
		if (JSON.stringify(this.mutationSnapshot.items) !== JSON.stringify(this.state.items)) {
			this.past.push(this.mutationSnapshot);
			if (this.past.length > 80) {
				this.past.shift();
			}
			this.future = [];
			this.plugin.updateFileState(this.file.path, this.state);
			this.isDirty = true;
		}
		this.mutationSnapshot = null;
	}

	private eventToPixel(event: PointerEvent): Point {
		const rect = this.overlayEl.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	private getCanvasSize(): { width: number; height: number } {
		return {
			width: Math.max(this.viewerEl.scrollWidth, this.viewerEl.clientWidth, 1),
			height: Math.max(this.viewerEl.scrollHeight, this.viewerEl.clientHeight, 1)
		};
	}

	private pixelToNorm(point: Point): Point {
		const size = this.getCanvasSize();
		return { x: point.x / size.width, y: point.y / size.height };
	}

	private normToPixel(point: Point): Point {
		const size = this.getCanvasSize();
		return { x: point.x * size.width, y: point.y * size.height };
	}

	private eraseAt(pixel: Point) {
		const nextItems: AnnotationItem[] = [];
		let changed = false;

		for (const item of this.state.items) {
			if (item.type === "stroke") {
				const points = item.points.map((point) => this.normToPixel(point));
				let hit = false;
				for (let i = 1; i < points.length; i++) {
					if (distanceToSegment(pixel, points[i - 1], points[i]) <= this.eraserThreshold + item.width / 2) {
						hit = true;
						break;
					}
				}
				if (hit) {
					changed = true;
					continue;
				}
			}
			nextItems.push(item);
		}

		if (changed) {
			this.state.items = nextItems;
		}
	}

	private selectByLasso(polygonNorm: Point[]) {
		const selection = new Set<string>();
		for (const item of this.state.items) {
			if (item.type === "stroke") {
				if (item.points.some((point) => pointInPolygon(point, polygonNorm))) {
					selection.add(item.id);
				}
			} else {
				const corners: Point[] = [
					{ x: item.x, y: item.y },
					{ x: item.x + item.width, y: item.y },
					{ x: item.x, y: item.y + item.height },
					{ x: item.x + item.width, y: item.y + item.height }
				];
				if (corners.some((point) => pointInPolygon(point, polygonNorm))) {
					selection.add(item.id);
				}
			}
		}
		this.selectionIds = selection;
		this.updateLassoMenuPosition();
	}

	private hitSelection(pixel: Point): boolean {
		for (const item of this.state.items) {
			if (!this.selectionIds.has(item.id)) continue;
			if (item.type === "image") {
				const topLeft = this.normToPixel({ x: item.x, y: item.y });
				const size = this.normToPixel({ x: item.width, y: item.height });
				if (
					pixel.x >= topLeft.x
					&& pixel.x <= topLeft.x + size.x
					&& pixel.y >= topLeft.y
					&& pixel.y <= topLeft.y + size.y
				) {
					return true;
				}
				continue;
			}

			const points = item.points.map((point) => this.normToPixel(point));
			for (let i = 1; i < points.length; i++) {
				if (distanceToSegment(pixel, points[i - 1], points[i]) < item.width + 6) {
					return true;
				}
			}
		}
		return false;
	}

	private moveSelectionBy(dxPx: number, dyPx: number) {
		const size = this.getCanvasSize();
		const dx = dxPx / size.width;
		const dy = dyPx / size.height;
		for (const item of this.state.items) {
			if (!this.selectionIds.has(item.id)) continue;
			if (item.type === "stroke") {
				item.points = item.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
			} else {
				item.x += dx;
				item.y += dy;
			}
		}
	}

	private async pickImage() {
		const input = createEl("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;

			const reader = new FileReader();
			reader.onload = () => {
				const src = String(reader.result || "");
				if (!src) return;

				const image = new Image();
				image.onload = () => {
					this.imageCache.set(src, image);
					this.pendingImage = { src, width: image.width, height: image.height };
					this.refreshToolbarState();
					new Notice("Click where you want to place the image.");
					this.render();
				};
				image.src = src;
			};
			reader.readAsDataURL(file);
		};
		input.click();
	}

	private placeImageAt(pixel: Point, pending: { src: string; width: number; height: number }) {
		const size = this.getCanvasSize();
		const targetWidthPx = Math.min(320, size.width * 0.35);
		const targetHeightPx = (pending.height / Math.max(pending.width, 1)) * targetWidthPx;

		this.state.items.push({
			id: crypto.randomUUID(),
			type: "image",
			src: pending.src,
			x: (pixel.x - targetWidthPx / 2) / size.width,
			y: (pixel.y - targetHeightPx / 2) / size.height,
			width: targetWidthPx / size.width,
			height: targetHeightPx / size.height
		});
	}

	private async exportSelectionToPng() {
		if (this.selectionIds.size === 0) {
			new Notice("Select with lasso first.");
			return;
		}

		const selected = this.state.items.filter((item) => this.selectionIds.has(item.id));
		const bounds = this.getSelectionBoundsInPixels(selected);
		if (!bounds) {
			new Notice("No selection found.");
			return;
		}

		const exportCanvas = document.createElement("canvas");
		exportCanvas.width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
		exportCanvas.height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
		const ctx = exportCanvas.getContext("2d");
		if (!ctx) {
			new Notice("Could not create image canvas.");
			return;
		}

		for (const item of selected) {
			if (item.type === "stroke") {
				const points = item.points.map((point) => this.normToPixel(point));
				this.drawStroke(ctx, item, points, -bounds.minX, -bounds.minY);
				continue;
			}

			const image = this.getOrLoadImage(item.src);
			if (!image) continue;
			const topLeft = this.normToPixel({ x: item.x, y: item.y });
			const size = this.normToPixel({ x: item.width, y: item.height });
			ctx.drawImage(image, topLeft.x - bounds.minX, topLeft.y - bounds.minY, size.x, size.y);
		}

		const blob = await new Promise<Blob | null>((resolve) => exportCanvas.toBlob(resolve, "image/png"));
		if (!blob) {
			new Notice("Screenshot failed.");
			return;
		}

		const arrayBuffer = await blob.arrayBuffer();
		const prefix = `${this.file.parent?.path ? `${this.file.parent.path}/` : ""}${this.file.basename}-selection`;
		let path = `${prefix}.png`;
		let index = 1;
		while (await this.plugin.app.vault.adapter.exists(path)) {
			path = `${prefix}-${index}.png`;
			index++;
		}

		await this.plugin.app.vault.createBinary(path, arrayBuffer);
		new Notice(`Screenshot saved: ${path}`);
	}

	private getSelectionBoundsInPixels(items: AnnotationItem[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const item of items) {
			if (item.type === "stroke") {
				for (const point of item.points.map((p) => this.normToPixel(p))) {
					minX = Math.min(minX, point.x);
					minY = Math.min(minY, point.y);
					maxX = Math.max(maxX, point.x);
					maxY = Math.max(maxY, point.y);
				}
				continue;
			}
			const topLeft = this.normToPixel({ x: item.x, y: item.y });
			const size = this.normToPixel({ x: item.width, y: item.height });
			minX = Math.min(minX, topLeft.x);
			minY = Math.min(minY, topLeft.y);
			maxX = Math.max(maxX, topLeft.x + size.x);
			maxY = Math.max(maxY, topLeft.y + size.y);
		}

		if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
			return null;
		}
		return { minX, minY, maxX, maxY };
	}

	private getOrLoadImage(src: string): HTMLImageElement | null {
		const cached = this.imageCache.get(src);
		if (cached) return cached;

		const image = new Image();
		image.onload = () => {
			this.imageCache.set(src, image);
			if (!this.redrawQueued) {
				this.redrawQueued = true;
				window.requestAnimationFrame(() => {
					this.redrawQueued = false;
					this.render();
				});
			}
		};
		image.src = src;
		return null;
	}

	private render() {
		const size = this.getCanvasSize();
		this.overlayEl.style.width = `${size.width}px`;
		this.overlayEl.style.height = `${size.height}px`;

		for (const canvas of [this.drawCanvas, this.helperCanvas]) {
			canvas.width = size.width;
			canvas.height = size.height;
		}

		this.drawCtx.clearRect(0, 0, size.width, size.height);
		this.helperCtx.clearRect(0, 0, size.width, size.height);

		for (const item of this.state.items) {
			if (item.type === "stroke") {
				const points = item.points.map((point) => this.normToPixel(point));
				this.drawStroke(this.drawCtx, item, points, 0, 0);
				if (this.selectionIds.has(item.id)) {
					this.drawStrokeSelection(points);
				}
				continue;
			}

			const image = this.getOrLoadImage(item.src);
			if (image) {
				const topLeft = this.normToPixel({ x: item.x, y: item.y });
				const imageSize = this.normToPixel({ x: item.width, y: item.height });
				this.drawCtx.drawImage(image, topLeft.x, topLeft.y, imageSize.x, imageSize.y);
			}
			if (this.selectionIds.has(item.id)) {
				this.drawImageSelection(item);
			}
		}

		if (this.drawingStroke) {
			const points = this.drawingStroke.points.map((point) => this.normToPixel(point));
			this.drawStroke(this.drawCtx, this.drawingStroke, points, 0, 0);
		}

		if (this.activeTool === "lasso" && this.lassoPolygon.length > 1 && !this.draggingSelection) {
			const points = this.lassoPolygon.map((point) => this.normToPixel(point));
			this.helperCtx.save();
			this.helperCtx.strokeStyle = "rgba(60, 140, 255, 0.9)";
			this.helperCtx.lineWidth = 1.5;
			this.helperCtx.setLineDash([8, 6]);
			this.helperCtx.beginPath();
			this.helperCtx.moveTo(points[0].x, points[0].y);
			for (let i = 1; i < points.length; i++) {
				this.helperCtx.lineTo(points[i].x, points[i].y);
			}
			this.helperCtx.stroke();
			this.helperCtx.restore();
		}

		this.updateLassoMenuPosition();
	}

	private drawStroke(
		ctx: CanvasRenderingContext2D,
		item: StrokeItem,
		points: Point[],
		offsetX: number,
		offsetY: number
	) {
		if (points.length < 2) return;
		ctx.save();
		ctx.globalAlpha = item.opacity;
		ctx.strokeStyle = item.color;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.lineWidth = item.width;
		ctx.beginPath();
		ctx.moveTo(points[0].x + offsetX, points[0].y + offsetY);
		for (let i = 1; i < points.length; i++) {
			ctx.lineTo(points[i].x + offsetX, points[i].y + offsetY);
		}
		ctx.stroke();
		ctx.restore();
	}

	private drawStrokeSelection(points: Point[]) {
		if (points.length < 2) return;
		this.helperCtx.save();
		this.helperCtx.strokeStyle = "rgba(0, 120, 255, 0.9)";
		this.helperCtx.lineWidth = 2;
		this.helperCtx.setLineDash([6, 4]);
		this.helperCtx.beginPath();
		this.helperCtx.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i++) {
			this.helperCtx.lineTo(points[i].x, points[i].y);
		}
		this.helperCtx.stroke();
		this.helperCtx.restore();
	}

	private drawImageSelection(item: ImageItem) {
		const topLeft = this.normToPixel({ x: item.x, y: item.y });
		const size = this.normToPixel({ x: item.width, y: item.height });
		this.helperCtx.save();
		this.helperCtx.strokeStyle = "rgba(0, 120, 255, 0.9)";
		this.helperCtx.lineWidth = 2;
		this.helperCtx.setLineDash([6, 4]);
		this.helperCtx.strokeRect(topLeft.x, topLeft.y, size.x, size.y);
		this.helperCtx.restore();
	}
}
