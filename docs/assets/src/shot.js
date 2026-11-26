const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();
for (const [f,w,h,o] of [['banner',1600,640,'banner.png'],['social',1280,640,'social-preview.png']]){
 const p=await b.newPage({viewport:{width:w,height:h},deviceScaleFactor:2});
 await p.goto('file://'+process.cwd()+'/'+f+'.html'); await p.waitForTimeout(400);
 await p.screenshot({path:o}); }
await b.close();})();
