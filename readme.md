# TTRPG Tools: Publish (Obsidian Plugin)

**TTRPG Tools: Publish** is a helper plugin for people who publish their vault as a website (Obsidian Publish).
It prepares content from:
- **TTRPG Tools: Maps (Zoom Map)** so your interactive maps can be displayed on your Publish site.
- **TTRPG Tools: Timeline (Simple Timeline)** so timeline code blocks can be rendered on your Publish site.

This plugin is intentionally **separate** from TTRPG Tools: Maps/Timeline:
- users who don’t use Publish don’t need the extra runtime and workflow,
- it keeps the Maps and Timeline plugins smaller,
- it creates room for Publish support for other tools without bloating the main plugins.

## What it does

When you run one of the **Prepare** commands, the plugin:

1) **Installs/updates Publish runtime**
- Writes/updates a generated **Publish runtime block** into:
  - `publish.js`
  - `publish.css`
- It does *not* delete your existing content in those files; it only replaces the section between the markers:
  - `BEGIN TTRPGTOOLS_ZOOMMAP_PUBLISH` … `END TTRPGTOOLS_ZOOMMAP_PUBLISH`

2) **Generates Publish data notes (maps / timeline)**
- Converts internal data into **publishable Markdown notes**:
  - `ZoomMap/publish/library.md` (icons + collections + travel rules packs)
  - `ZoomMap/publish/markers/m-<hash>.md` (one per markers.json)
  - `Timeline/publish/timelines/t-<hash>.md` (one per timeline name; contains a JSON payload used by the Publish runtime)

3) **Generates assets manifest notes**
- Creates:
  - `ZoomMap/publish/assets.md`
  - `Timeline/publish/assets.md`

These notes link to:
  - all data notes,
  - all maps and asset files referenced by your published maps (bases, overlays, frames, stickers, baked SVGs, icon files, …).
  - all notes and internal images referenced by published timeline entries.

## Requirements

- Obsidian Publish
- **Custom domain enabled** (required by Obsidian Publish to use `publish.js`)
- TTRPG Tools: Maps (Zoom Map) installed and used in your vault (optional)
- TTRPG Tools: Timeline (Simple Timeline) installed and used in your vault (optional)

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

**Important:** TTRPG Tools: Publish will read the library JSON from the **TTRPG Tools: Maps setting** (library file path).
If the file is missing, it will try to call the plugin to export it automatically.

### 2) Mark notes as publishable (optional, recommended)

If you don’t want the plugin to scan your entire vault:
- add frontmatter to your published notes:

```yaml
---
publish: true
---
```

Then keep **Scan mode** = *Only publish: true notes* in this plugin’s settings.

### 3) Timeline notes: required frontmatter

For timeline entries, the plugin scans notes that contain:
- a start date (default key: fc-date)
- a timeline list (default key: timelines)

Example:

```yaml
---
publish: true
fc-date: 1165-03-01
fc-end: 1165-03-03
timelines: [Travelbook 1]
tl-title: Arrival in New York
tl-image: assets/my-image.png
tl-summary: |-
  Leave two empty spaces before you start the summary.
---
```

Notes:
- fc-end, tl-summary, tl-image are optional.
- tl-image can be an external URL or an internal vault file link/path.
- Month names on Publish can be taken from the TTRPG Tools: Timeline (optional setting) or overridden in this plugin’s settings.

## Commands

Maps:
- “Maps: prepare publish (runtime + data notes + assets)”

Timeline:
- “Timeline: prepare publish (runtime + data notes + assets)”

Both:
- “Prepare publish (maps + timeline)”

### Maps: one command (recommended)

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

### Timeline: one command (recommended)

Run:
- “Timeline: prepare publish (runtime + data notes + assets)”

Then in Obsidian Publish:
1) Open Publish changes
2) Select:
   - publish.js
   - publish.css
   - Timeline/publish/assets.md
3) Click Add linked
4) Click Publish

### Individual commands

You can also run these separately:
- Maps: Install/Update publish.js + publish.css
- Maps: generate publish data notes (library + markers)
- Maps: generate publish assets manifest note +- Timeline
- Timeline: generate publish data notes
- Timeline: generate publish assets manifest note

## What works on Publish

### Maps

The Publish runtime renders maps as read-only interactive maps:
- pan / zoom
- marker rendering (including layers visibility)
- base images + overlays + viewport frame
- drawings and pattern overlays (baked SVGs)
- swap pins (right click cycles the frame)
- ruler / measurement (local, read-only)
- text layers

Editing markers on Publish is not supported.

### Timeline

The Publish runtime renders timelines from pre-generated timeline data notes.

Supported code blocks on Publish:
- ```timeline-cal (vertical “cross” cards)
- ```timeline-h (horizontal timeline)

Important:
- On Publish, timelines are not rendered by scanning your vault.

## Files generated / modified

- **Root of your vault** (Publish runtime):
  - `publish.js`
  - `publish.css`

- **Publish data folder** (default):
  - `ZoomMap/publish/library.md`
  - `ZoomMap/publish/markers/m-<hash>.md`
  - `ZoomMap/publish/assets.md`
  - `Timeline data folder (default):`
  - `Timeline/publish/timelines/t-<hash>.md`
  - `Timeline/publish/assets.md`
  
## Settings you might care about

### Website

- Hover popover max width
Controls the maximum width of Publish hover popovers (Page Preview) via generated CSS/runtime.
- Hide folders in publish navigation
Lets you hide specific folders in the Publish navigation tree (purely visual; notes stay published and hover previews still work).

## Notes

- The plugin avoids rewriting generated marker/library notes if the underlying JSON didn’t change,
  so Obsidian Publish won’t constantly recommend re-uploading unchanged files.
- The library JSON source path is taken from **TTRPG Tools: Maps → Settings → Library file path** (not hard-coded).

## Roadmap

This plugin is intended as a shared “Publish bridge” for TTRPG Tools.
Future versions may add more tools and more design options for Publish-rendered content.

## License
MIT