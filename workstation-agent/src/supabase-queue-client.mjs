export class SupabaseQueueClient {
  constructor(config) {
    this.baseUrl=config.supabaseUrl.replace(/\/$/,""); this.publishableKey=config.supabasePublishableKey;
    this.agentToken=config.agentToken; this.agentId=config.agentId; this.leaseMs=config.leaseMs;
  }
  async rpc(name,body) {
    const response=await fetch(`${this.baseUrl}/rest/v1/rpc/${name}`,{method:"POST",headers:{"Content-Type":"application/json","apikey":this.publishableKey,"Authorization":`Bearer ${this.publishableKey}`},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    const text=await response.text(); let result;
    try { result=JSON.parse(text); } catch { throw new Error(`Supabase trả về dữ liệu không phải JSON (${response.status})`); }
    if(!response.ok||result?.ok===false) throw new Error(result?.error?.message||result?.message||`Supabase HTTP ${response.status}`);
    return result?.data??result;
  }
  claim(state){return this.rpc("print_agent_claim",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_state:state,p_lease_ms:this.leaseMs});}
  progress(jobId,stage,details={}){return this.rpc("print_agent_progress",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_stage:stage,p_details:details,p_lease_ms:this.leaseMs});}
  complete(jobId,result){return this.rpc("print_agent_complete",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_result:result});}
  fail(jobId,error){return this.rpc("print_agent_fail",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_error:error});}
  requeue(jobId,reason){return this.rpc("print_agent_requeue",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_reason:reason});}
}
