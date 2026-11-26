# دليل إعداد القارئ الصوتي (Chirp 3: HD) والمناقشة (Gemini المجاني) — بضمان 0$ شهريًا

يضيف هذا المشروع وضعين متكاملين داخل القارئ مع إمكانية التبديل الفوري بينهما:
1. **وضع القراءة الصوتية (`Chirp 3: HD`)**: عبر Google Cloud Text-to-Speech بأصوات عربية طبيعية (`ar-XA`).
2. **وضع المناقشة (`Gemini API — الباقة المجانية`)**: عبر Google AI Studio لمناقشة الصفحة الحالية أو المقطع المحدد.

---

## 1. كيف نضمن 0.00$ شهريًا بشكل قاطع؟

تم تطبيق **طبقتين من الحماية**:

### أ) حماية داخل التطبيق (و/أو الوسيط السحابي)
- **سقف شهري صارم لـ Chirp 3 HD**: `900,000` حرف/شهر (بهامش أمان 10% أقل من الحد المجاني البالغ مليون حرف شهريًا).
- **سقف يومي لتوزيع الرصيد**: `30,000` حرف/يوم حتى لا يُستنزف رصيد الشهر في جلسة واحدة.
- **سقف يومي لـ Gemini المجاني**: `20` طلب/يوم + فاصل زمني 6 ثوانٍ بين الطلبات لحماية حد الدقيقة (RPM).
- **التحويل التلقائي لصوت المتصفح المجاني (`Web Speech API`)** عند بلوغ السقف الآمن، فلا يتوقف القارئ ولا تُحسب أي تكلفة.

### ب) حماية على مستوى Google Cloud Console (مهمة جدًا لـ Chirp 3 HD)
لضمان أن Google Cloud نفسها **لن تصدر فاتورة أبدًا** حتى لو فُتح القارئ من عدة أجهزة:
1. افتح مشروعك `gog-reader-20261012` في [Google Cloud Console](https://console.cloud.google.com/).
2. فعّل **Cloud Text-to-Speech API**.
3. من **APIs & Services → Enabled APIs → Cloud Text-to-Speech API → Quotas & System Limits**:
   - عدّل حصة `Characters per day` (أو `Chirp 3 HD characters per day`) إلى **`30,000`**.
   - بهذا يصبح الحد الأقصى الممكن في 30 يومًا هو `900,000` حرف (أقل من المليون المجاني = **\$0.00 رياضيًا**).
4. من **Credentials → Create Credentials → API Key**:
   - قيّد المفتاح على **Cloud Text-to-Speech API** فقط.
   - إذا كنت ستستخدمه مباشرة في المتصفح، قيّده بـ **HTTP Referrer** لنطاق موقعك فقط (مثل `https://estrdaad.github.io/*`).

### ج) مفتاح Gemini المجاني (بدون بطاقة بنكية)
1. افتح [Google AI Studio](https://aistudio.google.com/apikey).
2. أنشئ مفتاح API على **الباقة المجانية (Free Tier)** دون ربط أي حساب فوترة.
3. النماذج المدعومة في القارئ: `gemini-3.8-flash` و`gemini-flash-lite-latest`.

---

## 2. طريقتا التشغيل

### الطريقة السريعة (مباشرة من المتصفح — دون نشر خادم)
1. افتح القارئ واضغط قائمة الأدوات ← **🎧 استماع (Chirp 3)** أو **💬 ناقش (Gemini)**.
2. انتقل إلى تبويب **⚙️ الإعدادات**.
3. الصق مفتاح Google Cloud TTS ومفتاح Gemini المجاني واضغط **حفظ الإعدادات**.
   - تُحفظ المفاتيح محليًا في `localStorage` على جهازك فقط ولا تُرفع إلى GitHub.

### الطريقة الاحترافية (عبر Cloudflare Worker المنشور في `voice-bridge/`)
تم نشر الوسيط السحابي وربطه تلقائيًا بالقارئ مع مساحة تخزين **Cloudflare KV دائمة** (`goog-voice-quota` / `QUOTA_KV`) لتثبيت حدود الصفر تكلفة عبر جميع الأجهزة:
- الرابط الحي: `https://goog-voice-bridge.estrdaad-reader.workers.dev`
- حالة الرصيد والمفاتيح: `https://goog-voice-bridge.estrdaad-reader.workers.dev/status`

لإضافة مفاتيحك كـ **Secrets** مشفرة على Cloudflare (تُنفّذ مرة واحدة فقط):

```sh
./chatgpt-bridge/node_modules/.bin/wrangler secret put GOOGLE_TTS_API_KEY --config voice-bridge/wrangler.jsonc
./chatgpt-bridge/node_modules/.bin/wrangler secret put GEMINI_API_KEY --config voice-bridge/wrangler.jsonc
```

ولإعادة النشر بعد أي تعديل على `voice-bridge/worker.mjs`:

```sh
./chatgpt-bridge/node_modules/.bin/wrangler deploy --config voice-bridge/wrangler.jsonc
```

---

## 3. ممارسات خفض الاستهلاك المدمجة تلقائيًا

- **ذاكرة صوتية دائمة (`IndexedDB`)**: كل مقطع يُقرأ يُحفظ محليًا بمفتاح فريد؛ إعادة الاستماع لنفس الصفحة تستهلك **0 حرف**.
- **تنظيف النص العربي قبل الإرسال**: إزالة التطويل (`ـ`)، وأرقام الحواشي، والفواصل الزخرفية، والمسافات الزائدة (يوفّر نحو 8%–15% من الأحرف).
- **تجميع ذكي للفقرات القصيرة**: دمج الفقرات القصيرة ضمن مقاطع متوازنة (420–650 حرفًا) مع جلب مسبق لمقطع واحد فقط أثناء التشغيل، وإلغاء الطلب فورًا عند الإيقاف أو قلب الصفحة.
- **مناقشة موفّرة للتوكنات في Gemini**: إرسال مقتطف الصفحة الحالية فقط (بحد أقصى 1400 حرف) + آخر 4 رسائل فقط + ردود مركزة (`maxOutputTokens: 320`) + كاش للأسئلة المتكررة.
