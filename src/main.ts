import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  parseYaml,
} from "obsidian";
import type { App } from "obsidian";

import { fnv1a32, hashKeyToId, hashPathToId, normalizeForHash } from "./hash";
import {
  ZM_BEGIN_CSS,
  ZM_BEGIN_JS,
  ZM_END_CSS,
  ZM_END_JS,
  buildPublishCssBlock,
  buildPublishJsBlock,
} from "./publishTemplates";

type ScanMode = "publishTrueOnly" | "allMarkdown";

interface PublishToolsSettings {
  scanMode: ScanMode;
  publishRoot: string;       // ZoomMap/publish
  rasterizeTextLayersToWebp: boolean;
  textLayerRasterRoot: string; // ZoomMap/publish/textlayers
  assetsNotePath: string;    // ZoomMap/publish/assets.md
  hideNavFolders: string;    // newline or comma separated folder prefixes
  includePinLinkedNotesInAssets: boolean;
  
  // Publish website hover popover size (affects page preview popovers)
  hoverPopoverMaxWidth: string;   // e.g. 720px
  
  // Timeline publish
  timelineScanMode: ScanMode;
  timelineRoot: string;         // Timeline/publish
  timelineAssetsNotePath: string; // Timeline/publish/assets.md
  timelineDateKey: string;      // fc-date
  timelineEndKey: string;       // fc-end
  timelineListKey: string;      // timelines
  timelineTitleKey: string;     // tl-title
  timelineSummaryKey: string;   // tl-summary
  timelineImageKey: string;     // tl-image
  
  timelineUseSimpleTimelineMonths: boolean;
  timelineMonthOverridesYaml: string;
}

const DEFAULT_SETTINGS: PublishToolsSettings = {
  scanMode: "publishTrueOnly",
  publishRoot: "ZoomMap/publish",
  rasterizeTextLayersToWebp: true,
  textLayerRasterRoot: "ZoomMap/publish/textlayers",
  assetsNotePath: "ZoomMap/publish/assets.md",
  hideNavFolders: "",
  includePinLinkedNotesInAssets: false,
  
  hoverPopoverMaxWidth: "720px",
  
  timelineScanMode: "publishTrueOnly",
  timelineRoot: "Timeline/publish",
  timelineAssetsNotePath: "Timeline/publish/assets.md",
  timelineDateKey: "fc-date",
  timelineEndKey: "fc-end",
  timelineListKey: "timelines",
  timelineTitleKey: "tl-title",
  timelineSummaryKey: "tl-summary",
  timelineImageKey: "tl-image",
  
  timelineUseSimpleTimelineMonths: true,
  timelineMonthOverridesYaml: "",
};

function normalizeCssSizeValue(raw: string, fallback: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  if (/^\d+(\.\d+)?$/.test(s)) return `${s}px`;
  return s;
}

function setCssProps(el: HTMLElement, props: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null) el.style.removeProperty(key);
    else el.style.setProperty(key, value);
  }
}

// Minimal interface to call into Zoom Map plugin if installed.
interface ZoomMapPluginApi {
  saveLibraryToPath: (path: string) => Promise<void>;
  libraryFilePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseHideNavFolders(raw: string): string[] {
  const parts = String(raw ?? "")
    .split(/[\n,]/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, ""));
  return Array.from(new Set(parts));
}

function fmNumber(fm: Record<string, unknown> | null, key: string): number | undefined {
  const v = fm?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readFrontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\n([\s\S]*?)\n---\n?/m.exec(text);
  if (!m) return null;
  try {
    const parsed: unknown = parseYaml(m[1]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function basePathsFromZoommapScan(image: string, imageBases: string[]): string[] {
  const out: string[] = [];
  if (typeof image === "string" && image.trim()) out.push(normalizePath(image.trim()));
  for (const p of imageBases) {
    if (typeof p === "string" && p.trim()) out.push(normalizePath(p.trim()));
  }
  return Array.from(new Set(out.filter(Boolean)));
}

type LibraryLinkIndex = {
  iconDefaultLinks: Map<string, string>;
  swapPresets: Map<string, { frameLinks: string[]; frameIconKeys: string[] }>;
};

type Ymd = { y: number; m: number; d: number };
type TimelineEntry = {
  notePath: string; // vault path to note
  title: string;
  summary?: string;
  start: Ymd;
  end?: Ymd;
  img?: string; // url or vault path
  dateText?: string; // baked display string (uses custom months from settings)
};

function ymdSortKey(v: Ymd): number {
  return v.y * 10000 + v.m * 100 + v.d;
}

function splitTimelineNames(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .replace(/[\]["]/g, "")
      .split(/[,;\n]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}


export default class TtrpgToolsPublishPlugin extends Plugin {
  settings: PublishToolsSettings = DEFAULT_SETTINGS;
  
  private loadedCanvasFonts = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "zoommap-publish-install-runtime",
      name: "Maps: Install/Update publish.js + publish.css",
      callback: () => void this.installPublishRuntime(),
    });

    this.addCommand({
      id: "zoommap-publish-generate-data-notes",
      name: "Maps: generate publish data notes (library + markers)",
      callback: () => void this.generatePublishDataNotes(),
    });

    this.addCommand({
      id: "zoommap-publish-generate-assets",
      name: "Maps: generate publish assets manifest note",
      callback: () => void this.generateAssetsManifest(),
    });

    this.addCommand({
      id: "zoommap-publish-prepare-all",
      name: "Maps: prepare publish (runtime + data notes + assets)",
      callback: () => void this.prepareAll(),
    });
	
    this.addCommand({
      id: "timeline-publish-generate-data-notes",
      name: "Timeline: generate publish data notes",
      callback: () => void this.generateTimelineDataNotes(),
    });

    this.addCommand({
      id: "timeline-publish-generate-assets",
      name: "Timeline: generate publish assets manifest note",
      callback: () => void this.generateTimelineAssetsManifest(),
    });

    this.addCommand({
      id: "timeline-publish-prepare",
      name: "Timeline: prepare publish (runtime + data notes + assets)",
      callback: () => void this.prepareTimelineOnly(),
    });

    this.addCommand({
      id: "publish-prepare-maps-and-timeline",
      name: "Prepare publish (maps + timeline)",
      callback: () => void this.prepareMapsAndTimeline(),
    });

    this.addSettingTab(new PublishToolsSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PublishToolsSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private publishRoot(): string {
    return normalizePath(this.settings.publishRoot || DEFAULT_SETTINGS.publishRoot);
  }
  
  private timelineRoot(): string {
    return normalizePath(this.settings.timelineRoot || DEFAULT_SETTINGS.timelineRoot);
  }

  private timelineAssetsNotePath(): string {
    return normalizePath(this.settings.timelineAssetsNotePath || DEFAULT_SETTINGS.timelineAssetsNotePath);
  }
  
  private resolveZoomMapLibraryJsonPath(): string {
    const api = this.getZoomMapPluginApi();
    const p = (api?.libraryFilePath ?? "").trim();
    return normalizePath(p || "ZoomMap/library.json");
  }

  private libraryNotePath(): string {
    return normalizePath(`${this.publishRoot()}/library.md`);
  }

  private markerNotePathForMarkersPath(markersPath: string): string {
    const id = hashPathToId(markersPath);
    return normalizePath(`${this.publishRoot()}/markers/m-${id}.md`);
  }
  
  private timelineDataNotePathForTimelineName(name: string): string {
    const id = hashKeyToId(name);
    return normalizePath(`${this.timelineRoot()}/timelines/t-${id}.md`);
  }

  private timelineDataNoteKeyForTimelineName(name: string): string {
    // for runtime fetchNoteJson(): pass without .md
    const id = hashKeyToId(name);
    return normalizePath(`${this.timelineRoot()}/timelines/t-${id}`);
  }

  private async prepareAll(): Promise<void> {
    await this.installPublishRuntime();
    await this.generatePublishDataNotes();
    await this.generateAssetsManifest();
    new Notice(
      "TTRPG Tools: Publish: done. Next: Publish changes → select publish.js/publish.css and ZoomMap/publish/assets.md → Add linked → Publish.",
      15000,
    );
  }
  
  private async prepareTimelineOnly(): Promise<void> {
    await this.installPublishRuntime();
    await this.generateTimelineDataNotes();
    await this.generateTimelineAssetsManifest();
    new Notice(
      "TTRPG Tools: Publish: Timeline done. Next: Publish changes → select publish.js/publish.css and Timeline assets note → Add linked → Publish.",
      15000,
    );
  }

  private async prepareMapsAndTimeline(): Promise<void> {
    await this.installPublishRuntime();
    await this.generatePublishDataNotes();
    await this.generateAssetsManifest();
    await this.generateTimelineDataNotes();
    await this.generateTimelineAssetsManifest();
    new Notice("Ttrpg tools: publish: maps + timeline done.", 15000);
  }
  
  private textLayerRasterRoot(): string {
    return normalizePath(
      (this.settings.textLayerRasterRoot ?? DEFAULT_SETTINGS.textLayerRasterRoot) ||
        DEFAULT_SETTINGS.textLayerRasterRoot,
    );
  }

  private async installPublishRuntime(): Promise<void> {
    const jsPath = "publish.js";
    const cssPath = "publish.css";

    const stamp = String(this.manifest.version ?? "");
	
    const popoverW = normalizeCssSizeValue(
      this.settings.hoverPopoverMaxWidth,
      DEFAULT_SETTINGS.hoverPopoverMaxWidth,
    );

    const jsBlock = buildPublishJsBlock(stamp, {
      hideNavFolders: parseHideNavFolders(this.settings.hideNavFolders),
      mapRoot: this.publishRoot(),
      timelineRoot: this.timelineRoot(),
      hoverPopoverMaxWidth: popoverW,
    });
    const cssBlock = buildPublishCssBlock({
      hoverPopoverMaxWidth: normalizeCssSizeValue(
        this.settings.hoverPopoverMaxWidth,
        DEFAULT_SETTINGS.hoverPopoverMaxWidth,
      ),
    });

    await this.upsertRootFileBlock(jsPath, ZM_BEGIN_JS, ZM_END_JS, jsBlock);
    await this.upsertRootFileBlock(cssPath, ZM_BEGIN_CSS, ZM_END_CSS, cssBlock);

    new Notice("Publish runtime installed/updated: publish.js + publish.css", 15000);
    new Notice("Reminder: publish.js works only with a custom domain and must be published.", 15000);
  }
  
  private extractMarkerBasePaths(data: Record<string, unknown>, fallback: string[], fromNotePath: string): string[] {
    const raw = data["bases"];
    const out: string[] = [];

    const add = (p: unknown) => {
      if (typeof p !== "string") return;
      const t = p.trim();
      if (!t) return;
      const normTarget = this.normalizeLinkTarget(t);
      const candidate = normalizePath(normTarget || t);
      if (!candidate) return;

      const byPath = this.app.vault.getAbstractFileByPath(candidate);
      if (byPath instanceof TFile) {
        out.push(byPath.path);
        return;
      }
      const dest = this.app.metadataCache.getFirstLinkpathDest(candidate, fromNotePath);
      if (dest instanceof TFile) out.push(dest.path);
      else out.push(candidate);
    };

    if (Array.isArray(raw)) {
      for (const it of raw) {
        if (typeof it === "string") add(it);
        else if (it && typeof it === "object" && "path" in it) add((it as { path?: unknown }).path);
      }
    } else {
      for (const p of fallback) add(p);
    }

    return Array.from(new Set(out.filter(Boolean)));
  }

  private async upsertRootFileBlock(path: string, begin: string, end: string, block: string): Promise<void> {
    const p = normalizePath(path);
    const adapter = this.app.vault.adapter;

    const exists = await adapter.exists(p);
    let text = "";

    if (exists) {
      // @ts-expect-error adapter.read exists
      text = await adapter.read(p);
    }

    const next = this.upsertBlock(text, begin, end, block);

    if (!exists) {
      // @ts-expect-error adapter.write exists
      await adapter.write(p, next);
    } else if (text !== next) {
      // @ts-expect-error adapter.write exists
      await adapter.write(p, next);
    }
  }

  private upsertBlock(src: string, begin: string, end: string, block: string): string {
    const a = src.indexOf(begin);
    const b = src.indexOf(end);

    if (a >= 0 && b > a) {
      const before = src.slice(0, a);
      const after = src.slice(b + end.length);
      const needsNlBefore = before.length > 0 && !before.endsWith("\n");
      const needsNlAfter = after.length > 0 && !after.startsWith("\n");
      return (
        before +
        (needsNlBefore ? "\n" : "") +
        block.trimEnd() +
        (needsNlAfter ? "\n" : "") +
        after
      ).trimEnd() + "\n";
    }

    const trimmed = src.trimEnd();
    if (!trimmed) return block.trimEnd() + "\n";
    return trimmed + "\n\n" + block.trimEnd() + "\n";
  }

  private async generatePublishDataNotes(): Promise<void> {
    const root = this.publishRoot();
    await this.ensureFolderFor(this.libraryNotePath());
    await this.ensureFolderFor(normalizePath(`${root}/markers/x.md`)); // creates folder
	await this.ensureFolderFor(normalizePath(`${this.textLayerRasterRoot()}/x.webp`));
	
    let updatedMarkerNotes = 0;
    let skippedMarkerNotes = 0;

    try {
      await this.exportLibraryNote();
    } catch (e) {
      console.warn("TTRPG Tools: Publish: exportLibraryNote failed (continuing with markers).", e);
      new Notice("Tttrpg tools: publish: library export failed (see console). Markers will still be generated.", 15000);
    }

    // 2) Scan notes for zoommap blocks → collect markersPath set
    const maps = await this.scanZoommaps();
    const markerNotePaths = new Set<string>();

    for (const m of maps) {
      const markersPath = m.markersPath;
      const markerJsonFile = this.resolveVaultFile(markersPath);
	  const sourceMtime = markerJsonFile?.stat?.mtime;
      if (!markerJsonFile) {
        new Notice(`TTRPG Tools: Publish: missing marker file: ${markersPath}`, 15000);
        continue;
      }

      const raw = await this.app.vault.read(markerJsonFile);
      // Ensure it's valid JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        new Notice(`TTRPG Tools: Publish: invalid JSON: ${markersPath}`, 15000);
        continue;
      }

      const notePath = this.markerNotePathForMarkersPath(markersPath);
      markerNotePaths.add(notePath);
	  
      const existing = this.app.vault.getAbstractFileByPath(notePath);
      let prevMtime: number | undefined = undefined;
      let prevRasterKey = "";
      let prevRasterEnabled = false;

      if (existing instanceof TFile) {
        const cur = await this.app.vault.read(existing);
        const fm = readFrontmatter(cur);
        prevMtime = fmNumber(fm, "zoommapSourceMtime");
        prevRasterKey = typeof fm?.zoommapTextLayerRasterKey === "string" ? String(fm.zoommapTextLayerRasterKey) : "";
        prevRasterEnabled = fm?.zoommapTextLayerRasterEnabled === true;
      }

      const parsedObj = parsed as Record<string, unknown>;
      const basePaths = this.extractMarkerBasePaths(parsedObj, m.basePaths, m.notePath);

      const sourceChanged =
        prevMtime !== undefined && sourceMtime !== undefined
          ? prevMtime !== sourceMtime
          : true;

      const wantRaster = !!this.settings.rasterizeTextLayersToWebp;
      let rasterKey = "";
      let overlayMap: Record<string, string> = {};
      let rasterFilesMissing = false;

      if (wantRaster) {
        overlayMap = this.computeTextLayerRasterOutputPaths(markersPath, basePaths, parsedObj);
        if (Object.keys(overlayMap).length > 0) {
          const stablePairs = Object.entries(overlayMap).sort((a, b) => a[0].localeCompare(b[0]));
          rasterKey = fnv1a32(JSON.stringify(stablePairs)).toString(36);
          rasterFilesMissing = stablePairs.some(([, p]) => !(this.app.vault.getAbstractFileByPath(normalizePath(p)) instanceof TFile));

          if (sourceChanged || rasterFilesMissing || prevRasterKey !== rasterKey || prevRasterEnabled !== true) {
            await this.rasterizeTextLayersForPublish({
              markersPath,
              mapNotePath: m.notePath,
              basePaths,
              data: parsedObj,
            });
          }

          parsedObj.publishTextLayerOverlays = overlayMap;
        } else {
          delete (parsedObj as { publishTextLayerOverlays?: unknown }).publishTextLayerOverlays;
        }
      } else {
        delete (parsedObj as { publishTextLayerOverlays?: unknown }).publishTextLayerOverlays;
      }
	  
      if (existing instanceof TFile) {
        const sameSource = prevMtime !== undefined && sourceMtime !== undefined && prevMtime === sourceMtime;
        const sameRaster =
          (wantRaster
            ? (prevRasterEnabled === true && prevRasterKey === rasterKey)
            : (prevRasterEnabled !== true));

        if (sameSource && sameRaster && !rasterFilesMissing) {
          skippedMarkerNotes++;
          continue;
        }
      }
	  
      const rasterMeta: Record<string, unknown> = {};
      if (wantRaster && rasterKey) {
        rasterMeta.zoommapTextLayerRasterEnabled = true;
        rasterMeta.zoommapTextLayerRasterKey = rasterKey;
        rasterMeta.zoommapTextLayerRasterRoot = this.textLayerRasterRoot();
      } else {
        rasterMeta.zoommapTextLayerRasterEnabled = false;
      }

      const md = this.wrapJsonAsPublishNote(
        "markers",
        parsedObj,
        {
          zoommapMarkersPath: normalizeForHash(markersPath),
          sourceFile: markerJsonFile.path,
          zoommapSourceMtime: sourceMtime,
		  ...rasterMeta,
        },
      );

      await this.writeOrUpdateMarkdown(notePath, md);
	  updatedMarkerNotes++;
    }

    // 3) Cleanup old marker notes (only generated files m-*.md)
    await this.cleanupMarkerNotes(markerNotePaths);

    new Notice(
      `Generated publish marker notes: ${markerNotePaths.size} (updated: ${updatedMarkerNotes}, unchanged: ${skippedMarkerNotes})`,
      15000,
    );
  }

  private async exportLibraryNote(): Promise<void> {
    const LIB_JSON = this.resolveZoomMapLibraryJsonPath();
    const LIB_NOTE = this.libraryNotePath();

    await this.ensureFolderFor(LIB_JSON);

    const zm = this.getZoomMapPluginApi();
    if (zm) {
      try {
        await zm.saveLibraryToPath(LIB_JSON);
      } catch (e) {
        console.warn("TTRPG Tools: Publish: saveLibraryToPath failed.", e);
        new Notice("Ttrpg tools: publish: failed to export zoom map library.json (see console).", 15000);
      }
    }

    const libFile = this.resolveVaultFile(LIB_JSON);
    if (!libFile) {
      new Notice(
       `TTRPG Tools: Publish: library JSON missing: ${LIB_JSON}. Export it once from Zoom Map settings (Library file path).`,
        15000,
      );
      return;
    }

    const raw = await this.app.vault.read(libFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      new Notice("Ttrpg tools: publish: library.json is invalid JSON.", 15000);
      return;
    }

    const sourceMtime = libFile.stat?.mtime;
    const existing = this.app.vault.getAbstractFileByPath(LIB_NOTE);
    if (existing instanceof TFile) {
      const cur = await this.app.vault.read(existing);
      const fm = readFrontmatter(cur);
      const prevMtime = fmNumber(fm, "zoommapSourceMtime");
      if (prevMtime !== undefined && sourceMtime !== undefined && prevMtime === sourceMtime) {
        return;
      }
    }

    const md = this.wrapJsonAsPublishNote("library", parsed, {
      sourceFile: libFile.path,
      zoommapSourceMtime: sourceMtime,
    });

    await this.writeOrUpdateMarkdown(LIB_NOTE, md);
    new Notice(`Generated: ${LIB_NOTE}`, 15000);
  }

  private wrapJsonAsPublishNote(kind: "library" | "markers" | "timeline", obj: unknown, meta?: Record<string, unknown>): string {
    const fm: Record<string, unknown> = {
      publish: true,
      ttrpgtools: "ttrpgtools-publish",
      ttrpgtoolsData: kind,
      ...(meta ?? {}),
      generatedAt: new Date().toISOString(),
    };

    const fmYaml = this.stringifyFrontmatter(fm);

    const json = JSON.stringify(obj, null, 2);

    return [
      fmYaml,
      "",
      `# TTRPG Tools: Maps publish data (${kind})`,
      "",
      "```json",
      json,
      "```",
      "",
    ].join("\n");
  }

  private stringifyFrontmatter(obj: Record<string, unknown>): string {
    // Minimal YAML frontmatter writer (safe for simple scalar values)
    const lines: string[] = ["---"];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (typeof v === "string") lines.push(`${k}: ${JSON.stringify(v)}`);
      else if (typeof v === "number" || typeof v === "boolean") lines.push(`${k}: ${String(v)}`);
      else lines.push(`${k}: ${JSON.stringify(v)}`);
    }
    lines.push("---");
    return lines.join("\n");
  }

  private async cleanupMarkerNotes(keep: Set<string>): Promise<void> {
    const folder = normalizePath(`${this.publishRoot()}/markers`);
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/"));

    for (const f of files) {
      const name = f.name ?? "";
      if (!name.startsWith("m-")) continue; // only delete generated ones
      if (keep.has(f.path)) continue;
      try {
        await this.app.fileManager.trashFile(f);
      } catch (e) {
        console.warn("Zoom Map Publish: failed to delete old marker note", f.path, e);
      }
    }
  }
  
  // =========================
  // Timeline publish (data notes)
  // =========================

  private parseFcDate(val: unknown): Ymd | null {
    if (!val) return null;

    if (typeof val === "string") {
      const m = val.trim().match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
      if (!m) return null;
      return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    }

    if (isRecord(val)) {
      const y = Number(val.year);
      const mo = Number(val.month);
      const d = Number(val.day);
      if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
      return { y, m: mo, d };
    }

    return null;
  }
  
  private defaultMonths(): string[] {
    return [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
  }

  private parseTimelineMonthOverrides(): Record<string, string[]> {
    const raw = String(this.settings.timelineMonthOverridesYaml ?? "").trim();
    if (!raw) return {};
    try {
      const parsed = parseYaml(raw) as unknown;
      if (!isRecord(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k !== "string" || !k.trim()) continue;
        if (Array.isArray(v)) {
          const arr = v.map((x) => String(x ?? "").trim()).filter(Boolean);
          if (arr.length) out[k.trim()] = arr;
        } else if (typeof v === "string" && v.trim()) {
          const arr = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (arr.length) out[k.trim()] = arr;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private tryGetSimpleTimelineMonths(timelineName: string): string[] | null {
    if (!this.settings.timelineUseSimpleTimelineMonths) return null;
    const plugins = (this.app as unknown as { plugins?: unknown }).plugins;
    if (!isRecord(plugins)) return null;

    const getPlugin = plugins["getPlugin"];
    let st: unknown = null;
    if (typeof getPlugin === "function") {
      try {
        st = (getPlugin as (id: string) => unknown).call(plugins, "simple-timeline");
      } catch {
        st = null;
      }
    }

    const pluginsMap = plugins["plugins"];
    if (!st && isRecord(pluginsMap)) {
      st = pluginsMap["simple-timeline"] ?? null;
    }

    if (!isRecord(st)) return null;

    const normalizeMonths = (v: unknown): string[] | null => {
      if (Array.isArray(v)) {
        const arr = v.map((x) => String(x ?? "").trim()).filter(Boolean);
        return arr.length ? arr : null;
      }
      if (typeof v === "string" && v.trim()) {
        const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
        return arr.length ? arr : null;
      }
      return null;
    };

    const getMonthsFn = st["getMonths"];
    if (typeof getMonthsFn === "function") {
      try {
        const res = (getMonthsFn as (key?: string) => unknown).call(st, timelineName);
        const arr = normalizeMonths(res);
        if (arr && arr.length > 0) return arr;
      } catch {
        // No empty.
      }
    }

    const settings = st["settings"];
    if (isRecord(settings)) {
      const tlCfgs = settings["timelineConfigs"];
      if (isRecord(tlCfgs)) {
        const cfgMaybe = tlCfgs[timelineName];
        if (isRecord(cfgMaybe)) {
          const months = cfgMaybe["months"];
          const arr = normalizeMonths(months);
          if (arr && arr.length > 0) return arr;
        }
      }

      const legacy = settings["monthOverrides"];
      if (isRecord(legacy) && Object.prototype.hasOwnProperty.call(legacy, timelineName)) {
        const arr = normalizeMonths(legacy[timelineName]);
        if (arr && arr.length > 0) return arr;
      }
    }

    return null;
  }

  private getTimelineMonths(timelineName: string, overrides: Record<string, string[]>): string[] {
    const ov = overrides[timelineName];
    if (Array.isArray(ov) && ov.length > 0) return ov;

    const st = this.tryGetSimpleTimelineMonths(timelineName);
    if (st && st.length > 0) return st;

    return this.defaultMonths();
  }

  private formatRangeWithMonths(months: string[], start: Ymd, end?: Ymd): string {
    const mName = (m: number) => months[(m - 1 + months.length) % months.length] ?? String(m);
    const fmt = (x: Ymd) => `${x.d} ${mName(x.m)} ${x.y}`;
    if (!end) return fmt(start);
    if (start.y === end.y && start.m === end.m && start.d === end.d) return fmt(start);
    if (start.y === end.y && start.m === end.m) return `${start.d}–${end.d} ${mName(start.m)} ${start.y}`;
    return `${fmt(start)} – ${fmt(end)}`;
  }

  private resolveInternalAttachmentPath(raw: string, fromPath: string): string | null {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return null;

    const stripped = s.startsWith("[[") && s.endsWith("]]") ? s.slice(2, -2).trim() : s;
    const pipe = stripped.indexOf("|");
    const link = pipe >= 0 ? stripped.slice(0, pipe).trim() : stripped;

    const dest = this.app.metadataCache.getFirstLinkpathDest(link, fromPath);
    if (dest instanceof TFile) return dest.path;

    // maybe already a path
    const byPath = this.app.vault.getAbstractFileByPath(normalizePath(link));
    return byPath instanceof TFile ? byPath.path : null;
  }

  private pickTimelineImagePath(file: TFile, fm: Record<string, unknown>): string | undefined {
    const key = this.settings.timelineImageKey || "tl-image";
    const fmImage = fm[key];
    if (typeof fmImage === "string" && fmImage.trim()) {
      const internal = this.resolveInternalAttachmentPath(fmImage, file.path);
      return internal ?? fmImage.trim(); // keep URL as-is
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const exts = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;

    for (const e of cache?.embeds ?? []) {
      if (exts.test(e.link)) {
        const internal = this.resolveInternalAttachmentPath(e.link, file.path);
        if (internal) return internal;
      }
    }
    for (const l of cache?.links ?? []) {
      if (exts.test(l.link)) {
        const internal = this.resolveInternalAttachmentPath(l.link, file.path);
        if (internal) return internal;
      }
    }

    // fallback: first image in same folder
    const parent = file.parent;
    if (parent instanceof TFolder) {
      for (const ch of parent.children) {
        if (ch instanceof TFile && exts.test(ch.name)) return ch.path;
      }
    }

    return undefined;
  }

  private async extractFirstParagraph(file: TFile): Promise<string | undefined> {
    try {
      const raw = await this.app.vault.read(file);
      const text = raw.replace(/^---[\s\S]*?---\s*/m, "");
      const paras = text
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean);

      for (const p of paras) {
        if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/.test(p)) continue;
        let clean = p
          .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/`{1,3}[^`]*`{1,3}/g, "")
          .replace(/[*_~]/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (clean) {
          if (clean.length > 500) clean = `${clean.slice(0, 497)}…`;
          return clean;
        }
      }
    } catch (e) {
      console.warn("TTRPG Tools: Publish: extractFirstParagraph failed", e);
    }
    return undefined;
  }

  private async scanTimelineEntries(): Promise<Array<{ timelines: string[]; entry: TimelineEntry; imgInternal?: string }>> {
    const files = this.app.vault.getMarkdownFiles();
    const out: Array<{ timelines: string[]; entry: TimelineEntry; imgInternal?: string }> = [];

    const dateKey = this.settings.timelineDateKey || "fc-date";
    const endKey = this.settings.timelineEndKey || "fc-end";
    const listKey = this.settings.timelineListKey || "timelines";
    const titleKey = this.settings.timelineTitleKey || "tl-title";
    const summaryKey = this.settings.timelineSummaryKey || "tl-summary";

    for (const f of files) {
      if (this.settings.timelineScanMode === "publishTrueOnly") {
        const fmPub = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
        if (fmPub?.publish !== true) continue;
      }

      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm) continue;

      const start = this.parseFcDate(fm[dateKey]);
      if (!start) continue;

      const timelines = splitTimelineNames(fm[listKey]);
      if (!timelines.length) continue;

      const end = fm[endKey] ? this.parseFcDate(fm[endKey]) ?? undefined : undefined;

      const title = typeof fm[titleKey] === "string" && fm[titleKey].trim() ? fm[titleKey].trim() : f.basename;

      let summary: string | undefined;
      // Important: allow "intentionally empty" summaries:
      // If tl-summary exists in frontmatter (even empty), do NOT auto-extract.
      if (Object.prototype.hasOwnProperty.call(fm, summaryKey)) {
        const v = fm[summaryKey];
        if (typeof v === "string") {
          summary = v; // keep as-is (can be "")
        } else if (typeof v === "number" || typeof v === "boolean") {
          summary = String(v);
        } else if (v == null) {
          summary = "";
        } else {
          // Avoid "[object Object]" (eslint: no-base-to-string)
          try {
            summary = JSON.stringify(v);
          } catch {
            summary = "";
          }
        }
      } else {
        summary = await this.extractFirstParagraph(f);
      }

      const img = this.pickTimelineImagePath(f, fm);
      const imgInternal = img ? this.resolveInternalAttachmentPath(img, f.path) ?? undefined : undefined;

      out.push({
        timelines,
        imgInternal,
        entry: {
          notePath: f.path,
          title,
          summary,
          start,
          end,
          img,
        },
      });
    }

    return out;
  }

  private async cleanupTimelineNotes(keep: Set<string>): Promise<void> {
    const folder = normalizePath(`${this.timelineRoot()}/timelines`);
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/"));
    for (const f of files) {
      if (!f.name.startsWith("t-")) continue;
      if (keep.has(f.path)) continue;
      try {
        await this.app.fileManager.trashFile(f);
      } catch (e) {
        console.warn("Timeline Publish: failed to delete old timeline note", f.path, e);
      }
    }
  }

  private async generateTimelineDataNotes(): Promise<void> {
    const root = this.timelineRoot();
    await this.ensureFolderFor(normalizePath(`${root}/timelines/x.md`));

    const scanned = await this.scanTimelineEntries();
    const byTimeline = new Map<string, TimelineEntry[]>();
    const keepPaths = new Set<string>();
	const monthOverrides = this.parseTimelineMonthOverrides();

    for (const it of scanned) {
      for (const tl of it.timelines) {
        const arr = byTimeline.get(tl) ?? [];
        arr.push({ ...it.entry });
        byTimeline.set(tl, arr);
      }
    }

    for (const [name, entries] of byTimeline.entries()) {
      const months = this.getTimelineMonths(name, monthOverrides);

      for (const e of entries) {
        e.dateText = this.formatRangeWithMonths(months, e.start, e.end);
      }

      entries.sort((a, b) => ymdSortKey(a.start) - ymdSortKey(b.start));

      const notePath = this.timelineDataNotePathForTimelineName(name);
      keepPaths.add(notePath);

      const payload = {
        timelineName: name,
        months,
        entries,
      };

      const md = this.wrapJsonAsPublishNote("timeline", payload, {
        timelineName: name,
        timelineKey: this.timelineDataNoteKeyForTimelineName(name),
      });

      await this.writeOrUpdateMarkdown(notePath, md);
    }

    await this.cleanupTimelineNotes(keepPaths);
    new Notice(`Generated timeline data notes: ${byTimeline.size}`, 15000);
  }

  // =========================
  // Timeline publish (assets)
  // =========================

  private async generateTimelineAssetsManifest(): Promise<void> {
    const assets = new Set<string>();
    const scanned = await this.scanTimelineEntries();

    // include data notes + entry notes + internal images
    const timelines = new Set<string>();
    for (const it of scanned) {
      for (const tl of it.timelines) timelines.add(tl);
      assets.add(normalizePath(it.entry.notePath));
      if (it.imgInternal) assets.add(normalizePath(it.imgInternal));
    }

    for (const tl of timelines) {
      assets.add(this.timelineDataNotePathForTimelineName(tl));
    }

    const notePath = this.timelineAssetsNotePath();
    assets.add(notePath);

    const out = Array.from(assets)
      .filter(Boolean)
      .filter((p) => !p.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));

    await this.ensureFolderFor(notePath);

    const lines: string[] = [];
    lines.push("---");
    lines.push("publish: true");
    lines.push("---");
    lines.push("");
    lines.push("# TTRPG Tools: Timeline – Publish assets");
    lines.push("");
    lines.push("Generated by **TTRPG Tools: Publish**.");
    lines.push("Next: **Publish changes** → select this note → **Add linked** → Publish.");
    lines.push("");
    lines.push("## Assets");
    lines.push("");
    for (const p of out) {
      const link = p.endsWith(".md") ? p.slice(0, -3) : p;
      lines.push(`- [[${link}]]`);
    }
    lines.push("");

    await this.writeOrUpdateMarkdown(notePath, lines.join("\n"));
    new Notice(`Generated: ${notePath}`, 15000);
  }

  private async generateAssetsManifest(): Promise<void> {
    const assets = new Set<string>();

    // Always include the publish data notes themselves
    assets.add(this.libraryNotePath());
    assets.add(this.settings.assetsNotePath);

    const maps = await this.scanZoommaps();

    // Link to each marker note (NOT the json)
    for (const m of maps) {
      assets.add(this.markerNotePathForMarkersPath(m.markersPath));
      for (const p of m.assetPaths) assets.add(normalizePath(p));
    }
	
    const libIndex = this.settings.includePinLinkedNotesInAssets
      ? await this.buildLibraryLinkIndex(this.resolveZoomMapLibraryJsonPath())
      : null;

    if (this.settings.includePinLinkedNotesInAssets) {
      for (const m of maps) {
        await this.addLinkedNotesFromMarkersJson(m.markersPath, m.notePath, assets, libIndex);
      }
    }

    // Expand assets by reading marker json (stickers, baked svg, overlays, bases)
    for (const m of maps) {
      await this.addAssetsFromMarkersJson(m.markersPath, assets);
    }
	
    if (this.settings.rasterizeTextLayersToWebp) {
      for (const m of maps) {
        const markerJsonFile = this.resolveVaultFile(m.markersPath);
        if (!markerJsonFile) continue;
        try {
          const raw = await this.app.vault.read(markerJsonFile);
          const data = JSON.parse(raw) as Record<string, unknown>;
          const basePaths = this.extractMarkerBasePaths(data, m.basePaths, m.notePath);
          const out = this.computeTextLayerRasterOutputPaths(m.markersPath, basePaths, data);
          for (const p of Object.values(out)) assets.add(normalizePath(p));
        } catch {
          // ignore
        }
      }
    }

    // Expand assets from library.json (icon files, sticker presets)
    await this.addAssetsFromLibraryJson(this.resolveZoomMapLibraryJsonPath(), assets);

    // Filter + sort
    const configDirPrefix = normalizePath(`${this.app.vault.configDir}/`);
    const out = Array.from(assets)
      .filter((p) => {
        if (!p) return false;
        return !normalizePath(p).startsWith(configDirPrefix);
      })
      .filter((p) => !p.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));

    const notePath = normalizePath(this.settings.assetsNotePath || DEFAULT_SETTINGS.assetsNotePath);
    await this.ensureFolderFor(notePath);

    const lines: string[] = [];
    lines.push("---");
    lines.push("publish: true");
    lines.push("---");
    lines.push("");
    lines.push("# TTRPG Tools: Maps – Publish assets");
    lines.push("");
    lines.push("Generated by **TTRPG Tools: Publish**.");
    lines.push("Publish this note, then use **Publish changes → Add linked** to include all map assets.");
    lines.push("");
    lines.push("## Assets");
    lines.push("");

    for (const p of out) {
      // use wiki links for both md + attachments
      const link = p.endsWith(".md") ? p.slice(0, -3) : p;
      lines.push(`- [[${link}]]`);
    }
    lines.push("");

    await this.writeOrUpdateMarkdown(notePath, lines.join("\n"));

    new Notice(`Generated: ${notePath}`, 15000);
    new Notice("Next: Publish changes → select ZoomMap/publish/assets.md → Add linked → Publish.", 15000);
  }

  private async scanZoommaps(): Promise<Array<{ notePath: string; markersPath: string; assetPaths: string[]; basePaths: string[] }>> {
    const files = this.app.vault.getMarkdownFiles();
    const out: Array<{ notePath: string; markersPath: string; assetPaths: string[]; basePaths: string[] }> = [];

    for (const f of files) {
      if (this.settings.scanMode === "publishTrueOnly") {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
        if (fm?.publish !== true) continue;
      }

      const text = await this.app.vault.read(f);
      const blocks = this.extractZoommapCodeblocks(text);

      for (const src of blocks) {
        let obj: unknown;
        try {
          obj = parseYaml(src);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== "object") continue;
        const y = obj as Record<string, unknown>;

        const image = this.scalarString(y, "image") || this.firstBaseFromYaml(y);
        if (!image) continue;

        const markers = this.scalarString(y, "markers") || `${image}.markers.json`;
		
        const basesFromYaml = this.parseYamlPathList(y["imageBases"]);
        const basePaths = basePathsFromZoommapScan(image, basesFromYaml);

        const assetPaths: string[] = [];
        assetPaths.push(image);

        for (const p of this.parseYamlPathList(y["imageBases"])) assetPaths.push(p);
        for (const p of this.parseYamlPathList(y["imageOverlays"])) assetPaths.push(p);

        const frame = this.scalarString(y, "viewportFrame");
        if (frame) assetPaths.push(frame);

        out.push({
          notePath: f.path,
          markersPath: normalizePath(markers),
          assetPaths,
		  basePaths,
        });
      }
    }

    return out;
  }
  


  private extractZoommapCodeblocks(noteText: string): string[] {
    const lines = noteText.split("\n");
    const blocks: string[] = [];

    let inBlock = false;
    let buf: string[] = [];

    const isFenceOpen = (ln: string) => stripQuotePrefix(ln).trimStart().toLowerCase().startsWith("```zoommap");
    const isFenceClose = (ln: string) => stripQuotePrefix(ln).trimStart().startsWith("```");

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];

      if (!inBlock) {
        if (isFenceOpen(ln)) {
          inBlock = true;
          buf = [];
        }
        continue;
      }

      if (isFenceClose(ln)) {
        inBlock = false;
        blocks.push(buf.join("\n"));
        buf = [];
        continue;
      }

      buf.push(stripQuotePrefix(ln));
    }

    return blocks;
  }

  private scalarString(obj: Record<string, unknown>, key: string): string {
    const v = obj[key];
    return typeof v === "string" ? v.trim() : "";
  }

  private firstBaseFromYaml(obj: Record<string, unknown>): string {
    const v = obj["imageBases"];
    const paths = this.parseYamlPathList(v);
    return paths[0] ?? "";
  }

  private parseYamlPathList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const it of v) {
      if (typeof it === "string") {
        const p = it.trim();
        if (p) out.push(p);
        continue;
      }
      if (it && typeof it === "object" && "path" in it) {
        const p = (it as { path?: unknown }).path;
        if (typeof p === "string" && p.trim()) out.push(p.trim());
      }
    }
    return out;
  }

  private resolveVaultFile(path: string): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return af instanceof TFile ? af : null;
  }

  private async addAssetsFromMarkersJson(markersPath: string, assets: Set<string>): Promise<void> {
    const af = this.resolveVaultFile(markersPath);
    if (!af) return;

    try {
      const raw = await this.app.vault.read(af);
      const data = JSON.parse(raw) as Record<string, unknown>;

      // bases
      if (Array.isArray(data.bases)) {
        for (const it of data.bases) {
          if (typeof it === "string" && it.trim()) assets.add(normalizePath(it.trim()));
          else if (it && typeof it === "object" && "path" in it) {
            const p = (it as { path?: unknown }).path;
            if (typeof p === "string" && p.trim()) assets.add(normalizePath(p.trim()));
          }
        }
      }

      // overlays
      if (Array.isArray(data.overlays)) {
        for (const it of data.overlays) {
          if (it && typeof it === "object" && "path" in it) {
            const p = (it as { path?: unknown }).path;
            if (typeof p === "string" && p.trim()) assets.add(normalizePath(p.trim()));
          }
        }
      }

      // stickers
      if (Array.isArray(data.markers)) {
        for (const m of data.markers) {
          if (!m || typeof m !== "object") continue;
          const type = (m as { type?: unknown }).type;
          if (type === "sticker") {
            const sp = (m as { stickerPath?: unknown }).stickerPath;
            if (typeof sp === "string" && sp.trim()) assets.add(normalizePath(sp.trim()));
          }
        }
      }

      // baked SVG from drawings
      if (Array.isArray(data.drawings)) {
        for (const d of data.drawings) {
          if (!d || typeof d !== "object") continue;
          const bp = (d as { bakedPath?: unknown }).bakedPath;
          if (typeof bp === "string" && bp.trim()) assets.add(normalizePath(bp.trim()));
        }
      }
    } catch (e) {
      console.warn("TTRPG Tools: Publish: failed to parse markers json", markersPath, e);
    }
  }

  private async addAssetsFromLibraryJson(libraryJsonPath: string, assets: Set<string>): Promise<void> {
    const af = this.resolveVaultFile(libraryJsonPath);
    if (!af) return;

    try {
      const raw = await this.app.vault.read(af);
      const obj = JSON.parse(raw) as Record<string, unknown>;

      const icons = Array.isArray(obj.icons) ? (obj.icons as unknown[]) : [];
      for (const it of icons) {
        if (!it || typeof it !== "object") continue;
        const src = (it as { pathOrDataUrl?: unknown }).pathOrDataUrl;
        if (
          typeof src === "string" &&
          src.trim() &&
          !src.trim().startsWith("data:") &&
          !/^https?:\/\//i.test(src.trim())
        ) {
          assets.add(normalizePath(src.trim()));
        }
      }

      const cols = Array.isArray(obj.baseCollections) ? (obj.baseCollections as unknown[]) : [];
      for (const c of cols) {
        if (!isRecord(c)) continue;
        const include = c.include;
        if (!isRecord(include)) continue;

        const stickersRaw = include.stickers;
        const stickers = Array.isArray(stickersRaw) ? stickersRaw : [];
        for (const s of stickers) {
          if (!isRecord(s)) continue;
          const p = s.imagePath;
          if (typeof p === "string" && p.trim() && !p.trim().startsWith("data:")) {
            assets.add(normalizePath(p.trim()));
          }
        }
      }
    } catch (e) {
      console.warn("TTRPG Tools: Publish: failed to parse library json", libraryJsonPath, e);
    }
  }
  
  private getZoomMapPluginApi(): ZoomMapPluginApi | null {
    try {
      const pluginsAny = (this.app as unknown as { plugins?: unknown }).plugins;
      if (!isRecord(pluginsAny)) return null;

      let pl: unknown = null;
      const getPlugin = pluginsAny["getPlugin"];
      if (typeof getPlugin === "function") {
        try {
          pl = (getPlugin as (id: string) => unknown).call(pluginsAny, "zoom-map");
        } catch {
          pl = null;
        }
      }

      if (!pl) {
        const pluginsMap = pluginsAny["plugins"];
        if (isRecord(pluginsMap)) {
          pl = pluginsMap["zoom-map"];
        }
      }

      if (!isRecord(pl)) return null;
      const fn = pl["saveLibraryToPath"];
      if (typeof fn !== "function") return null;

      const settings = pl["settings"];
      const libraryFilePath =
        isRecord(settings) && typeof settings["libraryFilePath"] === "string"
          ? String(settings["libraryFilePath"])
          : undefined;

      return {
        saveLibraryToPath: (path: string) => (fn as (p: string) => Promise<void>).call(pl, path),
        libraryFilePath,
      };
    } catch (e) {
      console.warn("TTRPG Tools: Publish: getZoomMapPluginApi failed.", e);
      return null;
    }
  }

  private async ensureFolderFor(path: string): Promise<void> {
    const dir = normalizePath(path).split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }
  }

  private async writeOrUpdateMarkdown(path: string, content: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (af instanceof TFile) {
      const cur = await this.app.vault.read(af);
      if (cur === content) return;
      await this.app.vault.modify(af, content);
      return;
    }
    await this.app.vault.create(path, content);
  }
  
  private stripWikiBrackets(s: string): string {
    const t = String(s ?? "").trim();
    if (t.startsWith("[[") && t.endsWith("]]")) return t.slice(2, -2).trim();
    return t;
  }

  private normalizeLinkTarget(raw: string): string {
    let s = this.stripWikiBrackets(raw);
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return "";
    const pipe = s.indexOf("|");
    if (pipe >= 0) s = s.slice(0, pipe).trim();
    const hash = s.indexOf("#");
    if (hash >= 0) s = s.slice(0, hash).trim();
    const block = s.indexOf("^");
    if (block >= 0) s = s.slice(0, block).trim();
    return s;
  }

  private resolveLinkedNotePath(link: string, fromNotePath: string): string | null {
    const target = this.normalizeLinkTarget(link);
    if (!target) return null;

    const byPath = this.app.vault.getAbstractFileByPath(normalizePath(target));
    if (byPath instanceof TFile && byPath.extension?.toLowerCase() === "md") {
      return byPath.path;
    }

    const dest = this.app.metadataCache.getFirstLinkpathDest(target, fromNotePath);
    if (dest instanceof TFile && dest.extension?.toLowerCase() === "md") {
      return dest.path;
    }

    return null;
  }

  private async buildLibraryLinkIndex(libraryJsonPath: string): Promise<LibraryLinkIndex> {
    const iconDefaultLinks = new Map<string, string>();
    const swapPresets = new Map<string, { frameLinks: string[]; frameIconKeys: string[] }>();

    const af = this.resolveVaultFile(libraryJsonPath);
    if (!af) {
      return { iconDefaultLinks, swapPresets };
    }

    try {
      const raw = await this.app.vault.read(af);
      const obj = JSON.parse(raw) as Record<string, unknown>;

      const icons = Array.isArray(obj.icons) ? (obj.icons as unknown[]) : [];
      for (const it of icons) {
        if (!it || typeof it !== "object") continue;
        const key = (it as { key?: unknown }).key;
        const dl = (it as { defaultLink?: unknown }).defaultLink;
        if (typeof key === "string" && key.trim() && typeof dl === "string" && dl.trim()) {
          iconDefaultLinks.set(key.trim(), dl.trim());
        }
      }

      const cols = Array.isArray(obj.baseCollections) ? (obj.baseCollections as unknown[]) : [];
      for (const c of cols) {
        if (!isRecord(c)) continue;
        const include = c.include;
        if (!isRecord(include)) continue;

        const swapPinsRaw = include.swapPins;
        const swapPins = Array.isArray(swapPinsRaw) ? swapPinsRaw : [];
        for (const sp of swapPins) {
          if (!isRecord(sp)) continue;
          const id = sp.id;
          if (typeof id !== "string" || !id.trim()) continue;

          const framesRaw = sp.frames;
          const frames = Array.isArray(framesRaw) ? framesRaw : [];
          const frameLinks: string[] = [];
          const frameIconKeys: string[] = [];
          for (const fr of frames) {
            if (!isRecord(fr)) continue;
            const iconKey = fr.iconKey;
            const link = fr.link;
            if (typeof iconKey === "string" && iconKey.trim()) frameIconKeys.push(iconKey.trim());
            if (typeof link === "string" && link.trim()) frameLinks.push(link.trim());
          }

          const prev = swapPresets.get(id.trim());
          if (!prev) {
            swapPresets.set(id.trim(), { frameLinks, frameIconKeys });
          } else {
            prev.frameLinks.push(...frameLinks);
            prev.frameIconKeys.push(...frameIconKeys);
          }
        }
      }
    } catch {
      return { iconDefaultLinks, swapPresets };
    }

    for (const v of swapPresets.values()) {
      v.frameLinks = Array.from(new Set(v.frameLinks.filter(Boolean)));
      v.frameIconKeys = Array.from(new Set(v.frameIconKeys.filter(Boolean)));
    }

    return { iconDefaultLinks, swapPresets };
  }

  private async addLinkedNotesFromMarkersJson(
    markersPath: string,
    fromNotePath: string,
    assets: Set<string>,
    libIndex: LibraryLinkIndex | null,
  ): Promise<void> {
    const af = this.resolveVaultFile(markersPath);
    if (!af) return;

    let data: Record<string, unknown>;
    try {
      const raw = await this.app.vault.read(af);
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const addLink = (rawLink: string) => {
      const p = this.resolveLinkedNotePath(rawLink, fromNotePath);
      if (p) assets.add(normalizePath(p));
    };

    const markers = Array.isArray(data.markers) ? (data.markers as unknown[]) : [];
    for (const mm of markers) {
      if (!mm || typeof mm !== "object") continue;
      const m = mm as Record<string, unknown>;

      const link = m.link;
      if (typeof link === "string" && link.trim()) addLink(link);

      const type = m.type;
      if (type !== "swap") {
        continue;
      }

      const swapLinks = m.swapLinks;
      if (swapLinks && typeof swapLinks === "object") {
        for (const v of Object.values(swapLinks as Record<string, unknown>)) {
          if (typeof v === "string" && v.trim()) addLink(v);
        }
      }

      const swapKey = m.swapKey;
      if (!libIndex) continue;
      if (typeof swapKey !== "string" || !swapKey.trim()) continue;

      const preset = libIndex.swapPresets.get(swapKey.trim());
      if (preset) {
        for (const l of preset.frameLinks) addLink(l);
        for (const iconKey of preset.frameIconKeys) {
          const dl = libIndex.iconDefaultLinks.get(iconKey);
          if (dl) addLink(dl);
        }
      }
    }
  }
  private computeTextLayerRasterOutputPaths(
    markersPath: string,
    basePaths: string[],
    markerData: Record<string, unknown>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const textLayers = Array.isArray(markerData.textLayers) ? markerData.textLayers : [];
    if (!textLayers.length) return out;

    const mpId = hashPathToId(markersPath);
    for (const basePath of basePaths) {
      const bpTarget = this.normalizeLinkTarget(basePath) || String(basePath ?? "");
      const bp = normalizePath(bpTarget);
      if (!bp) continue;

      const relevant = textLayers.some((tl) => {
        if (!tl || typeof tl !== "object") return false;
        const bound = (tl as { boundBase?: unknown }).boundBase;
        if (typeof bound === "string" && bound.trim()) return normalizePath(bound.trim()) === bp;
        return true;
      });
      if (!relevant) continue;

      const baseId = hashPathToId(bp);
      out[bp] = normalizePath(`${this.textLayerRasterRoot()}/tl-${mpId}-${baseId}.webp`);
    }

    return out;
  }

  private async loadImageSize(path: string, fromNotePath: string): Promise<{ w: number; h: number } | null> {
    const target = this.normalizeLinkTarget(path) || String(path ?? "");
    if (!target || /^https?:\/\//i.test(target) || /^data:/i.test(target)) return null;
    const p = normalizePath(target);
    const byPath = this.app.vault.getAbstractFileByPath(p);
    const f =
      byPath instanceof TFile
        ? byPath
        : this.app.metadataCache.getFirstLinkpathDest(p, fromNotePath);
    if (!(f instanceof TFile)) return null;

    const url = this.app.vault.getResourcePath(f);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await img.decode();
    } catch {
      // ignore
    }

    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (w > 0 && h > 0) return { w, h };
    return null;
  }

  private resolveCssToCanvasColor(color: string): string {
    const el = document.createElement("span");
    setCssProps(el, {
      color,
      position: "absolute",
      left: "-10000px",
      top: "-10000px",
    });
    document.body.appendChild(el);
    const out = window.getComputedStyle(el).color || "#ffffff";
    el.remove();
    return out;
  }

  private resolveCssToCanvasFontFamily(fontFamily: string): string {
    const el = document.createElement("span");
    setCssProps(el, {
      "font-family": fontFamily,
      position: "absolute",
      left: "-10000px",
      top: "-10000px",
    });
    document.body.appendChild(el);
    const out = window.getComputedStyle(el).fontFamily || "sans-serif";
    el.remove();
    return out;
  }
  
  private async ensureCanvasFontLoaded(fontSpec: string, sampleText: string): Promise<void> {
    const spec = String(fontSpec ?? "").trim();
    if (!spec) return;
    if (this.loadedCanvasFonts.has(spec)) return;

    const fonts = (document as unknown as { fonts?: unknown }).fonts as
      | { load?: (font: string, text?: string) => Promise<unknown>; ready?: Promise<unknown> }
      | undefined;

    if (!fonts || typeof fonts.load !== "function") {
      this.loadedCanvasFonts.add(spec);
      return;
    }

    const sample = String(sampleText ?? "").trim() || "AaBbYyZz 0123456789";
    const timeout = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    try { await Promise.race([fonts.load(spec, sample).then(() => undefined), timeout(1200)]); } catch { /* ignore */ }
    try { if (fonts.ready) await Promise.race([fonts.ready.then(() => undefined), timeout(1200)]); } catch { /* ignore */ }
    this.loadedCanvasFonts.add(spec);
  }

  private async writeWebpToVault(path: string, canvas: HTMLCanvasElement, quality = 0.92): Promise<void> {
    const dir = normalizePath(path).split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }

    const q = Math.min(1, Math.max(0.1, quality));
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/webp", q);
    });

    const p = normalizePath(path);
    const buf = await blob.arrayBuffer();

    const anyAdapter = this.app.vault.adapter as unknown as { writeBinary?: (path: string, data: ArrayBuffer) => Promise<void> };
    if (typeof anyAdapter.writeBinary === "function") {
      await anyAdapter.writeBinary(p, buf);
      return;
    }

    const af = this.app.vault.getAbstractFileByPath(p);
    if (af instanceof TFile) {
      // @ts-expect-error modifyBinary exists on newer Obsidian builds
      await this.app.vault.modifyBinary(af, buf);
    } else {
      // @ts-expect-error createBinary exists on newer Obsidian builds
      await this.app.vault.createBinary(p, buf);
    }
  }

  private async rasterizeTextLayersForPublish(args: {
    markersPath: string;
    mapNotePath: string;
    basePaths: string[];
    data: Record<string, unknown>;
  }): Promise<Record<string, string>> {
    const out = this.computeTextLayerRasterOutputPaths(args.markersPath, args.basePaths, args.data);
    const wanted = Object.entries(out);
    if (wanted.length === 0) return {};

    const textLayers = Array.isArray(args.data.textLayers) ? args.data.textLayers : [];
    const size = (args.data.size ?? null) as { w?: unknown; h?: unknown } | null;

    for (const [basePath, outPath] of wanted) {
      const bp = normalizePath(basePath);
      if (!bp) continue;

      const sz = await this.loadImageSize(bp, args.mapNotePath);
      const w =
        sz?.w ??
        (typeof size?.w === "number" && Number.isFinite(size.w) ? size.w : 0);
      const h =
        sz?.h ??
        (typeof size?.h === "number" && Number.isFinite(size.h) ? size.h : 0);
      if (!(w > 0 && h > 0)) continue;

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w);
      canvas.height = Math.round(h);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";

      for (const tl of textLayers) {
        if (!tl || typeof tl !== "object") continue;
        const bound = (tl as { boundBase?: unknown }).boundBase;
        if (typeof bound === "string" && bound.trim()) {
          if (normalizePath(bound.trim()) !== bp) continue;
        }

        const style = ((tl as { style?: unknown }).style ?? {}) as Record<string, unknown>;
        const fontSize = typeof style.fontSize === "number" && Number.isFinite(style.fontSize) && style.fontSize > 1 ? style.fontSize : 14;
        const fontWeight = typeof style.fontWeight === "string" && style.fontWeight.trim() ? style.fontWeight.trim() : "400";
        const italic = style.italic === true;
        const padLeft = typeof style.padLeft === "number" && Number.isFinite(style.padLeft) && style.padLeft >= 0 ? style.padLeft : 0;
        const colorRaw = typeof style.color === "string" && style.color.trim() ? style.color.trim() : "var(--text-normal)";
        const fontFamilyRaw = typeof style.fontFamily === "string" && style.fontFamily.trim() ? style.fontFamily.trim() : "var(--font-text)";

        const color = this.resolveCssToCanvasColor(colorRaw);
        const fontFamily = this.resolveCssToCanvasFontFamily(fontFamilyRaw);
        ctx.fillStyle = color;
        const fontSpec = `${italic ? "italic " : ""}${fontWeight} ${fontSize}px ${fontFamily}`;

        const lines = Array.isArray((tl as { lines?: unknown }).lines) ? (tl as { lines: unknown[] }).lines : [];
        const sampleText = lines
          .map((ln) => (ln && typeof (ln as { text?: unknown }).text === "string" ? String((ln as { text?: unknown }).text) : ""))
          .filter((s) => s.trim().length > 0)
          .join(" ")
          .slice(0, 280);

        await this.ensureCanvasFontLoaded(fontSpec, sampleText);
        ctx.font = fontSpec;
        for (const ln of lines) {
          if (!ln || typeof ln !== "object") continue;
          const x0 = (ln as { x0?: unknown }).x0;
          const y0 = (ln as { y0?: unknown }).y0;
          const x1 = (ln as { x1?: unknown }).x1;
          const y1 = (ln as { y1?: unknown }).y1;
          const text = (ln as { text?: unknown }).text;
          if (typeof x0 !== "number" || typeof y0 !== "number" || typeof x1 !== "number" || typeof y1 !== "number") continue;
          const txt = typeof text === "string" ? text.trimEnd() : "";
          if (!txt) continue;

          const ax0 = x0 * w;
          const ay0 = y0 * h;
          const ax1 = x1 * w;
          const ay1 = y1 * h;
          const dx = ax1 - ax0;
          const dy = ay1 - ay0;
          const angle = Math.atan2(dy, dx);

          ctx.save();
          ctx.translate(ax0 + padLeft, ay0);
          if (Math.abs(angle) > 1e-6) ctx.rotate(angle);
          ctx.fillText(txt, 0, 0);
          ctx.restore();
        }
      }

      await this.writeWebpToVault(outPath, canvas, 0.92);
    }

    return out;
  }
}

class PublishToolsSettingTab extends PluginSettingTab {
  plugin: TtrpgToolsPublishPlugin;

  constructor(app: App, plugin: TtrpgToolsPublishPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Ttrpg tools: timeline").setHeading();

    new Setting(containerEl)
      .setName("Timeline scan mode")
      .setDesc("Either all Markdown notes are scanned, or only those with the property publish: true")
      .addDropdown((d) => {
        d.addOption("publishTrueOnly", "Only publish: true notes");
        d.addOption("allMarkdown", "All Markdown notes");
        d.setValue(this.plugin.settings.timelineScanMode);
        d.onChange(async (v) => {
          this.plugin.settings.timelineScanMode = (v === "allMarkdown") ? "allMarkdown" : "publishTrueOnly";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Timeline root folder")
      .setDesc("Where timeline data notes are generated (must match runtime).")
      .addText((t) => {
        t.setPlaceholder("Timeline/publish");
        t.setValue(this.plugin.settings.timelineRoot);
        t.onChange(async (v) => {
          this.plugin.settings.timelineRoot = normalizePath(v.trim() || "Timeline/publish");
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Timeline assets manifest note")
      .setDesc("This note is generated; use publish → add linked on it.")
      .addText((t) => {
        t.setPlaceholder("Timeline/publish/assets.md");
        t.setValue(this.plugin.settings.timelineAssetsNotePath);
        t.onChange(async (v) => {
          this.plugin.settings.timelineAssetsNotePath = normalizePath(v.trim() || "Timeline/publish/assets.md");
          await this.plugin.saveSettings();
        });
      });
	  
    new Setting(containerEl)
      .setName("Use custom month names")
      .setDesc("Use the custom month names from your timeline settings.")
      .addToggle((t) => {
        t.setValue(!!this.plugin.settings.timelineUseSimpleTimelineMonths);
        t.onChange(async (v) => {
          this.plugin.settings.timelineUseSimpleTimelineMonths = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Timeline: month overrides (optional).")
      .setDesc("Overrides per timeline name. Example:\ntravelbook 1: [januar, februar, ...]")
      .addTextArea((ta) => {
        ta.inputEl.rows = 6;
        ta.setPlaceholder("Travelbook 1:...");
        ta.setValue(this.plugin.settings.timelineMonthOverridesYaml ?? "");
        ta.onChange(async (v) => {
          this.plugin.settings.timelineMonthOverridesYaml = v ?? "";
          await this.plugin.saveSettings();
        });
      });
	  
	new Setting(containerEl).setName("Ttrpg tools: maps").setHeading();
	
    new Setting(containerEl)
      .setName("Rasterize text layers to webp (publish)")
      .setDesc("Generates per-base transparent webp overlays for text layers, so local fonts don't break layout on publish.")
      .addToggle((t) => {
        t.setValue(!!this.plugin.settings.rasterizeTextLayersToWebp);
        t.onChange(async (v) => {
          this.plugin.settings.rasterizeTextLayersToWebp = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Text layer raster output folder")
      .setDesc("Vault folder where the generated webp overlays are stored.")
      .addText((t) => {
        t.setPlaceholder("Zoommap/publish/textlayers");
        t.setValue(this.plugin.settings.textLayerRasterRoot ?? DEFAULT_SETTINGS.textLayerRasterRoot);
        t.onChange(async (v) => {
          this.plugin.settings.textLayerRasterRoot = normalizePath(v.trim() || DEFAULT_SETTINGS.textLayerRasterRoot);
          await this.plugin.saveSettings();
        });
      });
	  
    new Setting(containerEl)
      .setName("Publish: text layer webp overlays")
      .setDesc("If enabled, ttrpg tools: publish generates transparent webp overlays per base image for text layers.")
      .addToggle((t) => {
        t.setValue(!!this.plugin.settings.rasterizeTextLayersToWebp);
        t.onChange(async (v) => {
          this.plugin.settings.rasterizeTextLayersToWebp = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Publish: text layer overlay folder")
      .setDesc("Vault folder where the generated webp overlays are stored.")
      .addText((t) => {
        t.setPlaceholder("Zoommap/publish/textlayers");
        t.setValue(this.plugin.settings.textLayerRasterRoot ?? DEFAULT_SETTINGS.textLayerRasterRoot);
        t.onChange(async (v) => {
          this.plugin.settings.textLayerRasterRoot = normalizePath(v.trim() || DEFAULT_SETTINGS.textLayerRasterRoot);
          await this.plugin.saveSettings();
        });
      });
	
    new Setting(containerEl)
      .setName("Maps scan mode")
      .setDesc("Either all Markdown notes are scanned, or only those with the property publish: true")
      .addDropdown((d) => {
        d.addOption("publishTrueOnly", "Only publish: true notes");
        d.addOption("allMarkdown", "All Markdown notes");
        d.setValue(this.plugin.settings.scanMode);
        d.onChange(async (v) => {
          this.plugin.settings.scanMode = (v === "allMarkdown") ? "allMarkdown" : "publishTrueOnly";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Publish data root folder")
      .setDesc("All publish data notes will be written here.")
      .addText((t) => {
        t.setPlaceholder("Zoommap/publish");
        t.setValue(this.plugin.settings.publishRoot);
        t.onChange(async (v) => {
          this.plugin.settings.publishRoot = normalizePath(v.trim() || "ZoomMap/publish");
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Assets manifest note path")
      .setDesc("This note is generated and contains links to all needed assets.")
      .addText((t) => {
        t.setPlaceholder("ZoomMap/publish/assets.md");
        t.setValue(this.plugin.settings.assetsNotePath);
        t.onChange(async (v) => {
          this.plugin.settings.assetsNotePath = normalizePath(v.trim() || "ZoomMap/publish/assets.md");
          await this.plugin.saveSettings();
        });
      });
	  
    new Setting(containerEl)
      .setName("Assets: include linked notes from pins")
      .setDesc("Optional. If enabled, the assets manifest also includes all notes linked from markers (pins, swap pins, ping pins, etc.).")
      .addToggle((t) => {
        t.setValue(!!this.plugin.settings.includePinLinkedNotesInAssets);
        t.onChange(async (v) => {
          this.plugin.settings.includePinLinkedNotesInAssets = v;
          await this.plugin.saveSettings();
        });
      });
	  
    new Setting(containerEl).setName("Website").setHeading();

    new Setting(containerEl)
      .setName("Hover popover max width")
      .setDesc("CSS size value (e.g. 720px, 60rem). Affects page preview popovers on your publish website.")
      .addText((t) => {
        t.setPlaceholder("720px");
        t.setValue(this.plugin.settings.hoverPopoverMaxWidth ?? DEFAULT_SETTINGS.hoverPopoverMaxWidth);
        t.onChange(async (v) => {
          this.plugin.settings.hoverPopoverMaxWidth = v ?? "";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Hide folders in publish navigation")
      .setDesc("One per line or comma separated. Notes stay published and hover previews still work.")
      .addTextArea((t) => {
        t.setPlaceholder("Gm/secrets\narchive");
        t.setValue(this.plugin.settings.hideNavFolders ?? "");
        t.onChange(async (v) => {
          this.plugin.settings.hideNavFolders = v ?? "";
          await this.plugin.saveSettings();
        });
      });
  }
}

// local helper: handle zoommap blocks inside callouts
function stripQuotePrefix(line: string): string {
  let s = line ?? "";
  while (true) {
    const m = /^\s*>\s*/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}