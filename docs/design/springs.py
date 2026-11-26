import math
S={"release":(700,30,1),"thumb":(520,26,1),"pop":(520,20,1),"glide":(420,34,1),"settle":(380,30,1),"morph":(380,36,1),"roll":(200,24,1),"magnet":(240,16,.8),"drag":(300,28,1)}
for n,(k,c,m) in S.items():
    x,v,t,dt=0.0,0.0,0.0,0.0001; xs=[]; peak=0; last_out=0
    while t<3:
        a=(-k*(x-1)-c*v)/m; v+=a*dt; x+=v*dt; t+=dt; xs.append((t,x)); peak=max(peak,x)
        if abs(x-1)>0.002 or abs(v)>0.02: last_out=t
    dur=math.ceil(last_out*1000/10)*10
    N=max(24,min(48,dur//12))
    pts=[]
    for i in range(N+1):
        tt=dur/1000*i/N
        idx=min(len(xs)-1,int(tt/dt)); pts.append(0 if i==0 else (1 if i==N else round(xs[idx][1],3)))
    z=c/(2*math.sqrt(k*m))
    print(f"{n}: k{k} c{c} m{m} zeta={z:.2f} overshoot={(peak-1)*100:.1f}% dur={dur}ms")
    print("  linear("+", ".join(('%g'%p) for p in pts)+")")
