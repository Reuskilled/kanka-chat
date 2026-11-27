// Kanka rakunu: özgün maskot. rac({mood, arm, blink, mouthOpen, phones, sweat})
function rac(o){
  o=Object.assign({mood:'happy',arm:0,armL:0,blink:0,talk:0,phones:false,sweat:0,tail:0},o);
  const fur='#9a8f88',furD='#6e645e',light='#efe6da',mask='#2b2522',org='#ff8a4c',orgD='#e2632e';
  const eyeH=o.blink?2:18;
  let brows='';
  if(o.mood==='angry')brows=`<path d="M108 120 L150 134" stroke="${mask}" stroke-width="10" stroke-linecap="round"/><path d="M212 120 L170 134" stroke="${mask}" stroke-width="10" stroke-linecap="round"/>`;
  if(o.mood==='sad')brows=`<path d="M112 132 L150 122" stroke="${mask}" stroke-width="9" stroke-linecap="round"/><path d="M208 132 L170 122" stroke="${mask}" stroke-width="9" stroke-linecap="round"/>`;
  let mouth;
  if(o.mood==='happy')mouth=`<path d="M138 205 Q160 ${232+o.talk*8} 182 205 Z" fill="#5a1f1a"/><path d="M148 214 Q160 ${226+o.talk*6} 172 214" fill="#ff7a8a"/>`;
  else if(o.mood==='angry')mouth=`<rect x="136" y="204" width="48" height="${16+o.talk*8}" rx="6" fill="#5a1f1a"/><rect x="138" y="205" width="44" height="7" fill="#fff"/>`;
  else mouth=`<path d="M140 216 Q160 200 180 216" stroke="#3a1a16" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  const sweat=o.sweat?`<path d="M232 110 Q244 132 232 142 Q220 132 232 110 Z" fill="#8fd0ff" opacity="${o.sweat}"/>`:'';
  const steam=o.mood==='angry'?`<g stroke="#ff6b6b" stroke-width="8" stroke-linecap="round" opacity=".9"><path d="M70 60 l-18 -14"/><path d="M84 46 l-6 -20"/><path d="M250 60 l18 -14"/><path d="M236 46 l6 -20"/></g>`:'';
  const phones=o.phones?`<path d="M74 150 Q74 52 160 52 Q246 52 246 150" stroke="#2a2a30" stroke-width="14" fill="none"/><rect x="58" y="134" width="36" height="62" rx="16" fill="${org}"/><rect x="226" y="134" width="36" height="62" rx="16" fill="${org}"/>`:'';
  return `<svg viewBox="0 0 320 460" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;overflow:visible">
  <g transform="rotate(${-20+o.tail*25} 210 380)"><path d="M210 380 Q300 360 300 280 Q300 250 280 250" stroke="${furD}" stroke-width="44" fill="none" stroke-linecap="round"/>
   <path d="M210 380 Q300 360 300 280 Q300 250 280 250" stroke="${mask}" stroke-width="44" fill="none" stroke-linecap="round" stroke-dasharray="22 26"/></g>
  <ellipse cx="160" cy="440" rx="90" ry="14" fill="#000" opacity=".3"/>
  <rect x="110" y="380" width="40" height="60" rx="16" fill="${mask}"/><rect x="170" y="380" width="40" height="60" rx="16" fill="${mask}"/>
  <path d="M92 300 Q92 250 160 250 Q228 250 228 300 L236 392 Q160 410 84 392 Z" fill="${org}"/>
  <path d="M120 330 h80 v34 q-40 12 -80 0 Z" fill="${orgD}"/>
  <text x="160" y="318" text-anchor="middle" font-family="Inter,Arial" font-weight="900" font-size="40" fill="#1a0f08">K</text>
  <g transform="rotate(${-o.armL*140} 96 280)"><rect x="66" y="276" width="34" height="96" rx="17" fill="${org}"/><circle cx="83" cy="372" r="20" fill="${furD}"/></g>
  <g transform="rotate(${o.arm*150} 224 280)"><rect x="220" y="276" width="34" height="96" rx="17" fill="${org}"/><circle cx="237" cy="372" r="20" fill="${furD}"/></g>
  <path d="M84 96 L66 28 Q100 40 124 70 Z" fill="${fur}"/><path d="M90 84 L80 46 Q100 56 112 72 Z" fill="#e8a8a0"/>
  <path d="M236 96 L254 28 Q220 40 196 70 Z" fill="${fur}"/><path d="M230 84 L240 46 Q220 56 208 72 Z" fill="#e8a8a0"/>
  <ellipse cx="160" cy="150" rx="104" ry="96" fill="${fur}"/>
  <path d="M58 150 Q160 92 262 150 Q248 190 205 178 Q160 162 115 178 Q72 190 58 150 Z" fill="${mask}"/>
  <ellipse cx="160" cy="200" rx="56" ry="44" fill="${light}"/>
  <ellipse cx="128" cy="150" rx="18" ry="${eyeH}" fill="#fff"/><ellipse cx="192" cy="150" rx="18" ry="${eyeH}" fill="#fff"/>
  ${o.blink?'':`<circle cx="${o.mood==='sad'?126:131}" cy="${o.mood==='sad'?156:152}" r="9" fill="#111"/><circle cx="${o.mood==='sad'?190:195}" cy="${o.mood==='sad'?156:152}" r="9" fill="#111"/><circle cx="134" cy="148" r="3" fill="#fff"/><circle cx="198" cy="148" r="3" fill="#fff"/>`}
  ${brows}
  <ellipse cx="160" cy="184" rx="16" ry="11" fill="#1a1412"/>
  ${mouth}${phones}${sweat}${steam}
  </svg>`;
}
