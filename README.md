# pi-jev-eye

> **Ultra-lean, high-precision supervisor for Pi coding agent.**  
> Mengawasi aksi agent, mencegah perintah berbahaya, memblokir kebocoran secret, menuntut verifikasi nyata, dan memfilter kode slop dengan TypeSafe Jev.

Ukuran: **< 10 KB (1 file TypeScript)** · Ketergantungan: **0 npm dependencies**.

---

## 3 Lapisan Pengawasan

```
Aksi Agent (tool_call / message_end)
       │
       ▼
[Layer 1: Local Regex Gate]     ──► rm -rf / force-push / secret? ──► [BLOKIR INSTAN] (0 ms, 0 token)
       │ (Aman)
       ▼
[Layer 2: Done-Check Tracker]   ──► File berubah tapi klaim selesai tanpa test? ──► [PERINGATAN] (0 token)
       │ (Lolos)
       ▼
[Layer 3: Jev Semantic Gate]    ──► Diff kode baru ≥ 10 baris? ──► [CEK SLOP JEV] (P > 0.85 diblokir)
```

1. **Layer 1 — Regex Guard (0 ms, 0 Token):**
   * Mencegah perintah destruktif: `rm -rf /`, `git push --force (main|master)`, `git reset --hard`, `DROP DATABASE/TABLE`, `mkfs`.
   * Mencegah kebocoran API key (`sk-...`, `ghp_...`, private keys) baik di terminal bash maupun di dalam isi file yang hendak disimpan.
2. **Layer 2 — Done-Check Tracker (0 Token, Pure Code):**
   * Memantau apakah file diubah dalam giliran kerja.
   * Jika agent menyatakan "selesai / done" tanpa pernah menjalankan perintah verifikasi (`npm test`, `cargo test`, `pytest`, `lint`, `typecheck`), sistem memberikan notifikasi peringatan.
3. **Layer 3 — Jev Semantic Gate (Targeted & Hemat Kuota):**
   * Hanya aktif jika ada perubahan kode baru $\ge 10$ baris.
   * Menggunakan model **TypeSafe Jev** (`has_slop`) untuk mendeteksi stub pemalas, fungsi kosong, atau TODO yang belum tuntas.
   * Menggunakan API key dari `TYPESAFE_API_KEY` atau otomatis membaca `~/.pi/agent/pi-typesafe/auth.json`.

---

## Cara Pasang di Pi

### 1. Pasang dari path lokal:
```bash
pi install /run/media/bisma/DATA/Pi/pi-jev-eye
```

### 2. Atau uji coba tanpa install:
```bash
pi -e /run/media/bisma/DATA/Pi/pi-jev-eye/extensions/index.ts
```

---

## Perintah CLI

* `/eye` atau `/eye status` — Melihat status aktif layer, status kunci TypeSafe, dan statistik aksi yang telah dicegat.
* `/eye on` — Mengaktifkan pengawasan.
* `/eye off` — Menonaktifkan sementara pengawasan.

---

## Perbandingan dengan `pi-warden`

| Metrik | `pi-warden` | `pi-jev-eye` |
| :--- | :--- | :--- |
| **Ukuran Berkas** | ~900 KB (puluhan modul) | **< 10 KB (1 file)** |
| **Dependencies** | Banyak dependensi pihak ketiga | **0 external dependencies** |
| **Pencegahan Berbahaya** | AI + AST Parsing | **Regex instan (0 ms, 0 token)** |
| **Konsumsi Kuota Jev** | Boros (banyak evaluasi sepele) | **Sangat hemat** (hanya untuk diff $\ge 10$ baris) |
