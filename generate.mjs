import fs from "fs";
import path from "path";
const R = "/Users/eemanmajumder/code_shit/slam/reader";
const IMG = "/Users/eemanmajumder/code_shit/plan-to-cad/data";
const OUT = process.argv[2];

const { load } = await import(R + "/eval/img.js");
const { read } = await import(R + "/lib/reader/index.js");
const { readText } = await import(R + "/lib/reader/text.js");
const { findOpenings } = await import(R + "/lib/reader/openings.js");
const { compose } = await import(R + "/lib/ui/compose.js");
const PlanCore = (await import(R + "/lib/planCore.js")).default;

const OCR = { langPath: R + "/public/tessdata", gzip: false };
const sample = JSON.parse(fs.readFileSync(R + "/eval/sample40.json", "utf8"));
const acc = JSON.parse(fs.readFileSync(R + "/eval/accuracy.json", "utf8")).per_flat;

fs.mkdirSync(OUT + "/plans", { recursive: true });
fs.mkdirSync(OUT + "/cad", { recursive: true });

const cases = [];
for (const f of sample) {
  const id = path.basename(f.file, ".png");
  const t0 = Date.now();
  let rec = { id, file: f.file, block: f.block, floor: f.floor, flat: f.flat, split: f.split,
              faded: f.faded, W: f.W, H: f.H, ok: false, error: null };
  // ground truth
  const tp = R + "/data/truth/" + id + ".json";
  if (fs.existsSync(tp)) {
    const t = JSON.parse(fs.readFileSync(tp, "utf8"));
    rec.truth = { rooms: t.rooms.map(r => ({ name: r.name, size: r.size })),
                  doors: t.doors, windows: t.windows, ventilators: t.ventilators };
  }
  const op = R + "/data/truth_openings/" + id + ".json";
  rec.hasOpeningTruth = fs.existsSync(op);
  rec.measured = acc[f.file] || null;

  try {
    const img = await load(IMG + "/" + f.file);
    fs.copyFileSync(IMG + "/" + f.file, OUT + "/plans/" + id + ".png");
    const r = read(img);
    if (!r || !r.ok) throw new Error("reader could not read this plan (" + ((r && r.reason) || "unknown") + ")");
    let text = null, open = null, missing = {};
    try { text = await readText(img, r, OCR); } catch (e) { missing.text = "failed: " + e.message; }
    try { open = await findOpenings(img, r, {}); } catch (e) { missing.openings = "failed: " + e.message; }
    const { desc, stats } = compose(r, { text, openings: open, missing });
    const out = PlanCore.convert(desc, img.W, img.H, { mm: true, I: 125 / 25.4, E: 250 / 25.4, templates: null, image: img });
    fs.writeFileSync(OUT + "/cad/" + id + ".svg", out.svg);
    rec.ok = true;
    rec.ms = Date.now() - t0;
    rec.spaces = out.model.rooms ? out.model.rooms.length : null;
    rec.quality = out.model.quality ? { level: out.model.quality.level,
      checks: out.model.quality.checks.map(c => ({ level: c.level, text: c.text })) } : null;
    // model inches -> image pixels: layout() divides pixel coords by this scale,
    // so multiplying back registers the drawing on the plan exactly.
    const rs = [];
    for (const sp of out.norm.spaces) {
      if (sp.w) rs.push((sp.px[2] - sp.px[0]) / sp.w);
      if (sp.d) rs.push((sp.px[3] - sp.px[1]) / sp.d);
    }
    rs.sort((a, b) => a - b);
    const sc = (out.L.snap && out.L.snap.scale) || rs[rs.length >> 1];
    const vb = out.svg.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
    rec.overlay = { sc, viewBox: vb };
    rec.cad = {
      rooms: (out.norm.spaces || []).map(s => ({ name: s.name || null, label: s.label || null, w: s.w || null, d: s.d || null, kind: s.kind })),
      placed: out.model.placed || [],
      notes: out.model.notes || [],
      pxPerIn: stats.pxPerIn, scaleSpreadPct: stats.scaleSpreadPct,
      missing,
    };
  } catch (e) {
    rec.error = String(e.message || e);
    rec.stage = /could not read this plan/.test(String(e.message || e)) ? "read" : "cad";
    rec.ms = Date.now() - t0;
    // still make sure the plan image is there so the checker sees the case
    try { fs.copyFileSync(IMG + "/" + f.file, OUT + "/plans/" + id + ".png"); } catch {}
  }
  cases.push(rec);
  process.stdout.write(rec.ok ? "." : "X");
}
fs.writeFileSync(OUT + "/cases.json", JSON.stringify({
  generated: new Date().toISOString(),
  reader: "classical offline reader (lib/reader + lib/planCore), no AI, no trained model",
  units: "millimetres; internal wall 125 mm, external 250 mm",
  total_in_brochure: 162,
  cases,
}, null, 1));
console.log("\n" + cases.filter(c => c.ok).length + " ok, " + cases.filter(c => !c.ok).length + " failed");
