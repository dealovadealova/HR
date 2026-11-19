// Worker: API tanya jawab regulasi HR.
// - Mengambil pasal relevan dari D1 (pencarian kata kunci sederhana).
// - Memanggil model lewat endpoint OpenAI-compatible; kunci API disimpan sebagai secret.
// - Membatasi pemakaian per IP per hari dan menyimpan jawaban di KV agar hemat.

const RULES = `Kamu asisten tanya jawab ketenagakerjaan Indonesia berdasarkan UU Nomor 27 Tahun 2026 tentang Pelindungan Ketenagakerjaan.
Aturan:
1. Jawab hanya dengan dasar KONTEKS. Jika tidak ada di konteks, katakan belum ada di basis ini dan sarankan cek naskah resmi.
2. Sebut nomor pasal dan status berlaku setiap jawaban.
3. UU 13/2003 sudah dicabut. PP 35/2021 dan 36/2021 hanya berlaku sepanjang tidak bertentangan dengan UU 27/2026.
4. Jangan menyebut angka UMP/UMK tertentu; minta pengguna cek SK terbaru.
5. Untuk kasus, tanyakan data penting yang kurang (paling banyak 5 hal).
6. Bahasa Indonesia baku dan sederhana. Tanpa emoji.
7. Beri peringatan tegas untuk tindakan yang batal demi hukum atau pidana.
9. Contoh jenis pekerjaan PKWT hanya boleh dari lima kategori Pasal 87 ayat 1: sekali selesai, sementara, musiman, produk baru, atau tidak tetap. Jangan mengarang daftar contoh lain. Jika pengguna minta contoh tambahan, beri label jelas: ilustrasi, bukan ketentuan UU.
10. Jawaban harus selesai dan tidak terpotong. Jika perlu, ringkas.
8. Akhiri dengan: informasi ini bersifat umum dan bukan nasihat hukum.`;

const MAX_QUESTION = 500;
const MAX_HISTORY = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/tanya" && request.method === "POST") {
      return handleTanya(request, env);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleTanya(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Permintaan tidak valid." }, 400);
  }

  const question = String(body.question || "").trim().slice(0, MAX_QUESTION);
  if (!question) return json({ error: "Pertanyaan kosong." }, 400);

  // Batas pemakaian per IP per hari.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:${ip}:${day}`;
  const used = parseInt((await env.KV.get(rlKey)) || "0", 10);
  const limit = parseInt(env.DAILY_LIMIT || "20", 10);
  if (used >= limit) {
    return json({ error: "Batas pertanyaan harian tercapai. Coba lagi besok." }, 429);
  }

  // Jawaban yang sama disimpan 24 jam (hanya jika tanpa riwayat percakapan).
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
  const cacheKey = history.length === 0 ? `ans:${await sha256(question)}` : null;
  if (cacheKey) {
    const cached = await env.KV.get(cacheKey);
    if (cached) return json({ answer: cached, cached: true });
  }

  const rows = await searchRegulasi(env.DB, question);
  const context = rows.length
    ? rows.map((r, i) => `[${i + 1}] ${r.topik} (status: ${r.status}, sumber: ${r.sumber}): ${r.teks}`).join("\n")
    : "Tidak ada topik yang cocok di basis ini.";

  const messages = [
    { role: "system", content: `${RULES}\n\nKONTEKS:\n${context}` },
    ...history.filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_QUESTION) })),
    { role: "user", content: question },
  ];

  let answer;
  try {
    answer = await callModel(env, messages);
  } catch (err) {
    return json({ error: "Layanan AI sedang tidak tersedia. Coba lagi nanti." }, 502);
  }

  await env.KV.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  if (cacheKey) await env.KV.put(cacheKey, answer, { expirationTtl: 60 * 60 * 24 });

  return json({ answer, sources: rows.map((r) => ({ topik: r.topik, status: r.status, sumber: r.sumber })) });
}

// Pencarian sederhana: cocokkan kata (>2 huruf) dengan topik, kata kunci, dan teks.
async function searchRegulasi(db, question) {
  const words = [...new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))].slice(0, 8);
  if (words.length === 0) return [];
  const clauses = words.map(() => "(lower(topik) LIKE ? OR lower(kata_kunci) LIKE ? OR lower(teks) LIKE ?)").join(" OR ");
  const binds = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]);
  const { results } = await db
    .prepare(`SELECT topik, teks, sumber, status FROM regulasi WHERE ${clauses} LIMIT 4`)
    .bind(...binds)
    .all();
  return results || [];
}

// Default: Workers AI (binding AI, tanpa kunci API).
// Jika LLM_BASE_URL diisi, memanggil endpoint OpenAI-compatible dengan secret LLM_API_KEY.
async function callModel(env, messages) {
  if (!env.LLM_BASE_URL) {
    if (!env.AI) throw new Error("Workers AI belum dikonfigurasi");
    const out = await env.AI.run(env.LLM_MODEL, { messages, temperature: 0.2, max_tokens: 1500 });
    const text = out?.response;
    if (!text) throw new Error("jawaban kosong");
    return text;
  }
  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({ model: env.LLM_MODEL, messages, temperature: 0.2, max_tokens: 1500 }),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("jawaban kosong");
  return text;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
