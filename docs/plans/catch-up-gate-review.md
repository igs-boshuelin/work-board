# 回饋：catch-up gate 計畫書預審

> 對象：`docs/plans/catch-up-gate.md`（v5.6）
> 日期：2026-09-18
> 性質：計畫書預審（還沒有實作 diff）。三面向平行審＋逐項反駁後，只留下確認過的問題。
> 下一步：人在下面「裁決」欄圈選；確認後才改計畫書，不要直接 `/impl`。

主幹沒問題：不寫 `spans`、不改 PATCH、管理者不能代補、缺欄位＝沒問過、`dueNotified` 慣例。
照現況實作，有兩處契約會直接做錯。

---

## 裁決（人填）

| # | 嚴重度 | 一句話 | 裁決 |
|---|---|---|---|
| X-1 | 必修 | `#day-pick` 空字串會讓第一次不問；人員牆點進來也不跑 `refresh()` | 待裁：A 放寬判準 / B 放寬＋`applyView` 也掛 / C 不改 |
| X-3 | 必修 | POST 不冪等，中途失敗再送會把 `spentMin` 加兩次 | 待裁：A 當天再 POST 當 skip / B 回 409 / C 不改 |
| X-4 | 決策 | 今早先被插件，文案會寫「沒有進度紀錄」 | 待裁：A 只改文案 / B 文案＋`recordedMin` 改交集 / C 不改 |
| C-6 | 建議 | fixture 沒有 segs＋overflow，鎖不住 `t0013` | 待裁：加 / 不加 |
| C-2 | 建議 | 大標用 `date` 有沒有值決定「排了這幾張」 | 待裁：改看 `planned` / 不改 |
| C-3 | 建議 | 「全部都沒做」沒寫中途失敗 | 待裁：套用確定那套 / 不改 |
| C-5 | 建議 | fixture 沒寫 `startedAt`/`doneAt` 空字串 | 待裁：補預設 / 不改 |
| C-7 | 建議 | 前端驗收沒說要另用沒跑過 POST 的 fixture | 待裁：寫明分隔 / 不改 |
| C-4 | 建議 | await 回來不重驗 view／modal | 待裁：補重驗 / 不改 |
| H-2 | 建議 | §2 把「改估時不記帳」歸因到錯的守門 | 待裁：改文件 / 不改 |

建議預設（人沒圈就照這組改計畫書）：

- X-1 → **B**（放寬判準 ＋ `applyView` 進入本人 member 看板也叫）
- X-3 → **A**（`catchUpAsked === today` 且不是 skip → `200 { skipped: true }`，前端重送只送還沒成功的）
- X-4 → **A**（live `spentMin > 0` 就不要寫「沒有任何進度紀錄」；`recordedMin` 公式不動）
- 建議修全部 → **改**

---

## 必修

### X-1　第一次打開自己的看板，照 §5.3 寫不會立刻問

**位置**：計畫書 §5.3 守門第 3 條；現況 `public/app.js` `applyView` / `renderToday` / `init`

**問題**：守門要求 `$('#day-pick').value` **嚴格等於** `todayStr()`。`index.html` 的 `#day-pick` 是空 `<select>`。`refresh()` 尾端的 `applyView()` 以**無 await**呼叫 `refreshDayPicker()`（要打 `/api/days`），`maybeCatchUp()` 若緊接在 `applyView()` 之後跑，那時 `value === ''`，條件 3 失敗、直接 return，而且**還沒設** `catchUpKey`。

第二條失效路徑：人員牆點進自己看板只走 `hashchange → applyView()`（`app.js:1825`），計畫把掛點只放在 `refresh()` 尾端 ⇒ 這條路永遠不觸發，只剩 20 秒 `setInterval`，且外層包 `if (!busy())`（焦點在 INPUT/SELECT 也算忙）。

`renderToday` 自己的歷史判準是 `if ( viewing && viewing !== today )`——空字串當今天。計畫第 3 條跟它不一致。

**會怎樣**：最常見的「早上打開自己的看板」第一次不問。人員牆點進來要等最多 20 秒；一進看板就點估時格，這 20 秒還會再被 `busy()` 吃掉。

**建議改計畫書**：

1. 第 3 條改成跟 `renderToday` 同一句：`viewing && viewing !== todayStr()` 才跳過（空字串＝今天）。
2. 除了 `refresh()` 尾端，`applyView` 進入本人 member 看板時也叫 `maybeCatchUp`（人員牆點進來才會立刻問）。
3. §7.3 前端補一條：從人員牆點進自己看板也要跳；壞掉的樣子是「看板畫出來了但窗不跳，等到 20 秒輪詢才跳」。

`catchUpKey` 的「重整＝F5」語意沒問題（見已排除 C-1），不要為了這條去清 key。

---

### X-3　確定鈕中途失敗再送，已成功那列 `spentMin` 會加兩次

**位置**：§5.2 補帳路徑 `spentMin +=`；§5.4「任何一列丟錯 → 停在那裡，已送出的保留」

**問題**：§5.2 驗證第 1–8 條沒有任何一條以 `catchUpAsked === today` 擋回。第 8 條「`spentH === 0` 且 `remainH === task.estimate`」在重送時不成立（remain 已是人打的新值）。前端視窗還在、三列輸入都還在，再按確定會把已成功那列再 POST 一次，後端照樣 `spentMin +=`。

**會怎樣**：已做被灌水；之後走既有「被插件」會繼續加在假數字上。兩個分頁各送一次是同一種洞。

**建議改計畫書**：

- POST：`task.catchUpAsked === today` 且不是 skip → 回 `200 { task, skipped: true }`，**不要再加 `spentMin`、不要改 estimate**。（選 409 也可以，前端比較好標「這列已經寫過」；靜默 skip 比較短。）
- 前端：成功列做標記，重送只送還沒成功的。
- §7.3 加一條：第一列成功、第二列失敗、再按確定，第一列 `spentMin` 不變。

---

## 需要決策

### X-4　今早先被插件，補帳文案會說「沒有進度紀錄」

**位置**：§5.1 `recordedMin` 只收 `ymdLocal(s.to) === date`；列文案 `planned && recordedMin === 0`

**路徑**：單從昨天 `doing` → 今早走既有被插件（`changeStatus` → PATCH）→ `spans.to` 是**今天**、`spentMin` 已含昨天到現在、狀態變 `todo` → GET 規則 A 仍命中昨天快照 → `recordedMin === 0` → 印「沒有任何進度紀錄」。人若照提示再填「做了多少」，POST 再 `spentMin +=`。

計畫明文「不可以拿 `recordedMin > 0` 當排除條件」，所以這條路不會被濾掉。兩格都沒改就按確定會走 skip，數字倖免——危險的是誤導文案。

跟 X-1 有關：若第一次不問、人先被插件再被問到，這條更容易走到。補帳之後再被插件是安全的（`doing` 會重設 `startedAt`）。

**選項**：

| | 做法 | 代價 |
|---|---|---|
| **A（建議）** | 列上同時印 live `spentMin`；`spentMin > 0` 時不要寫「沒有任何進度紀錄」 | `recordedMin` 公式不動，排除條件也不動 |
| B | A ＋ `recordedMin` 改成 interval 與基準日有交集（`from` 或 `to` 落在那天） | 提示比較準，但仍不當排除條件 |
| C | 不改 | 靠人自己記得今早已經插件過 |

---

## 建議修

### C-6　fixture 鎖不住 §1 的動機案例

§5.1 A.3：「只看 `segs`，overflow 裡的不算；一張單同時出現在兩邊**算命中**（`t0013` 就是這種）。」
§7.2 的 t1 只在 segs、t2 只在 overflow。有一種合理誤讀是加 `filter(id => !overflowIds.includes(id))`，把 segs∩overflow 反向排除——t1/t2 測不出這個錯，§7 全綠但 `t0013` 不問。

**改**：fixture 加一張同時在 `segs` 與 `overflow` 的單，GET 斷言它命中。

### C-2　視窗大標用錯旗標

`date`＝「最近一份早於今天的快照」，跟 items 有沒有 `planned` 無關。昨天有快照、但 items 全是 B 條（卡在進行中、沒排進表）時，§5.4 仍印「排了這幾張」。每列 `.hint` 是對的，只有大標說錯。

**改**：大標看 `items.some(i => i.planned)`；`date === null` 只負責「沒有可用快照」那句。

### C-3　「全部都沒做」沒寫失敗怎麼停

「確定」有「任一列丟錯 → toast、停在那裡、已送出的保留」。「全部都沒做」只有成功路徑。中途失敗時前面幾張已經寫了 `catchUpAsked`，視窗卻可能關了。

**改**：skip 批次套用同一套，不要 `closeModal`。

### C-5　§7.3 斷言依賴表上沒列的欄位

啟動時的形狀補齊不管 `startedAt`/`doneAt`；v5 的 migrate 也不補。fixture 若只照 §7.2 的欄表捏，`startedAt === ''` 會紅（`undefined === ''`）。`spentMin`/`estimate0` 那兩條斷言是安全的（handler 有兜底、補帳後重算）。

**改**：§7.2 加預設 `startedAt: ''`、`doneAt: ''`、`spentMin: 0`。`t4`/`t5` 的 `startedAt` 寫成本機 ISO，讓 `ymdLocal(new Date(...))` 對得上 `ref`／`today`。

### C-7　前端「列出 3 張」跟後端 POST 搶同一份 fixture

後端補帳測完 t1/t4/t10 都有 `catchUpAsked === today`。同一節後面前端卻說進看板要列出 3 張。照順序在同一份副本上做，前端看到 0 張，會被判成守門壞掉。

**改**：寫明前端用**未跑過 POST** 的 fixture（或 `catchup-test.js` 結束後還原／另寫一份）。

### C-4　await 回來不重驗

守門全在 `await` 前。localhost 讀記憶體，回應約 10–50ms，自然點麵包屑幾乎走不到。但仍是未定義的重入：慢回應期間切到別人看板／歷史日／打開別的 modal，回來仍會 `openCatchUpModal`。

**改**：`await` 後重跑第 1–4 條，不成立就 return；不要重設 `catchUpKey`。

### H-2　§2 歸因寫錯（契約已堵住，改文件即可）

「改估時不記 `spentMin`」是對的，但原因不是 `estimate0 !== null` 守門。那道守門在 `server.js:1650`，只跳過補 `estimate0`；`spentMin` 只在離開進行中時寫（`server.js:1614–1620`）。§5.2 已寫「不要照抄 PATCH 守門」、§6 已寫「不要改 PATCH」，實作者不太會因此去鬆 PATCH。

**改**：§2 拆成兩句——記 `spentMin` 的路只有離開進行中；直接改估時只動 `estimate`，沒走過插件時連 `estimate0` 補平都被跳過。

---

## 已排除 3 項

- **[C-1]** `catchUpKey` 跟「重整再問」打架 — 「重整」＝ F5；變數在記憶體，重載天然歸零。20 秒再跳才是壞掉。
- **[H-1]** HANDOFF「不要寫 v6 轉檔」講的是兩張舊單的 `requesterId` — 計畫自己已禁 `DATA_VERSION`，主依據是 `dueNotified`，後果不成立。
- **[X-2]** GET 回來蓋掉已開的 modal — localhost 記憶體讀、回應窗口短於點擊；ESC 後當天不再問是規格。

---

## 對帳（行號／既有行為）

§3 引用的函式與行號幾乎都還在原位（允許 ±2 行那種漂移不算錯）：

- `parseHours` / `fmtHours` / `EST_HINT` / `EST_MAX_H` / `ymdLocal` / `canSchedule` / `session` / `queueNotify` / `refreshProjection` 都對。
- PATCH 要照抄的兩句錯誤訊息還是原文；「不要信前端 `spentMin`」註解還在。
- 快照形狀（`groups[].segs[]` 的 `id/from/to/past`、頂層 `overflow`）與 `pastEntries`「今天的 `spans.to` 會佔住時間軸」都跟禁寫 `spans` 的理由對得上。
- `busy()` 真的把打字算進去；20 秒輪詢真的包 `if (!busy())`；`day-starts` 404 吞法的註解就是「新網頁＋舊服務」。

唯一的語意引用問題是 H-2（上面）與 H-1（已排除）。

沒當成 finding、但實作者可能撞到的小差異：沒 session 時既有 day-plan／day-start 回 **403** `'請先登入'`，計畫書 GET catch-up 寫的是 **401**。計畫書是新規格，不是引錯；實作時不要「為了一致」改成 403，也不要回頭改舊 API。

---

## 覆蓋範圍

- **契約**：內部互打、驗收蓋不住自己寫的規則、§6 否決有沒有被偷渡。Skip／補帳兩條路徑是分得開的；§6 否決的東西沒有被 §5 引回來。
- **對帳**：§3 點名的 `server.js` / `app.js` / README 命中小節／HANDOFF §2 都核過。
- **脈絡**：PATCH 被插件、`changeStatus`、`pastEntries`、overflow（含 `t0013` 真資料就是 segs＋overflow）、`ownerParam`、`canSchedule` vs 起排、總管理者 `who === null`、20 秒輪詢、ESC／`closeModal`。

**沒查證**：兩個分頁同時開窗各送一次（跟 X-3 同一種灌水）；瀏覽器時區 vs Node `ymdLocal` 差一天；v5 之前完全沒有 `past` 的舊快照（計畫當成可接受；本機 09-16/09-17 已有 `past`）。
