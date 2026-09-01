# בטון · אפליקציית הימורי אירועים (מובייל)

אתר מובייל להימור על אירועי היום. אדמין מזין שאלות (אירועים) עם מספר תשובות שלכל אחת ערך;
כל מהמר נכנס עם משתמש/סיסמה ובוחר תשובה לכל שאלה. התוצאה הסופית = סכום הערכים של
התשובות הנכונות שנבחרו. יש טבלת דירוג.

שני ממשקים על אותו שרת:

- **אפליקציית המהמרים** – `/` – מובייל בלבד: הימורים + טבלת דירוג.
- **קונסולת ניהול** – `/admin.html` – למנהלים בלבד, נפרדת מהאפליקציה. שני טאבים:
  **אירועים** (יצירה/עריכה/הכרעה) ו-**משתמשים** (יצירה, איפוס סיסמה, הרשאת ניהול, מחיקה).

## הרצה מקומית

```bash
npm install
cp .env.example .env      # מלא DATABASE_URL של Neon ו-SESSION_SECRET
npm run db:init           # יוצר טבלאות + משתמשי דמו
npm start                 # http://127.0.0.1:8000
```

משתמשי דמו: `yossi/beton123` (מנהל), `dana/beton123`, `avi/beton123`.

## מודל הנתונים

- **users** – מהמרים. כניסה עם `username` + `password` (scrypt). `is_admin` לניהול.
- **questions** – אירוע ליום (`event_date`). `status`: `open` → `closed` → `resolved`.
  `correct_answer_id` נקבע בהכרעה.
- **answers** – תשובות ברמת השאלה, לכל אחת `value` מספרי.
- **bets** – בחירה אחת למשתמש לכל שאלה (upsert). ניתן לשנות כל עוד השאלה `open`.

ניקוד מהמר = `SUM(answers.value)` על שאלות `resolved` שבהן `bet.answer_id = correct_answer_id`.

## API

| Method | Path | תיאור |
|---|---|---|
| POST | `/api/auth/register` | הרשמה `{name, username, password}` |
| POST | `/api/auth/login` | כניסה `{username, password}` |
| POST | `/api/auth/logout` | יציאה |
| GET | `/api/auth/me` | המשתמש הנוכחי |
| GET | `/api/questions?date=YYYY-MM-DD` | שאלות היום + התשובה שלי |
| POST | `/api/bets` | `{question_id, answer_id}` (רק כששאלה `open`) |
| GET | `/api/leaderboard` | טבלת דירוג |
| GET/POST | `/api/admin/questions` | ניהול שאלות (מנהל) |
| PATCH/DELETE | `/api/admin/questions/:id` | סטטוס / תשובה נכונה / מחיקה |
| POST | `/api/admin/questions/:id/answers` | הוספת תשובה |
| PATCH/DELETE | `/api/admin/answers/:id` | עריכת ערך / מחיקה |
