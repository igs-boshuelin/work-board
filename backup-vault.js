// 異地備份：config.json 壓縮＋加密成 vault.enc.json，auth.json / data.json 原樣複製，
// 一起推到另一個 private repo（預設 ../work-board-data）。零依賴，只用 Node 內建模組。
//
//   node backup-vault.js init       產一把新金鑰（只有第一次做，⚠️ 會叫你去抄一份）
//   node backup-vault.js push       備份＋commit＋push（工作排程器跑的就是這支）
//   node backup-vault.js verify     解開雲端上那份，確認它真的還原得回來
//   node backup-vault.js restore    解到 restored/ 底下（⛔ 不會蓋掉正在用的檔）
//
// ⚠️⚠️ 金鑰只存在 vault.key 這一個檔，而且**不進版控**。
//      硬碟掛掉而你沒有另外抄一份 ⇒ 雲端那份是永遠解不開的亂碼，等於沒備份。
//      所以 init 會逼你把金鑰抄到密碼管理器，⛔ 不要跳過那一步。

const fs = require( 'fs' );
const path = require( 'path' );
const zlib = require( 'zlib' );
const https = require( 'https' );
const crypto = require( 'crypto' );
const { execFileSync } = require( 'child_process' );

const ROOT = __dirname;
const KEY_PATH = path.join( ROOT, 'vault.key' );
// 備份 repo 的位置。放在專案隔壁，兩個 repo 各自乾淨。
// 換位置的話改這一行（或設環境變數 WB_VAULT_DIR）。
const VAULT_DIR = process.env.WB_VAULT_DIR || path.resolve( ROOT, '..', 'work-board-data' );
const VAULT_FILE = path.join( VAULT_DIR, 'vault.enc.json' );
const MANIFEST = path.join( VAULT_DIR, 'MANIFEST.txt' );

// 要備份哪些檔。⚠️ 往後加不要插中間 —— restore 出來的目錄結構人會照著看。
const FILES = [ 'config.json', 'auth.json', 'data.json' ];
// 只有 config.json 加密（botToken、adminPassword）。其餘兩個是內部資料，
// 2026-09-23 使用者裁定明碼存 —— 在 GitHub 上看得到每次改了什麼。
// ⛔ 要把哪個檔改成明碼前先想清楚：明碼推上去就永遠在 git 歷史裡，事後改回加密也收不回來。
const SECRET_FILES = [ 'config.json' ];
const PLAIN_FILES = FILES.filter( n => SECRET_FILES.indexOf( n ) < 0 );
// 儲存格式的版本，算進「沒變就跳過」的雜湊 —— 換格式時來源檔沒變也要重寫一次，
// 否則舊格式的備份會一直留著（第一次改成部分明碼時就會踩到）。
const LAYOUT = 2;

// ── 小工具 ───────────────────────────────────────────────────────────────────

// 用丟的而不是直接 process.exit —— push 失敗時進入點要先發完 TG 才能結束。
class Fatal extends Error {}
function die( msg ) {
    throw new Fatal( msg );
}

function git( args, opts ) {
    return execFileSync( 'git', [ '-C', VAULT_DIR ].concat( args ),
        Object.assign( { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] }, opts ) ).trim();
}

function sha256( buf ) {
    return crypto.createHash( 'sha256' ).update( buf ).digest( 'hex' );
}

function stamp() {
    const d = new Date();
    const p = n => String( n ).padStart( 2, '0' );
    return `${ d.getFullYear() }-${ p( d.getMonth() + 1 ) }-${ p( d.getDate() ) } `
        + `${ p( d.getHours() ) }:${ p( d.getMinutes() ) }`;
}

function loadKey() {
    if ( !fs.existsSync( KEY_PATH ) ) {
        die( `找不到金鑰 ${ KEY_PATH }\n`
            + '   第一次用請先跑：node backup-vault.js init\n'
            + '   已經有金鑰（在密碼管理器裡）的話，把那串 64 個 16 進位字元存成 vault.key' );
    }
    const hex = fs.readFileSync( KEY_PATH, 'utf8' ).trim();
    // 金鑰是人手貼進來的 ⇒ 這裡要擋。貼錯長度的話，下面解密只會吐一句看不懂的錯。
    if ( !/^[0-9a-f]{64}$/i.test( hex ) ) {
        die( `vault.key 的內容不是 64 個 16 進位字元（現在是 ${ hex.length } 個字元）。\n`
            + '   ⚠️ 從密碼管理器貼過來時很容易多帶到空白或換行，檢查一下。' );
    }
    return Buffer.from( hex, 'hex' );
}

// ── 加密／解密 ───────────────────────────────────────────────────────────────

// 明文長這樣：{ v, at, files: { 檔名: 內容字串 } }，gzip 之後用 AES-256-GCM 包起來。
// GCM 自帶完整性驗證 —— 檔案被改過一個位元組，解密就會直接丟例外，不會悄悄給你壞資料。
function encrypt( plainBuf, key ) {
    const iv = crypto.randomBytes( 12 );
    const c = crypto.createCipheriv( 'aes-256-gcm', key, iv );
    const data = Buffer.concat( [ c.update( plainBuf ), c.final() ] );
    return {
        v: 1,
        alg: 'aes-256-gcm',
        note: '解開的方式寫在 work-board 的 README §8.7，以及這個 repo 的 README。',
        at: new Date().toISOString(),
        iv: iv.toString( 'hex' ),
        tag: c.getAuthTag().toString( 'hex' ),
        data: data.toString( 'base64' ),
    };
}

function decrypt( env, key ) {
    if ( env.v !== 1 || env.alg !== 'aes-256-gcm' ) {
        die( `不認得的備份格式（v=${ env.v } alg=${ env.alg }）` );
    }
    const d = crypto.createDecipheriv( 'aes-256-gcm', key, Buffer.from( env.iv, 'hex' ) );
    d.setAuthTag( Buffer.from( env.tag, 'hex' ) );
    return Buffer.concat( [ d.update( Buffer.from( env.data, 'base64' ) ), d.final() ] );
}

function readSources() {
    const files = {};
    for ( const name of FILES ) {
        const p = path.join( ROOT, name );
        // auth.json 在全新安裝時可能還不存在，那不是錯 —— 記成 null，restore 時就不會生一個空殼。
        files[ name ] = fs.existsSync( p ) ? fs.readFileSync( p, 'utf8' ) : null;
    }
    return files;
}

// ── init ─────────────────────────────────────────────────────────────────────

function cmdInit() {
    if ( fs.existsSync( KEY_PATH ) ) {
        die( `vault.key 已經存在了。\n`
            + '   ⚠️ 換一把新的金鑰，等於雲端上**所有舊的備份都解不開了**。\n'
            + '   真的要換的話，先手動把舊的 vault.key 改名留著，再跑一次 init。' );
    }
    const key = crypto.randomBytes( 32 ).toString( 'hex' );
    fs.writeFileSync( KEY_PATH, key + '\n', 'utf8' );
    console.log( '\n新金鑰已經寫進 ' + KEY_PATH + '（這個檔不會進版控）\n' );
    console.log( '════════════════════════════════════════════════════════════════════' );
    console.log( key );
    console.log( '════════════════════════════════════════════════════════════════════\n' );
    console.log( '⚠️⚠️ 現在就把上面那串抄到密碼管理器（或任何不在這台電腦上的地方）。' );
    console.log( '     這台硬碟掛掉而你沒有另一份 ⇒ 雲端的備份是永遠解不開的亂碼，' );
    console.log( '     整套備份等於沒有做。⛔ 不要想說「之後再抄」。\n' );
}

// ── push ─────────────────────────────────────────────────────────────────────

function cmdPush() {
    const key = loadKey();
    if ( !fs.existsSync( path.join( VAULT_DIR, '.git' ) ) ) {
        die( `${ VAULT_DIR } 不是一個 git repo。\n`
            + '   建立方式寫在 work-board 的 README §8.7。' );
    }

    const files = readSources();
    const secret = {};
    for ( const n of SECRET_FILES ) secret[ n ] = files[ n ];
    const plain = Buffer.from( JSON.stringify( { v: 1, at: new Date().toISOString(), files: secret } ), 'utf8' );
    // ⚠️ 雜湊**只算 files（＋格式版本）**，不要算整包 —— 整包裡有時間戳，每次都不一樣，
    //    下面那個「沒變就跳過」會永遠不成立，變成什麼都沒改也天天 commit。
    const plainHash = sha256( Buffer.from( JSON.stringify( { layout: LAYOUT, files } ), 'utf8' ) );

    // 內容沒變就整個跳過。⚠️ 不能用密文比 —— 每次 IV 都不一樣，密文一定不同，
    //    比密文的話會變成「什麼都沒改也天天 commit」。
    const prev = fs.existsSync( MANIFEST ) ? fs.readFileSync( MANIFEST, 'utf8' ) : '';
    const m = /^來源雜湊: ([0-9a-f]{64})$/m.exec( prev );
    if ( m && m[ 1 ] === plainHash ) {
        console.log( `[${ stamp() }] 內容跟上一次備份一樣，跳過。` );
        return;
    }

    const gz = zlib.gzipSync( plain, { level: 9 } );
    const env = encrypt( gz, key );

    // ⭐ 寫出去之前先解回來對一次。少了這一步，「備份有在跑」跟「備份解得開」是兩件事，
    //    而你會在需要它的那天才發現是後者。
    const back = zlib.gunzipSync( decrypt( env, key ) );
    if ( !back.equals( plain ) ) die( '自我檢查失敗：加密後解回來跟原文對不上。沒有寫出任何東西。' );

    fs.writeFileSync( VAULT_FILE, JSON.stringify( env ), 'utf8' );
    // 明碼的原樣放。來源不存在（全新安裝還沒有 auth.json）就把 repo 裡那份也拿掉，保持跟來源一致。
    for ( const n of PLAIN_FILES ) {
        const p = path.join( VAULT_DIR, n );
        if ( files[ n ] === null ) { if ( fs.existsSync( p ) ) fs.unlinkSync( p ); }
        else fs.writeFileSync( p, files[ n ], 'utf8' );
    }

    // MANIFEST 是給人在 GitHub 網頁上「不解密也看得出備份有沒有在跑」用的。
    // ⛔ 只放不敏感的：時間、大小、單數。不要把內容摘要寫進來。
    const data = files[ 'data.json' ] ? JSON.parse( files[ 'data.json' ] ) : null;
    const lines = [
        '接單看板 加密備份',
        '',
        `備份時間: ${ stamp() }`,
        `來源雜湊: ${ plainHash }`,
        `密文大小: ${ fs.statSync( VAULT_FILE ).size } bytes`,
        '',
        '內含檔案:',
        ...FILES.map( n => `  ${ n.padEnd( 14 ) } ${ files[ n ] === null ? '（不存在，沒備）' : files[ n ].length + ' 字元' }`
            + `　${ SECRET_FILES.indexOf( n ) >= 0 ? '加密，在 vault.enc.json 裡' : '明碼' }` ),
        '',
        data ? `工單數: ${ data.tasks.length }　人員數: ${ ( data.members || [] ).length }　資料版本: v${ data.v }` : '',
        '',
        '⚠️ 這個檔只是給人確認備份有在跑。怎麼還原：看這個 repo 的 README.md。',
    ];
    fs.writeFileSync( MANIFEST, lines.join( '\n' ) + '\n', 'utf8' );

    git( [ 'add', '-A' ] );
    if ( !git( [ 'status', '--porcelain' ] ) ) {
        console.log( `[${ stamp() }] 寫出來的檔跟 repo 裡的一樣，沒有東西要 commit。` );
        return;
    }
    git( [ 'commit', '-q', '-m', `備份 ${ stamp() }` ] );
    git( [ 'push', '-q', 'origin', 'HEAD' ] );
    console.log( `[${ stamp() }] 備份完成並已推上去（密文 ${ fs.statSync( VAULT_FILE ).size } bytes）。` );
}

// ── 讀回備份（verify / restore 共用）─────────────────────────────────────────

// 解開 vault.enc.json，再疊上 repo 裡的明碼檔。
// 舊格式（2026-09-23 之前，三個檔全在密文裡、沒有明碼檔）照樣讀得出來 —— 明碼檔不在就用密文裡那份。
function readVault( key ) {
    if ( !fs.existsSync( VAULT_FILE ) ) die( `找不到 ${ VAULT_FILE } —— 備份從來沒跑成功過。` );
    const env = JSON.parse( fs.readFileSync( VAULT_FILE, 'utf8' ) );
    const files = JSON.parse( zlib.gunzipSync( decrypt( env, key ) ).toString( 'utf8' ) ).files;
    for ( const n of PLAIN_FILES ) {
        const p = path.join( VAULT_DIR, n );
        if ( fs.existsSync( p ) ) files[ n ] = fs.readFileSync( p, 'utf8' );
    }
    return { at: env.at, files };
}

// ── verify ───────────────────────────────────────────────────────────────────

function cmdVerify() {
    const key = loadKey();
    console.log( '先把雲端最新的抓下來…' );
    // ⚠️ 用目前分支名去對，不要用 origin/HEAD —— 剛 clone 完的 repo 沒有 origin/HEAD 這個 ref，
    //    第一次 verify 會直接錯在一句看不懂的 "unknown revision"。
    const br = git( [ 'rev-parse', '--abbrev-ref', 'HEAD' ] );
    git( [ 'fetch', '-q', 'origin' ] );
    git( [ 'reset', '-q', '--hard', 'origin/' + br ] );

    const vault = readVault( key );

    console.log( '\n✓ 解得開，而且內容是合法的 JSON。' );
    console.log( '  備份時間:', vault.at );
    for ( const name of FILES ) {
        const v = vault.files[ name ];
        if ( v === null || v === undefined ) { console.log( `  ${ name.padEnd( 14 ) } —（沒有備到）` ); continue; }
        // 逐檔真的 parse 一次，不只看長度 —— 截斷一半的 JSON 長度也是有的。
        const o = JSON.parse( v );
        const extra = name === 'data.json' ? `　工單 ${ o.tasks.length } 張` : '';
        console.log( `  ${ name.padEnd( 14 ) } ${ v.length } 字元　parse ✓${ extra }` );
    }
    console.log( '' );
}

// ── restore ──────────────────────────────────────────────────────────────────

function cmdRestore() {
    const key = loadKey();
    const out = path.join( ROOT, 'restored' );
    // ⛔ 刻意解到 restored/ 而不是直接蓋回去 —— 服務跑著的時候蓋掉 data.json，
    //    記憶體裡那份會在下一次 saveData() 把你還原的東西整份蓋回去，而且沒有任何錯誤訊息。
    //    要用哪一份請自己關掉服務再手動複製過去。
    const vault = readVault( key );

    fs.mkdirSync( out, { recursive: true } );
    for ( const name of FILES ) {
        if ( vault.files[ name ] === null || vault.files[ name ] === undefined ) continue;
        fs.writeFileSync( path.join( out, name ), vault.files[ name ], 'utf8' );
        console.log( '寫出', path.join( out, name ) );
    }
    console.log( `\n備份時間: ${ vault.at }` );
    console.log( '⚠️ 這幾個檔**沒有**蓋回去。要用的話：先把看板服務關掉，再手動複製過去。' );
    console.log( '   服務跑著的時候蓋 data.json，會被下一次寫入整份蓋回來，而且不會報錯。\n' );
}

// ── 失敗通知 ─────────────────────────────────────────────────────────────────

// push 是排程器在背景跑的，失敗只會寫進 backup-vault.log —— 沒人會去看。
// 所以失敗時私訊「全權管理者（members[].admin）裡有綁 TG 的人」（跟看板同一個 bot）。
// ⛔ 不發群組 —— 備份失敗是管理者的事，一般成員收到也做不了什麼。
// ⚠️ 這裡是外部邊界（網路、人手改的 json），失敗只記一行、不丟 —— 通知失敗不能蓋掉原本的錯誤。
//    而且備份失敗的原因本身就可能是這幾個檔壞了，所以每個都要各自擋。
// ⛔ 只管「跑了但失敗」。排程器根本沒在跑的話這裡不會執行，那要看 MANIFEST 的備份時間。
function readJson( name ) {
    try {
        return JSON.parse( fs.readFileSync( path.join( ROOT, name ), 'utf8' ) );
    } catch ( e ) {
        console.error( `[tg] 讀不到 ${ name }，沒有發通知：${ e.message }` );
        return null;
    }
}

function notifyFailure( msg ) {
    const config = readJson( 'config.json' );
    const data = readJson( 'data.json' );
    const auth = readJson( 'auth.json' );
    if ( !config || !data || !auth ) return Promise.resolve();
    const tg = config.telegram;
    if ( !tg || !tg.enabled || !tg.botToken ) {
        console.error( '[tg] config.json 的 telegram 沒啟用或缺 botToken，沒有發通知。' );
        return Promise.resolve();
    }
    const subs = auth.subscribers || {};
    const targets = ( data.members || [] ).filter( m => m.admin && subs[ m.id ] && subs[ m.id ].tgChatId );
    if ( !targets.length ) {
        console.error( '[tg] 沒有任何全權管理者綁了 TG，沒有發通知。' );
        return Promise.resolve();
    }
    const text = `⛔ 接單看板加密備份失敗（${ stamp() }）\n\n${ msg.slice( 0, 1500 ) }\n\n詳細看 work-board/backup-vault.log`;
    return Promise.all( targets.map( m => sendTo( tg.botToken, subs[ m.id ].tgChatId, text, m.name ) ) );
}

function sendTo( token, chatId, text, who ) {
    const body = JSON.stringify( { chat_id: chatId, text } );
    return new Promise( resolve => {
        const req = https.request( {
            hostname: 'api.telegram.org',
            path: `/bot${ token }/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength( body ) },
            timeout: 15000,
        }, res => {
            let s = '';
            res.on( 'data', c => s += c );
            res.on( 'end', () => {
                console.error( res.statusCode === 200 ? `[tg] 已發失敗通知 → ${ who }`
                    : `[tg] 通知 ${ who } 失敗 HTTP ${ res.statusCode }：${ s.slice( 0, 200 ) }` );
                resolve();
            } );
        } );
        req.on( 'timeout', () => req.destroy( new Error( '逾時' ) ) );
        req.on( 'error', e => { console.error( `[tg] 通知 ${ who } 失敗：${ e.message }` ); resolve(); } );
        req.end( body );
    } );
}

// ── 進入點 ───────────────────────────────────────────────────────────────────

const cmd = process.argv[ 2 ];
const run = { init: cmdInit, push: cmdPush, verify: cmdVerify, restore: cmdRestore }[ cmd ];
if ( run ) {
    try {
        run();
    } catch ( e ) {
        // git 失敗時 e.message 已經帶著 git 的 stderr，不用另外接。
        const msg = e.message;
        // 非 Fatal 的（git 失敗、程式本身的 bug）印完整堆疊；Fatal 是寫好的說明，印訊息就夠。
        console.error( '\n⛔ ' + ( e instanceof Fatal ? msg : e.stack ) + '\n' );
        process.exitCode = 1;
        if ( cmd === 'push' ) notifyFailure( msg );
    }
}
else {
    console.log( '用法: node backup-vault.js <init|push|verify|restore>' );
    console.log( '  init     第一次用，產一把金鑰（會叫你抄到密碼管理器）' );
    console.log( '  push     備份＋commit＋push（工作排程器跑這個）' );
    console.log( '  verify   把雲端那份抓下來解開，確認真的還原得回來' );
    console.log( '  restore  解到 restored/ 底下（不會蓋掉正在用的檔）' );
    process.exit( 1 );
}
