import sys
cx, cy = 512, 503
C, S = 0.8660254, 0.5
def P(x, y, z): return (cx + (x - y) * C, cy + (x + y) * S - z)
def pts(ps): return " ".join("%.2f,%.2f" % P(*p) for p in ps)
B, H, G = 272, 76, int(sys.argv[3]) if len(sys.argv) > 3 else 24
INSET = int(sys.argv[2]) if len(sys.argv) > 2 else 0
M = B - INSET
slabs = [(B, B, 0, H), (M, M, H + G, H), (B, B, 2 * (H + G), H)]
def mix(c1, c2, k):
    a=[int(c1[j:j+2],16) for j in (1,3,5)]; b=[int(c2[j:j+2],16) for j in (1,3,5)]
    return "#%02x%02x%02x" % tuple(round(a[n]+(b[n]-a[n])*k) for n in range(3))
defs, body = [], []
for i, (a, b, z0, h) in enumerate(slabs):
    t = i / 2
    z1 = z0 + h
    top = [(0,0,z1),(a,0,z1),(a,b,z1),(0,b,z1)]
    left = [(0,b,z0),(a,b,z0),(a,b,z1),(0,b,z1)]
    right = [(a,0,z0),(a,b,z0),(a,b,z1),(a,0,z1)]
    # gradients
    defs.append(f'<linearGradient id="t{i}" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="{mix("#e4e4ea","#ffffff",t)}"/><stop offset="0.55" stop-color="{mix("#b9b9c2","#e6e6ec",t)}"/><stop offset="1" stop-color="{mix("#8f8f99","#bdbdc6",t)}"/></linearGradient>')
    defs.append(f'<linearGradient id="l{i}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="{mix("#5d5d66","#7d7d87",t)}"/><stop offset="1" stop-color="{mix("#33333a","#4a4a52",t)}"/></linearGradient>')
    defs.append(f'<linearGradient id="r{i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{mix("#2a2a30","#3a3a41",t)}"/><stop offset="1" stop-color="{mix("#111114","#19191d",t)}"/></linearGradient>')
    defs.append(f'<clipPath id="ct{i}"><polygon points="{pts(top)}"/></clipPath>')
    soft = 'stroke-linejoin="round" stroke-width="3"'
    body.append(f'<polygon points="{pts(left)}" fill="url(#l{i})" stroke="url(#l{i})" {soft}/>')
    body.append(f'<polygon points="{pts(right)}" fill="url(#r{i})" stroke="url(#r{i})" {soft}/>')
    body.append(f'<polygon points="{pts(top)}" fill="url(#t{i})" stroke="url(#t{i})" {soft}/>')
    # sheen on top face
    body.append(f'<polygon points="{pts(top)}" fill="url(#sheen)" opacity="{0.35+0.4*t:.2f}"/>')
    # ambient occlusion from the slab above, cast onto this top face
    if i < 2:
        a2, b2, _, _ = slabs[i+1]
        fp = [(0,0,z1),(a2,0,z1),(a2,b2,z1),(0,b2,z1)]
        body.append(f'<g clip-path="url(#ct{i})"><polygon points="{pts(fp)}" fill="#000" opacity="0.85" filter="url(#ao)"/></g>')
    # edge highlights: front top edges bright, vertical front corner subtle, bottom edge dark
    body.append(f'<polyline points="{pts([(0,b,z1),(a,b,z1),(a,0,z1)])}" fill="none" stroke="#fff" stroke-opacity="{0.55+0.35*t:.2f}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>')
    body.append(f'<polyline points="{pts([(a,b,z0+3),(a,b,z1)])}" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="1.6" stroke-linecap="round"/>')
    body.append(f'<polyline points="{pts([(0,0,z1),(0,b,z1)])}" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="1.4" stroke-linecap="round"/>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#202026"/><stop offset="0.5" stop-color="#121216"/><stop offset="1" stop-color="#070709"/></linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.44" r="0.46"><stop offset="0" stop-color="#c9d2ff" stop-opacity="0.13"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0.03"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="0.35" stop-color="#ffffff" stop-opacity="0.07"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/></linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.06"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
    <radialGradient id="sheen" cx="0.3" cy="0.15" r="0.9"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.15"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <filter id="ao" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="drop" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="30"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer></filter>
    <clipPath id="sq"><rect x="64" y="64" width="896" height="896" rx="200"/></clipPath>
    {"".join(defs)}
  </defs>
  <g clip-path="url(#sq)">
    <rect x="64" y="64" width="896" height="896" fill="url(#bg)"/>
    <rect x="64" y="64" width="896" height="896" fill="url(#halo)"/>
    <rect x="64" y="64" width="896" height="420" fill="url(#gloss)"/>
    <rect x="64" y="64" width="896" height="896" fill="url(#vig)"/>
    <rect x="64" y="64" width="896" height="896" filter="url(#grain)"/>
    <ellipse cx="512" cy="{cy + B + 40}" rx="300" ry="70" fill="#000" opacity="0.75" filter="url(#drop)"/>
  </g>
  <rect x="65.5" y="65.5" width="893" height="893" rx="198.5" fill="none" stroke="url(#rim)" stroke-width="3"/>
  {"".join(body)}
</svg>'''
open(sys.argv[1], "w").write(svg)
