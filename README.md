# BetOn · אפליקציית הימורי אירועים (מובייל)

אתר מובייל להימור על אירועי היום. אדמין מזין שאלות (אירועים) עם מספר תשובות שלכל אחת ערך;
כל מהמר נכנס עם משתמש/סיסמה ובוחר תשובה לכל שאלה. התוצאה הסופית = סכום הערכים של
התשובות הנכונות שנבחרו. יש טבלת דירוג.

שני ממשקים על אותו שרת:

- **אפליקציית המהמרים** – `/` – מובייל בלבד: הימורים + טבלת דירוג.
- **קונסולת ניהול** – `/admin.html` – למנהלים בלבד, נפרדת מהאפליקציה (מסך כניסה מלא מראש
  ב-yossi/beton123). שני טאבים: **אירועים** (יצירה/עריכה/הכרעה) ו-**משתמשים**, שבו
  ניהול **המנהלים** ו-**המהמרים** מופרד לשני חלקים; לכל משתמש: שם, סיסמה, אייקון,
  העברה בין התפקידים, מחיקה.

## הרצה מקומית

```bash
npm install
cp .env.example .env      # מלא DATABASE_URL של Neon ו-SESSION_SECRET
npm run db:init           # יוצר טבלאות + משתמשי דמו
npm start                 # http://127.0.0.1:8000
```

משתמשי דמו: `yossi/beton123` (מנהל), ו-`dana` / `avi` / `noa` / `tomer` / `shira` (מהמרים, כולם `beton123`).

נתוני דמו (אופציונלי):

```bash
npm run db:seed-demo        # אירוע אחד/יום, 14 ימים קדימה, פתוח
npm run db:seed-demo-past    # אירוע אחד/יום, 14 ימים אחורה, מוכרע + הימורי דמו למהמרים
npm run db:spread-events     # אכיפת אירוע אחד ליום (מזיז אירועים עודפים קדימה)
```

## פריסה ב-Vercel

`server.js` מייצא את אפליקציית Express; `api/index.js` הוא ה-serverless entry
ו-`vercel.json` מנתב `/api/*` אליו. הקבצים ב-`public/` מוגשים כ-static ע"י Vercel.

1. **Project Settings → Environment Variables** (Production + Preview):
   - `DATABASE_URL` – מחרוזת ה-connection של Neon (עם `-pooler`)
   - `SESSION_SECRET` – מחרוזת אקראית ארוכה
2. Redeploy.
3. הטבלאות והמשתמשים נוצרים פעם אחת מול Neon: `npm run db:init` מקומית עם אותו
   `DATABASE_URL` (ואופציונלית `npm run db:seed-demo*`).

## מודל הנתונים

- **users** – `is_admin=false` מהמרים, `is_admin=true` חשבונות ניהול (לא משתתפים בהימורים
  ולא בטבלת הדירוג). כניסה עם `username` + `password` (scrypt). `icon` – אימוג'י שנבחר
  בקונסולת הניהול ומוצג במסך הכניסה (ברירת מחדל: אייקון אקראי לפי id).
- **questions** – **אירוע אחד ליום** (`event_date`). `status`: `open` → `closed` → `resolved`.
  `correct_answer_id` נקבע בהכרעה. אם ליום יש יותר מאירוע אחד — למהמרים מוצג רק הראשון.
- **answers** – תשובות ברמת השאלה, לכל אחת `value` מספרי.
- **bet_messages** – הודעות מצחיקות; בכל הימור מוקפצת אחת אקראית למהמר (שם המהמר
  מתווסף אוטומטית, או משולב ב-`{name}`). טאב "💬 הודעות" בקונסולה.
- **daily_tips** – טיפים מעולם ההימורים; טיפ אקראי מוצג במסך ההימורים בכל טעינה
  (`GET /api/daily-tip`). טאב "💡 טיפים" בקונסולה.
- **bets** – **הימור אחד למשתמש ליום** (`UNIQUE(user_id, event_date)`). לחיצה על תשובה
  באירוע אחר של אותו יום מעבירה את ההימור. ניתן להמר **רק על אירועי היום** וכל עוד השאלה
  `open` (נחסם בשרת; ימים אחרים באפליקציה הם צפייה בלבד).

ניקוד מהמר = `SUM(answers.value)` על שאלות `resolved` שבהן `bet.answer_id = correct_answer_id`.

## API

| Method | Path | תיאור |
|---|---|---|
| POST | `/api/auth/login` | כניסה `{username, password}` (אין הרשמה עצמית — חשבונות נוצרים בקונסולה) |
| POST | `/api/auth/logout` | יציאה |
| GET | `/api/auth/me` | המשתמש הנוכחי |
| GET | `/api/questions?date=YYYY-MM-DD` | שאלות היום + התשובה שלי |
| POST | `/api/bets` | `{question_id, answer_id}` (רק אירוע של היום ו-`open`) |
| GET | `/api/users` | רשימת המהמרים + ניקוד (ציבורי, למסך הכניסה) |
| GET | `/api/leaderboard` | טבלת דירוג |
| GET/POST | `/api/admin/questions` | ניהול שאלות (מנהל) |
| PATCH/DELETE | `/api/admin/questions/:id` | סטטוס / תשובה נכונה / מחיקה |
| POST | `/api/admin/questions/:id/answers` | הוספת תשובה |
| PATCH/DELETE | `/api/admin/answers/:id` | עריכת ערך / מחיקה |
| GET/POST | `/api/admin/users` | רשימה / יצירת משתמש (`is_admin` לתפקיד) |
| PATCH/DELETE | `/api/admin/users/:id` | שם / סיסמה / `icon` / תפקיד / מחיקה |
| GET | `/api/daily-tip` | טיפ יומי אקראי |
| CRUD | `/api/admin/bet-messages`, `/api/admin/daily-tips` | ניהול מאגרי הטקסט |
