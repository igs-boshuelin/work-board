# 計畫書：隔天早上補帳守門（catch-up gate）

> 專案：`D:\H5\_ai-tools\work-board`（自建工作看板，零依賴 Node + 原生 JS，**不是 git repo**）
> 規劃：2026-09-18 · 目標版號：**v5.6**

---

## 1. 任務目標

讓「昨天排了卻沒有留下任何進度紀錄」的單，在本人隔天早上打開看板時**被主動問一次**
「那天做了多少／還要多久」，把答案寫成真實的工時帳與剩餘估時。

做完之後，下面這個具體情況不會再發生：

> `t0013`「初版檢核」（專案 `889`）估時 8h、`due` 2026-09-17。
> 09-17 的排程快照真的把它排了 3h45m（`1065–1080` ＋ 加班 `1110–1320`），
> 但它全程停在 `🟡 已排程`、沒有經過「進行中」，所以 `spentMin` 是 `0`、`estimate` 還是 `8`。
> ⇒ 09-18 的排程又拿**整個 8h** 去塞今天（`606–750`、`810–1080`、加班 `1110–1176`）。

---

## 2. 背景 / 為什麼

**根因**：目前所有工時帳都是「狀態轉換的副作用」。`server.js` 的 PATCH 裡只有這一條路會記帳：

```
task.status === 'doing' && b.status !== 'doing' && b.status !== 'done'
```

也就是**只有「離開進行中」才會算 `spentMin`、才會把 `estimate` 壓成剩餘**。
沒經過「進行中」的單，做了多久都等於沒發生。

**現有機制都補不到這個洞**：

- 「逾期」完全沒有後果 —— `server.js` 裡「逾期」零次命中，只有 `public/app.js:1050`
  印一個紅字、`app.js:301` 數一個數字。沒有任何東西會因為逾期去問「昨天做了多少」。
- 「快到預計完成時間」（v5.5）只看排程推算的完成時刻，跟「昨天到底做了沒」無關。
- 直接在卡片上改估時可以救排程，但**救不回工時帳**。這裡有兩件不同的事，⚠️ 不要混在一起：
  1. **會寫 `spentMin` 的路只有一條** —— 離開「進行中」那個分支（`server.js:1614–1620`）。
     直接改估時只會動 `task.estimate`，不會碰 `spentMin`。
  2. 而且沒走過插件的單（`estimate0` 是 `null`）連「補平 `estimate0`」都會被跳過
     —— 補平那行有 `task.estimate0 !== null` 的守門（`server.js:1650`）。
  ⇒ 昨天的工時永遠不會被記下來，卡片上也不會出現那三個數字。

**不改會怎樣**：排程每天用一個不會衰減的估時去算，`≈ 推估完成日` 與右側時間表都是假的，
而且錯誤會累積 —— 這正是使用者 2026-09-18 回報的症狀。

### 2.1 規範登記與交叉

本專案**未建**（沒有 `rule_conflict_registry.md` / `capacity_table.md`，也不是老虎機專案）。
本任務不涉及表演參數，無洩漏風險。

---

## 3. 開工前先讀（精確指路）

⚠️ `README.md` 與 `HANDOFF.md` 各約 42KB，**不要整份讀**，照下表只讀命中的小節。

| 檔案 | 讀哪一段 | 為什麼要讀 |
|---|---|---|
| `README.md` | §7「做到一半被插件」（搜 `被插件`） | `原估 ＝ 已做 ＋ 剩` 這條唯一硬保證的語意，以及 v5.4 之後 `estimate0` 的意思已經變成「目前認為總共要多久」 |
| `README.md` | §6「已經發生過的事會佔住時間」（搜 `已經發生過的事`） | 為什麼**不能**替補帳寫 `spans` —— 時間表的長度是用「上一件結束 → 這一件結束」推的 |
| `README.md` | §8「資料」（搜 `dueNotified`） | 「沒響過的單**沒有這個欄位**，不是壞資料」＝本次新欄位 `catchUpAsked` 要照抄的慣例 |
| `README.md` | §3「推播時機」（搜 `推播時機`） | 估時是五種會推播的異動之一；90 秒彙整、同欄位只留最初→最後 |
| `server.js` | `parseHours`（L296）、`fmtHours`（L317）、`bodyEstimate`（L333）、`EST_HINT`（L327）、`EST_MAX_H`（L332） | 時間字串的四種寫法與上限守門，⛔ 不要自己再寫一個 parser |
| `server.js` | `ymdLocal`（L972） | 本機日期字串，本次判「早於今天」「落在哪一天」都用它 |
| `server.js` | `canSchedule`（L551）、`session`（L514） | 權限規則：排程與估時**只有本人**，管理者也不行 |
| `server.js` | PATCH `/api/tasks/:id` 的狀態區塊（約 L1605–1655） | 既有記帳算法：`cut`、`spentMin`、`estimate0` 補平那三行 |
| `server.js` | `/api/day-plan`（L1765）、`/api/days`（L1697） | 快照的存法與形狀、`ownerParam` 為什麼不該用在寫入 |
| `server.js` | `queueNotify`（L712）、`refreshProjection`（L1052） | 改完估時要通知誰、要不要重算推估 |
| `public/app.js` | `buildPlanModel`（L1061） | 快照裡 `groups[].segs[]` 的確切欄位（`id` / `from` / `to` / `past`） |
| `public/app.js` | `changeStatus`（L1334） | 既有「還要多久」視窗的措辭與 `parseHours` / `EST_HINT` 用法，新視窗要延續同一套講法 |
| `public/app.js` | `refresh`（L1722）尾端的 `applyView()` | 新守門的掛載點之一，以及「新網頁 ＋ 舊服務」為什麼一定要吞 404 |
| `public/app.js` | `applyView`（L239）、`canScheduleView`（L233）、檔尾的 `hashchange` 監聽（L1825） | 另一個掛載點。⚠️ `hashchange` 只呼叫 `applyView`、**不呼叫 `refresh`** ⇒ 從人員牆點進來不會經過第一個掛載點 |
| `public/app.js` | `renderToday`（L1185）開頭那兩行 `viewing` 判斷 | 「是不是在回看歷史」的既有判準要照抄。⚠️ `#day-pick`（`index.html:98`）初始是**空的 `<select>`**，`.value` 會是 `''` |
| `public/app.js` | `openMemberModal`（L447） | 本專案的 modal 寫法：塞 `#modal-body`、`classList.remove('hidden')`、綁按鈕、`closeModal()` |

---

## 4. 要改的檔案

**只改這四個，不要動其他檔案。**

| 檔案 | 位置 | 改什麼 |
|---|---|---|
| `server.js` | `/api/day-plan` handler 之後（L1783 那行註解之前） | 新增 `GET /api/catch-up` 與 `POST /api/catch-up` |
| `public/app.js` | `refresh()` 尾端（L1763 `applyView()` 之後）**與** `applyView()` 裡面，兩處都要掛；＋ modal 區（`closeModal` 附近） | 新增守門觸發與補帳視窗 |
| `public/style.css` | 檔尾 | 新增補帳視窗那幾列的排版（一個小區塊） |
| `README.md` | §7 之後新增一個小節；§8 的 `tasks` 欄位清單補 `catchUpAsked` | 寫下這個機制與新欄位 |

⚠️ **這個專案的 `.js` / `.md` / `.css` 是 LF 行尾**，⛔ 不要轉成 CRLF。
（只有 `啟動看板.bat` 必須維持 CRLF，本次不會動它。）

⛔ **不要動** `data.json` / `auth.json` / `config.json` / `backup/`。
⛔ **不要新增 npm 依賴**（刻意的零依賴，見 `README.md` 開頭與專案 memory）。
⛔ **不要重啟 8420 上跑著的正式服務**（那是使用者自己決定的時機；驗收用副本另起一個埠，見 §7）。

---

## 5. 實作契約

### 5.0 資料欄位：`task.catchUpAsked`

- 型別：`string`，值是本機日期 `'YYYY-MM-DD'`（用 `ymdLocal( new Date() )` 產生）。
- 語意：**這張單在那一天已經問過了**（不管答案是補帳還是「沒做」）。
- **沒問過的單沒有這個欄位** —— 照 `dueNotified` 的慣例（`README.md` §8）。
- ⛔ **不要寫轉檔（migration）、不要動 `DATA_VERSION`。** 新欄位用「缺欄位＝從沒問過」表達，
  這條路 `dueNotified` 已經走過。`HANDOFF.md` §2 明確寫過「⛔ 不要為了這個寫 v6 轉檔」。

### 5.1 `GET /api/catch-up`

- **簽章**：`GET /api/catch-up?owner=<人員id>`
- **權限**：
  - 沒有 session → `401 { error: '請先登入' }`
  - 沒帶 `owner`、或 `owner` 不是名冊上的人 → `400 { error: 'owner 要明確指定（補帳是一個人一份，不會幫你猜）' }`
    ⛔ **不要用 `ownerParam( query )`** —— 它會退回 `defaultOwner()`，那正是 P5 修掉的坑。
  - `owner !== session.who` → `403 { error: '只有本人能補自己的帳' }`
    ⚠️ **管理者也不行**（跟 `canSchedule` 同一條規則）：「昨天做了多少」只有本人知道。
  - ⚠️ **未登入回 `401` 是這兩支新 API 刻意的規格**，跟隔壁 `/api/day-plan`、`/api/day-start`
    回 `403 '請先登入'` 不一致 —— 這不是引錯。`401`（沒帶憑證）比 `403`（帶了但不准）
    語意正確，而且 `/api/subscribe` 已經在用 `401`。
    ⛔ **不要為了一致把新的改成 `403`，也 ⛔ 不要順手去改那兩支舊 API**
    （前端 `api()` 對兩者處理相同，改舊的只會多一個不在本次射程的風險）。
- **回傳** `200`：

```js
{
    date: '2026-09-17' | null,   // 判定基準日（見下），沒有可用快照時是 null
    items: [ {
        id: 't0013',
        title: '初版檢核',
        project: '889',
        status: 'todo',          // 'todo' | 'doing'
        estimate: 8,             // 小時，目前的估時
        spentMin: 0,             // task.spentMin 原值（整張單累計，不分日）——視窗文案要用
        planned: true,           // 基準日的快照把它排進去了
        plannedMin: 225,         // 基準日快照給它的分鐘數（planned 為 false 時是 0）
        recordedMin: 0,          // 基準日「已經記到帳」的分鐘數（見下）
        stuckDoing: false,       // 狀態是 doing 且 startedAt 早於今天
        startedAt: '',           // stuckDoing 為 true 時帶原值，否則空字串
    } ]
}
```

- **基準日 `date` 的算法**：
  `Object.keys( data.days ).filter( d => d < today && data.days[ d ][ owner ] ).sort().pop() || null`
  （`today = ymdLocal( new Date() )`）
  ⚠️ 是「**最近一個早於今天、而且那個人有快照的日期**」，不是「昨天」——
  週末、請假、那天沒打開看板都會讓昨天沒有快照。

- **命中規則**（兩條，聯集，依 `id` 去重）：

  **A（快照）** —— 只在 `date !== null` 時成立。
  走 `data.days[ date ][ owner ].groups[].segs[]`，收集滿足**全部**下列條件的 `seg.id`：

  1. `seg.id` 有值（會議與空白段沒有 `id`）
  2. `seg.past === undefined`（那一段是「還沒發生的」；`'done'` / `'cut'` 都排除）
     ⚠️ v5 之前的舊快照整份都沒有 `past` 欄位 ⇒ 全部看起來像「未發生」。這是可接受的：
     下面第 5、6 條會把已完成／已擱置／沒估時的濾掉，剩下的問一次就不會再問（`catchUpAsked`）。
  3. ⛔ **`plan.overflow` 裡的不算** —— 那是「那天根本塞不進去」的，不是「排了卻沒做」。
     一張單同時出現在 `segs` 與 `overflow` 時**算命中**（`t0013` 就是這種：排了 225 分、溢出 255 分）。
  4. `findTask( seg.id )` 找得到、且 `task.owner === owner`（轉派走了就不是他的帳）
  5. `task.status === 'todo' || task.status === 'doing'`
     ⛔ `done` / `parked` / `inbox` 都不問 —— 那三種本來就不進排程佇列（`README.md` §6），
     不會造成「估時不衰減」的症狀。
  6. `task.estimate > 0`（沒估時的單排程本來就不排，而且「還要多久」沒有基準）
  7. `task.catchUpAsked !== today`

  `plannedMin` ＝ 該單所有命中 seg 的 `( seg.to - seg.from )` 之和。

  **B（卡在進行中跨日）**：
  `task.owner === owner && task.status === 'doing' && task.startedAt`
  `&& ymdLocal( new Date( task.startedAt ) ) < today`
  `&& task.estimate > 0 && task.catchUpAsked !== today`
  ⇒ `stuckDoing: true`、`startedAt` 帶原值。（同時命中 A 的，兩個旗標都是 `true`。）

- **`recordedMin`**：`date !== null` 時＝
  `( task.spans || [] ).filter( s => s.to && ymdLocal( new Date( s.to ) ) === date ).reduce( ( a, s ) => a + ( s.min || 0 ), 0 )`
  `date === null` 時是 `0`。
  ⚠️ 用途只是視窗上的提示文字 —— 「那天有記過一輪」**不等於**「那天最後那段也記了」，
  所以 ⛔ **不可以拿 `recordedMin > 0` 當排除條件**。
  ⚠️ 這個公式看的是 `spans`，而**補帳刻意不寫 `spans`**（§5.2）⇒ 補過帳的單
  `recordedMin` 還是 `0`。這是預期行為，⛔ 不要為了讓它變好看而改公式或改成寫 `spans`。
  真正「這張單記了多少」要看 `spentMin`，所以上面的回傳要把它一起帶出來。

- **`spentMin`**：`task.spentMin || 0`，原封不動帶出。
  ⚠️ 它是**整張單的累計工時、不分日**，跟基準日無關 ——
  ⛔ 視窗文案不要把它講成「那天做了多少」。

- **排序**：`planned` 的照 `plannedMin` 由大到小；只有 `stuckDoing` 的排在後面。
- **副作用**：無（純讀，不寫檔、不通知）。

### 5.2 `POST /api/catch-up`

- **簽章**：`POST /api/catch-up`，body：

```js
{ id: 't0013', skip: true }                      // 「沒做」：只記「問過了」
{ id: 't0013', spent: '5h', remain: '3h' }       // 補帳
```

  `spent` / `remain` 收 `parseHours()` 吃的四種寫法（`1.5` / `1h30m` / `90m` / `1:30`），
  也收純數字。⛔ **不要自己寫 parser**，直接用 `server.js:296` 的 `parseHours`。

- **權限與驗證**（依序，全部擋在寫檔之前）：
  1. 沒 session → `401 { error: '請先登入' }`
  2. `findTask( id )` 找不到 → `404 { error: '沒有這張單' }`
  3. `!canSchedule( req, task )` → `403`，訊息沿用 PATCH 那句
     `排程與估時只有 <memberName(task.owner)> 本人能改`
  4. `task.status !== 'todo' && task.status !== 'doing'` → `400 { error: '只有已排程與進行中的單能補帳' }`
  5. **冪等守門**：`!b.skip && task.catchUpAsked === today`
     ⇒ 直接 `200 { task, skipped: true }`，**什麼都不寫**（不碰 `spentMin` / `estimate` /
     `estimate0` / `updatedAt`、不 `saveData()`、不通知）。
     ⚠️ 這條是為了「前端整批送出時中途某列失敗，人改完再按一次確定」那個情境 ——
     已經成功的那幾列會被重送，少了這條守門 `spentMin` 就會被加兩次。
     ⛔ 不要改成回 `409`／`400`：前端要能把它當成「這列已經好了」正常收下。
     ⚠️ `b.skip` 的情況**刻意不擋** —— skip 路徑本身只寫 `catchUpAsked = today`，
     重送幾次結果都一樣。
     ⚠️ 副作用是「同一天不能補第二次」。這是接受的：視窗不會再列出它
     （GET 有 `catchUpAsked !== today` 的條件），要再修就走卡片上既有的改估時那條路。
  6. `b.skip` 為真 ⇒ 跳到「skip 路徑」
  7. `spentH = parseHours( b.spent == null || b.spent === '' ? 0 : b.spent )`
     `remainH = parseHours( b.remain )`
     任一為 `null` → `400 { error: EST_HINT }`
  8. `remainH > EST_MAX_H` → `400`，訊息照抄 PATCH 那段（含 `fmtHours( remainH )` 與
     「要填分鐘的話記得加 m」那句提示）
     **`spentH > EST_MAX_H` 也要擋**，同樣回 `400`，訊息開頭改成「已做的時間太大」
     （2026-09-18 終審補上，初版只寫了 `remainH`）。
     ⚠️ 不是對稱性潔癖：「90」想打的是 90 分鐘，`parseHours` 讀成 **90 小時**，
     而 `spentMin` 全案只有兩個寫入點（離開進行中、這支 API）**都只會加不會減**
     —— `server.js` 明寫「⛔ 不要信前端送的 `spentMin`」，所以打錯一次從 UI 救不回來，
     只能停掉服務手改 `data.json`。⛔ 不要只靠連動把「還要多久」壓成 `0m` 當警示，那擋不住送出。
     驗收要帶正控：`spent: '1000'`（剛好等於上限）必須 `200`。
  9. `spentH === 0 && remainH === task.estimate` ⇒ 視同 skip（人按了確定但兩格都沒改，
     ⛔ 不要為此發通知）

- **skip 路徑**（`b.skip` 或第 9 條）：
  - `task.catchUpAsked = today`
  - `task.updatedAt` **不動**（什麼都沒改，⛔ 不要讓它看起來像被編輯過）
  - `saveData()`
  - ⛔ 不 `queueNotify`、⛔ 不 `refreshProjection()`
  - 回 `200 { task, skipped: true }`

- **補帳路徑**：

```js
const estimateBefore = task.estimate;
task.spentMin = ( task.spentMin || 0 ) + Math.round( spentH * 60 );
task.estimate = remainH;
// 「原估 ＝ 已做 ＋ 剩」是 README §7 的唯一硬保證。這裡**無條件**寫 ——
// ⛔ 不要照抄 PATCH 那段的 `estimate0 !== null` 守門：沒走過插件的單 estimate0 是
//    null，帶著那個守門的話補帳就完全不會記帳，這正是本次要修的洞。
// ⚠️ 算在分鐘上再除回小時，⛔ 不要用小時直接相加。
task.estimate0 = ( task.spentMin + Math.round( task.estimate * 60 ) ) / 60;
// 還在進行中的單：這一輪的計時要從補帳這一刻重新開始。⛔ 不重設的話，
//    昨天那段會在下次「被插件」時被 workMinutesSpan( startedAt, now ) 再算一次。
if ( task.status === 'doing' ) task.startedAt = nowISO();
task.catchUpAsked = today;
task.updatedAt = nowISO();
```

  - ⛔ **不寫 `task.spans`。** 理由（兩個都成立，⛔ 不要只因為「帳看起來少一段」就加回去）：
    1. 基準日的快照已經凍結（`data.days` 同一天只留最新一份，歷史頁讀的是那一份），
       補一筆進去**沒有任何顯示路徑**。
    2. 寫成今天的時間戳會被 `app.js` 的 `pastEntries` 當成「今天發生過的事」，
       而時間表的長度是用「上一件結束 → 這一件結束」推的（`README.md` §6）⇒
       會把今天從起排到現在整段吃掉，畫成「你今天早上都在做它」。
  - ⛔ **不動** `status`、`doneAt`、`due`、`order`。
  - `saveData()`
  - 通知：`estimate` 真的變了才發，欄位與措辭跟 PATCH 完全一致 ——

    ```js
    queueNotify( task, [ { field: 'estimate', label: '估時',
        from: estimateBefore ? fmtHours( estimateBefore ) : '未估',
        to: task.estimate ? fmtHours( task.estimate ) : '未估' } ], s.who );
    ```

    ⚠️ 走既有彙整佇列（90 秒 debounce、同欄位只留最初→最後）⇒ 早上一次補三張只會出一則訊息。
  - `refreshProjection()` —— 估時變了，那個人後面每一筆的推估完成日都位移，提出者該知道。
  - 回 `200 { task, skipped: false }`

### 5.3 前端：什麼時候問

**兩個掛載點，都要掛**：

1. `refresh()` 尾端、`applyView()` **之後**（L1763 附近）
2. `applyView()` 裡面，判定出「本人的 member 看板」之後

⚠️ **第 2 個掛載點不是多餘的。** 從人員牆點進自己的看板走的是
`hashchange → applyView`（`app.js:1825`）—— 那條路**完全不會呼叫 `refresh()`**。
只掛第 1 點的話，看板畫出來了但窗不跳，要等最多 20 秒的輪詢才跳。

⚠️ 兩個掛載點會在同一次進場裡都觸發到（重整時 `refresh()` 與 `applyView()` 都會跑）——
靠下面的 `catchUpKey` 擋掉第二次，所以 ⛔ **不要為了「避免重複」而拆掉任何一個掛載點**。

```js
let catchUpKey = '';   // `${owner}@${date}`：這個人的今天已經查過了，別每 20 秒再打一次
```

`maybeCatchUp()` 的守門，**任一條不成立就直接 `return`**：

1. `view.kind === 'member'` 且 `view.owner` 有值
2. `canScheduleView()` 為真（＝`view.owner === meta.who`，**本人**）
   ⚠️ 管理者路過看別人一眼**不問** —— 沿用 `README.md` §6「只有看自己的看板時才會自動定案」那條。
3. **不是在回看歷史**：
   ```js
   const viewing = $( '#day-pick' ).value;
   if ( viewing && viewing !== todayStr() ) return;
   ```
   ⚠️ 判準**照抄 `renderToday`（`app.js:1185`）的 `if ( viewing && viewing !== today )`**，
   ⛔ **不要寫成 `=== todayStr()`**：`#day-pick` 在 `index.html:98` 是個**空的 `<select>`**，
   `refreshDayPicker()` 填完之前 `.value` 是 `''` ⇒ 嚴格比較會在第一次上畫時把守門擋掉，
   症狀是「重整後第一次不跳，要等 20 秒的輪詢才跳」。空字串要算成今天。
4. 三個 modal 都是 hidden（`#modal` / `#pw-modal` / `#sub-modal`）
   ⛔ **不要用 `busy()`** —— 它把「焦點在輸入框」也算忙，那會讓守門在使用者打字時永遠不觸發
5. `catchUpKey !== owner + '@' + todayStr()`；**打 API 之前就先把這個值設好**
   （⛔ 不要等回應才設：`refresh()` 每 20 秒跑一次，慢的回應會讓它重複開窗）

然後：

```js
const r = await api( '/api/catch-up?owner=' + encodeURIComponent( view.owner ) ).catch( () => null );
if ( !r || !r.items.length ) return;
// ⚠️ await 期間人可能已經切走看板、切到歷史、或自己開了別的視窗。
//    ⛔ 不要在這裡重設 catchUpKey —— 這個人的今天確實已經查過了，
//       重設只會讓下一次輪詢再打一次 API、然後在同樣的情況下再判定一次。
if ( 前面第 1–4 條有任何一條不再成立 ) return;
openCatchUpModal( r.date, r.items );
```

⚠️ 第 1–4 條要**抽成一個小函式**（例如 `catchUpAllowed()`），`await` 前後各呼叫一次。
⛔ 不要把條文複製兩份 —— 那種寫法之後改判準只會改到一邊。
（第 5 條不重驗：它在 `await` 前就被自己設成今天了，重驗必然失敗。）

⚠️ **這支 API 失敗一律靜默吞掉**（`catch( () => null )`）。理由跟 `refresh()` 裡
`/api/day-starts` 那段註解同一條：`public/` 是每次請求現讀磁碟、`server.js` 卻要重開服務才會換
⇒ 「新網頁 ＋ 舊服務」必然並存一段時間，那段時間這支是 404。
⛔ 不擋住的話會為了一個提醒賠掉整張看板。

### 5.4 前端：補帳視窗

**一個視窗、一列一張**，`#modal-body` 塞 HTML，沿用 `openMemberModal` 的寫法。

⛔ **不要做成一張一張輪流跳的對話鏈** —— 那需要一套 Promise 狀態機去處理
「中途按 ESC」「點背景關掉」，而 `#modal` 的 ESC 與背景點擊都直接呼叫 `closeModal()`。
一個視窗把「關掉＝這次全部不寫」變成天然行為。

**內容**：

- 標題：`<h2>補一下進度</h2>`
- 說明（`.hint`）—— **判準是 `items.some( i => i.planned )`，⛔ 不是看 `date` 是不是 `null`**：
  - 有任一列 `planned` → `{M/D}{（昨天）}排了這幾張，但沒有進度紀錄。排程還在拿整個估時算，先把帳補平。`
    ——「（昨天）」只有在 `date` 真的等於昨天時才加上去，否則只印日期。
  - 全部都只有 `stuckDoing` → `這幾張卡在進行中已經跨天了。先把帳補平，排程才算得準。`
  ⚠️ `date` 有值、但命中的全是規則 B（卡在進行中）是**會發生的**組合：
  那天有快照，只是快照裡沒有任何符合條件的 seg。
  拿 `date !== null` 當判準會印出「{M/D} 排了這幾張」然後底下每一列都寫「不在任何快照裡」。
  `date` 的唯一用途是上面那句話裡的日期，以及下面每一列的 `{date M/D}`。
- 每張單一列（`data-id` 帶 task id）：
  - 第一行：`{title}`＋`{project}`（有才印，用既有的 `.tag`）
  - 第二行（`.hint`）依旗標組合：
    - `planned && recordedMin === 0 && spentMin === 0`
      → `{date M/D} 排了 {fmtDur(plannedMin)}，沒有任何進度紀錄`
    - `planned && recordedMin > 0`
      → `{date M/D} 排了 {fmtDur(plannedMin)}，那天已記 {fmtDur(recordedMin)}`
    - `planned && recordedMin === 0 && spentMin > 0`
      → `{date M/D} 排了 {fmtDur(plannedMin)}，那天沒有紀錄；這張單目前已記 {fmtDur(spentMin)}`
      ⚠️ 這一條**不能漏**：補帳不寫 `spans` ⇒ 補過帳的單 `recordedMin` 永遠是 `0`。
      漏了的話，一張明明記了 5 小時的單會被寫成「沒有任何進度紀錄」，人會以為補帳沒存進去。
      ⛔ 也不要反過來把 `spentMin` 講成「那天做的」—— 它是整張單的累計。
    - `stuckDoing` 且 `planned` → 上面那句再追加 `・從 {startedAt 的 M/D HH:MM} 起掛在進行中`
    - 只有 `stuckDoing`（`planned` 為 false）→ `從 {startedAt 的 M/D HH:MM} 起掛在進行中，目前估時 {fmtHours(estimate)}`；
      `spentMin > 0` 時再追加 `・已記 {fmtDur(spentMin)}`
  - 兩個輸入框：
    - `做了多少`：**預設空**（⛔ 不要猜一個值填進去）
    - `還要多久`：預設 `fmtHours( item.estimate )`
- `.modal-actions`：
  - `全部都沒做`（`class="btn"`）—— **只有 `items.length > 1` 時才畫**
  - ⛔ **不要**每一列各給一顆「這張沒做」：`items.length === 1` 時會出現兩顆意思相近的按鈕。
    單張不想答就直接關掉視窗，下次重整再問。
  - `確定`（`class="btn primary"`）

**連動規則**（`還要多久` 的自動計算）：

- 在「做了多少」的 `input` 事件裡：`const s = parseHours( 那格的值 )`；
  `s !== null` 時把「還要多久」設成 `fmtHours( Math.max( 0, item.estimate - s ) )`。
- ⚠️ 只在使用者**還沒手動改過「還要多久」**時才連動：那一格綁一個 `input` 監聽把
  `row.dataset.touched = '1'`，連動前先檢查。⛔ 少了這條會把人打進去的數字蓋掉。
- 「做了多少」清空（`parseHours` 回 `null`）時**不要**去改「還要多久」。

**送出（`確定`）**：

1. 先在前端逐列解析：`spent`（空白視為 `0`）與 `remain` 都要 `parseHours` 得出值；
   任一列解析不出來 → `toast( EST_HINT, true )` 並 `return`（⛔ 不要只送成功的那幾列）
   ⚠️ 解析**只掃還沒送成功的列**（見第 2 點的 `data-sent`）——
   已經送成功的列輸入框內容不再重要。
2. 逐列**依序** `await api( '/api/catch-up', { method: 'POST', body: { id, spent, remain } } )`
   （⛔ 不要 `Promise.all` —— 每一次都會 `saveData()` 寫同一個檔）
   - **送之前先跳過 `row.dataset.sent === '1'` 的列**
   - 每一列成功就 `row.dataset.sent = '1'`，並把那一列的兩個輸入框 `disabled = true`
     （人看得出哪幾列已經進去了）
   - 任何一列丟錯 → `toast( err.message, true )`，**停在那裡**、⛔ **不要 `closeModal()`**，
     已送成功的保留
   ⚠️ 這個標記是為了「中途失敗、人改完那一列再按一次確定」—— 少了它會把成功的列重送，
   `spentMin` 就會被加兩次。
   ⚠️ 後端第 5 條冪等守門是**第二道防線**，兩道都要有：前端標記會被「關掉視窗再重整」清掉，
   後端守門則擋不住同一天的第二次「真的想改」。⛔ 不要因為有後端守門就省掉前端標記。
3. 全部送完 → `closeModal()` → `await refresh()` → `toast( '已補上進度' )`
   ⚠️ `refresh()` 裡的 `maybeCatchUp()` 會因為 `catchUpKey` 已經是今天而不再開窗
   - 若**每一筆回應都是 `skipped: true`**（＝全部被冪等守門擋下，或兩格都沒改）
     → 改成 `toast( '這幾張今天已經補過了' )`。
     ⛔ 不要在那種情況印「已補上進度」—— 什麼都沒寫卻說寫了。

**`全部都沒做`**：逐列**依序** `await api( '/api/catch-up', { method: 'POST', body: { id, skip: true } } )`
→ `closeModal()` → `await refresh()` → `toast( '好，都記成沒做' )`
⚠️ **失敗處理跟「確定」完全一樣**：跳過 `data-sent`、成功就標記、任一列丟錯就
`toast( err.message, true )` **停在那裡且 ⛔ 不要 `closeModal()`**。
⛔ 不要寫成「不管成敗都關掉視窗」—— 那會讓人以為十張都記成沒做了，
實際上第三張之後一張都沒寫，而且畫面已經關掉、看不出停在哪裡。
（實作上這兩顆按鈕應該共用同一支送出函式，差別只有 body 與最後那句 toast。）

### 5.5 CSS

在 `public/style.css` 檔尾加一個小區塊，`/* ── v5.6：補帳視窗 ─────── */` 開頭。
只需要：一列的外框（上邊界線、`padding`）、列內兩個輸入框並排
（`display:flex; gap:8px`，每格 `flex:1 1 0; min-width:0`）、輸入框上方的小標題沿用
既有 `.field > span` 的樣式。
⛔ 不要改既有選擇器，⛔ 不要動 `.field` / `.modal-actions` / `.hint` 本身。

### 5.6 README 要補的內容

- **§7 之後**新增小節〈`### 隔天早上會問你「昨天做了多少」`〉，寫：觸發判準兩條
  （快照命中／卡在進行中跨日）、基準日是「最近一個有快照且早於今天的日期」不是「昨天」、
  只問本人不問管理者、「全部都沒做」也會記一筆所以當天不會再問、⛔ 為什麼不寫 `spans`。
  另外要寫清楚這兩件人會踩到的事：
  - **一張單一天只能補一次**（同一天重送會被當成「已經補過了」直接放行不加帳）。
    要再修就改卡片上的估時。
  - 補帳**不會**在右側時間表上長出灰色區間（因為不寫 `spans`）——
    數字會進「已做」，但那天的表已經凍結了。
  - 一張單同時被排進去又溢出（排不完的那種）**算「排了」**，會問。
- **§8 的 `tasks` 欄位清單**補一條 `catchUpAsked`，照 `dueNotified` 那條的寫法
  （「沒問過的單**沒有這個欄位**，不是壞資料。把它刪掉＝那張單今天會再問一次。」）
- ⛔ 不要動 §9「之後可以加的」（那份清單是使用者的，不要替他劃掉項目）。

---

## 6. 明確不要做

- ⛔ **不要寫 `spans`**（理由見 §5.2）。這是本計畫最容易被「好心」加回去的一條。
- ⛔ **不要寫轉檔、不要動 `DATA_VERSION`**。`HANDOFF.md` §2 已明確否決為這類小欄位開 v6。
- ⛔ **不要為了「跟舊 API 一致」去改 HTTP 狀態碼。** 新的兩支未登入回 `401`，
  隔壁 `/api/day-plan` / `/api/day-start` 回 `403 '請先登入'` —— 這個不一致是知道的（見 §5.1），
  ⛔ 不要把新的降成 `403`，更 ⛔ 不要去動那兩支舊 API。
- ⛔ **不要改既有的 PATCH `/api/tasks/:id`**。補帳走新端點，理由是 PATCH 的 `estimate` 那條路
  刻意不動 `spentMin`（`server.js` 註解：「⛔ 不要信前端送的 `spentMin`」），
  不要為了共用而把那條守門鬆掉。
- ⛔ **不要讓管理者替別人補帳**。曾考慮沿用起排那條「本人或管理者」的鬆規則，**否決**：
  起排只決定「表從幾點開始畫」，補帳會改真實工時與估時，屬於 `canSchedule` 的射程。
- ⛔ **不要把「逾期」（`due < today`）加進命中規則。** 2026-09-18 與使用者確認後選定只用
  「快照 ＋ 卡在進行中」兩條：逾期但根本沒排進表的單會每天早上重複問一次，而卡片上已經有紅字了。
- ⛔ **不要順手做「待評估堆積提醒」「別人看板的陳舊標記」「跨日未動 TG 私訊」。**
  那三件已確認留到下一輪、另開計畫書。
- ⛔ **不要自動寫入任何估時**（例如「看到沒進度就自己把估時打折」）。
  預設值可以推，寫入一定要人按過 —— 沿用 `app.js:1334` 上面那段註解的原則：
  「⚠️ 建議值是從 `startedAt` 推的上班時數，所以是問一次再存，⛔ 不要改成自動寫入。」
- ⛔ **不要 round 到 0.5h**。`app.js` 已記：只剩 10 分鐘的單會被建議成 0.5h，使用者回報過。
- ⛔ **不要改印小數**（「剩 1.33h」是使用者明確說看不懂的東西）。一律 `fmtHours` / `fmtDur`。
- ⛔ **不要新增 npm 依賴、不要改 `config.json` 結構、不要動 `啟動看板.bat`。**
- ⛔ **不要重啟或關掉 8420 上的正式服務**，也 ⛔ 不要對正式資料夾跑 `/api/set-password`
  （那會改掉本人真正的密碼）。驗收一律在副本上做，見 §7。

---

## 7. 驗收條件

### 7.1 測試實例怎麼架（⛔ 不要碰正式資料夾）

1. 在自己的 scratchpad 建 `catchup/`，把 `server.js`、`public/`、`config.json` 複製過去
2. 改副本的 `config.json`：`"port": 8441`、**`telegram.enabled` 設 `false`**
   ⚠️ 不關 TG 的話會跟 8420 上跑著的 bot 同時 `getUpdates`，Telegram 回 409（`README.md` §3）
3. 副本裡**自己捏一份 `data.json` fixture**（下面 §7.2），⛔ 不要複製正式的 `data.json`
4. `node server.js` 起在 8441，測完關掉
5. 取得 `who === 'boshue'` 的 session（**只在副本上做**）：
   - `POST /api/login`　body `{ "password": "<副本 config.json 的 adminPassword>" }`
     → 拿 `token`（總管理者，`who` 是 `null`）
   - `POST /api/set-password`　header `x-admin-token: <上面的 token>`，
     body `{ "who": "boshue", "newPassword": "test1234" }`
     → 回應裡的 `token` 就是 `who = 'boshue'` 的 session（管理者不需要舊密碼或起始碼）

### 7.2 fixture 的形狀（日期一律相對「今天」算，⛔ 不要寫死 2026-09-18）

`today = ymdLocal(今天)`、`ref = ymdLocal(今天 − 1 天)`。
`members`：`boshue`（admin）、`other`（dev）。`v` 用 `5`。

⚠️ **每筆 task 都要自己帶齊這些欄位**：`spans: []`、`spentMin: 0`、`startedAt: ''`、
`doneAt: ''`、`estimate0: null`。
理由：把這些欄位補成預設值的那段程式碼（`server.js:140–175`）**在 `from < 4` 的轉檔區塊裡面**
（`if ( t.startedAt === undefined ) t.startedAt = '';` 就在那裡）—— fixture 寫 `v: 5` 就整段跳過。
⛔ 少寫的話那些欄位是 `undefined`，§7.3 裡 `startedAt === ''` 這類斷言會用一個假的理由失敗，
會被誤讀成實作的 bug。（t4 / t5 的 `startedAt` 照下表帶值。）

⚠️ `t4` / `t5` 的 `startedAt` 要寫成**本機時間的 ISO 字串**（含時區偏移，或用
`new Date( y, m, d, 10, 0 ).toISOString()` 這種先組本機時間再轉的寫法）。
⛔ 不要手寫 `'<ref>T10:00:00Z'` —— `ymdLocal( new Date( startedAt ) )` 是按本機時區換算的，
UTC 字串在台北會被推到隔天，`ref`／`today` 的判定就反了。

| id | owner | status | estimate | 在 `days[ref]` 的位置 | 預期 |
|---|---|---|---|---|---|
| `t1` | boshue | todo | 8 | `segs` `from:600 to:825`，無 `past` | **命中**，`plannedMin: 225` |
| `t2` | boshue | todo | 3 | 只在 `overflow` | ⛔ 不命中 |
| `t3` | boshue | done | 2 | `segs`，`past: 'done'` | ⛔ 不命中 |
| `t4` | boshue | doing | 4 | 不在任何快照，`startedAt` ＝ `ref` 那天 10:00（本機） | **命中**，`stuckDoing: true` |
| `t5` | boshue | doing | 4 | 不在任何快照，`startedAt` ＝ 今天 09:30（本機） | ⛔ 不命中 |
| `t6` | boshue | inbox | 0 | `segs`，無 `past` | ⛔ 不命中 |
| `t7` | boshue | todo | 5 | `segs`，無 `past`，且 `catchUpAsked` ＝ `today` | ⛔ 不命中 |
| `t8` | other | todo | 5 | `days[ref].other` 的 `segs` | ⛔ 不出現在 `owner=boshue` 的回應 |
| `t9` | boshue | parked | 5 | `segs`，無 `past` | ⛔ 不命中 |
| `t10` | boshue | todo | 6 | `segs` `from:900 to:960`，`spans` 有一筆 `to` 落在 `ref`、`min: 120` | **命中**，`recordedMin: 120` |
| `t11` | boshue | todo | 8 | `segs` `from:1065 to:1080` ＋ `from:1110 to:1320`（都無 `past`），**同時**在 `overflow` | **命中**，`plannedMin: 225` |

⚠️ **`t11` 是本次要修的那張真實單（`t0013`「初版檢核」）的形狀**：09-17 的快照把它排了
`1065–1080` ＋ 加班 `1110–1320`（共 225 分），同時 `overflow` 還留著剩下的 255 分。
它把 §5.1 命中規則第 3 條鎖住 —— **「`overflow` 裡的不算」不可以寫成「出現在 `overflow` 就排除」**。
⛔ 不要為了讓 `t2` 與 `t11` 的規則「看起來一致」而把這張也濾掉：那樣本計畫書 §1 講的那張單
就是永遠不會被問到的，整個功能對它無效。
（`t2` 與 `t11` 的差別只有一個：`segs` 裡有沒有它。）

### 7.3 逐條驗收（寫一支 `catchup-test.js` 在 scratchpad，跑完貼真實輸出與通過條數）

⚠️ **每一條 POST 案例開始前，腳本要自己把那張單的 `catchUpAsked` 調成想要的狀態**
（要測「第一次補」就刪掉它，要測冪等就留著）。
⛔ 不要假設案例的執行順序 —— 上一條寫進去的 `catchUpAsked` 會讓下一條變成回 `skipped: true`，
那種失敗會被誤讀成實作的 bug。

⚠️ **`data.json` 是開機時讀進記憶體的**（`public/` 才是每次請求現讀）⇒
服務跑著的時候手改 `data.json` **沒有效果**，而且會被下一次 `saveData()` 整份蓋掉。
所以要調 fixture 狀態只有兩條路：
- 用 API 調（例如 `PATCH /api/tasks/:id` 改 `status`）；
- 或**關掉服務 → 改 `data.json` → 重開**。

✅ **最省事的作法：不要重用單，fixture 多捏幾張。**
下面每一條寫「先把 `catchUpAsked` 清掉」的案例，改成**各給一張自己的單**
（照 `t1` 的形狀複製成 `t12`、`t13`…，`estimate` 依案例需要調）——
`catchUpAsked` 從來沒被寫過，就不用清、也不用重開服務。
需要重開的只剩下「把 `t3` 改成別的狀態」這類，腳本用 `child_process.spawn` / `kill`
自己管一次重開就好，⛔ 不要在服務跑著時邊改檔邊打 API。

**GET**

- [ ] `GET /api/catch-up?owner=boshue`（boshue token）→ `200`，`date === ref`，
      `items` 的 id 集合**剛好**是 `{ t1, t4, t10, t11 }`
- [ ] `t1`：`plannedMin === 225`、`recordedMin === 0`、`planned === true`、`stuckDoing === false`
- [ ] `t4`：`stuckDoing === true`、`planned === false`、`plannedMin === 0`、`startedAt` 帶原值
- [ ] `t10`：`recordedMin === 120`
- [ ] **`t11`（同時在 `segs` 與 `overflow`）：`planned === true`、`plannedMin === 225`**
      ——「兩段 seg 相加」與「不因為 `overflow` 被排除」一次驗到
- [ ] 每一筆 `item` 都有 `spentMin` 這個欄位（型別是數字）
- [ ] 沒帶 `owner` → `400`
- [ ] `owner=other`（boshue token）→ `403`
- [ ] 不帶 token → `401`
- [ ] 用總管理者 token（`who` 是 `null`）＋ `owner=boshue` → `403`

**POST：補帳**

- [ ] `{ id:'t1', spent:'5h', remain:'3h' }` → `200`，且 `t1` 變成
      `estimate === 3`、`spentMin === 300`、`estimate0 === 8`、`catchUpAsked === today`、
      `spans.length === 0`、`startedAt === ''`、`status === 'todo'`、`doneAt === ''`
- [ ] `estimate0 === spentMin / 60 + estimate`（「原估 ＝ 已做 ＋ 剩」）成立
- [ ] `{ id:'t4', spent:'2h', remain:'2h' }` → `t4.spentMin === 120`、`estimate === 2`、
      `estimate0 === 4`，且 **`startedAt` 被重設成補帳當下**（`ymdLocal(t4.startedAt) === today`）
- [ ] `{ id:'t10', spent:'', remain:'4h' }` → `spentMin` **不變**（仍是 fixture 裡的值）、`estimate === 4`
- [ ] 補完的那張再 `GET` 一次 → 不再出現在 `items` 裡
- [ ] `{ id:'t1', spent:'90m', remain:'1:30' }`（先把 `catchUpAsked` 清掉再打）→
      四種寫法都吃得下，`spentMin` **累加**而不是覆蓋

**POST：冪等（同一天重送不重複加帳）**

- [ ] `{ id:'t11', spent:'2h', remain:'6h' }` → `200 { skipped: false }`，`t11.spentMin === 120`
- [ ] **緊接著把同一個 body 再送一次** → `200`，且回應是 `{ skipped: true }`，
      `t11.spentMin` **仍然是 `120`**、`estimate` 仍是 `6`、`estimate0` 仍是 `8`、
      `updatedAt` 跟第一次之後**一樣**（沒有被第二次碰到）
      壞掉的樣子：`spentMin` 變成 `240`（第 5 條冪等守門沒寫，或寫在解析之後卻先改了欄位）
- [ ] 模擬「中途失敗後重送整批」：先 `{ id:'t1', ... }` 成功、再 `{ id:'t3', ... }`（已完成 ⇒ `400`），
      然後把 `t1` 與一張合法的單一起重送 → `t1` 回 `{ skipped: true }` 且 `spentMin` 不變，
      另一張正常寫入
- [ ] `{ id:'t11', skip:true }`（`catchUpAsked` 已經是 `today`）→ `200 { skipped: true }`，
      數字一個都沒變（skip 刻意不被冪等守門擋，重送結果相同）

**POST：skip 與擋門**

- [ ] `{ id:'t10', skip:true }`（先清 `catchUpAsked`）→ `200 { skipped: true }`，
      `estimate` / `spentMin` / `estimate0` / `updatedAt` **一個都沒變**，只有 `catchUpAsked === today`
- [ ] `{ id:'t10', spent:'0', remain:'<t10 目前的 estimate>' }` → `skipped: true`，數字不動
- [ ] `{ id:'t8', spent:'1h', remain:'1h' }`（boshue token）→ `403`
- [ ] `{ id:'t3', spent:'1h', remain:'1h' }`（已完成）→ `400`
- [ ] `{ id:'t1', spent:'abc', remain:'3h' }` → `400`，訊息含 `EST_HINT` 的內容
- [ ] `{ id:'t1', spent:'1h', remain:'2000' }` → `400`（`EST_MAX_H`），且 `t1` 的數字**沒有被改到**
- [ ] `{ id:'t1', spent:'5000', remain:'3h' }` → `400`，訊息含「已做的時間太大」，`t1` 的數字沒被改到
      正控：`{ spent:'1000', remain:'0' }`（剛好等於上限）必須 `200`
      壞掉的樣子：回 `200` 且 `spentMin` 變成 `300000`（只擋了 `remain`，見 §5.2 第 8 條）
- [ ] `{ id:'nope', spent:'1h', remain:'1h' }` → `404`
- [ ] 不帶 token → `401`

**回歸（⛔ 不要弄壞既有行為）**

- [ ] 既有的「被插件」那條路還是對的：把 `t5`（doing）PATCH 成 `{ status:'todo', estimate:2 }`
      → `spans` 多一筆、`estimate0 === spentMin / 60 + estimate`
- [ ] 對一張**沒有** `catchUpAsked` 的單做任何既有操作，不會意外長出這個欄位
- [ ] 沒有動到 `data.json` 的 `v`（fixture 前後都是 `5`）
- [ ] 正式資料夾的 `data.json` / `auth.json` / `config.json` mtime 沒有變

**前端（不能自動化的部分，寫清楚「壞掉的樣子」給人看）**

⚠️ **這一段要用一份「沒有被 POST 跑過」的 fixture。** 上面的 POST 驗收會把
`t1` / `t4` / `t10` / `t11` 的 `catchUpAsked` 都寫成 `today` ⇒ GET 就一張都不回，視窗永遠不跳，
人會誤判成守門壞了。作法二選一，寫進測試腳本裡：
- 跑 POST 驗收**之前**先把 fixture 的 `data.json` 複製成 `data.fixture.json`，
  前端驗收前覆蓋回去（服務要先關掉再覆蓋，不然會被記憶體裡的資料寫回去）；
- 或測試腳本收尾時把那幾張的 `catchUpAsked` 刪掉。

- [ ] 用副本 8441 開瀏覽器、以 boshue 登入、**重整進自己的看板** → 補帳視窗自動跳出來，列出 4 張
      壞掉的樣子：完全不跳（守門條件寫錯，或 API 404 被吞掉而條件其實也沒過）；
      **只在等了 20 秒之後才跳**（`#day-pick` 的判準寫成嚴格 `=== todayStr()`，
      第一次上畫時 `.value` 還是 `''` 被擋掉）；
      或每 20 秒重複跳一次（`catchUpKey` 沒有在打 API **之前**設好）
- [ ] **從人員牆點進自己的看板**（先切到「還不確定找誰」或別人的看板，再點回自己）
      → 視窗**立刻**跳出來
      壞掉的樣子：看板畫出來了但窗不跳，等最多 20 秒的輪詢才跳
      （`maybeCatchUp` 只掛在 `refresh()`，而這條路走的是 `hashchange → applyView`，
      不經過 `refresh()`）
- [ ] 在「做了多少」打 `5h` → 「還要多久」自動變成 `3h`；接著手動把它改成 `4h`，
      再回去把「做了多少」改成 `6h` → 「還要多久」**維持 `4h` 不被蓋掉**
      壞掉的樣子：第二次連動把手打的 `4h` 蓋成 `2h`（`dataset.touched` 沒生效）
- [ ] 按 ESC 關掉 → 什麼都沒寫（重整後視窗再次跳出、`catchUpAsked` 仍不存在）
- [ ] **中途失敗要停在視窗上**：先手動把 `t3` 改成 `status: 'done'` 之外的方式不好做，
      改用這招 —— 在第二列的「還要多久」填一個超過上限的值（例如 `2000`），按 `確定`
      → 第一列寫進去了（輸入框變灰、不能再改）、**視窗沒關**、紅色 toast 說估時太大
      → 把第二列改成 `3h` 再按一次 `確定` → 這次全部成功、視窗關掉
      壞掉的樣子：第一次按下去視窗就關了（`closeModal()` 被寫在失敗路徑上）；
      或第二次按完 `t1` 的 `spentMin` 變成兩倍（前端沒跳過 `data-sent`，而後端守門也漏了）
- [ ] **`全部都沒做` 的失敗處理跟 `確定` 一致**：用同樣的手法讓其中一列失敗
      （例如先在另一個分頁把某張單改成 `done`，再按 `全部都沒做`）
      → 視窗**沒關**、紅色 toast、已經記成沒做的那幾列有標記
      壞掉的樣子：視窗關掉且 toast 說「好，都記成沒做」，實際上後面幾張一張都沒寫
- [ ] 切到「還不確定找誰」或別人的看板 → **不跳**
- [ ] 用 `#day-pick` 切到歷史某天 → **不跳**
- [ ] 把副本的 `server.js` 換回沒有這兩支 API 的舊版、只留新的 `public/` → 看板照常開得起來、
      不跳窗、console 沒有未捕捉的錯誤
      壞掉的樣子：整張看板空白或卡在載入（404 沒被 `catch` 吞掉）

---

## 8. 人工待辦（實作者不要自己做）

| 事項 | 說明 |
|---|---|
| **重開 8420 的正式服務** | 這次動了 `server.js` ⇒ 重整瀏覽器沒有用，非重開不可。⚠️ 重開會把所有人登出（`sessions` 是記憶體裡的 `Map`），時機由使用者決定。作法見 `HANDOFF.md` §0「要再重開的話」。 |
| **重開前先備份** | `data.json` 與 `auth.json` 各留一份（本次不寫轉檔，但補帳本身會改寫 `data.json`）。 |
| **`t0013` 的第一次補帳** | 服務重開後，使用者自己打開看板回答一次 —— 那就是這個功能的第一次真實驗收。 |

---

## 9. 回報格式

做完請照這個格式回覆（下游 review 會據此對照）：

1. **改了哪些檔案** —— 逐檔一行，寫清楚改在哪個函式、做了什麼
2. **偏離計畫書的地方** —— 有就寫，含原因；沒有寫「無」
3. **不確定 / 需要決策的點** —— 有疑慮不要自己拍板：說明你選了什麼保守做法、為什麼
4. **沒做的部分** —— 做不到或被擋住的，說明原因
5. **測試輸出** —— `catchup-test.js` 的真實輸出（通過 / 總條數），以及測試檔放在哪

第 2、3、4 項寫「無」要是真的無 —— 蓋掉偏離處會讓下游 review 失焦，比偏離本身更糟。
