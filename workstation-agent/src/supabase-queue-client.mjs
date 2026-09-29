import { toNetworkError, withRetry } from "./network-retry.mjs";

// 20 giây mỗi lần gọi, thử lại 3 lần sau 1s/2s/4s: xấu nhất ~87 giây, vẫn dưới
// lease mặc định 120 giây nên mạng chập chờn không làm mất quyền giữ lệnh.
const RPC_TIMEOUT_MS=20000;
const RPC_RETRY_DELAYS_MS=[1000,2000,4000];

export class SupabaseQueueClient {
  constructor(config,options={}) {
    this.baseUrl=config.supabaseUrl.replace(/\/$/,""); this.publishableKey=config.supabasePublishableKey;
    this.agentToken=config.agentToken; this.agentId=config.agentId; this.leaseMs=config.leaseMs;
    this.fetch=options.fetch??((...args)=>fetch(...args)); this.logger=options.logger; this.sleep=options.sleep;
    this.timeoutMs=options.timeoutMs??RPC_TIMEOUT_MS; this.retryDelaysMs=options.retryDelaysMs??RPC_RETRY_DELAYS_MS;
  }
  async rpcOnce(name,body) {
    let response,text;
    try {
      response=await this.fetch(`${this.baseUrl}/rest/v1/rpc/${name}`,{method:"POST",headers:{"Content-Type":"application/json","apikey":this.publishableKey,"Authorization":`Bearer ${this.publishableKey}`},body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});
      text=await response.text();
    } catch(error) { throw toNetworkError(`Supabase ${name}`,error,this.timeoutMs); }
    // Gateway 5xx/429 là lỗi hạ tầng tạm thời, thử lại được; 4xx và ok:false là lỗi nghiệp vụ.
    const transient=response.status>=500||response.status===429; let result;
    try { result=JSON.parse(text); } catch { throw Object.assign(new Error(`Supabase ${name} trả về dữ liệu không phải JSON (${response.status})`),{code:`HTTP_${response.status}`,transient}); }
    if(!response.ok||result?.ok===false) throw Object.assign(new Error(result?.error?.message||result?.message||`Supabase HTTP ${response.status}`),{code:result?.error?.code||`HTTP_${response.status}`,transient:!response.ok&&transient});
    return result?.data??result;
  }
  rpc(name,body,{retry=true}={}) {
    if(!retry) return this.rpcOnce(name,body);
    return withRetry(()=>this.rpcOnce(name,body),{delaysMs:this.retryDelaysMs,sleep:this.sleep,onRetry:(error,attempt,delayMs)=>this.logger?.warn(`${error.message}; thử lại lần ${attempt} sau ${delayMs/1000}s`)});
  }
  // Vòng quét đã tự gọi lại claim sau mỗi nhịp, thử lại ở đây chỉ làm chậm vòng quét.
  claim(state){return this.rpc("print_agent_claim",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_state:state,p_lease_ms:this.leaseMs},{retry:false});}
  progress(jobId,stage,details={},options={}){return this.rpc("print_agent_progress",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_stage:stage,p_details:details,p_lease_ms:this.leaseMs},options);}
  complete(jobId,result){return this.rpc("print_agent_complete",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_result:result});}
  fail(jobId,error){return this.rpc("print_agent_fail",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_error:error});}
  requeue(jobId,reason){return this.rpc("print_agent_requeue",{p_agent_id:this.agentId,p_agent_token:this.agentToken,p_job_id:jobId,p_reason:reason});}
}
