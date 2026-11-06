import {multiply,rotate,fromEuler} from './orientation.js';
// Illustrative A3 board: documented outline, mounting holes and antenna overhang.
// Component placements are schematic, not a substitute for the KiCad assembly model.
export class DeviceView {
  constructor(canvas) {this.canvas=canvas;this.camera=fromEuler(-.85,0,-.28);}
  draw(pose,live=false) {
    const c=this.canvas,ctx=c.getContext('2d'),dpr=Math.min(devicePixelRatio||1,2);
    const w=c.clientWidth,h=c.clientHeight;if(!w||!h)return;
    c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);
    const bg=ctx.createRadialGradient(w*.5,h*.45,10,w*.5,h*.5,w*.55);bg.addColorStop(0,'#153445');bg.addColorStop(1,'#0b1525');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='#ffffff0c';ctx.lineWidth=1;
    for(let x=0;x<w;x+=28){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
    for(let y=0;y<h;y+=28){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    const q=multiply(this.camera,pose),scale=Math.min(w/115,h/105);
    const transform=p=>rotate(q,p),project=p=>[w/2+p[0]*scale,h/2-p[1]*scale];
    const faces=[];
    const face=(points,color,stroke='#ffffff20')=>{const v=points.map(transform);faces.push({depth:v.reduce((s,p)=>s+p[2],0)/v.length,draw:()=>{ctx.beginPath();v.forEach((p,i)=>{const [x,y]=project(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.strokeStyle=stroke;ctx.stroke();}});};
    const box=(x,y,z,sx,sy,sz,color)=>{
      const v=[[x,y,z],[x+sx,y,z],[x+sx,y+sy,z],[x,y+sy,z],[x,y,z+sz],[x+sx,y,z+sz],[x+sx,y+sy,z+sz],[x,y+sy,z+sz]];
      for(const indices of [[0,3,2,1],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]])face(indices.map(i=>v[i]),color);
    };
    const label=(text,p,color='#c7e7de',size=8)=>{const v=transform(p);faces.push({depth:v[2]+.05,draw:()=>{if(rotate(q,[0,0,1])[2]<0)return;const [x,y]=project(v);ctx.fillStyle=color;ctx.font=`600 ${size}px Inter, sans-serif`;ctx.textAlign='center';ctx.fillText(text,x,y);}});};
    box(-34,-34,-.8,68,68,1.6,'#09624e');
    const boardFaces=faces.splice(0);
    // Four 3.2 mm mounting holes at 4 mm inset, drawn on each face.
    for(const x of [-30,30])for(const y of [-30,30])for(const z of [-.82,.82]) {
      const points=Array.from({length:24},(_,i)=>[x+1.6*Math.cos(i*Math.PI/12),y+1.6*Math.sin(i*Math.PI/12),z]);face(points,'#071222','#c8b46d');
    }
    box(-9,15,.8,18,25,2.8,'#b2bcc3');box(-9,32,3.61,18,8,.3,'#202c38');
    for(let i=0;i<5;++i) box(-7+i*3,33,4,.9,5,.2,'#c4a961');
    label('ESP32-S3',[0,22,4.1],'#263b45',8);
    box(-21,4,.8,6,6,1.4,'#222d36');label('IMU',[-18,1,1]);
    box(14,4,.8,6,6,1.4,'#3c464d');label('BME688',[17,1,1]);
    box(-6,-8,.8,12,8,2,'#222d36');label('RTC',[0,-12,1]);
    box(-7,-35,.8,14,8,3.5,'#aab5bf');box(-5,-35.05,1.5,10,.1,1.9,'#18202b');
    for(const x of [-27,12]) {box(x,-27,.8,15,7,2.5,'#1c232c');for(let i=0;i<6;++i)for(let row=0;row<2;++row)box(x+1+i*2.4,-26+row*3,3.3,1,1,1,'#c8ac6a');}
    label('J3',[-20,-18,1]);label('J4',[19,-18,1]);
    box(-20,18,.8,6,5,1,'#b8a478');label('MIC',[-17,15,1]);
    box(24,20,.8,2,3,1,live?'#69f7b9':'#386658');
    label('FrED PAL A3',[0,7,1],'#defff0',12);
    for(let i=0;i<8;++i)box(-26+i*7,-14,.8,2,1,1,'#969774');
    boardFaces.sort((a,b)=>a.depth-b.depth).forEach(f=>f.draw());
    if(rotate(q,[0,0,1])[2]>=0) faces.sort((a,b)=>a.depth-b.depth).forEach(f=>f.draw());
    const origin=[w-49,h-43];
    [[1,0,0],[0,1,0],[0,0,1]].forEach((axis,i)=>{const v=rotate(this.camera,axis);ctx.strokeStyle=['#38bdf8','#fbbf24','#f43f5e'][i];ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(...origin);ctx.lineTo(origin[0]+v[0]*25,origin[1]-v[1]*25);ctx.stroke();ctx.font='11px Inter,sans-serif';ctx.fillText('XYZ'[i],origin[0]+v[0]*32,origin[1]-v[1]*32);});
    ctx.textAlign='right';ctx.fillStyle='#9bb0c7';ctx.font='10px Inter,sans-serif';ctx.fillText('WORLD · Z UP',w-16,h-8);
    ctx.textAlign='left';ctx.fillStyle='#9bb0c7';ctx.font='10px Inter,sans-serif';ctx.fillText('68 × 68 mm · illustrative component layout',16,h-16);
  }
}
