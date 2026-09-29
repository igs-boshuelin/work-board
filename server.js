'use strict';

// 接單看板 —— 零依賴 Node HTTP 服務
//   /            公開看板：任何人可新增需求、留言、看進度
//   /api/*       JSON API；寫入排序/估時/完成日需要 admin token
//   TG bot       估時或預計完成日有異動時，batch 後推播到群組

const http = require( 'http' );
const https = require( 'https' );
const fs = require( 'fs' );
const path = require( 'path' );
const os = require( 'os' );
const crypto = require( 'crypto' );

const ROOT = __dirname;
const CONFIG_PATH = path.join( ROOT, 'config.json' );
const DATA_PATH = path.join( ROOT, 'data.json' );
const AUTH_PATH = path.join( ROOT, 'auth.json' );
const PUBLIC_DIR = path.join( ROOT, 'public' );

const STATUSES = [ 'inbox', 'todo', 'doing', 'done', 'parked' ];
const STATUS_LABEL = {
    inbox: '待評估',
    todo: '已排程',
    doing: '進行中',
    done: '已完成',
    parked: '擱置',
};
const STATUS_ICON = { inbox: '📥', todo: '🟡', doing: '🔵', done: '✅', parked: '⏸️' };

// ── config / data ────────────────────────────────────────────────────────────

// 記事本存 UTF-8 會加 BOM，JSON.parse 會直接炸在 position 0，訊息完全看不出原因
function readJson( file ) {
    const raw = fs.readFileSync( file, 'utf8' ).replace( /^﻿/, '' );
    try {
        return JSON.parse( raw );
    } catch ( e ) {
        console.error( `\n❌ ${ path.basename( file ) } 格式有問題：${ e.message }` );
        console.error( '   常見原因：少了逗號、多了逗號、引號沒成對。' );
        console.error( '   貼到 https://jsonlint.com 可以看出是哪一行。\n' );
        process.exit( 1 );
    }
}

const config = readJson( CONFIG_PATH );

// ── data ─────────────────────────────────────────────────────────────────────

let data;
if ( fs.existsSync( DATA_PATH ) ) {
    data = readJson( DATA_PATH );
} else {
    data = { tasks: [], seq: 0 };
}
// 每日排程快照： "YYYY-MM-DD" -> { 人員id -> plan model }
if ( !data.days ) data.days = {};
// 每人每天的「起排時間」： "YYYY-MM-DD" -> { 人員id -> { min, auto, by, at } }
// ⚠️ 每個人各自一份 —— 同事請假、遲到，他那天本來就不是從上班時間開始算。
// ⛔ 不要為了加這個欄位寫 v6 轉檔：跟 data.days 一樣，舊檔第一次跑就補成 {}。
if ( !data.dayStarts ) data.dayStarts = {};
// data.json 是程式寫的，但人也會去翻它 —— 這兩個是讀檔邊界，normalize 掉比較省事
if ( !Array.isArray( data.members ) ) data.members = [];
if ( !Array.isArray( data.tasks ) ) data.tasks = [];

function saveData() {
    const tmp = DATA_PATH + '.tmp';
    fs.writeFileSync( tmp, JSON.stringify( data, null, 2 ), 'utf8' );
    fs.renameSync( tmp, DATA_PATH );
}

// ── 資料版本 ─────────────────────────────────────────────────────────────────

// 改資料形狀時 +1，並在 migrate() 補一段一次性轉檔。有版號才知道哪些轉檔
// 已經跑過了；靠「看起來像舊格式嗎」猜，遲早會把新資料誤判成舊的再轉一次。
const DATA_VERSION = 5;

function migrate() {
    const from = data.v || 1;
    if ( from >= DATA_VERSION ) return;

    // 轉檔前先留一份原樣的。轉壞了才有得退，backup/ 的每日備份不一定涵蓋到今天。
    // 全新安裝沒有 data.json 可備份，那也沒什麼好退的。
    if ( fs.existsSync( DATA_PATH ) ) {
        const dir = path.join( ROOT, 'backup' );
        if ( !fs.existsSync( dir ) ) fs.mkdirSync( dir );
        const stamp = new Date().toISOString().slice( 0, 10 );
        fs.writeFileSync(
            path.join( dir, `data-before-v${ DATA_VERSION }-${ stamp }.json` ),
            JSON.stringify( data, null, 2 ), 'utf8' );
    }

    // ⚠️ v3 要先跑：下面 v1 → v2 補 owner 時就要用到 defaultOwner()，
    // 而 defaultOwner 是這一步才從 config 搬進 data 的。
    if ( from < 3 ) {
        data.members = Array.isArray( config.members ) ? config.members.map( m => ( {
            id: String( m.id ), name: String( m.name || m.id ), admin: !!m.admin,
        } ) ) : [];
        data.defaultOwner = config.defaultOwner || ( data.members[ 0 ] || {} ).id || '';
        if ( !data.members.some( m => m.id === data.defaultOwner ) ) {
            data.defaultOwner = ( data.members[ 0 ] || {} ).id || '';
        }
        console.log( `[migrate] v${ from } → v3：名冊搬進 data.json（${ data.members.length } 人），之後在網頁上加人就好` );
    }

    if ( from < 2 ) {
        let nTask = 0;
        for ( const t of data.tasks ) {
            if ( !t.owner ) { t.owner = defaultOwner(); nTask++; }
        }
        // 舊快照是 plan 直接攤在日期底下，新的多一層人員 id
        let nDay = 0;
        for ( const date of Object.keys( data.days ) ) {
            const day = data.days[ date ];
            if ( day && day.savedAt ) {
                data.days[ date ] = { [ defaultOwner() ]: day };
                nDay++;
            }
        }
        console.log( `[migrate] v1 → v2：${ nTask } 筆待辦補上 owner、${ nDay } 天的快照改成分人存` );
    }

    // v4：編導改成要有帳號（見 README §5）。這一步只補欄位，不擋任何既有資料。
    if ( from < 4 ) {
        // 既有名冊全是程式端；編導是之後才會加進來的，角色在網頁上選。
        let nRole = 0;
        for ( const m of data.members ) if ( !m.role ) { m.role = 'dev'; nRole++; }

        // requester 本來是編導自己打的字。現在改綁帳號，但舊單的字要留著 ——
        // ⛔ 對不上就留空，不要硬湊一個 id：那會把別人提的單算到某個人頭上，
        //    而且「我提的需求」跟訂閱都會跟著錯，沒有任何錯誤訊息會告訴你。
        let nHit = 0;
        const miss = [];
        for ( const t of data.tasks ) {
            if ( t.requesterId ) continue;
            const m = matchMemberLoose( t.requester );
            if ( m ) { t.requesterId = m.id; nHit++; continue; }
            t.requesterId = '';
            if ( t.requester && miss.indexOf( t.requester ) < 0 ) miss.push( t.requester );
        }
        // 舊的自由文字希望時程搬進說明，不要直接丟掉（見 README §2 的 wishDate）
        let nWish = 0;
        for ( const t of data.tasks ) {
            if ( t.wishDate === undefined ) {
                const iso = String( t.wish || '' ).match( /^\d{4}-\d{2}-\d{2}$/ );
                if ( iso ) { t.wishDate = t.wish; }
                else {
                    t.wishDate = '';
                    // 看不懂的（「這週內」「下次送審前」）搬進說明，⛔ 不要直接丟 ——
                    // 那是編導唯一講過「什麼時候要」的地方，丟掉沒有任何人會發現
                    if ( t.wish ) {
                        t.detail = ( t.detail ? t.detail + '\n\n' : '' ) + `（原本填的希望時程：${ t.wish }）`;
                        nWish++;
                    }
                }
                t.wishTime = '';
            }
            delete t.wish;
            // 剩餘時數那三個欄位一起補齊，之後讀 data.json 的人才不用分「舊單／新單」
            if ( t.estimate0 === undefined ) t.estimate0 = null;
            if ( t.spentMin === undefined ) t.spentMin = 0;
            if ( t.startedAt === undefined ) t.startedAt = '';
        }
        console.log( `[migrate] v${ from } → v4：${ nRole } 人補上角色、${ nHit } 筆需求對上帳號、${ nWish } 筆希望時程搬進說明` );
        if ( miss.length ) {
            console.log( `[migrate]   提出者對不上帳號的（原文字留著，只是不算在「我提的需求」裡）：${ miss.join( '、' ) }` );
        }
    }

    // v5：多記「這一輪做到幾點」。以前離開「進行中」時 startedAt 就被清掉了，
    // 被插件的單在時間表上會整段消失、後面全部往前塌（README §3 的那個病）。
    if ( from < 5 ) {
        let n = 0;
        for ( const t of data.tasks ) if ( t.spans === undefined ) { t.spans = []; n++; }
        console.log( `[migrate] v${ from } → v5：${ n } 筆補上 spans（今天做到幾點的區間）` );
    }

    data.v = DATA_VERSION;
    saveData();
}
migrate();

// ── 讀檔邊界：把單的形狀補齊 ─────────────────────────────────────────────────

// migrate() 只在版號落後時跑一次，⛔ 之後手改 data.json 加進來的單它不會回頭看
// —— 而 HANDOFF 本來就會叫人關掉服務手改這個檔（補 requesterId 之類）。
// 複製一張舊單、或從備份貼一筆回來，少掉 spans / comments 的話：前端的
// `for ( const sp of t.spans )` 會丟 TypeError，從 renderToday 一路炸上去，
// **整張看板打不開**（只剩一個 toast）。2026-09-17 實測過。
// ✅ 正解是在入口把形狀統一，⛔ 不是在每個讀取點各補一次 `|| []`。
// ⚠️ 只補「形狀」，不猜內容：缺 order 補成排在最後，缺陣列補成空的，其他一律不動。
// 只改記憶體裡的，不寫回檔案 —— 順手改人家的檔沒人會預期，而且每次啟動都補是冪等的。
( () => {
    const fixed = [];
    let maxOrder = data.tasks.reduce( ( m, t ) => Math.max( m, Number( t.order ) || 0 ), 0 );
    for ( const t of data.tasks ) {
        const miss = [];
        // 前端無條件迭代這兩個（for...of / .length / .map），不是陣列就會炸
        if ( !Array.isArray( t.spans ) ) { t.spans = []; miss.push( 'spans' ); }
        if ( !Array.isArray( t.comments ) ) { t.comments = []; miss.push( 'comments' ); }
        if ( !Array.isArray( t.wishLog ) ) { t.wishLog = []; miss.push( 'wishLog' ); }
        // order 不是數字的話 NaN 會傳染：排序亂掉，而且新單的 maxOrder + 10 也變 NaN
        if ( !Number.isFinite( t.order ) ) { t.order = ( maxOrder += 10 ); miss.push( 'order' ); }
        if ( miss.length ) fixed.push( `${ t.id }（${ miss.join( '、' ) }）` );
    }
    if ( fixed.length ) {
        console.log( `⚠  data.json 有 ${ fixed.length } 筆單少了欄位，已在記憶體裡補成空值：${ fixed.join( '、' ) }` );
        console.log( '   手改過 data.json 的話，照著既有的單把欄位補齊比較保險（檔案本身沒有被改動）。' );
    }

    // ⭐ P4 的舊帳：v5.4 之前「直接改估時」不會動 estimate0 / spentMin，所以既有的單
    //    可能留著「原估 ≠ 已做 ＋ 剩」的紀錄（實際踩到的是 t0017：原估 2h・已做 3h・剩 2h）。
    //    PATCH 那邊只會在**下一次動到估時**才補平 ⇒ 沒人再碰的單會一直錯，而 README §7
    //    現在寫的是「這三個數字永遠加得起來」。所以開機時把舊帳補平。
    // ⚠️ 補的是「原估」，⛔ 不動 spentMin（那是後端算出來的真實工時）。
    // ⚠️ 補完就對得起來 ⇒ 下次開機是 no-op（冪等）。跟上面一樣只改記憶體，
    //    ⛔ 不主動寫檔；之後任何一次正常寫入才會把它存下去。
    const healed = [];
    for ( const t of data.tasks ) {
        if ( t.estimate0 === null || t.estimate0 === undefined ) continue;
        const want = ( ( t.spentMin || 0 ) + Math.round( ( t.estimate || 0 ) * 60 ) ) / 60;
        if ( Math.abs( t.estimate0 - want ) < 1e-9 ) continue;
        healed.push( `${ t.id }（原估 ${ fmtHours( t.estimate0 ) } → ${ fmtHours( want ) }）` );
        t.estimate0 = want;
    }
    if ( healed.length ) {
        console.log( `⚠  有 ${ healed.length } 筆單的「原估 ＝ 已做 ＋ 剩」對不起來（v5.4 之前手改估時留下的），` );
        console.log( `   已經把原估補成「已做 ＋ 剩」：${ healed.join( '、' ) }` );
    }
} )();

// ── 人員名冊 ─────────────────────────────────────────────────────────────────

// 名冊住在 data.json，不在 config.json —— 它跟 tasks[].owner 是同一組 id，
// 分兩個檔遲早會對不起來；而且 config.json 是你手改的，程式再去寫它，
// 你改到一半就會被下一次寫入蓋掉（auth.json 那個已知的坑）。
// config.members 只剩「第一次啟動的種子」，之後改它不會有任何作用。
if ( !data.members.length ) {
    console.error( '\n❌ 名冊是空的，至少要有一個人。' );
    console.error( '   第一次啟動請在 config.json 放： "members": [ { "id": "boshue", "name": "柏學" } ]' );
    console.error( '   已經跑過的話，名冊在 data.json 的 members。\n' );
    process.exit( 1 );
}

function findMember( id ) { return data.members.find( m => m.id === id ) || null; }
function isMember( id ) { return !!id && !!findMember( id ); }
function memberName( id ) {
    const m = findMember( id );
    return m ? m.name : id;
}

// 角色：dev＝做事的（會被指派、有排程頁），director＝編導（只提需求、不排程）。
// 沒寫 role 的一律當 dev —— v4 之前的名冊就是這樣。
const ROLES = [ 'dev', 'director' ];
function roleOf( id ) {
    const m = findMember( id );
    return m && m.role === 'director' ? 'director' : 'dev';
}
function isDev( id ) { return isMember( id ) && roleOf( id ) === 'dev'; }

// 用一段文字去猜是哪個人員（比 id 也比顯示名稱，不分大小寫）。
// ⛔ 只給轉檔與相容路徑用，正常流程一律吃 id —— 名字會重複、會改，猜錯不會有人發現。
function matchMemberLoose( text ) {
    const s = String( text || '' ).trim().toLowerCase();
    if ( !s ) return null;
    return data.members.find( m =>
        m.id.toLowerCase() === s || String( m.name ).toLowerCase() === s ) || null;
}

// 沒指定 owner 時算誰的。名冊會變，所以每次現查，不要抓成常數。
// ⚠️ 只在 dev 裡面挑 —— 編導不做單，落到編導頭上的話那張單在人員頁上根本沒有入口。
function defaultOwner() {
    if ( isDev( data.defaultOwner ) ) return data.defaultOwner;
    const m = data.members.find( x => roleOf( x.id ) === 'dev' );
    return m ? m.id : '';
}

// 日期與時刻都是從公開表單收進來的，⛔ 不要直接存 —— 對不上格式就當沒填。
// 存進去的爛字串不會當場報錯，是幾天後排程算不出來才會冒出來。
function normDate( v ) {
    const s = String( v || '' ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test( s ) ? s : '';
}
function normTime( v ) {
    const s = String( v || '' ).trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test( s ) ? s : '';
}

// 估時 / 剩餘時數的輸入。內部一律存小時數（3、1.5），但只吃小時數的話
// 「還要 20 分鐘」得自己換算成 0.33 —— 那是使用者實際抱怨的點。四種寫法都收：
//   1.5 / .5      純數字＝小時
//   1h30m / 1h30 / 1.5h
//   90m / 90分     分鐘
//   1:30 / :30    時:分
// 回傳對齊到整分鐘的小時數；看不懂的回 null。
// ⚠️ 看不懂回 null 而不是 0 —— 呼叫端要分得出「清掉估時」跟「打錯字」。
function parseHours( v ) {
    if ( typeof v === 'number' ) return isFinite( v ) && v >= 0 ? Math.round( v * 60 ) / 60 : null;
    const s = String( v == null ? '' : v ).trim().toLowerCase().replace( /\s+/g, '' )
        .replace( /小時/g, 'h' ).replace( /時/g, 'h' )
        .replace( /分鐘/g, 'm' ).replace( /分/g, 'm' );
    if ( !s ) return null;

    let m;
    if ( ( m = s.match( /^(\d*):([0-5]?\d)$/ ) ) ) {
        return ( Number( m[ 1 ] || 0 ) * 60 + Number( m[ 2 ] ) ) / 60;
    }
    if ( ( m = s.match( /^(\d+(?:\.\d+)?)h(?:(\d+)m?)?$/ ) ) ) {
        return Math.round( Number( m[ 1 ] ) * 60 + Number( m[ 2 ] || 0 ) ) / 60;
    }
    if ( ( m = s.match( /^(\d+(?:\.\d+)?)m$/ ) ) ) return Math.round( Number( m[ 1 ] ) ) / 60;
    if ( /^\d*\.?\d+$/.test( s ) ) return Math.round( Number( s ) * 60 ) / 60;
    return null;
}

// 小時數印成人看得懂的長度：1.3333 → 1h20m。
// ⛔ 不要改回印小數 ——「剩 1.33h」正是使用者說看不懂的那個東西。
function fmtHours( h ) {
    const min = Math.round( ( h || 0 ) * 60 );
    if ( min <= 0 ) return '0m';
    const hh = Math.floor( min / 60 );
    const mm = min % 60;
    return hh && mm ? `${ hh }h${ mm }m` : hh ? `${ hh }h` : `${ mm }m`;
}

// PATCH / POST body 裡的 estimate。空字串與 null ＝明確要清掉估時，
// 看不懂的字串回 undefined。⚠️ 兩者不能混：清掉是合法操作，打錯字要回 400。
const EST_HINT = '估時看不懂，可以填 1.5、1h30m、90m 或 1:30';
// 估時上限。≈ 半年的全職工時 —— 比這個大的一定是多打了幾位數。
// ⚠️ 這不只是「擋髒資料」：一個人 doing＋todo 的估時總和超過約 4.7 萬小時，
//    完成日推估的 guard 就會翻臉（見 projectQueue），2026-09-17 實測過。
//    上限存在的意義是讓打錯的人當場看到 400，⛔ 不要等到推估算不出來才發現。
const EST_MAX_H = 1000;
function bodyEstimate( v ) {
    if ( v === null || v === undefined || v === '' ) return null;
    const h = parseHours( v );
    return h === null ? undefined : h;
}

// 給人看的 owner 名稱。空字串是「還不確定找誰」的無主狀態，直接吐空字串的話
// 推播會變成「負責人 → 」，看不出發生了什麼事。
function ownerLabel( id ) {
    return id ? memberName( id ) : '還沒指定';
}

// 查詢字串的 ?owner=，沒帶或帶了不存在的人就當成預設那個人。
function ownerParam( query ) {
    const v = query && query.get( 'owner' );
    return isDev( v ) ? v : defaultOwner();
}

// 啟動時先把推估補齊，但不通知 —— 跨了一天本來就會位移，那不是誰改了什麼
setImmediate( () => refreshProjection( true ) );

// 每天留一份備份，改壞了可以退回去
function backupData() {
    const dir = path.join( ROOT, 'backup' );
    if ( !fs.existsSync( dir ) ) fs.mkdirSync( dir );
    const stamp = new Date().toISOString().slice( 0, 10 );
    const dest = path.join( dir, `data-${ stamp }.json` );
    if ( !fs.existsSync( dest ) && fs.existsSync( DATA_PATH ) ) {
        fs.copyFileSync( DATA_PATH, dest );
    }
}

// ── 密碼 ─────────────────────────────────────────────────────────────────────

// auth.json 由程式自己寫，⛔ 不要手改 —— 你改到一半會被下一次寫入蓋掉，而且沒有錯誤訊息。
// 裡面是各人員的密碼雜湊，所以這個檔不要丟進備份群組、不要跟人分享。
let auth;
if ( fs.existsSync( AUTH_PATH ) ) {
    auth = readJson( AUTH_PATH );
} else {
    auth = { v: 1, members: {}, subscribers: {} };
}
if ( !auth.members ) auth.members = {};
if ( !auth.subscribers ) auth.subscribers = {};
if ( !auth.setup ) auth.setup = {};   // 人員 id -> 還沒用掉的起始碼

// 訂閱本來是「自己打一個名字」，v2 起改成綁帳號。
// ⚠️ 這段不能塞進 migrate()：那支在 auth.json 載進來之前就跑完了。
if ( ( auth.v || 1 ) < 2 ) {
    const next = {};
    const orphan = [];
    for ( const [ key, sub ] of Object.entries( auth.subscribers ) ) {
        const m = matchMemberLoose( sub.memberId || sub.label );
        // ⛔ 對不上名冊的原樣留著，不要丟 —— 推播是走 Object.values() 的，留著他照樣收得到；
        //    丟掉的話他只會發現「某天起就沒訊息了」，而且沒有任何地方查得出原因。
        if ( !m ) { next[ key ] = sub; orphan.push( sub.label ); continue; }
        sub.memberId = m.id;
        sub.label = m.name;
        // 舊的範圍寫的是打的字（requester:BoShue），新的單存的是 id。
        // 不換掉的話他會從「訂閱生效」變成「靜靜地再也收不到自己的單」。
        sub.scopes = ( sub.scopes || [] ).map( s =>
            s.indexOf( 'requester:' ) === 0 ? `requester:${ m.id }` : s );
        next[ m.id ] = sub;   // 鍵從 sha1(名字) 換成人員 id
    }
    auth.subscribers = next;
    auth.v = 2;
    saveAuth();
    if ( orphan.length ) {
        console.log( `[migrate] 這些訂閱者對不上名冊，通知照發但網頁上改不到，要請他們重訂一次：${ orphan.join( '、' ) }` );
    }
}

function saveAuth() {
    const tmp = AUTH_PATH + '.tmp';
    fs.writeFileSync( tmp, JSON.stringify( auth, null, 2 ), 'utf8' );
    fs.renameSync( tmp, AUTH_PATH );
}

// scrypt 是 Node 內建的，不用裝東西。用非同步版本，免得登入時卡住整個 event loop
// （scrypt 故意設計成慢，同步版會讓所有人的請求一起等）。
function scryptHash( password, salt ) {
    return new Promise( ( resolve, reject ) => {
        crypto.scrypt( password, salt, 64, ( e, key ) => e ? reject( e ) : resolve( key ) );
    } );
}

async function setPassword( id, password ) {
    const salt = crypto.randomBytes( 16 ).toString( 'hex' );
    const key = await scryptHash( password, salt );
    auth.members[ id ] = { salt, hash: key.toString( 'hex' ), setAt: nowISO() };
    // 密碼一旦存在，還沒用掉的起始碼就沒有意義了 —— 留著等於多開一道進得去的門。
    // 放在這裡而不是各個呼叫點，是因為「有密碼 ⇒ 沒有效起始碼」是資料的不變條件，
    // 漏掉任何一個呼叫點都會破壞它。
    delete auth.setup[ id ];
    saveAuth();
}

async function checkPassword( id, password ) {
    const rec = auth.members[ id ];
    if ( !rec ) return false;
    const key = await scryptHash( password, rec.salt );
    const stored = Buffer.from( rec.hash, 'hex' );
    // 長度不同時 timingSafeEqual 會直接丟例外，要先擋掉
    if ( stored.length !== key.length ) return false;
    return crypto.timingSafeEqual( stored, key );
}

function hasPassword( id ) { return !!auth.members[ id ]; }

// ── 起始碼 ───────────────────────────────────────────────────────────────────

// 新人員第一次設密碼要有一組管理者發的起始碼。沒有這道手續的話，
// 「還沒設過密碼的人任何人都能幫他設」—— 名冊裡有 admin 的人時，
// 那等於任何連得進內網的人都拿得到全權。
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 碼是當面 / 私訊給的，可能隔幾天才用
const SETUP_MAX_TRIES = 10;                     // 六碼只有 32^6，猜得到；試錯要有上限

// 去掉 0/O/1/I，這組碼是要用手打的
function newCode( n ) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for ( let i = 0; i < n; i++ ) s += abc[ crypto.randomInt( abc.length ) ];
    return s;
}

// 起始碼也用 scrypt 存。存明文的話 auth.json 外流就等於所有待設定的人都被接管了，
// 而且那個檔本來就有大家的 TG chat id，不該再多一項。
async function issueSetupCode( id, by ) {
    const code = newCode( 6 );
    const salt = crypto.randomBytes( 16 ).toString( 'hex' );
    const key = await scryptHash( code, salt );
    auth.setup[ id ] = {
        salt, hash: key.toString( 'hex' ),
        expiresAt: Date.now() + SETUP_TTL_MS,
        tries: 0, by, createdAt: nowISO(),
    };
    saveAuth();
    return code;
}

function setupCodeInfo( id ) {
    const rec = auth.setup[ id ];
    if ( !rec ) return null;
    if ( rec.expiresAt < Date.now() ) { delete auth.setup[ id ]; saveAuth(); return null; }
    return { expiresAt: rec.expiresAt, tries: rec.tries, left: SETUP_MAX_TRIES - rec.tries };
}

// 對一次就用掉。回傳 { ok } 或 { ok:false, error }
async function useSetupCode( id, code ) {
    const rec = auth.setup[ id ];
    if ( !rec ) return { ok: false, error: '還沒有人幫你發起始碼，找管理者要一組' };
    if ( rec.expiresAt < Date.now() ) {
        delete auth.setup[ id ]; saveAuth();
        return { ok: false, error: '起始碼過期了，請管理者重發一組' };
    }

    const key = await scryptHash( String( code ).trim().toUpperCase(), rec.salt );
    const stored = Buffer.from( rec.hash, 'hex' );
    // 長度不同時 timingSafeEqual 會直接丟例外，要先擋掉
    const ok = stored.length === key.length && crypto.timingSafeEqual( stored, key );
    if ( ok ) return { ok: true };   // 真正刪掉是在 setPassword 裡，成功才算用掉

    rec.tries += 1;
    const left = SETUP_MAX_TRIES - rec.tries;
    if ( left <= 0 ) {
        delete auth.setup[ id ]; saveAuth();
        console.log( `[auth] ${ memberName( id ) } 的起始碼試錯太多次，已作廢` );
        return { ok: false, error: '試錯太多次，這組碼作廢了，請管理者重發' };
    }
    saveAuth();
    return { ok: false, error: `起始碼不對（還可以試 ${ left } 次）` };
}

// ── session ──────────────────────────────────────────────────────────────────

// token -> { who, admin }
//   who   人員 id；用 config.adminPassword 進來的總管理者是 null（不綁定某個人）
//   admin true 代表可以改所有人的，false 只能改自己 owner 的
// 存在記憶體裡，所以重啟就全部失效 —— 密碼本身不會離開這支程式。
const sessions = new Map();

function session( req ) {
    const t = req.headers[ 'x-admin-token' ];
    return typeof t === 'string' ? sessions.get( t ) || null : null;
}

function newSession( who, admin ) {
    const token = crypto.randomBytes( 24 ).toString( 'hex' );
    sessions.set( token, { who, admin } );
    return token;
}

// 改密碼時把那個人其他還開著的 session 踢掉
function dropSessionsOf( who ) {
    for ( const [ t, s ] of sessions ) if ( s.who === who ) sessions.delete( t );
}

// 全權：可以改所有人的單、推播、存別人的排程
function isAdmin( req ) {
    const s = session( req );
    return !!s && s.admin;
}

// 這一筆改不改得動
function canEdit( req, task ) {
    const s = session( req );
    if ( !s ) return false;
    // owner 空字串＝「還不確定找誰」，是無主的。誰都能接走，不用等管理者轉派 ——
    // 這跟從別人手上搶單是兩回事，那個仍然只有管理者能做（canEdit 對有主的只認本人）。
    if ( !task.owner ) return true;
    return s.admin || task.owner === s.who;
}

// 排程與評估（排序、估時、預計完成日、狀態）只有本人能動 —— 管理者也不行。
// 別人的順序排不排得下、一張單要做多久，只有他自己知道；管理者要保證的是
// 「單子有人負責、內容正確」，不是替他決定怎麼做。
// 管理者仍然做得到的：轉派、改文字、刪除（那些走 canEdit）。
// 無主的單還是誰都能排 —— 它還沒有「本人」。
function canSchedule( req, task ) {
    const s = session( req );
    if ( !s ) return false;
    if ( !task.owner ) return true;
    return task.owner === s.who;
}

// 「希望完成」只有提出需求的本人能改（負責人與總管理者都不行，2026-09-18 裁定）——
// 那是編導對自己需求的宣告，不是排程。⇒ 它不走 canEdit，見 PATCH /api/tasks/:id/wish。
// ⚠️ 嚴格比 requesterId，⛔ 不用 matchMemberLoose 退回比名字 —— 這是寫入權限，
//    名字會重複、會改，猜錯不會有人發現。⇒ v4 之前沒有 requesterId 的舊單沒有「本人」，
//    那幾張的希望時間誰都改不了（刻意的；要改就先手動補 requesterId，見 HANDOFF）。
function isRequester( req, task ) {
    const s = session( req );
    // 用 config.adminPassword 進來的總管理者 who 是 null —— 他不是任何人的提出者
    if ( !s || !s.who ) return false;
    return !!task.requesterId && task.requesterId === s.who;
}

// ── Telegram ─────────────────────────────────────────────────────────────────

// Telegram API 呼叫。回傳 Promise，失敗時 resolve 成 null 而不是丟出去 ——
// 推播失敗不該讓一次編輯跟著失敗，這是外部服務邊界。
function tgApi( method, payload ) {
    return new Promise( resolve => {
        const tg = config.telegram;
        if ( !tg.enabled || !tg.botToken ) return resolve( null );
        const body = JSON.stringify( payload );
        const req = https.request( {
            hostname: 'api.telegram.org',
            path: `/bot${ tg.botToken }/${ method }`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength( body ) },
            timeout: 65000,   // getUpdates 會掛著等，要比它的 timeout 長
        }, res => {
            let buf = '';
            res.on( 'data', c => buf += c );
            res.on( 'end', () => {
                let j = null;
                try { j = JSON.parse( buf ); } catch ( e ) { /* 下面統一當失敗處理 */ }
                if ( !j || !j.ok ) {
                    console.error( `[tg] ${ method } 失敗`, res.statusCode, buf.slice( 0, 200 ) );
                    return resolve( null );
                }
                resolve( j.result );
            } );
        } );
        req.on( 'error', e => { console.error( `[tg] ${ method } 連線錯誤`, e.message ); resolve( null ); } );
        req.on( 'timeout', () => { req.destroy(); resolve( null ); } );
        req.end( body );
    } );
}

// chatId 不給就送群組。給了就是私訊某個人。
async function tgSend( text, chatId ) {
    const tg = config.telegram;
    const target = chatId || tg.chatId;
    if ( !tg.enabled || !tg.botToken || !target ) {
        console.log( '[tg] 未啟用，略過推播\n' + text );
        return false;
    }
    const r = await tgApi( 'sendMessage', {
        chat_id: target,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    } );
    if ( r ) console.log( `[tg] 已送出 → ${ chatId ? '私訊 ' + chatId : '群組' }` );
    return !!r;
}

// ── TG 綁定 ──────────────────────────────────────────────────────────────────

// bot 沒辦法主動私訊一個從沒跟它講過話的人 —— 這是 Telegram 的硬限制。
// 所以流程只能反過來：網頁產生一組碼，本人私訊 bot 把碼送過來，我們才拿得到他的 chat id。
// 待綁定的碼只放記憶體：重啟就失效是對的，一組碼本來就不該長命。
const pendingBinds = new Map();   // code -> { who, label, scopes, tagInGroup, expiresAt, done }
const BIND_TTL_MS = 15 * 60 * 1000;

let botUsername = '';   // 給網頁組 t.me 連結用

// 這組碼是要用手打進 TG 的，所以跟起始碼用同一套沒有 0/O/1/I 的字母表
function newBindCode() { return newCode( 6 ); }

function sweepBinds() {
    const now = Date.now();
    for ( const [ code, b ] of pendingBinds ) if ( b.expiresAt < now ) pendingBinds.delete( code );
}

// v4 起訂閱是綁帳號的，所以鍵就是人員 id —— 不用再從打的字去雜湊。
// （v4 之前的舊記錄鍵是 sha1(label)，對不上名冊的那幾筆會原樣留著，見上面的 auth v2 轉檔。）

// 對上碼就把這個人記下來。同一個帳號重綁會蓋掉舊的（換手機、換 TG 帳號）。
function completeBind( code, from, chat ) {
    sweepBinds();
    const b = pendingBinds.get( code );
    if ( !b ) return null;
    pendingBinds.delete( code );

    const id = b.who;
    auth.subscribers[ id ] = {
        memberId: b.who,
        label: b.label,
        scopes: b.scopes,
        tagInGroup: !!b.tagInGroup,
        tgChatId: chat.id,
        tgUserId: from.id,
        tgUsername: from.username || '',
        tgName: [ from.first_name, from.last_name ].filter( Boolean ).join( ' ' ),
        boundAt: nowISO(),
    };
    saveAuth();
    b.done = id;
    console.log( `[tg] ${ b.label } 綁定成功（${ auth.subscribers[ id ].tgName }）` );
    return auth.subscribers[ id ];
}

// long polling。Telegram 會把連線掛著最多 50 秒，有訊息才回，所以這不是在狂打 API。
let tgOffset = 0;
let pollStop = false;

async function pollLoop() {
    if ( !config.telegram.enabled || !config.telegram.botToken ) return;

    const me = await tgApi( 'getMe', {} );
    if ( !me ) {
        console.error( '[tg] 取不到 bot 資訊，訂閱綁定停用（token 對嗎？）' );
        return;
    }
    botUsername = me.username || '';
    console.log( `[tg] 綁定服務已啟動 @${ botUsername }` );

    while ( !pollStop ) {
        const ups = await tgApi( 'getUpdates', { offset: tgOffset, timeout: 50 } );
        if ( !ups ) {
            // 連線壞掉時不要空轉打爆 API
            await new Promise( r => setTimeout( r, 5000 ) );
            continue;
        }
        for ( const u of ups ) {
            tgOffset = u.update_id + 1;
            const msg = u.message;
            if ( !msg || !msg.text || !msg.from || !msg.chat ) continue;
            // 只認私訊。群組裡喊綁定會把 chat id 存成群組，之後「私訊」會發到整群去。
            if ( msg.chat.type !== 'private' ) continue;

            const m = msg.text.trim().match( /^\/(?:start|bind)(?:@\S+)?\s+([A-Za-z0-9]{6})$/ );
            if ( !m ) {
                if ( /^\/(start|bind)\b/.test( msg.text ) ) {
                    await tgSend( '請從接單看板網頁點「訂閱通知」拿一組 6 碼，再送 <code>/bind 你的碼</code>。', msg.chat.id );
                }
                continue;
            }
            const sub = completeBind( m[ 1 ].toUpperCase(), msg.from, msg.chat );
            await tgSend( sub
                ? `✅ 訂閱完成，之後「${ esc( sub.label ) }」的需求有異動就會通知你。\n要取消請回網頁點「取消訂閱」。`
                : '這組碼不對或已經過期了，回網頁重新產生一組。', msg.chat.id );
        }
    }
}

function esc( s ) {
    return String( s == null ? '' : s ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
}

// 待推播的異動：taskId -> { task, fields: Map<欄位, { label, from, to }> }
let pendingChanges = new Map();
let notifyTimer = null;

// changes 是 [ { field, label, from, to } ]
// by ＝ 這次是誰動的（登入帳號 id，沒有就不填）。⭐ 只有「強制通知」那條路用得到：
//    自己開單給自己、自己把單撿到自己名下，不該再私訊自己一次。
// ⛔ 不要拿它去過濾一般訂閱 —— 訂閱範圍是他自己訂的，自己動了也照樣想收到。
function queueNotify( task, changes, by ) {
    const entry = pendingChanges.get( task.id ) || { task, fields: new Map() };
    entry.task = task;
    if ( by ) entry.by = by;
    for ( const c of changes ) {
        const prev = entry.fields.get( c.field );
        // 同一個欄位在彙整期間被改好幾次，只留「最初 → 最後」。
        // 不收斂的話，90 秒內拖兩次順序、改一次估時，訊息會變成一串中間狀態的流水帳。
        if ( prev ) prev.to = c.to;
        else entry.fields.set( c.field, { label: c.label, from: c.from, to: c.to } );
    }
    pendingChanges.set( task.id, entry );

    if ( notifyTimer ) clearTimeout( notifyTimer );
    notifyTimer = setTimeout( flushNotify, config.notifyDebounceMs );
}

// 新單進來。跟欄位異動走同一個彙整佇列，所以一次貼五張不會變成五則訊息。
// ⚠️ 這是「訂閱無主收件匣」有沒有用的關鍵：無主單不在任何人的看板上，
// 沒有這則通知的話，訂了也只會在「有人動它之後」才響 —— 那就太晚了。
function queueNew( task, by ) {
    const entry = pendingChanges.get( task.id ) || { task, fields: new Map() };
    entry.task = task;
    entry.isNew = true;
    if ( by ) entry.by = by;
    pendingChanges.set( task.id, entry );

    if ( notifyTimer ) clearTimeout( notifyTimer );
    notifyTimer = setTimeout( flushNotify, config.notifyDebounceMs );
}

function fmtDue( d ) {
    if ( !d ) return '未定';
    const [ , m, day ] = d.split( '-' );
    return `${ m }/${ day }`;
}

// 「希望完成」給人看的寫法。⚠️ TG 通知與系統留言都走這支 ⇒ 兩邊的字一定一致；
// 各自拼一次的話，對帳時會看不出「09/20」跟「09/20（當天內）」是不是同一件事。
function wishLabel( date, time ) {
    if ( !date ) return '未定';
    return fmtDue( date ) + ( time ? ` ${ time }` : '（當天內）' );
}

function buildScheduleBlock() {
    const lines = [];
    for ( const st of [ 'doing', 'todo', 'inbox' ] ) {
        const list = data.tasks
            .filter( t => t.status === st )
            .sort( ( a, b ) => a.order - b.order );
        if ( !list.length ) continue;
        lines.push( `${ STATUS_ICON[ st ] } <b>${ STATUS_LABEL[ st ] }</b>（${ list.length }）` );
        for ( const t of list.slice( 0, 12 ) ) {
            const proj = t.project ? `[${ esc( t.project ) }] ` : '';
            const due = t.due ? ` — 預計 ${ fmtDue( t.due ) }` : '';
            const est = t.estimate ? `（${ fmtHours( t.estimate ) }）` : '';
            lines.push( `  • ${ proj }${ esc( t.title ) }${ due }${ est }` );
        }
        if ( list.length > 12 ) lines.push( `  … 另外 ${ list.length - 12 } 項` );
        lines.push( '' );
    }
    return lines.join( '\n' ).trimEnd();
}

// 訂閱範圍。scope 長成 "requester:小明" / "owner:boshue" / "project:迦羅戰神500" / "all"。
// 名字本身可能含冒號，所以只切第一個。
function matchScope( scope, task ) {
    if ( scope === 'all' ) return true;
    const i = scope.indexOf( ':' );
    if ( i < 0 ) return false;
    const kind = scope.slice( 0, i );
    const val = scope.slice( i + 1 );
    // v4 起 requester 範圍存的是人員 id。⚠️ 也要比舊單的名字字串 ——
    // v4 之前的單沒有 requesterId，只認 id 的話那些單會從所有人的訂閱裡消失。
    if ( kind === 'requester' ) {
        return task.requesterId ? task.requesterId === val : task.requester === val;
    }
    if ( kind === 'owner' ) return task.owner === val;
    if ( kind === 'project' ) return task.project === val;
    return false;
}

function subMatches( sub, task ) {
    return ( sub.scopes || [] ).some( s => matchScope( s, task ) );
}

// scope 是瀏覽器送進來的，所以要擋。⚠️ v4 起 requester/owner 收的都是**人員 id**，
// 不是打的字 —— 不驗的話一個錯字會變成「訂閱看起來有生效、但永遠不會響」。
// 回傳 { ok, scopes } 或 { ok:false, error }。
function parseScopes( raw, me ) {
    if ( !Array.isArray( raw ) || !raw.length ) return { ok: true, scopes: [ `requester:${ me }` ] };
    if ( raw.length > 20 ) return { ok: false, error: '追蹤範圍最多 20 項' };

    const out = [];
    for ( const x of raw ) {
        const s = String( x ).trim();
        if ( s.length > 120 ) return { ok: false, error: '追蹤範圍的值太長' };
        if ( s === 'all' ) { if ( out.indexOf( s ) < 0 ) out.push( s ); continue; }
        const i = s.indexOf( ':' );
        const kind = i < 0 ? '' : s.slice( 0, i );
        // owner: 後面可以是空的 —— 那就是「還不確定找誰」的無主收件匣
        if ( [ 'requester', 'owner', 'project' ].indexOf( kind ) < 0 ) {
            return { ok: false, error: `看不懂的追蹤範圍：${ s }` };
        }
        if ( kind === 'owner' ) {
            const id = s.slice( i + 1 );
            if ( id && !isMember( id ) ) return { ok: false, error: '沒有這個人員' };
        }
        // requester 反過來不能空 —— 空的話 matchScope 會去比 task.requesterId === ''，
        // 那是「舊單對不上帳號」的標記，等於訂到一堆不相干的東西
        if ( kind === 'requester' ) {
            const id = s.slice( i + 1 );
            if ( !isMember( id ) ) return { ok: false, error: '沒有這個提出者' };
        }
        if ( out.indexOf( s ) < 0 ) out.push( s );
    }
    if ( !out.length ) return { ok: false, error: '至少要選一個追蹤範圍' };
    return { ok: true, scopes: out };
}

// ⭐ 強制通知（2026-09-18）：這兩件事**不看訂閱範圍**，只看「這張單是不是落在你頭上」——
//    ⒜ 新單直接指派給你 ⒝ 既有的單被改成指派給你。
// ⚠️ 「不管有沒有訂閱」在只走 TG 的前提下**只能做到這個程度**：
//    bot 沒辦法主動私訊一個從沒跟它講過話的人（Telegram 的硬限制，見 tgSend 上面那段），
//    所以「沒綁過 TG 的人」根本沒有送達位址 —— 綁過的才收得到，見 README §9。
// ⛔ 自己動的不通知自己（自己開單給自己、自己把無主單撿起來）。
function forcedFor( sub, e ) {
    if ( !e.task.owner || e.task.owner !== sub.memberId ) return false;
    if ( e.by && e.by === sub.memberId ) return false;
    return !!e.isNew || e.fields.has( 'owner' );
}

function changeLineOf( e, forced ) {
    const proj = e.task.project ? `[${ esc( e.task.project ) }] ` : '';
    const parts = [ ...e.fields.values() ].map( f => `${ f.label } ${ f.from } → <b>${ f.to }</b>` );
    // ⭐ 強制通知的那幾筆要標出來 —— 收到的人可能根本沒訂這個範圍，
    //    不標的話他會以為是自己訂錯了。
    const mark = forced ? '👤 ' : '';
    if ( !e.isNew ) return `• ${ mark }${ proj }<b>${ esc( e.task.title ) }</b>\n  ${ parts.join( '；' ) }`;

    // 新單沒有「從什麼變成什麼」可以講，改講誰提的、落到誰身上
    const who = e.task.owner
        ? `→ ${ esc( memberName( e.task.owner ) ) }`
        : '<b>⚠️ 還沒指定負責人</b>';
    const tail = parts.length ? `\n  ${ parts.join( '；' ) }` : '';
    return `• 🆕 ${ proj }<b>${ esc( e.task.title ) }</b>\n  ${ esc( e.task.requester ) } 提出　${ who }${ tail }`;
}

function flushNotify() {
    notifyTimer = null;
    if ( !pendingChanges.size ) return;

    const entries = [ ...pendingChanges.values() ];
    pendingChanges = new Map();

    // 改過去又改回來，等於什麼都沒發生 —— 這種不該發通知
    for ( const e of entries ) {
        for ( const [ k, f ] of e.fields ) if ( f.from === f.to ) e.fields.delete( k );
    }
    // 新單就算沒有欄位異動也要發 —— 它本身就是要通知的事
    const live = entries.filter( e => e.fields.size || e.isNew );
    if ( !live.length ) return;

    // 個人訂閱：每個人只收到跟自己有關的那幾筆
    // ⭐ 再加上「強制通知」的那幾筆（指派給你的新單／被改成指派給你）——
    //    那幾筆不看 scopes，⛔ 不要塞進 subMatches 裡面（那會把訂閱的語意弄髒）。
    for ( const sub of Object.values( auth.subscribers ) ) {
        if ( !sub.tgChatId ) continue;
        const forced = new Set( live.filter( e => forcedFor( sub, e ) ) );
        const mine = live.filter( e => forced.has( e ) || subMatches( sub, e.task ) );
        if ( !mine.length ) continue;
        const heading = mine.every( e => forced.has( e ) )
            ? `👤 <b>有項目指派給你</b>（${ mine.length } 項）`
            : mine.every( e => e.isNew )
                ? `🆕 <b>有新的需求</b>（${ mine.length } 項）`
                : `📌 <b>你追蹤的項目有異動</b>（${ mine.length } 項）`;
        tgSend( `${ heading }\n\n` + mine.map( e => changeLineOf( e, forced.has( e ) ) ).join( '\n' ), sub.tgChatId );
    }

    // 群組彙整預設關掉 —— 多人之後訊息量是人數的倍數，訂閱才是主要管道。
    // 想開回來：config.json 的 telegram.notifyGroup 設 true。
    if ( !config.telegram.notifyGroup ) return;

    const head = `📌 <b>工作排程更新</b>（${ live.length } 項異動）\n`;
    const changeLines = live.map( changeLineOf ).join( '\n' );
    tgSend( `${ head }\n${ changeLines }\n\n──────────\n${ buildScheduleBlock() }` );
}

// 在群組訊息尾巴 @ 一排人。用 tg://user?id= 而不是 @username ——
// 沒設公開 username 的人也 tag 得到。
function mentionLine( tasks ) {
    const hit = [];
    for ( const sub of Object.values( auth.subscribers ) ) {
        if ( !sub.tagInGroup || !sub.tgUserId ) continue;
        if ( !tasks.some( t => subMatches( sub, t ) ) ) continue;
        hit.push( `<a href="tg://user?id=${ sub.tgUserId }">${ esc( sub.tgName || sub.label ) }</a>` );
    }
    return hit.length ? `\n\n👀 ${ hit.join( '　' ) }` : '';
}

// ── 完成日推估 ───────────────────────────────────────────────────────────────

// 照「目前的順序 ＋ 估時」推算每一筆大概哪天做得完。
// 這跟 task.due 是兩回事：due 是我手動給的承諾，projectedDue 是目前排法推出來的後果。
// 以前順序一動，後面每一筆的實際完成時間都跟著位移，但編導完全看不到 —— 這支就是補那個洞。
// 只用正常工時推 —— 把加班當成常態去算，得到的日期是騙人的。

function hhmmToMin( s, where ) {
    const m = String( s ).match( /^(\d{1,2}):(\d{2})$/ );
    if ( !m ) {
        console.error( `\n❌ config.json 的 ${ where || 'workHours' } 格式不對：「${ s }」，要像 "09:00"\n` );
        process.exit( 1 );
    }
    return Number( m[ 1 ] ) * 60 + Number( m[ 2 ] );
}

const WORK = ( () => {
    const w = config.workHours || {};
    const pair = list => list.map( ( [ a, b ] ) => ( { start: hhmmToMin( a ), end: hhmmToMin( b ) } ) );
    return {
        normal: pair( w.normal || [ [ '09:00', '12:30' ], [ '13:30', '18:00' ] ] ),
        overtime: pair( w.overtime || [ [ '18:30', '22:00' ] ] ),
        workdays: w.workdays || [ 1, 2, 3, 4, 5 ],
    };
} )();

// 固定會議：每週某天的某個時段不能拿來做單。手改 config.json，程式不會去寫它。
// 不放 data.json 是因為沒有任何 UI 會改它 —— 跟 workHours 一樣屬於「環境設定」。
const MEETINGS = ( config.meetings || [] ).map( ( m, i ) => {
    const where = `config.json 的 meetings[${ i }]`;
    // config 是手改的邊界，這裡的檢查是給人看的錯誤訊息，不是內部防禦
    if ( !( m.weekday >= 0 && m.weekday <= 6 ) ) {
        console.error( `\n❌ ${ where } 的 weekday 要是 0–6（0 是週日，2 是週二）\n` +
            `   例：{ "title": "程式會議", "weekday": 2, "start": "16:00", "end": "17:00" }\n` );
        process.exit( 1 );
    }
    const start = hhmmToMin( m.start, `meetings[${ i }].start` );
    const end = hhmmToMin( m.end, `meetings[${ i }].end` );
    if ( end <= start ) {
        console.error( `\n❌ ${ where } 的 end 要比 start 晚\n` );
        process.exit( 1 );
    }
    // members 沒填＝全員都要開；填了就只有名單上的人被佔用
    return { title: String( m.title || '會議' ), weekday: m.weekday, start, end,
        members: Array.isArray( m.members ) ? m.members.slice() : null };
} );

function meetingsOn( date, who ) {
    return MEETINGS.filter( m => m.weekday === date.getDay()
        && ( !m.members || m.members.indexOf( who ) >= 0 ) );
}

// 當天真正能排單的時段＝正常工時挖掉會議
function freeBlocks( date, who ) {
    let out = WORK.normal.map( b => ( { start: b.start, end: b.end } ) );
    for ( const m of meetingsOn( date, who ) ) {
        const next = [];
        for ( const b of out ) {
            if ( m.end <= b.start || m.start >= b.end ) { next.push( b ); continue; }
            if ( b.start < m.start ) next.push( { start: b.start, end: m.start } );
            if ( m.end < b.end ) next.push( { start: m.end, end: b.end } );
        }
        out = next;
    }
    return out;
}

function ymdLocal( d ) {
    return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
}

// 一列佇列依序塞進工作日，回傳 taskId -> { date, min }
// ⭐ min ＝ 那天從午夜算起的第幾分鐘（＝做完的時刻）。v5.4 之前只回日期，
//    時刻算出來就被 ymdLocal 丟掉了；「快到預計完成時間」那個提醒要的就是它。
function projectQueue( queue, who ) {
    const out = new Map();
    const cur = new Date();
    let cursor = cur.getHours() * 60 + cur.getMinutes();
    let guard = 0;

    for ( const t of queue ) {
        let remain = Math.round( t.estimate * 60 );
        while ( remain > 0 ) {
            // 工時設成空的、每天都不上班、或會議把整天吃光，這個迴圈會永遠跑不完
            //  —— 卡住比報錯難查太多。⚠️ 一個人的估時總和太大（約 4.7 萬小時以上）
            //  也會撞到這裡，不是只有設定壞掉才會。
            // ⛔ 這個 throw 不可以逸出到 projectAll 外面 —— 理由見 projectAll 的註解。
            if ( ++guard > 20000 ) {
                throw new Error( '完成日推估跑不完：檢查 config.json 的 workHours 與 meetings，'
                    + '以及名下有沒有哪張單的估時多打了幾位數' );
            }
            const workday = WORK.workdays.indexOf( cur.getDay() ) >= 0;
            const blk = workday && freeBlocks( cur, who ).find( b => cursor < b.end );
            if ( !blk ) {
                cur.setDate( cur.getDate() + 1 );
                cursor = 0;
                continue;
            }
            const from = Math.max( cursor, blk.start );
            const use = Math.min( blk.end - from, remain );
            remain -= use;
            cursor = from + use;
        }
        out.set( t.id, { date: ymdLocal( cur ), min: cursor } );
    }
    return out;
}

// 推估算不出來時抱怨過的話。同一句不重印 —— 每次寫入都會重算，
// 不擋的話 console 會被洗掉，真正有用的那幾行就看不到了。
const projectionGripes = new Set();

// 某個人的推估算不出來時，印一段人看得懂的、⛔ 不要讓例外往上跑。
// 2026-09-17 實測：例外一路逸出的話，啟動時那支 setImmediate( refreshProjection )
// 沒有人接 → 整個 process exit 1 → 看板再也起不來，只能手改檔案救。
// 而且用 `啟動看板.bat` 雙擊時視窗一閃就關（見 HANDOFF §4），症狀跟「bat 行尾壞了」
// 長得一模一樣，會白查半天。
function gripeProjection( who, msg ) {
    const line = `${ memberName( who ) }：${ msg }`;
    if ( projectionGripes.has( line ) ) return;
    projectionGripes.add( line );
    console.error( `\n❌ 完成日推估算不出來 —— ${ line }` );
    console.error( '   其他人的推估照算，看板照開；修好之後重開服務（或再改一次任何一張單）就會重算。\n' );
}

function projectAll() {
    const out = new Map();
    // 每個人各自排各自的 —— 大家是平行在做，不該互相把對方往後推
    for ( const id of data.members.map( m => m.id ) ) {
        const queue = [];
        for ( const st of [ 'doing', 'todo' ] ) {
            queue.push( ...data.tasks
                .filter( t => t.owner === id && t.status === st && t.estimate > 0 )
                .sort( ( a, b ) => a.order - b.order ) );
        }
        // ⚠️ 一個人算不完只能影響他自己：他的單 projectedDue 會變空（前端就不顯示 ≈），
        //    ⛔ 不可以連帶把別人的推估一起弄掉，更不可以把整個服務弄死。
        try {
            for ( const [ k, v ] of projectQueue( queue, id ) ) out.set( k, v );
        } catch ( e ) {
            gripeProjection( id, e.message );
        }
    }
    return out;
}

// silent 用在啟動時：跨了一天本來就會位移，那不是誰改了什麼，不該通知
function refreshProjection( silent ) {
    const next = projectAll();
    let changed = 0;
    for ( const t of data.tasks ) {
        const end = next.get( t.id );
        // ⚠️ projectQueue 現在回的是 { date, min }；這裡只要日期（projectedDue 的語意沒變）
        const nv = end ? end.date : '';
        const old = t.projectedDue || '';
        if ( nv === old ) continue;
        t.projectedDue = nv;
        changed++;
        // 第一次算出來（old 是空的）不吵人；變成沒有了（做完、擱置、估時清掉）也不吵
        if ( !silent && old && nv ) {
            queueNotify( t, [ { field: 'projectedDue', label: '預估完成',
                from: fmtDue( old ), to: fmtDue( nv ) } ] );
        }
    }
    if ( changed ) saveData();
    return changed;
}


// ── 快到預計完成時間的提醒 ───────────────────────────────────────────────────

// 「還有半小時這張就該做完了」的提醒（2026-09-18 加的）。
// ⚠️ 看的是**排程推算出來的完成時刻**（分鐘級，projectQueue 的 cursor），
//    ⛔ 不是卡片上的 `due` —— due 只有日期沒有時刻，推不出「前半小時」。
// ⚠️ 也因此它**會漂**：別人插件、改估時、拖順序都會讓時刻前後移動。
//    去重那段的一小時容忍度就是在處理這件事。
const DUE_SOON_MIN = ( () => {
    if ( config.dueSoonMin === undefined ) return 30;
    const v = Number( config.dueSoonMin );
    if ( !Number.isInteger( v ) || v < 1 || v > 480 ) {
        console.error( `\n❌ config.json 的 dueSoonMin 要是 1–480 的整數（提前幾分鐘提醒），現在是「${ config.dueSoonMin }」\n` );
        process.exit( 1 );
    }
    return v;
} )();

// 現在是不是上班時間（只看正常工時，⛔ 不扣會議 —— 開會中也是上班，訊息照收）
function isWorkingAt( d ) {
    if ( WORK.workdays.indexOf( d.getDay() ) < 0 ) return false;
    const m = d.getHours() * 60 + d.getMinutes();
    return WORK.normal.some( b => m >= b.start && m < b.end );
}

function endKey( end ) {
    const hh = String( Math.floor( end.min / 60 ) ).padStart( 2, '0' );
    const mm = String( end.min % 60 ).padStart( 2, '0' );
    return `${ end.date }T${ hh }:${ mm }`;
}

function keyToDate( key ) {
    const [ d, t ] = key.split( 'T' );
    const [ y, mo, da ] = d.split( '-' ).map( Number );
    const [ h, mi ] = t.split( ':' ).map( Number );
    return new Date( y, mo - 1, da, h, mi, 0, 0 );
}

// 現在到那個時刻還有幾分鐘。⚠️ 是**牆鐘**分鐘，⛔ 不是工作分鐘 ——
// 中間夾到午休的話，「還有 30 分鐘」其實只剩十幾分鐘的工作時間。
function minutesUntil( key, now ) {
    return Math.round( ( keyToDate( key ) - now ) / 60000 );
}

// 每分鐘掃一次。⛔ 這裡**不呼叫 refreshProjection** —— 那支會寫檔、還會發
// 「預估完成 X → Y」的異動通知，每分鐘跑一次會把既有行為弄壞（時間流逝造成的
// 位移本來是等到有人寫入時才被算出來的）。這裡只自己算一份、只讀不寫。
function checkDueSoon() {
    const now = new Date();
    // 非工時不吵人。⚠️ 代價：通知時刻落在午休／下班時段的話會延到下一段工時
    //    一開始才響（那時距離完成可能已經不到半小時）—— 半夜響更糟，這是刻意的。
    if ( !isWorkingAt( now ) ) return;

    const ends = projectAll();
    let hit = 0;
    for ( const t of data.tasks ) {
        // 只有排程中的單有推估（projectAll 只收 doing / todo 且估時 > 0 的）
        if ( t.status !== 'doing' && t.status !== 'todo' ) continue;
        const end = ends.get( t.id );
        if ( !end ) continue;

        const key = endKey( end );
        const left = minutesUntil( key, now );
        if ( left < 0 || left > DUE_SOON_MIN ) continue;

        // 同一張單只響一次。⚠️ 但推估會漂 —— 差超過一小時就當成「另一次到期」可以再響。
        // ⛔ 不設這個容忍度的話，時刻漂一分鐘就再私訊一次，一路洗版。
        if ( t.dueNotified && Math.abs( minutesUntil( t.dueNotified, keyToDate( key ) ) ) <= 60 ) continue;

        // ⚠️ 沒綁過 TG 的人沒有送達位址（見 forcedFor 上面那段）—— 這裡只能跳過。
        const sub = auth.subscribers[ t.owner ];
        if ( !sub || !sub.tgChatId ) continue;

        const proj = t.project ? `[${ esc( t.project ) }] ` : '';
        const dueTail = t.due ? `\n  （你排的完成日 ${ fmtDue( t.due ) }）` : '';
        tgSend( `⏰ <b>快到預計完成時間了</b>\n\n• ${ proj }<b>${ esc( t.title ) }</b>\n`
            + `  預計 <b>${ key.slice( 11 ) }</b> 做完，還有 ${ left } 分鐘${ dueTail }`, sub.tgChatId );
        t.dueNotified = key;
        hit++;
        console.log( `[due] ${ t.id } ${ t.title } —— 預計 ${ key } 做完，提前 ${ left } 分鐘通知 ${ memberName( t.owner ) }` );
    }
    // 響過才寫檔：dueNotified 要存得住，不然重開服務會再響一次
    if ( hit ) saveData();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function newId() {
    data.seq += 1;
    return `t${ String( data.seq ).padStart( 4, '0' ) }`;
}

function nowISO() { return new Date().toISOString(); }

function findTask( id ) {
    return data.tasks.find( t => t.id === id );
}

function publicTask( t ) { return t; }

// ── CSV ─────────────────────────────────────────────────────────────────────

// 一律加引號，不逐種判斷 —— 欄位裡有逗號／引號／換行時都得包，與其逐種判斷不如全包。
// ⚠️ 引號只擋「欄位被切錯位」。開頭是 = + - @ 的字串，Excel 照樣會當公式去算
//    （加引號**沒有**用，要擋得在前面塞一個單引號）。這裡刻意不擋：
//    內部看板、填的人跟看的人是同一批，為了這個去改人家打的字不划算。見 README §8.5。
function csvCell( v ) {
    // 欄位裡的換行也一併轉成 CRLF（明細常常是多行的）。混著 LF 的話，
    // Excel 有些版本會把整格擠成一行看不出斷行。包在引號裡所以是合法的。
    const s = ( v === null || v === undefined ? '' : String( v ) ).replace( /\r\n|[\r\n]/g, '\r\n' );
    return '"' + s.replace( /"/g, '""' ) + '"';
}

// ISO（UTC）→ 本機 "YYYY-MM-DD HH:MM"。⛔ 不要直接吐 ISO —— 試算表裡差 8 小時，
//    而且「完成時間」差 8 小時剛好會跨日，跟排程表對不起來。
function csvTime( iso ) {
    if ( !iso ) return '';
    const d = new Date( iso );
    const p = n => String( n ).padStart( 2, '0' );
    return `${ d.getFullYear() }-${ p( d.getMonth() + 1 ) }-${ p( d.getDate() ) } `
        + `${ p( d.getHours() ) }:${ p( d.getMinutes() ) }`;
}

// 欄位順序＝匯出檔的欄位順序。⚠️ 有人拿去接別的表單之後，新欄位**往後加**，不要插中間。
const CSV_COLUMNS = [
    [ '單號', t => t.id ],
    [ '標題', t => t.title ],
    [ '專案', t => t.project ],
    [ '提出者', t => t.requester ],
    [ '負責人', t => t.owner ? memberName( t.owner ) : '' ],
    [ '狀態', t => STATUS_LABEL[ t.status ] || t.status ],
    [ '估時(h)', t => t.estimate === null || t.estimate === undefined ? '' : t.estimate ],
    [ '已花(h)', t => t.spentMin ? +( t.spentMin / 60 ).toFixed( 2 ) : '' ],
    [ '希望完成', t => t.wishDate ? t.wishDate + ( t.wishTime ? ' ' + t.wishTime : '' ) : '' ],
    [ '指定完成', t => t.due ],
    [ '推估完成', t => t.projectedDue ],
    [ '建立', t => csvTime( t.createdAt ) ],
    [ '完成', t => csvTime( t.doneAt ) ],
    [ '備註', t => t.note ],
    [ '明細', t => t.detail ],
    [ '留言數', t => ( t.comments || [] ).length ],
];

// 訂閱資料裡的 chat id / user id 不要吐給瀏覽器 —— 任何人都查得到這幾支端點
function publicSub( s ) {
    return {
        label: s.label, scopes: s.scopes, tagInGroup: !!s.tagInGroup,
        tgName: s.tgName, tgUsername: s.tgUsername, boundAt: s.boundAt,
    };
}

function send( res, code, obj ) {
    const body = JSON.stringify( obj );
    res.writeHead( code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    } );
    res.end( body );
}

function readBody( req ) {
    return new Promise( ( resolve, reject ) => {
        let buf = '';
        req.on( 'data', c => {
            buf += c;
            if ( buf.length > 1e6 ) reject( new Error( 'body too large' ) );
        } );
        req.on( 'end', () => {
            if ( !buf ) return resolve( {} );
            try { resolve( JSON.parse( buf ) ); }
            catch ( e ) { reject( new Error( 'invalid JSON body' ) ); }
        } );
        req.on( 'error', reject );
    } );
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function serveStatic( req, res, urlPath ) {
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    rel = decodeURIComponent( rel ).replace( /\\/g, '/' );
    const full = path.join( PUBLIC_DIR, path.normalize( rel ) );
    if ( !full.startsWith( PUBLIC_DIR ) ) { res.writeHead( 403 ); return res.end( 'forbidden' ); }
    fs.readFile( full, ( err, buf ) => {
        if ( err ) { res.writeHead( 404 ); return res.end( 'not found' ); }
        res.writeHead( 200, { 'Content-Type': MIME[ path.extname( full ) ] || 'application/octet-stream', 'Cache-Control': 'no-cache' } );
        res.end( buf );
    } );
}

// ── API ──────────────────────────────────────────────────────────────────────

async function handleApi( req, res, urlPath, query ) {
    const method = req.method;

    // 登入。帶 who 是人員登入，不帶就是用 config.adminPassword 的總管理者
    // （總管理者是後路：人員名冊或密碼弄壞時還進得去）。
    if ( urlPath === '/api/login' && method === 'POST' ) {
        const body = await readBody( req );
        const pw = String( body.password || '' );

        if ( !body.who ) {
            if ( pw !== config.adminPassword ) return send( res, 401, { error: '密碼不對' } );
            return send( res, 200, { token: newSession( null, true ), who: null, admin: true } );
        }

        const who = String( body.who );
        if ( !isMember( who ) ) return send( res, 400, { error: '沒有這個人員' } );
        if ( !hasPassword( who ) ) return send( res, 409, { error: '還沒設定密碼', needSetup: true } );
        if ( !await checkPassword( who, pw ) ) return send( res, 401, { error: '密碼不對' } );

        const m = findMember( who );
        return send( res, 200, { token: newSession( who, !!m.admin ), who, admin: !!m.admin } );
    }

    // ── 人員名冊（只有管理者能動） ──

    if ( urlPath === '/api/members' && method === 'POST' ) {
        if ( !isAdmin( req ) ) return send( res, 403, { error: '只有管理者能新增人員' } );
        const b = await readBody( req );
        const id = String( b.id || '' ).trim();
        const name = String( b.name || '' ).trim();

        if ( !name ) return send( res, 400, { error: '要填顯示名稱' } );
        // id 之後會變成 tasks[].owner 與 days[日期][人] 的鍵，所以只收保守的字元；
        // 中文可以放在 name，id 留給程式用就好。
        if ( !/^[A-Za-z0-9_-]{1,24}$/.test( id ) ) {
            return send( res, 400, { error: '代號只能用英數與 - _，最多 24 個字' } );
        }
        // 大小寫不同但長得一樣的兩個 id，之後沒有人分得出誰是誰
        if ( data.members.some( m => m.id.toLowerCase() === id.toLowerCase() ) ) {
            return send( res, 409, { error: `代號「${ id }」已經有人用了` } );
        }

        const role = ROLES.indexOf( b.role ) >= 0 ? b.role : 'dev';
        const m = { id, name, admin: !!b.admin, role };
        data.members.push( m );
        saveData();
        console.log( `[member] 新增 ${ name }（${ id }）${ role === 'director' ? '・編導' : '' }${ b.admin ? '・全權' : '' }` );
        return send( res, 200, { member: m } );
    }

    // 人員牆拖曳排序。送的是「全部人」的新順序（含編導），不是只送有動的那幾個 ——
    // 這樣伺服器只要確認名單剛好等於現有名冊，就不會有人因為前端漏送而被刪掉或重複。
    // ⚠️ 要放在 mMember 前面：/api/members/order 也吻合那個 regex。
    if ( urlPath === '/api/members/order' && method === 'POST' ) {
        if ( !isAdmin( req ) ) return send( res, 403, { error: '只有管理者能排人員順序' } );
        const b = await readBody( req );
        const ids = Array.isArray( b.ids ) ? b.ids.map( String ) : null;
        const same = ids && ids.length === data.members.length
            && new Set( ids ).size === ids.length
            && ids.every( id => isMember( id ) );
        // 名冊在別的視窗剛被改過（新增／移除）就會對不上 —— 叫他重新整理，不要猜著合併
        if ( !same ) return send( res, 409, { error: '人員名單剛被改過，請重新整理再拖一次' } );
        data.members = ids.map( id => findMember( id ) );
        saveData();
        return send( res, 200, { ok: true } );
    }

    const mMember = urlPath.match( /^\/api\/members\/([\w-]+)$/ );

    if ( mMember && method === 'PATCH' ) {
        if ( !isAdmin( req ) ) return send( res, 403, { error: '只有管理者能改人員' } );
        const m = findMember( mMember[ 1 ] );
        if ( !m ) return send( res, 404, { error: '沒有這個人員' } );
        const b = await readBody( req );

        // ⛔ id 不給改。它是 tasks[].owner 與 days[日期][人] 的鍵，改了等於
        // 把他名下的單全部變成孤兒，而且沒有任何錯誤訊息會告訴你。
        if ( 'name' in b ) {
            const name = String( b.name || '' ).trim();
            if ( !name ) return send( res, 400, { error: '名稱不能空白' } );
            m.name = name;
        }
        if ( 'admin' in b && !!b.admin !== !!m.admin ) {
            m.admin = !!b.admin;
            // 他現在開著的視窗權限是登入當下記下來的，不踢掉就會跟名冊對不起來
            dropSessionsOf( m.id );
        }
        if ( 'role' in b && ROLES.indexOf( b.role ) >= 0 && b.role !== roleOf( m.id ) ) {
            // 手上還有單的人不能改成編導 —— 編導不在人員頁上，那些單會變成沒有入口可以動
            if ( b.role === 'director' ) {
                const own = data.tasks.filter( t => t.owner === m.id );
                if ( own.length ) {
                    return send( res, 409, {
                        error: `${ m.name } 名下還有 ${ own.length } 筆，改成編導之前要先轉派掉`,
                    } );
                }
            }
            m.role = b.role;
            if ( data.defaultOwner === m.id && b.role === 'director' ) data.defaultOwner = defaultOwner();
        }
        saveData();
        return send( res, 200, { member: m } );
    }

    if ( mMember && method === 'DELETE' ) {
        if ( !isAdmin( req ) ) return send( res, 403, { error: '只有管理者能移除人員' } );
        const id = mMember[ 1 ];
        if ( !isMember( id ) ) return send( res, 404, { error: '沒有這個人員' } );
        // 移除＝連帳號一起刪，刪自己等於當場把自己鎖在外面（2026-09-29 知博就是這樣沒的）
        if ( session( req ).who === id ) return send( res, 409, { error: '不能移除自己，請另一位管理者來移除' } );
        if ( data.members.length <= 1 ) return send( res, 409, { error: '至少要留一個人' } );

        // 名下還有單就不給移除。直接刪掉的話那些單會指向一個不存在的人：
        // 人員頁看不到、推估不會算、誰都編輯不了 —— 而且完全不會報錯。
        const own = data.tasks.filter( t => t.owner === id );
        if ( own.length ) {
            return send( res, 409, {
                error: `${ memberName( id ) } 名下還有 ${ own.length } 筆，請先轉派或刪掉再移除`,
            } );
        }

        const name = memberName( id );
        data.members = data.members.filter( x => x.id !== id );
        // 他的排程快照留著也沒有入口看得到，而且同名 id 再建回來會「復活」成他的
        for ( const date of Object.keys( data.days ) ) {
            delete data.days[ date ][ id ];
            if ( !Object.keys( data.days[ date ] ).length ) delete data.days[ date ];
        }
        // 起排同理 —— ⛔ 漏了這段，同名 id 建回來會撿到前一個人的起排
        for ( const date of Object.keys( data.dayStarts ) ) {
            delete data.dayStarts[ date ][ id ];
            if ( !Object.keys( data.dayStarts[ date ] ).length ) delete data.dayStarts[ date ];
        }
        if ( data.defaultOwner === id ) data.defaultOwner = data.members[ 0 ].id;
        saveData();

        delete auth.members[ id ];
        delete auth.setup[ id ];
        saveAuth();
        dropSessionsOf( id );

        console.log( `[member] 移除 ${ name }（${ id }）` );
        return send( res, 200, { ok: true } );
    }

    // 管理者幫某個還沒設密碼的人發一組起始碼。碼只在這個回應裡出現一次，
    // 之後 auth.json 裡只剩雜湊 —— 忘了就重發一組，沒有「再看一次」。
    if ( urlPath === '/api/setup-code' && method === 'POST' ) {
        if ( !isAdmin( req ) ) return send( res, 403, { error: '只有管理者能發起始碼' } );
        const body = await readBody( req );
        const who = String( body.who || '' );
        if ( !isMember( who ) ) return send( res, 400, { error: '沒有這個人員' } );

        if ( body.revoke ) {
            delete auth.setup[ who ];
            saveAuth();
            console.log( `[auth] 收回了 ${ memberName( who ) } 的起始碼` );
            return send( res, 200, { ok: true } );
        }

        // 已經有密碼的人不需要起始碼；忘記密碼是「管理者直接幫他重設」那條路。
        // 兩條路都留著的話，起始碼就變成繞過舊密碼的後門。
        if ( hasPassword( who ) ) {
            return send( res, 409, { error: `${ memberName( who ) } 已經有密碼了，忘記密碼請直接幫他重設` } );
        }

        const s = session( req );
        const code = await issueSetupCode( who, s.who || '總管理者' );
        console.log( `[auth] 發了一組起始碼給 ${ memberName( who ) }（${ who }）` );
        return send( res, 200, { code, expiresInDays: SETUP_TTL_MS / 86400000 } );
    }

    // 首次設定密碼 / 改密碼。
    // 第一次設要帶管理者發的起始碼；設過的人一定要帶舊密碼。
    // 總管理者兩者都不用（幫人救回忘記密碼、以及自己是發碼的人）。
    if ( urlPath === '/api/set-password' && method === 'POST' ) {
        const body = await readBody( req );
        const who = String( body.who || '' );
        const next = String( body.newPassword || '' );
        if ( !isMember( who ) ) return send( res, 400, { error: '沒有這個人員' } );
        if ( next.length < 4 ) return send( res, 400, { error: '密碼至少 4 個字' } );

        if ( !isAdmin( req ) ) {
            if ( hasPassword( who ) ) {
                if ( !await checkPassword( who, String( body.password || '' ) ) ) {
                    return send( res, 401, { error: '舊密碼不對' } );
                }
            } else {
                const r = await useSetupCode( who, body.setupCode || '' );
                if ( !r.ok ) return send( res, 401, { error: r.error, needSetupCode: true } );
            }
        }
        await setPassword( who, next );
        dropSessionsOf( who );   // 改完密碼，別處還開著的視窗要重登
        console.log( `[auth] ${ memberName( who ) }（${ who }）設定了密碼` );
        return send( res, 200, { token: newSession( who, !!findMember( who ).admin ), who } );
    }

    // 目前使用者身分 + 專案候選清單
    if ( urlPath === '/api/meta' && method === 'GET' ) {
        const seen = [];
        for ( const p of config.projects ) if ( p && seen.indexOf( p ) < 0 ) seen.push( p );
        for ( const t of data.tasks ) if ( t.project && seen.indexOf( t.project ) < 0 ) seen.push( t.project );
        const s = session( req );
        return send( res, 200, {
            admin: !!s,                    // 有沒有「某些東西」可以編輯
            fullAdmin: !!s && s.admin,     // 能不能改所有人的、推播
            who: s ? s.who : null,
            projects: seen.sort(),
            myRole: s && s.who ? roleOf( s.who ) : null,
            members: data.members.map( m => {
                const one = { id: m.id, name: m.name, admin: !!m.admin,
                    role: roleOf( m.id ), hasPassword: hasPassword( m.id ) };
                // 「誰身上有還沒用掉的起始碼」只給管理者看 —— 那是發碼的人要追的事，
                // 對其他人來說只是多告訴他一個可以去猜的目標。
                if ( s && s.admin ) one.setupCode = setupCodeInfo( m.id );
                return one;
            } ),
            defaultOwner: defaultOwner(),
            workHours: WORK,   // 工時只有一份定義，前後端都吃這個
            meetings: MEETINGS,   // 固定會議同理，前端畫的格子要跟推估用的同一份
            telegramEnabled: !!config.telegram.enabled,
            // ⭐ 能力旗標：這台後端有沒有 PATCH /api/tasks/:id/wish。
            //    public/ 每次請求現讀、server.js 要重開才會換 ⇒ 一定有一段「新網頁 ＋ 舊服務」
            //    並存的時間；沒有這個旗標的話，提出者會看到一顆按了回 404 的「改時間」。
            //    ⛔ 不要改成前端寫死版本號 —— 那要每次改版記得同步，忘了不會有人發現。
            wishApi: true,
            // 提前幾分鐘發「快到預計完成時間了」（config.dueSoonMin，沒填＝30）。
            //    ⛔ 不是給前端拿來算的 —— 只有說明頁那句文案在用，
            //    ⚠️ 但文案寫死就會跟 config 脫鉤，所以走同一份定義。
            dueSoonMin: DUE_SOON_MIN,
            pendingNotify: pendingChanges.size,
        } );
    }

    // ── 匯出 CSV ─────────────────────────────────────────────────────────────
    //
    // 給試算表、以及「另一份表單」直接抓。`?owner=<人員id>` 只出那個人的，
    // `?owner=`（空值）＝ 只出還沒指定負責人的；不帶這個參數就是全部。
    //
    // ⚠️ 跟 GET /api/tasks 一樣**不擋登入** —— 內網用，而且擋了外部表單就抓不到。
    //    哪天要對外開放，這兩支必須一起加權限，⛔ 不要只擋其中一支。
    if ( urlPath === '/api/export.csv' && method === 'GET' ) {
        const owner = query && query.get( 'owner' );
        let list = [ ...data.tasks ].sort( ( a, b ) => a.order - b.order );
        if ( owner !== null ) list = list.filter( t => ( t.owner || '' ) === owner );

        // BOM 是給 Excel 的 —— 少了它中文會變亂碼，⛔ 不要「順手清掉怪字元」。
        // 換行用 CRLF，RFC 4180 是這樣定的。
        const body = '\uFEFF' + [
            CSV_COLUMNS.map( c => csvCell( c[ 0 ] ) ).join( ',' ),
            ...list.map( t => CSV_COLUMNS.map( c => csvCell( c[ 1 ]( t ) ) ).join( ',' ) ),
        ].join( '\r\n' ) + '\r\n';

        const stamp = new Date().toISOString().slice( 0, 10 );
        res.writeHead( 200, {
            'Content-Type': 'text/csv; charset=utf-8',
            // 檔名刻意全 ASCII —— 中文檔名要 RFC 5987 編碼，各家瀏覽器行為不一致，不值得。
            'Content-Disposition': `attachment; filename="work-board-${ stamp }.csv"`,
            'Cache-Control': 'no-store',
        } );
        return res.end( body );
    }

    if ( urlPath === '/api/tasks' && method === 'GET' ) {
        const tasks = [ ...data.tasks ].sort( ( a, b ) => a.order - b.order );
        return send( res, 200, { tasks: tasks.map( publicTask ) } );
    }

    // 新增需求 —— v4 起要登入。提出者不再是自己打的字，而是登入的那個帳號。
    // 這樣「我提的需求」、訂閱、之後要找誰追問，講的都是同一個人。
    if ( urlPath === '/api/tasks' && method === 'POST' ) {
        const s = session( req );
        if ( !s || !s.who ) {
            return send( res, 401, { error: '要先登入才能提需求', needLogin: true } );
        }
        const b = await readBody( req );
        const title = String( b.title || '' ).trim();
        if ( !title ) return send( res, 400, { error: '標題不能空白' } );
        // owner 是外部帶進來的，要擋。⚠️ 比 isDev 不是 isMember —— 指給編導的單沒有入口看得到
        if ( b.owner && !isDev( b.owner ) ) return send( res, 400, { error: '沒有這個人員（或對方不接單）' } );
        // 有帶 owner 欄位但值是空的＝提的人自己也不知道該找誰，丟進無主收件匣。
        // 沒帶這個欄位（舊的前端、直接打 API）才落到預設那個人。
        const owner = 'owner' in b ? String( b.owner || '' ) : defaultOwner();

        const maxOrder = data.tasks.reduce( ( m, t ) => Math.max( m, t.order ), 0 );
        const task = {
            id: newId(),
            title,
            detail: String( b.detail || '' ).trim(),
            project: String( b.project || '' ).trim(),
            // requesterId 才是真的身分；requester 是當下的顯示名稱快照，
            // 留著是為了 v4 之前那些對不上帳號的舊單還看得懂是誰提的。
            requesterId: s.who,
            requester: memberName( s.who ),
            owner,            // 誰做的；requester 是誰提的，兩回事。空字串＝還沒指定

            wishDate: normDate( b.wishDate ),   // 編導希望的完成日 YYYY-MM-DD，可空
            wishTime: normTime( b.wishTime ),   // 再細一點的時刻 HH:MM，可空
            status: 'inbox',
            order: maxOrder + 10,
            estimate: null,   // 我估的工時 (h)。改成已排程時會被換成「剩餘」，見 §3
            estimate0: null,  // 最初估的那個數字，之後只拿來對照，不參與排程
            spentMin: 0,      // 累計已經做掉幾分鐘（進行中切走時累加）
            startedAt: '',    // 這一輪是什麼時候進「進行中」的
            spans: [],        // 今天做到幾點的區間 [ { from, to, min } ]，被插件時補一筆
            due: '',          // 我排的預計完成日 YYYY-MM-DD
            note: '',         // 我回給編導的備註
            comments: [],
            // 開單時填的那個「希望完成」不算異動 ⇒ 這裡是空的，第一次「改」才會有東西
            wishLog: [],
            createdAt: nowISO(),
            updatedAt: nowISO(),
            doneAt: '',
        };
        data.tasks.push( task );
        saveData();
        refreshProjection();   // 新單進 inbox 不影響排程，但估時/狀態可能是帶進來的
        // ⭐ 第二個參數是「誰動的」：自己開單給自己就不用再私訊自己一次（forcedFor）。
        queueNew( task, s.who );   // 訂了對應範圍的人（含無主收件匣）、以及被指派的本人會收到
        console.log( `[new] ${ task.id } ${ task.title }（${ task.requester }）${ owner ? '' : '・無主' }` );
        return send( res, 200, { task } );
    }

    // 留言 —— 任何人都可以
    const mComment = urlPath.match( /^\/api\/tasks\/([\w]+)\/comments$/ );
    if ( mComment && method === 'POST' ) {
        const task = findTask( mComment[ 1 ] );
        if ( !task ) return send( res, 404, { error: '找不到這筆' } );
        // v4 起也要登入。⚠️ 這是提需求綁帳號之後**最後一個**自己打名字的地方 ——
        // 留著的話任何人都能用別人的名字留言，而那條留言看起來跟真的一模一樣。
        const s = session( req );
        if ( !s ) return send( res, 401, { error: '要先登入才能留言', needLogin: true } );
        const b = await readBody( req );
        const text = String( b.text || '' ).trim();
        if ( !text ) return send( res, 400, { error: '留言不能空白' } );
        task.comments.push( {
            who: s.who ? memberName( s.who ) : '管理者',
            text,
            at: nowISO(),
        } );
        task.updatedAt = nowISO();
        saveData();
        return send( res, 200, { task } );
    }

    // 改「希望完成」—— ⚠️ 只有提出需求的本人，負責人與總管理者都不行（2026-09-18 裁定）。
    // ⛔ 為什麼不併進下面那支 PATCH：那支的入口守門是 canEdit（＝負責人／管理者），
    //    把提出者放進 canEdit 會連標題、估時、狀態一起開放給他。
    // 每一次改都留三個痕跡：wishLog（給卡片數「改過 N 次」）、系統留言（給人看誰改了什麼）、
    // TG 彙整（給負責人知道）。⭐ 三個都要 —— 只留紀錄不通知，被改的人不會發現。
    const mWish = urlPath.match( /^\/api\/tasks\/([\w]+)\/wish$/ );
    if ( mWish && method === 'PATCH' ) {
        const task = findTask( mWish[ 1 ] );
        if ( !task ) return send( res, 404, { error: '找不到這筆' } );
        const s = session( req );
        if ( !s ) return send( res, 401, { error: '要先登入才能改希望完成時間', needLogin: true } );
        if ( !isRequester( req, task ) ) {
            return send( res, 403, { error: task.requesterId
                ? `「希望完成」只有提出的人（${ memberName( task.requesterId ) }）能改`
                : '這張單沒有登記提出者帳號（v4 之前的舊單），希望完成時間改不了' } );
        }
        // 做完的單不收 —— 這時候改希望時間改不動任何事，只會讓事後對帳看起來像有人動過手腳
        if ( task.status === 'done' ) {
            return send( res, 400, { error: '這張單已經完成了，不能再改希望完成時間' } );
        }

        const b = await readBody( req );
        // ⚠️ 驗證全部做完才賦值（同下面那支 PATCH 的理由）。
        const wishDate = normDate( b.wishDate );
        const wishTime = normTime( b.wishTime );
        // ⛔ 格式對不上時 normDate 會回空字串＝「清掉希望時間」，那跟「我就是要清掉」
        //    長得一模一樣 ⇒ 有送非空的字串但解不出來，一律當錯字擋掉，不要幫他清。
        if ( String( b.wishDate || '' ).trim() && !wishDate ) {
            return send( res, 400, { error: '希望完成的日期看不懂（要 YYYY-MM-DD）' } );
        }
        if ( String( b.wishTime || '' ).trim() && !wishTime ) {
            return send( res, 400, { error: '希望完成的時刻看不懂（要 HH:MM）' } );
        }
        // 沒有日期就沒有「希望完成」—— 卡片、逾期判斷、說明頁講的都是日期，時刻自己站不住
        if ( !wishDate && wishTime ) return send( res, 400, { error: '要先填日期才能填時刻' } );
        // ⛔ 不能往回填。「早就該做完了」不是需求，是對帳 —— 而且填了之後卡片會立刻變紅，
        //    等於用一個假的逾期去催人。今天可以（＝當天內都算）。
        if ( wishDate && wishDate < ymdLocal( new Date() ) ) {
            return send( res, 400, { error: '希望完成不能設在今天之前' } );
        }

        const fromText = wishLabel( task.wishDate, task.wishTime );
        const toText = wishLabel( wishDate, wishTime );
        // 送回一樣的值（表單沒改就按了儲存）⇒ ⛔ 不要記一筆「改過」也不要吵 TG
        if ( fromText === toText ) return send( res, 200, { task, queued: false } );

        task.wishDate = wishDate;
        task.wishTime = wishTime;
        task.wishLog.push( { at: nowISO(), by: s.who, from: fromText, to: toText } );
        // 紀錄寫成系統留言 —— 跟討論放在一起才會有人看到，⛔ 不另開一個沒人會點的頁面。
        // ⚠️ who 帶前綴符號，跟真人的留言分得開（真人的 who 是名冊裡的名字）。
        task.comments.push( {
            who: '⚙ 系統紀錄',
            // 前端靠這個旗標把它畫成灰底的系統紀錄 —— ⛔ 不要讓前端去猜 who 的前綴
            sys: true,
            text: `${ memberName( s.who ) } 把希望完成從「${ fromText }」改成「${ toText }」`
                + `（這張單第 ${ task.wishLog.length } 次改）`,
            at: nowISO(),
        } );
        task.updatedAt = nowISO();
        saveData();
        // 併進既有的 90 秒彙整（跟估時／狀態同一則訊息），⛔ 不另開一種推播。
        // ⚠️ 走的是訂閱範圍 ⇒ 負責人要訂了 owner:自己 才收得到，跟其他欄位一樣。
        queueNotify( task, [ { field: 'wish', label: '🙏 希望完成', from: fromText, to: toText } ], s.who );
        console.log( `[wish] ${ task.id } ${ fromText } → ${ toText }`
            + `（${ memberName( s.who ) }・第 ${ task.wishLog.length } 次）` );
        // ⚠️ 不呼叫 refreshProjection —— 希望時間不進推估算式（那個只看順序與估時）
        return send( res, 200, { task, queued: true } );
    }

    // ── 以下都要登入。人員只能動自己 owner 的，總管理者不限 ──

    const mTask = urlPath.match( /^\/api\/tasks\/([\w]+)$/ );

    if ( mTask && ( method === 'PATCH' || method === 'DELETE' ) ) {
        const task = findTask( mTask[ 1 ] );
        if ( !task ) return send( res, 404, { error: '找不到這筆' } );
        // 先查得到這筆才知道它是誰的，所以權限檢查放在找得到之後
        if ( !canEdit( req, task ) ) {
            return send( res, 403, { error: session( req ) ? `這是 ${ memberName( task.owner ) } 的項目` : '請先登入' } );
        }

        if ( method === 'DELETE' ) {
            data.tasks = data.tasks.filter( t => t.id !== task.id );
            saveData();
            refreshProjection();   // 拿掉一筆，後面全部往前
            return send( res, 200, { ok: true } );
        }

        const b = await readBody( req );
        // 欄位驗證要在任何一行賦值之前做完。下面是先改再存，中途 return 會留下
        // 一個「改了一半、沒存檔」的物件在記憶體裡，等別的請求存檔時才一起寫進去。
        // 轉派的合法性與權限都在這裡判掉，理由同上 —— 到下面真的要賦值時就不能再 return 了。
        // 只有總管理者能轉派，分派權跟排序權一樣，不該讓人把工作互相推來推去；
        // 唯一的例外是無主的單，誰都可以接走（但只能接給自己）。
        if ( 'owner' in b ) {
            const want = String( b.owner || '' );
            if ( want && !isDev( want ) ) return send( res, 400, { error: '沒有這個人員（或對方不接單）' } );
            const s = session( req );
            const claiming = !task.owner && want === s.who;
            if ( want !== task.owner && !s.admin && !claiming ) {
                return send( res, 403, { error: task.owner ? '只有管理者能轉派' : '只能接給自己' } );
            }
        }

        // ⛔ 「希望完成」不在這裡改了 —— 只有提出者本人動得了，走 PATCH /api/tasks/:id/wish
        //    （2026-09-18 裁定：負責人與總管理者都不能代改，而且每次改都要留紀錄）。
        // ⚠️ 比的是「值有沒有變」不是「key 在不在」—— 沒清快取的舊前端會把整份表單
        //    送回來，只看 key 的話管理者光改個標題就會被擋。
        if ( ( 'wishDate' in b && normDate( b.wishDate ) !== task.wishDate )
            || ( 'wishTime' in b && normTime( b.wishTime ) !== task.wishTime ) ) {
            return send( res, 403, { error: '「希望完成」只有提出需求的人能改（請重新整理頁面再試）' } );
        }

        // 排程與評估只有本人能改，理由見 canSchedule。
        // ⚠️ 比的是「值有沒有變」不是「key 在不在」—— 編輯表單每次都把整份欄位送回來，
        // 只看 key 的話管理者光改個標題就會被擋。
        // ⚠️ 只解析一次，下面套用時直接用 nextEstimate —— 兩邊各解析一次的話，
        //    parser 改了一邊沒改另一邊，會變成「擋不下來但也沒寫進去」。
        const nextEstimate = 'estimate' in b ? bodyEstimate( b.estimate ) : undefined;
        if ( 'estimate' in b && nextEstimate === undefined ) return send( res, 400, { error: EST_HINT } );
        // ⛔ 擋在存檔之前。存下去之後才發現的話，這張單會讓那個人的推估永遠算不出來，
        //    而且舊版連服務都會被弄死（見 EST_MAX_H 與 projectAll）。
        if ( nextEstimate !== undefined && nextEstimate !== null && nextEstimate > EST_MAX_H ) {
            return send( res, 400, {
                error: `估時上限是 ${ EST_MAX_H } 小時，填進來的是 ${ fmtHours( nextEstimate ) }`
                    + '，確認一下是不是多打了幾位數（要填分鐘的話記得加 m，例如 90m）',
            } );
        }
        const wantEstimate = 'estimate' in b && nextEstimate !== task.estimate;
        const wantDue = 'due' in b && String( b.due || '' ) !== task.due;
        const wantStatus = 'status' in b && STATUSES.indexOf( b.status ) >= 0 && b.status !== task.status;
        if ( ( wantEstimate || wantDue || wantStatus ) && !canSchedule( req, task ) ) {
            return send( res, 403, { error: `排程與估時只有 ${ memberName( task.owner ) } 本人能改` } );
        }

        const changes = [];
        // ⚠️ 下面的 estimate 區塊會就地覆蓋 task.estimate，而「被插件」那段要算
        //    「原本剩多少 − 現在剩多少」。先留一份，⛔ 不要到下面才讀 task.estimate。
        const estimateBefore = task.estimate;
        // 這次請求有沒有走「被插件」那條路。走過的話那段自己會把帳算對，
        // 下面補原估那段就不能再插手（否則會算兩次）。
        let cutRound = false;

        if ( 'estimate' in b ) {
            const v = nextEstimate;
            if ( v !== task.estimate ) {
                changes.push( { field: 'estimate', label: '估時',
                    from: task.estimate ? fmtHours( task.estimate ) : '未估',
                    to: v ? fmtHours( v ) : '未估' } );
                task.estimate = v;
            }
        }
        if ( 'due' in b ) {
            const v = String( b.due || '' );
            if ( v !== task.due ) {
                changes.push( { field: 'due', label: '預計完成',
                    from: task.due ? fmtDue( task.due ) : '未定',
                    to: v ? fmtDue( v ) : '未定' } );
                task.due = v;
            }
        }
        // 轉派。對編導來說「換人做」跟「換日期」一樣要緊，算在該推播的異動裡。
        if ( 'owner' in b && String( b.owner || '' ) !== task.owner ) {
            changes.push( { field: 'owner', label: '負責人',
                from: ownerLabel( task.owner ), to: ownerLabel( b.owner ) } );
            task.owner = String( b.owner || '' );
        }
        if ( 'status' in b && STATUSES.indexOf( b.status ) >= 0 && b.status !== task.status ) {
            changes.push( { field: 'status', label: '狀態',
                from: STATUS_LABEL[ task.status ], to: STATUS_LABEL[ b.status ] } );

            // 進「進行中」記時間點，之後切走才算得出這一輪做掉多久。
            if ( b.status === 'doing' ) task.startedAt = nowISO();
            // 離開「進行中」但還沒做完＝被插件了。前端會先問「還要多久」再送 estimate 過來，
            // 這裡把「原估」補起來並累加已做時數。⚠️ 做掉的時數要自己算，
            // ⛔ 不要信前端送的 spentMin —— 那是公開可寫的欄位。
            if ( task.status === 'doing' && b.status !== 'doing' && b.status !== 'done' ) {
                cutRound = true;
                if ( task.estimate0 === null || task.estimate0 === undefined ) {
                    task.estimate0 = estimateBefore;
                }
                const cut = ( estimateBefore || 0 ) - ( task.estimate || 0 );
                if ( cut > 0 ) task.spentMin = ( task.spentMin || 0 ) + Math.round( cut * 60 );
                // 這一輪在時間表上佔掉的區間。沒有這一筆的話，被插件的單會從時間表上
                // 整段消失、後面全部往前塌 —— 使用者看到的是「那個時段變成另一個進行中」。
                // ⚠️ 沒有 startedAt 就記不出區間（v4 以前留下來、狀態已經是進行中的單），
                //    那就不記：時間表上少一段，比畫一段編出來的區間好。
                // ⚠️ min 記的是人確認過的「做掉多少」；時間表畫的長度是另外用時間戳推的
                //    （見 app.js 的 pastEntries），兩個數字不保證一樣，⛔ 不要互相取代。
                if ( task.startedAt ) {
                    task.spans.push( {
                        from: task.startedAt, to: nowISO(), min: Math.max( 0, Math.round( cut * 60 ) ),
                    } );
                }
                task.startedAt = '';
            }
            task.status = b.status;
            task.doneAt = b.status === 'done' ? nowISO() : '';
        }
        // ⭐ P4（＝README §7 的 Bug B）：把「原估 ＝ 已做 ＋ 剩」變成**無條件**成立。
        //    原本有兩條路會讓它對不起來：
        //    ⒜ 卡片上直接改估時 —— 只寫 estimate，estimate0／spentMin 原封不動。
        //    ⒝ 被插件時填的「還要多久」比原本剩的**更多**（原估 1h、還要 2h）——
        //       上面那段的 cut 是負數、不會累加 spentMin，於是 1 ≠ 0 ＋ 2。
        //    所以這裡不分路，只要「估時動過」或「走過插件」就把原估補成 已做 ＋ 剩。
        // ⚠️ 正常那條路算完本來就相等 ⇒ 這行是 no-op（X6 之外的案子數字不會變）。
        // ⛔ 沒有選「清掉 estimate0 / spentMin」那條路 —— spentMin 是後端自己從估時差
        //    算出來的真實工時，清掉等於把那一輪的紀錄丟了，而且時間表上的 spans 還留著，
        //    會變成「表上有一段灰色、卡片上卻說沒做過」。
        // ⚠️ 代價：`estimate0` 不再是「第一次填的那個數字」，而是「現在認為總共要多久」。
        //    重估剩餘時數會把它往上推。README §7 已經照這個講法改過。
        // ⚠️ 算在**分鐘**上再除回小時，⛔ 不要用小時直接相加（0.1h 那種會湊不出整數分鐘）。
        if ( ( wantEstimate || cutRound ) && task.estimate0 !== null && task.estimate0 !== undefined ) {
            task.estimate0 = ( ( task.spentMin || 0 ) + Math.round( ( task.estimate || 0 ) * 60 ) ) / 60;
        }
        // 這幾項純內部修訂，不值得吵 TG。
        // ⛔ requester 不在裡面 —— v4 起提出者是登入帳號，不是可以改的一段字。
        for ( const k of [ 'title', 'detail', 'project', 'note' ] ) {
            if ( k in b ) task[ k ] = String( b[ k ] || '' ).trim();
        }

        task.updatedAt = nowISO();
        saveData();
        // ⚠️ 上面那個 s 是 if ( 'owner' in b ) 區塊裡的，這裡看不到 —— 重拿一次。
        const me = session( req );
        if ( changes.length ) queueNotify( task, changes, me && me.who );
        // 估時或狀態一改，這個人後面每一筆的完成日都會位移
        refreshProjection();
        return send( res, 200, { task, queued: changes.length > 0 } );
    }

    // 排序
    if ( urlPath === '/api/reorder' && method === 'POST' ) {
        if ( !session( req ) ) return send( res, 403, { error: '請先登入' } );
        const b = await readBody( req );
        const ids = Array.isArray( b.ids ) ? b.ids : [];
        const list = ids.map( findTask ).filter( Boolean );

        // 排序是排程的一部分，管理者也不能替別人排（見 canSchedule）
        const bad = list.find( t => !canSchedule( req, t ) );
        if ( bad ) return send( res, 403, { error: `裡面有 ${ memberName( bad.owner ) } 的項目，不能一起排` } );

        // 只動送進來的這幾筆的 order「值」：把它們現有的值由小到大排好，
        // 再照送進來的順序塞回去。沒送進來的人一個字都不會被改到 ——
        // 所以別人在自己頁面拖曳，不會動到你的排序。
        const slots = list.map( t => t.order ).sort( ( x, y ) => x - y );
        list.forEach( ( t, i ) => { t.order = slots[ i ]; } );

        saveData();
        // 排序就是這個功能的重點：往後挪一格，完成日真的變晚了，提出的人該知道
        const moved = refreshProjection();
        return send( res, 200, { ok: true, projectionChanged: moved } );
    }

    // ── 每日排程快照 ──
    // 計畫是前端算的，這裡只負責存。存最新的一份，所以隔天回看到的是那天收工時的樣子。

    if ( urlPath === '/api/days' && method === 'GET' ) {
        const owner = ownerParam( query );
        const list = Object.keys( data.days ).sort().reverse()
            .filter( d => data.days[ d ][ owner ] )
            .map( d => ( { date: d, savedAt: data.days[ d ][ owner ].savedAt } ) );
        return send( res, 200, { days: list } );
    }

    const mDay = urlPath.match( /^\/api\/days\/(\d{4}-\d{2}-\d{2})$/ );
    if ( mDay && method === 'GET' ) {
        const owner = ownerParam( query );
        const plan = ( data.days[ mDay[ 1 ] ] || {} )[ owner ];
        if ( !plan ) return send( res, 404, { error: '那天沒有存到排程' } );
        return send( res, 200, { plan } );
    }

    // 某一天「所有人」的起排。⚠️ 一次回整張表 —— 前端在人員之間切來切去時
    // 不用每切一次就打一支 API，而且「每個人各有一份」這件事在這裡就看得出來。
    if ( urlPath === '/api/day-starts' && method === 'GET' ) {
        const date = normDate( query.get( 'date' ) );
        if ( !date ) return send( res, 400, { error: 'date 格式要是 YYYY-MM-DD' } );
        return send( res, 200, { date, starts: data.dayStarts[ date ] || {} } );
    }

    if ( urlPath === '/api/day-start' && method === 'POST' ) {
        const s = session( req );
        if ( !s ) return send( res, 403, { error: '請先登入' } );
        const b = await readBody( req );
        const date = normDate( b.date );
        if ( !date ) return send( res, 400, { error: 'date 格式要是 YYYY-MM-DD' } );
        if ( b.owner && !isMember( b.owner ) ) return send( res, 400, { error: '沒有這個人員' } );
        // ⛔ 寫入一律要明確指定 owner。沒帶就退回 defaultOwner() 的話，
        //    「沒有主人」的呼叫會被寫成那個人的起排（P5 同一類的坑，2026-09-17 修）。
        if ( !b.owner ) return send( res, 400, { error: 'owner 要明確指定（起排是一個人一份，不會幫你猜）' } );
        const owner = b.owner;
        // 本人，或管理者（同事遲到／請假時要幫他調）。⛔ 其他同事一律不行。
        // ⚠️ 這跟「ADMIN 也不能調別人的排程與評估」不衝突 —— 起排只是這張表從幾點
        //    開始畫，不會動到任何人的單、估時或順序。
        if ( owner !== s.who && !s.admin ) {
            return send( res, 403, { error: '只有本人或管理者能調這個人的起排' } );
        }
        // ⛔ 不要用 Number( b.min ) 收 —— `null`／`""`／`true` 會被它悄悄變成 0／0／1
        //    全部收下（`null` 跟 `""` 存成 0 ＝ 起排變午夜，P7）。
        // ⚠️ 純數字的字串（`"600"`，用 curl 手打時很常見）照收，其餘一律擋。
        const min = typeof b.min === 'string' && /^\d{1,4}$/.test( b.min.trim() )
            ? Number( b.min.trim() ) : b.min;
        if ( typeof min !== 'number' || !Number.isInteger( min ) || min < 0 || min > 1439 ) {
            return send( res, 400, {
                error: 'min 要是 0–1439 的整數（當天從午夜算起的分鐘）'
                    + '，⛔ 不收 null／空字串／true 這種會被硬轉成 0 的值',
            } );
        }
        if ( !data.dayStarts[ date ] ) data.dayStarts[ date ] = {};
        // auto＝自動算出來的、還沒有人手動調過。人調過的一律 false，之後誰都不准自動蓋。
        // ⚠️ 前端本來就有這條（applyStartForView 看到 auto=false 就不動），
        //    但後端沒有 ⇒ 直接打 API、或兩個分頁搶著寫，就會把人調過的值蓋掉（P7）。
        const prevStart = data.dayStarts[ date ][ owner ];
        if ( b.auto && prevStart && prevStart.auto === false ) {
            return send( res, 409, {
                error: `${ memberName( owner ) } 的起排已經自己調過了，自動算出來的值不會蓋掉它`,
                start: prevStart,
            } );
        }
        data.dayStarts[ date ][ owner ] = { min, auto: !!b.auto, by: s.who || '', at: nowISO() };
        saveData();
        return send( res, 200, { ok: true, start: data.dayStarts[ date ][ owner ] } );
    }

    if ( urlPath === '/api/day-plan' && method === 'POST' ) {
        const s = session( req );
        if ( !s ) return send( res, 403, { error: '請先登入' } );
        const b = await readBody( req );
        if ( !/^\d{4}-\d{2}-\d{2}$/.test( b.date || '' ) ) return send( res, 400, { error: 'date 格式要是 YYYY-MM-DD' } );
        if ( b.owner && !isMember( b.owner ) ) return send( res, 400, { error: '沒有這個人員' } );
        // ⭐ P5：沒帶 owner 就退回 defaultOwner() 的話，「還不確定找誰」那一頁存出來的
        //    快照會掛在他名下、汙染他當天的紀錄。快照是一個人一份，⛔ 不准猜。
        if ( !b.owner ) return send( res, 400, { error: 'owner 要明確指定（排程快照是一個人一份，不會幫你猜）' } );
        const owner = b.owner;
        // 管理者也不行 —— 他看別人的頁面時前端根本不會存，這裡是後門那一面
        if ( owner !== s.who ) return send( res, 403, { error: '只能存自己的排程' } );
        if ( !data.days[ b.date ] ) data.days[ b.date ] = {};
        data.days[ b.date ][ owner ] = Object.assign( {}, b.plan, { savedAt: nowISO() } );
        saveData();
        return send( res, 200, { ok: true } );
    }

    // ── 補帳守門（隔天早上問「昨天做了多少」）──

    if ( urlPath === '/api/catch-up' && method === 'GET' ) {
        const s = session( req );
        if ( !s ) return send( res, 401, { error: '請先登入' } );
        const owner = query && query.get( 'owner' );
        if ( !owner || !isMember( owner ) ) return send( res, 400, { error: 'owner 要明確指定（補帳是一個人一份，不會幫你猜）' } );
        if ( owner !== s.who ) return send( res, 403, { error: '只有本人能補自己的帳' } );
        const today = ymdLocal( new Date() );
        // 最近一個早於今天、而且那個人有快照的日期
        const date = Object.keys( data.days )
            .filter( d => d < today && data.days[ d ][ owner ] )
            .sort().pop() || null;

        // 命中規則 A：快照裡排了但沒有 past 的 seg（overflow 裡的不算，但同時在 segs 的算）
        const hitIds = new Set();
        const plannedMinMap = new Map();
        if ( date !== null ) {
            const snap = data.days[ date ][ owner ];
            for ( const g of ( snap.groups || [] ) ) {
                for ( const seg of ( g.segs || [] ) ) {
                    if ( !seg.id ) continue;
                    if ( seg.past !== undefined ) continue;   // past:'done'/'cut' 排除
                    const task = findTask( seg.id );
                    if ( !task || task.owner !== owner ) continue;
                    if ( task.status !== 'todo' && task.status !== 'doing' ) continue;
                    if ( !( task.estimate > 0 ) ) continue;
                    if ( task.catchUpAsked === today ) continue;
                    hitIds.add( seg.id );
                    plannedMinMap.set( seg.id, ( plannedMinMap.get( seg.id ) || 0 ) + ( seg.to - seg.from ) );
                }
            }
        }

        // 命中規則 B：卡在進行中跨日
        const stuckIds = new Set();
        for ( const task of data.tasks ) {
            if ( task.owner !== owner ) continue;
            if ( task.status !== 'doing' ) continue;
            if ( !task.startedAt ) continue;
            if ( ymdLocal( new Date( task.startedAt ) ) >= today ) continue;
            if ( !( task.estimate > 0 ) ) continue;
            if ( task.catchUpAsked === today ) continue;
            stuckIds.add( task.id );
            if ( !hitIds.has( task.id ) ) hitIds.add( task.id );
        }

        const items = [];
        for ( const id of hitIds ) {
            const task = findTask( id );
            if ( !task ) continue;
            const planned = plannedMinMap.has( id );
            const plannedMin = plannedMinMap.get( id ) || 0;
            const stuckDoing = stuckIds.has( id );
            const recordedMin = date !== null
                ? ( task.spans || [] )
                    .filter( sp => sp.to && ymdLocal( new Date( sp.to ) ) === date )
                    .reduce( ( a, sp ) => a + ( sp.min || 0 ), 0 )
                : 0;
            items.push( {
                id: task.id,
                title: task.title,
                project: task.project || '',
                status: task.status,
                estimate: task.estimate,
                spentMin: task.spentMin || 0,
                planned,
                plannedMin,
                recordedMin,
                stuckDoing,
                startedAt: stuckDoing ? ( task.startedAt || '' ) : '',
            } );
        }
        // planned 的照 plannedMin 由大到小；只有 stuckDoing 的排在後面
        items.sort( ( a, b ) => {
            if ( a.planned && !b.planned ) return -1;
            if ( !a.planned && b.planned ) return 1;
            return b.plannedMin - a.plannedMin;
        } );

        return send( res, 200, { date, items } );
    }

    if ( urlPath === '/api/catch-up' && method === 'POST' ) {
        const s = session( req );
        if ( !s ) return send( res, 401, { error: '請先登入' } );
        const b = await readBody( req );
        const task = findTask( b.id );
        if ( !task ) return send( res, 404, { error: '沒有這張單' } );
        if ( !canSchedule( req, task ) ) {
            return send( res, 403, { error: `排程與估時只有 ${ memberName( task.owner ) } 本人能改` } );
        }
        if ( task.status !== 'todo' && task.status !== 'doing' ) {
            return send( res, 400, { error: '只有已排程與進行中的單能補帳' } );
        }
        const today = ymdLocal( new Date() );
        // 冪等守門：非 skip 路徑且今天已補過，直接放行（不加帳）
        if ( !b.skip && task.catchUpAsked === today ) {
            return send( res, 200, { task, skipped: true } );
        }
        // skip 路徑（⛔ updatedAt 不動：什麼都沒改，不要讓它看起來像被編輯過）
        if ( b.skip ) {
            task.catchUpAsked = today;
            saveData();
            return send( res, 200, { task, skipped: true } );
        }
        // 解析 spent / remain
        const spentH = parseHours( b.spent == null || b.spent === '' ? 0 : b.spent );
        const remainH = parseHours( b.remain );
        if ( spentH === null || remainH === null ) {
            return send( res, 400, { error: EST_HINT } );
        }
        if ( remainH > EST_MAX_H ) {
            return send( res, 400, {
                error: `估時太大（你填的是 ${ fmtHours( remainH ) }），要填分鐘的話記得加 m`,
            } );
        }
        // ⚠️ spent 也要擋 —— 「90」想打的是 90 分鐘，parseHours 讀成 90 小時，
        //   而 spentMin 兩個寫入點都只會加不會減，打錯一次從 UI 救不回來。
        if ( spentH > EST_MAX_H ) {
            return send( res, 400, {
                error: `已做的時間太大（你填的是 ${ fmtHours( spentH ) }），要填分鐘的話記得加 m`,
            } );
        }
        // 視同 skip：兩格都沒改
        if ( spentH === 0 && remainH === task.estimate ) {
            task.catchUpAsked = today;
            saveData();
            return send( res, 200, { task, skipped: true } );
        }
        // 補帳
        const estimateBefore = task.estimate;
        task.spentMin = ( task.spentMin || 0 ) + Math.round( spentH * 60 );
        task.estimate = remainH;
        // 「原估 ＝ 已做 ＋ 剩」無條件寫（⛔ 不照抄 PATCH 的 estimate0 !== null 守門：
        //   沒走過插件的單 estimate0 是 null，有守門就完全不會記帳，正是本次要修的洞。）
        task.estimate0 = ( task.spentMin + Math.round( task.estimate * 60 ) ) / 60;
        // 還在進行中：計時從補帳這一刻重新開始（否則昨天那段會在下次「被插件」時被再算一次）
        if ( task.status === 'doing' ) task.startedAt = nowISO();
        task.catchUpAsked = today;
        task.updatedAt = nowISO();
        saveData();
        // 估時真的變了才發通知（走既有彙整佇列，早上補三張只出一則）
        if ( estimateBefore !== task.estimate ) {
            queueNotify( task, [ { field: 'estimate', label: '估時',
                from: estimateBefore ? fmtHours( estimateBefore ) : '未估',
                to: task.estimate ? fmtHours( task.estimate ) : '未估' } ], s.who );
        }
        refreshProjection();
        return send( res, 200, { task, skipped: false } );
    }

    // 手動立刻推播目前排程 —— 這則還是發到群組（週會前用）
    if ( urlPath === '/api/notify' && method === 'POST' ) {
        if ( !isAdmin( req ) ) return send( res, 403, { error: '只有管理者能推播' } );
        if ( notifyTimer ) { clearTimeout( notifyTimer ); notifyTimer = null; }
        if ( pendingChanges.size ) flushNotify();
        const live = data.tasks.filter( t => t.status !== 'done' );
        tgSend( `📋 <b>目前工作排程</b>\n\n${ buildScheduleBlock() }${ mentionLine( live ) }` );
        return send( res, 200, { ok: true } );
    }

    // ── 訂閱 ──

    // 產生一組綁定碼。v4 起要登入 —— 訂閱綁的是帳號，不是自己打的一個名字。
    // 拿到碼之後還是要本人去私訊 bot 才算數（TG 的硬限制，見 §3）。
    if ( urlPath === '/api/subscribe' && method === 'POST' ) {
        const s = session( req );
        if ( !s || !s.who ) return send( res, 401, { error: '要先登入才能訂閱', needLogin: true } );
        if ( !config.telegram.enabled || !botUsername ) {
            return send( res, 503, { error: 'TG 綁定服務沒開，跟管理者說一聲' } );
        }
        const b = await readBody( req );
        const label = memberName( s.who );

        const parsed = parseScopes( b.scopes, s.who );
        if ( !parsed.ok ) return send( res, 400, { error: parsed.error } );
        const scopes = parsed.scopes;

        sweepBinds();
        const code = newBindCode();
        pendingBinds.set( code, {
            who: s.who, label, scopes, tagInGroup: !!b.tagInGroup,
            expiresAt: Date.now() + BIND_TTL_MS, done: null,
        } );
        return send( res, 200, {
            code,
            bot: botUsername,
            link: `https://t.me/${ botUsername }?start=${ code }`,
            expiresInMin: Math.round( BIND_TTL_MS / 60000 ),
        } );
    }

    // 網頁輪這支看綁好了沒
    const mBind = urlPath.match( /^\/api\/subscribe\/([A-Z0-9]{6})$/ );
    if ( mBind && method === 'GET' ) {
        const b = pendingBinds.get( mBind[ 1 ] );
        if ( b ) return send( res, 200, { state: 'waiting' } );
        // 碼被消耗掉了：可能綁好了，也可能過期。回查自己的訂閱才知道是哪一種
        const s = session( req );
        const sub = s && s.who ? auth.subscribers[ s.who ] : null;
        if ( sub ) return send( res, 200, { state: 'done', sub: publicSub( sub ) } );
        return send( res, 200, { state: 'expired' } );
    }

    // 以下三支都只動「登入的那個人自己的」訂閱 —— 不再從 body 收名字，
    // 所以也沒有「改到別人的」這種事了（v4 之前是只認名字的）。
    if ( urlPath === '/api/subscription' && method === 'GET' ) {
        const s = session( req );
        if ( !s || !s.who ) return send( res, 200, { sub: null, needLogin: true } );
        const sub = auth.subscribers[ s.who ];
        return send( res, 200, { sub: sub ? publicSub( sub ) : null } );
    }

    // 改追蹤範圍。不用重綁 —— 綁定是為了拿到 TG chat id，那個沒變。
    if ( urlPath === '/api/subscription' && method === 'PATCH' ) {
        const s = session( req );
        if ( !s || !s.who ) return send( res, 401, { error: '要先登入', needLogin: true } );
        const sub = auth.subscribers[ s.who ];
        if ( !sub ) return send( res, 404, { error: '還沒訂閱，先去產生綁定碼' } );

        const b = await readBody( req );
        const parsed = parseScopes( b.scopes, s.who );
        if ( !parsed.ok ) return send( res, 400, { error: parsed.error } );
        sub.scopes = parsed.scopes;
        if ( 'tagInGroup' in b ) sub.tagInGroup = !!b.tagInGroup;
        saveAuth();
        console.log( `[tg] ${ sub.label } 改了追蹤範圍：${ sub.scopes.join( '、' ) }` );
        return send( res, 200, { sub: publicSub( sub ) } );
    }

    if ( urlPath === '/api/unsubscribe' && method === 'POST' ) {
        const s = session( req );
        if ( !s || !s.who ) return send( res, 401, { error: '要先登入', needLogin: true } );
        const sub = auth.subscribers[ s.who ];
        if ( !sub ) return send( res, 404, { error: '本來就沒有訂閱' } );
        delete auth.subscribers[ s.who ];
        saveAuth();
        tgSend( '已取消訂閱，之後不會再收到通知。', sub.tgChatId );
        return send( res, 200, { ok: true } );
    }

    return send( res, 404, { error: 'no such endpoint' } );
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer( ( req, res ) => {
    const u = new URL( req.url, 'http://x' );
    if ( u.pathname.startsWith( '/api/' ) ) {
        handleApi( req, res, u.pathname, u.searchParams )
            .catch( e => {
                console.error( '[api]', e );
                send( res, 500, { error: e.message } );
            } );
        return;
    }
    serveStatic( req, res, u.pathname );
} );

function localIPs() {
    const out = [];
    for ( const list of Object.values( os.networkInterfaces() ) ) {
        for ( const ni of list ) {
            if ( ni.family === 'IPv4' && !ni.internal ) out.push( ni.address );
        }
    }
    return out;
}

backupData();
setInterval( backupData, 6 * 60 * 60 * 1000 );
// 「快到預計完成時間」每分鐘掃一次。⚠️ 一分鐘是提醒的解析度 ——
// 拉長的話「前 30 分鐘」會變成「前 30±n 分鐘」。⛔ 不要用它來代替 refreshProjection。
setInterval( checkDueSoon, 60 * 1000 );

server.listen( config.port, '0.0.0.0', () => {
    console.log( '────────────────────────────────────' );
    console.log( ' 接單看板已啟動' );
    console.log( `   本機   http://localhost:${ config.port }` );
    for ( const ip of localIPs() ) console.log( `   內網   http://${ ip }:${ config.port }` );
    console.log( ` TG 推播 ${ config.telegram.enabled ? '已啟用' : '未啟用（改 config.json）' }` );
    console.log( ` 群組彙整 ${ config.telegram.notifyGroup ? '開' : '關（只走個人訂閱；📣 手動推播不受影響）' }` );
    console.log( ` 訂閱中 ${ Object.keys( auth.subscribers ).length } 人` );
    if ( config.adminPassword === 'CHANGE-ME' ) console.log( ' ⚠  admin 密碼還是預設值，去 config.json 改掉' );
    console.log( '────────────────────────────────────' );
    // 綁定用的 long polling。掛在 listen 之後，網頁不會因為 TG 連不上而起不來。
    pollLoop().catch( e => console.error( '[tg] 綁定服務停了', e.message ) );
} );
