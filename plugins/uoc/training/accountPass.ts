/** Account-only authentication for Training; it never selects a pilot. */
export function createTrainingAccountPass(transport:typeof fetch=fetch) {
  const pending=new Map<string,Promise<string>>(), inFlight=new Set<Promise<string>>(), owned=new Set<string>();
  let released=false;
  const logout=async(token:string)=>{await transport('/api/logout',{method:'POST',credentials:'omit',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});};
  return {
    async optionsFor(accountName:string):Promise<{token:string}>{
      const name=accountName.trim();
      if(!name)throw Error('This browser no longer knows which account that pilot is on.');
      if(released)throw Error('This window has been closed.');
      let promise=pending.get(name);
      if(!promise){
        promise=(async()=>{
          const response=await transport('/api/pilot-training/login',{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify({username:name})});
          const data=await response.json() as any;
          if(!response.ok||data?.ok===false)throw Error(data?.message||data?.error||'Account authentication failed.');
          if(typeof data?.sessionToken!=='string'||!data.sessionToken)throw Error('Account authentication is incomplete.');
          const token=data.sessionToken;owned.add(token);
          if(typeof data?.account?.username!=='string'||data.account.username.toLowerCase()!==name.toLowerCase())throw Error('Account identity changed during authentication.');
          return token;
        })();
        const created=promise;pending.set(name,created);inFlight.add(created);
        created.then(()=>inFlight.delete(created),()=>{inFlight.delete(created);if(pending.get(name)===created)pending.delete(name);});
      }
      const token=await promise;
      if(released)throw Error('This window has been closed.');
      return {token};
    },
    forget(accountName:string){pending.delete(accountName.trim());},
    async release(){
      if(released)return;released=true;
      await Promise.allSettled([...inFlight]);pending.clear();
      const tokens=[...owned];owned.clear();
      await Promise.allSettled(tokens.map(logout));
    },
  };
}
