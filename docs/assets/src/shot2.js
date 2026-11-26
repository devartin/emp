const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1600,height:582},deviceScaleFactor:2});
await p.goto('file://'+process.cwd()+'/features.html');await p.waitForTimeout(400);await p.screenshot({path:'features.png'});await b.close();})();
