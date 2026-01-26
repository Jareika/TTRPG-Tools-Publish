# TTRPG Tools: Publish (Obsidian Plugin)

**TTRPG Tools: Publish** is a helper plugin for people who publish their vault as a website (Obsidian Publish).
It prepares **TTRPG Tools: Maps (Zoom Map)** content so your interactive maps can be displayed on your Publish site.

This plugin is intentionally **separate** from TTRPG Tools: Maps:
- users who don’t use Publish don’t need the extra runtime and workflow,
- it keeps the Maps plugin smaller,
- it creates room for future Publish support for other tools (e.g. **TTRPG Tools: Timeline**).

## What it does

When you run **“Maps: prepare publish (runtime + data notes + assets)”**, the plugin:

1) **Installs/updates Publish runtime**
- Writes/updates a generated **Zoom Map runtime block** into:
  - `publish.js`
  - `publish.css`
- It does *not* delete your existing content in those files; it only replaces the section between the markers:
  - `BEGIN TTRPGTOOLS_ZOOMMAP_PUBLISH` … `END TTRPGTOOLS_ZOOMMAP_PUBLISH`

2) **Generates Publish data notes**
- Converts JSON data used by the Maps plugin into **publishable Markdown notes**:
  - `ZoomMap/publish/library.md` (icons + collections + travel rules packs)
  - `ZoomMap/publish/markers/m-<hash>.md` (one per markers.json)

3) **Generates an assets manifest note**
- Creates `ZoomMap/publish/assets.md` which links to:
  - all data notes,
  - all maps and asset files referenced by your published maps (bases, overlays, frames, stickers, baked SVGs, icon files, …).

## Requirements

- Obsidian Publish
- **Custom domain enabled** (required by Obsidian Publish to use `publish.js`)
- TTRPG Tools: Maps (Zoom Map) installed and used in your vault

### Storage requirement (important)

Publish support currently requires **JSON marker storage** (the default):
- marker data must be available as `<image>.markers.json`

If you use `storage: note` (inline marker storage), this plugin cannot export those maps yet.

## Installation

Manual install (Obsidian community plugin):
- Copy the compiled plugin folder into:
  - `<vault>/.obsidian/plugins/ttrpg-tools-publish/`
- Reload Obsidian
- Enable the plugin in **Settings → Community plugins**

## Setup (recommended)

### 1) Use the default Zoom Map library path

In **TTRPG Tools: Maps** settings, set **Library file path** to wherever you store your icon/collection library, e.g.:
- `ZoomMap/library.json` (recommended default)
- or a custom path (also supported)

**Important:** TTRPG Tools: Publish will read the library JSON from the **TTRPG Tools: Mapa setting** (library file path).
If the file is missing, it will try to call Zoom Map to export it automatically.

### 2) Mark notes as publishable (optional, recommended)

If you don’t want the plugin to scan your entire vault:
- add frontmatter to your published notes:

```yaml
---
publish: true
---
```

Then keep **Scan mode** = *Only publish: true notes* in this plugin’s settings.

## Usage / Workflow

### One command (recommended)

Run:
- **“Maps: prepare publish (runtime + data notes + assets)”**

Then in Obsidian Publish:
1) Open **Publish changes**
2) Select:
   - `publish.js`
   - `publish.css`
   - `ZoomMap/publish/assets.md`
3) Click **Add linked**
4) Click **Publish**

`assets.md` is the “one-click selector” that pulls in all required files.

### Individual commands

You can also run these separately:
- **Maps: Install/Update publish.js + publish.css**
- **Maps: generate publish data notes (library + markers)**
- **Maps: generate publish assets manifest note**

## What works on Publish

The Publish runtime renders maps as **read-only interactive maps**:
- pan / zoom
- marker rendering (including layers visibility)
- base images + overlays + viewport frame
- drawings and pattern overlays (baked SVGs)
- swap pins (right click cycles the frame)
- ruler / measurement (local, read-only)

Editing markers on Publish is not supported.

## Files generated / modified

- **Root of your vault** (Publish runtime):
  - `publish.js`
  - `publish.css`

- **Publish data folder** (default):
  - `ZoomMap/publish/library.md`
  - `ZoomMap/publish/markers/m-<hash>.md`
  - `ZoomMap/publish/assets.md`

## Notes

- The plugin avoids rewriting generated marker/library notes if the underlying JSON didn’t change,
  so Obsidian Publish won’t constantly recommend re-uploading unchanged files.
- The library JSON source path is taken from **TTRPG Tools: Maps → Settings → Library file path** (not hard-coded).

## Roadmap

This plugin is intended as a shared “Publish bridge” for TTRPG Tools.
Future versions may add Publish support for other tools (e.g. **TTRPG Tools: Timeline**).

## License
MIT