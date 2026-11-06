export function setupDeviceDialog() {
 const dialog=document.getElementById('deviceSetup'),names=['connection','sampling','firmware'];
 const select=name=>{
  for(const item of names){const button=document.getElementById(item+'Tab');button.setAttribute('aria-selected',String(item===name));button.tabIndex=item===name?0:-1;document.getElementById(item+'Settings').hidden=item!==name;}
 };
 document.getElementById('openSetup').onclick=()=>dialog.showModal();
 document.getElementById('closeSetup').onclick=()=>dialog.close();
 for(const [i,name] of names.entries()) {
  const button=document.getElementById(name+'Tab');button.onclick=()=>select(name);
  button.onkeydown=event=>{
   const next=event.key==='ArrowRight'?(i+1)%3:event.key==='ArrowLeft'?(i+2)%3:event.key==='Home'?0:event.key==='End'?2:-1;
   if(next>=0){event.preventDefault();select(names[next]);document.getElementById(names[next]+'Tab').focus();}
  };
 }
 return {connected(){if(!document.getElementById('connectionSettings').hidden)dialog.close();}};
}
