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
npm run db:seed-demo        # 3 שאלות/יום, 10 ימים קדימה, פתוחות
npm run db:seed-demo-past   # 2 שאלות/יום, 10 ימים אחורה, מוכרעות + ~30 הימורי דמו למהמרים
```

## מודל הנתונים

- **users** – `is_admin=false` מהמרים, `is_admin=true` חשבונות ניהול (לא משתתפים בהימורים
  ולא בטבלת הדירוג). כניסה עם `username` + `password` (scrypt). `icon` – אימוג'י שנבחר
  בקונסולת הניהול ומוצג במסך הכניסה (ברירת מחדל: אייקון אקראי לפי id).
- **questions** – אירוע ליום (`event_date`). `status`: `open` → `closed` → `resolved`.
  `correct_answer_id` נקבע בהכרעה.
- **answers** – תשובות ברמת השאלה, לכל אחת `value` מספרי.
- **bets** – בחירה אחת למשתמש לכל שאלה (upsert). ניתן להמר **רק על אירועי היום** ורק
  כל עוד השאלה `open` (נחסם בשרת; ימים אחרים באפליקציה הם צפייה בלבד).

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
