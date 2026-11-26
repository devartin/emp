from parts import CHART, DONUT, HEAT
def window(scale_style):
    return f'''
<div class="win" style="{scale_style}">
 <div class="side">
  <div class="dots"><b></b><b></b><b></b></div>
  <div class="ws"><img src="icon.svg">Personal</div>
  <div class="nav"><s></s>Search<span class="mono" style="margin-left:auto;font-size:10px;color:#55555f">⌘K</span></div>
  <div class="nav on"><s></s>Home</div>
  <div class="nav"><s></s>Today</div>
  <div class="nav"><s></s>Life apps</div>
  <div class="nav"><s></s>Markets</div>
  <div class="lbl">Workspace</div>
  <div class="nav"><s style="border-radius:50%"></s>Money HQ</div>
  <div class="nav"><s style="border-radius:50%"></s>Portfolio</div>
  <div class="nav"><s style="border-radius:50%"></s>Tax Organizer</div>
  <div class="nav"><s></s>Projects</div>
  <div class="nav"><s></s>Reading list</div>
  <div class="nav"><s></s>Budget 2027.xlsx</div>
  <div class="lbl">Private · encrypted</div>
  <div class="nav"><s></s>Journal</div>
 </div>
 <div class="main">
  <div class="crumb">Money HQ  /  Overview</div>
  <div class="h1">Good evening, Alex <span style="font-size:12px;font-weight:500;color:#6f6f7a;margin-left:auto">● Locked vault · XChaCha20</span></div>
  <div class="kpis">
   <div class="kpi"><div class="k">Net worth</div><div class="v">$248,930<span class="pill up">+4.2%</span></div></div>
   <div class="kpi"><div class="k">Saved this month</div><div class="v">$2,184<span class="pill up">31%</span></div></div>
   <div class="kpi"><div class="k">Portfolio · XIRR</div><div class="v">11.8%<span class="pill dn">−0.6%</span></div></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 190px;gap:12px">
   <div class="card"><div style="display:flex;justify-content:space-between;font-size:12px;color:#8b8b96;margin-bottom:10px"><span style="color:#e6e6ea;font-weight:600">Net worth</span><span>1M · 6M · <b style="color:#fff">1Y</b> · All</span></div>{CHART}</div>
   <div class="card" style="display:flex;flex-direction:column;align-items:center;gap:6px"><div style="font-size:12px;color:#e6e6ea;font-weight:600;align-self:flex-start">Budget · Nov</div>{DONUT}</div>
  </div>
  <div class="card" style="margin-top:12px;display:flex;gap:18px;align-items:center"><div><div style="font-size:12px;color:#e6e6ea;font-weight:600;margin-bottom:4px">Habits</div><div style="font-size:11px;color:#7d7d88">Read · 23 day streak</div></div>{HEAT}</div>
 </div>
</div>'''

def page(w,h,left_css,win_css,tag_size=30,word_size=84,sub=True,chips=True):
    chipdata=[('#e4e4ea','Notion-style docs & databases'),('#9aa4ff','Excel-grade sheets'),('#4ade80','Personal finance'),('#38bdf8','Stocks & portfolio'),('#fbbf24','Taxes'),('#f472b6','Guided life apps'),('#a1a1aa','Google Calendar · Docs · Sheets')]
    ch=''.join(f'<span class="chip"><i style="background:{c}"></i>{t}</span>' for c,t in chipdata)
    return f'''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="common.css"></head>
<body><div class="stage" style="width:{w}px;height:{h}px"><div class="grid"></div>
<div style="position:absolute;{left_css};display:flex;flex-direction:column;gap:26px">
 <div class="brand"><img src="icon.svg"><div class="word" style="font-size:{word_size}px">EMP</div></div>
 <div class="tag" style="font-size:{tag_size}px">Your whole life, <em>beautifully</em> organised.<br>Local-first. Encrypted. Yours.</div>
 {'<div class="sub">The productivity super app: documents, databases, spreadsheets, money,<br>investing and taxes — with guided setups built on best practices.</div>' if sub else ''}
 {f'<div class="chips">{ch}</div>' if chips else ''}
</div>
{window(win_css)}
</div></body></html>'''

open('banner.html','w').write(page(1600,640,'left:84px;top:96px;width:640px',
  'left:800px;top:70px;width:960px;height:600px;transform:perspective(2200px) rotateY(-16deg) rotateX(7deg) rotateZ(1deg);transform-origin:left center'))
open('social.html','w').write(page(1280,640,'left:72px;top:118px;width:560px',
  'left:640px;top:84px;width:900px;height:560px;transform:perspective(2000px) rotateY(-18deg) rotateX(7deg);transform-origin:left center',tag_size=28,word_size=80,sub=False))
