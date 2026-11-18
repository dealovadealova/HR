-- Skema basis regulasi. Setiap baris = satu topik/pasal yang sudah diverifikasi.
CREATE TABLE IF NOT EXISTS regulasi (
  id INTEGER PRIMARY KEY,
  topik TEXT NOT NULL,
  kata_kunci TEXT NOT NULL,
  teks TEXT NOT NULL,
  sumber TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'berlaku',   -- berlaku | dicabut | diubah | dibatalkan_sebagian
  diperbarui TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_regulasi_topik ON regulasi (topik);
