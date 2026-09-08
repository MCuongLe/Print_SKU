export class QueueClient {
  constructor(config) {
    this.url = config.queueUrl;
    this.token = config.agentToken;
    this.agentId = config.agentId;
    this.leaseMs = config.leaseMs;
  }

  async request(action, data = {}) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`
      },
      body: JSON.stringify({ action, agentId: this.agentId, ...data }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`Queue trả về dữ liệu không phải JSON (${response.status})`); }
    if (!response.ok || result.ok === false) throw new Error(result.error?.message || result.message || `Queue HTTP ${response.status}`);
    return result.data ?? result;
  }

  heartbeat(state) { return this.request("agent_heartbeat", { state }); }
  claim(state) { return this.request("agent_claim", { leaseMs: this.leaseMs, state }); }
  progress(jobId, stage, details = {}) { return this.request("agent_progress", { jobId, stage, details }); }
  complete(jobId, result) { return this.request("agent_complete", { jobId, result }); }
  fail(jobId, error) { return this.request("agent_fail", { jobId, error }); }
  requeue(jobId, reason) { return this.request("agent_requeue", { jobId, reason }); }
}
