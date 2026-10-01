// 國定假日表：從人事行政總處的「政府行政機關辦公日曆表」抓下來，寫成 holidays.json。
// 零依賴，只用 Node 內建模組。
//
//   node update-holidays.js              抓今年＋明年
//   node update-holidays.js 2027 2028    指定年份（西元）
//
// 每年 6～7 月總處會公布明年的表，⚠️ 那之後跑一次、看過差異再 commit。
// 年中如果有修法加假（例：114 年 10 月那次），平台上會多一份「(更新)」—— 一樣重跑就好。
// 改完要**重開服務**才會生效（holidays.json 是開機讀的）。
//
// 只存「跟平常不一樣」的日子：off ＝ 平日放假，on ＝ 週末補班。
// 平常哪幾天上班仍然看 config.json 的 workHours.workdays。

const fs = require( 'fs' );
const path = require( 'path' );
const https = require( 'https' );

const ROOT = __dirname;
const OUT = path.join( ROOT, 'holidays.json' );
const DATASET_API = 'https://data.gov.tw/api/v2/rest/dataset/14718';
const DATASET_PAGE = 'https://data.gov.tw/dataset/14718';

function die( msg ) {
    console.error( `\n⛔ ${ msg }\n` );
    process.exit( 1 );
}

function get( url ) {
    return new Promise( ( resolve, reject ) => {
        https.get( url, res => {
            if ( res.statusCode >= 300 && res.statusCode < 400 && res.headers.location ) {
                res.resume();
                return resolve( get( new URL( res.headers.location, url ).href ) );
            }
            const chunks = [];
            res.on( 'data', c => chunks.push( c ) );
            res.on( 'end', () => {
                if ( res.statusCode !== 200 ) return reject( new Error( `HTTP ${ res.statusCode }：${ url }` ) );
                resolve( Buffer.concat( chunks ) );
            } );
        } ).on( 'error', reject );
    } );
}

// 平台上同一年可能有好幾份：Google 行事曆專用版（格式不同）、「(更新)」修正版。
// 挑非 Google 版裡**最後列出的**那份 —— 修正版是後來補上去的，會排在後面。
function pickResource( list, year ) {
    const roc = year - 1911;
    const hits = list.filter( r => {
        const t = String( r.resourceDescription || '' );
        return t.indexOf( `${ roc }年` ) === 0 && t.indexOf( '辦公日曆表' ) >= 0
            && t.indexOf( 'Google' ) < 0 && String( r.resourceFormat || '' ).toUpperCase() === 'CSV';
    } );
    return hits.length ? hits[ hits.length - 1 ] : null;
}

// CSV：西元日期,星期,是否放假,備註 —— 是否放假 2＝放假、0＝上班
function parseCsv( buf, year ) {
    let text = buf.toString( 'utf8' ).replace( /^﻿/, '' );
    // 早年的檔是 Big5，用 utf8 解會出現替代字元
    if ( text.indexOf( '�' ) >= 0 ) text = new TextDecoder( 'big5' ).decode( buf );
    const lines = text.split( /\r?\n/ ).filter( l => l.trim() );
    const head = lines[ 0 ].split( ',' ).map( s => s.trim() );
    if ( head[ 0 ] !== '西元日期' || head[ 2 ] !== '是否放假' ) {
        die( `${ year } 年的表頭不是預期的格式：「${ lines[ 0 ] }」—— 總處可能改了格式，要改這支程式` );
    }
    const rows = lines.slice( 1 );
    const leap = new Date( year, 1, 29 ).getMonth() === 1;
    if ( rows.length !== ( leap ? 366 : 365 ) ) die( `${ year } 年只有 ${ rows.length } 天，表不完整` );

    const off = {}, on = {};
    for ( const line of rows ) {
        const c = line.split( ',' );
        const ymd = c[ 0 ].trim();
        if ( !/^\d{8}$/.test( ymd ) || ymd.slice( 0, 4 ) !== String( year ) ) die( `${ year } 年的表裡有一行看不懂：「${ line }」` );
        const iso = `${ ymd.slice( 0, 4 ) }-${ ymd.slice( 4, 6 ) }-${ ymd.slice( 6, 8 ) }`;
        const dow = new Date( `${ iso }T00:00:00` ).getDay();
        const weekend = dow === 0 || dow === 6;
        const flag = c[ 2 ].trim();
        if ( flag !== '0' && flag !== '2' ) die( `${ iso } 的「是否放假」是「${ flag }」，只認 0 / 2` );
        const note = ( c[ 3 ] || '' ).trim();
        if ( flag === '2' && !weekend ) off[ iso ] = note || '放假';
        if ( flag === '0' && weekend ) on[ iso ] = note || '補班';
    }
    return { off, on };
}

async function main() {
    const now = new Date();
    const years = process.argv.slice( 2 ).map( Number );
    if ( !years.length ) years.push( now.getFullYear(), now.getFullYear() + 1 );
    for ( const y of years ) if ( !( y >= 2017 && y <= 2100 ) ) die( `年份要寫西元，例：2027（收到「${ y }」）` );

    const prev = fs.existsSync( OUT ) ? JSON.parse( fs.readFileSync( OUT, 'utf8' ) ) : { years: [], off: {}, on: {} };

    const meta = JSON.parse( ( await get( DATASET_API ) ).toString( 'utf8' ) );
    const list = meta.result.distribution;

    const got = {};
    for ( const y of years ) {
        const r = pickResource( list, y );
        if ( !r ) {
            console.log( `⚠️ ${ y } 年平台上還沒有表（通常 6～7 月才公布明年的），先跳過` );
            continue;
        }
        got[ y ] = parseCsv( await get( r.resourceDownloadUrl ), y );
        console.log( `✅ ${ y }：${ r.resourceDescription }` );
    }
    if ( !Object.keys( got ).length ) die( '一年都沒抓到，holidays.json 不動' );

    // 這次抓到的年份整年換掉，其他年份原樣保留
    const keep = obj => {
        const out = {};
        for ( const k of Object.keys( obj ) ) if ( !got[ k.slice( 0, 4 ) ] ) out[ k ] = obj[ k ];
        return out;
    };
    const next = {
        source: `人事行政總處「政府行政機關辦公日曆表」${ DATASET_PAGE }`,
        updated: `${ now.getFullYear() }-${ String( now.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( now.getDate() ).padStart( 2, '0' ) }`,
        note: 'off＝平日放假、on＝週末補班。由 update-holidays.js 產生，⛔ 不要手改 —— 重跑會蓋掉。',
        years: [],
        off: keep( prev.off ),
        on: keep( prev.on ),
    };
    for ( const y of Object.keys( got ) ) {
        Object.assign( next.off, got[ y ].off );
        Object.assign( next.on, got[ y ].on );
    }
    const sortKeys = obj => {
        const out = {};
        for ( const k of Object.keys( obj ).sort() ) out[ k ] = obj[ k ];
        return out;
    };
    next.off = sortKeys( next.off );
    next.on = sortKeys( next.on );
    const ys = prev.years.concat( Object.keys( got ).map( Number ) );
    next.years = ys.filter( ( y, i ) => ys.indexOf( y ) === i ).sort();

    // 差異印出來給人看 —— 這是要 commit 的東西，⛔ 不要沒看就推
    for ( const kind of [ 'off', 'on' ] ) {
        const label = kind === 'off' ? '放假' : '補班';
        for ( const k of Object.keys( next[ kind ] ) ) {
            if ( !( k in prev[ kind ] ) ) console.log( `   ＋ ${ label } ${ k } ${ next[ kind ][ k ] }` );
        }
        for ( const k of Object.keys( prev[ kind ] ) ) {
            if ( !( k in next[ kind ] ) ) console.log( `   － ${ label } ${ k } ${ prev[ kind ][ k ] }` );
        }
    }

    fs.writeFileSync( OUT, JSON.stringify( next, null, 2 ) + '\n', 'utf8' );
    console.log( `\n寫好 holidays.json：${ next.years.join( '、' ) } 年，平日放假 ${ Object.keys( next.off ).length } 天、`
        + `週末補班 ${ Object.keys( next.on ).length } 天。⚠️ 重開服務才會生效。` );
}

main().catch( e => die( e.stack ) );
