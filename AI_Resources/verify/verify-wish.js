'use strict';
// 「希望完成只有提出者能改 ＋ 留紀錄」的驗收 harness。
// ⚠️ 只打 8443（副本），⛔ 不碰 8420。
const http = require( 'http' );
const fs = require( 'fs' );
const path = require( 'path' );

const HOST = 'localhost';
const PORT = 8443;
const DIR = __dirname;

let pass = 0, fail = 0;
const fails = [];
function ok( name, cond, got ) {
    if ( cond ) { pass++; console.log( `  ✓ ${ name }` ); }
    else { fail++; fails.push( name ); console.log( `  ✗ ${ name }　得到：${ JSON.stringify( got ) }` ); }
}

function req( method, urlPath, body, token ) {
    return new Promise( ( resolve, reject ) => {
        const payload = body === undefined ? null : JSON.stringify( body );
        const headers = {};
        if ( payload ) {
            headers[ 'Content-Type' ] = 'application/json';
            headers[ 'Content-Length' ] = Buffer.byteLength( payload );
        }
        if ( token ) headers[ 'X-Admin-Token' ] = token;
        const r = http.request( { host: HOST, port: PORT, method, path: urlPath, headers }, res => {
            let buf = '';
            res.on( 'data', c => buf += c );
            res.on( 'end', () => {
                let json = null;
                try { json = JSON.parse( buf ); } catch ( e ) { /* 非 JSON（靜態檔）留 null */ }
                resolve( { code: res.statusCode, json, raw: buf } );
            } );
        } );
        r.on( 'error', reject );
        if ( payload ) r.write( payload );
        r.end();
    } );
}

function ymd( offset ) {
    const d = new Date();
    d.setDate( d.getDate() + ( offset || 0 ) );
    return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
}

const sleep = ms => new Promise( r => setTimeout( r, ms ) );

// 磁碟上那一筆（⚠️ 寫入之後要留一點時間給 renameSync，否則 Windows 上會撞 EPERM）
async function onDisk( id ) {
    for ( let i = 0; i < 6; i++ ) {
        try {
            const d = JSON.parse( fs.readFileSync( path.join( DIR, 'data.json' ), 'utf8' ) );
            const t = d.tasks.find( x => x.id === id );
            if ( t ) return t;
        } catch ( e ) { /* 正在被換檔，等一下再讀 */ }
        await sleep( 120 );
    }
    throw new Error( 'cannot read task from disk: ' + id );
}

async function tokenFor( who ) {
    // 兩段式：先用總管理者密碼進來，再 set-password 換成綁人的 token
    const root = await req( 'POST', '/api/login', { password: 'testroot' } );
    if ( root.code !== 200 ) throw new Error( 'root login failed: ' + root.raw );
    if ( who === null ) return root.json.token;
    const r = await req( 'POST', '/api/set-password',
        { who, newPassword: 'pw' + who }, root.json.token );
    if ( r.code !== 200 || !r.json.token ) throw new Error( `set-password ${ who } failed: ` + r.raw );
    return r.json.token;
}

( async () => {
    const T = {
        root: await tokenFor( null ),
        zoe: await tokenFor( 'zoe' ),
        boshue: await tokenFor( 'boshue' ),
        plain: await tokenFor( 'plain' ),
        dev2: await tokenFor( 'dev2' ),
    };
    console.log( `今天 = ${ ymd( 0 ) }；token 都拿到了\n` );

    // ── A. 提出者本人可以改，而且三個痕跡都要留 ────────────────────────────
    console.log( 'A. 提出者本人改 t001（小柔提的）' );
    const before = await onDisk( 't001' );
    const a = await req( 'PATCH', '/api/tasks/t001/wish',
        { wishDate: ymd( 2 ), wishTime: '09:30' }, T.zoe );
    ok( 'A1 回 200', a.code === 200, a );
    ok( 'A2 queued=true（有進 TG 彙整佇列）', a.json && a.json.queued === true, a.json );
    const a1 = await onDisk( 't001' );
    ok( 'A3 磁碟上 wishDate 換成新的', a1.wishDate === ymd( 2 ), a1.wishDate );
    ok( 'A4 磁碟上 wishTime 換成 09:30', a1.wishTime === '09:30', a1.wishTime );
    ok( 'A5 wishLog 從 0 變 1', before.wishLog.length === 0 && a1.wishLog.length === 1,
        { b: before.wishLog.length, a: a1.wishLog.length } );
    const log = a1.wishLog[ 0 ] || {};
    ok( 'A6 wishLog 記了誰改的', log.by === 'zoe', log );
    ok( 'A7 wishLog 記了「從什麼變成什麼」', log.from === `${ ymd( 5 ).slice( 5 ).replace( '-', '/' ) } 14:00` && log.to === `${ ymd( 2 ).slice( 5 ).replace( '-', '/' ) } 09:30`,
        { from: log.from, to: log.to } );
    const sys = a1.comments.filter( c => c.sys );
    ok( 'A8 討論區多了一條系統紀錄', sys.length === 1, a1.comments );
    ok( 'A9 系統紀錄寫了誰、從什麼到什麼、第幾次',
        sys.length === 1 && /小柔/.test( sys[ 0 ].text ) && sys[ 0 ].text.includes( ymd( 5 ).slice( 5 ).replace( '-', '/' ) + ' 14:00' )
        && /第 1 次改/.test( sys[ 0 ].text ), sys[ 0 ] && sys[ 0 ].text );
    ok( 'A10 系統紀錄的 who 跟真人分得開', sys.length === 1 && sys[ 0 ].who === '⚙ 系統紀錄',
        sys[ 0 ] && sys[ 0 ].who );

    // ── B. 負責人 / 總管理者都不能改（這次收緊的權限）────────────────────
    console.log( '\nB. 別人不能改（負責人、總管理者、沒登入）' );
    const b1 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 9 ) }, T.boshue );
    ok( 'B1 負責人（且是 admin）→ 403', b1.code === 403, b1 );
    ok( 'B2 403 訊息點名提出者是誰', b1.json && /小柔/.test( b1.json.error ), b1.json );
    const b2 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 9 ) }, T.root );
    ok( 'B3 總管理者 → 403', b2.code === 403, b2 );
    const b3 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 9 ) } );
    ok( 'B4 沒登入 → 401', b3.code === 401, b3 );
    const b4 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 9 ) }, T.plain );
    ok( 'B5 別的編導（不是這張的提出者）→ 403', b4.code === 403, b4 );
    const bAfter = await onDisk( 't001' );
    ok( 'B6 上面四次都沒寫進去（wishDate 還是 A 設的）', bAfter.wishDate === ymd( 2 ), bAfter.wishDate );
    ok( 'B7 上面四次都沒多記 wishLog', bAfter.wishLog.length === 1, bAfter.wishLog.length );

    // ── C. 舊那支 PATCH 不再能改 wish，但別的欄位照舊 ──────────────────────
    console.log( '\nC. 一般 PATCH（編輯表單那支）不能再改 wish' );
    const c1 = await req( 'PATCH', '/api/tasks/t001',
        { title: '小柔提的單', wishDate: ymd( 9 ) }, T.boshue );
    ok( 'C1 送不同的 wishDate → 403', c1.code === 403, c1 );
    ok( 'C2 403 訊息叫人去找提出者', c1.json && /只有提出需求的人能改/.test( c1.json.error ), c1.json );
    // 正控：舊前端把整份表單送回來（wish 值沒變）⇒ 不可以被擋，否則管理者連標題都改不了
    const c2 = await req( 'PATCH', '/api/tasks/t001',
        { title: '改過的標題', wishDate: ymd( 2 ), wishTime: '09:30' }, T.boshue );
    ok( 'C3 正控：wish 值沒變、只改標題 → 200', c2.code === 200, c2 );
    const c3 = await onDisk( 't001' );
    ok( 'C4 正控：標題真的存進去了', c3.title === '改過的標題', c3.title );
    ok( 'C5 正控：wish 沒被動到', c3.wishDate === ymd( 2 ) && c3.wishTime === '09:30',
        { d: c3.wishDate, t: c3.wishTime } );
    ok( 'C6 正控：也沒偷記一筆 wishLog', c3.wishLog.length === 1, c3.wishLog.length );

    // ── D. 硬性限制 ───────────────────────────────────────────────────────
    console.log( '\nD. 硬性限制：不能改到今天之前、已完成的不能改' );
    const d1 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( -1 ) }, T.zoe );
    ok( 'D1 昨天 → 400', d1.code === 400, d1 );
    ok( 'D2 400 訊息講得出原因', d1.json && /今天之前/.test( d1.json.error ), d1.json );
    const d2 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( -30 ) }, T.zoe );
    ok( 'D3 一個月前 → 400', d2.code === 400, d2 );
    // 正控：今天可以（邊界就在今天，⛔ 不是明天）
    const d3 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 0 ) }, T.zoe );
    ok( 'D4 正控：今天 → 200', d3.code === 200, d3 );
    const d3d = await onDisk( 't001' );
    ok( 'D5 正控：今天真的存進去了', d3d.wishDate === ymd( 0 ), d3d.wishDate );
    ok( 'D6 正控：時刻被清掉了（這次沒送 wishTime）', d3d.wishTime === '', d3d.wishTime );
    ok( 'D7 wishLog 累加到 2', d3d.wishLog.length === 2, d3d.wishLog.length );

    const d4 = await req( 'PATCH', '/api/tasks/t003/wish', { wishDate: ymd( 5 ) }, T.zoe );
    ok( 'D8 已完成的單（t003，她自己提的）→ 400', d4.code === 400, d4 );
    ok( 'D9 400 訊息講得出原因', d4.json && /已經完成/.test( d4.json.error ), d4.json );
    const d4d = await onDisk( 't003' );
    ok( 'D10 已完成的單一個字都沒被改到',
        d4d.wishDate === ymd( 3 ) && d4d.wishLog.length === 0 && !d4d.comments.some( c => c.sys ),
        { d: d4d.wishDate, n: d4d.wishLog.length } );

    // ── E. 舊單沒有 requesterId ───────────────────────────────────────────
    console.log( '\nE. v4 之前的舊單（沒有 requesterId）' );
    const e1 = await req( 'PATCH', '/api/tasks/t002/wish', { wishDate: ymd( 5 ) }, T.zoe );
    ok( 'E1 同名的人也改不了 → 403', e1.code === 403, e1 );
    ok( 'E2 403 訊息說得出是舊單的問題', e1.json && /舊單/.test( e1.json.error ), e1.json );
    const e2 = await onDisk( 't002' );
    ok( 'E3 舊單沒被改到', e2.wishDate === ymd( 6 ) && e2.wishLog.length === 0, e2.wishDate );

    // ── F. 輸入驗證 ───────────────────────────────────────────────────────
    console.log( '\nF. 輸入驗證（打錯字不要被當成「我要清掉」）' );
    const f1 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: '2026/09/30' }, T.zoe );
    ok( 'F1 日期格式錯 → 400（⛔ 不是默默清掉）', f1.code === 400, f1 );
    const f2 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 3 ), wishTime: '25:00' }, T.zoe );
    ok( 'F2 時刻格式錯 → 400', f2.code === 400, f2 );
    const f3 = await req( 'PATCH', '/api/tasks/t001/wish', { wishTime: '10:00' }, T.zoe );
    ok( 'F3 只給時刻沒給日期 → 400', f3.code === 400, f3 );
    const f3b = await onDisk( 't001' );
    ok( 'F4 上面三次都沒寫進去', f3b.wishDate === ymd( 0 ) && f3b.wishLog.length === 2,
        { d: f3b.wishDate, n: f3b.wishLog.length } );

    // ── G. 沒改到就不要留痕跡 ─────────────────────────────────────────────
    console.log( '\nG. 送一樣的值（表單沒動就按了儲存）' );
    const g1 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: ymd( 0 ) }, T.zoe );
    ok( 'G1 回 200', g1.code === 200, g1 );
    ok( 'G2 queued=false（⛔ 不吵 TG）', g1.json && g1.json.queued === false, g1.json );
    const g1d = await onDisk( 't001' );
    ok( 'G3 wishLog 沒有多一筆', g1d.wishLog.length === 2, g1d.wishLog.length );
    ok( 'G4 也沒多一條系統紀錄', g1d.comments.filter( c => c.sys ).length === 2,
        g1d.comments.filter( c => c.sys ).length );

    // ── H. 清掉希望時間 ───────────────────────────────────────────────────
    console.log( '\nH. 提出者把希望時間清掉' );
    const h1 = await req( 'PATCH', '/api/tasks/t001/wish', { wishDate: '', wishTime: '' }, T.zoe );
    ok( 'H1 回 200', h1.code === 200, h1 );
    const h1d = await onDisk( 't001' );
    ok( 'H2 wishDate 真的空了', h1d.wishDate === '', h1d.wishDate );
    ok( 'H3 清掉也算一次異動（wishLog = 3）', h1d.wishLog.length === 3, h1d.wishLog.length );
    ok( 'H4 紀錄寫成「→ 未定」', ( h1d.wishLog[ 2 ] || {} ).to === '未定', h1d.wishLog[ 2 ] );

    // ── I. 從備份貼回來、少了 wishLog 的單 ────────────────────────────────
    console.log( '\nI. 磁碟上少了 wishLog 的單（t006）' );
    const i1 = await req( 'PATCH', '/api/tasks/t006/wish', { wishDate: ymd( 7 ) }, T.zoe );
    ok( 'I1 照樣改得動（讀檔邊界補過形狀）', i1.code === 200, i1 );
    const i1d = await onDisk( 't006' );
    ok( 'I2 wishLog 存成長度 1 的陣列',
        Array.isArray( i1d.wishLog ) && i1d.wishLog.length === 1, i1d.wishLog );

    // ── J. 無主單也適用（提出者是誰才是關鍵，不是有沒有負責人）──────────
    console.log( '\nJ. 無主單（t005，小平提的）' );
    const j1 = await req( 'PATCH', '/api/tasks/t005/wish', { wishDate: ymd( 8 ) }, T.plain );
    ok( 'J1 提出者本人改得動', j1.code === 200, j1 );
    const j2 = await req( 'PATCH', '/api/tasks/t005/wish', { wishDate: ymd( 9 ) }, T.boshue );
    ok( 'J2 別人即使「誰都能接的無主單」也改不了 wish', j2.code === 403, j2 );
    const j2d = await onDisk( 't005' );
    ok( 'J3 只有本人那次寫進去', j2d.wishDate === ymd( 8 ) && j2d.wishLog.length === 1,
        { d: j2d.wishDate, n: j2d.wishLog.length } );

    // ── K. 端點不存在的 method ────────────────────────────────────────────
    console.log( '\nK. 端點邊界' );
    const k1 = await req( 'POST', '/api/tasks/t001/wish', { wishDate: ymd( 5 ) }, T.zoe );
    ok( 'K1 POST 不是這支端點的 method（不該悄悄生效）', k1.code !== 200, k1.code );
    const k2 = await req( 'PATCH', '/api/tasks/nope/wish', { wishDate: ymd( 5 ) }, T.zoe );
    ok( 'K2 不存在的單 → 404', k2.code === 404, k2 );

    // ── M. 提出者＝負責人＝admin 同一個人（t004）───────────────────────────
    // ⚠️ 這種人最容易被新守門誤傷：他走的是 isRequester 那條，但他同時也吃 canEdit
    console.log( '\nM. 自己提自己做（t004，柏學提、柏學做、又是 admin）' );
    const m1 = await req( 'PATCH', '/api/tasks/t004/wish', { wishDate: ymd( 7 ) }, T.boshue );
    ok( 'M1 本人改得動（不會因為他也是負責人就走錯分支）', m1.code === 200, m1 );
    const m1d = await onDisk( 't004' );
    ok( 'M2 磁碟上寫進去了、wishLog 記到他名下',
        m1d.wishDate === ymd( 7 ) && m1d.wishLog.length === 1 && m1d.wishLog[ 0 ].by === 'boshue',
        { d: m1d.wishDate, n: m1d.wishLog.length, by: ( m1d.wishLog[ 0 ] || {} ).by } );
    // 正控：他用編輯表單改別的欄位不可以被新守門擋掉
    const m2 = await req( 'PATCH', '/api/tasks/t004',
        { title: '自己提自己做（改過）', wishDate: ymd( 7 ) }, T.boshue );
    ok( 'M3 正控：他仍然能用編輯表單改標題 → 200', m2.code === 200, m2 );
    const m2d = await onDisk( 't004' );
    ok( 'M4 正控：標題進去了、wish 沒被動、沒偷記 wishLog',
        m2d.title === '自己提自己做（改過）' && m2d.wishDate === ymd( 7 ) && m2d.wishLog.length === 1,
        { t: m2d.title, d: m2d.wishDate, n: m2d.wishLog.length } );
    // 另一個 admin 不給豁免
    const m3 = await req( 'PATCH', '/api/tasks/t004/wish', { wishDate: ymd( 8 ) }, T.dev2 );
    ok( 'M5 別的 admin 改不動（admin 不是豁免）', m3.code === 403, m3 );
    ok( 'M6 M5 那次沒寫進去', ( await onDisk( 't004' ) ).wishDate === ymd( 7 ), m3 );
    // ── L. TG 彙整的訊息長相（TG 關著 ⇒ 全文會印在 server log）────────────
    console.log( '\nL. 等 TG 彙整 flush（notifyDebounceMs = 1500）…' );
    await sleep( 2600 );
    const logTxt = fs.readFileSync( path.join( DIR, 'srv.log' ), 'utf8' );
    const blocks = logTxt.split( '[tg] 未啟用，略過推播\n' ).slice( 1 );
    ok( 'L1 真的有走到 tgSend（＝進了彙整、也選到了收件人）', blocks.length > 0, blocks.length );
    const all = blocks.join( '\n---\n' );
    ok( 'L2 訊息裡有「🙏 希望完成」這個欄位名', /🙏 希望完成/.test( all ), all.slice( 0, 400 ) );
    ok( 'L3 訊息裡有「舊 → 新」', /🙏 希望完成 .+ → <b>.+<\/b>/.test( all ), all.slice( 0, 400 ) );
    ok( 'L4 掛在「你追蹤的項目有異動」那個既有標題下（＝併進現有彙整，沒有新開一種）',
        /你追蹤的項目有異動/.test( all ), all.slice( 0, 200 ) );

    console.log( '\n──────────────────────────────' );
    console.log( `通過 ${ pass } / 失敗 ${ fail }` );
    if ( fail ) console.log( '失敗清單：\n  ' + fails.join( '\n  ' ) );
    console.log( '\n── 供人工核對：t001 的系統紀錄全文 ──' );
    for ( const c of ( await onDisk( 't001' ) ).comments ) {
        if ( c.sys ) console.log( `  [${ c.who }] ${ c.text }` );
    }
    console.log( '\n── 供人工核對：TG 訊息全文 ──' );
    console.log( all.split( '\n---\n' ).map( b => b.trim() ).join( '\n\n───\n' ) );
    process.exit( fail ? 1 : 0 );
} )().catch( e => { console.error( 'harness 自己炸了：', e ); process.exit( 2 ); } );
