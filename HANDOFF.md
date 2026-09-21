# 交接：work-board v5

寫於 2026-09-17（接續 v4 那份，舊內容已消掉的部分見下）。**這份是暫時的**，事情做完就可以刪掉。
背景與設計決策在同資料夾的 `README.md`，以及 memory 的 `work-board-tool.md`。

---

## 0. 現在的狀態（重要，先讀）

- ✅ **v5 已經上線了**：8420 有人在聽，`data.json` 已經是 `v: 5`、10 筆單、
  10 筆都有 `spans`，`GET /api/tasks` 回 200。轉檔前的自動備份是
  `backup/data-before-v5-2026-09-17.json`。
- ⚠️ **中間卡了一次，原因是 `啟動看板.bat` 的行尾**（詳見 §4 最後一條）——
  那支 bat 是 LF 行尾，`cmd.exe` 吃不動，雙擊之後 node 不會真的起來、視窗一閃就沒了。
  已經把它改成 CRLF（只動行尾，其他位元組沒動），原檔留在 scratchpad 的
  `啟動看板-原檔-LF.bat`。
- ✅ **v5.1 也上線了**（只動 `public/app.js`）：起排預設值改成看「今天有沒有發生過事」。
  ⚠️ **不用重開服務** —— `serveStatic` 每次請求都從磁碟讀、而且回 `Cache-Control: no-cache`，
  瀏覽器重整就吃得到新的。
- ✅ **v5.2 也上線了、而且服務已經重開過**（`server.js` 有動，這次非重開不可）。
  2026-09-17 實測 `GET /api/day-starts?date=2026-09-17` 回 200，裡面已經有 `boshue`
  與 `DingWun` 兩筆（都是 `by: boshue`）—— 表示「自己調」跟「管理者幫別人調」兩條路
  在正式機上都走得通。
  ⚠️ **重開會把所有人登出**（`sessions` 是記憶體裡的 `Map`），這是預期行為，不是壞掉。
- ✅ **v5.3（P1/P2/P3）已經生效** —— 8420 在 2026-09-17 15:33 重開過，
  而那批改動 14:45 就寫完了（重開比改動晚 ⇒ 跑的是新版）。
- ✅ **v5.4 已經重開過了**（2026-09-18 使用者回報「這三件我都做完了」）⇒ 8420 的後端是 v5.4。
  P6 與 P5 的前端那半只動 `public/app.js`，重整瀏覽器就吃到。改了什麼見 §1 的「✅ v5.4」。
  ⭐ 重開前已經拿**真 `data.json` 的副本**配新版 server 在 8441 預演過（結果見下面那條）。
- ✅ **v5.5 與 v5.6 都已經上線了**（2026-09-18 14:54 重開過，比 `server.js` 的 14:35 晚
  ⇒ 跑的是 v5.6）。`GET /api/catch-up` 在 8420 回 401（不是 404）＝ 路由在。
  v5.5 是兩種不看訂閱範圍的通知，v5.6 是早上的補帳跳窗，改了什麼見 §1。
- ✅ **v5.6 的說明頁也上線了**（只動 `public/`）：右上角 ❓ 說明，內容寫死在
  `index.html` 的 `#help-modal`。⚠️ 改公告要換 `app.js` 的 `HELP_VERSION`，否則紅點不亮。
- ⚠️ 判斷「跑的是不是新版」的方法：`Get-Process -Id <pid> | Select StartTime`
  跟 `server.js` 的 mtime 比。⛔ 不要看 `server-out.log` —— 那是 `.bat` 開機時
  重導的，手動 `node server.js` 起的不會寫進去，看起來會像停在好幾天前。
- ⚠️⚠️ 用 Bash 的 `node -e "…"` 改這份文件時**一定要用單引號或讀檔**，
  雙引號裡的反引號會被 bash 當成命令展開 —— 2026-09-17 就這樣把這一段的
  程式碼標記整段吃掉，還順手在背景跑了一次 `node server.js`（撞到 8420 沒起來）。
- **隔離測試實例都已經關掉**（8428 / 8430 / 8433 / 8434 / 8436–8439 / 8441），現在只有 8420 在聽。
  ⚠️ PID 每次重開都會變，⛔ 不要照抄這份文件裡的數字，自己用
  `netstat -ano | grep 8420` 查。

### 要再重開的話（⚠️ 要先關掉那個 console 視窗）

雙擊資料夾裡的 `啟動看板.bat`，或自己下：

```bash
cd /d/H5/_ai-tools/work-board && node server.js
```

⚠️ **`啟動看板.bat` 一定要維持 CRLF 行尾**（見 §4）。要確認的話：

```bash
cd /d/H5/_ai-tools/work-board && cat -A 啟動看板.bat | head -1
```

每一行結尾要看到 CRLF 的 `^M` 標記；沒有 `^M` 就是被轉成 LF 了，雙擊會起不來。

轉檔已經跑過了，之後重開不會再印 `[migrate]`（`data.json` 已經是 v5）。

### 回退點

- **程式碼**：⛔ 這個資料夾**不是 git repo**，沒有版本控制。
  v5 那次改的四個檔（`server.js` / `public/app.js` / `public/index.html` / `public/style.css`）
  **沒有留副本** —— 要回退只能靠下面那份「這次改了什麼」自己反著改回去。
  ⚠️ **v5.3（P1/P2/P3）的改動同樣沒有「改之前」的副本** —— 要退只能照 §1 最後一段反著改。
  ⭐ 但**改之後**那版有留：`server-v5.3.js` / `app-v5.3.js` / `data-2026-09-17-p123.json`
  在 v5.3 的 scratchpad（見 §3），下一次要改東西時那份就是回退點。
  ⭐ **起排這條線留了三份**：scratchpad 的 `app-before-bugA.js` 是 v5.0（完全沒改過）、
  `app-before-xfix.js` 是「修完 Bug A 但還沒補 X-1/X-2/X-3」、
  `app-before-perperson.js` 是「v5.1 完成、還沒改成每人一份」那一版；
  後端則是 `server-before-daystarts.js`。
  ⚠️ 回退到 `app-before-perperson.js` 的話 `server.js` 不用退（多兩支沒人叫的 API 而已）；
  ⛔ 反過來只退 `server.js` 不退 `app.js` 會讓看板存不起來起排。
  蓋回去就回到對應的狀態（⚠️ 蓋回 v5.0 之後記得叫使用者清掉瀏覽器的
  `localStorage.wb_daystart`，舊程式看不懂新的 `auto` 欄位倒是無所謂，但值會留著）。
- **資料**：
  - `backup/data-before-v4-2026-09-17.json`（v4 轉檔前）
  - `backup/data-before-v5-2026-09-17.json`（v5 轉檔前，**已經產生了**）
  - `C:\Users\BOSHUE~1\AppData\Local\Temp\claude\D--H5--ai-tools-work-board\721c1cca-2f48-4fb3-9b7a-1dcbad6fe8ea\scratchpad\`
    裡有 `data-before-v5-manual.json` + `auth-before-v5-manual.json`（改程式前，手動存的）
    以及 `data-before-restart.json` + `auth-before-restart.json`（重開前一刻，手動存的）
  - `啟動看板-原檔-LF.bat` 也在同一個 scratchpad（就是壞掉那版）
- ⚠️ 要回退資料的話**兩個檔都要蓋回去**，而且要**先關服務**。

---

## 1. 這次做完的事

### ✅ 問題 1：希望完成的時間不再卡半小時

`public/index.html:61` 與 `public/app.js:1152` 的 `step="1800"` 拿掉了（HTML 預設 `step=60`）。
後端 `normTime()` 本來就只驗 `HH:MM` 的形狀、`app.js` 的 `wishLate()` 用字串比 —— 都不用動，
已經各自確認過。

### ✅ 問題 2：估時／剩餘時數可以填到分鐘（走 B 案）

內部**仍然存小時數**，但輸入與顯示都改了：

- 新增 `parseHours()` / `fmtHours()`，**前後端各一份、逐字相同**（v5test 的 A1 在盯這件事）。
  收 `1.5`、`1h30m`、`1h30`、`90m`、`90分`、`1:30`、`:45`、`2小時`。
- 顯示一律 `1h20m`，⛔ 不要改回印小數。
- 卡片上的估時輸入框從 `<input type="number" step="0.5">` 換成 `type="text"`，送原字串給後端解析。
- 改狀態時那個 prompt 的**建議值不再 `Math.max(0.5, …)`**，也不再 round 到 0.5。
- 後端打錯字回 **400** 並附可用寫法，⛔ 不會默默存成 0。

### ✅ 問題 3：改成已排程後那段時間不再被別人佔走（加了 `task.spans`）

- **資料格式升到 v5**：每張單多一個 `spans: [ { from, to, min } ]`。
  離開「進行中」但沒完成時補一筆；**按完成不寫這裡**（那條路走 `doneAt`，兩邊都記會畫兩次）。
  沒有 `startedAt` 的單不留（表上少一段，比畫一段編出來的區間好）。
- 前端 `doneEntries()` → **`pastEntries()`**：把「今天做完的」與「今天被插件的」
  合成一條**照結束時間排序**的清單，一起佔住時間軸。畫成灰色 `⏸`（CSS `.slot.cut`）。
- 被插件的單會**同時出現兩段**（前面灰色的已做、後面剩下的估時）—— 這是對的，⛔ 不要去重。

### ✅ v5.1 Bug A：做完的單不會再從時間表上消失

**災情**：2026-09-17 服務掛了一早上，使用者 11:20 才第一次打開看板。起排被凍在 `11:20`，
而 `pastEntries()` 有一條規則是「起排**之前**結束的不畫」（那條規則本身是對的：那段時間
不在這張表的範圍裡）。結果 11:18 做完的單只差兩分鐘就被整個丟掉，9:00–11:20 全成了「未排」。
⚠️ **資料一筆都沒掉**，純粹是畫不出來。

**改法**（只動 `public/app.js`，使用者選的是「看今天有沒有做過事」）：

- 新增 `earliestPastMin( all )`：今天已經發生過的事最早結束在幾點（`done` 走 `doneAt`、
  被插件的走 `spans[].to`），今天什麼都沒發生就回 `null`。
  ⚠️ **它的判斷條件必須跟 `pastEntries()` 一模一樣** —— 兩邊對不起來的話，會出現
  「起排往前拉了，但那件事還是沒被畫出來」。
- 新增 `initialStartMin( all )`：有發生過事 → `BLOCKS[0].start`（上班時間）；沒有 → `defaultStartMin()`（現在）。
- 新增 `dataLoaded` 旗標與 `initStartOnce()`，在 `renderToday()` 裡、`getStartMin()` **之前**呼叫。
  ⚠️ ⛔ 起排的定案**不可以搬回 init 那段** —— 那時單還沒抓回來，「今天什麼都沒發生」跟
  「還不知道」長得一模一樣，會定在「現在」，正好就是這個 bug 本身。
- `localStorage.wb_daystart` 多存一個 `auto` 欄位：
  - `auto: false`（人自己調的）⇒ 當天絕對不動。
  - `auto: true` 或**沒有這個欄位**（v5.0 存的舊格式）⇒ **只准往前拉，⛔ 不准往後推**。
  ⭐ 「沒有 `auto` 就當成自動」這條是為了**救今天**：使用者的瀏覽器早上已經把 `11:20`
  存進去了，不這樣寫的話新程式會尊重那個存檔，今天照樣是壞的。

#### v5.2：起排改成「每人每天一份、存伺服器」

使用者的話：「有些同事可能會請假或遲到，所以起排時間要每個人都有一份表」。
兩個裁決：**存伺服器、大家看到同一份**；**只有本人跟管理者能調**。

- 後端：`data.dayStarts`（`日期 → 人員 → { min, auto, by, at }`）、
  `GET /api/day-starts?date=`（回整張表，不用登入）、`POST /api/day-start`。
  ⛔ **沒有寫 v6 轉檔** —— 跟 `data.days` 一樣，舊檔第一次跑就補成 `{}`。
  刪人員時他那幾筆要一起清掉（同名 id 建回來會撿到前一個人的起排）。
- 前端：`localStorage.wb_daystart` **整套拿掉**，換成 `dayStarts` 這張表；
  `initStartOnce()` → `applyStartForView()`。
  ⭐ 「當天只決定一次」現在是靠**伺服器上有沒有那一筆**保證的，不是靠瀏覽器存檔。
- ⚠️ **`public/` 是現讀檔、`server.js` 要重開才會換**，所以「新網頁 + 舊服務」一定
  會並存一段時間。那段時間 `/api/day-starts` 是 404 ——
  ⛔ 不擋住的話 `Promise.all` 會連單一起丟掉，整個看板打不開。
  所以那一支（**只有那一支**）准失敗：退回當場算、跳一次「起排暫時存不起來」，
  並且立 `startsApiMissing` 旗標不再送寫入（⛔ 不然每 20 秒洗一次錯誤訊息）。

#### ⚠️ v5.1 第一版還漏了三條，review 抓到、已經補上（都實際重現過才改）

1. **只有看自己的看板時才准動那一格**（`if ( !canScheduleView() ) return;`）。
   `initStartOnce()` 用 `scopeTasks()` 取單，但 `#day-start` 跟 `wb_daystart` 是
   **全域、不分人**的。點進別人的看板時是拿「他的」單在算 —— 他今天做完的事會把
   我的起排拉到 9:00，再加上「只准往前拉」，我當天就再也調不回來。
   ⭐ 用的是寫快照那條路同一個判準，理由也同一個（「別人開著我的頁面」）。
2. **`earliestPastMin()` 要照抄 `pastEntries()` 的第二關**（工作分鐘 > 0）。
   上班時間之前做完的事 `pastEntries` 本來就會丟掉；少了這一關就會把起排拉到 9:00，
   但那件事依然畫不出來，整個早上被還沒做的單填滿 —— 正是這次災情的鏡像版。
   ⛔ 這兩個函式的判斷條件**每一關都要對齊**，不是只有第一關。
3. **「只准往前拉」不能無條件**。原本寫 `if ( want >= getStartMin() ) return;`，
   等於每次重畫都拿「上班時間」去比 —— 12:00 打開、12:20 按完成，起排就跳回 9:00，
   剛做完那張單被記成做了 3 小時（估時 1 小時）。
   改成只有「**已經發生過的事正被起排擋在外面**」才拉：
   `earliest === null || earliest >= getStartMin()` 就 return。
   ⭐ 今天的災情仍然救得到（9:10 < 11:20 → 擋在外面 → 拉回 9:00），日常路徑不再亂跳。

### ✅ v5.3：三個特殊情況的修正（P1／P2／P3，2026-09-17）

⚠️ **`server.js` 有動 ⇒ 非重開不可**（會把所有人登出）。P3 只動前端，重整就好。
⭐ 這三個都是**先實際重現、再改**，不是讀程式碼猜的。

1. **P1：完成日推估算不出來時，整個服務起不來**（最嚴重，症狀跟 §4 那條 LF 行尾一模一樣）
   `projectQueue` 的 `guard > 20000` 會 `throw`，而 startup 的 `setImmediate( refreshProjection )`
   **沒有 catch** ⇒ `exit 1`，雙擊 bat 只看到視窗一閃。兩條觸發路徑都實測過：
   (a) 有人把估時打成 `47000`（多打幾位數）→ 存進 data.json ⇒ **之後每次重開都死**，
   (b) `config.json` 的 `workHours` 被改成空的／會議吃掉整天 ⇒ 一樣死。
   **改法**：`projectAll` 改成**逐人 try/catch**（`server.js` 約 968–998 行，含
   `projectionGripes` / `gripeProjection`），壞掉的那個人跳過、其他人照算、看板照開，
   並印一句含人名的中文錯誤；另外加 `EST_MAX_H = 1000`（約 312 行），在 PATCH
   **存檔之前**擋掉超過的估時（約 1425 行）。
   ⚠️ 1000h ＝ 125 個工作日，是**保守值**（實測 guard 約在一人總和 4.7 萬小時才撞到）。
   ⛔ 那個 `throw` 以後也不可以逸出到 `projectAll` 外面，函式上的註解寫了理由。
2. **P2：手改 `data.json` 漏欄位會讓整個看板打不開**
   `migrate()` 只跑一次，之後手加的單如果沒有 `spans`，前端 `for...of t.spans` 直接炸，
   **整頁白掉**（不是只有那張卡片壞）。`comments` 同理，`order` 壞掉會讓 `maxOrder + 10`
   變 `NaN` 汙染後面每一張單。
   **改法**：在 `migrate()` **之後**加一段讀檔邊界的形狀正規化（約 206 行），
   把 `spans`／`comments` 補成 `[]`、`order` 補成遞增數字，並印出補了哪幾張。
   ⭐ **只在記憶體補、不回寫檔案**（所以回退不留痕跡）；放在 migrate 之後是為了
   讓 `[migrate]` 的統計數字保持誠實。
   ⭐ 挑這三個欄位的依據：它們是前端**無條件**迭代／讀長度的唯一欄位
   （`app.js` 的 `for-of t.spans`、`t.comments.length`／`.map`）。
   ⛔ 正解是**在入口統一形狀**，不是在每個讀取點補 `?.` / `|| []`（團隊規則）。
3. **P3：同一分鐘按完成好幾張，第二張之後整格從時間表上消失**
   `pastEntries` 原本一筆一筆看，第二筆的「工作分鐘」是 0，被「> 0」那一關丟掉。
   早上忘了記、一次補登三張就會遇到（很常見）。
   **最後的做法（2026-09-17 使用者裁定「放同一時間段就好」）**：結束在**同一分鐘的**
   **合成一格**、列出每一張，時間就是 `上一件結束 → 這一分鐘` 那段真實區間。
   `pastEntries` 回傳 `entry.also`（同一格的其他張）→ `buildPlanModel` 的 `also`
   → `renderPlan` 畫成 `class="slot multi"`、每張一行、各自帶 `data-id` 所以都點得開
   （`app.js` 約 896–931 / 1064 / 1107 行，`style.css` 的 `.slot.multi` 三行）。
   ⛔ **不要改回「把那幾分鐘平分給它們各自一格」** —— 這條路我走過兩次都不行：
   ⒜ 平分後分到 0 分鐘的那張 `renderPlan` 會跳過 ⇒ 整張單還是消失。
      「同一分鐘結束的張數 > 可分的分鐘數」真的會發生：`t0017` 15:29:40 被插件、
      `t0021` 15:30:16 與 `t0020` 15:30:18 按完成 ⇒ 只有 1 分鐘要分給 2 張。
   ⒝ 補成「每張至少 1 分鐘」就得跟後面借時間 ⇒ 段長加起來比真正過去的時間長、
      還沒做的單看起來晚開始；而且平分出來的長度本身就是假的
      （`doneAt` 只到分鐘，各花多久**我們根本不知道**，所以那版還得畫 `~` 自首）。
   ⭐ 放同一格則三件事同時成立：沒有單消失、時間軸完全不變形、也沒有編出來的長度。
   ⛔ 也不可以拿 `span.min` 或估時去分（既有註解早就否決過）。
   ⚠️ 合併格**刻意不套** `.slot.done` / `.slot.cut`：那兩條的 `::before` 會給整格同一個
   圖示，可是同一分鐘結束的可能一張是完成、一張是被插件 ⇒ 圖示逐行寫在標題文字裡，
   淡掉則由 `.slot.multi { opacity: .5 }` 自己來。
   ⚠️ 舊的排程快照沒有 `also` ⇒ 走原本的一格一張，相容；中間那幾小時存的快照可能
   帶著平分時代的 `split` 欄位，現在沒人讀它，不會出錯（只是那張歷史圖是平分的樣子）。
   ⚠️ `planDay` 標「續」的那個 `seen` 也要把 `also` 裡的單記帳，否則它們之後自己
   那一段不會標「續」。
4. **順手硬化（⚠️ 沒有判準覆蓋）**：`renderPlan` 的 `data-id="${ s.id }"` 改成 `esc( s.id )`。
   防的是「伺服器快照裡的 id 帶引號」，正常流程碰不到，所以也沒做出能觸發它的情境。

### ✅ v5.4：P4／P5／P6／P7 四條都修了（2026-09-17，接在 v5.3 後面）

⚠️ **`server.js` 又動了 ⇒ 要再重開一次**（P4／P5 後端／P7 都在後端）。
P6 與 P5 的前端那半只動 `public/app.js`，重整瀏覽器就吃到。
⭐ 四條都有**突變測試**背書（`mutate-p4567.js` 10/10），⛔ 不是只跑一次綠燈就算。

1. **P4（＝原本的 Bug B）：「原估 ＝ 已做 ＋ 剩」變成無條件成立**
   原本有**兩條**路會讓它對不起來，不只 README 寫的那一條：
   ⒜ 卡片上直接改估時 —— 只寫 `estimate`，`estimate0` / `spentMin` 原封不動。
   ⒝ 被插件時填的「還要多久」**比原本剩的更多**（原估 1h、還要 2h）——
      `cut` 是負數不累加 `spentMin`，於是 1 ≠ 0 ＋ 2。⭐ 這條是 `edge-api` X6 抓到的，
      盤點當時沒寫進 P4 的描述裡，⛔ 所以不要以為 P4 只有「直接改估時」那一條。
   **改法**：`server.js` PATCH 尾端加一段，只要「估時動過」或「走過插件」就把
   `estimate0` 補成 `spentMin/60 + estimate`（算在分鐘上再除回小時）。
   正常那條路本來就相等 ⇒ 那一行是 no-op。用 `cutRound` 這個旗標認得出走過插件。
   ⚠️ **代價（已寫進 README §7 與 §8）**：`estimate0` 的意思從「第一次填的數字」
   變成「現在認為總共要多久」。⛔ 卡片上的標籤還是寫「原估」——
   要不要改成「總估」留給使用者決定，程式沒動。
   ⛔ **沒有走「清掉 `estimate0` / `spentMin`」那條路**：`spentMin` 是後端從估時差
   算出來的真實工時，清掉的話 `spans` 還在 ⇒ 表上有一段灰色、卡片卻說沒做過。
   （`mutate-p4567.js` 第 3 個突變就是走那條路，X10c 會紅。）
2. **P5：排程快照不再掛到 `defaultOwner` 頭上**
   後端 `/api/day-plan`（與同一個坑的 `/api/day-start`）原本是 `b.owner || defaultOwner()`
   ⇒ 沒帶 owner 的寫入會變成那個人的紀錄。現在**兩個寫入都要求明確帶 `owner`**，
   沒帶回 `400`。⚠️ 讀取那條（`ownerParam`，`GET /api/days`）**刻意保留** fallback ——
   讀錯人只是看到別人的歷史，不會弄髒資料。
   前端 `renderToday` 也加了「不是某個人的看板就不存」：
   「還不確定找誰」那一頁沒有主人，而 `canScheduleView()` 在那一頁對管理者是 `true`。
   ⛔ 兩邊都要有 —— 只擋後端的話前端每 4 秒送一次注定 400 的請求。
3. **P6：重疊的固定會議不再把工時扣成負數**
   `app.js` 加了 `busyMerged()`，扣會議之前先把重疊的區間併起來，
   `workMinutesBetween` 與 `workMinutesOnDay` **兩處都要用**。
   ⚠️ 那兩支是幾乎一樣的兩份程式碼（一個算今天、一個算跨天），改一邊要改兩邊 ——
   `edge-plan` 新增的 `__spanMin` 判準就是為了讓「只改一邊」會紅。
   ⛔ `meetingsToday()` / `meetingsOn()` 本身**不要**改成回併好的：畫格子那條
   （`blockSpans`）要的是每一場自己的標題。
   ⭐ 併完是互不重疊的 ⇒ 扣掉的總和一定 ≤ 那段的上班分鐘，所以結果不可能再是負數。
4. **P7：`/api/day-start` 的 `min` 與 `auto` 收嚴了**
   `Number( b.min )` 會把 `null` / `""` / `true` 悄悄變成 `0` / `0` / `1`（起排變午夜）。
   現在只收整數，或**純數字字串**（`"600"`，curl 手打時很常見）。
   ⛔ 不要為了「寬鬆一點」退回 `Number()`。
   另外「`auto:true` 不准蓋掉人自己調過的 `auto:false`」後端也擋了，回 `409` 且資料不動
   —— 這條前端本來就有、後端沒有，兩個分頁搶著寫就會蓋掉。

---

### ✅ v5.5：兩種「不看訂閱範圍」的通知（2026-09-18）

使用者的要求原話：「自己工作被新增項目時，跟項目即將到期時我希望都能通知，**不管有沒有訂閱**」。

⚠️ **「不管有沒有訂閱」沒辦法照字面做到，而且原因不在程式**：
送達管道只有 Telegram 私訊，而 **bot 沒辦法主動私訊一個從沒跟它講過話的人**（TG 的硬限制）
⇒ **綁定 TG ≡ 訂閱**，沒綁的人**沒有送達位址**。
做得到的是**跳過範圍過濾**（`subMatches`），那就是這次做的。
使用者選的方案：**只做 TG，沒綁的人就請他們去綁**（⛔ 不做站內紅點、不開群組彙整）。
⇒ **GreenYang / FrankWen 還沒綁，他們一則都收不到**（見 §2）。

1. **`👤 有項目指派給你`：新單落到我名下、或單子被轉派給我**
   `forcedFor( sub, e )`（`server.js:831`）＝「這張單的 owner 是我」且「不是我自己動的」
   且「是新單或換了負責人」。`flushNotify` 把它併進收件清單：
   `live.filter( e => forced.has( e ) || subMatches( sub, e.task ) )`。
   - ⛔ **只認「新單」與「換人」兩件事**，⛔ 不是「我名下的任何異動」。
     別人把一張大單轉給我，會把我名下其他單的 `projectedDue` 往後推（`refreshProjection`
     發的、沒有 `by` 的異動）—— 那些**不可以**被夾帶進來，否則佇列一動就洗版。
     `notify-check` 的 **N8** 就是守這一條（⭐ 它是唯一抓得到「放寬成 `return true`」的判準：
     N4 抓不到，因為 N4 的動作是本人做的，會先被「⛔ 不吵自己」那條擋掉）。
   - **⛔ 不吵自己**：`queueNew` / `queueNotify` 多收一個 `by`（登入帳號 id），
     `forcedFor` 看到 `e.by === sub.memberId` 就不發。
     ⛔ **`by` 只給強制那條路用** —— 一般訂閱是他自己訂的範圍，自己動了也照樣想收到。
   - 標題三選一：全部都是強制 ⇒ `👤 有項目指派給你`；全部是新單 ⇒ `🆕 有新的需求`；
     其餘 ⇒ `📌 你追蹤的項目有異動`。混在同一則時，強制那幾條的行首會多一個 `👤`。
2. **`⏰ 快到預計完成時間了`：預計完成前 30 分鐘**
   使用者指定的基準是**排程推算出來的完成時刻（分鐘級）**，⛔ 不是卡片上的 `due`
   （`due` 只有日期，推不出「前半小時」—— 這件事有先問過）。
   - `projectQueue` 本來就算得出那個時刻（`cursor`），只是 `ymdLocal` 之後被丟掉了。
     現在回 `{ date, min }`；`refreshProjection` 只取 `date`（`projectedDue` 的語意沒變）。
   - `checkDueSoon()` 每 **60 秒**掃一次（`setInterval`，`server.js` 尾端）。
     ⚠️ 一分鐘是提醒的解析度，拉長的話「前 30 分鐘」會變成「前 30±n 分鐘」。
   - ⛔ **它不呼叫 `refreshProjection`**，只呼叫唯讀的 `projectAll()`。
     呼叫的話每分鐘會寫一次檔，而且會把既有的「預估完成 X → Y」通知吃掉
     （那支是「有變才通知」，每分鐘先跑一遍就永遠沒有差異可報）。
   - 閘門：`isWorkingAt( now )`（正常工時、⛔ 不扣會議）→ 狀態是 `doing`/`todo`
     → 有推估時刻 → `0 ≤ 還有幾分鐘 ≤ dueSoonMin` → 負責人**綁過 TG**。
   - 去重：響過寫 `t.dueNotified = key`（`YYYY-MM-DDTHH:MM`，進 `data.json`）。
     推估會漂，所以容忍度是**一小時** —— 漂超過一小時當成另一個時間點，會重響。
   - `config.dueSoonMin` 可調（1–480 的整數）。⛔ 填錯直接 `process.exit(1)` 並印原因，
     不給預設值吞掉 —— 這是設定檔的錯，不是執行期的意外。

⭐ 兩條都有**突變測試**背書（`mutate-notify.js` **11/11**），⛔ 不是只跑一次綠燈就算。
`notify-check.js` 28 綠 / 0 紅。⚠️ 兩件量不到的事，測法記在這裡免得下次重想：
- **非工時抑制**沒辦法真的把時鐘撥到半夜 ⇒ 用**兩個只差工時區間起點**的實例對照
  （8445 的工時 20 分鐘後才開始、8446 的 5 分鐘前就開始），一個不響一個響。
- **去重的一小時容忍度**沒辦法等時鐘漂（兩個時刻都得落在 30 分鐘的窗裡，彼此不可能差一小時）
  ⇒ 用**種進去的 `data.json`**（8447）給兩張已經「響過」的單，一張記的時刻差 30 分、一張差 3 小時。

---

## 2. ⛔ 還沒做的 / 掛著的

1. **把 Teddy 跟 Jabo 加成編導** —— 使用者選了「自己在網頁上加」。
   人員牆最下面「編導」區的 ＋ 新增編導，代號填 `Teddy` / `Jabo`
   （**要跟舊單 `requester` 那串文字一樣**，大小寫可以不同），角色選編導，加完各發一組起始碼。
2. **`t0012` / `t0013` 的 `requesterId` 要不要補** —— **還沒回**。
   那兩張是 Teddy / Jabo 提的舊單，`requesterId` 是空字串，轉檔只跑一次不會回頭補。
   不補的話那兩張不會出現在他們的「我提的需求」裡，訂閱 `requester:Teddy` 也追不到。
   要補就**關掉服務**再手改那兩個欄位。⛔ 不要為了這個寫 v6 轉檔。
3. **起始碼／密碼要不要重發** —— 使用者已回：**暫時不處理**。（`auth.json` 曾被印出來過。）
4. **✅ Bug B（＝P4）已經修了** —— 2026-09-17 使用者改口「P4 P5 P6 P7 也都修」。
   作法與代價見 §1 的「✅ v5.4」第 1 條，README §7 也改了。
   ⭐ 這裡只留一筆裁決理由：原本兩條路（(a) 等比調 `estimate0`、(b) 清掉那筆帳）
   選了 **(a)**，因為 `spentMin` 是後端算出來的真實工時、而且 `spans` 還留著，
   清掉會變成「表上有灰色區間、卡片說沒做過」。
   ⚠️ **還留一件事沒動**：卡片上的標籤還是寫「原估」，但它現在的意思是
   「目前認為總共要多久」。要不要改成「總估」是使用者的決定，⛔ 沒有自作主張改。
   ⭐ 順帶記一筆（跟 P4 無關、還是成立）：`優化工作看板` 早上那一小時**永遠畫不出來**，
   因為 10:19 插件當下跑的還是 v4 的 server，沒有寫 `spans`。
   那是資料缺口，不是程式錯，⛔ 不要回頭補造。
5. **✅ P5 / P6 / P7 也都修了**（同上，2026-09-17）。細節看 §1 的「✅ v5.4」。
   ⚠️ 探針現在只剩**一條刻意的紅燈**：`edge-plan` 的 **E6**
   「缺 `spans` 欄位的單會讓 `pastEntries` 丟 `t.spans is not iterable`」。
   ⛔ **這條是刻意留紅的，不要為了讓它變綠而在前端補 `|| []`** ——
   P2 的裁決是「在後端讀檔邊界把形狀補齊」（`edge-api` X9 守這一條），
   照團隊規則（形狀在入口統一、⛔ 不要每個讀取點各補一次）前端就該假設 `spans` 一定在。
   真正會踩到 E6 的只有「繞過後端、直接把資料塞進前端」，那不是產品路徑。
7. **⛔ 知博（FrankWen）與大綠（GreenYang）還沒綁 TG ⇒ v5.5 的兩種通知他們一則都收不到。**
   2026-09-18 查過名冊：綁了的只有柏學（boshue）與丁文（DingWun）。
   ⚠️ 這**不是**程式挑人 —— bot 沒辦法主動私訊沒跟它講過話的人，沒綁就沒有送達位址。
   要他們收得到只有一條路：本人登入網頁 → 🔔 訂閱通知 → 私訊 bot `/bind 那組碼`（見 README §3）。
   綁完之後**範圍可以全部不勾**，「指派給你」與「快到期」照樣會來。
6. **`⏸` 在 Windows 上是黑白的（要不要改成彩色 emoji）** —— 小事，沒動。
   `public/style.css:244` 與 `public/index.html:110` 用的是裸的 `U+23F8`，Windows 預設字型
   把它畫成細細的黑白「‖」，旁邊的 `✅`（`U+2705`）卻是彩色的，同一句話裡兩種調性。
   要統一成彩色，就在那兩個 `⏸` 後面各加一個 variation selector `U+FE0F`（`⏸️`）。
   ⚠️ 灰掉那行本來就是「已經過去的」，黑白其實也說得通 —— 所以留給人決定，沒有自作主張改。

---

## 3. 測試資產（都還在）

| 測試 | 條數 | 在哪 | 怎麼跑 |
| --- | --- | --- | --- |
| `v5test.js` | 93 | 本次 scratchpad | 先 `node mkv5.js` → 到 `v5/` 起 server（8433）→ `node v5test.js` |
| `mutate.js` | 5 個突變 | 本次 scratchpad | `node mutate.js`（自己建副本改壞，不碰本體） |
| `starttest.js` | 52 | 本次 scratchpad | 直接 `node starttest.js`（起排判準，純函式，不用起 server） |
| `mutate-start.js` | 14 個突變 | 本次 scratchpad | `node mutate-start.js`（把起排的修正改壞，看 starttest 會不會紅） |
| `daystart-api.js` | 32 | 本次 scratchpad | 直接 `node daystart-api.js`（後端起排 API 與權限；⭐ 自己鋪 8434 隔離實例、跑完自己收） |
| `racetest.js` | 9 | 本次 scratchpad | 直接 `node racetest.js`（輪詢與寫入的競態；假伺服器，不碰 8420） |
| `mutate-race.js` | 4 個突變 | 本次 scratchpad | `node mutate-race.js` |
| `probe-live-start.js` | 探針 | 本次 scratchpad | `node probe-live-start.js`（⚠️ 唯讀，只 GET 8420；寫入一律攔下來只記帳） |
| `edge-plan.js` | 59 綠 ＋ 1 條刻意紅（E6；⭐ E11b 是 P5 的反面對照） | v5.3 scratchpad | 直接 `node edge-plan.js`（前端 20 個特殊情況；`vm` 跑真 `app.js` ＋ 可控的假「現在」。吃 `WB_SRC`） |
| `mutate-plan.js` | 5 個突變 | v5.3 scratchpad | `node mutate-plan.js`（把 P3 改回壞的，看 `edge-plan` 會不會紅；自己建副本，⛔ 不碰本體） |
| `mutate-p4567.js` | 10 個突變 | v5.3 scratchpad | `node mutate-p4567.js`（把 v5.4 的 P4／P5／P6／P7 各自改回壞的；會自己分派到 `edge-api` 或 `edge-plan`。⚠️ 也是字串錨點貼上去的，同樣會印「貼不上（matches=N）」⇒ ⛔ 那不算通過） |
| `rehearse.js` | 重開前的預演 | v5.3 scratchpad | `node rehearse.js`（拿**真 `data.json` 的副本** ＋ 現在的 `server.js` 在 8441 起一次，看警告行／推估／API。⛔ TG 關掉、不寫回真資料夾、⛔ 不印 config／auth 內容） |
| `bind-check.js` | 7 個位置全綠 | v5.3 scratchpad | `node bind-check.js`（把 `paintPlan` 的選擇器從 `app.js` 挖出來跟畫出來的 `data-id` 對帳；⚠️ 是靜態對帳、不是真 DOM，真的點得開還是要人點） |
| `edge-api.js` | 26 綠 / 0 紅（X1–X10） | v5.3 scratchpad | 直接 `node edge-api.js`（後端特殊情況；自己鋪 8436／8437 隔離實例。⭐ X10a–d 是 v5.4 為 P4 新加的：改完估時「原估 ＝ 已做 ＋ 剩」還要成立） |
| `heal-check.js` | 11 綠 / 0 紅 | v5.3 scratchpad | `node heal-check.js`（v5.4 的開機補帳：會不會補、會不會講、⛔ 有沒有多補不該補的、什麼時候落地到檔案、重開第二次是不是安靜的。自己鋪 8442。⚠️ 跟 `edge-api.js` 共用前半段，改過它的環境段要重新產生） |
| `notify-check.js` | 28 綠 / 0 紅（N1–N8、D1–D7） | v5.3 scratchpad | 直接 `node notify-check.js`（v5.5 的兩種強制通知；自己鋪 8443–8447 五個隔離實例。⚠️ **要跑約 2.5 分鐘** —— 到期提醒是 60 秒一次的定時器。`WB_ONLY=n` 只跑強制通知那段（約 15 秒）、`d1` 只等第一輪、`d` 兩輪都等。⚠️ 跟 `edge-api.js` 共用前半段，改過它的環境段要重新產生） |
| `mutate-notify.js` | 11 個突變 | v5.3 scratchpad | `node mutate-notify.js n`（強制通知那 5 條，約 1 分鐘）／`node mutate-notify.js d`（到期提醒那 6 條，約 11 分鐘；第二個參數可以再縮到單一條，例如 `node mutate-notify.js d 容忍度`）。⚠️ 一樣是字串錨點，會印「貼不上（matches=N）」⇒ ⛔ 那不算通過 |
| `edge-guard.js` | 1（⭐ P1 的核心判準） | v5.3 scratchpad | 直接 `node edge-guard.js`（估時階梯 → 殺掉重開，證明還起得來；8438） |
| `edge-two.js` | 2 | v5.3 scratchpad | 直接 `node edge-two.js`（A：工時設定改壞後重開；B：分鐘級估時的時刻標籤。8439） |
| `plantest.js` | 36 | 上個 session scratchpad | 直接 `node plantest.js`（純函式，不用起 server） |
| `subtest.js` | 28 | 同上 | 直接跑 |
| `sub-e2e.js` | 26 | 同上 | 直接跑（自己起 8430 / 假 TG 8431） |
| `v4test.js` | 42 | 同上 | `node mkv4.js` → 到 `v4/` 起 server（8433）→ 跑 |
| `permtest.js` | 28 | 同上 | 到 `perm/` 起 server（8428）→ 跑 |

- ⭐ **v5.5 的回退點**：`server-v5.5.js`（＝現在這版）／`README-v5.5.md`／`HANDOFF-v5.5.md`，
  要退回 v5.5 之前就用 **`server-v5.4.js`**（只有 `server.js` 動過，`public/` 沒動）。
  ⚠️ **這次退版不用退資料** —— v5.5 只多寫一個 `dueNotified` 欄位，v5.4 的程式讀不到它、
  也不會被它弄壞（跟 v5.4 那次「資料也要跟著退」不一樣）。留了一份重開前的
  `data-2026-09-18-before-v55-restart.json` 備查。
- v5.3 scratchpad：`C:\Users\BOSHUE~1\AppData\Local\Temp\claude\D--H5\037ce7ec-672a-45d0-937e-a0cf25e77ab9\scratchpad\`
  （裡面的回退點：**v5.4**＝`server-v5.4.js` / `app-v5.4.js` / `README-v5.4.md`、
  **v5.3**＝`server-v5.3.js` / `app-v5.3.js` / `style-v5.3.css`、
  資料＝`data-2026-09-17-p123.json`（v5.3 當時）與 `data-2026-09-17-1605.json`。
  ⚠️⚠️ **退 v5.4 的話「資料也要退」** —— P4 的開機補帳雖然只改記憶體，
  但**落地的時機比想像的早**：`recomputeProjections()` 在開機時只要有任何一張單的
  推估變了就會 `saveData()`（server.js:1040）⇒ **重開當下 `data.json` 就被改寫了**，
  ⛔ 不需要有人去動任何一張單。實測（`heal-check.js` H3a ＋ 8441 預演）確實如此，
  真資料被動到的是 `t0017`（原估 2h → 5h）。
  ⇒ 只把 `server.js` 換回 v5.3 救不回那個數字，要一起換
  `data-2026-09-17-1710-before-v54-restart.json`（重開前最後一份）。）
- 本次 scratchpad：`C:\Users\BOSHUE~1\AppData\Local\Temp\claude\D--H5--ai-tools-work-board\721c1cca-2f48-4fb3-9b7a-1dcbad6fe8ea\scratchpad\`
- 上個 session：`C:\Users\BOSHUE~1\AppData\Local\Temp\claude\D--H5\531abe04-191f-4b9d-8de0-34faf8b7e010\scratchpad\`
- ⚠️ `v5test.js` / `v4test.js` **不是冪等的**（會新增人員與單），重跑前先跑對應的 `mk*.js` 重鋪。
- ⚠️ `plantest.js` 這次**改過**：測資補了 `spans: []`、`s.entry.done` 換成 `s.entry.kind`。
- ⚠️ `perm/` 的 `server.js` 與 `public/` 這次被換成 v5 的了。
- ⚠️ `starttest.js` / `racetest.js` 吃 `WB_SRC` 環境變數（突變測試用），不設就對本體跑。
- ⭐ **競態那條坑（實際踩過）**：起排寫回伺服器之後，「輪詢的 GET 比我的 POST 更早
  出發、卻更晚回來」的話，舊回應會把剛調好的值蓋掉（畫面彈回去，20 秒後才復原）。
  ⛔ 第一版用「POST 一回來就把 pending 清掉」判斷 —— **清得太早**，正好漏掉最危險
  的那一段。正解是比序號：`refresh()` 出發前拿 `poll = ++pollSeq`，寫入成功時記
  `since = pollSeq`；`since < poll` 才算「這一輪的回應含得到它」。
  ⚠️ 寫**失敗**時要把 pending 刪掉 —— 伺服器上根本沒那筆，留著會讓畫面一直顯示
  一個只有這個分頁看得到的值（`racetest` 的 F1）。
- ⚠️ `mutate-start.js` 的突變是**字串比對**貼上去的：改過 `applyStartForView` 之後
  有錨點會失效，它會印「貼不上（matches=N）—— ⛔ 錨點過期，這不算通過」。
  ⛔ 看到那行不要當成通過，要回去把錨點改成現在的寫法（已經踩過兩次）。
  ⚠️ 結尾那行也會把「幾個錨點過期沒跑到」一起印出來。
- ⚠️⚠️ **`mutate-start.js` 沒有覆蓋 `pastEntries`** —— 它的 X-2（「少了工作分鐘 > 0 那一關」）
  錨點其實在 `maybePullStart`，名字很像但是另一個函式。v5.3 改的是 `pastEntries`，
  所以另開了 `mutate-plan.js` 補這個洞。⛔ 以後動 `pastEntries` 要跑後者，
  光看 `mutate-start 14/14` 不代表那段有被驗到。
- ⭐ **P3 那段的判準看的是「有沒有單消失」，⛔ 不是「有幾段」** —— 同一分鐘結束的
  合成一格之後段數本來就會變少。`edge-plan` 裡用 `covered( past )`（entry 自己的單
  ＋ `entry.also` 裡的單）來數，⛔ 不要退回 `past.length`。
- ⭐ **時間軸守恆**（E1／E2／E19／E20）：段長加起來要**剛好**等於「起排 → 最後一件事」
  的工作分鐘。不多（＝沒跟後面借時間）也不少（＝沒有段被丟掉）。
- ⭐⭐ **`edge-plan` 的 E20 是使用者實際踩到的第二次**（15:29 剛結束一件、15:30 又按兩張
  ⇒ 1 分鐘擺 2 張）。它守：三張都在表上、那兩張同一格且長度就是那 1 分鐘、
  段長加總完全等於實際過去的分鐘、合併格畫成 `.slot multi`。
- ⚠️ `mutate-plan.js` 的 5 個突變分別打：不分群／`also` 只帶第一張／拿掉「工作分鐘 > 0」／
  `also` 沒傳給畫面／合併格每行沒帶 `data-id`。⛔ 最後兩條是「畫面斷在半路」——
  `pastEntries` 對了但畫不出來，判準只看資料層的話抓不到。
- ⚠️ `mutate-p4567.js` 的 10 個突變分別打：**P4** 不補原估／只補「直接改估時」那半（漏掉插件那條）／
  改走「清掉 `estimate0` ＋ `spentMin`」那條被否決的路；**P5** 後端退回 `b.owner || defaultOwner()`
  ×2（day-start／day-plan）；**P6** 兩處各拿掉 `busyMerged`；**P7** `min` 退回 `Number()`／
  拿掉後端的「自動不准蓋手動」；**第 10 個**把前端存快照那段**整個**廢掉。
  ⭐ 第 10 個存在的理由：E11（無主頁不該存）對「什麼都不存」也是綠的 ⇒
  ⛔ 光有它是空判準，要靠 `edge-plan` 的 **E11b**（某個人的看板還是要存、掛在他自己頭上）。
  ⭐ 第 3 個（清帳那條）由 `edge-api` 的 **X10c** 抓 —— ⛔ 它存在的意義是：以後如果有人覺得
  「乾脆把 `estimate0` 清掉比較乾淨」，那條路會立刻紅。
  ⚠️ 判準文字改過的話，這支的 `want` 欄位（用判準前幾個字當錨點）要跟著改，
  否則會報 ❌ 但其實判準有紅 —— 2026-09-17 已經踩過一次。
- ⭐ **P6 有兩份幾乎一樣的程式碼**：`workMinutesBetween`（今天）與 `workMinutesOnDay`（跨天）。
  改一邊要改兩邊，`edge-plan` 的 `__spanMin` 判準就是為了讓「只改一邊」會紅。
- ⚠️ `probe-real.js` / `dump19.js` / `dump20.js` 是**用 `mkdump.js` 之類的腳本把
  `edge-plan.js` 前半段（環境）接上一小段 tail 產生的**，不是手寫的完整檔。
  改過 `edge-plan.js` 的結構（切點是 `let pass = 0, fail = 0`）要重新產生。
  `probe-real.js` 唯讀真 `data.json`，⛔ 不連 8420、不寫任何東西。

---

## 4. 動手前的硬規則（沿用專案慣例）

- ⛔ **不要印出 `config.json` 的內容、`adminPassword`、`botToken`，`auth.json` 也不要貼出來。**
- 零依賴：只能用 Node 內建模組，**不要 `npm install`**。Node 18.14，**沒有 `node:sqlite`**。
- 改完**一定要出驗收單**（`verify-checklist` skill，固定五段）。
  出完驗收單**不要停下來等回覆**，自己驗得動的繼續驗，只把「只有人做得到的」獨立成一段。
- 測 TG 相關的東西**不要對著 8420 真看板跑**，用 scratchpad 裡的隔離實例（8428/8430/8433）。
- ⚠️ 這個資料夾的行尾是 **LF**（不是團隊 Cocos 專案那套 CRLF），改檔時不要順手轉。
- ⚠️ 用 Bash heredoc 寫含正規表達式的 patch script 會**把反斜線吃掉**（`\\d` → `\d`）。
  用 Write 工具寫檔，或把含反斜線的內容放進獨立的 `.txt` 再讀進來。
- ⛔ **`*.bat` 是上面那條「這個資料夾用 LF」的例外，一定要 CRLF。**
  `cmd.exe` 吃不動 LF 行尾的批次檔：雙擊之後 node **不會真的被執行**，
  視窗一閃就關掉（連 `pause` 都不會擋），從外面看就像「點了沒反應」。
  2026-09-17 真的踩到了，查了半天才發現不是 `server.js` 的問題。
  A/B 證據：同一個資料夾、同一份 `server.js`，`cmd /c node server.js` 起得來、
  LF 版 bat 起不來、把同一支 bat 轉成 CRLF 就又起得來。
  ⚠️ 所以**不要**拿「整個資料夾轉成 LF」這種工具掃過去，會把啟動器弄壞。
