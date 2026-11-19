// Worker: tanya jawab regulasi HR berbasis teks UU 27/2026.
// - Potongan naskah (data/potongan.json) dan indeks topik (data/kb.json) dimuat saat build.
// - Pencarian mencari potongan paling relevan, lalu mengirimnya ke model sebagai konteks.
// - Model: Claude (jika ANTHROPIC_API_KEY diisi), atau endpoint OpenAI-compatible (jika LLM_BASE_URL diisi), atau Workers AI (default).
import POTONGAN from "../data/potongan.json";
import KB from "../data/kb.json";
import JAWABAN from "../data/jawaban.json";

const MAX_QUESTION = 500;
const MAX_HISTORY = 6;
const TOP_CHUNKS = 8;
const TOP_TOPICS = 2;
const STOP = new Set(["yang","dan","atau","untuk","dengan","apakah","bisa","boleh","saya","kami","dari","dalam","pada","akan","ada","tidak","jika","bagaimana","berapa","apa","ini","itu","sebagai","oleh","karena","kalau","harus","perlu","tentang","jadi","mereka","kita","nya"]);

const RULES = `Kamu asisten tanya jawab ketenagakerjaan Indonesia berdasarkan UU Nomor 27 Tahun 2026 tentang Pelindungan Ketenagakerjaan (diundangkan 28 Oktober 2026).

ATURAN WAJIB:
1. Dasarkan jawaban HANYA pada KONTEKS (potongan naskah UU dan indeks topik). Jangan menambah pasal, angka, contoh, atau daftar dari ingatanmu.
2. Setiap poin jawaban harus menyebut nomor pasal dari konteks, misalnya "Pasal 87 ayat 1". Jika potongan tidak punya nomor pasal, tulis "(nomor pasal perlu dicek di naskah resmi)".
3. Jika jawabannya tidak ada di konteks, katakan dengan jelas bahwa belum ditemukan di basis ini, lalu sarankan cek naskah resmi atau peraturan pelaksana. Jangan menebak.
4. Contoh jenis pekerjaan PKWT hanya boleh dari Pasal 87 ayat 1 (sekali selesai, sementara, musiman, produk baru, tidak tetap). Jangan mengarang contoh lain.
5. UU 13/2003 sudah dicabut. PP 35/2021 dan 36/2021 hanya berlaku sepanjang tidak bertentangan dengan UU 27/2026.
6. Jangan menyebut angka UMP/UMK tertentu; minta pengguna cek SK terbaru.
7. Untuk kasus, tanyakan maksimal 5 data penting yang kurang (status kontrak, masa kerja, lokasi, jumlah pekerja, riwayat peringatan, sudah bipartit atau belum).
8. Beri peringatan tegas untuk tindakan yang batal demi hukum atau pidana.
9. Bahasa Indonesia baku dan sederhana. Tanpa emoji. Jawaban harus selesai, tidak terpotong.
10. Akhiri dengan: informasi ini bersifat umum dan bukan nasihat hukum.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/tanya" && request.method === "POST") return handleTanya(request, env);
    if (url.pathname === "/api/health") return json({ ok: true, potongan: POTONGAN.length });
    return env.ASSETS.fetch(request);
  },
};

async function handleTanya(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Permintaan tidak valid." }, 400); }

  const question = String(body.question || "").trim().slice(0, MAX_QUESTION);
  if (!question) return json({ error: "Pertanyaan kosong." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:${ip}:${day}`;
  const used = parseInt((await env.KV.get(rlKey)) || "0", 10);
  const limit = parseInt(env.DAILY_LIMIT || "20", 10);
  if (used >= limit) return json({ error: "Batas pertanyaan harian tercapai. Coba lagi besok." }, 429);

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];

  // Jawaban terverifikasi untuk topik yang sering ditanyakan: dipakai dulu, tanpa model.
  // Hanya untuk pertanyaan baru (bukan lanjutan percakapan).
  if (history.length === 0) {
    const hit = curated(question);
    if (hit) {
      await env.KV.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 }).catch(() => {});
      return json({
        answer: hit.jawaban,
        sources: hit.pasal.map((p) => `Pasal ${p}`),
        topik: [],
        mode: "terverifikasi",
      });
    }
  }
  const modelName = env.ANTHROPIC_API_KEY ? env.ANTHROPIC_MODEL : (env.LLM_BASE_URL ? env.LLM_MODEL : env.LLM_MODEL);
  const cacheKey = history.length === 0 ? `ans:${modelName}:${await sha256(question)}` : null;
  if (cacheKey) {
    const cached = await env.KV.get(cacheKey, "json");
    if (cached) return json({ ...cached, cached: true });
  }

  const { chunks, topics } = retrieve(question);
  const context = buildContext(chunks, topics);
  const system = `${RULES}\n\nKONTEKS:\n${context}`;

  const msgs = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  msgs.push({ role: "user", content: question });

  let answer;
  try {
    answer = await callModel(env, system, msgs);
  } catch (err) {
    return json({ error: "Layanan AI sedang tidak tersedia. Coba lagi nanti." }, 502);
  }

  const sources = [
    ...new Set(chunks.map((c) => (c.pasal ? `Pasal ${c.pasal}` : "Potongan tanpa nomor pasal"))),
  ];
  const result = { answer, sources, topik: topics.map((t) => t.t) };

  await env.KV.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  if (cacheKey) await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 });
  return json(result);
}

const SINONIM = {
  pkwt: ["perjanjian kerja waktu tertentu"],
  pkwtt: ["perjanjian kerja waktu tidak tertentu"],
  kontrak: ["perjanjian kerja waktu tertentu"],
  "karyawan tetap": ["perjanjian kerja waktu tidak tertentu"],
  phk: ["pemutusan hubungan kerja"],
  "pemutusan": ["pemutusan hubungan kerja"],
  "diberhentikan": ["pemutusan hubungan kerja"],
  "dipecat": ["pemutusan hubungan kerja"],
  "outsourcing": ["alih daya"],
  "outsource": ["alih daya"],
  "vendor": ["alih daya"],
  "cuti": ["cuti"],
  "upah": ["upah"],
  "gaji": ["upah"],
  "mogok": ["mogok kerja"],
  "sakit": ["sakit"],
};

function expand(q) {
  let t = q.toLowerCase();
  const extra = [];
  for (const [k, vals] of Object.entries(SINONIM)) {
    if (t.includes(k)) extra.push(...vals);
  }
  return t + " " + extra.join(" ");
}


// Pencocokan jawaban terverifikasi: skor = jumlah panjang kata kunci yang ditemukan dalam pertanyaan.
function curated(question) {
  const q = question.toLowerCase();
  let best = null, bestScore = 0;
  for (const entry of JAWABAN) {
    let score = 0;
    for (const k of entry.kata) if (q.includes(k)) score += k.length;
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  return bestScore >= 6 ? best : null;
}

function tokens(q) {
  const x = expand(q).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(x)].slice(0, 16);
}

// Bobot kata: kata yang jarang muncul di naskah lebih penting (idf sederhana).
const DF = new Map();
const N_CHUNK = POTONGAN.length;
for (const c of POTONGAN) {
  const seen = new Set(c.teks.toLowerCase().split(/[^a-z0-9]+/));
  for (const w of seen) DF.set(w, (DF.get(w) || 0) + 1);
}
function idf(w) {
  const df = DF.get(w) || 0;
  return Math.log(1 + N_CHUNK / (df + 1));
}

function score(text, toks) {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of toks) {
    let i = t.indexOf(w), n = 0;
    while (i !== -1 && n < 5) { n++; i = t.indexOf(w, i + w.length); }
    if (n) s += n * idf(w);
  }
  return s;
}

function retrieve(question) {
  const toks = tokens(question);
  const explicit = [...question.matchAll(/pasal\s*(\d{1,3})/gi)].map((m) => m[1]);

  const chunks = POTONGAN.map((c) => {
    let s = score(c.teks, toks);
    if (c.pasal && explicit.includes(String(c.pasal))) s += 50;
    return { ...c, s };
  }).filter((c) => c.s > 0).sort((a, b) => b.s - a.s).slice(0, TOP_CHUNKS);

  const topics = KB.map((e) => ({ ...e, s: score(`${e.t} ${e.k} ${e.x}`, toks) }))
    .filter((e) => e.s > 0).sort((a, b) => b.s - a.s).slice(0, TOP_TOPICS);

  return { chunks, topics };
}

function buildContext(chunks, topics) {
  if (!chunks.length && !topics.length) return "Tidak ada potongan yang cocok dengan pertanyaan ini di basis.";
  const parts = [];
  chunks.forEach((c, i) => {
    const label = c.pasal ? `Pasal ${c.pasal}` : "nomor pasal tidak terbaca otomatis";
    parts.push(`[Potongan ${i + 1} | ${label}]\n${c.teks}`);
  });
  topics.forEach((t) => parts.push(`[Indeks topik: ${t.t}]\n${t.x}`));
  return parts.join("\n\n");
}

async function callModel(env, system, msgs) {
  if (env.ANTHROPIC_API_KEY) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: 1500, temperature: 0.1, system, messages: msgs }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) throw new Error("jawaban kosong");
    return text;
  }

  if (env.LLM_BASE_URL) {
    const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model: env.LLM_MODEL, messages: [{ role: "system", content: system }, ...msgs], temperature: 0.1, max_tokens: 1500 }),
    });
    if (!res.ok) throw new Error(`model ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("jawaban kosong");
    return text;
  }

  if (!env.AI) throw new Error("Belum ada model yang dikonfigurasi");
  const out = await env.AI.run(env.LLM_MODEL, { messages: [{ role: "system", content: system }, ...msgs], temperature: 0.1, max_tokens: 1500 });
  const text = out?.response;
  if (!text) throw new Error("jawaban kosong");
  return text;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
