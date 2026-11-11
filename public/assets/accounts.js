const headers={'Content-Type':'application/json','X-Design-Client':'workbench-v1'};
export async function accountRequest(route,body){const r=await fetch('/api/auth/'+route,{method:'POST',headers,body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data;}
const form=document.getElementById('accountForm');
if(form){
 let register=false;const submit=document.getElementById('accountSubmit'),toggle=document.getElementById('accountToggle'),error=document.getElementById('accountError');
 const returnTo=()=>{const target=sessionStorage.getItem('accountReturn') || (new URLSearchParams(location.search).get('returnTo') || '/') + location.hash;sessionStorage.removeItem('accountReturn');const destination=new URL(target||'/',location.origin);location.href=destination.origin===location.origin?destination.href:'/';};
 toggle.onclick=()=>{register=!register;document.getElementById('displayNameField').hidden=!register;form.elements.displayName.required=register;form.elements.password.autocomplete=register?'new-password':'current-password';submit.textContent=register?'注册并登录':'登录';toggle.textContent=register?'已有账号，登录':'注册账号';error.textContent='';};
 form.onsubmit=async e=>{e.preventDefault();submit.disabled=toggle.disabled=true;error.textContent='';try{await accountRequest(register?'register':'login',Object.fromEntries(new FormData(form)));returnTo();}catch(e){error.textContent=e.message;}finally{submit.disabled=toggle.disabled=false;}};
 fetch('/api/auth/session').then(r=>r.json()).then(s=>{if(s.user||!s.enabled)returnTo();else if(!s.initialized){error.textContent='平台账号尚未初始化，请联系维护者。';submit.disabled=toggle.disabled=true;}}).catch(()=>{error.textContent='无法连接账号服务，请刷新重试';});
}
export async function mountAccount({flush=async()=>true}={}){
 const r=await fetch('/api/auth/session'),s=await r.json();if(!s.enabled)return;
 if(!s.user){sessionStorage.setItem('accountReturn',location.pathname+location.search+location.hash);location.href='/login';return;}
 const bar=document.createElement('div');bar.className='account-session';const name=document.createElement('span');name.textContent=s.user.displayName;const button=document.createElement('button');button.className='button';button.textContent='退出登录';bar.append(name,button);document.querySelector('.sider-footer')?.prepend(bar);
 button.onclick=async()=>{if(!await flush())return;button.disabled=true;try{await accountRequest('logout',{});location.href='/login';}catch(e){button.disabled=false;button.textContent=e.message;}};
}
