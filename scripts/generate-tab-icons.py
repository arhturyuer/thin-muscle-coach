"""Rasterize original vector-like tab icons; no third-party asset or imaging dependency."""
from pathlib import Path
import math,struct,zlib
root=Path(__file__).resolve().parents[1]/'miniprogram/assets/icons'
root.mkdir(parents=True,exist_ok=True)
def segment(x,y,a,b):
 dx=b[0]-a[0];dy=b[1]-a[1]
 t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
 return math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)
shapes={
 'today':([(4,11),(12,4),(20,11),(20,20),(14.5,20),(14.5,14),(9.5,14),(9.5,20),(4,20),(4,11)],[]),
 'growth':([(4,4),(4,20),(21,20)],[]),
 'profile':([],[(12,8,4)])}
def draw(name,color):
 points,circles=shapes[name];lines=list(zip(points,points[1:]))
 if name=='growth':lines += [((8,15),(8,17)),((12,11),(12,17)),((16,7),(16,17))]
 if name=='profile':lines += [((4,21),(4,19)),((4,19),(7,16)),((7,16),(17,16)),((17,16),(20,19)),((20,19),(20,21))]
 data=bytearray();size=81
 for j in range(size):
  data.append(0)
  for i in range(size):
   hits=0
   for sy in range(3):
    for sx in range(3):
     x=(i+(sx+.5)/3)*24/size;y=(j+(sy+.5)/3)*24/size
     if any(segment(x,y,a,b)<.85 for a,b in lines) or any(abs(math.hypot(x-cx,y-cy)-rad)<.85 for cx,cy,rad in circles):hits+=1
   data.extend((*color,round(hits/9*255)))
 def chunk(t,v):return struct.pack('!I',len(v))+t+v+struct.pack('!I',zlib.crc32(t+v)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(data)))+chunk(b'IEND',b'')
for name in shapes:
 for suffix,color in [('',(123,141,129)),('-active',(23,62,50))]:
  (root/(name+suffix+'.png')).write_bytes(draw(name,color))
