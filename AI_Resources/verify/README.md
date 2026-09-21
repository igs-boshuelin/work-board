# 「希望完成」異動守門的驗收 harness

`verify-wish.js` ＝ 59 條 assertion，驗 `PATCH /api/tasks/:id/wish` 的權限、硬限制、
三種紀錄（`wishLog` / 系統留言 / TG 彙整）。

⚠️ **只打 8443（副本），⛔ 絕對不要指到 8420 的正式資料夾** —— 它會真的寫單、改密碼。

## 怎麼跑

```bash
mkdir /tmp/wbtest && cd /tmp/wbtest
cp <專案>/server.js . && cp -r <專案>/public . && cp <專案>/AI_Resources/verify/*.js .
node make-fixture.js          # 產 config.json（port 8443、adminPassword=testroot）＋ data.json
node -e "require('fs').writeFileSync('auth.json',JSON.stringify({v:2,members:{},setup:{},subscribers:{
  boshue:{memberId:'boshue',label:'柏學',scopes:['owner:boshue'],tgChatId:'999001'},
  zoe:{memberId:'zoe',label:'小柔',scopes:['requester:zoe'],tgChatId:'999002'}}}))"
node server.js > srv.log 2>&1 &
node verify-wish.js
```

⭐ **訂閱那一段不能省** —— 少了它 `flushNotify` 選不到收件人，L1–L4（TG 訊息長相）
會全部紅掉，而那四條正是「併進現有彙整」有沒有做到的證據。

⚠️ `config.telegram.enabled` 是 `false`，所以 `tgSend` 會把**訊息全文印進 `srv.log`**
（`server.js:610`）—— harness 就是從那裡讀出來比對的，不需要真的 bot。

⚠️ **每次重跑前要 `node make-fixture.js` 重做 fixture ＋ 重開 server**。
fixture 是有狀態的（`wishLog` 會累加），跑第二次 A5「從 0 變 1」一定紅。
⛔ 也不要用 `| head` 接它 —— SIGPIPE 會把 harness 從中間砍掉，看起來像全過。

## fixture 裡那六張單各驗什麼

| id | 用來驗 |
| --- | --- |
| `t001` | 正常路徑：改、擋別人、硬限制、清空 |
| `t002` | v4 之前沒有 `requesterId` 的舊單 ⇒ 誰都改不了 |
| `t003` | 已完成的單不能改 |
| `t004` | 自己提自己做 |
| `t005` | 無主單（提出者是誰才是關鍵，跟有沒有負責人無關）|
| `t006` | **磁碟上就少了 `wishLog`** ⇒ 驗讀檔邊界會不會補形狀 |

## 寫這類 harness 踩過的坑（⛔ 不要再踩一次）

- **POST 之後不要立刻 `readFileSync`** —— 會跟 server 的 `renameSync` 在 Windows 上撞出
  `EPERM: rename 'data.json.tmp' -> 'data.json'`，讓那次 POST 回 500。要 pause ＋ retry
  （`verify-wish.js` 的 `onDisk()` 就是為這個寫的）。
- **拿 pristine fixture 當基準去比對「有沒有副作用」會誤判** —— `server.js:352` 的
  `setImmediate( refreshProjection( true ) )` 開機就會填滿所有 `projectedDue`。基準要在**開機後**取。
- **fixture 加了新 task 記得回頭改 id 集合的期望值**，否則會出現假紅。
- **登入是兩段式**：`POST /api/login {password}` 拿總管理者 token（`who === null`）→
  用它 `POST /api/set-password {who,newPassword}`，回來的 token 才綁那個人；
  之後可以直接 `POST /api/login {who,password}`。`newPassword` 至少 4 個字。
  ⛔ **絕對不要對正式資料夾跑 `set-password`** —— 會改掉本人真正的密碼。
- **sessions 是記憶體 `Map`** —— 副本重啟後所有 token 失效，要重新鑄。
- **SPA 的否定測試不要只換 hash** —— 不會重載，模組層級的變數（`catchUpKey` 之類）還留著，
  測試會因為錯的理由通過。要 `location.reload()`。
