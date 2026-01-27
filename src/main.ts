import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  parseYaml,
} from "obsidian";
import type { App } from "obsidian";

import { hashPathToId, normalizeForHash } from "./hash";
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
  assetsNotePath: string;    // ZoomMap/publish/assets.md
}

const DEFAULT_SETTINGS: PublishToolsSettings = {
  scanMode: "publishTrueOnly",
  publishRoot: "ZoomMap/publish",
  assetsNotePath: "ZoomMap/publish/assets.md",
};

// Minimal interface to call into Zoom Map plugin if installed.
interface ZoomMapPluginApi {
  saveLibraryToPath: (path: string) => Promise<void>;
  libraryFilePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

export default class TtrpgToolsPublishPlugin extends Plugin {
  settings: PublishToolsSettings = DEFAULT_SETTINGS;

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

  private async prepareAll(): Promise<void> {
    await this.installPublishRuntime();
    await this.generatePublishDataNotes();
    await this.generateAssetsManifest();
    new Notice(
      "TTRPG Tools: Publish: done. Next: Publish changes → select publish.js/publish.css and ZoomMap/publish/assets.md → Add linked → Publish.",
      9000,
    );
  }

  private async installPublishRuntime(): Promise<void> {
    const jsPath = "publish.js";
    const cssPath = "publish.css";

    const stamp = String(this.manifest.version ?? "");

    const jsBlock = buildPublishJsBlock(stamp);
    const cssBlock = buildPublishCssBlock();

    await this.upsertRootFileBlock(jsPath, ZM_BEGIN_JS, ZM_END_JS, jsBlock);
    await this.upsertRootFileBlock(cssPath, ZM_BEGIN_CSS, ZM_END_CSS, cssBlock);

    new Notice("Publish runtime installed/updated: publish.js + publish.css", 2500);
    new Notice("Reminder: publish.js works only with a custom domain and must be published.", 6000);
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
	
    let updatedMarkerNotes = 0;
    let skippedMarkerNotes = 0;

    try {
      await this.exportLibraryNote();
    } catch (e) {
      console.warn("TTRPG Tools: Publish: exportLibraryNote failed (continuing with markers).", e);
      new Notice("Tttrpg tools: publish: library export failed (see console). Markers will still be generated.", 6000);
    }

    // 2) Scan notes for zoommap blocks → collect markersPath set
    const maps = await this.scanZoommaps();
    const markerNotePaths = new Set<string>();

    for (const m of maps) {
      const markersPath = m.markersPath;
      const markerJsonFile = this.resolveVaultFile(markersPath);
	  const sourceMtime = markerJsonFile?.stat?.mtime;
      if (!markerJsonFile) {
        new Notice(`TTRPG Tools: Publish: missing marker file: ${markersPath}`, 6000);
        continue;
      }

      const raw = await this.app.vault.read(markerJsonFile);
      // Ensure it's valid JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        new Notice(`TTRPG Tools: Publish: invalid JSON: ${markersPath}`, 6000);
        continue;
      }

      const notePath = this.markerNotePathForMarkersPath(markersPath);
      markerNotePaths.add(notePath);
	  
      const existing = this.app.vault.getAbstractFileByPath(notePath);
      if (existing instanceof TFile) {
        const cur = await this.app.vault.read(existing);
        const fm = readFrontmatter(cur);
        const prevMtime = fmNumber(fm, "zoommapSourceMtime");
        if (prevMtime !== undefined && sourceMtime !== undefined && prevMtime === sourceMtime) {
          skippedMarkerNotes++;
          continue;
        }
      }

      const md = this.wrapJsonAsPublishNote(
        "markers",
        parsed,
        {
          zoommapMarkersPath: normalizeForHash(markersPath),
          sourceFile: markerJsonFile.path,
          zoommapSourceMtime: sourceMtime,
        },
      );

      await this.writeOrUpdateMarkdown(notePath, md);
	  updatedMarkerNotes++;
    }

    // 3) Cleanup old marker notes (only generated files m-*.md)
    await this.cleanupMarkerNotes(markerNotePaths);

    new Notice(
      `Generated publish marker notes: ${markerNotePaths.size} (updated: ${updatedMarkerNotes}, unchanged: ${skippedMarkerNotes})`,
      2500,
    );
  }

  private async exportLibraryNote(): Promise<void> {
    const LIB_JSON = this.resolveZoomMapLibraryJsonPath();
    const LIB_NOTE = this.libraryNotePath();

    if (!this.resolveVaultFile(LIB_JSON)) {
      const zm = this.getZoomMapPluginApi();
      if (zm) await zm.saveLibraryToPath(LIB_JSON);
    }

    const libFile = this.resolveVaultFile(LIB_JSON);
    if (!libFile) {
      new Notice(
       `TTRPG Tools: Publish: library JSON missing: ${LIB_JSON}. Export it once from Zoom Map settings (Library file path).`,
         9000,
        9000,
      );
      return;
    }

    const raw = await this.app.vault.read(libFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      new Notice("Ttrpg tools: publish: library.json is invalid JSON.", 6000);
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
    new Notice(`Generated: ${LIB_NOTE}`, 2000);
  }

  private wrapJsonAsPublishNote(kind: "library" | "markers", obj: unknown, meta?: Record<string, unknown>): string {
    const fm: Record<string, unknown> = {
      publish: true,
      ttrpgtools: "ttrpgtools-maps-publish",
      zoommapData: kind,
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

    // Expand assets by reading marker json (stickers, baked svg, overlays, bases)
    for (const m of maps) {
      await this.addAssetsFromMarkersJson(m.markersPath, assets);
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

    new Notice(`Generated: ${notePath}`, 2500);
    new Notice("Next: Publish changes → select ZoomMap/publish/assets.md → Add linked → Publish.", 8000);
  }

  private async scanZoommaps(): Promise<Array<{ notePath: string; markersPath: string; assetPaths: string[] }>> {
    const files = this.app.vault.getMarkdownFiles();
    const out: Array<{ notePath: string; markersPath: string; assetPaths: string[] }> = [];

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
      const app = this.app;
      if (!app) return null;

      const plugins = (app as unknown as { plugins?: unknown }).plugins;
      if (!isRecord(plugins)) return null;

      const maybeZm = (plugins as { getPlugin?: (id: string) => unknown }).getPlugin?.("zoom-map");
      if (!isRecord(maybeZm)) return null;

      const saveLibraryToPath = maybeZm.saveLibraryToPath;
      if (typeof saveLibraryToPath !== "function") return null;

      const settings = maybeZm.settings;
      const libraryFilePath =
        isRecord(settings) && typeof settings.libraryFilePath === "string"
          ? settings.libraryFilePath
          : undefined;

      return {
        saveLibraryToPath: saveLibraryToPath as (path: string) => Promise<void>,
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

    new Setting(containerEl)
      .setName("Scan mode")
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

    new Setting(containerEl).setName("Usage").setHeading();
    new Setting(containerEl).setDesc(
      "Run: “TTRPG Tools: Maps: Prepare Publish (runtime + data notes + assets)”. Then in Publish changes: publish.js + publish.css + ZoomMap/publish/assets.md → Add linked → Publish.",
    );
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