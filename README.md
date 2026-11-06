# CAMI KIR! – TikTok Live oyunu

## Kurulum
1. Node.js 20.6+ kur.
2. Klasörde: `npm install`
3. `.env.example` dosyasını `.env` olarak kopyala, şifreyi ve TikTok kullanıcı adını yaz.
4. `npm start`
5. Yayın ekranı: http://localhost:3000/overlay  (TikTok LIVE Studio / OBS "Tarayıcı kaynağı" olarak ekle; arka plan şeffaf. Önizleme için `?bg=1`)
6. Yönetici: http://localhost:3000/admin  (şifre = ADMIN_PASSWORD). Bu adresi yayın kaynağına ekleme.

## Notlar
- Puanlar ve cam durumu `data.json` dosyasına yazılır; yeniden başlatmada korunur.
- Hediye puanları admin panelinden `isim=puan` olarak girilir. İsimler TikTok'un gönderdiği hediye adıdır (genelde İngilizce: rose, heart...). Listede olmayan hediye = elmas × çarpan.
- Seri (streak) hediyeler: sadece yeni eklenen adet puanlanır, seri bitişi çift puan vermez. Her mesaj `msgId` ile tekilleştirilir.
- Bağlantı koparsa 2sn'den başlayıp 30sn'ye kadar artan aralıkla otomatik yeniden bağlanır.
- Sunucuyu internete açacaksan HTTPS (ters vekil) arkasına koy; /admin Basic Auth kullanır.
