'use strict';
const fs = require( 'fs' );
const path = require( 'path' );

const DIR = __dirname;
const today = ( () => {
    const d = new Date();
    return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
} )();
function shift( days ) {
    const d = new Date();
    d.setDate( d.getDate() + days );
    return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
}

fs.writeFileSync( path.join( DIR, 'config.json' ), JSON.stringify( {
    port: 8443,
    adminPassword: 'testroot',
    telegram: { enabled: false, botToken: '', chatId: '', notifyGroup: false },
    notifyDebounceMs: 1500,
    projects: [ 'A案' ],
    members: [ { id: 'boshue', name: '柏學', admin: true } ],
    defaultOwner: 'boshue',
    workHours: { start: '09:00', end: '18:00' },
    meetings: [],
}, null, 2 ) );

function task( o ) {
    return Object.assign( {
        id: '', title: '', detail: '', project: '', requester: '', requesterId: '',
        status: 'todo', order: 10, estimate: 1, due: '', note: '', comments: [], wishLog: [],
        createdAt: '2026-09-10T01:00:00.000Z', updatedAt: '2026-09-10T01:00:00.000Z',
        doneAt: '', owner: 'boshue', projectedDue: '', wishDate: '', wishTime: '',
        estimate0: null, spentMin: 0, startedAt: '', spans: [],
    }, o );
}

fs.writeFileSync( path.join( DIR, 'data.json' ), JSON.stringify( {
    v: 5, seq: 10,
    defaultOwner: 'boshue',
    members: [
        { id: 'boshue', name: '柏學', admin: true, role: 'dev' },
        { id: 'dev2', name: '阿二', admin: true, role: 'dev' },
        { id: 'zoe', name: '小柔', admin: true, role: 'director' },
        { id: 'plain', name: '小平', admin: false, role: 'director' },
    ],
    tasks: [
        task( { id: 't001', title: '小柔提的單', requester: '小柔', requesterId: 'zoe',
            order: 10, wishDate: shift( 5 ), wishTime: '14:00' } ),
        task( { id: 't002', title: '舊單沒有 requesterId', requester: '小柔', requesterId: '',
            order: 20, wishDate: shift( 6 ) } ),
        task( { id: 't003', title: '小柔提的已完成單', requester: '小柔', requesterId: 'zoe',
            order: 30, status: 'done', doneAt: '2026-09-12T01:00:00.000Z', wishDate: shift( 3 ) } ),
        task( { id: 't004', title: '柏學自己提自己做', requester: '柏學', requesterId: 'boshue',
            order: 40, wishDate: '' } ),
        task( { id: 't005', title: '小平提的、無主', requester: '小平', requesterId: 'plain',
            order: 50, owner: '', wishDate: shift( 2 ) } ),
        // ⭐ 故意少掉 wishLog：驗「舊資料 / 從備份貼回來」時讀檔邊界會不會補
        ( () => { const t = task( { id: 't006', title: '缺 wishLog 的單', requester: '小柔',
            requesterId: 'zoe', order: 60, wishDate: shift( 4 ) } ); delete t.wishLog; return t; } )(),
    ],
    days: {}, dayStarts: {},
}, null, 2 ) );

fs.writeFileSync( path.join( DIR, 'auth.json' ), JSON.stringify( {
    passwords: {}, subscribers: {}, pending: {},
}, null, 2 ) );

console.log( 'fixture ready; today =', today, 'today+5 =', shift( 5 ), 'yesterday =', shift( -1 ) );
