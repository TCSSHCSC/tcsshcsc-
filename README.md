# TCSSHCSC 社團點名系統

Cloudflare Workers + D1 的社團座位點名系統。學員必須以 `@stu.tcssh.tc.edu.tw` 學生帳號使用 Google Identity Services 登入。後端驗證 Google 簽章、audience、issuer、有效期限、nonce、已驗證電子郵件與 Google Workspace 的 `hd` 學校網域，驗證完成才建立登入 session。沒有額外的識別密碼。

## 正式網站

- 學員 A 班：https://tcsshcsc-attendance.yichengc869.workers.dev/a
- 學員 B 班：https://tcsshcsc-attendance.yichengc869.workers.dev/b
- 管理員 A 班：https://tcsshcsc-attendance.yichengc869.workers.dev/admin/a
- 管理員 B 班：https://tcsshcsc-attendance.yichengc869.workers.dev/admin/b

## 功能

- A、B 教室各 48 席，每排 8 席，共 6 排，左至右、前至後編號 01–48。
- 紅燈未報到、綠燈已報到、灰燈停用。登入 Google 後點選座位，填寫班級與班級座號。
- 每場每個 Google 帳號只能占一席，A/B 兩間共用限制；同班級座號不能重複。班級名稱須由學員一致填寫，尚未串接學籍名冊。
- 管理員帳號 `tcsshcsc`；密碼僅以加鹽 PBKDF2 雜湊存在 Cloudflare secret，公開倉庫不含真實密碼或雜湊。
- 管理員可停用/恢復空位，查看報到名單、匯出 CSV、同時為兩班開始新場次。歷史紀錄與停用座位保留。
- 畫面每 7 秒更新；隱藏分頁暫停輪詢。公開 API 不傳回學員姓名、帳號或班級座號。
- Session 使用 HttpOnly/SameSite Cookie，正式站使用 Secure，8 小時到期。每 IP 每 15 分鐘最多 20 次登入嘗試。
- SQLite constraints 與 triggers 原子檢查座位、帳號及班級座號衝突，並拒絕舊場次報到。

## 開發

需要 Node.js 24（測試使用 Node SQLite）與 npm。

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run password
# 將產生的 ADMIN_PASSWORD_HASH 設定在 .dev.vars
npm run db:local
npm run dev
```

本機 Google 登入須在 Google OAuth 用戶端「已授權的 JavaScript 來源」另外加入本機來源，例如 `http://localhost:8787`。正式網址已加入來源。Google Client ID 是公開設定，不是 secret。本系統使用 ID token 登入，不需要 Google client secret。

## 部署到 Cloudflare

```sh
npx wrangler login
# 新帳號請建立自己的 D1，將回傳 ID 寫入 wrangler.jsonc
npx wrangler d1 create tcsshcsc-attendance --location apac
npm run db:remote
npx wrangler secret put ADMIN_PASSWORD_HASH
npm run deploy
```

既有正式資料庫不需重建。`wrangler.jsonc` 內的 D1 ID 為本專案已建立的資料庫。若複製到其他帳號，請替換 ID，Google OAuth 也需加入新的網站來源。不要在 GitHub Pages 直接部署：後端與 D1 binding 必須在 Workers 執行。

每天 UTC 19:00（台灣 03:00）清除過期 session 與登入限制計數。此排程不刪除點名歷史。可由管理員使用 Cloudflare D1 控制台處理學員的更正或刪除請求。

## Google OAuth

Google Cloud 專案：`tcsshcsc-attendance`。OAuth 用戶端：`TCSSHCSC Attendance Web`。

來源：`https://tcsshcsc-attendance.yichengc869.workers.dev`。

後端只接收經驗證的 Google ID token，不接受前端提供的 user ID 或 email。Google Auth Platform 必須允許正式學員使用；使用者身分可能依 Google 設定、帳號政策及 OAuth 傳播時間受到限制。

## 測試

```sh
npm test
npm run build
npx wrangler deploy --dry-run
npx wrangler types
```

測試覆蓋：96 席/公開資料最小化、未登入與偽造 token 拒絕、跨來源請求拒絕、雙人搶位、跨教室重複報到、停用座位、歷史保留、舊場次防護、session 登入登出與到期、登入速率限制。測試在獨立記憶體 SQLite 執行，不修改正式 D1。Google 真實登入與 Workers 執行環境另需瀏覽器驗證。

## 結構

`web/` 為繁體中文響應式介面，`server/worker.mjs` 為 Workers 後端，`server/security.mjs` 為驗證工具，`migrations/` 為 D1 schema，`tests/` 為整合測試。`dist/` 由 build 產生，不包含 secrets。

`.dev.vars`、`secrets.json`、`.env*` 與 `.wrangler/` 均忽略，請勿將登入 cookie、Google token 或密碼放入 issue、前端或 GitHub Actions log。
