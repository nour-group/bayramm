const {JSDOM}=require('jsdom');const fs=require('fs');
const html=fs.readFileSync(require('path').join(__dirname,'..','admin.html'),'utf8');
const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://x.test/#dashboard',pretendToBeVisual:true});
const w=dom.window,d=w.document;let fails=0;const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m);if(!c)fails++};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
w.addEventListener('error',e=>{console.log('JS ERROR',e.message);fails++});
(async()=>{
 await wait(50);const {S,A,UI}=w.__bayramAdmin;
 ok(d.querySelectorAll('.stage').length===4,'pipeline renders');
 for(const r of ['vendors','add','requests','clients','moderation','payments','team','audit','settings','dashboard']){w.location.hash=r;await wait(20);ok(d.querySelector('#view').innerHTML.length>200,'route '+r)}
 const rv=S.vendors.find(v=>v.status==='review'&&v.photos.length>=5&&v.check.contract&&v.check.consent);
 A.activate(rv.id);ok(S.vendors.find(v=>v.id===rv.id).status==='active','activate ready vendor');
 const nr=S.vendors.find(v=>v.status==='review'&&!(v.photos.length>=5&&v.check.contract&&v.check.consent));A.activate(nr.id);ok(nr.status==='review','blocked activation when not ready');
 A.openV(S.vendors[0].id);await wait(10);ok(d.querySelector('#drawer.on h3'),'drawer opens');
 A.suspend(S.vendors[0].id);A.mOk();ok(d.querySelector('#mErr').textContent.length>0,'suspend requires reason');
 d.querySelector('#mReason').value='test';A.mOk();ok(S.vendors[0].status==='suspended','suspend with reason');
 A.goAdd();await wait(20);A.saveForm('review');await wait(10);ok(d.querySelectorAll('.field.bad').length>=3,'review validation');
 w.__bayramAdmin.UI.form.name='Test Hall';A.saveForm('draft');await wait(60);ok(S.vendors.some(v=>v.name==='Test Hall'&&v.status==='draft'),'draft saved');
 w.location.hash='requests';await wait(20);const r=S.requests.find(x=>x.status!=='replied');A.reassign(r.id);A.mOk();ok(S.audit[0].a==='aReassign','reassign');
 A.pay(S.vendors.find(v=>v.status==='active').id);d.querySelector('#mAmt').value='300000';A.mOk();ok(S.payments.length===2,'payment');
 A.reveal(S.clients[0].id);ok(S.audit[0].a==='aPii','PII view logged');
 d.querySelector('#langSeg button[data-l=uz]').click();await wait(10);ok(d.querySelector('#title').textContent==='Soʻrovlar','uz lang');
 console.log(fails?`FAILED ${fails}`:'ALL PASSED');process.exit(fails?1:0);
})();
