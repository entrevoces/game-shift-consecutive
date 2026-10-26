// Night Shift — catch · stack · render (consecutive adventure)
// Verbs, not paragraphs: speech drifts past as orbs. Catch the load-bearing
// ones, stack them vertically (Rozan), then the voice leaves and you render
// from paper alone. Gile's two phases, as two screens your hands can feel.
import * as core from "./engine/engine-core/index.js";
import { EngineClient } from "./engine/engine-client/engine-client.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let engine, domain, concepts = [], targetLang = "es", learnerState = null;
let night = null; // { mode, turns, index, stamina, tokens, heartsEarned, faithful, total, noteScores[] }
let turn = null; // { data, caught:[], orbs:[], phase, transcriptConfidence, assisted }
let rafId = null, catchUntil = 0;

function params() { return new URLSearchParams(location.search); }
function hubHref() {
  const p = params();
  return `https://entrevoces.github.io/apps/hub/?domain=${encodeURIComponent(engine?.domainId || p.get("domain") || "oregon-medical")}&learner=${encodeURIComponent(engine?.learnerId || p.get("learner") || "")}&engine=${encodeURIComponent(engine?.engineUrl || p.get("engine") || "")}`;
}
function showScreen(id) {
  stopRiver();
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("is-active", s.id === id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function updateSyncBadge() {
  const st = engine.status();
  const b = $("#syncBadge");
  b.textContent = st.online ? `Synced · ${st.pending} pending` : `Local-only · ${st.pending} queued`;
  b.className = `pill ${st.online ? "pill-on" : "pill-local"}`;
  $("#hubLink").href = hubHref(); $("#endHubLink").href = hubHref();
}
function conceptById(id) { return concepts.find((c) => c.conceptId === id); }
function speak(text, lang) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "es" ? "es-ES" : lang === "zh" ? "zh-CN" : "en-US";
    u.rate = 0.92;
    speechSynthesis.speak(u);
  } catch { /* voice is garnish; text always works */ }
}
function floatNote(text, good = true) {
  const el = document.createElement("span");
  el.className = "float-note"; el.textContent = text;
  el.style.left = "42%"; el.style.top = "34%"; el.style.color = good ? "#e9c46a" : "#e76f51";
  $("#fxLayer").appendChild(el); setTimeout(() => el.remove(), 1050);
}

// ---------- boot ----------
async function boot() {
  const p = params();
  targetLang = p.get("lang") || localStorage.getItem("ev:targetLang") || "es";
  let fallbackConcepts = core.CONCEPTS;
  try { const r = await fetch("concepts-subset.json"); if (r.ok) fallbackConcepts = await r.json(); } catch { /* bundled fallback */ }
  const domainId = p.get("domain") || localStorage.getItem("ev:domainId") || "oregon-medical";
  engine = new EngineClient({
    engineUrl: p.get("engine") || localStorage.getItem("ev:engineUrl") || "http://127.0.0.1:8787",
    learnerId: p.get("learner") || "", domainId, core,
    fallbackDomain: core.SEED_DOMAINS.find((d) => d.domainId === domainId) || core.OREGON_MEDICAL,
    fallbackConcepts,
  });
  await engine.init();
  domain = await engine.getDomain(engine.domainId);
  concepts = await engine.listConcepts(engine.domainId);
  if (!concepts.length) concepts = fallbackConcepts.filter((c) => c.domainId === engine.domainId);
  try { learnerState = await engine.getState(engine.domainId, concepts); } catch { learnerState = null; }
  updateSyncBadge();
  const enc = core.ENCOUNTERS.find((e) => e.domainId === engine.domainId) || null;
  $("#titleContext").innerHTML = enc
    ? `<strong>${esc(domain?.label.en || engine.domainId)}</strong> · Story: ${esc(enc.title.en)} (${enc.turns.length} turns) · Waiting room mints people for your thinnest concepts. ${engine.online ? "Engine connected." : "Offline — the night still runs."}`
    : `<strong>${esc(domain?.label.en || engine.domainId)}</strong> · This world has no scripted story yet — the waiting room mints people for your thinnest concepts (nothing is borrowed from other worlds). ${engine.online ? "Engine connected." : "Offline — the night still runs."}`;
  if (!enc) { $("#storyBtn").disabled = true; $("#storyBtn").textContent = "No story in this world yet"; }
  renderQueuePreview(enc);
  $("#storyBtn").addEventListener("click", () => startNight("story"));
  $("#waitingBtn").addEventListener("click", () => startNight("waiting"));
  $("#againBtn").addEventListener("click", () => { showScreen("screen-title"); renderQueuePreview(enc); });
  $("#playBtn").addEventListener("click", playVoice);
  $("#repeatBtn").addEventListener("click", () => useToken("repeat"));
  $("#revealBtn").addEventListener("click", () => useToken("reveal"));
  $("#toRenderBtn").addEventListener("click", toRender);
  $("#submitBtn").addEventListener("click", submitRender);
  $("#nextBtn").addEventListener("click", nextTurn);
  $("#endShiftBtn").addEventListener("click", endNight);
  $("#disputeBtn").addEventListener("click", dispute);
  $("#riverCanvas").addEventListener("pointerdown", onRiverTap);
  $("#jotInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { addJot($("#jotInput").value); $("#jotInput").value = ""; } });
  buildSymbolRow();
  setupMic();
  setInterval(updateSyncBadge, 5000);
}

function renderQueuePreview(enc) {
  const people = core.generateNight({ domain, concepts, learnerState, seed: `preview-${engine.learnerId?.slice(0, 6)}-${Date.now().toString().slice(-4)}`, targetLang, size: 3 });
  $("#queuePreview").innerHTML = `<p class="hint" style="color:#5c7268;">Tonight's waiting room, minted for you${enc ? ` — plus the continuing story of ${esc(enc.title.en)}` : ""}:</p>` + people.map((pp) => `
    <div class="queue-card"><span class="face">${esc(pp.name.slice(0, 1))}</span><span><strong>${esc(pp.name)}</strong> · ${esc(pp.role)} · ${esc(pp.areaLabel)}<br><span class="hint">${esc(pp.quirk.label)} — ${esc(pp.stake)}. Needs: ${esc(pp.termEn)}.</span></span></div>`).join("");
}

function buildTurns(mode) {
  if (mode === "story") {
    const enc = core.ENCOUNTERS.find((e) => e.domainId === engine.domainId);
    if (!enc) return buildTurns("waiting"); // tenancy: never borrow another world's story
    const peopleById = Object.fromEntries(enc.people.map((pp) => [pp.id, pp]));
    return enc.turns.map((t) => {
      const toTarget = t.direction.startsWith("en");
      const sourceText = toTarget ? t.en : (t[targetLang] || t.es);
      const targetText = toTarget ? (t[targetLang] || t.es) : t.en;
      return {
        speakerName: peopleById[t.speaker]?.role || t.speaker, role: peopleById[t.speaker]?.role || "Speaker",
        sourceText, targetText, sourceLang: toTarget ? "en" : targetLang, targetLanguage: toTarget ? targetLang : "en",
        concept: conceptById(t.conceptId), areaId: t.areaId, effort: t.effort, noteHint: t.noteHint,
        storyLabel: `${enc.title.en} · Turn ${t.turn}`,
      };
    });
  }
  const people = core.generateNight({ domain, concepts, learnerState, seed: `night-${Date.now()}`, targetLang, size: 5 });
  return people.map((pp) => {
    const c = conceptById(pp.conceptId) || concepts[0];
    const ex = c.examples?.[0] || { en: c.definition.en, es: c.definition.es || c.definition.en, zh: c.definition.zh || c.definition.en };
    return {
      speakerName: pp.name, role: pp.role, sourceText: ex.en, targetText: ex[targetLang] || ex.es,
      sourceLang: "en", targetLanguage: targetLang,
      concept: c, areaId: pp.areaId, effort: pp.effort, noteHint: pp.quirk.effect,
      storyLabel: `${pp.name} — ${pp.stake}`,
    };
  });
}

function startNight(mode) {
  const turns = buildTurns(mode);
  night = { mode, turns, index: 0, stamina: 100, tokens: 3, faithful: 0, total: 0, noteScores: [], hearts: turns.map(() => null) };
  showScreen("screen-play");
  loadTurn();
}

function renderHud() {
  $("#hudNight").textContent = night.mode === "story" ? "Story night" : "Waiting-room night";
  $("#hudPerson").textContent = `${night.index + 1} / ${night.turns.length}`;
  $("#staminaFill").style.width = `${Math.max(0, night.stamina)}%`;
  $("#hudTokens").textContent = `Clarify tokens ${night.tokens}`;
  $("#heartsBox").textContent = night.hearts.map((h) => (h === null ? "○" : h ? "●" : "○")).join(" ");
  $("#queueStrip").innerHTML = night.turns.map((t, i) => `<span class="queue-chip ${i === night.index ? "now" : ""} ${night.hearts[i] ? "done" : ""}">${esc(t.speakerName)}<small>${esc(t.concept?.terms.en.term || "")}</small></span>`).join("");
  const e = turn?.data.effort || { listening: 1, memory: 1, production: 1 };
  $("#effL").style.width = `${e.listening * 20}%`; $("#effM").style.width = `${e.memory * 20}%`; $("#effP").style.width = `${e.production * 20}%`;
}

function loadTurn() {
  const data = night.turns[night.index];
  const concept = data.concept || concepts[0];
  turn = { data, concept, caught: [], orbs: [], phase: "catch", transcriptConfidence: 0.9, assisted: false, rendered: false };
  $("#speakerBadge").textContent = `${data.speakerName} · ${data.role}`;
  $("#phaseLabel").textContent = "Listen & catch";
  $("#sourceText").textContent = "Listen first — the words are hidden while you catch. Your notebook is what remains.";
  $("#sourceText").classList.add("masked");
  $("#riverHint").textContent = `Their stake: ${data.storyLabel}. ${data.noteHint || ""}`;
  $("#noteStack").innerHTML = `<span class="hint">Empty page. The river is coming.</span>`;
  $("#jotInput").value = ""; $("#answerInput").value = "";
  $("#feedback").textContent = ""; $("#heardBox").hidden = true;
  $("#renderZone").hidden = true; $("#toRenderBtn").disabled = false;
  $("#nextBtn").hidden = true; $("#disputeBtn").hidden = true;
  $("#playBtn").disabled = false;
  renderHud();
  buildOrbs(data);
}

// ---------- CATCH: the river ----------
function buildOrbs(data) {
  const keys = core.extractKeywords(data.sourceText, data.concept, targetLang);
  const distract = ["um…", "well…", "next week", "42", "maybe later", "the other one"].filter((d) => !keys.includes(d));
  const labels = [...keys.map((k) => ({ label: k, gold: true })), ...distract.slice(0, 4).map((k) => ({ label: k, gold: false }))];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  turn.orbs = labels.map((o, i) => ({
    ...o, caught: false,
    x: reduced ? 60 + (i % 4) * 150 : -40 - i * 110,
    y: 50 + ((i * 67) % 200),
    speed: reduced ? 0 : (0.55 + (data.effort.listening * 0.22)) * (0.8 + ((i * 37) % 40) / 100),
    wob: (i * 53) % 40,
  }));
  drawRiver(0);
}

function drawRiver(t) {
  const cv = $("#riverCanvas"), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  // river bands
  ctx.fillStyle = "#0d231e"; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = "#2c554c"; ctx.lineWidth = 1.5;
  for (let y = 52; y < cv.height; y += 52) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
  ctx.fillStyle = "#7fa79b"; ctx.font = "600 13px Public Sans, sans-serif";
  ctx.fillText(turn.phase === "catch" ? "THE RIVER — tap gold orbs to catch them into your notebook" : "The voice has left. Your paper remembers.", 14, 26);
  for (const o of turn.orbs) {
    if (o.caught) continue;
    const y = o.y + Math.sin(t / 600 + o.wob) * 7;
    ctx.beginPath();
    ctx.arc(o.x, y, 27, 0, Math.PI * 2);
    ctx.fillStyle = o.gold ? "#e9c46a" : "#33544c";
    ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#0c211c"; ctx.stroke();
    ctx.fillStyle = o.gold ? "#3d2f02" : "#b9cdc4";
    ctx.font = "700 12px Public Sans, sans-serif"; ctx.textAlign = "center";
    const label = o.label.length > 14 ? o.label.slice(0, 13) + "…" : o.label;
    ctx.fillText(label, o.x, y + 4);
    o._x = o.x; o._y = y;
  }
  ctx.textAlign = "left";
}

function riverLoop(t) {
  if (!turn || turn.phase !== "catch") return;
  for (const o of turn.orbs) o.x += o.speed;
  drawRiver(t);
  if (turn.orbs.some((o) => !o.caught && o.x < 760)) rafId = requestAnimationFrame(riverLoop);
  else drawRiver(t);
}
function stopRiver() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

function onRiverTap(e) {
  if (!turn || turn.phase !== "catch") return;
  const cv = $("#riverCanvas"), rect = cv.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * cv.width;
  const y = ((e.clientY - rect.top) / rect.height) * cv.height;
  const hit = [...turn.orbs].reverse().find((o) => !o.caught && Math.hypot((o._x ?? -99) - x, (o._y ?? -99) - y) < 34);
  if (!hit) return;
  hit.caught = true;
  if (hit.gold) {
    turn.caught.push(hit.label);
    addNoteChip(hit.label, "caught live");
    floatNote(hit.label, true);
  } else {
    floatNote("Not load-bearing", false);
    $("#feedback").textContent = "That one was river foam — filler, not freight. Save your hands for numbers, names, negations.";
    $("#feedback").className = "feedback bad";
  }
}

function buildSymbolRow() {
  $("#symbolRow").innerHTML = core.NOTE_SYMBOLS.map((s) => `<button type="button" class="symbol-btn" data-symbol="${esc(s.symbol)}" title="${esc(s.name)} — ${esc(s.rozan)}" aria-label="${esc(s.name)}">${esc(s.symbol)}</button>`).join("");
  document.querySelectorAll("[data-symbol]").forEach((b) => b.addEventListener("click", () => addNoteChip(b.dataset.symbol, b.title.split(" — ")[0])));
}
function addJot(text) { const t = text.trim(); if (t) addNoteChip(t, "jot"); }
function addNoteChip(text, kind) {
  const stack = $("#noteStack");
  if (stack.querySelector(".hint")) stack.innerHTML = "";
  const chip = document.createElement("span");
  chip.className = "note-chip";
  chip.innerHTML = `${esc(text)} <small>${esc(kind)}</small>`;
  stack.appendChild(chip);
  turn.caught.push(text);
}

// ---------- phases ----------
function playVoice() {
  if (!turn) return;
  $("#playBtn").disabled = true;
  speak(turn.data.sourceText, turn.data.sourceLang);
  stopRiver();
  rafId = requestAnimationFrame(riverLoop);
  setTimeout(() => { $("#playBtn").disabled = false; }, 1200);
}

function useToken(kind) {
  if (!turn || night.tokens <= 0) { $("#feedback").textContent = "No tokens left. Professionals ration clarification — so does tonight."; return; }
  if (kind === "repeat" && turn.phase !== "catch") return;
  night.tokens -= 1; turn.assisted = true;
  if (kind === "repeat") { speak(turn.data.sourceText, turn.data.sourceLang); stopRiver(); rafId = requestAnimationFrame(riverLoop); }
  if (kind === "reveal") { $("#sourceText").textContent = turn.data.sourceText; $("#sourceText").classList.remove("masked"); $("#feedback").textContent = "Peeked. The token is spent and the engine notes the help — honestly, like a real clarification."; }
  renderHud();
}

function toRender() {
  if (!turn) return;
  turn.phase = "render";
  stopRiver(); drawRiver(0);
  $("#phaseLabel").textContent = "Render — from notes alone";
  $("#sourceText").classList.add("masked");
  $("#renderZone").hidden = false;
  $("#toRenderBtn").disabled = true;
  $("#answerInput").focus();
  $("#feedback").textContent = "Source gone. Trust the stack you built — that trust is the skill.";
  $("#feedback").className = "feedback";
}

function setupMic() {
  const btn = $("#recordBtn");
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) { btn.disabled = true; btn.textContent = "Speak (typed tonight — no mic API)"; return; }
  let rec = null;
  const start = (e) => {
    e.preventDefault();
    try {
      rec = new Rec();
      rec.lang = turn?.data.targetLanguage === "en" ? "en-US" : turn?.data.targetLanguage === "zh" ? "zh-CN" : "es-ES";
      rec.interimResults = false;
      rec.onresult = (ev) => {
        const r = ev.results[0][0];
        $("#answerInput").value = r.transcript;
        turn.transcriptConfidence = r.confidence ?? 0.75;
        if (turn.transcriptConfidence < 0.65) $("#disputeBtn").hidden = false;
      };
      rec.start(); btn.textContent = "Listening… release to stop"; btn.setAttribute("aria-pressed", "true");
    } catch { /* typed path remains */ }
  };
  const stop = () => { try { rec?.stop(); } catch { /* noop */ } btn.textContent = "Hold to speak"; btn.setAttribute("aria-pressed", "false"); };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
}

function dispute() {
  if (!turn) return;
  $("#feedback").textContent = "Disputed and logged. Retype what you actually said — the engine learns from the dispute, it does not punish it.";
  turn.transcriptConfidence = 0.95; turn.assisted = true;
  $("#disputeBtn").hidden = true;
  engine.recordEvidence({
    conceptId: turn.concept.conceptId, areaId: turn.data.areaId, gameId: "shift-consecutive",
    activityType: "repair", stage: 6, languageDirection: `${turn.data.sourceLang}->${turn.data.targetLanguage}`,
    correct: true, score: 0.6, assistance: ["transcript-dispute"], confidence: 0.7,
    responseSummary: "Learner disputed low-confidence transcript",
  });
}

function submitRender() {
  if (!turn || turn.rendered) return;
  const answer = $("#answerInput").value.trim();
  if (!answer) { $("#feedback").textContent = "Render something first — even imperfect. Silence also gets interpreted, as absence."; return; }
  const jot = $("#jotInput").value.trim();
  if (jot) addJot(jot);
  turn.rendered = true;
  const assess = core.assessInterpretation({
    sourceText: turn.data.sourceText, learnerText: answer, concept: turn.concept,
    transcriptConfidence: turn.transcriptConfidence, targetLang: turn.data.targetLanguage === "en" ? "en" : targetLang,
  });
  const notes = core.scoreNotes({
    sourceText: turn.data.sourceText, notesText: turn.caught.join(" "), pinnedKeywords: turn.caught,
    concept: turn.concept, targetLang,
  });
  night.total += 1;
  night.noteScores.push(notes.score);
  const faithful = assess.correct;
  if (faithful) night.faithful += 1;
  night.hearts[night.index] = faithful;
  const effortCost = (turn.data.effort.listening + turn.data.effort.memory + turn.data.effort.production) * 2;
  night.stamina = Math.max(0, night.stamina - effortCost + (faithful ? 4 : 0));
  const fb = $("#feedback");
  fb.className = `feedback ${faithful ? "good" : "bad"}`;
  fb.textContent = faithful
    ? (assess.verdict === "faithful" ? "Carried clean across." : "Across — different words, same meaning. That counts.")
    : assess.explanation;
  const heard = $("#heardBox");
  heard.hidden = false;
  heard.innerHTML = `<strong>What they heard:</strong> “${esc(answer)}”<br><span class="hint">Preserved: ${esc(assess.preserved.join(", ") || "core gist")} · Missed: ${esc(assess.omitted.join(", ") || "nothing load-bearing")} · Notes craft ${(notes.score * 100).toFixed(0)}% — ${esc(notes.feedback[0] || "")}</span>`;
  floatNote(faithful ? "Understood" : "It wobbled", faithful);
  engine.recordEvidence({
    conceptId: turn.concept.conceptId, areaId: turn.data.areaId, gameId: "shift-consecutive",
    activityType: "interpretation", stage: 8, languageDirection: `${turn.data.sourceLang}->${turn.data.targetLanguage}`,
    correct: assess.correct, score: assess.score, confidence: Math.max(0.3, 1 - assess.uncertainty),
    assistance: [...(turn.assisted ? ["clarification-token"] : [])],
    fidelity: assess.verdict, responseSummary: answer.slice(0, 200),
  });
  engine.recordEvidence({
    conceptId: turn.concept.conceptId, areaId: turn.data.areaId, gameId: "shift-consecutive",
    activityType: "note-craft", stage: 6, languageDirection: `${turn.data.sourceLang}->${turn.data.targetLanguage}`,
    correct: notes.score >= 0.5, score: notes.score, confidence: 0.8,
    responseSummary: `Notes captured ${notes.captured.length}/${notes.captured.length + notes.missed.length} load-bearing items`,
  });
  updateSyncBadge();
  renderHud();
  $("#nextBtn").hidden = false; $("#nextBtn").focus();
  if (turn.transcriptConfidence < 0.65) $("#disputeBtn").hidden = false;
}

function nextTurn() {
  night.index += 1;
  if (night.index >= night.turns.length || night.stamina <= 5) { endNight(); return; }
  loadTurn();
}

async function endNight() {
  stopRiver();
  await engine.sync().catch(() => {});
  try { learnerState = await engine.getState(engine.domainId, concepts); } catch { /* keep */ }
  const next = await engine.getNext(engine.domainId).catch(() => null);
  const avgNotes = night.noteScores.length ? Math.round((night.noteScores.reduce((a, b) => a + b, 0) / night.noteScores.length) * 100) : 0;
  const rank = night.faithful >= 4 ? "Voice — rooms ask for you by name" : night.faithful >= 3 ? "Bridge — trusted with real turns" : night.faithful >= 1 ? "Listener — the river is teaching you" : "First night — everyone starts wet";
  $("#endTitle").textContent = night.stamina <= 5 ? "You are spent. The notebook closes itself." : "The waiting room is quiet.";
  $("#endStats").innerHTML = `<p style="font-size:19px;">Carried faithfully <strong>${night.faithful}/${night.total || 0}</strong> · Note craft <strong>${avgNotes}%</strong> · Stamina left <strong>${Math.round(night.stamina)}%</strong></p><p><strong>Reputation tonight:</strong> ${esc(rank)}.</p>`;
  $("#endExplain").innerHTML = `<strong>Engine next:</strong> ${esc(next?.rationale || "More nights sharpen the map.")}<br><span class="hint">Tomorrow: due concepts return as people, and the story advances whether you feel ready or not. That is why you will be ready.</span>`;
  showScreen("screen-end");
}

boot().catch((e) => {
  $("#titleContext").textContent = `The night failed to load (${e.message}). Reload — the waiting room refills itself.`;
  $("#storyBtn").disabled = true; $("#waitingBtn").disabled = true;
});
