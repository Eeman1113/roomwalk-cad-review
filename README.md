# RoomWalk CAD check

A review tool for one job: look at each generated CAD drawing beside the brochure
floor plan it came from, decide whether it is usable, and write down what is
missing. Open the page, work through the cases, export the CSV.

**Live page:** https://eeman1113.github.io/roomwalk-cad-review/

## What is being reviewed

Every drawing here was produced by the **classical, offline reader** — the code
that actually ships (`reader/lib/reader/` plus `reader/lib/planCore.js` in the
RoomWalk monorepo). **No trained model is involved.** There is no PlanNet
checkpoint on disk; the two toy checkpoints that exist put 10% of room-label
anchors on a room pixel against this reader's 97.6%, so the reader is what
generates the CAD and the reader is what the checker is judging.

40 cases: the flats annotated against the architect's own printed room names and
sizes, which is the only ground truth the brochure offers. The brochure holds 162
flats; extending the set is a configuration change in `generate.mjs`, not new
work.

35 of the 40 produced a drawing. **5 did not, and are shown as failed cases with
the reason** rather than omitted — a plan the reader cannot read at all is
exactly what a checker needs to see. All 5 are from the pale, outline-walled
pages (Lily, Tulip, Rose).

## Using it

| Key | |
|---|---|
| `←` `→` / `J` `K` | previous / next case |
| `U` | jump to the next case not yet reviewed |
| `1` `2` `3` | verdict: good / minor issues / unusable |
| `S` `O` `F` | side by side / overlay / flip |
| `Space` | in flip view, swap plan and CAD |
| `L` | lock or unlock the two panes' zoom and pan |
| `+` `−` `0` `9` | zoom in / out / fit / actual pixels |
| scroll, drag | zoom at the pointer, pan |
| `/` | jump to the notes box |
| `?` | the full list, plus what these drawings are |

The two panes are **locked together** by default, so a wall in one pane sits at
the same screen position as the same wall in the other. In overlay the drawing is
registered on the plan by the reader's own fitted scale.

Every keystroke is written to `localStorage` immediately — a refresh or a closed
tab loses nothing. It is per-browser, so export the CSV before switching machine.
**Import CSV** merges a previously exported file back in by `case_id`, which is
how two people's work gets combined or a lost session recovered.

## Files

| | |
|---|---|
| `index.html`, `styles.css`, `app.js` | the tool; no build step, no dependencies |
| `cases.json` | one record per case: metadata, printed ground truth, what the CAD carries, the generator's own confidence notes |
| `plans/*.png` | the brochure plans, original 400 dpi PNGs, unmodified |
| `cad/*.svg` | the generated drawings, vector, so they stay sharp at any zoom |
| `generate.mjs` | the script that produced `cases.json` and `cad/`, run against the RoomWalk monorepo |

## Regenerating

From a checkout of the RoomWalk monorepo with `reader/node_modules` installed and
the brochure images on disk, with the paths at the top of the script pointing at
them:

```bash
node generate.mjs ./out
```

It reads each plan, runs the reader, OCRs the labels, finds openings, converts to
CAD and writes the SVG. Nothing in this repo needs Node to be *reviewed* — only
to be rebuilt.

## A note on the images

`plans/` is a real builder's brochure. It is published here deliberately, so the
review can be shared, and it is kept under one folder so it can be removed in one
step if that decision changes.
