'use strict';

// TG bot 設定助手： node setup-tg.js
//   1. 驗證 config.json 裡的 botToken
//   2. 自動撈出 bot 看得到的聊天室，讓你用數字選
//   3. 把 chatId 寫回 config.json 並發一則測試訊息
// token 要你自己貼進 config.json —— 這支程式不會問你、也不會把它印出來。

const fs = require( 'fs' );
const path = require( 'path' );
const https = require( 'https' );
const readline = require( 'readline' );

const CONFIG_PATH = path.join( __dirname, 'config.json' );

function tg( token, method ) {
    return new Promise( ( resolve, reject ) => {
        https.get( `https://api.telegram.org/bot${ token }/${ method }`, res => {
            let buf = '';
            res.on( 'data', c => buf += c );
            res.on( 'end', () => {
                try { resolve( JSON.parse( buf ) ); }
                catch ( e ) { reject( new Error( `回應不是 JSON：${ buf.slice( 0, 200 ) }` ) ); }
            } );
        } ).on( 'error', reject );
    } );
}

function ask( q ) {
    const rl = readline.createInterface( { input: process.stdin, output: process.stdout } );
    return new Promise( r => rl.question( q, a => { rl.close(); r( a.trim() ); } ) );
}

function die( msg ) {
    console.log( `\n❌ ${ msg }\n` );
    process.exit( 1 );
}

( async () => {
    // 記事本存 UTF-8 會加 BOM，不剝掉的話 JSON.parse 會炸在 position 0
    const config = JSON.parse( fs.readFileSync( CONFIG_PATH, 'utf8' ).replace( /^﻿/, '' ) );
    const token = config.telegram.botToken;

    console.log( '\n=== 接單看板 · TG bot 設定 ===\n' );

    if ( !token ) {
        console.log( '還沒有 botToken。請先：' );
        console.log( '  1. TG 裡找 @BotFather → 送 /newbot → 照著取名' );
        console.log( '  2. 它會給你一組 token（像 8123456789:AAH...）' );
        console.log( `  3. 貼進 ${ CONFIG_PATH } 的 telegram.botToken` );
        console.log( '  4. 再跑一次 node setup-tg.js\n' );
        process.exit( 0 );
    }

    // 1. 驗證 token
    const me = await tg( token, 'getMe' );
    if ( !me.ok ) die( `token 無效：${ me.description }` );
    console.log( `✅ bot 是 @${ me.result.username }（${ me.result.first_name }）\n` );

    // 2. 撈聊天室
    console.log( '正在找這支 bot 看得到的聊天室…' );
    const upd = await tg( token, 'getUpdates' );
    if ( !upd.ok ) die( `getUpdates 失敗：${ upd.description }` );

    const chats = new Map();
    for ( const u of upd.result ) {
        const m = u.message || u.channel_post || u.my_chat_member;
        if ( m && m.chat ) chats.set( m.chat.id, m.chat );
    }

    if ( !chats.size ) {
        console.log( '\n⚠  一個都沒找到。TG bot 預設開著 privacy mode，' );
        console.log( '   看不到群組裡的普通訊息，所以要這樣做：\n' );
        console.log( `  1. 把 @${ me.result.username } 加進編導的群組` );
        console.log( `  2. 在那個群裡發一則 /start@${ me.result.username }` );
        console.log( '     （一定要是斜線指令，純文字它收不到）' );
        console.log( '  3. 再跑一次 node setup-tg.js\n' );
        process.exit( 0 );
    }

    const list = [ ...chats.values() ];
    console.log( '\n找到這些：\n' );
    list.forEach( ( c, i ) => {
        const name = c.title || [ c.first_name, c.last_name ].filter( Boolean ).join( ' ' ) || c.username || '(無名稱)';
        const kind = c.type === 'private' ? '私訊' : c.type === 'channel' ? '頻道' : '群組';
        console.log( `  [${ i + 1 }] ${ name }   ${ kind }   id=${ c.id }` );
    } );

    const pick = await ask( '\n推播要送到哪一個？輸入編號（直接 Enter 取消）：' );
    if ( !pick ) { console.log( '已取消，沒有改動。\n' ); process.exit( 0 ); }

    const chat = list[ Number( pick ) - 1 ];
    if ( !chat ) die( `沒有編號 ${ pick } 這個選項` );

    // 3. 寫回 config 並試發
    config.telegram.chatId = String( chat.id );
    config.telegram.enabled = true;
    fs.writeFileSync( CONFIG_PATH, JSON.stringify( config, null, 2 ) + '\n', 'utf8' );
    console.log( `\n✅ 已寫入 config.json：chatId=${ chat.id }、enabled=true` );

    const body = JSON.stringify( {
        chat_id: chat.id,
        text: '✅ 接單看板連上了。之後估時或預計完成日有異動就會推到這裡。',
    } );
    await new Promise( ( resolve, reject ) => {
        const req = https.request( {
            hostname: 'api.telegram.org',
            path: `/bot${ token }/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength( body ) },
        }, res => {
            let buf = '';
            res.on( 'data', c => buf += c );
            res.on( 'end', () => {
                if ( res.statusCode === 200 ) { console.log( '✅ 測試訊息已送出，去群裡看一下。' ); resolve(); }
                else { console.log( `❌ 測試訊息失敗 (${ res.statusCode })：${ buf }` ); resolve(); }
            } );
        } );
        req.on( 'error', reject );
        req.end( body );
    } );

    console.log( '\n最後一步：重啟看板服務（config.json 只在啟動時讀）。\n' );
} )().catch( e => die( e.message ) );
