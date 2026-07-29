# Fix Kiro "Improperly formed request" (HTTP 400)

## Deskripsi Masalah
Saat menggunakan provider **Kiro (AWS CodeWhisperer)**, validator API Kiro sangat ketat terhadap skema _tools_ (Function Calling). Jika di dalam riwayat percakapan (`history`) terdapat referensi pemakaian _tool_ (seperti `tool_use` atau `tool_result`), Kiro **mewajibkan** agar _request_ tersebut juga melampirkan array `tools` (spesifikasi daftar tool).

Banyak klien IDE (seperti OpenCode atau Cursor) secara dinamis memangkas riwayat atau **tidak lagi mengirimkan array `tools`** pada turn berikutnya, namun blok `tool_result` masih tertinggal di dalam `messages`. Hal ini menyebabkan validator Kiro menolak _request_ dengan error:
`"Improperly formed request"` (HTTP 400).

## Solusi yang Diterapkan
Perbaikan dilakukan pada _translator_ Open-SSE di file:
`open-sse/translator/request/openai-to-kiro.js`

**Perubahan:**
Logika `flattenToolInteractions(messages)` dipindahkan ke awal pemrosesan `openaiToKiroRequest`. 
Jika klien tidak mengirimkan array `tools` (`!clientProvidedTools`), maka seluruh riwayat pesan akan langsung di-_flatten_ (dilebur). Semua blok terstruktur seperti `tool_use` dan `tool_result` dikonversi menjadi teks biasa (contoh: `[Tool result: ...]`).

Karena struktur data spesifik tool sudah hilang dan menjadi teks murni, validator Kiro tidak akan mencari array `tools` lagi, sehingga _request_ lolos validasi tanpa menghilangkan konteks riwayat AI.
