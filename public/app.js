'use strict';

const $ = s => document.querySelector( s );
const $$ = s => [ ...document.querySelectorAll( s ) ];

const STATUS_LABEL = { inbox: '待評估', todo: '已排程', doing: '進行中', done: '已完成', parked: '擱置' };
const STATUS_ICON = { inbox: '📥', todo: '🟡', doing: '🔵', done: '✅', parked: '⏸️' };
const GROUP_ORDER = [ 'doing', 'todo', 'inbox', 'parked', 'done' ];

let tasks = [];
// 第一次把單抓回來之前，「今天什麼都沒發生」跟「還不知道」長得一模一樣，
// 起排不能在那時候定案（見 applyStartForView）。
let dataLoaded = false;
// 今天「每個人各自的起排」： 人員id -> { min, auto, by, at }。
// ⚠️ 存在伺服器（見 /api/day-starts），換一台電腦、換一個人看到的都是同一份。
// 每人各一份是必要的 —— 同事請假、遲到，他那天本來就不是從上班時間開始算。
let dayStarts = {};
// 我寫過、但還不確定「輪詢拿回來的那份含不含它」的起排。
//   人員id -> { val, since }   since＝我的寫入成功回來時，輪詢已經跑到第幾輪
// ⚠️ 輪詢的 GET 可能比我的 POST 更早出發、卻更晚回來，回來時帶的是舊值 ——
//    直接蓋上去，剛調好的那一格會彈回去，要等下一輪（20 秒）才復原。
// ⛔ 判斷「清掉沒」不可以只看 POST 回來了沒 —— 那清得太早，正好漏掉最危險的
//    那一段（POST 都回來了，先出發的那個 GET 還在路上）。要比的是「這一輪的
//    請求出發的時候，我的寫入成功了沒」：出發在後的那一輪才含得到它。
const pendingStarts = new Map();
let pollSeq = 0;
// 這支服務還不認得 /api/day-starts（＝網頁已經換新、server.js 還沒重開）。
// ⚠️ 那段時間起排只活在這個分頁裡，存不起來 —— 講一次就好，⛔ 不要每 20 秒
//    輪詢一次就跳一次錯誤訊息，那會洗掉所有人畫面上真正要看的訊息。
let startsApiMissing = false;
// `${owner}@${date}`：這個人的今天已經查過補帳了，不要每 20 秒再打一次 API
let catchUpKey = '';
let meta = { admin: false, fullAdmin: false, who: null, members: [], projects: [], telegramEnabled: false };

// 現在在看誰的。null＝還在外層的人員牆。
//   { kind:'member', owner:'boshue' }  某個人的看板
//   { kind:'open' }                    還不確定找誰（owner 空字串的無主單）
//   { kind:'mine' }                    我提的需求，跨所有人
let view = { kind: 'people' };

const OPEN_KEY = '_open';
const MINE_KEY = '_mine';

// ⛔ 這裡不再有 name —— v4 起「我是誰」只有一個來源：登入的帳號（meta.who）。
// 存一份自己打的名字在瀏覽器裡，就會出現「同一個人在兩台電腦是兩個提出者」。
const store = {
    get token() { return localStorage.getItem( 'wb_token' ) || ''; },
    set token( v ) { v ? localStorage.setItem( 'wb_token', v ) : localStorage.removeItem( 'wb_token' ); },
    // 說明視窗裡那份更新公告，這台瀏覽器看到的是哪一版（見 HELP_VERSION）
    get helpSeen() { return localStorage.getItem( 'wb_help_seen' ) || ''; },
    set helpSeen( v ) { localStorage.setItem( 'wb_help_seen', v ); },
};

// ── api ──────────────────────────────────────────────────────────────────────

async function api( url, opts ) {
    const o = opts || {};
    o.headers = Object.assign( { 'Content-Type': 'application/json' }, o.headers );
    if ( store.token ) o.headers[ 'X-Admin-Token' ] = store.token;
    if ( o.body && typeof o.body !== 'string' ) o.body = JSON.stringify( o.body );
    const res = await fetch( url, o );
    const json = await res.json().catch( () => ( {} ) );
    if ( !res.ok ) throw new Error( json.error || `HTTP ${ res.status }` );
    return json;
}

function toast( msg, isErr ) {
    const el = $( '#toast' );
    el.textContent = msg;
    el.classList.toggle( 'err', !!isErr );
    el.classList.remove( 'hidden' );
    clearTimeout( toast._t );
    toast._t = setTimeout( () => el.classList.add( 'hidden' ), 2600 );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function esc( s ) {
    return String( s == null ? '' : s )
        .replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' )
        .replace( /"/g, '&quot;' );
}

function todayStr() {
    const d = new Date();
    return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
}

function dueClass( t ) {
    if ( !t.due ) return 'none';
    if ( t.status === 'done' ) return '';
    const days = Math.round( ( new Date( t.due ) - new Date( todayStr() ) ) / 86400000 );
    if ( days < 0 ) return 'overdue';
    if ( days <= 1 ) return 'soon';
    return '';
}

function dueText( t ) {
    if ( !t.due ) return '未排';
    const days = Math.round( ( new Date( t.due ) - new Date( todayStr() ) ) / 86400000 );
    const md = t.due.slice( 5 ).replace( '-', '/' );
    if ( t.status === 'done' ) return md;
    if ( days === 0 ) return `${ md }（今天）`;
    if ( days === 1 ) return `${ md }（明天）`;
    if ( days < 0 ) return `${ md }（逾期 ${ -days } 天）`;
    return `${ md }（${ days } 天後）`;
}

// 希望完成時間。日期必填、時刻可空（空＝當天內都行）。
function wishText( t ) {
    if ( !t.wishDate ) return '';
    return t.wishDate.slice( 5 ).replace( '-', '/' ) + ( t.wishTime ? ` ${ t.wishTime }` : '' );
}

// ⚠️ 這裡的「逾期」看的是編導希望的時間，不是我排的 due —— 兩個是不同的承諾，
// 卡片上也分開顯示。合成一個的話會分不出「我排晚了」跟「他要得急」。
function wishLate( t ) {
    if ( !t.wishDate || t.status === 'done' ) return false;
    const now = new Date();
    const hhmmNow = `${ String( now.getHours() ).padStart( 2, '0' ) }:${ String( now.getMinutes() ).padStart( 2, '0' ) }`;
    return `${ t.wishDate }T${ t.wishTime || '23:59' }` < `${ todayStr() }T${ hhmmNow }`;
}

// 「希望完成」只有提出需求的本人改得動 —— 負責人與總管理者都不行（2026-09-18 裁定）。
// 伺服器端也是這樣守（isRequester），這支只負責決定「要不要畫出那個表單」。
// ⚠️ 嚴格比 requesterId，⛔ 不像 isMine() 那樣退回比名字 —— isMine 只是決定
//    「我提的需求」那一頁列不列這張單（看錯了頂多多看到一張），這裡是寫入權限。
//    ⇒ v4 之前沒有 requesterId 的舊單沒有「本人」，那幾張誰都改不了（刻意的）。
function canEditWish( t ) {
    // 舊後端還沒重開 ⇒ 那支端點還不存在，畫出來只會得到一顆按了回 404 的按鈕
    if ( !meta.wishApi ) return false;
    if ( !meta.who || t.requesterId !== meta.who ) return false;
    return t.status !== 'done';   // 做完了再改改不動任何事，後端也擋
}

// 「改過 N 次」。⚠️ 開單時填的那個不算改 —— wishLog 只有走 /api/tasks/:id/wish 才會 push，
// 所以 0 次＝從提出到現在沒動過。每一次改了什麼在討論區（系統紀錄那幾條）。
function wishTimesText( t ) {
    if ( !t.wishLog.length ) return '';
    return `<span class="wish-times" title="改過 ${ t.wishLog.length } 次，每次改了什麼在下面的討論裡">`
        + `·改過 ${ t.wishLog.length } 次</span>`;
}

// 估時 / 剩餘時數的輸入。內部一律存小時數（3、1.5），但只吃小時數的話
// 「還要 20 分鐘」得自己換算成 0.33 —— 那是使用者實際抱怨的點。四種寫法都收：
//   1.5 / .5      純數字＝小時
//   1h30m / 1h30 / 1.5h
//   90m / 90分     分鐘
//   1:30 / :30    時:分
// 回傳對齊到整分鐘的小時數；看不懂的回 null。
// ⚠️ 這支要跟 server.js 的 parseHours 同步 —— 後端才是有效力的那一份
//    （前端只負責把 prompt 的回答變成數字、以及擋掉明顯打錯的）。
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

const EST_HINT = '時間看不懂，可以填 1.5、1h30m、90m 或 1:30';

// 估時。被插件過的單，estimate 已經被換成「剩餘」了 —— 只印剩餘會讓人以為
// 這張單本來就這麼小，所以三個數字一起給。
function estText( t ) {
    if ( !t.estimate ) return '';
    // ⚠️ 這三個數字是「原估 ＝ 已做 ＋ 剩」的唯一硬保證，後端算在分鐘上，
    //    所以這裡也要用分鐘印，⛔ 不要先四捨五入成 0.1h 再顯示（會加不起來）。
    const spentH = t.spentMin / 60;
    if ( !spentH || t.estimate0 == null ) return fmtHours( t.estimate );
    return `原估 ${ fmtHours( t.estimate0 ) }・已做 ${ fmtHours( spentH ) }・剩 ${ fmtHours( t.estimate ) }`;
}

function fmtTime( iso ) {
    if ( !iso ) return '';
    const d = new Date( iso );
    return `${ d.getMonth() + 1 }/${ d.getDate() } ${ String( d.getHours() ).padStart( 2, '0' ) }:${ String( d.getMinutes() ).padStart( 2, '0' ) }`;
}

// ── 路由：外層人員牆 ↔ 某個人的看板 ────────────────────────────────────────────

function readHash() {
    const m = /^#m=(.+)$/.exec( location.hash );
    if ( !m ) return { kind: 'people' };
    const id = decodeURIComponent( m[ 1 ] );
    if ( id === OPEN_KEY ) return { kind: 'open' };
    if ( id === MINE_KEY ) return { kind: 'mine' };
    // 網址可能是別人貼給你的，人員名冊隨時會變 —— 認不得就退回人員牆，
    // 不要留在一個永遠空白、看不出為什麼空白的看板上
    if ( !devMembers().some( x => x.id === id ) ) return { kind: 'people' };
    return { kind: 'member', owner: id };
}

// 這個 view 該看到哪些單
function scopeTasks() {
    if ( view.kind === 'member' ) return tasks.filter( t => t.owner === view.owner );
    if ( view.kind === 'open' ) return tasks.filter( t => !t.owner );
    if ( view.kind === 'mine' ) return tasks.filter( isMine );
    return [];
}

// 「我提的需求」。v4 起提出者綁帳號，requesterId 才是身分。
// ⚠️ 但 v4 之前的舊單沒有 requesterId，只認 id 的話那些單會從這一頁整批消失，
// 所以對不上就退回比名字 —— 後端 matchScope 是同一條規則，兩邊要一致。
function isMine( t ) {
    if ( !meta.who ) return false;
    return t.requesterId ? t.requesterId === meta.who : t.requester === memberName( meta.who );
}

function viewTitle() {
    if ( view.kind === 'member' ) return `${ memberName( view.owner ) } 的看板`;
    if ( view.kind === 'open' ) return '還不確定找誰';
    if ( view.kind === 'mine' ) return `${ meta.who ? memberName( meta.who ) : '我' } 提的需求`;
    return '';
}

function memberName( id ) {
    const m = meta.members.find( x => x.id === id );
    return m ? m.name : id;
}

// 會接單的人。編導（director）只提需求，⛔ 不要出現在人員牆與「負責」下拉裡 ——
// 指到編導頭上的單在網頁上沒有任何入口可以再動它。後端 isDev 是同一條規則。
function devMembers() {
    return meta.members.filter( m => m.role !== 'director' );
}

// 這個 view 裡的單，我能不能動內容（轉派、改文字、刪除）
function canEditView() {
    if ( view.kind === 'open' ) return meta.admin;        // 無主單誰接都行，登入就好
    if ( view.kind === 'member' ) return meta.fullAdmin || view.owner === meta.who;
    return false;   // 「我提的需求」是跨人的，在這裡排序等於替別人決定順序
}

// 排程與評估（排序、估時、預計完成日、狀態）只有本人 —— 管理者也不行。
// 後端的 canSchedule 是同一條規則，這裡只是不要畫出按了會 403 的東西。
function canScheduleView() {
    if ( view.kind === 'open' ) return meta.admin;   // 無主的還沒有「本人」，誰接誰排
    if ( view.kind === 'member' ) return view.owner === meta.who;
    return false;
}

function applyView() {
    view = readHash();
    const onBoard = view.kind !== 'people';

    $( '#people-view' ).classList.toggle( 'hidden', onBoard );
    $( '#board-view' ).classList.toggle( 'hidden', !onBoard );
    $( '#crumb' ).classList.toggle( 'hidden', !onBoard );
    $( '#crumb' ).textContent = onBoard ? `← ${ viewTitle() }` : '';

    // 「我提的需求」跟無主收件匣沒有「這個人今天做什麼」可言，時間表藏起來
    $( '#today-panel' ).classList.toggle( 'hidden', view.kind !== 'member' );
    // 提需求是「提給某個人」，在「我提的需求」那頁提會不知道要算誰的。
    // 表單本來就是收起來的，這裡只負責關掉，⛔ 不要 toggle —— 那會在每次
    // 換人、每次自動 refresh 時把它展開。
    // v4 起提需求要登入 —— 提出者綁帳號，沒登入就不知道是誰提的。
    // 沒登入時把按鈕換成一行說明＋登入鍵，⛔ 不要只把按鈕藏掉：那會變成
    // 「編導打開網頁，發現沒有地方可以提需求，也不知道為什麼」。
    // ⚠️ 判準是 meta.who 不是 meta.admin —— 「總管理者」那條後路沒有綁到人，
    //    後端會 401，畫出表單只會讓人填完才被退。
    const canPost = view.kind !== 'mine' && !!meta.who;
    $( '#toggle-new' ).classList.toggle( 'hidden', !canPost );
    $( '#new-locked' ).classList.toggle( 'hidden', view.kind === 'mine' || !!meta.who );
    if ( !canPost ) $( '#form-new' ).classList.add( 'hidden' );
    $( '#new-as-me' ).textContent = meta.who ? memberName( meta.who ) : '—';
    $( '#new-locked-msg' ).textContent = meta.admin
        ? '你是用「總管理者」進來的，那組密碼沒有綁到人。要提需求請用自己的帳號登入。'
        : '提需求要先登入 —— 提出者綁你的帳號，這樣「我提的需求」跟通知才找得到你。';
    $( '#new-hint' ).textContent = view.kind === 'open'
        ? '送出後進「還不確定找誰」，等有人接走。'
        : `送出後會進 ${ viewTitle().replace( ' 的看板', '' ) } 的「待評估」，排序與預計完成時間由他來排。`;

    if ( onBoard ) {
        renderFilters();
        renderBoard();
        if ( view.kind === 'member' ) {
            refreshDayPicker();
            // ⚠️ hashchange → applyView 不會呼叫 refresh()，這裡是第二個掛載點
            // ⛔ 不要拆掉任何一個：catchUpKey 防重複，兩個都要有
            maybeCatchUp();
        }
    } else {
        renderPeople();
    }
}

function goHash( id ) {
    location.hash = id ? `m=${ encodeURIComponent( id ) }` : '';
}

// ── 人員牆 ───────────────────────────────────────────────────────────────────

function renderPeople() {
    const cards = devMembers().map( m => {
        const own = tasks.filter( t => t.owner === m.id );
        const open = own.filter( t => t.status !== 'done' );
        // 「排到幾號」看的是推估、不是我手填的 due —— due 是承諾，推估才是現在的排法真的做得完的日子
        const last = open.map( t => t.projectedDue ).filter( Boolean ).sort().pop();
        return peopleCardHTML( {
            href: m.id,
            icon: '🧑‍💻',
            name: m.name,
            sub: m.id === meta.who ? '你自己' : '',
            edit: meta.fullAdmin ? m.id : '',
            drag: meta.fullAdmin ? m.id : '',
            action: setupActionHTML( m ),
            stats: [
                { n: own.filter( t => t.status === 'doing' ).length, label: '進行中' },
                { n: own.filter( t => t.status === 'inbox' ).length, label: '待評估' },
                { n: open.filter( t => dueClass( t ) === 'overdue' ).length, label: '逾期', bad: true },
            ],
            foot: last ? `目前排到 <b>${ last.slice( 5 ).replace( '-', '/' ) }</b>` : '目前沒有排程中的工作',
        } );
    } );

    if ( meta.fullAdmin ) {
        cards.push( `<article class="people-card add" data-add="1">
            <span class="add-plus">＋</span>
            <div class="add-label">新增人員</div>
            <div class="people-foot">加進來之後發一組起始碼給他</div>
        </article>` );
    }

    const orphan = tasks.filter( t => !t.owner && t.status !== 'done' );
    cards.push( peopleCardHTML( {
        href: OPEN_KEY,
        icon: '📥',
        name: '還不確定找誰',
        sub: '不知道該找哪位就丟這裡',
        stats: [ { n: orphan.length, label: '等人接' } ],
        foot: orphan.length ? '有人會來認領' : '目前是空的',
        muted: true,
    } ) );

    const mine = meta.who ? tasks.filter( t => isMine( t ) && t.status !== 'done' ) : [];
    cards.push( peopleCardHTML( {
        href: MINE_KEY,
        icon: '🙋',
        name: '我提的需求',
        sub: meta.who ? `以「${ esc( memberName( meta.who ) ) }」的身分` : '還沒登入',
        stats: [ { n: mine.length, label: '未完成' } ],
        foot: meta.who ? '跨所有人，看自己的單排到哪' : '登入之後才知道哪些是你提的',
        muted: true,
    } ) );

    // 編導只提需求，沒有「他的看板」可以點進去 —— 但還是要有地方發起始碼、改名、移除，
    // ⛔ 不能只把他們從這一頁藏掉：那會變成新增之後就再也管不到的帳號。
    const dirs = meta.members.filter( m => m.role === 'director' );
    if ( meta.fullAdmin || dirs.length ) {
        cards.push( '<div class="people-sep">編導（只提需求，不接單）</div>' );
        for ( const m of dirs ) {
            cards.push( `<article class="people-card muted flat">
                <div class="people-head">
                    <span class="people-icon">🙋</span>
                    <div>
                        <div class="people-name">${ esc( m.name ) }</div>
                        <div class="people-sub">${ m.id === meta.who ? '你自己' : esc( m.id ) }</div>
                    </div>
                    ${ meta.fullAdmin ? `<button class="people-edit" data-stop="1" data-edit="${ esc( m.id ) }"
                        title="編輯人員">✎</button>` : '' }
                </div>
                <div class="people-foot">${ setupActionHTML( m )
                    || `提過 <b>${ tasks.filter( t => t.requesterId === m.id ).length }</b> 筆` }</div>
            </article>` );
        }
        if ( meta.fullAdmin ) {
            cards.push( `<article class="people-card add flat" data-add="director">
                <span class="add-plus">＋</span>
                <div class="add-label">新增編導</div>
                <div class="people-foot">發起始碼給他，他登入後才能提需求</div>
            </article>` );
        }
    }

    $( '#people-grid' ).innerHTML = cards.join( '' );
    $$( '#people-grid .people-card[data-href]' ).forEach( el =>
        el.addEventListener( 'click', e => {
            if ( e.target.closest( '[data-stop]' ) ) return;   // 發碼／編輯按鈕不算點卡片
            goHash( el.dataset.href );
        } ) );

    $$( '#people-grid [data-add]' ).forEach( el =>
        el.addEventListener( 'click', () => openMemberModal( null, el.dataset.add === 'director' ) ) );
    $$( '#people-grid [data-edit]' ).forEach( b =>
        b.addEventListener( 'click', () => openMemberModal( b.dataset.edit ) ) );

    $$( '#people-grid [data-member]' ).forEach( el => {
        el.addEventListener( 'dragstart', e => {
            peopleDragId = el.dataset.member;
            el.classList.add( 'dragging' );
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData( 'text/plain', peopleDragId );
        } );
        el.addEventListener( 'dragover', e => {
            if ( !peopleDragId || peopleDragId === el.dataset.member ) return;
            e.preventDefault();
            el.classList.add( 'drop-target' );
        } );
        el.addEventListener( 'dragleave', () => el.classList.remove( 'drop-target' ) );
        el.addEventListener( 'drop', e => {
            e.preventDefault();
            el.classList.remove( 'drop-target' );
            dropPerson( el.dataset.member );
        } );
        el.addEventListener( 'dragend', () => {
            peopleDragId = null;
            $$( '#people-grid .people-card' ).forEach( c => c.classList.remove( 'dragging', 'drop-target' ) );
        } );
    } );

    $$( '#people-grid [data-setup]' ).forEach( b =>
        b.addEventListener( 'click', () => issueSetup( b.dataset.setup ) ) );
    $$( '#people-grid [data-revoke]' ).forEach( b =>
        b.addEventListener( 'click', async () => {
            const who = b.dataset.revoke;
            if ( !confirm( `收回 ${ memberName( who ) } 的起始碼？他就不能用那組碼設密碼了。` ) ) return;
            await api( '/api/setup-code', { method: 'POST', body: { who, revoke: true } } )
                .catch( err => toast( err.message, true ) );
            await refresh();
            toast( '已收回' );
        } ) );
}

let peopleDragId = null;

// 人員牆只拖得到程式的卡，但名冊裡編導也在同一串 —— 編導留在原本的位置，
// 程式的那幾格照新順序填回去，再把「全部人」送出去（伺服器要的是完整名單）。
async function dropPerson( targetId ) {
    const dragId = peopleDragId;
    peopleDragId = null;
    if ( !dragId || dragId === targetId ) return;

    const devs = devMembers().map( m => m.id );
    const from = devs.indexOf( dragId );
    const to = devs.indexOf( targetId );
    devs.splice( from, 1 );
    // 往後拖時落在目標「後面」，否則等於沒動（跟工單拖曳同一個規則）
    devs.splice( devs.indexOf( targetId ) + ( from < to ? 1 : 0 ), 0, dragId );

    let k = 0;
    const ids = meta.members.map( m => m.role === 'director' ? m.id : devs[ k++ ] );
    try {
        await api( '/api/members/order', { method: 'POST', body: { ids } } );
    } catch ( err ) { toast( err.message, true ); }
    await refresh();
}

function peopleCardHTML( c ) {
    return `<article class="people-card${ c.muted ? ' muted' : '' }" data-href="${ esc( c.href ) }"
        ${ c.drag ? `draggable="true" data-member="${ esc( c.drag ) }" title="拖曳可以調整順序"` : '' }>
        <div class="people-head">
            <span class="people-icon">${ c.icon }</span>
            <div>
                <div class="people-name">${ esc( c.name ) }</div>
                ${ c.sub ? `<div class="people-sub">${ c.sub }</div>` : '' }
            </div>
            ${ c.edit ? `<button class="people-edit" data-stop="1" data-edit="${ esc( c.edit ) }"
                title="編輯人員">✎</button>` : '' }
        </div>
        <div class="people-stats">
            ${ c.stats.map( s => `<div class="people-stat${ s.bad && s.n ? ' bad' : '' }">
                <b>${ s.n }</b><span>${ s.label }</span></div>` ).join( '' ) }
        </div>
        <div class="people-foot">${ c.action || c.foot }</div>
    </article>`;
}

// 還沒設密碼的人，管理者在這裡發起始碼。放在人員牆上是因為
// 「誰還沒設定」本來就要在這一頁才看得出來，不用另外開一個管理畫面。
function setupActionHTML( m ) {
    if ( !meta.fullAdmin || m.hasPassword ) return '';
    const pending = m.setupCode;
    return `<div class="people-setup" data-stop="1">
        ${ pending
            ? `<span class="hint">起始碼發出去了，還沒用</span>
               <button class="btn small" data-setup="${ esc( m.id ) }">重發</button>
               <button class="btn small" data-revoke="${ esc( m.id ) }">收回</button>`
            : `<span class="hint">還沒設密碼</span>
               <button class="btn small" data-setup="${ esc( m.id ) }">發起始碼</button>` }
    </div>`;
}

async function issueSetup( who ) {
    let r;
    try {
        r = await api( '/api/setup-code', { method: 'POST', body: { who } } );
    } catch ( err ) {
        toast( err.message, true );
        return;
    }
    // 碼只會出現這一次 —— 伺服器那邊存的是雜湊，關掉就看不到了，忘了只能重發
    $( '#modal-body' ).innerHTML = `
        <h2>${ esc( memberName( who ) ) } 的起始碼</h2>
        <p class="hint">把這組碼給本人。他在「🔑 管理模式」選自己的名字，
        填這組碼＋自己想用的密碼，就設定完成了。</p>
        <div class="sub-code">${ esc( r.code ) }</div>
        <p class="hint">
            ${ r.expiresInDays } 天內有效、<b>只能用一次</b>、打錯 10 次就作廢。<br>
            ⛔ 這組碼<b>只顯示這一次</b>（伺服器只存雜湊），關掉就要重發。
        </p>`;
    $( '#modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';
}

// 新增／編輯人員。id 為 null 是新增，newDirector 決定新增時預設哪個角色。
function openMemberModal( id, newDirector ) {
    const m = id ? meta.members.find( x => x.id === id ) : null;
    const isDir = m ? m.role === 'director' : !!newDirector;

    $( '#modal-body' ).innerHTML = `
        <h2>${ m ? `編輯 ${ esc( m.name ) }` : ( isDir ? '新增編導' : '新增人員' ) }</h2>
        <div class="field">
            <span>顯示名稱</span>
            <input id="mem-name" maxlength="20" placeholder="王小明" value="${ m ? esc( m.name ) : '' }">
        </div>
        <div class="field">
            <span>代號</span>
            ${ m
                // 代號是 tasks[].owner 的鍵，改了他名下的單會全部變孤兒，所以不給改
                ? `<div class="mem-id-fixed">${ esc( m.id ) }<span class="hint">代號建立後不能改</span></div>`
                : `<input id="mem-id" maxlength="24" placeholder="xiaoming" autocapitalize="off" autocorrect="off">
                   <span class="hint">英數與 - _，之後會出現在網址裡，不能再改</span>` }
        </div>
        <div class="field">
            <span>角色</span>
            <select id="mem-role">
                <option value="dev"${ isDir ? '' : ' selected' }>程式（接單、有自己的看板）</option>
                <option value="director"${ isDir ? ' selected' : '' }>編導（只提需求，不出現在人員牆）</option>
            </select>
            <span class="hint">編導也要登入才能提需求，所以一樣要發起始碼。</span>
        </div>
        <label class="check mem-check">
            <input type="checkbox" id="mem-admin" ${ m && m.admin ? 'checked' : '' }>
            <span>全權管理者（能排所有人的單、發起始碼、推播）</span>
        </label>
        <div class="modal-actions">
            ${ m && m.id !== meta.who ? '<button class="btn danger" id="mem-del">移除</button>' : '' }
            <button class="btn primary" id="mem-save">${ m ? '儲存' : '新增' }</button>
        </div>`;
    $( '#modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';
    $( '#mem-name' ).focus();

    $( '#mem-save' ).addEventListener( 'click', async () => {
        const name = $( '#mem-name' ).value.trim();
        const admin = $( '#mem-admin' ).checked;
        const role = $( '#mem-role' ).value;
        // 把自己降權會當場失去這一頁的所有按鈕（伺服器會踢掉 session），先講清楚
        if ( m && m.id === meta.who && m.admin && !admin
            && !confirm( '取消自己的全權後會立刻登出，要重新登入才能繼續。確定嗎？' ) ) return;
        try {
            if ( m ) await api( `/api/members/${ encodeURIComponent( m.id ) }`, { method: 'PATCH', body: { name, admin, role } } );
            else await api( '/api/members', { method: 'POST', body: { id: $( '#mem-id' ).value.trim(), name, admin, role } } );
        } catch ( err ) { return toast( err.message, true ); }
        closeModal();
        await refresh();
        toast( m ? '已更新' : '已新增，記得發一組起始碼給他' );
    } );

    // 自己的視窗沒有移除鈕：移除＝連帳號一起刪，刪自己就再也登不進來
    if ( m && m.id !== meta.who ) $( '#mem-del' ).addEventListener( 'click', async () => {
        if ( !confirm( `移除 ${ m.name }？他的密碼與排程紀錄都會一起刪掉。名下還有單的話會擋下來。` ) ) return;
        try {
            await api( `/api/members/${ encodeURIComponent( m.id ) }`, { method: 'DELETE' } );
        } catch ( err ) { return toast( err.message, true ); }
        closeModal();
        await refresh();
        toast( '已移除' );
    } );
}

// ── render ───────────────────────────────────────────────────────────────────

function currentFilter() {
    return {
        project: $( '#filter-project' ).value,
        requester: $( '#filter-requester' ).value,
        showDone: $( '#filter-done' ).checked,
        q: $( '#filter-q' ).value.trim().toLowerCase(),
    };
}

// 搜尋比對的範圍。⚠️ 連 id 一起比是刻意的 —— TG 通知跟留言裡都是寫 t0012 這種單號，
//    貼進來要找得到。留言也比，因為「那件事後來怎麼了」常常只寫在留言裡。
function taskHaystack( t ) {
    return [ t.id, t.title, t.detail, t.note, t.project, t.requester ]
        .concat( ( t.comments || [] ).map( c => c.text ) )
        .join( '\n' ).toLowerCase();
}

function visibleTasks() {
    const f = currentFilter();
    return scopeTasks().filter( t => {
        if ( f.project && t.project !== f.project ) return false;
        if ( f.requester && t.requester !== f.requester ) return false;
        // ⚠️ 有打關鍵字時**刻意忽略**「顯示已完成」—— 找得到才是搜尋的意義。
        //    不然打了字卻一片空白，人只會以為這張單根本不存在。
        if ( !f.q && !f.showDone && t.status === 'done' ) return false;
        if ( f.q && !taskHaystack( t ).includes( f.q ) ) return false;
        return true;
    } );
}

function renderBoard() {
    const board = $( '#board' );
    const list = visibleTasks();

    // 今日排程看的是這個人全部的待辦，不受左邊的篩選影響
    if ( view.kind === 'member' ) renderToday();

    if ( !list.length ) {
        board.innerHTML = elsewhereHint() + '<div class="panel empty">目前沒有符合條件的項目。</div>';
        return;
    }

    let html = '';
    for ( const st of GROUP_ORDER ) {
        const group = list.filter( t => t.status === st );
        if ( !group.length ) continue;
        html += `<section class="group" data-status="${ st }">
            <div class="group-head">${ STATUS_ICON[ st ] } ${ STATUS_LABEL[ st ] } <span class="count">${ group.length }</span></div>
            ${ group.map( cardHTML ).join( '' ) }
        </section>`;
    }
    board.innerHTML = elsewhereHint() + html;
    bindCards();
}

// 搜尋只看得到「眼前這個看板」（跟專案／提出者兩個篩選同一套規則）。
// ⚠️ 少了這行提示的話，在 A 的看板搜不到就會以為全公司都沒有這張單，
//    其實只是它在 B 那邊 —— 那種找不到比沒有搜尋更糟。
function elsewhereHint() {
    const f = currentFilter();
    if ( !f.q ) return '';
    const here = new Set();
    scopeTasks().forEach( t => here.add( t.id ) );
    const n = tasks.filter( t => !here.has( t.id ) && taskHaystack( t ).includes( f.q ) ).length;
    if ( !n ) return '';
    return `<div class="panel hint-line">🔎 其他看板還有 <b>${ n }</b> 筆符合「${ esc( f.q ) }」——
        回人員頁（左上角 ←）切過去看。</div>`;
}

// 「⬇ CSV」下載哪些單。⚠️ 標題要講清楚拿到的是什麼 ——
//    以為匯出的是眼前篩選後的結果、實際拿到全部，是會出事的那種誤會。
function syncExportLink() {
    const a = $( '#export-csv' );
    if ( view.kind === 'member' ) {
        a.href = '/api/export.csv?owner=' + encodeURIComponent( view.owner );
        a.title = `下載 ${ memberName( view.owner ) } 的全部工單（CSV，不受上面的篩選影響）`;
    } else if ( view.kind === 'open' ) {
        a.href = '/api/export.csv?owner=';
        a.title = '下載「還不確定找誰」的全部工單（CSV）';
    } else {
        // 「我提的需求」是照 requesterId 分的，後端那支只認 owner，給不出對應的子集，
        // 所以退回全部 —— 寧可多，不要給一份內容對不上標題的檔案。
        a.href = '/api/export.csv';
        a.title = '下載全部工單（CSV，所有人）';
    }
}

function cardHTML( t ) {
    const dc = dueClass( t );
    const drag = canScheduleView();   // 排序＝排程，只有本人
    // 推估完成日是排出來的後果，跟我手填的 due 是兩件事，所以另外標。
    // 只有還沒手填 due 的才顯示，否則同一張卡上兩個日期會不知道該信哪個。
    const proj = !t.due && t.projectedDue && t.status !== 'done'
        ? `<span class="proj" title="照目前順序與估時推出來的">≈ ${ t.projectedDue.slice( 5 ).replace( '-', '/' ) }</span>` : '';
    return `<article class="card s-${ t.status }" data-id="${ t.id }" draggable="${ drag }">
        ${ drag ? '<div class="handle" title="拖曳排序">⠿</div>' : '' }
        <div class="card-main">
            <div class="card-title">${ esc( t.title ) }</div>
            <div class="card-meta">
                ${ t.project ? `<span class="tag">${ esc( t.project ) }</span>` : '' }
                <span class="tag plain">${ esc( t.requester ) }</span>
                ${ view.kind === 'mine' ? `<span class="tag plain">👤 ${ esc( ownerLabel( t.owner ) ) }</span>` : '' }
                <span class="due ${ dc }">📅 ${ dueText( t ) }</span>
                ${ proj }
                ${ t.estimate ? `<span>⏱ ${ estText( t ) }</span>` : '' }
                ${ t.wishDate ? `<span class="wish${ wishLate( t ) ? ' late' : '' }">🙏 希望 ${ wishText( t ) }${ wishTimesText( t ) }</span>` : '' }
                ${ t.comments.length ? `<span>💬 ${ t.comments.length }</span>` : '' }
            </div>
            ${ adminBarHTML( t ) }
        </div>
    </article>`;
}

function ownerLabel( id ) {
    return id ? memberName( id ) : '還沒指定';
}

// 一張卡的操作列。兩種權限混在同一列裡：
//   狀態／估時／預計完成 —— 排程與評估，只有本人（canScheduleView）
//   負責／刪除           —— 內容與歸屬，管理者也能動（canEditView）
// 兩邊都沒有就整列不畫。
function adminBarHTML( t ) {
    const sched = canScheduleView();
    const edit = canEditView();
    if ( !sched && !edit ) return '';

    const opts = Object.keys( STATUS_LABEL )
        .map( s => `<option value="${ s }"${ s === t.status ? ' selected' : '' }>${ STATUS_LABEL[ s ] }</option>` ).join( '' );
    // 轉派只有總管理者能做；無主的單則是誰登入誰都能接走，但只能接給自己
    // ⚠️ 候選只列 devMembers —— 轉派給編導的單，在人員牆上沒有入口可以再動它
    const owners = meta.fullAdmin
        ? [ { id: '', name: '還沒指定' }, ...devMembers() ]
        : ( !t.owner && meta.who && meta.myRole !== 'director'
            ? [ { id: '', name: '還沒指定' }, { id: meta.who, name: '接給我' } ] : null );
    return `<div class="admin-bar" data-stop="1">
        ${ sched ? `
        <label>狀態 <select data-act="status">${ opts }</select></label>
        <label>估時 <input type="text" size="7" data-act="estimate" value="${ t.estimate == null ? '' : fmtHours( t.estimate ) }" placeholder="1h30m" title="可以填 1.5、1h30m、90m 或 1:30"></label>
        <label>預計完成 <input type="date" data-act="due" value="${ t.due || '' }"></label>` : '' }
        ${ edit && owners ? `<label>負責 <select data-act="owner">${ owners.map( m =>
            `<option value="${ esc( m.id ) }"${ m.id === t.owner ? ' selected' : '' }>${ esc( m.name ) }</option>`
        ).join( '' ) }</select></label>` : '' }
        ${ edit ? '<button class="btn sm danger" data-act="delete">刪除</button>' : '' }
    </div>`;
}

function renderFilters() {
    const scoped = scopeTasks();
    // 篩選器只列這個 view 裡真的有的值 —— 列全部的話會有一半選了是空的
    const projects = [ ...new Set( scoped.map( t => t.project ).filter( Boolean ) ) ].sort();
    const requesters = [ ...new Set( scoped.map( t => t.requester ).filter( Boolean ) ) ].sort();
    fillSelect( $( '#filter-project' ), projects );
    fillSelect( $( '#filter-requester' ), requesters );
    syncExportLink();

    // 這兩個 datalist 是拿來「填新資料」的，候選要用全庫的，不能只有眼前這個人的
    $( '#project-list' ).innerHTML = [ ...new Set( tasks.map( t => t.project ).filter( Boolean ).concat( meta.projects ) ) ]
        .sort().map( p => `<option value="${ esc( p ) }">` ).join( '' );

    const open = scoped.filter( t => t.status !== 'done' );
    const overdue = open.filter( t => dueClass( t ) === 'overdue' ).length;
    const hours = open.reduce( ( s, t ) => s + ( t.estimate || 0 ), 0 );
    $( '#stats' ).innerHTML =
        `未完成 <b>${ open.length }</b>` +
        ` · 待評估 <b>${ scoped.filter( t => t.status === 'inbox' ).length }</b>` +
        ` · 已估工時 <b>${ fmtHours( hours ) }</b>` +
        ( overdue ? ` · <b style="color:var(--danger)">逾期 ${ overdue }</b>` : '' );
}

function fillSelect( sel, values ) {
    const keep = sel.value;
    sel.innerHTML = '<option value="">全部</option>' + values.map( v => `<option value="${ esc( v ) }">${ esc( v ) }</option>` ).join( '' );
    if ( values.indexOf( keep ) >= 0 ) sel.value = keep;
}

// ── 今日預估 ─────────────────────────────────────────────────────────────────

// 上班時段（分鐘，從午夜起算）。真正的定義在 config.json 的 workHours，
// 開機後由 meta 覆蓋掉 —— 前後端各寫一份遲早會對不起來。
let BLOCKS = [
    { start: 9 * 60, end: 12 * 60 + 30, label: '上午', ot: false },
    { start: 13 * 60 + 30, end: 18 * 60, label: '下午', ot: false },
    { start: 18 * 60 + 30, end: 22 * 60, label: '加班', ot: true },
];

function applyWorkHours( w ) {
    if ( !w || !w.normal ) return;
    const names = [ '上午', '下午', '午後' ];
    BLOCKS = [
        ...w.normal.map( ( b, i ) => ( { start: b.start, end: b.end, label: names[ i ] || `時段${ i + 1 }`, ot: false } ) ),
        ...w.overtime.map( b => ( { start: b.start, end: b.end, label: '加班', ot: true } ) ),
    ];
}

// 說明視窗那張工時表、以及排程表底下那行提示的數字。⛔ 不要在 HTML 裡寫死 ——
//    config.json 改了工時，排程會跟著動、說明文字卻不會，對不起來比沒寫還糟。
//    來源一律是 BLOCKS（開機時已經被 meta 覆蓋過了）。
function renderWorkHoursText() {
    const span = b => `${ hhmm( b.start ) }–${ hhmm( b.end ) }`;
    const hours = b => String( +( ( b.end - b.start ) / 60 ).toFixed( 2 ) );
    const normal = BLOCKS.filter( b => !b.ot );
    const ot = BLOCKS.filter( b => b.ot );
    $( '#wh-hint' ).textContent = `工時 ${ normal.map( span ).join( '、' ) }`
        + ( ot.length ? `（加班 ${ ot.map( span ).join( '、' ) } 不排單）` : '' ) + '。';
    $( '#help-wh' ).innerHTML = BLOCKS.map( b =>
        `<tr><th>${ esc( b.label ) }</th><td>${ span( b ) }（${ hours( b ) }h）`
        + ( b.ot ? '—— ⛔ <b>不排單</b>，排不完的進「⛔ 做不完」；真的做到這個時間的照實畫' : '' )
        + '</td></tr>' ).join( '' );
}

// 固定會議（每週某天的某段時間）。定義在 config.json，開機後由 meta 帶進來。
let MEETINGS = [];

function applyMeetings( list ) {
    MEETINGS = Array.isArray( list ) ? list : [];
}

// 某一天要開的會。members 沒填＝全員；填了就只算名單上的人。
function meetingsOn( date, who ) {
    const dow = new Date( `${ date }T00:00:00` ).getDay();
    return MEETINGS.filter( m => m.weekday === dow && ( !m.members || m.members.indexOf( who ) >= 0 ) );
}

// 今天要開的會。看別人的頁面時要用那個人的身分算，不是用我的。
function meetingsToday() {
    return meetingsOn( todayStr(), view.kind === 'member' ? view.owner : meta.who );
}

// ⭐ P6：`config.json` 的 meetings 是手改的，兩場會有可能撞在一起（16:00–17:00 與
//    16:30–17:30）。扣時間的時候一場一場扣，重疊的那半小時就被扣兩次 ⇒
//    workMinutesBetween 變負數、整段時間表畫不出來。所以扣之前先把重疊的併起來。
// ⚠️ 只有「扣時間」要用併好的；畫格子那條（blockSpans）要的是每一場自己的標題，
//    ⛔ 不要拿這個去取代 meetingsOn() / meetingsToday()。
// ⚠️ 併完是互不重疊的 ⇒ 扣掉的總和一定 ≤ 那段時間的上班分鐘，所以結果不會再是負數。
function busyMerged( list ) {
    const out = [];
    for ( const m of list.slice().sort( ( a, b ) => a.start - b.start ) ) {
        const last = out[ out.length - 1 ];
        if ( last && m.start <= last.end ) last.end = Math.max( last.end, m.end );
        else out.push( { start: m.start, end: m.end } );
    }
    return out;
}

// 排程只吃正常工時。加班段（config 的 overtime）只留著顯示，⛔ 不拿來排單 ——
//    2026-09-21 裁決：排不完就是排不完，要不要留下來是人自己決定的，
//    看板不該替人假設他會做到 22:00。
// ⚠️ 後端的完成日推估（server.js freeBlocks）本來就只吃 normal ⇒ 這是去對齊它，
//    以前是「≈ 當你不加班、右邊那張表當你一定加班」兩套假設打架。
function planBlocks() {
    return BLOCKS.filter( b => !b.ot );
}

function hhmm( m ) {
    return `${ Math.floor( m / 60 ) }:${ String( m % 60 ).padStart( 2, '0' ) }`;
}

// 預設起排時間＝現在往上取整到 5 分鐘，並夾進最近的上班時段
function defaultStartMin() {
    const d = new Date();
    const m = Math.ceil( ( d.getHours() * 60 + d.getMinutes() ) / 5 ) * 5;
    for ( const b of planBlocks() ) {
        if ( m <= b.start ) return b.start;
        if ( m < b.end ) return m;
    }
    return planBlocks()[ 0 ].start;   // 已經過了下班時間，當作明天早上
}

// 今天「已經發生過的事」最早結束在幾點：做完的走 doneAt、被插件的走 spans 的 to。
// 今天還沒發生過任何事就回 null。⚠️ 判斷條件要跟 pastEntries 一模一樣 ——
// 兩邊對不起來的話，會出現「起排往前拉了，但那件事還是沒被畫出來」。
// ⛔ 所以第二關（工作分鐘要 > 0）也要照抄：上班時間之前、或被會議整段吃掉的事件，
//    pastEntries 會直接丟掉。少了這一關就會把起排拉到上班時間，但那件事依然畫不
//    出來 —— 整個早上被還沒做的單填滿，看起來像「我九點就在做這些」。
function earliestPastMin( all ) {
    const today = todayStr();
    let earliest = null;
    const take = at => {
        if ( localDate( at ) !== today ) return;
        const m = localMin( at );
        // 以上班時間為錨點畫不出來的（min <= 0），拉了也沒用，不算數。
        if ( workMinutesBetween( BLOCKS[ 0 ].start, m ) <= 0 ) return;
        if ( earliest === null || m < earliest ) earliest = m;
    };
    for ( const t of all ) {
        if ( t.status === 'done' && t.doneAt ) take( t.doneAt );
        for ( const sp of t.spans ) take( sp.to );
    }
    return earliest;
}

// 當天第一次打開看板時，起排要定在哪。
// ⚠️ ⛔ 不可以只用「現在」—— 今天已經做完的單如果落在起排之前，pastEntries 會
//    整批丟掉（那條規則本身是對的：那段時間不在這張表的範圍裡），結果就是
//    整個早上顯示「未排」、今天做完的東西從時間表上全部消失。
//    2026-09-17 真的踩到：服務掛了一早上，11:20 才第一次打開看板，
//    11:18 做完的單只差兩分鐘就被丟掉，9:00–11:20 全成了「未排」。
// 所以今天只要已經發生過事，就從上班時間開始排，讓那些事有位置站。
function initialStartMin( all ) {
    return earliestPastMin( all ) === null ? defaultStartMin() : BLOCKS[ 0 ].start;
}

// 那一格是 <input type="time">，只吃兩位數的時。
function startValue( min ) {
    return hhmm( min ).replace( /^(\d):/, '0$1:' );
}

// 誰能調這個人的起排：本人，或管理者（同事遲到／請假時要幫他調）。
// ⚠️ 後端 /api/day-start 擋的是同一條 —— 這裡只是不要讓人白按。
// ⚠️ 這比 canScheduleView() 鬆（那個只准本人），因為起排不會動到任何人的單、
//    估時或順序，只決定這張表從幾點開始畫。
function canEditStart() {
    return view.kind === 'member' && ( view.owner === meta.who || meta.admin );
}

// 把某個人今天的起排寫回伺服器，順手更新手上這份表（不等回應，那一格才不會頓）。
// ⛔ 要先更新 dayStarts 再送 —— 不然 20 秒輪詢會在回應回來之前又自動定一次。
function saveStart( owner, min, auto ) {
    const val = { min, auto: !!auto, by: meta.who || '', at: new Date().toISOString() };
    dayStarts[ owner ] = val;
    if ( startsApiMissing ) return;
    const p = { val, since: undefined };
    pendingStarts.set( owner, p );
    api( '/api/day-start', { method: 'POST',
        body: { date: todayStr(), owner, min, auto: !!auto } } ).then(
        // 成功：從下一輪輪詢起，回應裡就一定含得到它了。
        () => { p.since = pollSeq; },
        // 失敗：伺服器上根本沒有這筆，⛔ 不能再用它去蓋輪詢拿回來的東西。
        // ⚠️ 比對的是「還是不是我這一次送的那筆」—— 期間又被調過的話不能刪，
        //    刪掉會讓後來那次的寫入被輪詢的舊資料蓋回去。
        e => { if ( pendingStarts.get( owner ) === p ) pendingStarts.delete( owner );
            toast( e.message, true ); } );
}

// 把「正在看的這個人」今天的起排填進那一格。
// ⚠️ 伺服器上已經有值就一律照用，⛔ 不要再重算 —— 重算等於每按一次完成就把起排
//    往回搬，剛做完的那張單會被記成做了一整個上午（估時才 1 小時）。
//    「當天只決定一次」這件事現在是靠伺服器上有沒有那筆值來保證的。
function applyStartForView() {
    // ⚠️ 單還沒到手之前不准定案 —— 那個當下看起來一定像「今天什麼都沒發生」，
    //    會把起排定在「現在」，正好就是 v5.1 修掉的那個 bug。
    if ( !dataLoaded ) return;
    const owner = view.owner;
    const saved = dayStarts[ owner ];
    // ⛔ 只有自己的看板才准寫。管理者路過看別人一眼，不該把人家的起排定死在
    //    「他被看到的那一刻」—— 那個人可能還沒到公司。別人的看板只是照算出來的
    //    畫給你看，等他自己開的時候才定案。（也不准替別人「救」，見下面。）
    const mine = owner === meta.who;

    if ( saved ) {
        $( '#day-start' ).value = startValue( saved.min );
        // 人自己（或管理者）調過的（auto=false）絕對不動 —— 他可能就是要只看下午。
        if ( !mine || !saved.auto ) return;
        // 自動定的還留一條救援：只有「今天已經發生過的事正被這個值擋在外面」才重定。
        // ⛔ 不可以無條件重算 —— 那樣每按一次完成都會把起排往回搬：14:00 打開、
        //    14:30 按完成，起排跳回 9:00，剛做完那張單被記成做了一整個上午。
        const earliest = earliestPastMin( scopeTasks() );
        if ( earliest === null || earliest >= saved.min ) return;
        const fixed = initialStartMin( scopeTasks() );
        $( '#day-start' ).value = startValue( fixed );
        saveStart( owner, fixed, true );
        return;
    }

    const want = initialStartMin( scopeTasks() );
    $( '#day-start' ).value = startValue( want );
    if ( mine ) saveStart( owner, want, true );
}

function getStartMin() {
    const v = $( '#day-start' ).value;
    if ( !v ) return defaultStartMin();
    const [ h, m ] = v.split( ':' ).map( Number );
    return h * 60 + m;
}

// [from, to) 之間真正算上班的分鐘數。中午休息、下班到加班之間的空檔要扣掉，
// 不然做一整個下午的單會被算成連午休也在做。
function workMinutesBetween( from, to ) {
    let n = 0;
    for ( const b of BLOCKS ) n += Math.max( 0, Math.min( to, b.end ) - Math.max( from, b.start ) );
    // 開會的時間不是花在那張單上的。不扣掉的話，跨過會議才做完的單會多背一小時「實際」。
    // 跟 BLOCKS 取交集是為了避免會議壓到午休時被扣兩次。
    // ⚠️ busyMerged：⛔ 不要改回直接跑 meetingsToday()，重疊的會議會被扣兩次（P6）。
    for ( const m of busyMerged( meetingsToday() ) ) {
        for ( const b of BLOCKS ) {
            n -= Math.max( 0, Math.min( to, m.end, b.end ) - Math.max( from, m.start, b.start ) );
        }
    }
    return n;
}

// 某一天的 [from, to) 有幾分鐘算上班。跟 workMinutesBetween 同一套算法，
// 差別是日期要自己給 —— 「被插件」那段要往回算到好幾天前。
function workMinutesOnDay( date, from, to, who ) {
    let n = 0;
    for ( const b of BLOCKS ) n += Math.max( 0, Math.min( to, b.end ) - Math.max( from, b.start ) );
    // ⚠️ 跟 workMinutesBetween 一樣要先併重疊的（P6）。
    for ( const mt of busyMerged( meetingsOn( date, who ) ) ) {
        for ( const b of BLOCKS ) {
            n -= Math.max( 0, Math.min( to, mt.end, b.end ) - Math.max( from, mt.start, b.start ) );
        }
    }
    return n;
}

// 兩個時間戳之間真正算上班的分鐘數，會跨天。拿來推「這一輪做掉多久」。
// ⚠️ 假日直接跳過（BLOCKS 是上班時段，週末沒有）。國定假日不知道，會多算一天 ——
//    所以這個數字只拿來當**預設值**，送出前一定讓人改，⛔ 不要拿它直接寫進 estimate。
function workMinutesSpan( fromISO, toISO, who ) {
    const first = localDate( fromISO );
    const last = localDate( toISO );
    if ( first > last ) return 0;

    let n = 0;
    const d = new Date( fromISO );
    d.setHours( 0, 0, 0, 0 );
    // 上限純粹是別讓一個壞掉的時間戳把瀏覽器轉死；正常情況幾天就跑完了
    for ( let i = 0; i < 400; i++ ) {
        const date = `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
        if ( date > last ) break;
        const dow = d.getDay();
        if ( dow !== 0 && dow !== 6 ) {
            n += workMinutesOnDay( date,
                date === first ? localMin( fromISO ) : 0,
                date === last ? localMin( toISO ) : 24 * 60, who );
        }
        d.setDate( d.getDate() + 1 );
    }
    return n;
}

function localMin( iso ) {
    const d = new Date( iso );
    return d.getHours() * 60 + d.getMinutes();
}

function localDate( iso ) {
    const d = new Date( iso );
    return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
}

// 今天已經發生過的事，要照發生順序佔住它真的花掉的那段時間。兩種來源：
//   done ＝今天做完的（doneAt）
//   cut  ＝今天做到一半被插件、離開「進行中」的（spans）
// 不留痕跡的話，按下完成／被插件的當下後面整批會往前塌 —— 起排是當天凍結的
//（見 init 那段註解），所以塌進去的是已經過去的時段，表上就會說「16:05 開始做」
// 而現在已經 17:40 了；被插件那種更糟，那個時段會直接顯示成另一張進行中的單。
// 時長用「上一件結束 → 這一件結束」的實際間隔推，不用估時也不用 span.min：
// 估時是事前猜的，這裡有真的時間戳可以用，而且我們要的本來就是
//「時間真的花到哪去了」。⛔ 不要改成用 span.min —— 那是人回報的工作量，
// 中間跑去做別的它不知道，拿來當長度會跟時間軸對不起來。
function pastEntries( all, startMin ) {
    const today = todayStr();
    const events = [];
    for ( const t of all ) {
        if ( t.status === 'done' && t.doneAt && localDate( t.doneAt ) === today ) {
            events.push( { task: t, at: t.doneAt, kind: 'done' } );
        }
        for ( const sp of t.spans ) {
            if ( localDate( sp.to ) === today ) events.push( { task: t, at: sp.to, kind: 'cut' } );
        }
    }
    events.sort( ( a, b ) => a.at.localeCompare( b.at ) );

    const out = [];
    let anchor = startMin;
    let i = 0;
    while ( i < events.length ) {
        // 結束在同一分鐘的算一群。⛔ 不可以一筆一筆看：舊版是這樣寫的，
        // 第二筆之後的「工作分鐘 ＝ 0」就被下面那關丟掉，整張單從時間表上消失。
        // 早上忘了記、11:18 一次補登三張是真的會發生的（2026-09-17 那次災情就是
        // 這樣來的），而且那天的症狀跟這個一模一樣：做完的事看不到了。
        const at = localMin( events[ i ].at );
        let j = i;
        while ( j < events.length && localMin( events[ j ].at ) === at ) j++;
        const group = events.slice( i, j );
        i = j;

        const min = workMinutesBetween( anchor, at );
        // 起排之前就結束的不畫，也不推進 anchor —— 那段時間不在這張表的範圍裡
        if ( min <= 0 ) continue;
        // 一群人平分它們共同佔住的那段。doneAt 的解析度就是分鐘，一次補登好幾張時
        // 我們**確實不知道**各花多久 —— 平分是沒有資訊時的中立分法，
        // ⛔ 不要拿估時或 span.min 去分（那是事前猜的／人回報的工作量，不是時鐘）。
        // ⚠️ 一定要切成整分鐘：帶小數的話 hhmm() 會印出「9:34.5」這種東西。
        // ⚠️ split > 1 的那幾筆長度是分出來的，畫面上要標示（renderPlan 的 ~）。
        // 同一分鐘結束的**放同一個時間段**（一格、列出每一張），2026-09-17 使用者裁定。
        // ⛔ 不要改回「把這幾分鐘平分給它們各自一格」—— 那條路走過兩次都不行：
        //   ⒜ 分到 0 分鐘的那張 renderPlan 會跳過 ⇒ 整張單從表上消失（災情本體）。
        //      「同一分鐘結束的張數 > 可分的分鐘數」是真的會發生的：15:29:40 才剛
        //      結束一件，15:30:16 與 15:30:18 又按了兩張 ⇒ 只有 1 分鐘要分給 2 張。
        //   ⒝ 補成「每張至少 1 分鐘」就得跟後面借時間，段長加起來比真正過去的時間長，
        //      還沒做的單看起來晚開始；而且平分出來的長度本來就是假的
        //      —— doneAt 的解析度只到分鐘，各花多久我們**根本不知道**。
        // 放同一格則三件事都成立：沒有單消失、時間軸不變形、也沒有編出來的長度。
        out.push( {
            task: group[ 0 ].task, min, past: true, kind: group[ 0 ].kind,
            also: group.slice( 1 ).map( e => ( { task: e.task, kind: e.kind } ) ),
        } );
        anchor = at;
    }
    return out;
}

// 把一個上班時段照今天的會議切成好幾截，會議那幾截標上 meeting。沒會議就回一截。
function blockSpans( b ) {
    let spans = [ { from: b.start, to: b.end } ];
    for ( const m of meetingsToday() ) {
        const next = [];
        for ( const sp of spans ) {
            if ( sp.meeting || m.end <= sp.from || m.start >= sp.to ) { next.push( sp ); continue; }
            if ( sp.from < m.start ) next.push( { from: sp.from, to: m.start } );
            next.push( { from: Math.max( sp.from, m.start ), to: Math.min( sp.to, m.end ), meeting: m.title } );
            if ( m.end < sp.to ) next.push( { from: m.end, to: sp.to } );
        }
        spans = next;
    }
    return spans;
}

// 把待辦依序塞進時段。回傳每個時段的分段、塞不下的、以及沒估時的。
// ⚠️ 只會拿來算「今天」—— 回看歷史畫的是存下來的快照，不會走到這裡。
function planDay( startMin ) {
    const mine = scopeTasks();
    const queue = [];
    for ( const st of [ 'doing', 'todo' ] ) {
        queue.push( ...mine.filter( t => t.status === st ).sort( ( a, b ) => a.order - b.order ) );
    }
    const noEstimate = queue.filter( t => !( t.estimate > 0 ) );

    // 已經發生過的排在最前面（照發生順序），接著才是還沒做的。
    // ⚠️ 被插件的單會同時出現在兩邊：前面一段灰色的「今天已經做掉的」，
    //    後面一段是它剩下的估時 —— 這是對的，不要去重。
    const ready = [
        ...pastEntries( mine, startMin ),
        ...queue.filter( t => t.estimate > 0 ).map( t => ( { task: t, min: t.estimate * 60, past: false } ) ),
    ];

    const groups = BLOCKS.map( b => ( { block: b, segs: [] } ) );
    let qi = 0;
    let rem = ready.length ? ready[ 0 ].min : 0;

    for ( const g of groups ) {
        const b = g.block;
        if ( startMin > b.start ) {
            g.segs.push( { from: b.start, to: Math.min( startMin, b.end ), free: '未排' } );
        }
        if ( startMin >= b.end ) continue;

        // 一個時段可能被會議切成好幾截，要一截一截塞。沒有會議時就只有一截，
        // 行為跟以前一模一樣。
        for ( const sp of blockSpans( b ) ) {
            let cur = Math.max( sp.from, startMin );
            if ( cur >= sp.to ) continue;
            if ( sp.meeting ) {
                g.segs.push( { from: cur, to: sp.to, meeting: sp.meeting, ot: b.ot } );
                continue;
            }
            while ( cur < sp.to && qi < ready.length ) {
                // ⛔ 加班段不排「還沒做的」（見 planBlocks 的註解）。
                // ⚠️ 但**今天真的做到那個時間**的照實畫 —— 不然一個做到 21:00 的人
                //    超出 8 小時的那幾張會從表上默默消失（overflow 會把 past 濾掉），
                //    那正是 v5 之前「做完的事看不到了」那個災情。
                if ( b.ot && !ready[ qi ].past ) break;
                const take = Math.min( rem, sp.to - cur );
                g.segs.push( { from: cur, to: cur + take, entry: ready[ qi ], ot: b.ot } );
                cur += take;
                rem -= take;
                if ( rem <= 0 ) {
                    qi += 1;
                    rem = ready[ qi ] ? ready[ qi ].min : 0;
                }
            }
            if ( cur < sp.to ) g.segs.push( { from: cur, to: sp.to, free: '空檔' } );
        }
    }

    // 同一張單被切成好幾段時要標「續」
    const seen = new Map();
    for ( const g of groups ) {
        for ( const s of g.segs ) {
            if ( !s.entry ) continue;
            const n = ( seen.get( s.entry.task.id ) || 0 ) + 1;
            seen.set( s.entry.task.id, n );
            s.part = n;
            // 跟它放在同一個時間段的那幾張也要記帳，否則它們之後自己那一段不會標「續」
            for ( const a of s.entry.also || [] ) seen.set( a.task.id, ( seen.get( a.task.id ) || 0 ) + 1 );
        }
    }

    // 排不完的。第一筆可能已經排了一部分（時段被切斷），要回報「還差多少」
    // 而不是整筆的估時 —— 否則同一筆會同時出現在時間表和排不完清單裡。
    // ⚠️ 先 map 再 filter：partial 判斷靠的是「是不是切斷處那一筆」，
    // 先濾掉已完成的會把索引錯開。
    const overflow = ready.slice( qi )
        .map( ( e, i ) => ( {
            task: e.task, past: e.past,
            remainMin: i === 0 ? rem : e.min,
            partial: i === 0 && rem < e.min,
        } ) )
        .filter( o => !o.past );   // 已經發生過的不可能「做不完」

    return { groups, overflow, noEstimate, planned: ready.slice( 0, qi ).map( e => e.task ) };
}

// 到期標記。隔天再看的時候「今日到期」會變成「已逾期」，不能只判斷等於今天
function dueFlag( t, today ) {
    if ( !t.due || t.status === 'done' ) return '';   // 做完的還掛「今日到期」只是雜訊
    if ( t.due === today ) return '· ⚠️ 今日到期';
    if ( t.due < today ) return '· 🔴 已逾期';
    return '';
}

// 分鐘轉成給人看的長度。跟 fmtHours 同一套印法 —— 同一張表上一邊寫「45 分」
// 一邊寫「1.5h」的話，要比大小得先在腦袋裡換算。
function fmtDur( min ) {
    return fmtHours( min / 60 );
}

// 把排程結果轉成純資料 —— 存快照跟畫面用的是同一份，回看歷史才不會是另一套邏輯
function buildPlanModel( startMin ) {
    const { groups, overflow, noEstimate } = planDay( startMin );
    return {
        startMin,
        groups: groups.map( g => ( {
            label: g.block.label, start: g.block.start, end: g.block.end, ot: g.block.ot,
            segs: g.segs.map( s => s.free
                ? { from: s.from, to: s.to, free: s.free }
                : s.meeting
                ? { from: s.from, to: s.to, meeting: s.meeting }
                : {
                    from: s.from, to: s.to, part: s.part, ot: !!s.ot,
                    id: s.entry.task.id, title: s.entry.task.title, project: s.entry.task.project,
                    estimate: s.entry.task.estimate, status: s.entry.task.status, due: s.entry.task.due,
                    // 已經發生過的那幾筆，畫面上要顯示實際花的時間而不是估時
                    actualMin: s.entry.past ? s.entry.min : undefined,
                    past: s.entry.kind,   // 'done' | 'cut'，還沒做的是 undefined
                    // 跟它結束在同一分鐘、放同一個時間段的其他張。
                    // 只有真的有才帶 —— 舊的快照沒有這個欄位＝那一格只有一張，畫法不變。
                    also: s.entry.also && s.entry.also.length
                        ? s.entry.also.map( a => ( { id: a.task.id, title: a.task.title, past: a.kind } ) )
                        : undefined,
                } ),
        } ) ),
        overflow: overflow.map( o => ( {
            id: o.task.id, title: o.task.title, due: o.task.due,
            remainMin: o.remainMin, partial: o.partial,
        } ) ),
        noEstimate: noEstimate.map( t => ( { id: t.id, title: t.title } ) ),
    };
}

// refDate＝這份計畫是哪一天的。回看 9/16 的快照時，到期標記要以 9/16 為準。
function renderPlan( plan, refDate ) {
    let html = '';
    for ( const g of plan.groups ) {
        // 沒加班就不顯示加班段。判斷用「有沒有真的單」—— 只有空檔或會議不算有加班。
        if ( g.ot && !g.segs.some( s => s.id ) ) continue;

        html += `<div class="slot-group${ g.ot ? ' ot' : '' }">
            <div class="slot-group-label">${ g.label } ${ hhmm( g.start ) }–${ hhmm( g.end ) }</div>`;

        for ( const s of g.segs ) {
            if ( s.from >= s.to ) continue;
            if ( s.free ) {
                html += `<div class="slot free">
                    <div class="slot-time">${ hhmm( s.from ) }–${ hhmm( s.to ) }</div>
                    <div class="slot-body"><div class="slot-title">${ s.free }</div></div>
                </div>`;
                continue;
            }
            if ( s.meeting ) {
                html += `<div class="slot meeting">
                    <div class="slot-time">${ hhmm( s.from ) }–${ hhmm( s.to ) }</div>
                    <div class="slot-body"><div class="slot-title">${ esc( s.meeting ) }</div></div>
                </div>`;
                continue;
            }
            // 結束在同一分鐘的好幾張 ＝ 一格、每張一行，時間就是那段真實區間。
            // ⛔ 不要改成平分成好幾格（理由見 pastEntries 的註解，那條路走過兩次都不行）。
            // ⚠️ 這一格不套 .slot.done / .cut（它們的 ::before 會給整格同一個圖示，
            //    可是同一分鐘結束的可能一張是完成、一張是被插件）—— 圖示逐行自己寫。
            if ( s.also ) {
                const all = [ { id: s.id, title: s.title, past: s.past } ].concat( s.also );
                html += `<div class="slot multi${ s.ot ? ' ot' : '' }">
                    <div class="slot-time">${ hhmm( s.from ) }–${ hhmm( s.to ) }</div>
                    <div class="slot-body">
                        ${ all.map( a => `<div class="slot-title" data-id="${ esc( a.id ) }">`
                            + `${ a.past === 'cut' ? '⏸ ' : '✅ ' }${ esc( a.title ) }</div>` ).join( '' ) }
                        <div class="slot-sub">${ all.length } 張結束在同一分鐘・這段共 ${ fmtDur( s.actualMin ) }</div>
                    </div>
                </div>`;
                continue;
            }
            html += `<div class="slot ${ s.status }${ s.past === 'cut' ? ' cut' : '' }${ s.ot ? ' ot' : '' }" data-id="${ esc( s.id ) }">
                <div class="slot-time">${ hhmm( s.from ) }–${ hhmm( s.to ) }</div>
                <div class="slot-body">
                    <div class="slot-title">${ esc( s.title ) }</div>
                    <div class="slot-sub">
                        ${ s.project ? esc( s.project ) + ' · ' : '' }${ s.past === 'cut'
                            ? `已做 ${ fmtDur( s.actualMin ) }`
                            : s.actualMin
                            ? `實際 ${ fmtDur( s.actualMin ) }（估 ${ fmtHours( s.estimate ) }）`
                            : `估 ${ fmtHours( s.estimate ) }` }
                        ${ s.part > 1 ? '<span class="cont">· 續</span>' : '' }
                        ${ dueFlag( s, refDate ) }
                    </div>
                </div>
            </div>`;
        }
        html += '</div>';
    }

    if ( plan.overflow.length ) {
        html += `<div class="today-over">
            <b>⛔ 做不完（${ plan.overflow.length } 項）</b>
            <ul>${ plan.overflow.map( o =>
                `<li>${ esc( o.title ) }（${ o.partial ? '已排一部分，還差 ' : '' }${ fmtDur( o.remainMin ) }）`
                + ` ${ dueFlag( o, refDate ).replace( /^· /, '' ) }</li>`
            ).join( '' ) }</ul>
        </div>`;
    }

    if ( plan.noEstimate.length ) {
        html += `<div class="today-noest">
            <b>${ plan.noEstimate.length } 項未估時</b>，沒排進來：
            ${ plan.noEstimate.map( t => esc( t.title ) ).join( '、' ) }
        </div>`;
    }

    return html || '<div class="empty">沒有進行中或已排程的項目。</div>';
}

function paintPlan( html ) {
    $( '#today-body' ).innerHTML = html;
    // ⚠️ 兩種都要綁：一般的一格一張（data-id 在 .slot 上），以及同一分鐘結束的
    //    合併格（.slot 本身沒有 data-id，改掛在每一行標題上）。這樣兩者都點得開，
    //    而且不會有一次點擊觸發兩個 handler。
    $$( '#today-body .slot[data-id], #today-body .slot-title[data-id]' ).forEach( el =>
        el.addEventListener( 'click', () => openModal( el.dataset.id ) ) );
}

let savePlanTimer = null;

function renderToday() {
    const viewing = $( '#day-pick' ).value;
    const today = todayStr();
    const owner = view.owner;

    // 看歷史：直接畫存下來的那份，不重算
    if ( viewing && viewing !== today ) {
        $( '#day-start' ).disabled = true;
        api( `/api/days/${ viewing }?owner=${ encodeURIComponent( owner ) }` )
            .then( r => paintPlan( renderPlan( r.plan, viewing ) ) )
            .catch( err => paintPlan( `<div class="empty">${ esc( err.message ) }</div>` ) );
        return;
    }

    // 別人的看板只能看，不能替他調（管理者除外；後端擋的是同一條）。
    $( '#day-start' ).disabled = !canEditStart();
    // ⚠️ 要在 getStartMin() 之前 —— 這一行可能會改掉那一格的值。
    applyStartForView();
    const plan = buildPlanModel( getStartMin() );
    paintPlan( renderPlan( plan, today ) );

    // ⭐ P5：快照是「某個人的今天」，所以只有在看**某個人的看板**時才存。
    //    「還不確定找誰」那一頁沒有主人（view.owner 是 undefined），而 canScheduleView()
    //    在那一頁對管理者是 true ⇒ 會送出一筆沒有 owner 的快照，被後端收成
    //    defaultOwner 的紀錄。⛔ 不要只靠後端擋（那邊現在會回 400），這裡也不該送。
    if ( view.kind !== 'member' || !owner ) return;
    // 只有本人才寫快照；存最新的一份，隔天回看就是收工時的樣子。
    // ⚠️ 管理者也不行 —— 別人開著我的頁面掛在那裡，會把他那邊
    // 用「現在時間」重算出來的空排程存成我今天的紀錄。
    if ( !canScheduleView() ) return;
    clearTimeout( savePlanTimer );
    savePlanTimer = setTimeout( () => {
        api( '/api/day-plan', { method: 'POST', body: { date: today, owner, plan } } )
            .then( () => refreshDayPicker() )
            .catch( () => {} );
    }, 4000 );
}

async function refreshDayPicker() {
    const sel = $( '#day-pick' );
    const today = todayStr();
    const keep = sel.value || today;
    const { days } = await api( `/api/days?owner=${ encodeURIComponent( view.owner ) }` )
        .catch( () => ( { days: [] } ) );
    const dates = [ today, ...days.map( d => d.date ).filter( d => d !== today ) ];
    sel.innerHTML = dates.map( d =>
        `<option value="${ d }">${ d === today ? '今天' : d.slice( 5 ).replace( '-', '/' ) }</option>` ).join( '' );
    sel.value = dates.indexOf( keep ) >= 0 ? keep : today;
}

// ── card interaction ─────────────────────────────────────────────────────────

function bindCards() {
    $$( '.card' ).forEach( card => {
        const id = card.dataset.id;

        card.addEventListener( 'click', e => {
            if ( e.target.closest( '[data-stop]' ) || e.target.closest( '.handle' ) ) return;
            openModal( id );
        } );

        card.querySelectorAll( '[data-act]' ).forEach( el => {
            const act = el.dataset.act;
            if ( act === 'delete' ) {
                el.addEventListener( 'click', () => deleteTask( id ) );
            } else if ( act === 'status' ) {
                el.addEventListener( 'change', () => changeStatus( id, el.value ) );
            } else {
                el.addEventListener( 'change', () => patchTask( id, { [ act ]: el.value } ) );
            }
        } );

        if ( !canScheduleView() ) return;   // 拖曳＝排序，只有本人
        card.addEventListener( 'dragstart', onDragStart );
        card.addEventListener( 'dragover', onDragOver );
        card.addEventListener( 'dragleave', () => card.classList.remove( 'drop-target' ) );
        card.addEventListener( 'drop', onDrop );
        card.addEventListener( 'dragend', () => {
            $$( '.card' ).forEach( c => c.classList.remove( 'dragging', 'drop-target' ) );
        } );
    } );
}

let dragId = null;

function onDragStart( e ) {
    dragId = this.dataset.id;
    this.classList.add( 'dragging' );
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData( 'text/plain', dragId );
}

function onDragOver( e ) {
    if ( !dragId || dragId === this.dataset.id ) return;
    e.preventDefault();
    this.classList.add( 'drop-target' );
}

async function onDrop( e ) {
    e.preventDefault();
    this.classList.remove( 'drop-target' );
    const targetId = this.dataset.id;
    if ( !dragId || dragId === targetId ) return;

    // 在「這個人全部的單」上 splice（不是畫面上篩選後的那幾張），再把整串新順序送回去。
    // 送別人的 id 進去會被伺服器擋掉，所以只送這個 view 的 —— 伺服器那邊是把
    // 送進來這幾筆現有的 order 值重新分配，不會動到沒送進來的人。
    const ids = scopeTasks().map( t => t.id );
    const from = ids.indexOf( dragId );
    const to = ids.indexOf( targetId );
    ids.splice( from, 1 );
    // 往下拖時要落在目標「後面」，否則等於沒動
    ids.splice( ids.indexOf( targetId ) + ( from < to ? 1 : 0 ), 0, dragId );

    dragId = null;

    // 樂觀更新：先重排本地再送，避免畫面跳一下
    const rank = new Map( ids.map( ( id, i ) => [ id, i ] ) );
    const slots = tasks.filter( t => rank.has( t.id ) ).map( t => t.order ).sort( ( x, y ) => x - y );
    ids.forEach( ( id, i ) => { tasks.find( t => t.id === id ).order = slots[ i ]; } );
    tasks.sort( ( a, b ) => a.order - b.order );
    renderBoard();

    try {
        const r = await api( '/api/reorder', { method: 'POST', body: { ids } } );
        // 推估完成日是伺服器算的，順序一動就會位移 —— 不重抓的話卡片上的 ≈ 還是舊的
        if ( r.projectionChanged ) await refresh();
        toast( r.projectionChanged ? '順序已更新，完成時間跟著變了' : '順序已更新' );
    } catch ( err ) {
        toast( err.message, true );
        await refresh();
    }
}

async function patchTask( id, patch ) {
    try {
        const r = await api( `/api/tasks/${ id }`, { method: 'PATCH', body: patch } );
        const i = tasks.findIndex( t => t.id === id );
        if ( i >= 0 ) tasks[ i ] = r.task;
        // 改估時 / 狀態 / 負責人都會讓後面整串的推估日位移，只換這一筆會對不起來
        await refresh();
        toast( r.queued && meta.telegramEnabled ? '已更新，排程異動將推播到 TG' : '已更新' );
    } catch ( err ) {
        toast( err.message, true );
    }
}

// 進行中 → 不是完成＝做到一半被插件了。這時候估時還是「整張單」的時數，
// 留著不動的話排程會以為它要從頭再做一次，後面每一筆的推估日都跟著錯。
// ⚠️ 建議值是從 startedAt 推的上班時數 —— 中間跑去做別的它不知道，所以是
//    問一次再存，⛔ 不要改成自動寫入。
async function changeStatus( id, next ) {
    const t = tasks.find( x => x.id === id );
    if ( !t || t.status !== 'doing' || next === 'doing' || next === 'done' || !t.estimate ) {
        return patchTask( id, { status: next } );
    }

    // ⛔ 不要再把建議值 round 到 0.5 —— 只剩 10 分鐘的單會被建議成 0.5h，
    //    使用者回報的就是這件事。分鐘級的數字直接給。
    const spentH = t.startedAt
        ? Math.round( workMinutesSpan( t.startedAt, new Date().toISOString(), t.owner ) ) / 60 : 0;
    const suggest = Math.max( 0, t.estimate - spentH );
    const ans = prompt(
        `「${ t.title }」要從進行中改成${ STATUS_LABEL[ next ] }。\n\n`
        + `目前估時 ${ fmtHours( t.estimate ) }，這一輪已經做掉大約 ${ fmtHours( spentH ) }`
        + `（照上班時段推的，午休跟固定會議已經扣掉）。\n\n`
        + '還要多久？可以填 1.5、1h30m、90m 或 1:30。不對就改掉再按確定。',
        fmtHours( suggest ) );

    // 按取消＝整個動作不做。下拉已經停在新值上了，重畫把它拉回原狀 ——
    // ⛔ 不要只 return：畫面會顯示「已排程」但伺服器上還是進行中。
    if ( ans === null ) return renderBoard();
    const rest = parseHours( ans );
    if ( rest === null ) { toast( EST_HINT, true ); return renderBoard(); }
    await patchTask( id, { status: next, estimate: rest } );
}

async function deleteTask( id ) {
    const t = tasks.find( x => x.id === id );
    if ( !confirm( `確定刪除「${ t ? t.title : id }」？這個動作無法復原。` ) ) return;
    try {
        await api( `/api/tasks/${ id }`, { method: 'DELETE' } );
        await refresh();
        toast( '已刪除' );
    } catch ( err ) {
        toast( err.message, true );
    }
}

// ── modal ────────────────────────────────────────────────────────────────────

function openModal( id ) {
    const t = tasks.find( x => x.id === id );
    if ( !t ) return;

    $( '#modal-body' ).innerHTML = `
        <h2>${ esc( t.title ) }</h2>
        <div class="card-meta">
            ${ t.project ? `<span class="tag">${ esc( t.project ) }</span>` : '' }
            <span class="tag plain">${ STATUS_ICON[ t.status ] } ${ STATUS_LABEL[ t.status ] }</span>
        </div>
        ${ t.detail ? `<div class="detail-text">${ esc( t.detail ) }</div>` : '' }
        <dl class="kv">
            <dt>提出者</dt><dd>${ esc( t.requester ) }</dd>
            <dt>負責人</dt><dd>${ esc( ownerLabel( t.owner ) ) }</dd>
            <dt>提出時間</dt><dd>${ fmtTime( t.createdAt ) }</dd>
            ${ t.wishDate || t.wishLog.length ? `<dt>希望完成</dt>
                <dd class="${ wishLate( t ) ? 'due overdue' : '' }">${ t.wishDate
                    ? `${ wishText( t ) }${ t.wishTime ? '' : '（當天內）' }` : '未定' }${ wishTimesText( t ) }</dd>` : '' }
            <dt>預計完成</dt><dd class="due ${ dueClass( t ) }">${ dueText( t ) }</dd>
            ${ t.projectedDue ? `<dt>目前排法推估</dt><dd>${ t.projectedDue.replace( /-/g, '/' ) }</dd>` : '' }
            <dt>估計工時</dt><dd>${ t.estimate ? estText( t ) : '尚未估' }</dd>
            ${ t.startedAt ? `<dt>這一輪開始</dt><dd>${ fmtTime( t.startedAt ) }</dd>` : '' }
            ${ t.note ? `<dt>我的備註</dt><dd>${ esc( t.note ) }</dd>` : '' }
        </dl>
        ${ canEditView() ? `
        <details class="edit-block">
            <summary>✏️ 編輯這張單</summary>
            <form id="edit-form">
                <div class="row">
                    <label class="field grow"><span>標題</span>
                        <input name="title" value="${ esc( t.title ) }" maxlength="120" required></label>
                    <label class="field w-proj"><span>專案</span>
                        <input name="project" list="project-list" value="${ esc( t.project ) }" maxlength="60"></label>
                </div>
                <label class="field"><span>詳細說明</span>
                    <textarea name="detail" rows="3" maxlength="2000">${ esc( t.detail ) }</textarea></label>
                <label class="field"><span>我的備註（顯示在單上，不推 TG）</span>
                    <textarea name="note" rows="2" maxlength="1000">${ esc( t.note ) }</textarea></label>
                <div class="form-foot">
                    <span class="hint">這些欄位不會觸發 TG 推播。</span>
                    <button type="submit" class="btn primary sm">儲存</button>
                </div>
            </form>
        </details>` : '' }
        ${ canEditWish( t ) ? `
        <details class="edit-block wish-block">
            <summary>🙏 改我希望完成的時間</summary>
            <form id="wish-form">
                <div class="row">
                    <label class="field w-wish"><span>希望完成（時刻不填＝當天內都可以）</span>
                        <span class="wish-pair">
                            <input type="date" name="wishDate" value="${ esc( t.wishDate ) }" min="${ todayStr() }">
                            <input type="time" name="wishTime" value="${ esc( t.wishTime ) }">
                        </span></label>
                </div>
                <div class="form-foot">
                    <span class="hint">⚠️ 每次改都會記在下面的討論裡，也會通知負責人。不能改到今天之前。</span>
                    <button type="submit" class="btn primary sm">改時間</button>
                </div>
            </form>
        </details>` : '' }
        <div class="comments">
            <div style="font-size:12px;color:var(--muted);font-weight:600">💬 討論（${ t.comments.length }）</div>
            ${ t.comments.map( c => `<div class="comment${ c.sys ? ' sys' : '' }">
                <div class="comment-head"><b>${ esc( c.who ) }</b> · ${ fmtTime( c.at ) }</div>
                <div class="comment-text">${ esc( c.text ) }</div>
            </div>` ).join( '' ) || '<div class="hint" style="margin:8px 0">還沒有人留言。</div>' }
            ${ meta.admin ? `<form class="comment-form" id="comment-form">
                <input name="text" placeholder="以「${ esc( meta.who ? memberName( meta.who ) : '管理者' ) }」的身分留言…" maxlength="500" required>
                <button class="btn primary sm" type="submit">送出</button>
            </form>` : '<div class="hint" style="margin:8px 0">要登入才能留言。</div>' }
        </div>`;

    $( '#modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';

    const editForm = $( '#edit-form' );
    if ( editForm ) editForm.addEventListener( 'submit', async e => {
        e.preventDefault();
        await patchTask( id, Object.fromEntries( new FormData( e.target ).entries() ) );
        openModal( id );
    } );

    // ⚠️ 走 /wish 這支專屬端點，⛔ 不要併進 patchTask —— 那支的入口守門是 canEdit，
    //    提出者送過去只會拿到 403。
    const wishForm = $( '#wish-form' );
    if ( wishForm ) wishForm.addEventListener( 'submit', async e => {
        e.preventDefault();
        const fd = new FormData( e.target );
        try {
            const r = await api( `/api/tasks/${ id }/wish`, {
                method: 'PATCH',
                body: { wishDate: fd.get( 'wishDate' ), wishTime: fd.get( 'wishTime' ) },
            } );
            const i = tasks.findIndex( x => x.id === id );
            if ( i >= 0 ) tasks[ i ] = r.task;
            openModal( id );
            renderBoard();
            // ⚠️ 不用 refresh() —— 希望時間不進推估算式，沒有別筆會跟著位移
            toast( !r.queued ? '時間沒有變'
                : ( meta.telegramEnabled ? '已改，會通知負責人' : '已改，也記在討論裡了' ) );
        } catch ( err ) {
            toast( err.message, true );
        }
    } );

    const cf = $( '#comment-form' );
    if ( cf ) cf.addEventListener( 'submit', async e => {
        e.preventDefault();
        const fd = new FormData( e.target );
        try {
            // 署名由伺服器照 session 填，⛔ 不要從這裡送 who —— 那又變成可以冒名
            const r = await api( `/api/tasks/${ id }/comments`, {
                method: 'POST',
                body: { text: fd.get( 'text' ) },
            } );
            const i = tasks.findIndex( x => x.id === id );
            if ( i >= 0 ) tasks[ i ] = r.task;
            openModal( id );
            renderBoard();
        } catch ( err ) {
            toast( err.message, true );
        }
    } );
}

function closeModal() {
    $( '#modal' ).classList.add( 'hidden' );
    document.body.style.overflow = '';
}

// ── admin ────────────────────────────────────────────────────────────────────

function openPwModal() {
    $( '#pw-error' ).classList.add( 'hidden' );
    $( '#pw-input' ).value = '';
    $( '#pw-code' ).value = '';

    // 「總管理者」是後路：名冊或密碼弄壞時還進得去，所以永遠留著這個選項
    const sel = $( '#pw-who' );
    sel.innerHTML = meta.members.map( m =>
        `<option value="${ esc( m.id ) }">${ esc( m.name ) }${ m.hasPassword ? '' : '（還沒設密碼）' }</option>`
    ).join( '' ) + '<option value="">總管理者</option>';
    // 剛剛在看誰的看板，多半就是要用誰的身分登入
    sel.value = view.owner && meta.members.some( m => m.id === view.owner ) ? view.owner : sel.options[ 0 ].value;
    // 只有一個人的時候不用選，但那個人自己就是預設值
    $( '#pw-who-field' ).classList.toggle( 'hidden', meta.members.length <= 1 );
    updatePwHint();

    $( '#pw-modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';
    $( '#pw-input' ).focus();
}

function updatePwHint() {
    const who = $( '#pw-who' ).value;
    const m = meta.members.find( x => x.id === who );
    const first = !!who && !m.hasPassword;   // 第一次設密碼，要起始碼

    $( '#pw-code-field' ).classList.toggle( 'hidden', !first );
    $( '#pw-pass-label' ).textContent = first ? '想設的密碼' : '密碼';
    $( '#pw-input' ).autocomplete = first ? 'new-password' : 'current-password';
    $( '#pw-hint' ).textContent = !who ? '總管理者：可以改所有人的。'
        : first ? '第一次登入：輸入管理者給你的起始碼，再打一組自己的密碼（至少 4 個字）。'
        : '登入後只能排自己的項目。';
}

function closePwModal() {
    $( '#pw-modal' ).classList.add( 'hidden' );
    $( '#pw-input' ).value = '';   // 不把密碼留在 DOM 裡
    $( '#pw-code' ).value = '';
    document.body.style.overflow = '';
}

async function submitPw( e ) {
    e.preventDefault();
    const input = $( '#pw-input' );
    const err = $( '#pw-error' );
    const who = $( '#pw-who' ).value;
    const m = meta.members.find( x => x.id === who );
    try {
        // 沒設過密碼的人，第一次輸入的就是他的密碼 —— 但要帶管理者發的起始碼，
        // 否則任何連得進內網的人都能搶先幫別人把密碼定下來。
        const r = ( who && !m.hasPassword )
            ? await api( '/api/set-password', { method: 'POST', body: {
                who, newPassword: input.value, setupCode: $( '#pw-code' ).value,
            } } )
            : await api( '/api/login', { method: 'POST', body: { who: who || undefined, password: input.value } } );
        store.token = r.token;
        closePwModal();
        await refresh();
        toast( who ? `已用 ${ memberName( who ) } 的身分登入` : '已進入管理模式' );
    } catch ( e2 ) {
        err.textContent = e2.message;
        err.classList.remove( 'hidden' );
        // 起始碼打錯時不要把他剛想好的密碼也清掉，游標放回真正出問題的那一格
        if ( who && !m.hasPassword ) {
            $( '#pw-code' ).value = '';
            $( '#pw-code' ).focus();
        } else {
            input.value = '';
            input.focus();
        }
    }
}

async function toggleAdmin() {
    if ( meta.admin ) {
        store.token = '';
        await refresh();
        toast( '已離開管理模式' );
        return;
    }
    openPwModal();
}

// ── 訂閱通知 ─────────────────────────────────────────────────────────────────

let subPoll = null;

function closeSubModal() {
    clearInterval( subPoll );
    subPoll = null;
    $( '#sub-modal' ).classList.add( 'hidden' );
    document.body.style.overflow = '';
}

// 已經綁過的人再打開視窗時，送出鍵要變成「更新」而不是重新綁一次 —— 綁定拿到的是
// TG chat id，那個沒變，沒必要叫人再跑一次 /bind。
// ⛔ v4 起訂閱綁登入帳號，所以不再需要「這是對哪個名字查的」那組狀態 ——
//    身分在整個視窗的生命週期裡不會變，原本的競態（打一半送出拿到前一個人的狀態）消失了。
let subExisting = false;

// 追蹤範圍的候選。人員與專案都從 meta 來，之後加人／加專案不用回來改這裡。
function renderSubScopes( checked ) {
    const on = checked || [];
    const has = v => on.indexOf( v ) >= 0;
    const box = ( v, t, hint, self ) => `<label class="check">
        <input type="checkbox" ${ self ? 'data-self="1"' : `value="${ esc( v ) }"` }
            ${ ( self ? on.some( s => s.indexOf( 'requester:' ) === 0 ) : has( v ) ) ? ' checked' : '' }>
        ${ esc( t ) }${ hint ? `<span class="scope-hint">${ esc( hint ) }</span>` : '' }
    </label>`;

    let html = box( '', '我提的需求', '用你的帳號比對，不是比名字', true )
        + box( 'owner:', '還不確定找誰的', '沒指定負責人的，進收件匣就通知' );

    const devs = devMembers();
    if ( devs.length ) {
        html += `<div class="scope-group">某個人的單</div>`
            + devs.map( m => box( `owner:${ m.id }`, m.name ) ).join( '' );
    }
    if ( meta.projects.length ) {
        html += `<div class="scope-group">某個專案</div>`
            + meta.projects.map( p => box( `project:${ p }`, p ) ).join( '' );
    }
    html += `<div class="scope-group">全部</div>`
        + box( 'all', '全部需求', '勾這個就不用勾上面的' );

    $( '#sub-scopes' ).innerHTML = html;

    // 勾了「全部」其他就沒有意義了，直接鎖起來，免得以為自己選得比較窄
    const all = $( '#sub-scopes input[value="all"]' );
    const sync = () => $$( '#sub-scopes input' ).forEach( i => {
        if ( i === all ) return;
        i.disabled = all.checked;
        i.closest( '.check' ).classList.toggle( 'muted', all.checked );
    } );
    all.addEventListener( 'change', sync );
    sync();
}

function readSubScopes() {
    const out = [];
    for ( const i of $$( '#sub-scopes input' ) ) {
        if ( !i.checked || i.disabled ) continue;
        out.push( i.dataset.self ? `requester:${ meta.who }` : i.value );
    }
    return out;
}

async function openSubModal() {
    $( '#sub-step-1' ).classList.remove( 'hidden' );
    $( '#sub-step-2' ).classList.add( 'hidden' );
    $( '#sub-modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';

    // 沒綁到人就沒有訂閱可言（總管理者那條後路也一樣）—— 表單整個收起來
    const ok = !!meta.who;
    $( '#sub-locked' ).classList.toggle( 'hidden', ok );
    $( '#sub-form' ).classList.toggle( 'hidden', !ok );
    $( '#sub-current' ).classList.add( 'hidden' );
    if ( !ok ) return;

    $( '#sub-as-me' ).textContent = memberName( meta.who );
    subExisting = false;
    renderSubScopes( [ `requester:${ meta.who }` ] );   // 預設只訂自己提的
    setSubMode();
    showCurrentSub();
}

function setSubMode() {
    $( '#sub-submit' ).textContent = subExisting ? '更新追蹤範圍' : '產生綁定碼';
    $( '#sub-foot-hint' ).textContent = subExisting
        ? '已經綁過了，改範圍不用再跑一次 /bind。'
        : '要用你自己的 TG 帳號完成綁定。';
}

async function showCurrentSub() {
    const box = $( '#sub-current' );
    const r = await api( '/api/subscription' ).catch( () => ( { sub: null } ) );
    subExisting = !!r.sub;
    setSubMode();
    if ( !r.sub ) { box.classList.add( 'hidden' ); return; }

    renderSubScopes( r.sub.scopes );
    $( '#sub-form' ).tagInGroup.checked = !!r.sub.tagInGroup;
    box.innerHTML = `已訂閱，通知送到 <b>${ esc( r.sub.tgName || r.sub.tgUsername ) }</b>
        <button type="button" class="btn ghost small" id="sub-cancel">取消訂閱</button>`;
    box.classList.remove( 'hidden' );
    $( '#sub-cancel' ).addEventListener( 'click', async () => {
        await api( '/api/unsubscribe', { method: 'POST' } );
        box.classList.add( 'hidden' );
        subExisting = false;
        setSubMode();
        toast( '已取消訂閱' );
    } );
}

async function submitSub( e ) {
    e.preventDefault();
    if ( !meta.who ) return;
    const scopes = readSubScopes();
    if ( !scopes.length ) { toast( '至少要選一個追蹤範圍', true ); return; }
    const tagInGroup = e.target.tagInGroup.checked;

    // 已經綁過的只改範圍，不用再走一次 TG 綁定
    if ( subExisting ) {
        try {
            await api( '/api/subscription', { method: 'PATCH', body: { scopes, tagInGroup } } );
        } catch ( err ) {
            toast( err.message, true );
            return;
        }
        closeSubModal();
        toast( '追蹤範圍已更新' );
        return;
    }

    let r;
    try {
        r = await api( '/api/subscribe', { method: 'POST', body: { scopes, tagInGroup } } );
    } catch ( err ) {
        toast( err.message, true );
        return;
    }

    $( '#sub-step-1' ).classList.add( 'hidden' );
    $( '#sub-step-2' ).classList.remove( 'hidden' );
    $( '#sub-code' ).textContent = `/bind ${ r.code }`;
    $( '#sub-link' ).href = r.link;
    $( '#sub-wait' ).textContent = `等你送出中…（${ r.expiresInMin } 分鐘內有效）`;

    // 綁定是在 TG 那邊完成的，網頁只能問「好了沒」
    clearInterval( subPoll );
    subPoll = setInterval( async () => {
        const s = await api( `/api/subscribe/${ r.code }` ).catch( () => null );
        if ( !s || s.state === 'waiting' ) return;
        clearInterval( subPoll );
        subPoll = null;
        if ( s.state === 'done' ) {
            closeSubModal();
            toast( `訂閱完成，通知會送到 ${ s.sub.tgName || s.sub.tgUsername }` );
        } else {
            $( '#sub-wait' ).textContent = '這組碼過期了，關掉重來一次。';
        }
    }, 2500 );
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function refresh() {
    // ⚠️ 序號要在請求「出發之前」拿（見 pendingStarts）。
    const poll = ++pollSeq;
    // ⚠️ 起排表要跟單一起抓 —— 分兩次抓會有一瞬間「表還沒到、單已經到」，
    //    applyStartForView 在那個當下會以為沒人定過，就自己定了一個。
    const [ m, t, d ] = await Promise.all( [
        api( '/api/meta' ), api( '/api/tasks' ),
        // ⚠️ 只有這一支准失敗。public/ 是每次請求現讀檔的，server.js 卻要重開服務
        //    才會換 —— 所以「新的網頁 + 舊的服務」一定會有一段時間並存，那段時間
        //    這支 API 還不存在（404）。⛔ 不擋住的話整個看板打不開（Promise.all 會
        //    連帶把單也一起丟掉），為了一個「從幾點開始畫」的設定賠掉整張看板。
        //    退而求其次：當天當場算一個，只是存不起來（POST 會跳錯誤訊息提醒重開）。
        api( '/api/day-starts?date=' + todayStr() ).catch( () => {
            if ( !startsApiMissing ) toast( '起排暫時存不起來（服務要重開一次）', true );
            startsApiMissing = true;
            return { starts: {} };
        } ) ] );
    meta = m;
    tasks = t.tasks;
    // ⚠️ public/ 是每次請求現讀、server.js 要重開才會換 ⇒ 一定會有一段「新網頁 ＋ 舊服務」
    //    並存的時間，那時舊後端吐的單沒有 wishLog，下面無條件讀 .length 會炸 ——
    //    從 renderBoard 一路炸上去、整張看板打不開（2026-09-17 為 spans / comments 踩過一次）。
    // ✅ 在入口把形狀統一，⛔ 不是在每個讀取點各補一次 `|| []`（同 server.js:191 的理由）。
    for ( const x of tasks ) if ( !Array.isArray( x.wishLog ) ) x.wishLog = [];
    dayStarts = d.starts;
    // 我寫過、但這一輪的回應可能還來不及含進去的那幾筆補回來（見 pendingStarts）。
    for ( const [ owner, p ] of pendingStarts ) {
        // 我的寫入在這一輪出發「之前」就成功了 ⇒ 回應裡一定有它，換伺服器的說法算數。
        if ( p.since !== undefined && p.since < poll ) { pendingStarts.delete( owner ); continue; }
        dayStarts[ owner ] = p.val;
    }
    dataLoaded = true;
    applyWorkHours( meta.workHours );
    renderWorkHoursText();
    // 說明頁那句「提前 N 分鐘」。⚠️ meta 是網路邊界：舊後端沒有這個欄位 ⇒ 整句括號不畫，
    //    ⛔ 不要讓它印出「提前 undefined 分鐘」。
    $( '#due-soon' ).textContent = meta.dueSoonMin === undefined ? '' : `（提前 ${ meta.dueSoonMin } 分鐘）`;
    applyMeetings( meta.meetings );

    // meta.admin 是「有東西可以編輯」，meta.fullAdmin 才是「可以改所有人的」。
    // 推播是全體的事，所以掛在 fullAdmin 上。
    const whoName = meta.who ? ( meta.members.find( m => m.id === meta.who ) || {} ).name : '';
    $( '#whoami' ).textContent = !meta.admin ? '瀏覽模式' : ( whoName || '管理模式' );
    $( '#whoami' ).classList.toggle( 'admin', meta.admin );
    $( '#btn-admin' ).textContent = meta.admin ? '🔓 登出' : '🔑 管理模式';
    $( '#btn-notify' ).classList.toggle( 'hidden', !meta.fullAdmin );
    // TG 沒開就沒有訂閱可言，按了只會得到錯誤訊息
    $( '#btn-sub' ).classList.toggle( 'hidden', !meta.telegramEnabled );

    // meta.members 要先到手，readHash 才認得出網址裡的人員 id
    applyView();
    maybeCatchUp();
}

// ── 補帳守門 ─────────────────────────────────────────────────────────────────

// 條件 1–4：是不是本人的看板、不在回看歷史、四個 modal 都是 hidden
// ⚠️ 條件 5（catchUpKey）在 maybeCatchUp() 裡檢查並預先設好，這裡不含。
function catchUpAllowed() {
    if ( view.kind !== 'member' || !view.owner ) return false;
    if ( !canScheduleView() ) return false;   // ＝ view.owner === meta.who，本人才問
    const viewing = $( '#day-pick' ).value;
    // ⚠️ 照抄 renderToday（app.js:1185）的判準：空字串算今天，⛔ 不要嚴格比 === todayStr()
    if ( viewing && viewing !== todayStr() ) return false;
    if ( !$( '#modal' ).classList.contains( 'hidden' ) ) return false;
    if ( !$( '#pw-modal' ).classList.contains( 'hidden' ) ) return false;
    if ( !$( '#sub-modal' ).classList.contains( 'hidden' ) ) return false;
    if ( !$( '#help-modal' ).classList.contains( 'hidden' ) ) return false;
    return true;
}

async function maybeCatchUp() {
    if ( !catchUpAllowed() ) return;
    const owner = view.owner;
    const key = owner + '@' + todayStr();
    if ( catchUpKey === key ) return;
    catchUpKey = key;   // ⛔ 打 API 之前就先設好，不等回應（refresh 每 20 秒跑一次，慢回應會讓它重複開窗）
    const r = await api( '/api/catch-up?owner=' + encodeURIComponent( owner ) ).catch( () => null );
    if ( !r || !r.items.length ) return;
    // ⚠️ await 期間可能已切走看板、切到歷史、或自己開了別的視窗
    if ( !catchUpAllowed() ) return;
    openCatchUpModal( r.date, r.items );
}

function openCatchUpModal( date, items ) {
    // 把 YYYY-MM-DD 格式化成 M/D
    const dateMd = date ? date.slice( 5 ).replace( '-', '/' ) : '';
    // 判斷是不是昨天（純字串比較，⛔ 不要手動計算時區）
    const yestD = new Date();
    yestD.setDate( yestD.getDate() - 1 );
    const yest = `${ yestD.getFullYear() }-${ String( yestD.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( yestD.getDate() ).padStart( 2, '0' ) }`;

    const hasPlanned = items.some( i => i.planned );
    // ⚠️ 判準是 items.some( planned )，⛔ 不是看 date 是不是 null（見計畫書 §5.4）
    const hintTop = hasPlanned
        ? `${ dateMd }${ date === yest ? '（昨天）' : '' }排了這幾張，但沒有進度紀錄。排程還在拿整個估時算，先把帳補平。`
        : '這幾張卡在進行中已經跨天了。先把帳補平，排程才算得準。';

    let rowsHtml = '';
    for ( const item of items ) {
        let rowHint = '';
        if ( item.planned ) {
            if ( item.recordedMin > 0 ) {
                rowHint = `${ dateMd } 排了 ${ fmtDur( item.plannedMin ) }，那天已記 ${ fmtDur( item.recordedMin ) }`;
            } else if ( item.spentMin > 0 ) {
                // ⚠️ 這條不能漏：補帳不寫 spans，補過帳的單 recordedMin 永遠是 0
                rowHint = `${ dateMd } 排了 ${ fmtDur( item.plannedMin ) }，那天沒有紀錄；這張單目前已記 ${ fmtDur( item.spentMin ) }`;
            } else {
                rowHint = `${ dateMd } 排了 ${ fmtDur( item.plannedMin ) }，沒有任何進度紀錄`;
            }
            if ( item.stuckDoing ) rowHint += `・從 ${ fmtTime( item.startedAt ) } 起掛在進行中`;
        } else if ( item.stuckDoing ) {
            rowHint = `從 ${ fmtTime( item.startedAt ) } 起掛在進行中，目前估時 ${ fmtHours( item.estimate ) }`;
            if ( item.spentMin > 0 ) rowHint += `・已記 ${ fmtDur( item.spentMin ) }`;
        }

        rowsHtml += `<div class="cu-row" data-id="${ esc( item.id ) }">
            <div class="cu-row-title">${ esc( item.title ) }${ item.project ? ` <span class="tag">${ esc( item.project ) }</span>` : '' }</div>
            <div class="hint">${ rowHint }</div>
            <div class="cu-fields">
                <label class="field"><span>做了多少</span>
                    <input class="cu-spent" type="text" placeholder="1h30m"></label>
                <label class="field"><span>還要多久</span>
                    <input class="cu-remain" type="text" value="${ esc( fmtHours( item.estimate ) ) }"></label>
            </div>
        </div>`;
    }

    $( '#modal-body' ).innerHTML = `
        <h2>補一下進度</h2>
        <p class="hint">${ hintTop }</p>
        ${ rowsHtml }
        <div class="modal-actions">
            ${ items.length > 1 ? '<button class="btn" id="cu-all-no">全部都沒做</button>' : '' }
            <button class="btn primary" id="cu-ok">確定</button>
        </div>`;

    $( '#modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';

    // 「做了多少」連動「還要多久」（只在沒有手動改過 remain 時）
    $$( '.cu-row' ).forEach( ( row, idx ) => {
        const item = items[ idx ];
        const spentEl = row.querySelector( '.cu-spent' );
        const remainEl = row.querySelector( '.cu-remain' );
        remainEl.addEventListener( 'input', () => { row.dataset.touched = '1'; } );
        spentEl.addEventListener( 'input', () => {
            if ( row.dataset.touched ) return;
            const s = parseHours( spentEl.value );
            if ( s !== null ) remainEl.value = fmtHours( Math.max( 0, item.estimate - s ) );
        } );
    } );

    // 共用送出邏輯（確定 / 全部都沒做）
    async function submitRows( isSkip ) {
        const rows = $$( '.cu-row' );
        // 非 skip 路徑：先驗所有未送出的列（⛔ 不要只送成功的那幾列）
        if ( !isSkip ) {
            for ( const row of rows ) {
                if ( row.dataset.sent === '1' ) continue;
                const spent = row.querySelector( '.cu-spent' ).value;
                const remain = row.querySelector( '.cu-remain' ).value;
                const spentOk = parseHours( spent === '' ? 0 : spent ) !== null;
                const remainOk = parseHours( remain ) !== null;
                if ( !spentOk || !remainOk ) { toast( EST_HINT, true ); return; }
            }
        }
        let allSkipped = true;
        for ( const row of rows ) {
            if ( row.dataset.sent === '1' ) continue;
            const id = row.dataset.id;
            let body;
            if ( isSkip ) {
                body = { id, skip: true };
            } else {
                const spent = row.querySelector( '.cu-spent' ).value;
                const remain = row.querySelector( '.cu-remain' ).value;
                body = { id, spent: spent === '' ? '0' : spent, remain };
            }
            try {
                const r = await api( '/api/catch-up', { method: 'POST', body } );
                row.dataset.sent = '1';
                row.querySelectorAll( 'input' ).forEach( el => { el.disabled = true; } );
                if ( !r.skipped ) allSkipped = false;
            } catch ( err ) {
                toast( err.message, true );
                return;   // ⛔ 停在這裡，不要 closeModal()
            }
        }
        closeModal();
        await refresh();
        if ( isSkip ) {
            toast( '好，都記成沒做' );
        } else if ( allSkipped ) {
            toast( '這幾張今天已經補過了' );
        } else {
            toast( '已補上進度' );
        }
    }

    $( '#cu-ok' ).addEventListener( 'click', () => submitRows( false ) );
    if ( $( '#cu-all-no' ) ) $( '#cu-all-no' ).addEventListener( 'click', () => submitRows( true ) );
}

// ── 說明視窗 ─────────────────────────────────────────────────────────────────

// 改了 index.html 裡那份「🆕 最近更新」就把這個字串換掉 —— 它只是用來讓「說明」
// 按鈕上的紅點重新亮起來，每個人各自看過各自的（存在他自己的瀏覽器裡，不進伺服器）。
const HELP_VERSION = '2026-09-21b';

function syncHelpDot() {
    $( '#help-dot' ).classList.toggle( 'hidden', store.helpSeen === HELP_VERSION );
}

function openHelpModal() {
    $( '#help-modal' ).classList.remove( 'hidden' );
    document.body.style.overflow = 'hidden';
    // 打開就算看過了 —— ⛔ 不要等他捲到底或按關閉，那樣紅點會一直亮著沒人理它
    store.helpSeen = HELP_VERSION;
    syncHelpDot();
}

function closeHelpModal() {
    $( '#help-modal' ).classList.add( 'hidden' );
    document.body.style.overflow = '';
}

function busy() {
    const a = document.activeElement;
    if ( a && /^(INPUT|TEXTAREA|SELECT)$/.test( a.tagName ) ) return true;
    return !$( '#modal' ).classList.contains( 'hidden' )
        || !$( '#pw-modal' ).classList.contains( 'hidden' )
        || !$( '#sub-modal' ).classList.contains( 'hidden' )
        || !$( '#help-modal' ).classList.contains( 'hidden' );
}

function init() {
    $( '#toggle-new' ).addEventListener( 'click', () => {
        const f = $( '#form-new' );
        f.classList.toggle( 'hidden' );
        if ( !f.classList.contains( 'hidden' ) ) f.title.focus();
    } );

    $( '#new-login' ).addEventListener( 'click', openPwModal );
    $( '#sub-login' ).addEventListener( 'click', () => { closeSubModal(); openPwModal(); } );

    $( '#form-new' ).addEventListener( 'submit', async e => {
        e.preventDefault();
        const fd = new FormData( e.target );
        const body = Object.fromEntries( fd.entries() );
        // 提出者是伺服器照 session 填的，⛔ 不要從這裡送
        // 提給誰＝現在在誰的頁面。「還不確定找誰」送空字串，會進無主收件匣。
        body.owner = view.owner || '';
        try {
            await api( '/api/tasks', { method: 'POST', body } );
            e.target.reset();
            e.target.classList.add( 'hidden' );
            await refresh();
            toast( '需求已送出，感謝！' );
        } catch ( err ) {
            toast( err.message, true );
        }
    } );

    $( '#btn-admin' ).addEventListener( 'click', toggleAdmin );

    $( '#btn-help' ).addEventListener( 'click', openHelpModal );
    $( '#help-close' ).addEventListener( 'click', closeHelpModal );
    $( '#help-modal' ).addEventListener( 'click', e => {
        if ( e.target.id === 'help-modal' ) closeHelpModal();
    } );
    syncHelpDot();

    $( '#btn-sub' ).addEventListener( 'click', openSubModal );
    $( '#sub-close' ).addEventListener( 'click', closeSubModal );
    $( '#sub-form' ).addEventListener( 'submit', submitSub );
    $( '#sub-modal' ).addEventListener( 'click', e => {
        if ( e.target.id === 'sub-modal' ) closeSubModal();
    } );

    $( '#btn-notify' ).addEventListener( 'click', async () => {
        if ( !confirm( '立刻把目前排程推播到 TG 群？' ) ) return;
        try {
            await api( '/api/notify', { method: 'POST' } );
            toast( meta.telegramEnabled ? '已推播' : 'TG 未啟用，內容印在 server console' );
        } catch ( err ) {
            toast( err.message, true );
        }
    } );

    [ '#filter-project', '#filter-requester', '#filter-done' ].forEach( s =>
        $( s ).addEventListener( 'change', renderBoard ) );
    // input 而不是 change —— 邊打邊篩。單子是幾百張這個量級，不用 debounce。
    $( '#filter-q' ).addEventListener( 'input', renderBoard );

    $( '#pw-who' ).addEventListener( 'change', updatePwHint );
    window.addEventListener( 'hashchange', applyView );

    // 起排每人每天一份，存在伺服器（見 applyStartForView / saveStart）。
    // ⚠️ ⛔ 不要在這裡預先填值 —— 那時人員名冊、工時、單都還沒到手，填什麼都是猜的。
    //    等 refresh() 回來之後由 renderToday 那條路定案。
    $( '#day-start' ).addEventListener( 'change', () => {
        // 人自己調的：auto = false，之後誰都不會自動蓋掉它。
        if ( canEditStart() ) saveStart( view.owner, getStartMin(), false );
        renderToday();
    } );
    $( '#day-pick' ).addEventListener( 'change', renderToday );
    // 日期清單是某個人的，要等 applyView 知道在看誰才抓得到

    $( '#modal-close' ).addEventListener( 'click', closeModal );
    $( '#modal' ).addEventListener( 'click', e => { if ( e.target.id === 'modal' ) closeModal(); } );

    $( '#pw-form' ).addEventListener( 'submit', submitPw );
    $( '#pw-input' ).addEventListener( 'keydown', e => {
        if ( e.key === 'Enter' ) { e.preventDefault(); submitPw( e ); }
    } );
    $( '#pw-close' ).addEventListener( 'click', closePwModal );
    $( '#pw-modal' ).addEventListener( 'click', e => { if ( e.target.id === 'pw-modal' ) closePwModal(); } );

    document.addEventListener( 'keydown', e => {
        if ( e.key !== 'Escape' ) return;
        closeModal();
        closePwModal();
        closeHelpModal();
    } );

    refresh().catch( err => toast( err.message, true ) );
    setInterval( () => { if ( !busy() ) refresh().catch( () => {} ); }, 20000 );
}

init();
