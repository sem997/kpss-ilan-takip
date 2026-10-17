# KPSS İlan Takip

Bölümünüze uygun KPSS lisans kamu personel ilanlarını tek sayfada gösteren site.
Varsayılan bölüm Gıda Mühendisliği; ziyaretçi açılır listeden kendi bölümünü seçebilir (seçim tarayıcıda hatırlanır).

## Nasıl çalışır

- `scraper/guncelle.mjs`: ilan.gov.tr'deki "Kamu-Akademik Personel" ilanlarını ve ÖSYM'deki KPSS tercih kılavuzlarını toplar,
  her ilanın metninde hangi bölümlerin, KPSS puan türlerinin ve son başvuru tarihinin geçtiğini bulur, `data/` klasörüne yazar.
- `.github/workflows/guncelle.yml`: botu GitHub üzerinde her 30 dakikada bir çalıştırır, değişiklik varsa kaydeder.
- `index.html`: GitHub Pages'te yayınlanan sayfa; `data/*.json` dosyalarını okur, yeni ilanları en üstte "Yeni" etiketiyle gösterir.

## Bilgisayarda deneme

```
node scraper/guncelle.mjs
npx serve .        # ya da: python -m http.server
```

## Yeni bölüm eklemek

`data/bolumler.json` dosyasına bir satır ekleyin. `ara` alanındaki ifadeler, Türkçe harfleri sadeleştirilmiş küçük harfli
metinde aranır (ör. "Gıda Mühendisliği" → `gida muhendis`).

## GitHub'a kurulum

1. GitHub'da yeni, herkese açık bir depo açın ve bu klasörü yükleyin.
2. Settings → Pages → "Deploy from a branch" → `main` / `(root)`.
3. Actions sekmesinde "İlanları güncelle" iş akışını bir kez elle çalıştırın (Run workflow).
